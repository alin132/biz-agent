/**
 * Agent 实体自检（npm run agents:selftest）：
 *   状态机全路径（draft→testing→published→stopped + revert）、
 *   已发布锁定 / 已停用拒绝、参数钳制、PATCH 三态、DAO 往返。
 *
 * 纯进程内、临时 SQLite，不起服务；HTTP 层的断言在 scripts/smoke-agents.ts（要服务在跑）。
 */
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../server/db/index.js";
import { AgentError, AgentService } from "../server/agents/service.js";
import { agentPromptOf } from "../server/session.js";
import { ToolRegistry } from "../src/core/registry.js";
import { createBusinessRuntime } from "../src/core/runtime.js";
import type { WorkflowDef } from "../src/core/types.js";
import { WorkflowEngine } from "../src/core/workflow.js";
import { createFauxRuntime, say } from "../examples/harness.js";

let passed = 0;
function check(name: string, fn: () => void): void {
	try {
		fn();
		passed += 1;
		console.log(`  ✓ ${name}`);
	} catch (error) {
		console.log(`  ✗ ${name}`);
		console.log(`      ${(error as Error).message.split("\n")[0]}`);
		process.exitCode = 1;
	}
}

/**
 * 异步版断言：压缩 / 计划模式要走真实的 await（问模型要摘要、重建 agent）。
 *
 * 为什么必须单独一个，而不是让 `check` 收 Promise：`check(name, async () => {...})`
 * 会把"未处理的 Promise"当成通过——断言在里面失败也**不会**让退出码变红，
 * 那就是一条空断言（这一类假绿踩过，所以这里显式 await，失败照常计入）。
 */
async function acheck(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		passed += 1;
		console.log("  ✓ " + name);
	} catch (error) {
		console.log("  ✗ " + name);
		console.log("      " + (error as Error).message.split("\n")[0]);
		process.exitCode = 1;
	}
}

const dir = mkdtempSync(join(tmpdir(), "agents-selftest-"));
const store = openStore({ dbPath: join(dir, "agents.db") });
let tick = 1000;
const service = new AgentService({
	storage: store,
	now: () => (tick += 10),
	idFactory: (() => {
		let n = 0;
		return () => `agent_t${(n += 1)}`;
	})(),
});

function created(): ReturnType<AgentService["create"]> {
	return service.create({ name: "测试助手", description: "自检用" });
}

console.log("\n── 创建与六维配置 ──────────────────────────────");

let agent = created();
check("新建一律是草稿", () => {
	assert.equal(agent.status, "draft");
	assert.equal(agent.agentsMd, "");
});
check("六维字段都在记录上", () => {
	for (const key of ["name", "agentsMd", "modelConfig", "memoryConfig", "advancedConfig", "skillIds", "kbIds", "status"] as const) {
		assert.ok(key in agent, `缺字段 ${key}`);
	}
});

check("空名称被拒", () => {
	assert.throws(() => service.create({ name: "   " }), (cause: unknown) => {
		return cause instanceof AgentError && cause.status === 400;
	});
});

check("名称超长被拒", () => {
	assert.throws(() => service.create({ name: "长".repeat(61) }), (cause: unknown) => {
		return cause instanceof AgentError && cause.status === 400;
	});
});

check("模型参数越界被钳制（temperature 5→2，topP -1→0，maxTokens 1e9→128000）", () => {
	const a = service.create({ name: "钳制", modelConfig: { temperature: 5, topP: -1, maxTokens: 1e9 } });
	assert.equal(a.modelConfig.temperature, 2);
	assert.equal(a.modelConfig.topP, 0);
	assert.equal(a.modelConfig.maxTokens, 128000);
});

check("Pi 压缩参数钳制到安全范围", () => {
	const a = service.create({ name: "记忆钳制", memoryConfig: { reserveTokens: -1, keepRecentTokens: 2_000_000 } });
	assert.deepEqual(a.memoryConfig, { reserveTokens: 0, keepRecentTokens: 1_000_000 });
});

check("skillIds / kbIds 去重并丢掉非字符串", () => {
	// 故意夹一个非字符串：脏数据不该写进库
	const a = service.create({ name: "去重", skillIds: ["s1", "s1", 42 as unknown as string, ""], kbIds: ["kb1"] });
	assert.deepEqual(a.skillIds, ["s1"]);
	assert.deepEqual(a.kbIds, ["kb1"]);
});

console.log("\n── 状态机全路径 ────────────────────────────────");

check("draft → testing → published → stopped → revert → draft 全链走通", () => {
	const a = created();
	assert.equal(service.applyAction(a.id, "test").status, "testing");
	assert.equal(service.applyAction(a.id, "publish").status, "published");
	assert.equal(service.applyAction(a.id, "stop").status, "stopped");
	assert.equal(service.applyAction(a.id, "revert").status, "draft");
	service.remove(a.id);
});

check("draft 直接 stop 是非法迁移", () => {
	const a = created();
	assert.throws(
		() => service.applyAction(a.id, "stop"),
		(cause: unknown) => cause instanceof AgentError && cause.code === "illegal_transition",
	);
});

check("published 不能再 test", () => {
	const a = created();
	service.applyAction(a.id, "publish");
	assert.throws(
		() => service.applyAction(a.id, "test"),
		(cause: unknown) => cause instanceof AgentError && cause.code === "illegal_transition",
	);
});

check("已发布不可编辑（published_locked）", () => {
	const a = created();
	service.applyAction(a.id, "publish");
	assert.throws(
		() => service.update(a.id, { name: "改名" }),
		(cause: unknown) => cause instanceof AgentError && cause.code === "published_locked",
	);
});

check("revert 回草稿后可以编辑", () => {
	const a = created();
	service.applyAction(a.id, "publish");
	service.applyAction(a.id, "revert");
	assert.equal(service.update(a.id, { name: "改名成功" }).name, "改名成功");
});

check("assertChattable：stopped 拒绝、published 允许", () => {
	const a = created();
	service.applyAction(a.id, "publish");
	service.applyAction(a.id, "stop");
	assert.throws(
		() => service.assertChattable(a.id),
		(cause: unknown) => cause instanceof AgentError && cause.code === "stopped_not_chattable",
	);
	service.applyAction(a.id, "revert");
	service.applyAction(a.id, "publish");
	assert.equal(service.assertChattable(a.id).id, a.id);
});

check("不存在的 id：get 抛 404", () => {
	assert.throws(() => service.get("nope"), (cause: unknown) => {
		return cause instanceof AgentError && cause.status === 404;
	});
});

console.log("\n── PATCH 语义与 DAO 往返 ──────────────────────");

check("PATCH 只写传了的字段（不传的保持原样）", () => {
	const a = created();
	service.update(a.id, { description: "只改简介" });
	const after = service.get(a.id);
	assert.equal(after.description, "只改简介");
	assert.equal(after.name, "测试助手");
	assert.deepEqual(after.skillIds, []);
});

check("JSON 配置往返（写进去读回来一致）", () => {
	const a = service.create({
		name: "往返",
		agentsMd: "# 指令",
		modelConfig: { chatModelId: "m1", temperature: 0.3, stream: false },
		memoryConfig: { reserveTokens: 8192, keepRecentTokens: 12000 },
		advancedConfig: { maxIters: 20, showThinking: false },
		skillIds: ["s1", "s2"],
		kbIds: ["kb1"],
	});
	const back = service.get(a.id);
	assert.equal(back.agentsMd, "# 指令");
	assert.deepEqual(back.modelConfig, { chatModelId: "m1", temperature: 0.3, stream: false });
	assert.deepEqual(back.memoryConfig, { reserveTokens: 8192, keepRecentTokens: 12000 });
	assert.deepEqual(back.skillIds, ["s1", "s2"]);
});

check("删除后查不到；list 为空", () => {
	const a = created();
	service.remove(a.id);
	assert.equal(store.listAgents().some((row) => row.id === a.id), false);
});

console.log("\n── Agent 人格指令注入系统提示 ─────────────────");

/** 造一个最小业务运行时：只验证人格指令进入业务系统提示。 */
function buildWithAgentPrompt(prompt: string | undefined): string {
	const workflow: WorkflowDef = {
		id: "probe-flow",
		name: "探针流程",
		steps: [],
		systemPrompt: "你是探针。",
		createTools: () => [],
	};
	const registry = new ToolRegistry();
	const engine = new WorkflowEngine(workflow);
	const built = createBusinessRuntime({
		workflow,
		registry,
		engine,
		toolNames: [],
		systemPromptExtras: [agentPromptOf(prompt)].filter((text) => text.length > 0),
	});
	return built.systemPrompt;
}

check("写了人格指令：原文出现在系统提示里", () => {
	const prompt = "# 你是报销专员\n锚点ZZQ9911相关问题，其他一律转人工。";
	const text = buildWithAgentPrompt(prompt);
	assert.ok(text.includes(prompt), "agentsMd 原文必须进系统提示，否则编辑了也不生效");
});

check("人格指令带标题，说明优先级高于通用要求", () => {
	const text = buildWithAgentPrompt("# 你是报销专员");
	assert.ok(text.includes("# 你的角色与指令"), "要有独立小节，不能和通用提示糊在一起");
	assert.ok(text.includes("优先级高于"), "要告诉模型这一段优先");
});

check("没写人格指令：系统提示里不出现空小节", () => {
	const text = buildWithAgentPrompt(undefined);
	assert.equal(text.includes("# 你的角色与指令"), false, "空 agentsMd 不该制造假小节");
	assert.equal(text.includes("优先级高于"), false);
});

check("只有空白的 agentsMd 等同没写", () => {
	const text = buildWithAgentPrompt("   \n\t  ");
	assert.equal(text.includes("# 你的角色与指令"), false, "纯空白要按空处理，别渲染出空壳");
});

check("人格指令是快照：改 Agent 不影响已建的会话", () => {
	const a = service.create({ name: "报销助手", agentsMd: "# 第一版" });
	const before = buildWithAgentPrompt(service.get(a.id).agentsMd);
	service.update(a.id, { agentsMd: "# 第二版" });
	assert.ok(before.includes("# 第一版"), "已建会话保留建会话那一刻的指令");
	assert.equal(before.includes("# 第二版"), false);
	assert.ok(buildWithAgentPrompt(service.get(a.id).agentsMd).includes("# 第二版"), "新会话用新指令");
});


console.log("\n── Agent 的技能与知识库绑定 ─────────────────");

// 用真实 SessionHub 建会话：验的是"配置真的进了运行实例"，不是"字段存在"
//
// 必须先指 DB_PATH 到临时目录：Session 构造会触发知识库模块的单例按默认 DB_PATH 打开
// **本机正式库**（data/biz-agent.db）——既污染真实数据，也让断言结果不可复现。
process.env.DB_PATH = join(dir, "agents.db");
const { SessionHub } = await import("../server/session.js");
const { WorkflowRepo } = await import("../server/workflows.js");
const hubRepo = new WorkflowRepo(store);
const hub = new SessionHub(store, hubRepo);

/** 随便挑一条内置技能当"Agent 声明的技能"（目录来自 repo.skills()） */
const catalogSkill = hubRepo.skills()[0];

check("Agent 声明的技能：新建会话自动装上", () => {
	assert.ok(catalogSkill, "目录里应当至少有一条技能");
	const agent = service.create({ name: "带技能", skillIds: [catalogSkill!.id] });
	const session = hub.create("auto-flow", {
		agent: { id: agent.id, name: agent.name, prompt: agent.agentsMd, skillIds: agent.skillIds, kbIds: agent.kbIds },
	});
	assert.equal(session.skillId, catalogSkill!.id, "声明的技能要真的装进会话");
});

check("Agent 技能目录里没有的 id：降级为没装，不炸建会话", () => {
	const agent = service.create({ name: "坏技能", skillIds: ["flow_does_not_exist"] });
	const session = hub.create("auto-flow", {
		agent: { id: agent.id, name: agent.name, prompt: agent.agentsMd, skillIds: agent.skillIds, kbIds: agent.kbIds },
	});
	assert.equal(session.skillId, null, "找不到就退化成普通会话，而不是抛错");
});

check("没声明技能：会话保持默认（不自动装东西）", () => {
	const agent = service.create({ name: "没技能" });
	const session = hub.create("auto-flow", {
		agent: { id: agent.id, name: agent.name, prompt: agent.agentsMd, skillIds: agent.skillIds, kbIds: agent.kbIds },
	});
	assert.equal(session.skillId, null);
});

check("Agent 没写人格指令时绑定依然成立但提示为空", () => {
	const agent = service.create({ name: "无指令", kbIds: ["kb_x"] });
	const session = hub.create("auto-flow", {
		agent: { id: agent.id, name: agent.name, prompt: agent.agentsMd, skillIds: agent.skillIds, kbIds: agent.kbIds },
	});
	assert.equal(session.agentId, agent.id);
	assert.equal(session.agentName, agent.name);
});

check("恢复会话要还原 Agent 人格：payload 只存 agentId 时，重建必须回查 Agent", () => {
	// 这条覆盖的是"刷新页面/重启服务后人格消失"——会话整条从库里恢复，
	// 内存里那份 options.agent 根本不存在，只能靠 agentId 回查。
	const agent = service.create({
		name: "恢复用",
		agentsMd: "# 锚点ZZQ9911\n\n开头加【报销专员】",
		kbIds: ["kb_restore"],
	});
	const created = hub.create("auto-flow", {
		agent: { id: agent.id, name: agent.name, prompt: agent.agentsMd, skillIds: agent.skillIds, kbIds: agent.kbIds },
	});
	const sid = created.id;

	// 把内存里那份丢掉，强制下一次 get() 走存储层恢复
	hub.drop(sid);
	const restored = hub.get(sid);
	assert.ok(restored, "会话应当能从库里恢复出来");
	assert.equal(restored.agentId, agent.id);
	assert.equal(restored.view().agentId, agent.id);
	assert.equal(restored.view().agentName, agent.name);
	// 断言 agentPrompt 本身被还原，而不是"渲染出来的提示里有那句话"——
	// 恢复出来的会话带着历史消息，而历史里那条旧 system message 本身就含人格，
	// 光看 systemPrompt 会**在回读失效时照样通过**（这个假阳性踩过）。
	assert.equal(
		(restored as unknown as { agentPrompt: string | null }).agentPrompt,
		agent.agentsMd,
		"agentPrompt 必须从库里回读出来，不能只靠历史消息里那份旧的",
	);
});

check("恢复会话要还原 Agent 的 systemPromptExtras（人格真的进了系统提示）", () => {
	const agent = service.create({
		name: "提示还原",
		agentsMd: "锚点ZZQ9911",
	});
	const created = hub.create("auto-flow", {
		agent: { id: agent.id, name: agent.name, prompt: agent.agentsMd, skillIds: agent.skillIds, kbIds: agent.kbIds },
	});
	hub.drop(created.id);
	const restored = hub.get(created.id)!;
	// 直接看运行实例的系统提示，而不是只看视图字段：
	// "绑定字段对得上"和"模型真的收到人格"是两件事
	const sys = (restored as unknown as { built: { systemPrompt: string } }).built.systemPrompt;
	assert.ok(sys.includes("锚点ZZQ9911"), "恢复后系统提示里必须还有 Agent 人格");
	assert.ok(sys.includes("你的角色与指令"), "人格小节标题也要在");
});

check("Agent 被删后老会话仍能打开：降级为默认人格，不报错", () => {
	const agent = service.create({ name: "会被删", agentsMd: "不该留下" });
	const created = hub.create("auto-flow", {
		agent: { id: agent.id, name: agent.name, prompt: agent.agentsMd, skillIds: agent.skillIds, kbIds: agent.kbIds },
	});
	service.remove(agent.id);
	hub.drop(created.id);
	const restored = hub.get(created.id);
	assert.ok(restored, "Agent 没了也要能打开历史会话");
	assert.equal(restored!.agentId, agent.id, "id 仍记着，只是人格回不来了");
	assert.equal(restored!.agentName, "会被删", "名字落库过，照样显示");
});
console.log("\n── 斜杠命令：压缩对话 + 计划模式 ───────────────");

// 这一段刻意不用模拟模式：`compact()` 要真的问一次模型要摘要，`setPlanMode()` 要真的重建 agent。
// 注入一个 faux 运行时（同 examples/harness 的造法），既走真实代码路径又不联网、可复现。
const { Session: SessionClass } = await import("../server/session.js");
type SessionLike = InstanceType<typeof SessionClass>;
const readRuntime = (session: SessionLike) => {
	const internal = session as unknown as {
		built: { systemPrompt: string };
		piHistory: { buildSessionContext(): { messages: unknown[] } };
		piRuntime: { messages(): unknown[] } | null;
	};
	return { state: { systemPrompt: internal.built.systemPrompt, messages: internal.piRuntime?.messages() ?? internal.piHistory.buildSessionContext().messages } };
};

/**
 * 会话历史条数（**不含开头那条系统提示**）。
 *
 * 为什么不直接数 messages.length：开头那条 system 是装配产物、不是对话内容，
 * 把它算进去会让"塞了 30 条"变成 31，断言里的数字全对不上——数字对不上时
 * 最容易的反应是去改断言，那就把测试改成了"迁就实现"，失去意义。
 */
const historyOf = (session: SessionLike): number => {
	const middle = readRuntime(session).state.messages.filter((message) => {
		return (message as { role?: string }).role !== "system";
	});
	return middle.length;
};

const piContextOf = (session: SessionLike): AgentMessage[] =>
	(session as unknown as { piHistory: { buildSessionContext(): { messages: AgentMessage[] } } }).piHistory.buildSessionContext().messages;

/**
 * 造一个"真实模型"会话：faux 运行时按队列吐响应。
 *
 * 为什么必须让 mode=live：模拟模式下 compact() 会直接报"需要接入真实模型"——
 * 那样测到的只是错误分支，压缩逻辑一行没跑。
 */
function liveSession(steps: Parameters<typeof createFauxRuntime>[0], keepRecentTokens = 20_000): SessionLike {
	const runtime = createFauxRuntime(steps);
	const record = service.create({ name: "压缩契约会话", memoryConfig: { reserveTokens: 16_384, keepRecentTokens } });
	return new SessionClass(hubRepo.get("auto-flow")!, {
		db: store,
		repo: hubRepo,
		agent: { id: record.id, name: record.name, prompt: record.agentsMd, skillIds: [], kbIds: [],
			modelConfig: record.modelConfig, memoryConfig: record.memoryConfig, advancedConfig: record.advancedConfig },
		resolveModel: () => ({ model: runtime.model, streamFn: runtime.streamFn, label: "Faux · 摘要模型", provider: "faux", modelId: "faux-summary" }),
	});
}

/** 直接往会话历史里塞消息：等价于"聊了很多轮"，但不用真的跑那么多轮模型。 */
function seedHistory(session: SessionLike, count: number, marker: string): void {
	const internal = session as unknown as {
		piHistory: { appendMessage(message: AgentMessage): unknown; buildSessionContext(): { messages: AgentMessage[] } };
		transcript: Array<{ role: "user" | "assistant"; text: string; at: number }>;
	};
	for (let index = 0; index < count; index += 1) {
		const text = `第${index + 1}轮：${marker} 的细节 ${index + 1}`;
		internal.piHistory.appendMessage({
			role: "user",
			content: text,
			timestamp: Date.now(),
		} as AgentMessage);
		internal.transcript.push({ role: "user", text, at: Date.now() });
	}
}

await acheck("计划模式：开启后系统提示真的多出「先给计划再执行」的约束", async () => {
	const session = liveSession([say("好的")]);
	const before = readRuntime(session).state.systemPrompt;
	assert.equal(before.includes("计划模式"), false, "默认不该带计划模式约束");

	session.setPlanMode(true);
	const after = readRuntime(session).state.systemPrompt;
	// 断言的是"模型真的收到这条指令"，不是"标志位变成了 true"
	assert.ok(after.includes("计划模式"), "开了计划模式，系统提示里必须有它");
	assert.ok(after.includes("先给计划"), "要明确要求先给计划");
	assert.ok(after.includes("等用户确认"), "还要要求停下来等确认——只说先给计划模型会自己接着干");
	assert.equal(session.view().planMode, true, "视图要如实反映开关状态");
});

await acheck("计划模式：关掉后系统提示里的约束随之消失（是可关的开关，不是单向）", async () => {
	const session = liveSession([say("好的")]);
	session.setPlanMode(true);
	assert.ok(readRuntime(session).state.systemPrompt.includes("计划模式"));
	session.setPlanMode(false);
	const off = readRuntime(session).state.systemPrompt;
	assert.equal(off.includes("计划模式"), false, "关掉后提示里不能再留着这段约束");
	assert.equal(session.view().planMode, false);
});

await acheck("计划模式：落库并可回读（刷新/重启后开关还在）", async () => {
	const created = liveSession([say("好的")]);
	created.setPlanMode(true);
	const sid = created.id;
	// 丢掉内存那份，强制从 payload 重建
	const restored = new SessionClass(hubRepo.get("auto-flow")!, {
		db: store,
		repo: hubRepo,
		restore: store.load(sid)!,
	});
	assert.equal(restored.view().planMode, true, "planMode 必须从 payload 回读出来");
	assert.ok(
		readRuntime(restored).state.systemPrompt.includes("计划模式"),
		"恢复出来的会话系统提示里也要带着约束，否则重启一次就变回随便动手",
	);
});

// 上面那条走的是"直接 new Session + 传 restore"，而**真实路径**是 hub.get()：
// 会话从库里捞出来、resolveModel 由 hub 注入。这条专门盯住那条路径——
// 防的正是"重启服务后计划模式悄悄失效"（配置在库里，但没被重新拼进提示）。
await acheck("计划模式：走 hub 恢复后依然约束模型（防重启就变回随便动手）", async () => {
	const runtime = createFauxRuntime([say("好的")]);
	const liveHub = new SessionHub(store, hubRepo, () => ({
		model: runtime.model,
		streamFn: runtime.streamFn,
		label: "Faux · 计划模式",
		provider: "faux",
		modelId: "faux-plan",
	}));
	const created = liveHub.create("auto-flow", {});
	created.setPlanMode(true);
	const sid = created.id;

	// drop 掉内存那份，强制下一次 get() 走真实恢复路径（DAO 回读 + 重新装配）
	liveHub.drop(sid);
	const restored = liveHub.get(sid)!;
	assert.ok(restored, "会话应当能从库里恢复");
	assert.equal(restored.view().planMode, true, "恢复后开关状态要对");
	// 关键：断言**模型真正收到的系统提示**，不是只看视图字段
	const sys = readRuntime(restored).state.systemPrompt;
	assert.ok(sys.includes("计划模式"), "恢复后的系统提示必须仍带计划模式约束");
	assert.ok(sys.includes("先给计划"), "约束正文也要在，不能只剩个标题");
	assert.ok(sys.includes("等用户确认"), "「等确认」这条最容易漏，必须一起在");
});

// 只断言 systemPrompt 里"有那句话"还不够：那句话得**真的被发出去**。
// 这里直接读 faux 收到的请求，证明约束进了模型上下文，而不是拼了个没人用的字符串。
await acheck("计划模式：约束真的进了发给模型的请求（不只是拼在某个字符串里）", async () => {
	const seen: string[] = [];
	const runtime = createFauxRuntime([say("好的")]);
	const spyStream = ((model: unknown, context: unknown, options: unknown) => {
		seen.push(JSON.stringify(context));
		return (runtime.streamFn as unknown as (m: unknown, c: unknown, o: unknown) => unknown)(model, context, options);
	}) as unknown as typeof runtime.streamFn;

	const session = new SessionClass(hubRepo.get("auto-flow")!, {
		db: store,
		repo: hubRepo,
		resolveModel: () => ({ model: runtime.model, streamFn: spyStream, label: "Faux", provider: "faux", modelId: "faux-spy" }),
	});
	session.setPlanMode(true);
	await session.send("帮我改一下这单数据");

	assert.ok(seen.length > 0, "模型至少应当收到一次请求");
	const sent = seen.join("\n");
	assert.ok(sent.includes("计划模式"), "发给模型的请求里必须带有计划模式约束");
	assert.ok(sent.includes("先给计划"), "要带上「先给计划」这条要求");
});

await acheck("压缩对话：消息条数真的变少，且摘要进了历史", async () => {
	const SUMMARY = "锚点KK7788：用户要报销 3200 元差旅费，需要 L1 审批。";
	const session = liveSession([say(SUMMARY)], 100);
	seedHistory(session, 30, "差旅报销");
	const before = historyOf(session);
	assert.equal(before, 30, "先确认塞进去了 30 条");

	const rawBefore = piContextOf(session).length;
	const result = await session.compact();
	// ① 条数真的变少——看的是真实历史数组，不是返回值
	const after = historyOf(session);
	assert.ok(after < before, `压缩后历史必须变短（${before} → ${after}）`);
	assert.equal(result.before, rawBefore, "before 按 Pi 当前上下文消息数统计");
	assert.equal(result.after, result.kept + 1, "after = 摘要 1 条 + 保留的原始消息");
	assert.equal(piContextOf(session).length, result.after, "返回值与 Pi 的实际上下文投影一致");
	assert.ok(result.kept >= 2, "至少要保留最近几条原始消息");

	// ② 摘要真的进了后续上下文（这是压缩的意义所在：旧信息没丢，只是换了形式）
	const flat = JSON.stringify(readRuntime(session).state.messages);
	assert.ok(flat.includes("锚点KK7788"), "摘要正文必须进了历史，否则等于把上下文丢了");
	assert.ok(flat.includes(SUMMARY), "Pi 压缩摘要应进入会话上下文");
	// ③ 保留的最近消息也还在（不是整个换掉）
	assert.ok(flat.includes("差旅报销 的细节 30"), "最近的消息要原样保留");
});

await acheck("压缩对话：摘要落库，刷新后不会变回压缩前的长历史", async () => {
	const session = liveSession([say("锚点MM5566：结论是走 L2 审批。")], 2);
	seedHistory(session, 20, "报销单");
	await session.compact();
	const sid = session.id;
	const compactedLength = historyOf(session);

	const restored = new SessionClass(hubRepo.get("auto-flow")!, {
		db: store,
		repo: hubRepo,
		restore: store.load(sid)!,
	});
	assert.equal(historyOf(restored), compactedLength, "恢复出来的历史要与压缩后一致，不能回涨");
	assert.ok(restored.view().summary?.includes("锚点MM5566"), "summary 要能回读");
	assert.ok(typeof restored.view().compactedAt === "number", "压缩时间要能回读");
});

await acheck("压缩对话：会推 compacted 事件给前端（界面能同步）", async () => {
	const session = liveSession([say("摘要内容 KX1234")], 2);
	seedHistory(session, 12, "工单");
	const events: { type: string; [key: string]: unknown }[] = [];
	const unsubscribe = session.subscribe((event) => events.push(event as { type: string }));
	await session.compact();
	unsubscribe();
	const compacted = events.find((event) => event.type === "compacted");
	assert.ok(compacted, "必须推 compacted 事件，否则前端只能靠轮询");
	assert.ok(String(compacted.summary).includes("KX1234"), "事件里要带摘要正文，前端才能显示");
	assert.ok(Number(compacted.after) < Number(compacted.before), "事件要如实上报压缩前后条数");
});

await acheck("计划模式：切换会推 plan 事件给前端", async () => {
	const session = liveSession([say("好的")]);
	const events: { type: string; planMode?: boolean }[] = [];
	const unsubscribe = session.subscribe((event) => events.push(event as { type: string }));
	session.setPlanMode(true);
	unsubscribe();
	const plan = events.find((event) => event.type === "plan");
	assert.ok(plan, "必须推 plan 事件");
	assert.equal(plan!.planMode, true);
});

await acheck("压缩对话：太短的会话直接拒绝，不假装压成功", async () => {
	const session = liveSession([say("不该被用到")]);
	// 原始条数 = 1 条系统提示 + 2 条对话 = 3，正好落在「压了也没意义」的区间里
	seedHistory(session, 2, "短对话");
	const before = historyOf(session);
	await assert.rejects(() => session.compact(), /Nothing to compact/, "Pi 原生规则拒绝没有可摘要内容的短历史");
	assert.equal(historyOf(session), before, "被拒绝时历史不能被动过");
});

await acheck("压缩对话：模拟模型下如实报错（不静默失败，也不假装压了）", async () => {
	// 不注入 resolveModel → mode=simulated
	const simulated = new SessionClass(hubRepo.get("auto-flow")!, { db: store, repo: hubRepo });
	seedHistory(simulated, 30, "模拟");
	await assert.rejects(() => simulated.compact(), /没有可用的真实模型/, "没有真实模型时明确拒绝压缩");
	assert.equal(historyOf(simulated), 30, "失败时历史必须原封不动");
	assert.equal(simulated.view().compactedAt, null, "失败不该留下「压过了」的痕迹");
});

store.close();

// 知识库单例也开着这个临时库（Session 构造时初始化），不关掉就删不掉：
// Windows 上会以 EBUSY 结束进程，把"全绿"的测试变成失败退出。
const { closeKb } = await import("../server/kb/index.js");
try {
	closeKb();
} catch {
	// 没初始化过就无需关闭
}
rmSync(dir, { recursive: true, force: true });

console.log("");
if (process.exitCode === 1) {
	console.log(`Agent 自检失败（通过 ${passed} 项）`);
} else {
	console.log(`Agent 自检通过：${passed} 项`);
}
