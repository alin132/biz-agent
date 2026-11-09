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
import type { PiRuntimeAdapter } from "../server/piRuntimeAdapter.js";
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

function seedPiHistory(subject: Session, count: number, marker: string): void {
	const internal = subject as unknown as {
		piHistory: { appendMessage(message: AgentMessage): unknown; buildSessionContext(): { messages: AgentMessage[] } };
		transcript: Array<{ role: "user" | "assistant"; text: string; at: number }>;
	};
	for (let i = 0; i < count; i++) {
		const text = `${marker}_${i} `.repeat(40);
		internal.piHistory.appendMessage({ role: "user", content: text, timestamp: i + 1 } as AgentMessage);
		internal.transcript.push({ role: "user", text, at: i + 1 });
	}
}

try {
	await check("Pi 工作空间压缩设置用于普通新会话，Agent 配置与已创建会话优先", () => {
		db.setModelSetting("pi.settings.v1", JSON.stringify({ compaction: { enabled: false, reserveTokens: 8192, keepRecentTokens: 12000 } }));
		const ordinary = new Session(repo.get("auto-flow")!, { db, repo, resolveModel: () => null });
		const ordinaryState = ordinary as unknown as { agentConfig: { memoryConfig: { reserveTokens?: number; keepRecentTokens?: number } }; autoCompactionEnabled: boolean };
		assert.deepEqual(ordinaryState.agentConfig.memoryConfig, { reserveTokens: 8192, keepRecentTokens: 12000 });
		assert.equal(ordinaryState.autoCompactionEnabled, false);
		assert.deepEqual(db.load(ordinary.id)?.agentConfig?.memoryConfig, { reserveTokens: 8192, keepRecentTokens: 12000 });
		assert.equal(db.load(ordinary.id)?.piAutoCompactionEnabled, false);
		const restored = new Session(repo.get("auto-flow")!, { db, repo, restore: db.load(ordinary.id)!, resolveModel: () => null });
		assert.equal((restored as unknown as { autoCompactionEnabled: boolean }).autoCompactionEnabled, false);
		const configuredAgent = service.create({ name: "自定义记忆 Agent", memoryConfig: { reserveTokens: 4096, keepRecentTokens: 9000 } });
		const agentSession = new Session(repo.get("auto-flow")!, { db, repo, agent: binding(configuredAgent), resolveModel: () => null });
		const agentState = agentSession as unknown as { agentConfig: { memoryConfig: { reserveTokens?: number; keepRecentTokens?: number } }; autoCompactionEnabled: boolean };
		assert.deepEqual(agentState.agentConfig.memoryConfig, { reserveTokens: 4096, keepRecentTokens: 9000 });
		assert.equal(agentState.autoCompactionEnabled, true);
		db.setModelSetting("pi.settings.v1", null);
	});

	await check("上下文用量始终使用 k 单位", () => {
		assert.equal(formatTokens(0), "0.0k");
		assert.equal(formatTokens(107), "0.1k");
		assert.equal(formatTokens(1_500), "1.5k");
		assert.equal(formatTokens(256_000), "256.0k");
	});

	await check("重命名同步更新业务标题与 Pi session info，且恢复后保留", () => {
		const subject = session(runtime([say("unused")]).live);
		subject.setTitle("部门协作会话");
		const getPiName = (value: Session) => (value as unknown as { piHistory: { getSessionName(): string | undefined } }).piHistory.getSessionName();
		assert.equal(subject.view().title, "部门协作会话");
		assert.equal(getPiName(subject), "部门协作会话");
		const restored = new Session(repo.get("auto-flow")!, { db, repo, restore: db.load(subject.id)!, resolveModel: () => null });
		assert.equal(restored.view().title, "部门协作会话");
		assert.equal(getPiName(restored), "部门协作会话");
	});

	await check("Pi 资源刷新更新插件技能快照并保留原会话历史", async () => {
		const subject = new Session(repo.get("auto-flow")!, { db, repo, resolveModel: () => null });
		const internal = subject as unknown as {
			ensurePiRuntime(): Promise<PiRuntimeAdapter>;
			piHistory: { appendMessage(message: AgentMessage): string; getBranch(): Array<{ id: string }> };
		};
		internal.piHistory.appendMessage({ role: "user", content: "保留这条 Pi 历史", timestamp: Date.now() } as AgentMessage);
		const beforeIds = internal.piHistory.getBranch().map((entry) => entry.id);
		const firstRuntime = await internal.ensurePiRuntime();
		assert.ok(!firstRuntime.piSkills().includes("contract-reload-skill"));
		db.createPlugin({
			id: "pi-skill-contract-reload",
			name: "Pi reload contract",
			version: "1.0.0",
			description: "",
			manifest: { skills: [{ id: "contract-reload-skill", description: "Reloaded skill", instructions: "Reloaded instructions" }] },
			enabled: true,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		try {
			const refreshed = await subject.reloadPiResources();
			assert.ok(refreshed.piSkills.includes("contract-reload-skill"), "刷新后 Pi ResourceLoader 读取最新已启用插件技能");
			assert.deepEqual(internal.piHistory.getBranch().map((entry) => entry.id), beforeIds, "runtime 重建沿用原 Pi session tree，不创建新对话");
			assert.equal(refreshed.session.id, subject.id);
		} finally {
			db.removePlugin("pi-skill-contract-reload");
			await subject.shutdown();
		}
	});

	await check("Pi clone 与 fork 创建独立且可恢复的业务会话", () => {
		const live = runtime([say("unused")]).live;
		const hub = new SessionHub(db, repo, () => live);
		const agentRecord = service.create({ name: "衍生会话 Agent" });
		const source = hub.create("auto-flow", { ownerId: "owner-source", agent: binding(agentRecord) });
		const history = (source as unknown as { piHistory: { appendMessage(message: AgentMessage): string; getBranch(): Array<{ id: string }> } }).piHistory;
		history.appendMessage({ role: "user", content: "原始问题", timestamp: 101 } as AgentMessage);
		history.appendMessage({ role: "assistant", content: [{ type: "text", text: "原始回答" }], timestamp: 102 } as AgentMessage);
		const forkPromptId = history.appendMessage({ role: "user", content: "再试一次", timestamp: 103 } as AgentMessage);
		const sourceIds = history.getBranch().map((entry) => entry.id);
		const cloned = hub.derive(source.id, "clone", { ownerId: "owner-clone" });
		assert.notEqual(cloned.session.id, source.id);
		assert.equal(cloned.session.view().agentId, source.view().agentId);
		assert.deepEqual(cloned.session.view().transcript.map((entry) => entry.text), ["原始问题", "原始回答", "再试一次"]);
		assert.deepEqual(history.getBranch().map((entry) => entry.id), sourceIds, "deriving must not move or mutate source history");
		assert.equal(db.load(cloned.session.id)?.createdBy, "owner-clone");
		const forked = hub.derive(source.id, "fork", { entryId: forkPromptId, ownerId: "owner-fork" });
		assert.equal(forked.editorText, "再试一次");
		assert.deepEqual(forked.session.view().transcript.map((entry) => entry.role), ["user", "assistant"]);
		assert.equal(forked.session.view().agentId, source.view().agentId);
		assert.deepEqual(db.load(forked.session.id)?.audit, [], "derived conversation starts with a fresh execution audit");
		hub.drop(cloned.session.id);
		const restoredClone = hub.get(cloned.session.id)!;
		assert.equal(restoredClone.view().transcript.length, 3, "the derived Pi branch restores after cache eviction");
		assert.equal(restoredClone.view().restored, true);
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

	await check("SessionHub shutdown 等待 Pi 扩展关闭且保留会话记录", async () => {
		const live = runtime([say("服务关闭前的 Pi 回复")]).live;
		const hub = new SessionHub(db, repo, () => live);
		const subject = hub.create("auto-flow");
		await subject.send("服务关闭生命周期验证");
		const transcript = subject.view().transcript;
		assert.equal(transcript.length, 2);
		await hub.shutdown();
		const saved = db.load(subject.id);
		assert.ok(saved, "shutdown must keep the persisted session record");
		const restored = new Session(repo.get("auto-flow")!, { db, repo, restore: saved!, resolveModel: () => null });
		assert.deepEqual(restored.view().transcript.map((entry) => entry.text), transcript.map((entry) => entry.text));
		restored.dispose();
	});

	await check("停止动作标记正在初始化的 Pi 会话为中断", () => {
		const subject = session(runtime([say("unused")]).live);
		const internal = subject as unknown as { running: boolean; stopRequested: boolean };
		assert.equal(subject.stop(), false);
		internal.running = true;
		assert.equal(subject.stop(), true);
		assert.equal(internal.stopRequested, true);
		internal.running = false;
	});

	await check("停止等待审批的会话会拒绝并清理挂起审批", async () => {
		const subject = session(runtime([callTool("approval_submit", {
			applicant: "张明", type: "报销", amount: 3200, reason: "客户拜访差旅",
		}), say("审批已取消")]).live);
		let markApproval!: (event: Extract<WireEvent, { type: "approval" }>) => void;
		const approvalEvent = new Promise<Extract<WireEvent, { type: "approval" }>>((resolve) => { markApproval = resolve; });
		subject.subscribe((event) => { if (event.type === "approval") markApproval(event); });
		const sending = subject.send("提交报销审批");
		const approval = await approvalEvent;
		assert.equal(subject.pendingApprovalViews().length, 1);
		assert.equal(subject.stop(), true);
		await sending;
		assert.equal(subject.pendingApprovalViews().length, 0);
		assert.equal(subject.resolveApproval(approval.requestId, true), false, "停止后迟到的批准应无效");
		assert.equal(subject.store.approvals.length, 0, "停止后高风险工具不能执行");
		assert.equal(subject.view().running, false);
	});

	await check("Pi runtime 初始化期间停止会阻止迟到的 prompt", async () => {
		const subject = session(runtime([say("must not run")]).live);
		let release!: (runtime: PiRuntimeAdapter) => void;
		let markInitialized!: () => void;
		const initialized = new Promise<void>((resolve) => { markInitialized = resolve; });
		const pending = new Promise<PiRuntimeAdapter>((resolve) => { release = resolve; });
		let prompts = 0;
		let aborts = 0;
		const internal = subject as unknown as {
			ensurePiRuntime(): Promise<PiRuntimeAdapter>;
			piRuntime: PiRuntimeAdapter | null;
		};
		internal.ensurePiRuntime = async () => {
			markInitialized();
			return pending;
		};
		const sending = subject.send("cancel during Pi setup");
		await initialized;
		assert.equal(subject.stop(), true);
		release({
			prompt: async () => { prompts++; }, followUp: async () => {}, messages: () => [], systemPrompt: () => "", lastAssistantText: () => "",
			lastAssistantMessage: () => undefined, compact: async () => { throw new Error("unused"); },
			stats: () => ({}) as ReturnType<PiRuntimeAdapter["stats"]>, navigateTree: async () => ({ cancelled: false }),
			abort: async () => { aborts++; }, setActiveToolsByName: () => {}, canonicalToolName: (name) => name, setModel: async () => {}, newSession: () => {}, subscribe: () => () => {},
			exportHistory: () => [], piSkills: () => [], dispose: () => {}, shutdown: async () => {}, session: {} as PiRuntimeAdapter["session"],
		});
		await sending;
		assert.equal(prompts, 0);
		assert.equal(aborts, 1);
		assert.equal(subject.view().running, false);
	});

	await check("Pi runtime 初始化期间停止会将调用链记为中断", async () => {
		const subject = session(runtime([say("must not run")]).live);
		const obs = createObservability({ storage: db, autoStart: false, retentionDays: 0 });
		try {
			const internal = subject as unknown as { ensurePiRuntime(): Promise<PiRuntimeAdapter> };
			let release!: (runtime: PiRuntimeAdapter) => void;
			let markInitialized!: () => void;
			const initialized = new Promise<void>((resolve) => { markInitialized = resolve; });
			internal.ensurePiRuntime = () => {
				markInitialized();
				return new Promise<PiRuntimeAdapter>((resolve) => { release = resolve; });
			};
			const traced = new Session(repo.get("auto-flow")!, { db, repo, resolveModel: () => runtime([say("unused")]).live, observability: obs });
			const tracedInternal = traced as unknown as { ensurePiRuntime(): Promise<PiRuntimeAdapter> };
			tracedInternal.ensurePiRuntime = internal.ensurePiRuntime;
			const sending = traced.send("cancel with trace");
			await initialized;
			traced.stop();
			release({ prompt: async () => {}, followUp: async () => {}, messages: () => [], systemPrompt: () => "", lastAssistantText: () => "", lastAssistantMessage: () => undefined,
				compact: async () => { throw new Error("unused"); }, stats: () => ({}) as ReturnType<PiRuntimeAdapter["stats"]>, abort: async () => {},
				setActiveToolsByName: () => {}, canonicalToolName: (name) => name, setModel: async () => {}, newSession: () => {}, subscribe: () => () => {}, exportHistory: () => [], piSkills: () => [], dispose: () => {}, shutdown: async () => {},
				navigateTree: async () => ({ cancelled: false }), session: {} as PiRuntimeAdapter["session"] });
			await sending;
			obs.flush();
			const trace = db.getTrace(traced.view().traceIds[0]!);
			assert.equal(trace?.status, "error");
		} finally { obs.close(); }
	});

	await check("Pi 追加式会话树是新写入历史，旧消息快照不再双存", async () => {
		const subject = session(runtime([say("canonical Pi history")]).live);
		await subject.send("canonical history request");
		const saved = db.load(subject.id)!;
		assert.ok(saved.piSessionEntries?.some((entry) => (entry as { type?: string }).type === "message"));
		assert.equal(saved.agentMessages, undefined, "new saves do not duplicate the Pi context projection");
		const legacy = { ...saved, piSessionEntries: undefined, agentMessages: [{ role: "user", content: "legacy snapshot", timestamp: 11 }] };
		const restored = new Session(repo.get("auto-flow")!, { db, repo, restore: legacy, resolveModel: () => null });
		assert.ok(restored.piTree().nodes.length > 0, "legacy AgentMessage history still imports into a Pi session tree");
	});

	await check("恢复和只读会话视图都以 Pi 活动分支重建 transcript", async () => {
		const subject = session(runtime([say("original branch reply"), say("alternate branch reply")]).live);
		await subject.send("branch point request");
		const internal = subject as unknown as {
			piHistory: { getBranch(): Array<{ id: string; type: string; message?: { role: string; content?: unknown } }> };
		};
		const branchPoint = internal.piHistory.getBranch().find((entry) => entry.type === "message" && entry.message?.role === "user");
		assert.ok(branchPoint, "first Pi user message exists as a branch point");
		await subject.navigatePiTree(branchPoint.id);
		await subject.send("alternate branch request");
		const saved = db.load(subject.id)!;
		const activeUserTexts = internal.piHistory.getBranch()
			.filter((entry) => entry.type === "message" && entry.message?.role === "user")
			.map((entry) => {
				const content = entry.message?.content;
				if (typeof content === "string") return content;
				if (!Array.isArray(content)) return "";
				return content.filter((part): part is { text: string } => Boolean(part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"))
					.map((part) => part.text).join("");
			});
		assert.equal(activeUserTexts.at(-1), "alternate branch request");
		assert.ok(!activeUserTexts.includes("stale abandoned branch"));

		const stale = {
			...saved,
			transcript: [{ role: "user" as const, text: "stale abandoned branch", at: 1 }],
			summary: "stale abandoned branch summary",
			compactedAt: 1,
			compactedAutomatically: true,
		};
		db.save(stale);
		const restored = new Session(repo.get("auto-flow")!, { db, repo, restore: db.load(subject.id)!, resolveModel: () => null });
		assert.deepEqual(restored.view().transcript.filter((entry) => entry.role === "user").map((entry) => entry.text), activeUserTexts);
		assert.equal(restored.view().summary, null, "summary metadata from an abandoned branch is ignored");
		assert.equal(restored.view().compactedAt, null);
		const hub = new SessionHub(db, repo, () => null);
		assert.deepEqual(hub.get(subject.id)!.view().transcript.filter((entry) => entry.role === "user").map((entry) => entry.text), activeUserTexts,
			"read-only list/detail views also project the Pi active branch");
		assert.equal(hub.get(subject.id)!.view().summary, null);
	});

	await check("Pi 分支导航按分支恢复技能、步骤和基础流程进度", async () => {
		const live = runtime([say("root reply")]).live;
		const subject = new Session(repo.get("ticket-flow")!, { db, repo, resolveModel: () => live });
		await subject.send("root request");
		const internal = subject as unknown as {
			piHistory: { getBranch(): Array<{ id: string; type: string; message?: { role: string } }> };
			persistPiBusinessState(): void;
		};
		const rootUser = internal.piHistory.getBranch().find((entry) => entry.type === "message" && entry.message?.role === "user");
		assert.ok(rootUser);

		const rootTool = subject.engine.currentStep?.via[0];
		assert.ok(rootTool);
		subject.engine.recordToolResult(rootTool, true);
		const rootProgress = structuredClone(subject.engine.state);
		subject.activateSkill("data-flow");
		subject.engine.recordToolResult("data_describe", true);
		internal.persistPiBusinessState();
		const skillState = structuredClone(subject.engine.state);
		const skillMarker = [...internal.piHistory.getBranch()].reverse().find((entry) => entry.type === "custom");
		assert.ok(skillMarker);

		await subject.navigatePiTree(rootUser.id);
		assert.equal(subject.view().activeSkillId, null);
		assert.deepEqual(subject.engine.state, { workflowId: "ticket-flow", stepIndex: 0, completed: [], calls: [] },
			"branch without a marker after history has business markers starts with its root state");

		await subject.navigatePiTree(skillMarker.id);
		assert.equal(subject.view().activeSkillId, "data-flow");
		assert.deepEqual(subject.engine.state, skillState);
		assert.deepEqual(subject.engine.state.workflowId, skillState.workflowId);
		subject.clearSkill();
		assert.deepEqual(subject.engine.state, rootProgress, "the skill marker restores its branch-local base workflow snapshot");
		assert.ok(rootProgress.stepIndex > 0, "the prior root workflow had independent progress");
	});

	await check("销毁会话会拒绝挂起审批且不会在删除后重新落库", async () => {
		const subject = session(runtime([callTool("approval_submit", {
			applicant: "张明", type: "报销", amount: 3200, reason: "客户拜访差旅",
		}), say("must not run")]).live);
		let markApproval!: () => void;
		const approvalEvent = new Promise<void>((resolve) => { markApproval = resolve; });
		subject.subscribe((event) => { if (event.type === "approval") markApproval(); });
		const sending = subject.send("wait for approval");
		await approvalEvent;
		const id = subject.id;
		subject.dispose();
		db.remove(id);
		await sending;
		assert.equal(subject.pendingApprovalViews().length, 0);
		assert.equal(db.load(id), undefined, "late send finalization must not resurrect a removed session");
	});

	await check("模型切换真的调用新运行时，历史和流式事件保留", async () => {
		const old = runtime([say("OLD")], "old");
		const next = runtime([say("NEW")], "new");
		const subject = new Session(repo.get("auto-flow")!, { db, repo, modelId: "old",
			resolveModel: (id) => id === "new" ? next.live : old.live });
		await subject.send("第一轮");
		const events = eventsOf(subject);
		await subject.setModel("new");
		assert.ok((db.load(subject.id)?.piSessionEntries as Array<{ type?: string }>).some((entry) => entry.type === "model_change"),
			"model switching is recorded in the Pi session tree");
		const changesBeforeSameModel = (db.load(subject.id)?.piSessionEntries as Array<{ type?: string }>).filter((entry) => entry.type === "model_change").length;
		await subject.setModel("new");
		const changesAfterSameModel = (db.load(subject.id)?.piSessionEntries as Array<{ type?: string }>).filter((entry) => entry.type === "model_change").length;
		assert.equal(changesAfterSameModel, changesBeforeSameModel, "selecting the active model must not append duplicate Pi model_change entries");
		await subject.send("第二轮");
		assert.equal(old.requests.length, 1);
		assert.equal(next.requests.length, 1);
		assert.ok(next.requests[0]!.context.includes("第一轮"));
		assert.equal(events.filter((event) => event.type === "text").map((event) => event.delta).join(""), "NEW");
		assert.equal(subject.view().modelId, "new");
	});

	await check("Pi 原生会话模型切换不重建 Agent，失败时保留原选择", async () => {
		const first = runtime([say("unused")], "model-one").live;
		const second = runtime([say("unused")], "model-two").live;
		const denied = runtime([say("unused")], "denied-model").live;
		const piRuntime = Promise.resolve({} as NonNullable<LlmRuntime["modelRuntime"]> extends Promise<infer T> ? T : never);
		const withPiRuntime = (value: LlmRuntime): LlmRuntime => ({
			...value,
			modelRuntime: piRuntime,
			prepareModel: Promise.resolve(value.model),
		});
		const models = new Map([["first", withPiRuntime(first)], ["second", withPiRuntime(second)], ["denied", withPiRuntime(denied)]]);
		const subject = new Session(repo.get("auto-flow")!, {
			db, repo,
			resolveModel: (id) => models.get(id ?? "first"),
			resolveModelKey: (id) => id ? `key-${id}` : null,
		});
		const internal = subject as unknown as {
			piRuntime: PiRuntimeAdapter | null;
			piHistory: { buildSessionContext(): { messages: unknown[] } };
			ensurePiRuntime(): Promise<{ setModel(model: LlmRuntime["model"]): Promise<void> }>;
		};
		assert.equal("agent" in (subject as unknown as Record<string, unknown>), false, "Session 不持有 Pi Agent");
		const historyBefore = internal.piHistory.buildSessionContext().messages.length;
		const selected: string[] = [];
		internal.ensurePiRuntime = async () => ({
			setModel: async (model) => {
				if (model === denied.model) throw new Error("Pi 拒绝模型");
				selected.push(model.id);
			},
		});
		const view = await subject.setModel("second");
		assert.equal(view.modelKey, "key-second");
		assert.equal(internal.piRuntime, null, "尚未启动的会话不提前构造 Pi AgentSession");
		assert.equal(internal.piHistory.buildSessionContext().messages.length, historyBefore);
		await assert.rejects(subject.setModel("denied"), /Pi 拒绝模型/);
		assert.equal(subject.view().modelKey, "key-second", "failed Pi selection does not persist the rejected model");
		assert.deepEqual(selected, [second.model.id]);
		const restoredSelections: string[] = [];
		const restored = new Session(repo.get("auto-flow")!, {
			db,
			repo,
			restore: db.load(subject.id)!,
			resolveModel: (id) => {
				restoredSelections.push(id ?? "");
				return id === "key-second" || id === "model-two" ? withPiRuntime(second) : withPiRuntime(first);
			},
			resolveModelKey: (id) => id === "model-two" ? "key-second" : id ? `key-${id}` : null,
		});
		assert.ok(restoredSelections.includes("key-second"), "restored session resolves its persisted model row key");
		assert.equal(restored.view().modelId, "model-two", "restored Pi session resumes with the previously selected model");
		restored.dispose();
		subject.dispose();
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

	await check("Pi thinking level 可通过 Session API 更新并在恢复后保持", async () => {
		const subject = session(runtime([say("unused")]).live);
		const events = eventsOf(subject);
		const updated = await subject.setThinkingLevel("high");
		assert.equal(updated.thinkingLevel, "high");
		assert.ok(events.some((event) => event.type === "thinking_level" && event.thinkingLevel === "high"));
		assert.equal(db.load(subject.id)?.thinkingLevel, "high");
		const restored = new Session(repo.get("auto-flow")!, { db, repo, restore: db.load(subject.id)!, resolveModel: () => runtime([say("unused")]).live });
		assert.equal(restored.view().thinkingLevel, "high");
	});

	await check("模拟会话切到可用模型后，运行模式与持久化同步变为 live", async () => {
		const live = runtime([say("LIVE_REPLY")]);
		let enabled = false;
		const subject = new Session(repo.get("auto-flow")!, { db, repo, resolveModel: () => enabled ? live.live : null });
		assert.equal(subject.view().mode, "simulated");
		enabled = true;
		await subject.setModel("enabled");
		assert.equal(subject.view().mode, "live");
		assert.equal(db.load(subject.id)!.mode, "live");
		await subject.send("hello");
		assert.equal(live.requests.length, 1);
	});

	await check("运行中的后续消息进入 Pi 原生 follow-up 队列并持久化", async () => {
		const faux = createFauxRuntime([say("FIRST_REPLY"), say("FOLLOW_UP_REPLY")]);
		let releaseFirst!: () => void;
		let markFirstStarted!: () => void;
		const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
		let calls = 0;
		const requests: string[] = [];
		const live: LlmRuntime = {
			...faux,
			label: "延迟 follow-up 模型",
			provider: "faux",
			modelId: "faux-follow-up",
			streamFn: async (model, context, options) => {
				requests.push(JSON.stringify(context.messages));
				calls++;
				if (calls === 1) {
					markFirstStarted();
					await firstGate;
				}
				return faux.streamFn(model, context, options);
			},
		};
		const obs = createObservability({ storage: db, autoStart: false, retentionDays: 0 });
		const subject = new Session(repo.get("auto-flow")!, { db, repo, resolveModel: () => live, observability: obs });
		const events = eventsOf(subject);
		const first = subject.send("FIRST_PROMPT");
		await firstStarted;
		await subject.send("QUEUED_PROMPT");
		assert.ok(events.some((event) => event.type === "queue" && event.followUp.includes("QUEUED_PROMPT")));
		releaseFirst();
		await first;
		const history = (subject as unknown as { piHistory: { buildSessionContext(): { messages: AgentMessage[] } } }).piHistory.buildSessionContext().messages;
		assert.equal(calls, 2, "Pi drains the follow-up after the current request");
		assert.ok(requests[1]!.includes("QUEUED_PROMPT"), "queued input reaches the next provider request");
		assert.ok(JSON.stringify(history).includes("QUEUED_PROMPT"), "queued input is in the Pi session history");
		assert.ok(subject.view().transcript.some((entry) => entry.role === "user" && entry.text === "QUEUED_PROMPT"));
		assert.equal(subject.view().traceIds.length, 1, "a follow-up in the active Pi run does not create a fake second trace");
		assert.ok(events.some((event) => event.type === "queue" && event.followUp.length === 0));
		obs.close();
	});

	await check("模拟模式可记住所选模型且重载后保留，回复模式仍标为 simulated", async () => {
		const subject = new Session(repo.get("auto-flow")!, {
			db,
			repo,
			resolveModel: () => null,
			resolveModelKey: (id) => id === "configured-model" ? "model-configured" : null,
		});
		const switched = await subject.setModel("configured-model");
		assert.equal(switched.mode, "simulated");
		assert.equal(switched.modelKey, "model-configured");
		assert.equal(db.load(subject.id)?.mode, "simulated");
		assert.equal(db.load(subject.id)?.modelKey, "model-configured");
		const restored = new Session(repo.get("auto-flow")!, {
			db,
			repo,
			restore: db.load(subject.id)!,
			resolveModel: () => null,
			resolveModelKey: (id) => id === "model-configured" ? "model-configured" : null,
		});
		assert.equal(restored.view().mode, "simulated");
		assert.equal(restored.view().modelKey, "model-configured");
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
		await subject.setModel("new");
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
		await subject.setModel("new");
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

	await check("Pi 默认不按 Agent 旧轮数配置裁剪历史", async () => {
		const live = runtime([say("first"), say("second")]);
		const record = service.create({ name: "Pi 历史保留", memoryConfig: { keepRecentTokens: 20000 } });
		const subject = session(live.live, binding(record));
		await subject.send("OLD_USER_MARKER");
		await subject.send("NEW_USER_MARKER");
		assert.ok(live.requests[1]!.context.includes("OLD_USER_MARKER"));
		assert.ok(live.requests[1]!.context.includes("NEW_USER_MARKER"));
	});

	await check("空会话的长首问不触发无效摘要", async () => {
		const live = runtime([say("FIRST_REPLY")]);
		live.live.model.contextWindow = 1;
		const record = service.create({ name: "首轮长输入", memoryConfig: { reserveTokens: 32, keepRecentTokens: 16 } });
		const subject = session(live.live, binding(record));
		const events = eventsOf(subject);
		await subject.send("LONG_FIRST_PROMPT ".repeat(200));
		assert.equal(live.requests.length, 1, "没有旧历史可压缩时首问仍应发送给模型");
		assert.ok(events.some((event) => event.type === "done" && event.text === "FIRST_REPLY"));
		assert.ok(!events.some((event) => event.type === "compacting" || event.type === "compacted"));
		assert.ok(!events.some((event) => event.type === "error" && event.message.includes("对话还太短")));
	});

	await check("上下文达到模型窗口阈值时压缩模型历史，保留完整可见对话并可恢复", async () => {
		const live = runtime([say("CURRENT_REPLY"), say("SUMMARY_MARKER"), say("FOLLOW_UP_REPLY")]);
		live.live.model.contextWindow = 100;
		const record = service.create({ name: "Pi 摘要记忆", memoryConfig: { reserveTokens: 0, keepRecentTokens: 32 } });
		const subject = session(live.live, binding(record));
		const internal = subject as unknown as {
			piRuntime: PiRuntimeAdapter | null;
			piHistory: { getEntries(): unknown[] };
		};
		seedPiHistory(subject, 8, "OLD_DETAIL_MARKER");
		const events = eventsOf(subject);
		await subject.send("CURRENT_PROMPT");
		const summary = db.load(subject.id)!.summary!;
		await subject.send("FOLLOW_UP_PROMPT");
		const compactedMessages = internal.piRuntime!.messages();
		assert.equal(live.requests.length, 3, "Pi threshold compaction runs after the completed turn, before the follow-up request");
		assert.ok(live.requests.at(-1)!.context.includes(summary), "摘要应进入压缩后的下一轮请求");
		assert.ok(JSON.stringify(compactedMessages).includes(summary), "压缩摘要应进入模型历史");
		assert.ok(JSON.stringify(compactedMessages).includes("CURRENT_PROMPT"), "压缩后当前请求应进入模型历史");
		assert.ok(JSON.stringify(internal.piHistory.getEntries()).includes("OLD_DETAIL_MARKER_0"), "追加式 Pi 历史仍保留原始 entry");
		assert.ok(!internal.piRuntime!.systemPrompt().includes(summary));
		assert.equal((db.load(subject.id) as unknown as { compactedAutomatically: boolean }).compactedAutomatically, true);
		assert.equal(subject.view().transcript.filter((entry) => entry.role === "compaction").length, 1);
		assert.ok(subject.view().transcript.some((entry) => entry.role === "compaction" && entry.text === summary));
		assert.ok(subject.view().transcript.some((entry) => entry.role === "user" && entry.text.includes("OLD_DETAIL_MARKER_0")), "压缩不应从界面历史删除旧消息");
		const transcript = subject.view().transcript;
		const compactionIndex = transcript.findIndex((entry) => entry.role === "compaction");
		const currentPromptIndex = transcript.findIndex((entry) => entry.role === "user" && entry.text === "CURRENT_PROMPT");
		assert.ok(compactionIndex > transcript.findIndex((entry) => entry.role === "user" && entry.text.includes("OLD_DETAIL_MARKER_0")));
		assert.ok(compactionIndex > currentPromptIndex, "摘要记录应显示在触发压缩的当前提问下方");
		assert.equal(transcript.at(-1)?.role, "assistant", "当前回答应显示在压缩标记下方");
		assert.ok(events.some((event) => event.type === "compacted" && event.transcript.some((entry) => entry.role === "compaction")));
		const restoredRecord = db.load(subject.id)!;
		const restored = new Session(repo.get("auto-flow")!, { db, repo, restore: restoredRecord, resolveModel: () => live.live, agent: binding(service.get(record.id)) });
		const restoredMessages = JSON.stringify((restored as unknown as { piHistory: { buildSessionContext(): { messages: unknown[] } } }).piHistory.buildSessionContext().messages);
		assert.ok(restoredMessages.includes(summary), "恢复会话后历史仍应包含摘要");
		assert.ok(restored.view().transcript.some((entry) => entry.role === "user" && entry.text.includes("OLD_DETAIL_MARKER_0")), "恢复会话后仍应显示压缩前的旧消息");
		assert.ok(restored.view().transcript.findIndex((entry) => entry.role === "compaction") > restored.view().transcript.findIndex((entry) => entry.role === "user" && entry.text === "CURRENT_PROMPT"),
			"恢复后摘要仍应显示在触发压缩的提问下方");
	});

	await check("手动压缩后模型输出及事件仍可用", async () => {
		const live = runtime([say("COMPACT_SUMMARY"), say("AFTER_COMPACT")]);
		const record = service.create({ name: "手动压缩保留轮数", memoryConfig: { keepRecentTokens: 100 } });
		const subject = session(live.live, binding(record));
		seedPiHistory(subject, 8, "history");
		await subject.compact();
		const events = eventsOf(subject);
		await subject.send("continue");
		assert.ok(events.some((event) => event.type === "done"), JSON.stringify(events));
		assert.ok(!events.some((event) => event.type === "error"), JSON.stringify(events));
	});

	await check("手动压缩期间拒绝并发发送，完成后会话恢复", async () => {
		const faux = createFauxRuntime([say("LOCKED_SUMMARY"), say("AFTER_LOCK")]);
		let releaseSummary!: () => void;
		let markSummaryStarted!: () => void;
		const summaryStarted = new Promise<void>((resolve) => { markSummaryStarted = resolve; });
		const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
		let calls = 0;
		const live: LlmRuntime = {
			...faux,
			label: "延迟摘要模型",
			provider: "faux",
			modelId: "faux-delayed-summary",
			streamFn: async (model, context, options) => {
				calls++;
				if (calls === 1) {
					markSummaryStarted();
					await summaryGate;
				}
				return faux.streamFn(model, context, options);
			},
		};
		const record = service.create({ name: "并发压缩保留轮数", memoryConfig: { keepRecentTokens: 100 } });
		const subject = session(live, binding(record));
		seedPiHistory(subject, 8, "history");
		const events = eventsOf(subject);
		const compacting = subject.compact();
		await summaryStarted;
		assert.equal(subject.view().running, true);
		await subject.send("must wait");
		assert.equal(calls, 1, "并发发送不能进入模型");
		assert.ok(events.some((event) => event.type === "error" && event.message.includes("不能排队")));
		assert.throws(() => subject.activateSkill(repo.all()[0]!.id), /正在压缩上下文/);
		releaseSummary();
		await compacting;
		assert.equal(subject.view().running, false);
		await subject.send("continue");
		assert.equal(calls, 2, "压缩完成后会话应重新可用");
		assert.ok(events.some((event) => event.type === "done"), JSON.stringify(events));
	});

	await check("Pi runtime 初始化期间停止会阻止手动压缩", async () => {
		const subject = session(runtime([say("must not summarize")]).live);
		let release!: (runtime: PiRuntimeAdapter) => void;
		let markInitialized!: () => void;
		const initialized = new Promise<void>((resolve) => { markInitialized = resolve; });
		const internal = subject as unknown as { ensurePiRuntime(): Promise<PiRuntimeAdapter> };
		internal.ensurePiRuntime = () => {
			markInitialized();
			return new Promise<PiRuntimeAdapter>((resolve) => { release = resolve; });
		};
		let compactCalls = 0;
		const compacting = subject.compact();
		await initialized;
		assert.equal(subject.stop(), true);
		release({ prompt: async () => {}, followUp: async () => {}, messages: () => [], systemPrompt: () => "", lastAssistantText: () => "", lastAssistantMessage: () => undefined,
			compact: async () => { compactCalls++; throw new Error("unexpected compact"); },
			stats: () => ({}) as ReturnType<PiRuntimeAdapter["stats"]>,
			abort: async () => {}, setActiveToolsByName: () => {}, canonicalToolName: (name) => name, newSession: () => {}, subscribe: () => () => {},
			exportHistory: () => [], piSkills: () => [], dispose: () => {}, shutdown: async () => {}, setModel: async () => {}, navigateTree: async () => ({ cancelled: false }), session: {} as PiRuntimeAdapter["session"] });
		await assert.rejects(compacting, /压缩已取消/);
		assert.equal(compactCalls, 0);
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
