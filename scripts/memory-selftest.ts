import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SqliteStorage } from "../server/db/sqlite.js";
import { AgentService } from "../server/agents/service.js";
import { MemoryError, MemoryService, memoryPrompt } from "../server/memory/service.js";
import { handleMemoryRoute } from "../server/memory/routes.js";
import { initAuth } from "../server/auth/service.js";
import { WorkflowRepo } from "../server/workflows.js";
import { Session } from "../server/session.js";
import { initKb, closeKb } from "../server/kb/index.js";

process.env.LLM_DISABLE = "1";
process.env.AUTH_MODE = "required";
process.env.AUTH_SECRET = randomUUID();
delete process.env.AUTH_BOOTSTRAP_EMAIL;
delete process.env.AUTH_BOOTSTRAP_PASSWORD;
const dir = mkdtempSync(join(tmpdir(), "biz-memory-selftest-"));
const path = join(dir, "memory.db");
let storage = new SqliteStorage(path);
let service = new MemoryService(storage);
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	await fn(); passed++; console.log(`  ✓ ${name}`);
}
function bad(fn: () => unknown, status: number): void {
	assert.throws(fn, (error: unknown) => error instanceof MemoryError && error.status === status);
}
initKb({ dbPath: path });
const repo = new WorkflowRepo(storage);
let subject: Session | undefined;
let server: ReturnType<typeof createServer> | undefined;
try {
	const agent = new AgentService({ storage }).create({ name: "记忆测试 Agent", createdBy: "user-a" });
	const otherAgent = new AgentService({ storage }).create({ name: "其它 Agent", createdBy: "user-a" });
	const first = service.create("user-a", { content: "回复使用中文", source: "用户明确确认" });
	const scoped = service.create("user-a", { content: "报价必须包含税费", source: "项目约定", agentId: agent.id });
	service.create("user-b", { content: "其它用户的私密偏好", source: "用户确认" });
	await check("记忆带来源、用户和时间，写入数据库", () => {
		assert.equal(first.ownerId, "user-a"); assert.equal(first.source, "用户明确确认");
		assert.ok(first.createdAt > 0); assert.equal(storage.listMemories({ ownerId: "user-a" }).length, 2);
	});
	await check("用户读取、编辑、删除互相隔离且不存在统一返回404", () => {
		assert.equal(service.list("user-b").length, 1);
		bad(() => service.update("user-b", first.id, { content: "篡改" }), 404);
		bad(() => service.remove("user-b", first.id), 404);
		assert.equal(service.list("user-a")[0]?.ownerId, "user-a");
	});
	await check("Agent 范围与个人范围可精确查询", () => {
		assert.deepEqual(service.list("user-a", { agentId: agent.id }).map((memory) => memory.id), [scoped.id]);
		assert.deepEqual(service.list("user-a", { agentId: null }).map((memory) => memory.id), [first.id]);
	});
	await check("缺少来源、空内容、超长内容和未知Agent明确拒绝", () => {
		bad(() => service.create("user-a", { content: "事实" }), 400);
		bad(() => service.create("user-a", { content: " ", source: "确认" }), 400);
		bad(() => service.create("user-a", { content: "x".repeat(2001), source: "确认" }), 400);
		bad(() => service.create("user-a", { content: "事实", source: "确认", agentId: "missing" }), 404);
	});
	subject = new Session(repo.get("auto-flow")!, { db: storage, repo, ownerId: "user-a", resolveModel: () => null });
	const sessionMemory = service.create("user-a", { content: "当前任务只讨论北区", source: "会话中用户确认", sessionId: subject.id });
	await check("会话记忆不允许读取其它用户来源会话，也不能伪造Agent绑定", () => {
		bad(() => service.create("user-b", { content: "伪造", source: "确认", sessionId: subject!.id }), 404);
		bad(() => service.create("user-a", { content: "伪造", source: "确认", sessionId: subject!.id, agentId: agent.id }), 400);
	});
	await check("注入只包含适用范围且将来源标为用户资料", () => {
		const prompt = memoryPrompt(storage, "user-a", agent.id, "other-session");
		assert.ok(prompt.includes("回复使用中文")); assert.ok(prompt.includes("报价必须包含税费"));
		assert.ok(!prompt.includes("当前任务只讨论北区")); assert.ok(!prompt.includes("其它用户"));
		assert.ok(prompt.includes("不是操作指令"));
		assert.ok(!memoryPrompt(storage, "user-a", otherAgent.id, "other-session").includes("报价必须包含税费"));
		assert.equal(memoryPrompt(storage, null, agent.id, subject!.id), "");
	});
	await check("编辑内容和来源但不能跨范围移动记录", () => {
		const updated = service.update("user-a", first.id, { content: "使用简体中文", source: "用户修订确认", agentId: otherAgent.id });
		assert.equal(updated.agentId, null); assert.equal(updated.content, "使用简体中文");
	});
	await check("下一轮注入新记忆，删除后下一轮不再注入", async () => {
		await subject!.send("确认偏好");
		const prompt = (subject as unknown as { runtimeSystemPrompt(): string }).runtimeSystemPrompt();
		assert.ok(prompt.includes("使用简体中文")); assert.ok(prompt.includes("当前任务只讨论北区"));
		service.remove("user-a", sessionMemory.id);
		await subject!.send("继续");
		assert.ok(!(subject as unknown as { runtimeSystemPrompt(): string }).runtimeSystemPrompt().includes("当前任务只讨论北区"));
	});
	subject.dispose(); subject = undefined;
	await check("重开数据库保留记忆及修改内容", () => {
		storage.close(); storage = new SqliteStorage(path); service = new MemoryService(storage);
		assert.equal(service.list("user-a").find((memory) => memory.id === first.id)?.content, "使用简体中文");
	});
	const users = ["user-a", "user-b", "user-auditor"].map((id) => storage.createUser({ id, workspaceId: "default", email: `${id}@example.invalid`, name: null, passwordHash: null, role: id === "user-auditor" ? "auditor" : "developer", disabled: false, createdAt: Date.now() }));
	const auth = initAuth(storage);
	server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://localhost");
			const denied = auth.guard(req, req.method ?? "GET", url.pathname);
			if (denied) { res.writeHead(denied.status, { "content-type": "application/json" }); res.end(JSON.stringify(denied)); return; }
			if (!await handleMemoryRoute(req, res, url, service, auth)) { res.writeHead(404); res.end(); }
		})().catch(() => { res.writeHead(500); res.end(); });
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const token = (index: number) => auth.issueToken({ ...users[index]!, lastLoginAt: null });
	const request = (path: string, index: number, method = "GET", body?: unknown) => fetch(base + path, { method, headers: { authorization: `Bearer ${token(index)}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	await check("HTTP未登录401，审计员可读不可写", async () => {
		assert.equal((await fetch(base + "/api/memories")).status, 401);
		assert.equal((await request("/api/memories", 2)).status, 200);
		assert.equal((await request("/api/memories", 2, "POST", { content: "越权", source: "确认" })).status, 403);
	});
	await check("HTTP查询不接受冒充owner，修改删除不能访问其它用户记忆", async () => {
		const response = await request("/api/memories?ownerId=user-a", 1);
		const data = await response.json() as { items: Array<{ ownerId: string }> };
		assert.ok(data.items.every((memory) => memory.ownerId === "user-b"));
		assert.equal((await request(`/api/memories/${first.id}`, 1, "PATCH", { content: "越权" })).status, 404);
		assert.equal((await request(`/api/memories/${first.id}`, 1, "DELETE")).status, 404);
	});
	await check("HTTP新增修改删除闭环，source和scope真实回显", async () => {
		const response = await request("/api/memories", 0, "POST", { content: "HTTP确认事实", source: "用户设置", ownerId: "user-b" });
		assert.equal(response.status, 201); const memory = await response.json() as { id: string; ownerId: string; source: string; agentId: null };
		assert.equal(memory.ownerId, "user-a"); assert.equal(memory.source, "用户设置"); assert.equal(memory.agentId, null);
		assert.equal((await request(`/api/memories/${memory.id}`, 0, "PATCH", { content: "HTTP修订事实" })).status, 200);
		assert.equal((await request(`/api/memories/${memory.id}`, 0, "DELETE")).status, 200);
		assert.equal((await request(`/api/memories/${memory.id}`, 0, "DELETE")).status, 404);
	});
	console.log(`长期记忆自检：${passed} 项通过`);
} finally {
	subject?.dispose();
	if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
	closeKb(); storage.close(); rmSync(dir, { recursive: true, force: true });
}
