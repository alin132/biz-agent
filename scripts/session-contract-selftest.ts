import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { callTool, createFauxRuntime, say } from "../examples/harness.js";
import { AgentService } from "../server/agents/service.js";
import { SqliteStorage } from "../server/db/sqlite.js";
import type { AgentRecord } from "../server/db/types.js";
import { initKb, closeKb } from "../server/kb/index.js";
import { Session, SessionHub } from "../server/session.js";
import type { SessionAgent, WireEvent } from "../server/session.js";
import type { LlmRuntime } from "../server/llm.js";
import { WorkflowRepo } from "../server/workflows.js";
import { createObservability } from "../server/observability/index.js";
import { WorkflowEngine } from "../src/core/workflow.js";
import { formatTokens } from "../client/src/contextUsage.js";

const dir = mkdtempSync(join(tmpdir(), "biz-contract-"));
const dbPath = join(dir, "contract.db");
process.env.DB_PATH = dbPath;
const db = new SqliteStorage(dbPath);
initKb({ dbPath });
const repo = new WorkflowRepo(db);
const service = new AgentService({ storage: db });
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
	try { await fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { process.exitCode = 1; console.error(`  ✗ ${name}`, error); }
}
function binding(record: AgentRecord): SessionAgent {
	return { id: record.id, name: record.name, prompt: record.agentsMd, skillIds: record.skillIds,
		kbIds: record.kbIds, modelConfig: record.modelConfig, memoryConfig: record.memoryConfig, advancedConfig: record.advancedConfig };
}
function runtime(steps: Parameters<typeof createFauxRuntime>[0], id = "faux-contract") {
	const faux = createFauxRuntime(steps);
	const requests: { context: string; system: string; options: Parameters<StreamFn>[2] }[] = [];
	const streamFn: StreamFn = (model, context, options) => {
		requests.push({ context: JSON.stringify(context), system: JSON.stringify(context.messages.filter((message) => message.role === "system")), options });
		return faux.streamFn(model, context, options);
	};
	const live: LlmRuntime = { ...faux, streamFn, label: id, modelId: id, provider: "faux" };
	return { live, requests };
}
function session(live: LlmRuntime, agent?: SessionAgent) {
	return new Session(repo.get("auto-flow")!, { db, repo, resolveModel: () => live, agent });
}
function eventsOf(subject: Session) {
	const events: WireEvent[] = [];
	subject.subscribe((event) => events.push(event));
	return events;
}

try {
	await check("上下文用量始终使用 k 单位", () => {
		assert.equal(formatTokens(0), "0.0k");
		assert.equal(formatTokens(107), "0.1k");
		assert.equal(formatTokens(1_500), "1.5k");
		assert.equal(formatTokens(256_000), "256.0k");
	});

	await check("上下文用量优先真实 input token，并在缺失时估算和恢复", () => {
		const subject = session(runtime([say("unused")]).live);
		const events = eventsOf(subject);
		const internal = subject as unknown as { recordLlmEvent(message: unknown): void };
		internal.recordLlmEvent({ role: "assistant", usage: { input: 1234, output: 12, totalTokens: 1246 } });
		assert.equal(subject.view().contextTokens, 1234);
		assert.equal(subject.view().contextTokensEstimated, false);
		assert.ok(events.some((event) => event.type === "context_usage" && event.tokens === 1234 && !event.estimated));
		internal.recordLlmEvent({ role: "assistant", usage: { input: 0, output: 0, totalTokens: 0 } });
		assert.equal(subject.view().contextTokensEstimated, true);
		assert.ok(subject.view().contextTokens > 0);
		const saved = db.load(subject.id)!;
		assert.equal(saved.contextTokens, subject.view().contextTokens);
		const restored = new Session(repo.get("auto-flow")!, { db, repo, restore: saved, resolveModel: () => null });
		assert.equal(restored.view().contextTokens, subject.view().contextTokens);
		assert.equal(restored.view().contextTokensEstimated, true);
	});

	await check("每轮会话持久化任务耗时及工具调用明细", async () => {
		const subject = session(runtime([callTool("data_describe", {}), say("完成")]).live);
		await subject.send("查看数据结构");
		const turn = subject.view().transcript.find((item) => item.role === "user")!;
		assert.ok(Number.isFinite(turn.durationMs) && turn.durationMs! >= 0);
		assert.equal(turn.tools?.length, 1);
		assert.equal(turn.tools?.[0]?.name, "data_describe");
		assert.equal(turn.tools?.[0]?.ok, true);
		assert.ok(turn.tools?.[0]?.result);
		assert.ok(Number.isFinite(turn.tools?.[0]?.durationMs));
		const restored = new Session(repo.get("auto-flow")!, { db, repo, restore: db.load(subject.id)!, resolveModel: () => null });
		const restoredTurn = restored.view().transcript.find((item) => item.role === "user")!;
		assert.equal(restoredTurn.durationMs, turn.durationMs);
		assert.deepEqual(restoredTurn.tools, turn.tools);
	});

	await check("停止动作只中断正在运行的会话", () => {
		const subject = session(runtime([say("unused")]).live);
		const internal = subject as unknown as { running: boolean; agent: { abort(): void } };
		let aborted = false;
		internal.agent.abort = () => { aborted = true; };
		assert.equal(subject.stop(), false);
		internal.running = true;
		assert.equal(subject.stop(), true);
		assert.equal(aborted, true);
		internal.running = false;
	});

	await check("模型切换真的调用新运行时，历史和流式事件保留", async () => {
		const old = runtime([say("OLD")], "old");
		const next = runtime([say("NEW")], "new");
		const subject = new Session(repo.get("auto-flow")!, { db, repo, modelId: "old",
			resolveModel: (id) => id === "new" ? next.live : old.live });
		await subject.send("第一轮");
		const events = eventsOf(subject);
		subject.setModel("new");
		await subject.send("第二轮");
		assert.equal(old.requests.length, 1);
		assert.equal(next.requests.length, 1);
		assert.ok(next.requests[0]!.context.includes("第一轮"));
		assert.equal(events.filter((event) => event.type === "text").map((event) => event.delta).join(""), "NEW");
		assert.equal(subject.view().modelId, "new");
	});

	await check("反复切换计划模式后，文字和工具事件各发送一次", async () => {
		const live = runtime([callTool("data_describe", {}), say("PLAN_REPLY")]);
		const subject = session(live.live);
		const events = eventsOf(subject);
		subject.setPlanMode(true);
		subject.setPlanMode(false);
		subject.setPlanMode(true);
		await subject.send("先查结构");
		assert.ok(live.requests[0]!.context.includes("计划模式"));
		assert.equal(events.filter((event) => event.type === "tool_start").length, 1);
		assert.equal(events.filter((event) => event.type === "tool_end").length, 1);
		assert.ok(events.some((event) => event.type === "tool_end" && event.ok));
		assert.equal(events.filter((event) => event.type === "text").map((event) => event.delta).join(""), "PLAN_REPLY");
	});

	await check("模拟会话切到可用模型后，运行模式与持久化同步变为 live", async () => {
		const live = runtime([say("LIVE_REPLY")]);
		let enabled = false;
		const subject = new Session(repo.get("auto-flow")!, { db, repo, resolveModel: () => enabled ? live.live : null });
		assert.equal(subject.view().mode, "simulated");
		enabled = true;
		subject.setModel("enabled");
		assert.equal(subject.view().mode, "live");
		assert.equal(db.load(subject.id)!.mode, "live");
		await subject.send("hello");
		assert.equal(live.requests.length, 1);
	});

	await check("重建后 LLM 与工具调用链仍落库，且不重复", async () => {
		const live = runtime([callTool("data_describe", {}), say("ok")]);
		const obs = createObservability({ storage: db, autoStart: false, retentionDays: 0 });
		try {
			const subject = new Session(repo.get("auto-flow")!, { db, repo, resolveModel: () => live.live, observability: obs });
			subject.setPlanMode(true);
			await subject.send("query");
			obs.flush();
			const traceId = subject.view().traceIds[0]!;
			const events = db.listTraceEvents(traceId);
			assert.equal(events.filter((event) => event.kind === "llm").length, 2);
			assert.equal(events.filter((event) => event.kind === "tool").length, 1);
		} finally { obs.close(); }
	});

	await check("委托子技能在换模型后使用新的运行时", async () => {
		const old = runtime([say("OLD_SHOULD_NOT_RUN")], "old");
		const next = runtime([callTool("flow_data_flow", { task: "查询订单" }),
			callTool("data_describe", {}), callTool("data_query", { limit: 1 }),
			callTool("data_aggregate", { groupBy: "region", metric: "sum_amount" }),
			callTool("report_save", { title: "报告", content: "报告正文" }), say("NESTED_RESULT"), say("PARENT_RESULT")], "new");
		const subject = new Session(repo.get("auto-flow")!, { db, repo, modelId: "old", resolveModel: (id) => id === "new" ? next.live : old.live });
		subject.setModel("new");
		await subject.send("委托执行");
		assert.equal(old.requests.length, 0);
		assert.equal(next.requests.length, 7);
		assert.equal(subject.view().transcript.at(-1)?.text, "PARENT_RESULT");
	});

	const skill = repo.create({ name: "契约说明技能", systemPrompt: "技能提示", steps: [],
		skill: { description: "只含说明", instructions: "UNIQUE_ACTIVE_SKILL_BODY" } });
	await check("模拟会话加载步骤技能后按当前技能执行而非重复自动编排提示", async () => {
		const hub = new SessionHub(db, repo, () => null);
		const subject = hub.create("auto-flow");
		const events: WireEvent[] = [];
		subject.subscribe((event) => {
			events.push(event);
			if (event.type === "approval") subject.resolveApproval(event.requestId, true);
		});
		subject.activateSkill("data-flow");
		events.length = 0;
		await subject.send("按区域汇总订单并生成报告");
		const tools = events.filter((event) => event.type === "tool_start").map((event) => event.name);
		assert.deepEqual(tools.slice(0, 3), ["data_describe", "data_query", "data_aggregate"]);
		const reply = events.filter((event) => event.type === "text").map((event) => event.delta).join("");
		assert.ok(reply.includes("区域分布"));
		assert.ok(!reply.includes("自动编排（当前是模拟模型）"));
	});

	await check("手动加载、恢复、退出技能的正文按当前状态进入请求", async () => {
		const live = runtime([say("one"), say("two"), say("three")]);
		const hub = new SessionHub(db, repo, () => live.live);
		const subject = hub.create("auto-flow");
		subject.activateSkill(skill.id);
		await subject.send("one");
		assert.ok(live.requests[0]!.context.includes("UNIQUE_ACTIVE_SKILL_BODY"));
		assert.ok(!live.requests[0]!.system.includes("UNIQUE_ACTIVE_SKILL_BODY"));
		hub.drop(subject.id);
		const restored = hub.get(subject.id)!;
		await restored.send("two");
		assert.ok(live.requests[1]!.context.includes("UNIQUE_ACTIVE_SKILL_BODY"));
		restored.clearSkill();
		await restored.send("three");
		assert.ok(!live.requests[2]!.context.includes("UNIQUE_ACTIVE_SKILL_BODY"));
	});

	await check("Agent 自动绑定技能正文生效", async () => {
		const live = runtime([say("ok")]);
		const record = service.create({ name: "自动技能", skillIds: [skill.id] });
		await session(live.live, binding(record)).send("test");
		assert.ok(live.requests[0]!.context.includes("UNIQUE_ACTIVE_SKILL_BODY"));
	});

	await check("换模型、计划模式及恢复后保留技能进度，退出恢复原进度", async () => {
		const live = runtime([say("ok")]);
		const hub = new SessionHub(db, repo, () => live.live);
		const subject = hub.create("ticket-flow");
		subject.engine.recordToolResult("ticket_search", true);
		const original = structuredClone(subject.engine.state);
		assert.equal(original.stepIndex, 1);
		subject.activateSkill("data-flow");
		subject.engine.recordToolResult("data_describe", true);
		const active = structuredClone(subject.engine.state);
		assert.equal(active.stepIndex, 1);
		subject.setModel("new");
		assert.deepEqual(subject.engine.state, active);
		subject.setPlanMode(true);
		assert.deepEqual(subject.engine.state, active);
		hub.drop(subject.id);
		const restored = hub.get(subject.id)!;
		assert.deepEqual(restored.engine.state, active);
		restored.clearSkill();
		assert.deepEqual(restored.engine.state, original);
	});

	await check("模型参数传入真实请求选项，恢复时沿用会话快照", async () => {
		const live = runtime([say("one"), say("two")]);
		const record = service.create({ name: "模型参数", modelConfig: { temperature: 0.2, topP: 0.7, maxTokens: 123 } });
		const subject = session(live.live, binding(record));
		await subject.send("one");
		const options = live.requests[0]!.options!;
		assert.equal(options.temperature, 0.2);
		assert.equal(options.samplingParams?.top_p, 0.7);
		assert.equal(options.maxTokens, 123);
		const anthropic = await options.onPayload?.({}, { ...live.live.model, api: "anthropic-messages" });
		assert.deepEqual(anthropic, { top_p: 0.7 });
		const google = await options.onPayload?.({ config: { temperature: 0.2 } }, { ...live.live.model, api: "google-generative-ai" });
		assert.deepEqual(google, { config: { temperature: 0.2, topP: 0.7 } });
		service.update(record.id, { modelConfig: { temperature: 1.5 } });
		const restored = new Session(repo.get("auto-flow")!, { db, repo, restore: db.load(subject.id)!,
			resolveModel: () => live.live, agent: binding(service.get(record.id)) });
		await restored.send("two");
		assert.equal(live.requests[1]!.options!.temperature, 0.2);
	});

	await check("非流式及隐藏思考设置生效，最终答案仍返回", async () => {
		const live = runtime([fauxAssistantMessage([fauxThinking("THINKING_MARKER"), fauxText("FINAL_ANSWER")])]);
		const record = service.create({ name: "输出策略", modelConfig: { stream: false }, advancedConfig: { showThinking: false } });
		const subject = session(live.live, binding(record));
		const events = eventsOf(subject);
		await subject.send("test");
		assert.ok(!events.some((event) => event.type === "text" || event.type === "thinking"));
		assert.ok(events.some((event) => event.type === "done" && event.text === "FINAL_ANSWER"));
	});

	await check("短期记忆按完整用户轮次截取", async () => {
		const live = runtime([say("first"), say("second")]);
		const record = service.create({ name: "滑动窗口", memoryConfig: { shortTermRounds: 1, overflowStrategy: "sliding_window" } });
		const subject = session(live.live, binding(record));
		await subject.send("OLD_USER_MARKER");
		await subject.send("NEW_USER_MARKER");
		assert.ok(!live.requests[1]!.context.includes("OLD_USER_MARKER"));
		assert.ok(live.requests[1]!.context.includes("NEW_USER_MARKER"));
	});

	await check("摘要溢出策略真正生成摘要，再回答并继续发送流式事件", async () => {
		const live = runtime([say("first"), say("SUMMARY_MARKER"), say("AFTER_SUMMARY")]);
		const record = service.create({ name: "摘要记忆", memoryConfig: { shortTermRounds: 1, overflowStrategy: "summarize" } });
		const subject = session(live.live, binding(record));
		await subject.send("OLD_DETAIL_MARKER");
		const events = eventsOf(subject);
		await subject.send("NEW_DETAIL_MARKER");
		assert.equal(live.requests.length, 3);
		assert.ok(live.requests[2]!.context.includes("SUMMARY_MARKER"));
		assert.ok(!live.requests[2]!.system.includes("SUMMARY_MARKER"));
		assert.ok(!live.requests[2]!.context.includes("OLD_DETAIL_MARKER"));
		assert.equal(events.filter((event) => event.type === "text").map((event) => event.delta).join(""), "AFTER_SUMMARY");
		assert.equal(db.load(subject.id)!.summary, "SUMMARY_MARKER");
	});

	await check("手动压缩后模型输出及事件仍可用", async () => {
		const live = runtime([say("COMPACT_SUMMARY"), say("AFTER_COMPACT")]);
		const subject = session(live.live);
		const internal = subject as unknown as { agent: { state: { messages: AgentMessage[] } } };
		for (let i = 0; i < 8; i++) internal.agent.state.messages.push({ role: "user", content: `history ${i}`, timestamp: i });
		await subject.compact();
		const events = eventsOf(subject);
		await subject.send("continue");
		assert.equal(events.filter((event) => event.type === "text").map((event) => event.delta).join(""), "AFTER_COMPACT");
	});

	await check("迭代上限约束自动编排，每条用户消息重新计数", async () => {
		const live = runtime([callTool("data_describe", {}), callTool("data_describe", {}), say("SHOULD_NOT_RUN")]);
		const record = service.create({ name: "限迭代", advancedConfig: { maxIters: 1 } });
		const subject = session(live.live, binding(record));
		const events = eventsOf(subject);
		await subject.send("one");
		assert.equal(live.requests.length, 1);
		assert.ok(events.some((event) => event.type === "error" && event.message.includes("最大推理轮数")));
		await subject.send("two");
		assert.equal(live.requests.length, 2);
	});

	await check("停用后旧会话及恢复会话均拒绝发送，召回后可继续", async () => {
		const live = runtime([say("RESUMED")]);
		const record = service.create({ name: "停用测试" });
		const hub = new SessionHub(db, repo, () => live.live);
		const subject = hub.create("auto-flow", { agent: binding(record) });
		service.applyAction(record.id, "publish");
		service.applyAction(record.id, "stop");
		assert.throws(() => subject.assertChattable(), /停用/);
		await subject.send("blocked");
		assert.equal(live.requests.length, 0);
		hub.drop(subject.id);
		const restored = hub.get(subject.id)!;
		await restored.send("blocked again");
		assert.equal(live.requests.length, 0);
		service.applyAction(record.id, "revert");
		await restored.send("allowed");
		assert.equal(live.requests.length, 1);
	});

	await check("同工具重复步骤分别执行，不复用之前或提前执行的结果", () => {
		const def = { ...repo.get("auto-flow")!, steps: [
			{ id: "first", title: "first", via: ["lookup"], hint: "" },
			{ id: "second", title: "second", via: ["lookup"], hint: "" },
			{ id: "third", title: "third", via: ["other"], hint: "" },
		] };
		const engine = new WorkflowEngine(def);
		engine.recordToolResult("other", true);
		engine.recordToolResult("lookup", true);
		assert.deepEqual(engine.state.completed, ["first"]);
		const restored = new WorkflowEngine(def, structuredClone(engine.state));
		restored.recordToolResult("lookup", false);
		assert.equal(restored.state.stepIndex, 1);
		restored.recordToolResult("lookup", true);
		assert.equal(restored.state.stepIndex, 2);
		restored.recordToolResult("other", true);
		assert.equal(restored.done, true);
	});
} finally {
	closeKb();
	db.close();
	if (dirname(dir) === resolve(tmpdir()) && basename(dir).startsWith("biz-contract-")) rmSync(dir, { recursive: true });
}
console.log(`功能契约自检：${passed} 项通过`);
