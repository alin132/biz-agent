import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createFauxRuntime, say } from "../examples/harness.js";
import { SqliteStorage } from "../server/db/sqlite.js";
import { MemoryService, memoryPrompt } from "../server/memory/service.js";
import { WorkflowRepo } from "../server/workflows.js";
import { Session } from "../server/session.js";
import { initKb, closeKb } from "../server/kb/index.js";
import type { LlmRuntime } from "../server/llm.js";
import { loadMigrations } from "../server/db/migrations.js";

const dir = mkdtempSync(join(tmpdir(), "biz-memory-session-"));
const dbPath = join(dir, "memory.db");
const db = new SqliteStorage(dbPath);
const service = new MemoryService(db);
const repo = new WorkflowRepo(db);
initKb({ dbPath });
const subjects: Session[] = [];
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	await fn(); passed++; console.log(`  ✓ ${name}`);
}
const faux = createFauxRuntime([say("第一轮完成"), say("第二轮完成"), say("第三轮完成"), say("匿名轮次完成"), say("群聊内部轮次完成")]);
const prompts: string[] = [];
const contexts: string[] = [];
const streamFn: StreamFn = (model, context, options) => {
	prompts.push(JSON.stringify(context.messages.filter((message) => message.role === "system")));
	contexts.push(JSON.stringify(context));
	return faux.streamFn(model, context, options);
};
const live: LlmRuntime = { ...faux, streamFn, label: "memory-faux", modelId: "memory-faux", provider: "faux" };
try {
	const subject = new Session(repo.get("auto-flow")!, { db, repo, ownerId: "owner-a", resolveModel: () => live }); subjects.push(subject);
	subject.activateSkill("data-flow");
	for (const tool of ["data_describe", "data_query", "data_aggregate", "report_save"]) subject.engine.recordToolResult(tool, true);
	const progress = structuredClone(subject.engine.state);
	const memory = service.create("owner-a", { content: "MEMORY_CREATE_MARKER", source: "用户确认偏好" });
	await check("已加载技能在新记忆生效后仍保留步骤进度", async () => {
		await subject.send("FIRST_HISTORY_MARKER");
		assert.ok(prompts[0]?.includes("MEMORY_CREATE_MARKER"));
		assert.equal(subject.view().activeSkillId, "data-flow");
		assert.deepEqual(subject.engine.state, progress);
	});
	await check("修改记忆在同一会话下一轮进入系统资料而不丢历史", async () => {
		service.update("owner-a", memory.id, { content: "MEMORY_UPDATE_MARKER" });
		await subject.send("SECOND_HISTORY_MARKER");
		assert.ok(prompts[1]?.includes("MEMORY_UPDATE_MARKER"));
		assert.ok(!prompts[1]?.includes("MEMORY_CREATE_MARKER"));
		assert.ok(contexts[1]?.includes("FIRST_HISTORY_MARKER"));
		assert.equal(subject.view().transcript.length, 4);
		assert.deepEqual(subject.engine.state, progress);
	});
	await check("删除记忆在同一会话下一轮停止注入且历史技能不变", async () => {
		service.remove("owner-a", memory.id);
		await subject.send("THIRD_HISTORY_MARKER");
		assert.ok(!prompts[2]?.includes("MEMORY_UPDATE_MARKER"));
		assert.ok(contexts[2]?.includes("FIRST_HISTORY_MARKER"));
		assert.ok(contexts[2]?.includes("SECOND_HISTORY_MARKER"));
		assert.equal(subject.view().transcript.length, 6);
		assert.equal(subject.view().activeSkillId, "data-flow");
		assert.deepEqual(subject.engine.state, progress);
	});
	await check("没有用户归属的开放API/内部会话不借用个人记忆", async () => {
		service.create("owner-a", { content: "PRIVATE_OWNER_MARKER", source: "用户确认" });
		const anonymous = new Session(repo.get("auto-flow")!, { db, repo, resolveModel: () => live }); subjects.push(anonymous);
		await anonymous.send("API_REQUEST_MARKER");
		assert.ok(!prompts[3]?.includes("PRIVATE_OWNER_MARKER"));
		assert.equal(memoryPrompt(db, null, null, anonymous.id), "");
	});
	await check("相同用户标识也不能读到其它工作空间记忆", () => {
		const raw = new DatabaseSync(dbPath);
		try {
			raw.prepare("INSERT INTO memories (id,workspace_id,owner_id,content,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("foreign-memory", "other-workspace", "owner-a", "FOREIGN_WORKSPACE_MARKER", "用户确认", Date.now(), Date.now());
		} finally { raw.close(); }
		assert.ok(!service.list("owner-a").some((memory) => memory.id === "foreign-memory"));
		assert.ok(!memoryPrompt(db, "owner-a", null, subject.id).includes("FOREIGN_WORKSPACE_MARKER"));
		assert.equal(db.removeMemory("foreign-memory", "owner-a"), false);
	});
	await check("群聊内部会话不注入创建者的个人记忆", async () => {
		const internal = new Session(repo.get("auto-flow")!, { db, repo, ownerId: "owner-a", internalGroupSession: true, resolveModel: () => live }); subjects.push(internal);
		await internal.send("GROUP_REQUEST_MARKER");
		assert.ok(!prompts.at(-1)?.includes("PRIVATE_OWNER_MARKER"));
	});
	await check("记忆注入有固定字符与条目预算", () => {
		for (let index = 0; index < 30; index++) service.create("budget-owner", { content: `${index}:` + "资料".repeat(900), source: "用户确认" });
		const prompt = memoryPrompt(db, "budget-owner", null, "budget-session");
		assert.ok(prompt.length < 6500);
		assert.ok(prompt.includes("参考资料"));
	});
	await check("Postgres长期记忆迁移被加载且包含范围索引", () => {
		const migration = loadMigrations().find((entry) => entry.version === "0016");
		assert.ok(migration);
		assert.ok(migration.sql.includes("CREATE TABLE IF NOT EXISTS memories"));
		assert.ok(migration.sql.includes("workspace_id, owner_id, agent_id, session_id"));
	});
	console.log(`长期记忆会话自检：${passed} 项通过`);
} finally {
	for (const subject of subjects) subject.dispose();
	closeKb(); db.close(); rmSync(dir, { recursive: true, force: true });
}
