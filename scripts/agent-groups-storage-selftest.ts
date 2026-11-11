import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations } from "../server/db/migrations.js";
import { SqliteStorage } from "../server/db/sqlite.js";
import { AgentGroupError, AgentGroupService, departmentPromptOf } from "../server/agentGroups/service.js";

const dir = mkdtempSync(join(tmpdir(), "agent-groups-storage-"));
const dbPath = join(dir, "groups.db");
let storage = new SqliteStorage(dbPath);
let passed = 0;

function check(name: string, fn: () => void): void {
	fn();
	passed++;
	console.log(`  ✓ ${name}`);
}

try {
	console.log("Agent 群组存储自检（SQLite）");
	check("部门轮次提示只注入当前事项与本轮上游发言", () => {
		const prompt = departmentPromptOf("财务协同", "第二轮事项", [{ agentName: "销售部", content: "本轮报价建议" }]);
		assert.ok(prompt.includes("第二轮事项"));
		assert.ok(prompt.includes("销售部：本轮报价建议"));
		assert.ok(!prompt.includes("完整群聊历史"));
		assert.ok(departmentPromptOf("协同", "事项", []).includes("本轮你是首个发言的部门"));
	});
	check("过长的上游部门意见会显式截断", () => {
		const prompt = departmentPromptOf("协同", "事项", [{ agentName: "销售部", content: "x".repeat(6_001) }]);
		assert.ok(prompt.includes("（意见过长，后续内容已截断）"));
		assert.ok(prompt.length < 6_200);
	});
	check("多部门意见共用固定上下文预算并公平保留各部门摘要", () => {
		const replies = Array.from({ length: 7 }, (_, index) => ({ agentName: `部门${index + 1}`, content: `${index + 1}`.repeat(6_000) }));
		const prompt = departmentPromptOf("协同", "事项", replies);
		const opinionBlock = prompt.split("本轮其他部门已给出的意见：")[1] ?? "";
		assert.ok(opinionBlock.length <= 8_000, `上游意见区超出 8000 字预算：${opinionBlock.length}`);
		for (let index = 1; index <= 7; index++) {
			assert.ok(opinionBlock.includes(`部门${index}：`), `缺少部门${index}的上游意见`);
			assert.ok(opinionBlock.includes(`${index}`.repeat(20)), `部门${index}的意见没有保留可辨认摘要`);
		}
		assert.equal((opinionBlock.match(/意见过长，后续内容已截断/g) ?? []).length, 7);
	});
	check("中断部门的下一轮提示会明确跳过未完成旧事项", () => {
		const prompt = departmentPromptOf("协同", "新一轮", [], true);
		assert.ok(prompt.includes("服务重启前没有向群聊提交本部门回复"));
		assert.ok(prompt.includes("只处理下面的新事项"));
		assert.ok(prompt.includes("新一轮"));
	});
	check("新库建好群组表", () => {
		const tables = new Set(storage.diagnostics().tables);
		for (const table of ["agent_groups", "agent_group_members", "agent_group_turns", "agent_group_messages"]) assert.ok(tables.has(table), table);
	});
	storage.close();
	const legacyDb = new DatabaseSync(dbPath);
	legacyDb.exec("DROP TABLE agent_group_messages; DROP TABLE agent_group_turns; DROP TABLE agent_group_members; DROP TABLE agent_groups;");
	legacyDb.close();
	storage = new SqliteStorage(dbPath);
	check("升级前 SQLite 库缺少群组表时，启动会自动补齐", () => {
		const tables = new Set(storage.diagnostics().tables);
		for (const table of ["agent_groups", "agent_group_members", "agent_group_turns", "agent_group_messages"]) assert.ok(tables.has(table), table);
	});

	const group = storage.createAgentGroup({ id: "group-a", name: "销售协作", createdBy: "user-a", createdAt: 10, updatedAt: 10 });
	check("群组 create/get/list/update", () => {
		assert.deepEqual(group, { id: "group-a", name: "销售协作", createdBy: "user-a", createdAt: 10, updatedAt: 10 });
		assert.deepEqual(storage.getAgentGroup(group.id), group);
		assert.deepEqual(storage.listAgentGroups(), [group]);
		assert.deepEqual(storage.updateAgentGroup(group.id, { name: "销售与运营", updatedAt: 20 }), { ...group, name: "销售与运营", updatedAt: 20 });
		assert.equal(storage.updateAgentGroup("missing", { name: "x" }), undefined);
	});

	const memberB = storage.addAgentGroupMember({ id: "member-b", groupId: group.id, agentId: "agent-b", agentName: "运营部", position: 2, sessionId: null, addedAt: 12 });
	const memberA = storage.addAgentGroupMember({ id: "member-a", groupId: group.id, agentId: "agent-a", agentName: "销售部", position: 1, sessionId: "session-a", addedAt: 11 });
	check("成员按 position 排序并支持 worker session 关联", () => {
		assert.deepEqual(storage.listAgentGroupMembers(group.id), [memberA, memberB]);
		assert.deepEqual(storage.getAgentGroupMember(memberA.id), memberA);
		assert.equal(storage.updateAgentGroupMember(memberB.id, { sessionId: "session-b" })?.sessionId, "session-b");
		assert.equal(storage.updateAgentGroupMember(memberB.id, { sessionId: null })?.sessionId, null);
		assert.equal(storage.updateAgentGroupMember("missing", { sessionId: "x" }), undefined);
		assert.equal(storage.removeAgentGroupMember("missing"), false);
	});

	const turn = storage.createAgentGroupTurn({ id: "turn-a", groupId: group.id, sequence: 1, userMessage: "分析本月业绩", status: "running", createdAt: 30, completedAt: null });
	check("turn create/get/list/update 状态与完成时间", () => {
		assert.deepEqual(storage.getAgentGroupTurn(turn.id), turn);
		assert.deepEqual(storage.listAgentGroupTurns(group.id), [turn]);
		assert.deepEqual(storage.updateAgentGroupTurn(turn.id, { status: "completed", completedAt: 40 }), { ...turn, status: "completed", completedAt: 40 });
		assert.equal(storage.updateAgentGroupTurn("missing", { status: "failed" }), undefined);
	});
	const secondConnection = new SqliteStorage(dbPath);
	const guardedTurn = storage.createAgentGroupTurn({ id: "turn-guarded", groupId: group.id, sequence: 2, userMessage: "并发保护", status: "running", createdAt: 41, completedAt: null });
	check("SQLite 跨连接拒绝同组第二个运行轮次，前轮结束后允许新轮次", () => {
		assert.throws(
			() => secondConnection.createAgentGroupTurn({ id: "turn-rejected", groupId: group.id, sequence: 3, userMessage: "重复轮次", status: "running", createdAt: 42, completedAt: null }),
			(error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "AGENT_GROUP_TURN_ALREADY_RUNNING"),
		);
		assert.deepEqual(storage.updateAgentGroupTurn(guardedTurn.id, { status: "completed", completedAt: 43 })?.status, "completed");
		assert.equal(secondConnection.createAgentGroupTurn({ id: "turn-after-guard", groupId: group.id, sequence: 3, userMessage: "下一轮", status: "running", createdAt: 44, completedAt: null }).status, "running");
		secondConnection.updateAgentGroupTurn("turn-after-guard", { status: "completed", completedAt: 45 });
	});
	secondConnection.close();

	const userMessage = storage.appendAgentGroupMessage({ id: "message-user", groupId: group.id, turnId: turn.id, role: "user", agentId: null, agentName: null, content: turn.userMessage, isError: false, createdAt: 31 });
	const agentMessage = storage.appendAgentGroupMessage({ id: "message-agent", groupId: group.id, turnId: turn.id, role: "agent", agentId: "agent-a", agentName: "销售部", content: "业绩增长 12%", isError: false, createdAt: 32 });
	const failedMessage = storage.appendAgentGroupMessage({ id: "message-error", groupId: group.id, turnId: turn.id, role: "agent", agentId: "agent-b", agentName: "运营部", content: "执行失败", isError: true, createdAt: 33 });
	check("消息只追加且按时间可从群组/turn 查询", () => {
		assert.deepEqual(storage.listAgentGroupTurnMessages(turn.id), [userMessage, agentMessage, failedMessage]);
		assert.deepEqual(storage.listAgentGroupMessages(group.id), [userMessage, agentMessage, failedMessage]);
		assert.equal(storage.listAgentGroupMessages("missing").length, 0);
	});

	const publishedAgents = ["agent-group-a", "agent-group-b"].map((id, index) => storage.createAgent({
		id, name: `部门 ${index + 1}`, status: "published", createdAt: 50 + index, updatedAt: 50 + index, statusChangedAt: 50 + index,
	}));
	const recoveryGroup = storage.createAgentGroup({ id: "group-recovery", name: "恢复协作", createdBy: "user-a", createdAt: 60, updatedAt: 60 });
	storage.addAgentGroupMember({ id: "recovery-member-a", groupId: recoveryGroup.id, agentId: publishedAgents[0]!.id, agentName: publishedAgents[0]!.name, position: 0, sessionId: "worker-a", addedAt: 60 });
	storage.addAgentGroupMember({ id: "recovery-member-b", groupId: recoveryGroup.id, agentId: publishedAgents[1]!.id, agentName: publishedAgents[1]!.name, position: 1, sessionId: "worker-b", addedAt: 60 });
	const interruptedTurn = storage.createAgentGroupTurn({ id: "turn-interrupted", groupId: recoveryGroup.id, sequence: 1, userMessage: "旧轮事项", status: "running", createdAt: 61, completedAt: null });
	storage.appendAgentGroupMessage({ id: "recovery-user", groupId: recoveryGroup.id, turnId: interruptedTurn.id, role: "user", agentId: null, agentName: null, content: interruptedTurn.userMessage, isError: false, createdAt: 62 });
	storage.appendAgentGroupMessage({ id: "recovery-reply-a", groupId: recoveryGroup.id, turnId: interruptedTurn.id, role: "agent", agentId: publishedAgents[0]!.id, agentName: publishedAgents[0]!.name, content: "已提交的部门回复", isError: false, createdAt: 63 });
	const workerSessions = new Map<string, { id: string; internalGroupSession: boolean; transcript: Array<{ role: "user" | "assistant"; text: string; at?: number }>; send: (text: string) => Promise<void>; stop?: () => boolean }>();
	const sentPrompts = new Map<string, string[]>();
	let createCount = 0;
	let removeCount = 0;
	const fakeHub = {
		get: (id: string) => workerSessions.get(id),
		create: (_workflowId: string, options: { internalGroupSession?: boolean }) => {
			const id = `worker-created-${++createCount}`;
			const session = {
				id,
				internalGroupSession: options.internalGroupSession === true,
				transcript: [] as Array<{ role: "user" | "assistant"; text: string; at?: number }>,
				send: async (text: string) => {
					sentPrompts.set(id, [...(sentPrompts.get(id) ?? []), text]);
					session.transcript.push({ role: "user", text }, { role: "assistant", text: `${id} reply` });
				},
			};
			workerSessions.set(id, session);
			return session;
		},
		remove: (id: string) => { removeCount++; return workerSessions.delete(id); },
	} as unknown as import("../server/session.js").SessionHub;
	workerSessions.set("worker-a", { id: "worker-a", internalGroupSession: true, transcript: [{ role: "user", text: "旧轮事项" }, { role: "assistant", text: "已提交的部门回复" }], send: async (text) => { sentPrompts.set("worker-a", [...(sentPrompts.get("worker-a") ?? []), text]); const session = workerSessions.get("worker-a")!; session.transcript.push({ role: "user", text }, { role: "assistant", text: "worker-a reply" }); } });
	workerSessions.set("worker-b", { id: "worker-b", internalGroupSession: true, transcript: [{ role: "user", text: "旧轮事项（中断）" }], send: async (text) => { sentPrompts.set("worker-b", [...(sentPrompts.get("worker-b") ?? []), text]); const session = workerSessions.get("worker-b")!; session.transcript.push({ role: "user", text }, { role: "assistant", text: "worker-b reply" }); } });
	const recoveryService = new AgentGroupService(storage, fakeHub);
	check("启动恢复将未完成轮次标失败，并为未提交回复的部门记下中断状态", () => {
		assert.equal(storage.getAgentGroupTurn(interruptedTurn.id)?.status, "failed");
		const messages = storage.listAgentGroupTurnMessages(interruptedTurn.id);
		assert.equal(messages.find((message) => message.agentId === publishedAgents[0]!.id)?.content, "已提交的部门回复", "已提交回复保留且不重复标记失败");
		assert.ok(messages.some((message) => message.agentId === publishedAgents[1]!.id && message.isError && message.content.includes("服务重启")), "未提交部门被显式标记为中断");
		assert.deepEqual(storage.listAgentGroupMembers(recoveryGroup.id).map((member) => member.sessionId), ["worker-a", "worker-b"], "各部门独立 Pi 会话关联在恢复后保留");
	});
	const recoveryResult = await recoveryService.send(recoveryGroup.id, "新轮事项");
	assert.equal(recoveryResult.turns.at(-1)?.status, "completed");
	assert.equal(new Set(recoveryResult.members.map((member) => member.sessionId)).size, 2, "部门仍各自使用独立 worker session");
	assert.ok(sentPrompts.get("worker-b")?.at(-1)?.includes("上一轮服务重启前没有向群聊提交本部门回复"), "中断部门收到清晰的 Pi 上下文恢复指令");
	check("恢复后的新轮次消息只归属新 turn，且每部门各有独立 Pi worker", () => {
		const nextTurn = recoveryResult.turns.at(-1)!;
		assert.equal(nextTurn.sequence, 2);
		assert.ok(storage.listAgentGroupTurnMessages(nextTurn.id).every((message) => message.turnId === nextTurn.id));
		assert.equal(workerSessions.get("worker-a")?.internalGroupSession, true);
		assert.equal(workerSessions.get("worker-b")?.internalGroupSession, true);
	});

	const cleanupGroup = storage.createAgentGroup({ id: "group-cleanup", name: "清理协作", createdBy: "user-a", createdAt: 70, updatedAt: 70 });
	for (let index = 0; index < 2; index++) storage.addAgentGroupMember({ id: `cleanup-member-${index}`, groupId: cleanupGroup.id, agentId: publishedAgents[index]!.id, agentName: publishedAgents[index]!.name, position: index, sessionId: null, addedAt: 70 });
	let releaseTurn!: () => void;
	const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
	let gateFirstCall = true;
	let stopCount = 0;
	const originalCreate = fakeHub.create;
	(fakeHub as unknown as { create: typeof originalCreate }).create = (_workflowId, options) => {
		const session = originalCreate(_workflowId, options);
		const originalSend = session.send.bind(session);
		let stopped = false;
		session.send = async (text: string) => {
			if (gateFirstCall) { gateFirstCall = false; sentPrompts.set(session.id, [...(sentPrompts.get(session.id) ?? []), text]); await turnGate; session.transcript.push({ role: "user", text, at: Date.now() }); if (!stopped) session.transcript.push({ role: "assistant", text: `${session.id} reply`, at: Date.now() }); return; }
			await originalSend(text);
		};
		session.stop = () => { stopCount++; stopped = true; releaseTurn(); return true; };
		return session;
	};
	const cleanupService = new AgentGroupService(storage, fakeHub);
	const pendingTurn = cleanupService.send(cleanupGroup.id, "等待取消保护");
	for (let n = 0; n < 20 && !cleanupService.get(cleanupGroup.id).running; n++) await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(cleanupService.get(cleanupGroup.id).activeAgentId, publishedAgents[0]!.id, "群组快照暴露当前正在执行的部门 Agent");
	assert.equal(cleanupService.get(cleanupGroup.id).activeAgentName, publishedAgents[0]!.name);
	assert.throws(() => cleanupService.update(cleanupGroup.id, { name: "运行中修改", agentIds: publishedAgents.map((agent) => agent.id) }), (error: unknown) => error instanceof AgentGroupError && error.status === 409);
	assert.throws(() => cleanupService.delete(cleanupGroup.id), (error: unknown) => error instanceof AgentGroupError && error.status === 409, "删除运行中的群聊被拒绝，不能释放正在使用的 Pi runtime");
	assert.equal(cleanupService.cancel(cleanupGroup.id), true, "主动取消会中止当前 Pi 会话并停止后续部门调度");
	assert.equal(stopCount, 1, "取消调用当前部门会话的 stop/abort");
	assert.equal(removeCount, 0, "取消不会移除当前正在执行的部门 runtime");
	const cancelled = await pendingTurn;
	assert.equal(cancelled.turns.at(-1)?.status, "cancelled");
	assert.ok(cancelled.messages.some((message) => message.turnId === cancelled.turns.at(-1)?.id && message.agentId === publishedAgents[0]!.id && message.isError && message.content.includes("Pi 执行已中止")), "当前部门明确显示 Pi 轮次已中止");
	assert.ok(cancelled.messages.some((message) => message.turnId === cancelled.turns.at(-1)?.id && message.agentId === publishedAgents[1]!.id && message.isError && message.content.includes("尚未开始执行")), "未执行部门收到明确取消状态");
	assert.equal(cleanupService.cancel(cleanupGroup.id), false, "轮次结束后重复取消返回 false");
	assert.equal(cleanupService.delete(cleanupGroup.id), true);
	assert.equal(removeCount, 1, "删除已停止的群聊会清理已启动的部门 runtime，未启动部门没有 runtime 可泄漏");

	const configGroup = recoveryService.create({ name: "配置测试", agentIds: publishedAgents.map((agent) => agent.id), createdBy: "user-a" });
	await recoveryService.send(configGroup.id, "保留记忆");
	const beforeConfig = recoveryService.get(configGroup.id);
	const thirdAgent = storage.createAgent({ id: "group-agent-third", name: "第三部门", status: "published", createdAt: 90, updatedAt: 90, statusChangedAt: 90 });
	check("配置更新保留成员会话与历史，新成员无旧记忆", () => {
		const retained = beforeConfig.members[0]!;
		const removed = beforeConfig.members[1]!;
		const updated = recoveryService.update(configGroup.id, { name: "更新后的群名", agentIds: [thirdAgent.id, retained.agentId] });
		assert.equal(updated.name, "更新后的群名");
		assert.deepEqual(updated.members.map((member) => member.agentId), [thirdAgent.id, retained.agentId]);
		assert.equal(updated.members[0]!.sessionId, null);
		assert.equal(updated.members[1]!.sessionId, retained.sessionId);
		assert.equal(updated.members[1]!.id, retained.id);
		assert.deepEqual(updated.messages, beforeConfig.messages);
		assert.equal(workerSessions.has(removed.sessionId!), false);
		assert.equal(workerSessions.has(retained.sessionId!), true);
	});
	check("配置校验先于写入，失败不改变群名和成员", () => {
		const before = recoveryService.get(configGroup.id);
		for (const agentIds of [[thirdAgent.id], [thirdAgent.id, thirdAgent.id], [thirdAgent.id, "missing"], [null, thirdAgent.id]]) {
			assert.throws(() => recoveryService.update(configGroup.id, { name: "不能保存", agentIds }), AgentGroupError);
			assert.deepEqual(recoveryService.get(configGroup.id), before);
		}
		assert.throws(() => recoveryService.update("missing", { name: "x", agentIds: [] }), (error: unknown) => error instanceof AgentGroupError && error.status === 404);
	});
	check("配置事务失败完整回滚群名与成员", () => {
		const before = recoveryService.get(configGroup.id);
		assert.throws(() => storage.saveAgentGroupConfig(configGroup.id, "回滚测试", [before.members[0]!, before.members[0]!]));
		assert.deepEqual(recoveryService.get(configGroup.id), before);
	});
	const targeted = await recoveryService.send(configGroup.id, "只请第三部门发言", [thirdAgent.id]);
	check("点名仅调度指定成员，其他成员不产生回复", () => {
		const replies = targeted.messages.filter((entry) => entry.turnId === targeted.turns.at(-1)!.id && entry.role === "agent");
		assert.deepEqual(replies.map((entry) => entry.agentId), [thirdAgent.id]);
	});
	await assert.rejects(recoveryService.send(configGroup.id, "非法点名", [publishedAgents[1]!.id]), (error: unknown) => error instanceof AgentGroupError && error.status === 400);
	await assert.rejects(recoveryService.send(configGroup.id, "重复点名", [thirdAgent.id, thirdAgent.id]), AgentGroupError);
	const allReply = await recoveryService.send(configGroup.id, "全部发言");
	assert.equal(allReply.messages.filter((entry) => entry.turnId === allReply.turns.at(-1)!.id && entry.role === "agent").length, 2);
	check("删除群组事务级联清理成员、turn、消息，重复删除返回 false", () => {
		assert.equal(storage.deleteAgentGroup(group.id), true);
		assert.equal(storage.getAgentGroup(group.id), undefined);
		assert.deepEqual(storage.listAgentGroupMembers(group.id), []);
		assert.deepEqual(storage.listAgentGroupTurns(group.id), []);
		assert.deepEqual(storage.listAgentGroupMessages(group.id), []);
		assert.equal(storage.deleteAgentGroup(group.id), false);
	});

	check("Postgres 迁移版本唯一且群组迁移在模型设置之前", () => {
		const migration = loadMigrations().find((entry) => entry.version === "0011");
		assert.ok(migration);
		const migrations = loadMigrations();
		assert.equal(new Set(migrations.map((entry) => entry.version)).size, migrations.length);
		assert.equal(migrations.at(-1)?.version, "0015");
		assert.equal(migrations.find((entry) => entry.name === "model settings")?.version, "0012");
		for (const table of ["agent_groups", "agent_group_members", "agent_group_turns", "agent_group_messages"]) {
			assert.match(migration.sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
		}
		assert.match(migration.sql, /ON DELETE CASCADE/);
		assert.match(migration.sql, /idx_agent_group_turns_group_sequence/);
		assert.match(migration.sql, /idx_agent_group_messages_group_order/);
		const concurrencyMigration = migrations.find((entry) => entry.version === "0013");
		assert.ok(concurrencyMigration);
		assert.match(concurrencyMigration.sql, /idx_agent_group_turns_one_running_per_group/);
		assert.match(concurrencyMigration.sql, /WHERE status = 'running'/);
	});

	console.log(`Agent 群组 SQLite 自检：${passed} 项通过`);
} finally {
	storage.close();
	rmSync(dir, { recursive: true, force: true });
}
