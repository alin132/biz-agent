import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const directory = mkdtempSync(join(tmpdir(), "biz-group-recovery-http-"));
const dbPath = join(directory, "groups.db");
const email = "recovery-owner@example.invalid";
const password = randomUUID();
const secret = randomUUID();
let child, base, token, passed = 0, toolAttempted = false, reportUsage = true;
let reportedResponsesRemaining = null, repeatDepartmentTool = false;
const ids = {};
const prompts = [];
const toolResults = [];
const model = createServer(async (req, res) => {
	try {
		assert.equal(req.url, "/v1/chat/completions");
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		const prompt = body.messages.filter((message) => message.role === "user")
			.map((message) => typeof message.content === "string" ? message.content : message.content?.map((part) => part.text ?? "").join("\n") ?? "")
			.filter((content) => content.startsWith("BIZ_GROUP_")).at(-1) ?? "";
		prompts.push(prompt);
		toolResults.push(...body.messages.filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content)));
		let content;
		let toolCalls;
		if (prompt.startsWith("BIZ_GROUP_HOST_PLAN")) {
			content = JSON.stringify({ content: "邀请财务核对当前方案", proposal: "预算方案", agentIds: [ids.finance] });
		} else if (prompt.startsWith("BIZ_GROUP_HOST_SUMMARY")) {
			const sources = JSON.parse(prompt.match(/本轮可引用发言：(\[[\s\S]*?\])\n/)?.[1] ?? "[]");
			const sourceId = sources.find((source) => source.agentId === ids.finance)?.id;
			assert.ok(sourceId);
			content = JSON.stringify({ summary: "已补充预算依据，继续交付。", decisions: [{ content: "按当前预算核算。", sourceMessageIds: [sourceId] }], actionItems: [{ title: "复核预算清单", ownerAgentId: ids.finance, deadline: null, sourceMessageIds: [sourceId] }], unresolved: [] });
		} else if (prompt.startsWith("BIZ_GROUP_DEPARTMENT")) {
			if (!toolAttempted || repeatDepartmentTool) {
				toolAttempted = true;
				const toolName = body.tools?.find((tool) => tool.function?.name?.includes("flow_approval_flow"))?.function.name ?? "flow_approval_flow";
				toolCalls = [{ id: "blocked-flow-call", type: "function", function: { name: toolName, arguments: JSON.stringify({ task: "尝试重放审批业务操作" }) } }];
			} else content = JSON.stringify({ content: "已参考原发言，确认预算。", mentions: [], stance: "agree", proposalId: `round-${Number(prompt.match(/第 (\d+) 轮/)?.[1] ?? 2)}` });
		} else throw new Error("恢复不得重新执行已完成的主持分派或销售步骤");
		res.writeHead(200, { "content-type": "text/event-stream" });
		const delta = toolCalls ? { role: "assistant", tool_calls: toolCalls.map((call, index) => ({ index, ...call })) } : { role: "assistant", content };
		res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`);
		const includeUsage = reportUsage && (reportedResponsesRemaining === null || reportedResponsesRemaining-- > 0);
		res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: toolCalls ? "tool_calls" : "stop" }], ...(includeUsage ? { usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } } : {}) })}\n\n`);
		res.end("data: [DONE]\n\n");
	} catch (error) {
		res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: error.message } }));
	}
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));

async function check(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }
async function stop() {
	if (!child || child.exitCode !== null) return;
	const process = child;
	process.kill();
	await Promise.race([new Promise((resolve) => process.once("exit", resolve)), delay(5_000)]);
}
async function start() {
	const socket = createServer();
	await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
	const port = socket.address().port;
	await new Promise((resolve) => socket.close(resolve));
	child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { windowsHide: true, stdio: "ignore", env: { ...process.env, PORT: String(port), DB_PATH: dbPath, DATABASE_URL: "", AUTH_MODE: "required", AUTH_SECRET: secret, SECRET_KEY: secret, AUTH_BOOTSTRAP_EMAIL: email, AUTH_BOOTSTRAP_PASSWORD: password, LLM_DISABLE: "0", DINGTALK_TRANSPORT: "fake" } });
	base = `http://127.0.0.1:${port}`;
	for (let count = 0; count < 450; count++) {
		if (child.exitCode !== null) throw new Error("隔离恢复服务启动失败");
		try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* Wait for the isolated listener. */ }
		await delay(200);
	}
	throw new Error("隔离恢复服务启动超时");
}
async function request(path, body, method = body === undefined ? "GET" : "POST", auth = token) {
	return fetch(base + path, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function api(path, body, method, auth) {
	const response = await request(path, body, method, auth);
	assert.ok(response.ok, `${method ?? "API"} ${path}: HTTP ${response.status}`);
	return response.json();
}

try {
	await start();
	token = (await api("/api/auth/login", { email, password })).token;
	const provider = await api("/api/models/providers", { name: "恢复本机测试", kind: "custom", baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: randomUUID() });
	const chat = await api("/api/models", { providerId: provider.id, modelId: "recovery-fixture", name: "恢复本机模型", kind: "chat" });
	for (const [key, name] of [["host", "主持"], ["sales", "销售"], ["finance", "财务"]]) {
		const agent = await api("/api/agents", { name, modelConfig: { chatModelId: chat.id } });
		ids[key] = agent.id;
		await api(`/api/agents/${agent.id}/actions`, { action: "publish" });
	}
	const group = await api("/api/agent-groups", { name: "恢复验收", agentIds: Object.values(ids), collaboration: { mode: "moderated", hostAgentId: ids.host, maxRounds: 3, maxCalls: 12, maxDurationMs: 15_000 } });
	const auditorPassword = randomUUID();
	await api("/api/auth/users", { email: "recovery-auditor@example.invalid", password: auditorPassword, role: "auditor" });
	const auditor = (await api("/api/auth/login", { email: "recovery-auditor@example.invalid", password: auditorPassword })).token;
	await stop();
	const db = new DatabaseSync(dbPath);
	const turnId = "recovery-checkpoint";
	const state = { round: 2, calls: 3, phase: "discussing", outcome: "pending", participants: [ids.sales, ids.finance], proposal: "已由销售确认的方案", elapsedMs: 200, usage: { tokens: 30, costUsd: null, piReportedCostUsd: null }, checkpoint: { phase: "discussing", round: 2, queue: [ids.finance], ballots: { [ids.sales]: "agree" }, requests: [ids.finance], pending: [] } };
	db.prepare("INSERT INTO agent_group_turns (id, group_id, sequence, user_message, status, created_at, completed_at, discussion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(turnId, group.id, 1, "恢复预算评审", "running", Date.now(), null, JSON.stringify(state));
	db.prepare("INSERT INTO agent_group_messages (id,group_id,turn_id,role,agent_id,agent_name,content,is_error,created_at,metadata) VALUES (?,?,?,?,?,?,?,?,?,?)").run("source-sales", group.id, turnId, "agent", ids.sales, "销售", "销售已确认方案", 0, Date.now(), JSON.stringify({ kind: "reply", round: 2, stance: "agree", proposalId: "round-2" }));
	db.close();
	await start();
	await check("重启把运行中轮次标为中断，保留来源发言与恢复检查点", async () => {
		const view = await api(`/api/agent-groups/${group.id}`);
		assert.equal(view.turns[0].discussion.outcome, "interrupted");
		assert.equal(view.turns[0].canResume, true);
		assert.ok(view.messages.some((message) => message.id === "source-sales"));
	});
	await check("恢复与行动项写接口拒绝未登录和只读审计角色", async () => {
		assert.equal((await request(`/api/agent-groups/${group.id}/resume`, { turnId }, "POST", "")).status, 401);
		assert.equal((await request(`/api/agent-groups/${group.id}/resume`, { turnId }, "POST", auditor)).status, 403);
		assert.equal((await request(`/api/agent-groups/${group.id}/actions`, { turnId, actionId: "action-1", status: "done" }, "PATCH", auditor)).status, 403);
	});
	let resumed;
	await check("真实 Pi 只读恢复跳过已完成部门，并阻断 flow 委托业务操作", async () => {
		resumed = await api(`/api/agent-groups/${group.id}/resume`, { turnId });
		assert.equal(resumed.turns.length, 1);
		assert.equal(resumed.turns[0].id, turnId);
		assert.equal(resumed.turns[0].discussion.resumeCount, 1);
		assert.equal(resumed.turns[0].discussion.usage.tokens, 66);
		assert.equal(resumed.turns[0].discussion.usage.costUsd, null);
		assert.equal(resumed.turns[0].discussion.outcome, "consensus", JSON.stringify({ prompts: prompts.map((prompt) => prompt.slice(0, 90)), toolResults, messages: resumed.messages.map((message) => message.content) }));
		assert.equal(resumed.messages.filter((message) => message.id === "source-sales").length, 1);
		assert.ok(!prompts.some((prompt) => prompt.startsWith("BIZ_GROUP_HOST_PLAN") || prompt.includes("你代表「销售」")));
		assert.ok(toolAttempted);
		assert.ok(toolResults.some((result) => result.includes("无权调用工具") && result.includes("flow_approval_flow")), "flow 委托必须在外层权限钩子被拒绝");
		assert.equal((await api("/api/approvals")).total, 0);
	});
	await check("结构化行动项可更新，来源与状态在重启后保持", async () => {
		assert.equal(resumed.turns[0].discussion.result.structured, true);
		await api(`/api/agent-groups/${group.id}/actions`, { turnId, actionId: "action-1", status: "done" }, "PATCH");
		await stop(); await start();
		const restored = await api(`/api/agent-groups/${group.id}`);
		assert.equal(restored.turns[0].discussion.result.actionItems[0].status, "done");
		assert.ok(restored.turns[0].discussion.result.actionItems[0].sourceMessageIds.every((id) => restored.messages.some((message) => message.id === id && !message.isError)));
		assert.equal((await request(`/api/agent-groups/${group.id}/resume`, { turnId })).status, 409);
	});
	async function seedBudgetGroup(name, maxTokens) {
		const group = await api("/api/agent-groups", { name, agentIds: Object.values(ids), collaboration: { mode: "moderated", hostAgentId: ids.host, maxRounds: 3, maxCalls: 12, maxDurationMs: 15_000, maxTokens } });
		const turnId = `budget-${randomUUID()}`;
		const database = new DatabaseSync(dbPath);
		database.prepare("INSERT INTO agent_group_turns (id, group_id, sequence, user_message, status, created_at, completed_at, discussion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(turnId, group.id, 1, name, "failed", Date.now(), Date.now(), JSON.stringify({ ...state, calls: 1, outcome: "interrupted", phase: "finished", usage: { tokens: 0, costUsd: null, piReportedCostUsd: 0 } }));
		database.prepare("INSERT INTO agent_group_messages (id,group_id,turn_id,role,agent_id,agent_name,content,is_error,created_at,metadata) VALUES (?,?,?,?,?,?,?,?,?,?)").run(`${turnId}-sales`, group.id, turnId, "agent", ids.sales, "销售", "销售已确认方案", 0, Date.now(), JSON.stringify({ kind: "reply", round: 2, stance: "agree", proposalId: "round-2" }));
		database.close();
		return { group, turnId };
	}
	await check("单次在途请求可跨 token 预算，下一次原生 Pi 请求被阻止且不重置消耗", async () => {
		const { group, turnId } = await seedBudgetGroup("token 预算", 10);
		toolAttempted = false; reportUsage = true;
		const count = prompts.length;
		const limited = await api(`/api/agent-groups/${group.id}/resume`, { turnId });
		assert.equal(prompts.length - count, 1, "已耗尽后不能向供应商发送下一次请求");
		assert.equal(limited.turns[0].discussion.outcome, "token_limit");
		assert.equal(limited.turns[0].discussion.usage.tokens, 12);
		assert.equal(limited.turns[0].budget.remainingTokens, 0);
		assert.equal(limited.turns[0].canResume, false);
		await api(`/api/agent-groups/${group.id}`, { name: group.name, agentIds: Object.values(ids), collaboration: { ...group.collaboration, maxTokens: 100 } }, "PATCH");
		const continued = await api(`/api/agent-groups/${group.id}/resume`, { turnId });
		assert.equal(continued.turns[0].discussion.outcome, "consensus");
		assert.equal(continued.turns[0].discussion.usage.tokens, 36, "提高预算必须保留已使用的12 token");
	});
	await check("供应商不报告 usage 时明确未知，配置 token 预算则不继续请求", async () => {
		const { group, turnId } = await seedBudgetGroup("usage 缺失", 100);
		toolAttempted = false; reportUsage = false;
		const count = prompts.length;
		const failed = await api(`/api/agent-groups/${group.id}/resume`, { turnId });
		assert.equal(prompts.length - count, 1);
		assert.equal(failed.turns[0].status, "failed");
		assert.equal(failed.turns[0].discussion.usage.tokens, null);
		assert.equal(failed.turns[0].discussion.usage.costUsd, null);
		assert.ok(failed.messages.some((message) => message.content.includes("未提供可核验")));
	});
	await check("普通部门在 token 预算下也不能用 flow 子运行绕过统计", async () => {
		const group = await api("/api/agent-groups", { name: "委托预算边界", agentIds: [ids.host, ids.finance], collaboration: { mode: "moderated", hostAgentId: ids.host, maxRounds: 1, maxCalls: 12, maxDurationMs: 15_000, maxTokens: 1000 } });
		toolAttempted = false; reportUsage = true;
		const before = toolResults.length;
		const view = await api(`/api/agent-groups/${group.id}/turns`, { message: "核对预算，尝试委托审批应被 token 预算阻止" });
		assert.equal(view.turns[0].discussion.outcome, "consensus");
		assert.ok(toolResults.slice(before).some((result) => result.includes("usage 未计入主会话") && result.includes("flow_approval_flow")));
		assert.equal(view.turns[0].discussion.usage.tokens, 48);
		assert.equal((await api("/api/approvals")).total, 0);
	});
	await check("同一 Pi 会话先报告 usage 后缺失时不能被旧累计值掩盖", async () => {
		const { group, turnId } = await seedBudgetGroup("后续 usage 缺失", 100);
		toolAttempted = false; reportUsage = true;
		reportedResponsesRemaining = 1; repeatDepartmentTool = true;
		const count = prompts.length;
		try {
			const failed = await api(`/api/agent-groups/${group.id}/resume`, { turnId });
			assert.equal(prompts.length - count, 2, "先有12 token、随后缺usage后，第三次供应商请求必须被阻止");
			assert.equal(failed.turns[0].status, "failed");
			assert.equal(failed.turns[0].discussion.usage.tokens, null);
			assert.equal(failed.turns[0].budget.remainingTokens, null);
			assert.ok(failed.messages.some((message) => message.content.includes("未提供可核验")));
		} finally {
			reportedResponsesRemaining = null; repeatDepartmentTool = false;
		}
	});
	console.log(`群聊恢复 HTTP 验收：${passed} 组通过（临时 SQLite、本机假模型、真实 Pi、强制鉴权）`);
} finally {
	await stop();
	await new Promise((resolve) => model.close(resolve));
	rmSync(directory, { recursive: true, force: true });
}
