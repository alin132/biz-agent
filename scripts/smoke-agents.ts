/**
 * Agent HTTP 端到端（npm run smoke:agents，要服务在跑）：
 *   建号 → 状态机全链 → 已发布锁定 → 停用恢复 → 删除，走真实 HTTP。
 *   服务层语义断言在 agents-selftest（不起服务），这里只验"线上那一份"。
 * 默认打 SMOKE_BASE（缺省 http://127.0.0.1:4317）。
 */
import assert from "node:assert/strict";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:4317";

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

async function call(method: string, path: string, body?: unknown) {
	const response = await fetch(BASE + path, {
		method,
		headers: body ? { "content-type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await response.text();
	let data: unknown = null;
	try {
		data = JSON.parse(text) as unknown;
	} catch {
		data = text;
	}
	return { status: response.status, data };
}

function asRecord(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, "object");
	return value as Record<string, unknown>;
}

console.log("\n── Agent HTTP（真实服务） ───────────────────────");

const created = await call("POST", "/api/agents", { name: `冒烟-${Date.now()}`, description: "smoke" });
check("创建返回 201 且为草稿", () => {
	assert.equal(created.status, 201);
	assert.equal(asRecord(created.data).status, "draft");
	assert.equal(asRecord(created.data).statusLabel, "草稿");
});
const id = String(asRecord(created.data).id);

const emptyName = await call("POST", "/api/agents", { name: "  " });
check("空名称 400", () => {
	assert.equal(emptyName.status, 400);
});

const patched = await call("PATCH", `/api/agents/${id}`, {
	description: "改过的简介",
	modelConfig: { temperature: 9 },
});
check("草稿可修改，temperature 越界钳到 2", () => {
	assert.equal(patched.status, 200);
	assert.equal(asRecord(asRecord(patched.data).modelConfig as unknown).temperature, 2);
});

const test = await call("POST", `/api/agents/${id}/actions`, { action: "test" });
check("draft → testing", () => {
	assert.equal(test.status, 200);
	assert.equal(asRecord(test.data).status, "testing");
});

const publish = await call("POST", `/api/agents/${id}/actions`, { action: "publish" });
check("testing → published", () => {
	assert.equal(publish.status, 200);
	assert.equal(asRecord(publish.data).status, "published");
});

const locked = await call("PATCH", `/api/agents/${id}`, { name: "改名" });
check("已发布拒绝编辑（409 + published_locked）", () => {
	assert.equal(locked.status, 409);
	assert.equal(asRecord(locked.data).code, "published_locked");
});

const illegal = await call("POST", `/api/agents/${id}/actions`, { action: "test" });
check("published 不能再 test（409 illegal_transition）", () => {
	assert.equal(illegal.status, 409);
	assert.equal(asRecord(illegal.data).code, "illegal_transition");
});

const stop = await call("POST", `/api/agents/${id}/actions`, { action: "stop" });
check("published → stopped", () => {
	assert.equal(stop.status, 200);
	assert.equal(asRecord(stop.data).status, "stopped");
});

const badAction = await call("POST", `/api/agents/${id}/actions`, { action: "explode" });
check("非法 action 被拒 400", () => {
	assert.equal(badAction.status, 400);
});

const revert = await call("POST", `/api/agents/${id}/actions`, { action: "revert" });
check("stopped → revert → draft", () => {
	assert.equal(revert.status, 200);
	assert.equal(asRecord(revert.data).status, "draft");
});

const list = await call("GET", "/api/agents");
check("列表能查到刚建的", () => {
	assert.equal(list.status, 200);
	const items = asRecord(list.data).items as unknown[];
	assert.ok(items.some((item) => asRecord(item).id === id));
});

const notFound = await call("GET", "/api/agents/nope");
check("不存在的 id 404", () => {
	assert.equal(notFound.status, 404);
});

// 人格指令要对"对话"生效，光存进库不算——这里验的是真实 HTTP 路径上
// POST /api/sessions 带 agentId 时，会话确实绑上了这个 Agent（而不是一个裸会话）。
// 指令正文是否进了系统提示，由 agents:selftest 读真实装配结果断言（HTTP 看不到系统提示）。
const chatAgent = await call("POST", "/api/agents", {
	name: `冒烟对话-${Date.now()}`,
	agentsMd: "# 你是报销专员\n只回答报销相关问题。",
});
const chatAgentId = String(asRecord(chatAgent.data).id);
check("带人格指令的 Agent 建出来了", () => {
	assert.equal(chatAgent.status, 201);
	assert.ok(String(asRecord(chatAgent.data).agentsMd).includes("报销专员"));
});

const chatSession = await call("POST", "/api/sessions", { workflowId: "auto-flow", agentId: chatAgentId });
check("建会话能绑上这个 Agent（配置生效的入口）", () => {
	assert.equal(chatSession.status, 201);
	const view = asRecord(chatSession.data);
	assert.equal(view.agentId, chatAgentId);
	assert.equal(view.agentName, asRecord(chatAgent.data).name);
});
const chatSessionId = String(asRecord(chatSession.data).id);

const viewAgain = await call("GET", `/api/sessions/${chatSessionId}`);
check("会话详情仍带着 Agent 绑定", () => {
	assert.equal(viewAgain.status, 200);
	assert.equal(asRecord(viewAgain.data).agentId, chatAgentId);
});

// 停用只能从 published 走（draft 直接 stop 是非法迁移，见 service.ts 的 TRANSITIONS），
// 所以这里要走完整状态机：publish 之后再 stop。
const strAgent = await call("POST", "/api/agents", { name: `冒烟停用-${Date.now()}` });
const strAgentId = String(asRecord(strAgent.data).id);
await call("POST", `/api/agents/${strAgentId}/actions`, { action: "publish" });
await call("POST", `/api/agents/${strAgentId}/actions`, { action: "stop" });
const stopped = await call("POST", "/api/sessions", { workflowId: "auto-flow", agentId: strAgentId });
check("停用的 Agent 建会话 409（配置再全也不放行）", () => {
	assert.equal(stopped.status, 409);
	assert.equal(asRecord(stopped.data).code, "stopped_not_chattable");
});


// 技能 / 知识库绑定要真的进会话，必须走完整 HTTP 路径验证。
// 注意 /api/skills 返回的是**裸数组**（不是 { items }），字段形状先看真实响应再写。
const skillsRaw = await call("GET", "/api/skills");
const skillList = (Array.isArray(skillsRaw.data) ? skillsRaw.data : []) as Record<string, unknown>[];
const boundSkill = skillList.find((item) => item.id !== "auto-flow");

const skillAgent = await call("POST", "/api/agents", {
	name: `冒烟技能-${Date.now()}`,
	skillIds: boundSkill ? [String(boundSkill.id)] : [],
});
const skillAgentId = String(asRecord(skillAgent.data).id);
check("Agent 能存下声明的技能", () => {
	const ids = asRecord(skillAgent.data).skillIds as unknown[];
	assert.equal(ids.length, 1);
	assert.equal(ids[0], boundSkill!.id);
});

const skillSession = await call("POST", "/api/sessions", { workflowId: "auto-flow", agentId: skillAgentId });
check("建会话后声明的技能已自动装上（activeSkillId 对得上）", () => {
	assert.equal(skillSession.status, 201);
	assert.equal(asRecord(skillSession.data).activeSkillId, boundSkill!.id);
});

const kbAgent = await call("POST", "/api/agents", {
	name: `冒烟知识库-${Date.now()}`,
	kbIds: ["kb_smoke_missing"],
});
const kbAgentId = String(asRecord(kbAgent.data).id);
check("Agent 能存下声明的知识库", () => {
	const ids = asRecord(kbAgent.data).kbIds as unknown[];
	assert.deepEqual(ids, ["kb_smoke_missing"]);
});

const kbSession = await call("POST", "/api/sessions", { workflowId: "auto-flow", agentId: kbAgentId });
check("声明了不存在的知识库也不影响建会话（降级而非报错）", () => {
	assert.equal(kbSession.status, 201);
});

// 复刻「点对话」的真实路径：POST 建会话 → 前端跳转后 GET 一次。
// 之前这里会丢人格：payload 只存 agentId，GET 恢复时不去回查 Agent，系统提示就退回通用模板。
const restoreAgent = await call("POST", "/api/agents", {
	name: `冒烟恢复-${Date.now()}`,
	agentsMd: "# 只回答报销\n\n开头加【报销专员】",
});
const restoreAgentId = String(asRecord(restoreAgent.data).id);
const restoreSession = await call("POST", "/api/sessions", { workflowId: "auto-flow", agentId: restoreAgentId });
const restoreSid = String(asRecord(restoreSession.data).id);
check("建会话时视图里的 Agent 名是名字，不是 id", () => {
	assert.equal(asRecord(restoreSession.data).agentName, asRecord(restoreAgent.data).name);
});

const fetched = await call("GET", `/api/sessions/${restoreSid}`);
check("GET 会话仍带着 Agent 绑定（前端点对话后的那次读取）", () => {
	const view = asRecord(fetched.data);
	assert.equal(view.agentId, restoreAgentId);
	assert.equal(view.agentName, asRecord(restoreAgent.data).name);
});

const listed = await call("GET", "/api/sessions");
check("会话列表里的 Agent 名字也是名字不是 id", () => {
	const rows = (Array.isArray(listed.data) ? listed.data : (asRecord(listed.data).items as unknown[]) ?? []) as Record<string, unknown>[];
	const row = rows.find((item) => item.id === restoreSid);
	assert.ok(row, "刚建的会话应当在列表里");
	assert.equal(row!.agentName, asRecord(restoreAgent.data).name);
});

await call("DELETE", `/api/sessions/${restoreSid}`);
await call("DELETE", `/api/agents/${restoreAgentId}`);
await call("DELETE", `/api/agents/${skillAgentId}`);
await call("DELETE", `/api/agents/${kbAgentId}`);
await call("DELETE", `/api/agents/${chatAgentId}`);
await call("DELETE", `/api/agents/${strAgentId}`);

const removed = await call("DELETE", `/api/agents/${id}`);
check("删除成功", () => {
	assert.equal(removed.status, 200);
	assert.equal(asRecord(removed.data).removed, true);
});

const gone = await call("GET", `/api/agents/${id}`);
check("删完查不到", () => {
	assert.equal(gone.status, 404);
});

console.log("");
if (process.exitCode === 1) {
	console.log(`Agent HTTP 冒烟失败（通过 ${passed} 项）`);
} else {
	console.log(`Agent HTTP 冒烟通过：${passed} 项`);
}
