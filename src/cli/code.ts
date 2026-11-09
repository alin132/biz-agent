/**
 * 编码 Agent 的命令行入口（TUI）。
 *
 * 形态对齐 Codex：cd 到仓库里，说一句话，它自己读文件、改代码、跑测试。
 * 复用平台的 core（runtime / registry / permission / audit），不另写一套 agent 循环。
 *
 * 三条安全边界（都是硬实现，不是提示词）：
 *  1. 文件操作锁在工作目录内（`src/tools/coding.ts` 的 resolveInside）；
 *  2. 写文件 / 跑命令 / git commit 逐次当场审批（`risk: "high"` + 本文件的 requestApproval）；
 *  3. 审批被拒就把拒绝原样回给模型，它不能绕过。
 *
 * 跑法：
 *   npm run code                 # 在当前目录开工
 *   npm run code -- --cwd ./biz-agent
 *   npm run code -- --model deepseek-v4-pro
 *   npm run code -- --yes        # 跳过审批（危险，只在自己完全信任的任务里用）
 */
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import { createBusinessRuntime } from "../core/runtime.js";
import { ToolRegistry } from "../core/registry.js";
import type { ApprovalRequest, BizContext, ToolDef } from "../core/types.js";
import { createCodingTools } from "../tools/coding.js";
import { createCodingWorkflow } from "../coding/workflow.js";
import { llmDisabled, resolveLlm } from "../../server/llm.js";
import { loadEnvFile } from "../../server/env.js";
import { createPiBusinessAgent, createPiRuntimeAdapter } from "../../server/piRuntimeAdapter.js";

// `.env` 要按这个 CLI 所在的包目录读，**不是**按 --cwd 的目标仓库读：
// 用户的仓库里没有我们的 key，从那边读只会读不到。
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadEnvFile(resolve(PACKAGE_ROOT, ".env"));

/* ---------------- 命令行参数 ---------------- */

interface CliOptions {
	cwd: string;
	model?: string;
	/** 跳过人工审批：只给"我完全信任这次任务"的场景用 */
	assumeYes: boolean;
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { cwd: process.cwd(), assumeYes: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]!;
		if (arg === "--cwd" || arg === "-C") {
			options.cwd = resolve(argv[i + 1] ?? process.cwd());
			i += 1;
		} else if (arg === "--model" || arg === "-m") {
			options.model = argv[i + 1];
			i += 1;
		} else if (arg === "--yes" || arg === "-y") {
			options.assumeYes = true;
		}
	}
	return options;
}

/* ---------------- 终端输出 ---------------- */

const useColor = stdout.isTTY;
const paint = (code: string, text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const dim = (text: string) => paint("2", text);
const bold = (text: string) => paint("1", text);
const cyan = (text: string) => paint("36", text);
const green = (text: string) => paint("32", text);
const yellow = (text: string) => paint("33", text);
const red = (text: string) => paint("31", text);

function formatTokens(value: number): string {
	return new Intl.NumberFormat("zh-CN").format(Math.max(0, Math.round(value)));
}

/**
 * 工具调用摘要：写文件不能把整篇内容糊到终端上（既刷屏又可能泄密）。
 * 每个工具显示"最能说明这次要干什么"的那一两个字段。
 */
function summarizeCall(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "fs_write": {
			const content = typeof args.content === "string" ? args.content : "";
			return `${String(args.path ?? "?")}（${content.length} 字符）`;
		}
		case "shell_run":
			return String(args.command ?? "?");
		case "git_commit":
			return String(args.message ?? "?");
		case "fs_read":
		case "fs_list":
			return String(args.path ?? ".");
		case "fs_grep":
			return `${String(args.pattern ?? "?")}${args.path ? ` @ ${String(args.path)}` : ""}`;
		case "fs_glob":
			return String(args.pattern ?? "?");
		default:
			return JSON.stringify(args).slice(0, 120);
	}
}

/** 工具结果预览：只给头几行，完整的留在模型上下文里。 */
function previewResult(text: string, limit = 6): string {
	const rows = text.split("\n");
	const shown = rows.slice(0, limit).map((row) => `   ${row.slice(0, 160)}`);
	if (rows.length > limit) shown.push(dim(`   … 还有 ${rows.length - limit} 行`));
	return shown.join("\n");
}

/* ---------------- 审批 ---------------- */

async function askApproval(
	request: ApprovalRequest,
	options: CliOptions,
	run: { question: (query: string) => Promise<string> },
): Promise<boolean> {
	if (options.assumeYes) return true;

	stdout.write(`\n${yellow("⚠ 需要审批")} ${bold(request.toolName)}：${summarizeCall(request.toolName, request.args)}\n`);
	if (request.toolName === "fs_write") {
		const content = String(request.args.content ?? "");
		stdout.write(dim(`${previewResult(content)}\n`));
	} else if (request.toolName === "shell_run") {
		stdout.write(dim(`   （将在工作目录内执行）\n`));
	}
	try {
		const answer = await run.question(`  ${yellow("允许？")} [y/N] `);
		return answer.trim().toLowerCase().startsWith("y");
	} catch {
		// 输入通道已关闭（管道跑完 / Ctrl+D）：按"没批准"处理，绝不放行
		return false;
	}
}

/* ---------------- 主流程 ---------------- */

async function main(): Promise<void> {
	const cli = parseArgs(process.argv.slice(2));

	if (llmDisabled()) {
		console.error(red("LLM_DISABLE=1 已设置：编码 Agent 需要真实模型，模拟模型跑不了文件操作任务。"));
		console.error(dim("去掉这个环境变量，或直接设置 DEEPSEEK_API_KEY 后再跑。"));
		process.exitCode = 1;
		return;
	}

	const runtime = resolveLlm(cli.model);
	if (!runtime) {
		console.error(red("没有可用的模型凭据。"));
		console.error(dim("设置 DEEPSEEK_API_KEY（或 OPENAI_API_KEY 等）后再跑：$env:DEEPSEEK_API_KEY=\"sk-...\""));
		process.exitCode = 1;
		return;
	}

	const root = resolve(cli.cwd);
	const workflow = createCodingWorkflow(root);
	const tools: ToolDef[] = createCodingTools(root);
	const registry = new ToolRegistry().registerAll(tools);

	const rl = createInterface({ input: stdin, output: stdout });
	// 管道输入（例如 `echo "任务" | npm run code`）读完就 EOF：
	// 不记这个标志，question 会一直返回空串，REPL 变成死循环。
	let closed = false;
	rl.on("close", () => {
		closed = true;
	});
	const ask = { question: (query: string) => rl.question(query) };

	const ctx: BizContext = {
		tenantId: "local",
		userId: "developer",
		traceId: `trace-${Date.now().toString(36)}`,
		allow: ["*"],
		requireApproval: [],
		audit: (entry) => {
			// 审计只打一行摘要：完整结果在模型上下文里，终端不需要重复
			const flag = entry.ok ? green("OK ") : red("ERR");
			console.log(dim(`[audit] ${flag} ${entry.toolName} chars=${entry.outputChars}${entry.truncated ? " (已截断)" : ""}`));
		},
		requestApproval: (request) => askApproval(request, cli, ask),
	};

	const built = createBusinessRuntime({
		workflow,
		registry,
		// 关键：空 steps 的流程默认**不暴露任何工具**（runtime 按步骤 via 取工具集），
		// 编码 Agent 没有固定步骤，必须显式把整份编码工具集装进去。
		toolNames: tools.map((tool) => tool.name),
	});
	let sessionManager = SessionManager.continueRecent(root);
	let resumedSession = sessionManager.getEntries().some((entry) => entry.type === "message");
	let agent = createPiBusinessAgent({ business: built, registry, ctx, model: runtime.model, streamFn: runtime.streamFn });
	let piSession = await createPiRuntimeAdapter({ agent, sessionManager, tools: agent.state.tools, cwd: root });
	let unsubscribe = () => {};

	/* -------- 事件渲染 -------- */

	let wroteText = false;
	const renderEvent: AgentSessionEventListener = (event) => {
		if (event.type === "message_update") {
			const delta = event.assistantMessageEvent;
			if (delta.type === "text_delta") {
				if (!wroteText) {
					stdout.write(`\n${cyan("助手")} `);
					wroteText = true;
				}
				stdout.write(delta.delta);
			}
			return;
		}
		if (event.type === "message_end") {
			if (wroteText) {
				stdout.write("\n\n");
				wroteText = false;
			}
			return;
		}
		if (event.type === "tool_execution_start") {
			stdout.write(`${dim("⚙")} ${bold(event.toolName)} ${dim(summarizeCall(event.toolName, event.args ?? {}))}\n`);
			return;
		}
		if (event.type === "tool_execution_end") {
			const text = typeof event.result?.content === "string" ? event.result.content : "";
			const flag = event.isError ? red("✗") : green("✓");
			const ms = event.durationMs ? dim(` ${event.durationMs}ms`) : "";
			stdout.write(`${flag} ${event.toolName}${ms}\n`);
			if (text) stdout.write(`${previewResult(text)}\n`);
			return;
		}
	};
	const attachSession = () => {
		unsubscribe();
		unsubscribe = piSession.subscribe(renderEvent);
	};
	attachSession();
	const switchSession = async (nextManager: SessionManager) => {
		unsubscribe();
		await piSession.shutdown();
		sessionManager = nextManager;
		resumedSession = sessionManager.getEntries().some((entry) => entry.type === "message");
		agent = createPiBusinessAgent({ business: built, registry, ctx, model: runtime.model, streamFn: runtime.streamFn });
		piSession = await createPiRuntimeAdapter({ agent, sessionManager, tools: agent.state.tools, cwd: root });
		wroteText = false;
		attachSession();
	};

	/* -------- 开场信息 -------- */

	console.log(bold("\n编码 Agent"));
	console.log(dim(`  工作目录：${root}`));
	console.log(dim(`  模型：${runtime.label}`));
	console.log(dim(`  Pi 会话：${sessionManager.getSessionId()}${resumedSession ? "（已恢复最近会话）" : "（新会话）"}`));
	console.log(dim(`  工具：${tools.map((tool) => tool.name).join(", ")}`));
	console.log(dim("  输入任务开始；/help 看命令，Ctrl+C 或 /exit 退出"));
	if (cli.assumeYes) {
		console.log(yellow("  --yes 已开启：写文件、执行命令、提交都不会再询问。"));
	}

	/* -------- REPL -------- */

	try {
		while (!closed) {
			const line = await rl.question(`\n${green("你")} `).catch(() => null);
			if (line === null || closed) break;
			const text = line.trim();
			if (!text) continue;

			if (text === "/exit" || text === "/quit") break;
			if (text === "/help") {
				console.log(dim("  /help   显示这段说明"));
				console.log(dim("  /session 查看 Pi 会话统计"));
				console.log(dim("  /compact 使用 Pi 原生逻辑压缩上下文"));
				console.log(dim("  /settings 查看当前 Pi 运行设置"));
				console.log(dim("  /resume [序号或会话ID] 恢复指定 Pi 会话"));
				console.log(dim("  /new    新建 Pi 会话"));
				console.log(dim("  /clear  新建 Pi 会话（兼容别名）"));
				console.log(dim("  /exit   退出"));
				continue;
			}
			if (text === "/session" || text === "/stats") {
				const stats = piSession.stats();
				console.log(dim(`  Pi 会话 ${sessionManager.getSessionId()}`));
				console.log(dim(`  消息：用户 ${stats.userMessages} · 助手 ${stats.assistantMessages} · 工具调用 ${stats.toolCalls}`));
				console.log(dim(`  Token：输入 ${formatTokens(stats.tokens.input)} · 输出 ${formatTokens(stats.tokens.output)} · 缓存读 ${formatTokens(stats.tokens.cacheRead)} · 缓存写 ${formatTokens(stats.tokens.cacheWrite)} · 累计 ${formatTokens(stats.tokens.total)}`));
				console.log(dim(`  费用：$${stats.cost.toFixed(6)}`));
				continue;
			}
			if (text === "/compact") {
				try {
					const result = await piSession.compact();
					console.log(dim(`  Pi 已压缩上下文：压缩前 ${formatTokens(result.tokensBefore)} tokens · 摘要 ${result.summary.length} 字符`));
				} catch (error) {
					console.error(red(`  Pi 压缩失败：${error instanceof Error ? error.message : String(error)}`));
				}
				continue;
			}
			if (text === "/settings") {
				console.log(dim(`  模型：${runtime.label}`));
				console.log(dim(`  推理强度：${piSession.getThinkingLevel?.() ?? "默认"}`));
				console.log(dim("  自动压缩：Pi AgentSession 已启用"));
				console.log(dim(`  模型上下文窗口：${formatTokens(agent.state.model?.contextWindow ?? 0)} tokens`));
				continue;
			}
			if (text === "/resume" || text.startsWith("/resume ")) {
				const sessions = await SessionManager.list(root);
				if (sessions.length === 0) {
					console.log(dim("  当前工作目录没有可恢复的 Pi 会话。"));
					continue;
				}
				console.log(dim("  可恢复的 Pi 会话："));
				for (const [index, item] of sessions.slice(0, 20).entries()) {
					const title = item.name || item.firstMessage.replace(/\s+/g, " ").slice(0, 72);
					console.log(dim(`  ${index + 1}. ${item.id} · ${item.messageCount} 条 · ${item.modified.toLocaleString()} · ${title}`));
				}
				const selector = text.slice("/resume".length).trim() || await rl.question(`  ${green("输入序号或会话 ID")} `).catch(() => "");
				const selected = /^\d+$/.test(selector)
					? sessions[Number(selector) - 1]
					: sessions.find((item) => item.id === selector || item.id.startsWith(selector));
				if (!selected) {
					console.log(yellow("  没有匹配的会话，当前会话未切换。"));
					continue;
				}
				await switchSession(SessionManager.open(selected.path, undefined, root));
				console.log(dim(`  已恢复 Pi 会话：${sessionManager.getSessionId()}`));
				continue;
			}
			if (text === "/clear" || text === "/new") {
				piSession.newSession();
				console.log(dim(`  已新建 Pi 会话：${sessionManager.getSessionId()}`));
				continue;
			}

			try {
				await piSession.prompt(text);
			} catch (error) {
				console.error(red(`\n运行失败：${error instanceof Error ? error.message : String(error)}`));
			}
		}
	} catch (error) {
		// Ctrl+C 会以 AbortError 结束 question；按正常退出来处理
		if ((error as { name?: string }).name !== "AbortError") throw error;
	} finally {
		rl.close();
		unsubscribe();
		await piSession.shutdown();
		console.log(dim("\n再见。"));
	}
}

await main();
