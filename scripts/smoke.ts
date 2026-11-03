/**
 * 端到端冒烟测试：走真实 HTTP + SSE，验证 Web 链路完整可用。
 *
 * 前置：先跑 `npm run dev` 把服务起来。
 * 跑法：npm run smoke
 *
 * 覆盖两条主链路：
 *   A. 工单流程 —— 四个工具依次执行，流程走完
 *   B. 审批流程 —— 高风险工具触发审批事件，人工同意后继续并归档
 */

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:4317";

interface Wire {
	type: string;
	[key: string]: unknown;
}

function fail(message: string): never {
	console.error(`✗ ${message}`);
	process.exit(1);
}

function assert(condition: boolean, message: string): void {
	if (!condition) fail(message);
	console.log(`  ✓ ${message}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface StreamHandle {
	events: Wire[];
	waitFor: (predicate: (event: Wire) => boolean, timeoutMs?: number) => Promise<Wire>;
}

async function openStream(sessionId: string): Promise<StreamHandle> {
	const response = await fetch(`${BASE}/api/sessions/${sessionId}/events`);
	if (!response.ok) fail("SSE 连接建立失败");
	const reader = response.body?.getReader();
	if (!reader) fail("SSE 无响应体");

	const events: Wire[] = [];
	void (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let index = buffer.indexOf("\n\n");
			while (index >= 0) {
				const chunk = buffer.slice(0, index);
				buffer = buffer.slice(index + 2);
				for (const line of chunk.split("\n")) {
					if (!line.startsWith("data: ")) continue;
					try {
						events.push(JSON.parse(line.slice(6)) as Wire);
					} catch {
						// 忽略注释行与无法解析的内容
					}
				}
				index = buffer.indexOf("\n\n");
			}
		}
	})();

	const waitFor = async (predicate: (event: Wire) => boolean, timeoutMs = 20000): Promise<Wire> => {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			const hit = events.find(predicate);
			if (hit) return hit;
			await sleep(50);
		}
		fail(`等待事件超时，已收到: ${events.map((event) => event.type).join(", ")}`);
	};

	return { events, waitFor };
}

async function createSession(workflowId: string): Promise<{ id: string; steps: { status: string }[] }> {
	const response = await fetch(`${BASE}/api/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ workflowId }),
	});
	if (!response.ok) fail(`创建会话失败: ${workflowId}`);
	return (await response.json()) as { id: string; steps: { status: string }[] };
}

async function sendMessage(sessionId: string, text: string): Promise<void> {
	const response = await fetch(`${BASE}/api/sessions/${sessionId}/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
	});
	if (response.status !== 202) fail("消息未被接受");
}

/* ---------------- 场景 A：工单流程 ---------------- */

async function scenarioTicket(): Promise<void> {
	console.log("\n[A] 工单流程");

	const session = await createSession("ticket-flow");
	assert(session.steps[0]?.status === "active", "初始时第 1 步为 active");

	const stream = await openStream(session.id);
	await stream.waitFor((event) => event.type === "ready");
	assert(true, "收到 ready 事件");

	await sendMessage(session.id, "把支付回调超时的工单处理掉，并通知客户");

	const doneEvent = await stream.waitFor((event) => event.type === "done");
	assert(String(doneEvent.text ?? "").length > 0, "最终回复非空");

	const textDeltas = stream.events.filter((event) => event.type === "text");
	assert(textDeltas.length > 0, `收到流式文本（${textDeltas.length} 段）`);

	const toolStarts = stream.events.filter((event) => event.type === "tool_start");
	assert(toolStarts.length === 4, `触发 4 次工具调用（实际 ${toolStarts.length}）`);

	const toolEnds = stream.events.filter((event) => event.type === "tool_end");
	assert(toolEnds.every((event) => event.ok === true), "所有工具调用成功");

	const lastWorkflow = [...stream.events].reverse().find((event) => event.type === "workflow");
	const steps = lastWorkflow?.steps as { status: string }[] | undefined;
	assert(Array.isArray(steps) && steps.every((step) => step.status === "done"), "流程 4 步全部完成");

	const snapshot = (await (await fetch(`${BASE}/api/sessions/${session.id}`)).json()) as {
		done: boolean;
		audit: { toolName: string }[];
		transcript: { role: string }[];
	};
	assert(snapshot.done === true, "会话快照显示流程已完成");
	assert(snapshot.audit.length === 4, `审计记录 4 条（实际 ${snapshot.audit.length}）`);
	assert(snapshot.transcript.length === 2, "transcript 有一问一答");
}

/* ---------------- 场景 B：审批流程（同意） ---------------- */

async function scenarioApproval(): Promise<void> {
	console.log("\n[B] 审批流程（人工同意）");

	const session = await createSession("approval-flow");
	const stream = await openStream(session.id);
	await stream.waitFor((event) => event.type === "ready");

	await sendMessage(session.id, "帮张明提交一笔 3200 元的报销，客户拜访差旅费");

	const approval = await stream.waitFor((event) => event.type === "approval");
	assert(String(approval.toolName ?? "") === "approval_submit", "高风险工具触发审批事件");
	assert(String(approval.risk ?? "") === "high", "审批事件带 high 风险等级");
	assert(typeof approval.requestId === "string", "审批事件带 requestId");

	const approveResponse = await fetch(`${BASE}/api/sessions/${session.id}/approve`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ requestId: approval.requestId, approved: true }),
	});
	assert(approveResponse.ok, "审批决定被接受");

	const doneEvent = await stream.waitFor((event) => event.type === "done", 25000);
	assert(String(doneEvent.text ?? "").length > 0, "审批通过后流程继续并产出回复");

	const lastWorkflow = [...stream.events].reverse().find((event) => event.type === "workflow");
	const steps = lastWorkflow?.steps as { status: string }[] | undefined;
	assert(Array.isArray(steps) && steps.every((step) => step.status === "done"), "审批流程 3 步全部完成");

	const toolNames = stream.events
		.filter((event) => event.type === "tool_end")
		.map((event) => String(event.name));
	assert(
		toolNames.includes("approval_submit") && toolNames.includes("approval_archive"),
		`提交与归档均已执行（${toolNames.join(" → ")}）`,
	);
}

async function main(): Promise<void> {
	console.log(`冒烟测试目标: ${BASE}`);
	await scenarioTicket();
	await scenarioApproval();
	console.log("\n冒烟测试全部通过");
	process.exit(0);
}

main().catch((error: unknown) => {
	fail(error instanceof Error ? error.message : String(error));
});
