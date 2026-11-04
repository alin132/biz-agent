/**
 * 会话持久化验证。
 *
 * 用法：
 *   npm run persist-check -- --write              新建会话、发一句话、打印会话 ID
 *   npm run persist-check -- --read <id>          读取会话（用于重启后验证历史还在）
 *   npm run persist-check -- --read <id> --continue  读取后继续追问，验证模型记得前文
 *
 * 完整的重启验证流程：
 *   1. npm run persist-check -- --write          记下输出的 SESSION_ID
 *   2. 重启服务（Ctrl+C 后 npm run dev）
 *   3. npm run persist-check -- --read <SESSION_ID> --continue
 *
 * --write 阶段会顺带把会话改成固定标题并归档，--read 阶段据此断言标题与归档状态也一起从存储恢复了。
 */

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:4317";

/** write 阶段写死的可识别标题，read 阶段拿它比对，验证 title 真的落库了。 */
const PERSIST_TITLE = "持久化标题验证";

interface Wire {
	type: string;
	[key: string]: unknown;
}

interface SessionSnapshot {
	id: string;
	workflowName: string;
	modeLabel: string;
	title: string | null;
	archived: boolean;
	steps: { title: string; status: string }[];
	transcript: { role: string; text: string }[];
	audit: { toolName: string; ok: boolean }[];
	done: boolean;
	restored: boolean;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSession(id: string): Promise<SessionSnapshot> {
	const response = await fetch(`${BASE}/api/sessions/${id}`);
	if (!response.ok) {
		throw new Error(`会话 ${id} 不存在（HTTP ${response.status}）`);
	}
	return (await response.json()) as SessionSnapshot;
}

/** PATCH /api/sessions/:id（重命名与归档共用这一个入口），返回 title 与 archived。 */
async function patchSession(id: string, body: unknown): Promise<{ title: string | null; archived: boolean }> {
	const response = await fetch(`${BASE}/api/sessions/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(`会话 ${id} 更新失败（HTTP ${response.status}）`);
	}
	return (await response.json()) as { title: string | null; archived: boolean };
}

async function renameSession(id: string, title: string): Promise<string | null> {
	return (await patchSession(id, { title })).title;
}

async function archiveSession(id: string, archived: boolean): Promise<boolean> {
	return (await patchSession(id, { archived })).archived;
}

async function runOnce(sessionId: string, text: string): Promise<void> {
	const events: Wire[] = [];
	const stream = await fetch(`${BASE}/api/sessions/${sessionId}/events`);
	const reader = stream.body?.getReader();
	if (!reader) throw new Error("SSE 无响应体");

	void (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let at = buffer.indexOf("\n\n");
			while (at >= 0) {
				const chunk = buffer.slice(0, at);
				buffer = buffer.slice(at + 2);
				for (const line of chunk.split("\n")) {
					if (!line.startsWith("data: ")) continue;
					try {
						events.push(JSON.parse(line.slice(6)) as Wire);
					} catch {
						// ignore
					}
				}
				at = buffer.indexOf("\n\n");
			}
		}
	})();

	const waitFor = async (predicate: (event: Wire) => boolean, timeoutMs: number): Promise<boolean> => {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			if (events.some(predicate)) return true;
			await sleep(80);
		}
		return false;
	};

	if (!(await waitFor((event) => event.type === "ready", 5000))) {
		throw new Error("SSE 未就绪");
	}

	await fetch(`${BASE}/api/sessions/${sessionId}/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
	});

	const started = Date.now();
	while (Date.now() - started < 180_000) {
		if (events.some((event) => event.type === "done")) {
			const done = events.find((event) => event.type === "done")!;
			const tools = events.filter((event) => event.type === "tool_start").map((event) => String(event.name));
			console.log(`  工具调用: ${tools.join(" → ") || "（无）"}`);
			console.log(`  回复: ${String(done.text ?? "").slice(0, 300)}`);
			return;
		}
		const error = events.find((event) => event.type === "error");
		if (error) {
			throw new Error(`模型报错: ${String(error.message)}`);
		}
		await sleep(150);
	}
	throw new Error("等待回复超时");
}

function printSession(session: SessionSnapshot): void {
	console.log(`会话: ${session.id}  (${session.workflowName})  模型=${session.modeLabel}`);
	console.log(`标题: ${session.title ?? "（未自定义，前端用首条消息派生）"}`);
	console.log(`归档: ${session.archived ? "已归档" : "未归档"}`);
	console.log(`从存储恢复: ${session.restored ? "是" : "否（内存中）"}`);
	console.log(`流程: ${session.steps.map((step) => `${step.title}[${step.status}]`).join(" → ")}`);
	console.log(`审计: ${session.audit.map((entry) => `${entry.toolName}${entry.ok ? "" : "(失败)"}`).join(" → ") || "（无）"}`);
	console.log(`对话条数: ${session.transcript.length}`);
	session.transcript.forEach((turn, index) => {
		const text = turn.text.length > 160 ? `${turn.text.slice(0, 160)}…` : turn.text;
		console.log(`  [${index + 1}] ${turn.role}: ${text}`);
	});
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const write = argv.includes("--write");
	const readIndex = argv.indexOf("--read");
	const shouldContinue = argv.includes("--continue");

	if (write) {
		const response = await fetch(`${BASE}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ workflowId: "ticket-flow" }),
		});
		const created = (await response.json()) as { id: string };
		console.log("【写入阶段】");
		await runOnce(created.id, "把 TK-1001 处理掉，指派给李工，然后通知客户");
		const savedTitle = await renameSession(created.id, PERSIST_TITLE);
		if (savedTitle !== PERSIST_TITLE) {
			throw new Error(`改名未生效：期望「${PERSIST_TITLE}」，实际「${String(savedTitle)}」`);
		}
		console.log(`已把会话改名为「${savedTitle}」（--read 阶段会校验它是否落库）`);

		const archived = await archiveSession(created.id, true);
		if (archived !== true) {
			throw new Error(`归档未生效：期望 archived=true，实际 ${String(archived)}`);
		}
		console.log("已把会话归档（--read 阶段会校验它是否落库）");
		const fresh = await getSession(created.id);
		printSession(fresh);
		console.log(`\nSESSION_ID=${created.id}`);
		process.exit(0);
	}

	if (readIndex >= 0) {
		const id = argv[readIndex + 1];
		if (!id) {
			throw new Error("缺少会话 ID：--read <id>");
		}
		console.log("【读取阶段】");
		const session = await getSession(id);
		printSession(session);

		if (session.title !== PERSIST_TITLE) {
			throw new Error(
				`标题未从存储恢复：期望「${PERSIST_TITLE}」，实际「${String(session.title)}」。\n` +
					"  提示：本脚本的 --read 是配合 --write 的两段式校验，只认 --write 阶段写下的标题；\n" +
					"        直接拿 --read 读旧会话（或别人创建的会话）会得到这个报错，属预期。",
			);
		}
		console.log(`✓ 自定义标题已从存储恢复：「${session.title}」`);

		if (session.archived !== true) {
			throw new Error(
				`归档状态未从存储恢复：期望 archived=true，实际 ${String(session.archived)}。\n` +
					"  提示：本脚本的 --read 是配合 --write 的两段式校验；直接读旧会话会得到这个报错，属预期。",
			);
		}
		console.log("✓ 归档状态已从存储恢复（archived=true）");

		if (shouldContinue) {
			console.log("\n【继续追问，验证上下文是否恢复】");
			await runOnce(id, "刚才那条工单是哪个客户的？");
			const after = await getSession(id);
			console.log(`  对话条数: ${after.transcript.length}`);
			console.log(`  归档状态: ${after.archived ? "已归档" : "未归档（收到新消息后已自动取消归档，符合预期）"}`);
			printSession(after);
		}
		process.exit(0);
	}

	console.error("用法: --write | --read <id> [--continue]");
	process.exit(1);
}

main().catch((error: unknown) => {
	console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
