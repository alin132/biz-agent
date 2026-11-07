/**
 * 编码 Agent 自检（npm run code:selftest）。
 *
 * 为什么不在终端里跑流程：审批要读 stdin，管道输入会在 agent 启动前就把 stdin 关掉，
 * 那样测到的只是"管道行为"，不是产品行为。所以这里直接测两样真东西：
 *  1. 编码工具本身（读写 / 搜索 / shell / git / 路径越界）；
 *  2. 权限钩子（高风险工具没审批必须挡住，有审批才放行）。
 *
 * 全部在临时目录里跑，不碰用户的仓库。
 */
import assert from "node:assert/strict";
import { exec } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createPermissionHook } from "../src/core/permission.js";
import { ToolRegistry } from "../src/core/registry.js";
import { createBusinessAgent } from "../src/core/runtime.js";
import type { BizContext, ToolDef } from "../src/core/types.js";
import { createCodingTools } from "../src/tools/coding.js";
import { createCodingWorkflow } from "../src/coding/workflow.js";

const run = promisify(exec);
let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
	try {
		await fn();
		passed += 1;
		console.log("  ok " + name);
	} catch (error) {
		failed += 1;
		console.error("  FAIL " + name);
		console.error("       " + (error instanceof Error ? error.message : String(error)));
	}
}

function makeCtx(overrides: Partial<BizContext> = {}): BizContext {
	return {
		tenantId: "tenant-test",
		userId: "u-test",
		traceId: "trace-test",
		allow: ["*"],
		requireApproval: [],
		...overrides,
	};
}

function byName(tools: ToolDef[], name: string): ToolDef {
	const found = tools.find((tool) => tool.name === name);
	assert.ok(found, "缺少工具 " + name);
	return found!;
}

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "code-selftest-"));
	try {
		const tools = createCodingTools(root);
		const registry = new ToolRegistry().registerAll(tools);
		const ctx = makeCtx();

		console.log("\n-- 工具集 --");
		await check("注册了 9 个编码工具", () => {
			assert.deepEqual(
				tools.map((tool) => tool.name),
				["fs_read", "fs_write", "fs_list", "fs_grep", "fs_glob", "shell_run", "git_status", "git_diff", "git_commit"],
			);
		});
		await check("写文件 / 执行命令 / 提交被标为高风险（会走审批）", () => {
			for (const name of ["fs_write", "shell_run", "git_commit"]) {
				assert.equal(byName(tools, name).risk, "high", name + " 应为 high");
			}
			assert.equal(byName(tools, "fs_read").risk, "low");
		});

		console.log("\n-- 文件读写 --");
		await check("fs_write 新建文件并 fs_read 读回一致", async () => {
			const written = await byName(tools, "fs_write").execute({ path: "hello.txt", content: "你好，编码 Agent" }, ctx);
			assert.equal(written.isError, undefined);
			const read = await byName(tools, "fs_read").execute({ path: "hello.txt" }, ctx);
			assert.equal(read.content, "你好，编码 Agent");
		});
		await check("fs_write 覆盖已有文件（不是追加）", async () => {
			await byName(tools, "fs_write").execute({ path: "hello.txt", content: "第二版" }, ctx);
			const read = await byName(tools, "fs_read").execute({ path: "hello.txt" }, ctx);
			assert.equal(read.content, "第二版");
		});
		await check("fs_write 自动创建不存在的子目录", async () => {
			await byName(tools, "fs_write").execute({ path: "a/b/c.txt", content: "deep" }, ctx);
			const read = await byName(tools, "fs_read").execute({ path: "a/b/c.txt" }, ctx);
			assert.equal(read.content, "deep");
		});
		await check("fs_list 列出子项，目录带斜杠", async () => {
			const listed = await byName(tools, "fs_list").execute({ path: "." }, ctx);
			assert.ok(listed.content.includes("hello.txt"), "应列出 hello.txt");
			assert.ok(listed.content.includes("a/"), "目录应带斜杠后缀");
		});
		await check("fs_read 读不存在的文件给中文错误而不是崩掉", async () => {
			const read = await byName(tools, "fs_read").execute({ path: "nope.txt" }, ctx);
			assert.equal(read.isError, true);
			assert.ok(read.content.includes("读取失败"), read.content);
		});

		console.log("\n-- 路径越界（安全边界）--");
		await check("fs_read 拒绝 ../ 越界", async () => {
			const read = await byName(tools, "fs_read").execute({ path: "../outside.txt" }, ctx);
			assert.equal(read.isError, true);
			assert.ok(read.content.includes("越界"), read.content);
		});
		await check("fs_write 拒绝工作目录外的绝对路径", async () => {
			const outside = resolve(root, "..", "escape.txt");
			const written = await byName(tools, "fs_write").execute({ path: outside, content: "x" }, ctx);
			assert.equal(written.isError, true);
			assert.ok(written.content.includes("越界"), written.content);
		});
		await check("越界时文件确实没被写出去", async () => {
			await assert.rejects(readFile(resolve(root, "..", "escape.txt"), "utf8"));
		});

		console.log("\n-- 搜索 --");
		await check("fs_grep 命中并给出行号", async () => {
			await byName(tools, "fs_write").execute({ path: "src/app.ts", content: "const a = 1;\nfunction target() {}\n" }, ctx);
			const hit = await byName(tools, "fs_grep").execute({ pattern: "function target" }, ctx);
			// Windows 的路径分隔符是反斜杠，断言前统一成 /，否则测的是平台不是逻辑
			const normalized = hit.content.replace(/\\/g, "/");
			assert.ok(normalized.includes("src/app.ts:2"), "应给出 文件:行号，实际 " + normalized);
		});
		await check("fs_grep 的正则非法时给中文错误", async () => {
			const hit = await byName(tools, "fs_grep").execute({ pattern: "([unclosed" }, ctx);
			assert.equal(hit.isError, true);
			assert.ok(hit.content.includes("正则"), hit.content);
		});
		await check("fs_glob 按模式找文件", async () => {
			const found = await byName(tools, "fs_glob").execute({ pattern: "**/*.ts" }, ctx);
			assert.ok(found.content.includes("src/app.ts"), "应命中 src/app.ts，实际 " + found.content);
		});

		console.log("\n-- shell 执行 --");
		await check("shell_run 正常命令返回输出", async () => {
			const result = await byName(tools, "shell_run").execute({ command: "echo selftest-ok" }, ctx);
			assert.ok(result.content.includes("selftest-ok"), result.content);
		});
		await check("shell_run 非零退出码如实回报", async () => {
			const result = await byName(tools, "shell_run").execute({ command: "exit 3" }, ctx);
			assert.ok(result.content.includes("3"), "应报告退出码 3，实际 " + result.content);
		});
		await check("shell_run 在工作目录内执行（cwd 生效）", async () => {
			// Windows 的 cmd 与 bash 都用 `cd` 打印当前目录，两边都能断言
			const result = await byName(tools, "shell_run").execute({ command: "cd" }, ctx);
			const printed = result.content.trim().replace(/^"|"$/g, "");
			assert.equal(printed, root, "命令应在工作目录内执行，实际 " + printed);
		});

		console.log("\n-- git --");
		await check("git_status 在非仓库目录如实报错", async () => {
			const result = await byName(tools, "git_status").execute({}, ctx);
			assert.equal(result.isError, true);
		});
		await check("git init 之后 status / diff / commit 可用", async () => {
			await run("git init -q", { cwd: root });
			await run("git config user.email t@example.com", { cwd: root });
			await run("git config user.name tester", { cwd: root });
			const status = await byName(tools, "git_status").execute({}, ctx);
			assert.equal(status.isError, undefined, status.content);
			assert.ok(status.content.includes("hello.txt"), status.content);
			await run("git add hello.txt", { cwd: root });
			const diff = await byName(tools, "git_diff").execute({ staged: true }, ctx);
			assert.ok(diff.content.includes("hello.txt"), diff.content);
			const commit = await byName(tools, "git_commit").execute({ message: "test: 自检提交" }, ctx);
			assert.equal(commit.isError, undefined, commit.content);
			const log = await run("git log --oneline", { cwd: root });
			assert.ok(log.stdout.includes("test: 自检提交"), log.stdout);
		});

		console.log("\n-- 审批钩子（高风险必须挡住）--");
		const hook = createPermissionHook(ctx, registry);
		await check("没有审批出口时 fs_write 被阻断", async () => {
			const result = await hook({ toolCall: { name: "fs_write" }, args: { path: "x.txt", content: "x" } } as never);
			assert.equal(result?.block, true);
			assert.ok(result?.reason?.includes("未获人工审批"), result?.reason);
		});
		await check("低风险工具不触发审批", async () => {
			const result = await hook({ toolCall: { name: "fs_read" }, args: { path: "hello.txt" } } as never);
			assert.equal(result, undefined);
		});
		let asked = 0;
		const approvingHook = createPermissionHook(makeCtx({ requestApproval: async () => { asked += 1; return true; } }), registry);
		await check("审批通过后放行，且同一会话内不再重复询问", async () => {
			assert.equal(await approvingHook({ toolCall: { name: "shell_run" }, args: { command: "echo hi" } } as never), undefined);
			assert.equal(await approvingHook({ toolCall: { name: "shell_run" }, args: { command: "echo hi" } } as never), undefined);
			assert.equal(asked, 1, "应只询问一次，实际 " + asked);
		});
		await check("审批拒绝时阻断且带上原因", async () => {
			const denyHook = createPermissionHook(makeCtx({ requestApproval: async () => false }), registry);
			const result = await denyHook({ toolCall: { name: "shell_run" }, args: { command: "echo hi" } } as never);
			assert.equal(result?.block, true);
		});

		console.log("\n-- 装配（回归：空 steps 不暴露工具）--");
		await check("显式 toolNames 后 agent 装上全部编码工具", () => {
			const workflow = createCodingWorkflow(root);
			assert.equal(workflow.steps.length, 0, "编码 Agent 不应有固定步骤");
			const built = createBusinessAgent({
				workflow,
				registry,
				ctx: makeCtx(),
				// 模型只在装配期用到类型，这里用假 runtime 即可：我们只断言工具集
				model: {} as never,
				streamFn: (() => { throw new Error("本用例不发起模型调用"); }) as never,
				toolNames: tools.map((tool) => tool.name),
			});
			const exposed = built.agent.state.tools.map((tool) => tool.name);
			assert.equal(exposed.length, 9, "应装上 9 个工具，实际 " + exposed.join(","));
			assert.ok(exposed.includes("shell_run"));
		});
		await check("不传 toolNames 时确实一个工具都装不上（说明必须显式传）", () => {
			const workflow = createCodingWorkflow(root);
			const built = createBusinessAgent({
				workflow,
				registry,
				ctx: makeCtx(),
				model: {} as never,
				streamFn: (() => { throw new Error("本用例不发起模型调用"); }) as never,
			});
			assert.equal(built.agent.state.tools.length, 0);
		});
		await check("系统提示写明了工作目录与审批约束", () => {
			const prompt = createCodingWorkflow(root).systemPrompt;
			assert.ok(prompt.includes(root), "系统提示应包含工作目录");
			assert.ok(prompt.includes("审批"), "系统提示应说明审批");
			assert.ok(prompt.includes("越界"), "系统提示应说明路径边界");
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}

	console.log("\n编码 Agent 自检：" + (failed === 0 ? "通过 " + passed + " 项" : "失败 " + failed + " 项，通过 " + passed + " 项"));
	if (failed > 0) process.exitCode = 1;
}

await main();