import { randomUUID } from "node:crypto";
import type { Storage, AgentGroupRecord, AgentGroupTurnRecord, AgentGroupMessageRecord, AgentGroupUsage } from "../db/types.js";
import type { SessionHub } from "../session.js";
import { collaborationConfig, discussionHistory, moderateDiscussion } from "./moderation.js";
import { addPiUsage, structuredDiscussionContext } from "./results.js";

const MAX_MEMBERS = 8;
const MAX_MESSAGE_LENGTH = 12_000;
const MAX_PRIOR_REPLY_CHARS = 6_000;
const MAX_PRIOR_REPLIES_TOTAL_CHARS = 8_000;
const PRIOR_REPLY_TRUNCATION = "\n（意见过长，后续内容已截断）";
const RESTART_RECOVERY_MESSAGE = "本群聊轮次在服务重启时未提交部门回复；若部门会话里有本轮遗留事项，请忽略并只处理新的本轮事项。";
const RESTART_NOT_STARTED_MESSAGE = "服务重启时本部门尚未轮到发言，本轮未执行。";
const CANCELLED_MEMBER_MESSAGE = "本轮已取消，本部门尚未开始执行。";
const CANCELLED_CURRENT_MESSAGE = "本轮已取消，当前部门的 Pi 执行已中止。";

export interface AgentGroupReplyContext {
	agentName: string;
	content: string;
}

export function departmentPromptOf(groupName: string, userMessage: string, priorReplies: AgentGroupReplyContext[], previousTurnInterrupted = false): string {
	const replyHeaderChars = priorReplies.reduce((total, reply) => total + reply.agentName.length + 1, 0);
	const separatorsChars = Math.max(0, priorReplies.length - 1) * 2;
	const truncationChars = priorReplies.length * PRIOR_REPLY_TRUNCATION.length;
	const promptSeparatorChars = 2;
	const perReplyBudget = priorReplies.length === 0 ? 0 : Math.max(0, Math.floor((MAX_PRIOR_REPLIES_TOTAL_CHARS - replyHeaderChars - separatorsChars - truncationChars - promptSeparatorChars) / priorReplies.length));
	const previous = priorReplies.length === 0
		? "本轮你是首个发言的部门。"
		: [
			"本轮其他部门已给出的意见：",
			...priorReplies.map(({ agentName, content }) => {
				const budget = Math.min(MAX_PRIOR_REPLY_CHARS, perReplyBudget);
				const clipped = content.length > budget
					? `${content.slice(0, budget)}${PRIOR_REPLY_TRUNCATION}`
					: content;
				return `${agentName}：${clipped}`;
			}),
		].join("\n\n");
	return [
		`你正在参加「${groupName}」部门协同群聊。`,
		"请只代表本部门独立分析；指出需要其他部门配合的事项，不要假装代表其他部门。",
		...(previousTurnInterrupted ? ["上一轮服务重启前没有向群聊提交本部门回复。若会话历史包含那轮事项，请不要继续执行，只处理下面的新事项。"] : []),
		"",
		"本轮事项：",
		userMessage,
		"",
		previous,
	].join("\n");
}

function id(prefix: string): string {
	return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

export class AgentGroupError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
		this.name = "AgentGroupError";
	}
}

function isRunningTurnConflict(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const dbError = error as { code?: unknown; constraint?: unknown };
	return dbError.code === "AGENT_GROUP_TURN_ALREADY_RUNNING"
		|| (dbError.code === "23505" && dbError.constraint === "idx_agent_group_turns_one_running_per_group");
}

export class AgentGroupService {
	private readonly running = new Set<string>();
	private readonly controllers = new Map<string, AbortController>();
	private readonly activeSessions = new Map<string, { sessionId: string; agentId: string; agentName: string }>();

	constructor(private readonly storage: Storage, private readonly hub: SessionHub) {
		const now = Date.now();
		for (const group of storage.listAgentGroups()) {
			for (const turn of storage.listAgentGroupTurns(group.id)) {
				if (turn.status !== "running") continue;
				const interruptedDiscussion = turn.discussion ? { ...turn.discussion, phase: "finished" as const, outcome: "interrupted" as const } : undefined;
				if (interruptedDiscussion?.activeCallStartedAt !== undefined) {
					interruptedDiscussion.elapsedMs = Math.min(group.collaboration?.maxDurationMs ?? 600_000, (interruptedDiscussion.elapsedMs ?? 0) + Math.max(0, now - interruptedDiscussion.activeCallStartedAt));
					delete interruptedDiscussion.activeCallStartedAt;
				}
				storage.updateAgentGroupTurn(turn.id, { status: "failed", completedAt: now, ...(interruptedDiscussion ? { discussion: interruptedDiscussion } : {}) });
				if (turn.discussion) {
					storage.appendAgentGroupMessage({ id: id("gmsg"), groupId: group.id, turnId: turn.id, role: "agent", agentId: null, agentName: "调度器", content: `服务重启，主持讨论已中断；不会自动重放工具操作，${turn.discussion.checkpoint ? "可从检查点只读恢复或发送新事项。" : "请发送新的事项继续。"}`, isError: true, createdAt: now, metadata: { kind: "notice", round: turn.discussion.round } });
					continue;
				}
				const turnMessages = storage.listAgentGroupTurnMessages(turn.id);
				const repliedAgentIds = new Set(turnMessages.filter((message) => message.role === "agent" && !message.isError).map((message) => message.agentId));
				const recordedAgentIds = new Set(turnMessages.filter((message) => message.role === "agent").map((message) => message.agentId));
				for (const member of this.conversationMembers(group.id, turn.conversationId)) {
					if (repliedAgentIds.has(member.agentId) || recordedAgentIds.has(member.agentId)) continue;
					const session = member.sessionId ? hub.get(member.sessionId) : undefined;
					const lastUserMessage = [...(session?.transcript ?? [])].reverse().find((message) => message.role === "user")?.text ?? "";
					const interrupted = lastUserMessage.includes(turn.userMessage);
					storage.appendAgentGroupMessage({
						id: id("gmsg"), groupId: group.id, turnId: turn.id, role: "agent",
						agentId: member.agentId, agentName: member.agentName,
						content: interrupted ? RESTART_RECOVERY_MESSAGE : RESTART_NOT_STARTED_MESSAGE, isError: true, createdAt: now,
					});
				}
			}
		}
	}

	list() {
		return this.storage.listAgentGroups().map((group) => this.view(group));
	}

	get(groupId: string, conversationValue?: unknown) {
		const group = this.requireGroup(groupId);
		return this.view(group, this.conversationIdOf(groupId, conversationValue));
	}

	createConversation(groupId: string) {
		const group = this.requireGroup(groupId);
		if (this.running.has(groupId) || this.storage.listAgentGroupTurns(groupId).some((turn) => turn.status === "running")) throw new AgentGroupError(409, "群聊正在运行，请结束本轮后新建对话");
		const now = Math.max(Date.now(), group.updatedAt + 1);
		const conversation = this.storage.createAgentGroupConversation({ id: id("gchat"), groupId, title: "新对话", createdAt: now, updatedAt: now, workers: {} });
		this.storage.updateAgentGroup(groupId, { updatedAt: now });
		return this.get(groupId, conversation.id);
	}

	create(input: { name: unknown; agentIds: unknown; createdBy: string | null; collaboration?: unknown }) {
		const name = typeof input.name === "string" ? input.name.trim() : "";
		if (!name) throw new AgentGroupError(400, "请填写群组名称");
		if (name.length > 60) throw new AgentGroupError(400, "群组名称不能超过 60 个字");
		if (!Array.isArray(input.agentIds)) throw new AgentGroupError(400, "部门 Agent 列表格式错误");
		const agentIds = [...new Set(input.agentIds.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim()))];
		if (agentIds.length < 2 || agentIds.length > MAX_MEMBERS) throw new AgentGroupError(400, `部门 Agent 数量必须是 2–${MAX_MEMBERS} 个`);
		const agents = agentIds.map((agentId) => {
			const agent = this.storage.getAgent(agentId);
			if (!agent) throw new AgentGroupError(404, `找不到 Agent：${agentId}`);
			if (agent.status !== "published") throw new AgentGroupError(400, `「${agent.name}」尚未发布，不能加入部门群聊`);
			return agent;
		});
		const collaboration = this.validateCollaboration(input.collaboration, agentIds);
		const now = Date.now();
		const group = this.storage.createAgentGroup({ id: id("group"), name, createdBy: input.createdBy, createdAt: now, updatedAt: now, ...(collaboration ? { collaboration } : {}) });
		agents.forEach((agent, position) => this.storage.addAgentGroupMember({
			id: id("member"), groupId: group.id, agentId: agent.id, agentName: agent.name, position, sessionId: null, addedAt: now,
		}));
		return this.view(group);
	}

	update(groupId: string, input: { name: unknown; agentIds: unknown; collaboration?: unknown }) {
		const group = this.requireGroup(groupId);
		if (this.running.has(groupId) || this.storage.listAgentGroupTurns(groupId).some((turn) => turn.status === "running")) {
			throw new AgentGroupError(409, "群聊正在运行，请结束本轮后再修改配置");
		}
		const name = typeof input.name === "string" ? input.name.trim() : "";
		if (!name || name.length > 60) throw new AgentGroupError(400, "群聊名称须为 1–60 个字");
		if (!Array.isArray(input.agentIds) || input.agentIds.some((value) => typeof value !== "string" || !value.trim())) {
			throw new AgentGroupError(400, "部门 Agent 列表格式错误");
		}
		const agentIds = input.agentIds as string[];
		if (new Set(agentIds).size !== agentIds.length || agentIds.length < 2 || agentIds.length > MAX_MEMBERS) {
			throw new AgentGroupError(400, `请选择 2–${MAX_MEMBERS} 个不同的部门 Agent`);
		}
		const previous = this.storage.listAgentGroupMembers(groupId);
		const members = agentIds.map((agentId, position) => {
			const current = previous.find((member) => member.agentId === agentId);
			const agent = this.storage.getAgent(agentId);
			// Existing unavailable members may remain so other configuration can still be edited.
			if (!current && (!agent || agent.status !== "published")) throw new AgentGroupError(400, "新增成员必须是已发布的 Agent");
			return { id: current?.id ?? id("member"), groupId, agentId, agentName: agent?.name ?? current!.agentName, position, sessionId: current?.sessionId ?? null, addedAt: current?.addedAt ?? Date.now() };
		});
		const collaboration = this.validateCollaboration(input.collaboration === undefined ? group.collaboration : input.collaboration, agentIds);
		this.storage.saveAgentGroupConfig(groupId, name, members, collaboration);
		for (const conversation of this.storage.listAgentGroupConversations(groupId)) {
			const workers = { ...conversation.workers };
			for (const [agentId, sessionId] of Object.entries(workers)) {
				if (!agentIds.includes(agentId)) { this.hub.remove(sessionId); delete workers[agentId]; }
			}
			this.storage.updateAgentGroupConversation(conversation.id, { workers });
		}
		for (const member of previous) {
			if (!agentIds.includes(member.agentId) && member.sessionId) this.hub.remove(member.sessionId);
		}
		return this.get(groupId);
	}

	async send(groupId: string, value: unknown, targetValue?: unknown, conversationValue?: unknown) {
		const group = this.requireGroup(groupId);
		const conversationId = this.conversationIdOf(groupId, conversationValue);
		const userMessage = typeof value === "string" ? value.trim() : "";
		if (!userMessage) throw new AgentGroupError(400, "请填写群聊消息");
		if (userMessage.length > MAX_MESSAGE_LENGTH) throw new AgentGroupError(400, `消息不能超过 ${MAX_MESSAGE_LENGTH} 个字`);
		if (this.running.has(groupId) || this.storage.listAgentGroupTurns(groupId).some((entry) => entry.status === "running")) {
			throw new AgentGroupError(409, "这个部门群聊正在处理上一轮");
		}
		const allMembers = this.conversationMembers(groupId, conversationId);
		if (allMembers.length < 2) throw new AgentGroupError(409, "群组成员不足，至少需要两个部门 Agent");
		let members = allMembers;
		if (targetValue !== undefined) {
			if (!Array.isArray(targetValue) || targetValue.length === 0 || targetValue.some((id) => typeof id !== "string")) {
				throw new AgentGroupError(400, "点名成员格式错误");
			}
			const targetIds = new Set(targetValue as string[]);
			if (targetIds.size !== targetValue.length || [...targetIds].some((id) => !allMembers.some((member) => member.agentId === id))) {
				throw new AgentGroupError(400, "点名成员必须来自当前群聊");
			}
			members = allMembers.filter((member) => targetIds.has(member.agentId));
		}
		if (group.collaboration && this.storage.getAgent(group.collaboration.hostAgentId)?.status !== "published") throw new AgentGroupError(409, "主持 Agent 不可用，请修改群聊配置选择已发布的主持");
		this.running.add(groupId);
		const controller = new AbortController();
		this.controllers.set(groupId, controller);
		let turn: AgentGroupTurnRecord | undefined;
		let failed = false;
		const repliedAgentIds = new Set<string>();
		try {
			const sequence = Math.max(0, ...this.storage.listAgentGroupTurns(groupId).map((entry) => entry.sequence)) + 1;
			turn = { id: id("turn"), groupId, ...(conversationId ? { conversationId } : {}), sequence, userMessage, status: "running", createdAt: Date.now(), completedAt: null,
				...(group.collaboration ? { discussion: { round: 0, calls: 0, phase: "planning" as const, outcome: "pending" as const, participants: [], proposal: "" } } : {}) };
			this.storage.updateAgentGroup(groupId, { updatedAt: turn.createdAt });
			try {
				this.storage.createAgentGroupTurn(turn);
			} catch (error) {
				if (isRunningTurnConflict(error)) throw new AgentGroupError(409, "这个部门群聊正在处理上一轮");
				throw error;
			}
			if (conversationId) {
				const conversation = this.storage.getAgentGroupConversation(conversationId)!;
				this.storage.updateAgentGroupConversation(conversationId, { title: conversation.title === "新对话" ? userMessage.slice(0, 60) : conversation.title, updatedAt: turn.createdAt });
			}
			this.appendMessage({ id: id("gmsg"), groupId, turnId: turn.id, role: "user", agentId: null, agentName: null, content: userMessage, isError: false, createdAt: Date.now() });
			if (group.collaboration) {
				await this.sendModerated(group, turn, targetValue === undefined ? [] : members.map((member) => member.agentId), controller);
			} else {
			const priorReplies: AgentGroupReplyContext[] = [];
			const priorMessages = this.conversationMessages(groupId, conversationId);
			for (const member of members) {
				if (controller.signal.aborted) {
					for (const pending of members.slice(members.indexOf(member))) {
						if (repliedAgentIds.has(pending.agentId)) continue;
						this.appendMessage({ id: id("gmsg"), groupId, turnId: turn.id, role: "agent", agentId: pending.agentId, agentName: pending.agentName, content: CANCELLED_MEMBER_MESSAGE, isError: true, createdAt: Date.now() });
					}
					break;
				}
				const agent = this.storage.getAgent(member.agentId);
				if (!agent || agent.status !== "published") {
					failed = true;
					const unavailable = "该 Agent 已删除或已停止，无法参与本轮。";
					this.appendMessage({ id: id("gmsg"), groupId, turnId: turn.id, role: "agent", agentId: member.agentId, agentName: member.agentName, content: unavailable, isError: true, createdAt: Date.now() });
					priorReplies.push({ agentName: member.agentName, content: unavailable });
					continue;
				}
				try {
					let session = member.sessionId ? this.hub.get(member.sessionId) : undefined;
					if (!session) {
						session = this.hub.create("auto-flow", {
							internalGroupSession: true,
							ownerId: group.createdBy,
							modelId: agent.modelConfig.chatModelId ?? undefined,
							agent: {
								id: agent.id, name: agent.name, prompt: agent.agentsMd,
								skillIds: agent.skillIds, kbIds: agent.kbIds,
								modelConfig: agent.modelConfig, memoryConfig: agent.memoryConfig, advancedConfig: agent.advancedConfig,
							},
						});
						try {
							this.saveWorker(groupId, conversationId, member.id, member.agentId, session.id);
						} catch (error) {
							this.hub.remove(session.id);
							throw error;
						}
					}
					const assistantCount = session.transcript.filter((entry) => entry.role === "assistant").length;
					const latestMemberMessage = [...priorMessages].reverse().find((message) => message.agentId === member.agentId);
					const previousTurnInterrupted = Boolean(latestMemberMessage?.isError && latestMemberMessage.content === RESTART_RECOVERY_MESSAGE);
					this.activeSessions.set(groupId, { sessionId: session.id, agentId: agent.id, agentName: agent.name });
					try {
						await session.send(departmentPromptOf(group.name, userMessage, priorReplies, previousTurnInterrupted));
					} finally {
						if (this.activeSessions.get(groupId)?.sessionId === session.id) this.activeSessions.delete(groupId);
					}
					if (controller.signal.aborted) {
						this.appendMessage({ id: id("gmsg"), groupId, turnId: turn.id, role: "agent", agentId: agent.id, agentName: agent.name, content: CANCELLED_CURRENT_MESSAGE, isError: true, createdAt: Date.now() });
						repliedAgentIds.add(agent.id);
						continue;
					}
					const reply = session.transcript.filter((entry) => entry.role === "assistant").slice(assistantCount).at(-1)?.text?.trim();
					if (!reply) throw new Error("Agent 没有返回可见回复");
					this.appendMessage({ id: id("gmsg"), groupId, turnId: turn.id, role: "agent", agentId: agent.id, agentName: agent.name, content: reply, isError: false, createdAt: Date.now() });
					repliedAgentIds.add(agent.id);
					priorReplies.push({ agentName: agent.name, content: reply });
				} catch (error) {
					if (controller.signal.aborted) {
						this.appendMessage({ id: id("gmsg"), groupId, turnId: turn.id, role: "agent", agentId: member.agentId, agentName: member.agentName, content: CANCELLED_CURRENT_MESSAGE, isError: true, createdAt: Date.now() });
						repliedAgentIds.add(member.agentId);
						continue;
					}
					failed = true;
					const message = error instanceof Error ? error.message : String(error);
					this.appendMessage({ id: id("gmsg"), groupId, turnId: turn.id, role: "agent", agentId: member.agentId, agentName: agent.name, content: message, isError: true, createdAt: Date.now() });
					priorReplies.push({ agentName: agent.name, content: `本轮未能完成：${message}` });
				}
			}
			this.storage.updateAgentGroupTurn(turn.id, { status: controller.signal.aborted ? "cancelled" : failed ? "failed" : "completed", completedAt: Date.now() });
			}
		} catch (error) {
			if (turn) this.storage.updateAgentGroupTurn(turn.id, { status: "failed", completedAt: Date.now() });
			throw error;
		} finally {
			this.running.delete(groupId);
			this.controllers.delete(groupId);
		}
		return this.get(groupId, conversationId);
	}

	private validateCollaboration(value: unknown, memberIds: string[]) {
		try { return collaborationConfig(value, memberIds); }
		catch (error) { throw new AgentGroupError(400, error instanceof Error ? error.message : String(error)); }
	}

	async resume(groupId: string, turnValue: unknown) {
		const group = this.requireGroup(groupId);
		if (typeof turnValue !== "string" || !turnValue.trim()) throw new AgentGroupError(400, "请指定要恢复的讨论轮次");
		const turn = this.storage.getAgentGroupTurn(turnValue);
		if (!turn || turn.groupId !== groupId) throw new AgentGroupError(404, "找不到这个群聊的讨论轮次");
		if (!group.collaboration || !turn.discussion?.checkpoint) throw new AgentGroupError(409, "这轮讨论没有可恢复检查点，请发送新事项继续");
		if (this.running.has(groupId) || this.storage.listAgentGroupTurns(groupId).some((entry) => entry.status === "running")) throw new AgentGroupError(409, "群聊正在运行，请结束后再恢复");
		if (turn.status !== "failed" && turn.status !== "cancelled") throw new AgentGroupError(409, "只有失败或停止的讨论可恢复，已完成讨论不会重复执行");
		if (this.storage.listAgentGroupTurns(groupId).filter((entry) => entry.conversationId === turn.conversationId).at(-1)?.id !== turn.id) throw new AgentGroupError(409, "这条对话已有后续事项，不能恢复较早轮次");
		if (turn.discussion.calls >= group.collaboration.maxCalls || (turn.discussion.elapsedMs ?? 0) >= (group.collaboration.maxDurationMs ?? 600_000)) throw new AgentGroupError(409, "原轮次预算已耗尽，请调整群聊预算后再恢复或新建事项");
		if (group.collaboration.maxTokens !== undefined && (turn.discussion.usage?.tokens == null || turn.discussion.usage.tokens >= group.collaboration.maxTokens)) throw new AgentGroupError(409, "原轮次 token 预算已耗尽或实际 usage 不可用，请调整预算配置后再恢复");
		if (turn.discussion.hostAgentId && turn.discussion.hostAgentId !== group.collaboration.hostAgentId) throw new AgentGroupError(409, "主持 Agent 已变化，请新建事项，不替换原讨论主持");
		const ids = new Set(this.conversationMembers(groupId, turn.conversationId).map((member) => member.agentId));
		const checkpoint = turn.discussion.checkpoint;
		if ([...turn.discussion.participants, ...checkpoint.queue, ...checkpoint.requests, ...checkpoint.pending, ...(checkpoint.failedAgentIds ?? [])].some((id) => !ids.has(id) || id === group.collaboration!.hostAgentId)) throw new AgentGroupError(409, "群聊成员已变化，请新建事项，不自动替换原参与部门");
		if (this.storage.getAgent(group.collaboration.hostAgentId)?.status !== "published") throw new AgentGroupError(409, "主持 Agent 不可用，请先修复群聊配置");
		const controller = new AbortController();
		this.running.add(groupId);
		this.controllers.set(groupId, controller);
		try {
			this.storage.updateAgentGroupTurn(turn.id, { status: "running", completedAt: null });
			this.appendMessage({ id: id("gmsg"), groupId, turnId: turn.id, role: "agent", agentId: null, agentName: "调度器", content: "正在从检查点只读恢复：保留已提交发言，未完成部门仅补充分析，不重放业务写入操作。", isError: false, createdAt: Date.now(), metadata: { kind: "notice", round: turn.discussion.round } });
			await this.sendModerated(group, turn, [], controller, true);
		} catch (error) {
			this.storage.updateAgentGroupTurn(turn.id, { status: "failed", completedAt: Date.now() });
			throw error;
		} finally {
			this.running.delete(groupId);
			this.controllers.delete(groupId);
		}
		return this.get(groupId, turn.conversationId);
	}

	updateAction(groupId: string, input: { turnId: unknown; actionId: unknown; status: unknown }) {
		this.requireGroup(groupId);
		if (typeof input.turnId !== "string" || typeof input.actionId !== "string" || !["pending", "in_progress", "done", "cancelled"].includes(String(input.status))) throw new AgentGroupError(400, "请指定有效的轮次、行动项和状态");
		const turn = this.storage.getAgentGroupTurn(input.turnId);
		if (!turn || turn.groupId !== groupId) throw new AgentGroupError(404, "找不到这个群聊的讨论轮次");
		if (this.running.has(groupId) || turn.status !== "completed") throw new AgentGroupError(409, "请先完成讨论再更新行动项，避免恢复汇总覆盖处理中状态");
		const result = turn.discussion?.result;
		if (!result?.actionItems.some((item) => item.id === input.actionId)) throw new AgentGroupError(404, "行动项不存在");
		this.storage.updateAgentGroupTurn(turn.id, { discussion: { ...turn.discussion!, result: { ...result, actionItems: result.actionItems.map((item) => item.id === input.actionId ? { ...item, status: input.status as "pending" | "in_progress" | "done" | "cancelled" } : item) } } });
		return this.get(groupId, turn.conversationId);
	}

	private async sendModerated(group: AgentGroupRecord, turn: AgentGroupTurnRecord, initialTargets: string[], controller: AbortController, recovering = false): Promise<void> {
		const config = group.collaboration!;
		const members = this.conversationMembers(group.id, turn.conversationId);
		let hostSessionId: string | undefined;
		const recoverySessions = new Map<string, string>();
		let timedOut = false;
		let tokenBudgetExceeded = false;
		let usage: AgentGroupUsage = recovering && turn.discussion?.usage
			? { ...turn.discussion.usage }
			: recovering && (turn.discussion?.calls ?? 0) > 0
				? { tokens: null, costUsd: null, piReportedCostUsd: null }
				: { tokens: 0, costUsd: null, piReportedCostUsd: 0 };
		const remainingMs = Math.max(0, (config.maxDurationMs ?? 600_000) - (recovering ? turn.discussion?.elapsedMs ?? 0 : 0));
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
			const active = this.activeSessions.get(group.id);
			if (active) this.hub.get(active.sessionId)?.stop();
		}, remainingMs);
		let lastTimestamp = Math.max(Date.now(), ...this.storage.listAgentGroupMessages(group.id).map((message) => message.createdAt));
		try {
			const result = await moderateDiscussion({
				config, members, initialTargets, groupName: group.name, userMessage: turn.userMessage, signal: controller.signal,
				...(recovering ? { resume: turn.discussion } : {}), timedOut: () => timedOut, tokenBudgetExceeded: () => tokenBudgetExceeded, usage: () => usage,
				previousSummaries: [
					discussionHistory(this.conversationMessages(group.id, turn.conversationId).filter((message) => message.turnId !== turn.id && message.metadata?.kind === "summary"), 8_000),
					structuredDiscussionContext(this.storage.listAgentGroupTurns(group.id).filter((entry) => entry.id !== turn.id && entry.conversationId === turn.conversationId)),
				].join("\n\n"),
				messages: () => this.storage.listAgentGroupTurnMessages(turn.id),
				persist: (discussion) => { this.storage.updateAgentGroupTurn(turn.id, { discussion }); },
				append: (agentId, content, metadata, isError = false) => {
					this.appendMessage({ id: id("gmsg"), groupId: group.id, turnId: turn.id, role: "agent", agentId, agentName: members.find((member) => member.agentId === agentId)?.agentName ?? "调度器", content, metadata, isError, createdAt: ++lastTimestamp });
				},
				invoke: async (agentId, prompt, host) => {
					const member = members.find((entry) => entry.agentId === agentId)!;
					const agent = this.storage.getAgent(agentId);
					if (!agent || agent.status !== "published") throw new Error(`「${member.agentName}」不可用，无法继续讨论`);
					const sessionId = host ? hostSessionId : recovering ? recoverySessions.get(agentId) : member.sessionId;
					let session = sessionId ? this.hub.get(sessionId) : undefined;
					if (!session) {
						session = this.hub.create("auto-flow", { internalGroupSession: true, ownerId: group.createdBy,
							modelId: agent.modelConfig.chatModelId ?? undefined,
							agent: { id: agent.id, name: agent.name, prompt: agent.agentsMd,
								skillIds: host || recovering ? [] : agent.skillIds, kbIds: host ? [] : agent.kbIds,
								modelConfig: agent.modelConfig, memoryConfig: agent.memoryConfig, advancedConfig: agent.advancedConfig },
						});
						if (host) { hostSessionId = session.id; session.setPermissionMode("readonly"); }
						else if (recovering) { recoverySessions.set(agentId, session.id); session.setPermissionMode("readonly"); }
						else {
							try { this.saveWorker(group.id, turn.conversationId, member.id, member.agentId, session.id); member.sessionId = session.id; }
							catch (error) { this.hub.remove(session.id); throw error; }
						}
					}
					const count = session.transcript.filter((entry) => entry.role === "assistant").length;
					await session.piStats();
					const before = session.piBudgetUsage();
					const priorUsage = { ...usage };
					const refreshUsage = () => {
						usage = addPiUsage(priorUsage, before, session!.piBudgetUsage());
						const current = this.storage.getAgentGroupTurn(turn.id)?.discussion;
						if (current) this.storage.updateAgentGroupTurn(turn.id, { discussion: { ...current, usage } });
					};
					session.setModelRequestGuard(() => {
						if (controller.signal.aborted) throw new Error(timedOut ? "已达讨论时限" : "本轮已停止");
						refreshUsage();
						if (config.maxTokens === undefined) return;
						if (usage.tokens === null) throw new Error("模型未提供可核验的 Pi token usage，已停止后续请求；请取消 token 预算或更换支持 usage 的模型");
						if (usage.tokens >= config.maxTokens) { tokenBudgetExceeded = true; throw new Error("已达 token 预算，后续模型请求已停止"); }
					}, { blockUnmeteredDelegation: config.maxTokens !== undefined });
					this.activeSessions.set(group.id, { sessionId: session.id, agentId, agentName: member.agentName });
					let failure: string | undefined;
					const unsubscribe = session.subscribe((event) => { if (event.type === "error") failure = event.message; });
					try { await session.send(prompt); }
					finally { refreshUsage(); session.setModelRequestGuard(); unsubscribe(); this.activeSessions.delete(group.id); }
					if (failure) throw new Error(failure);
					const reply = session.transcript.filter((entry) => entry.role === "assistant").slice(count).at(-1)?.text?.trim();
					if (!reply) throw new Error("Agent 没有返回可见回复");
					return reply;
				},
			});
			this.storage.updateAgentGroupTurn(turn.id, { discussion: result, status: result.outcome === "cancelled" ? "cancelled" : result.outcome === "failed" || result.outcome === "time_limit" || result.outcome === "token_limit" ? "failed" : "completed", completedAt: Date.now() });
		} finally {
			clearTimeout(timeout);
			// Host deliberation is isolated from the department's business memory; public summaries persist.
			if (hostSessionId) this.hub.remove(hostSessionId);
			for (const sessionId of recoverySessions.values()) this.hub.remove(sessionId);
		}
	}

	/** Stop the active Pi turn and prevent the remaining departments from starting. */
	cancel(groupId: string): boolean {
		this.requireGroup(groupId);
		const controller = this.controllers.get(groupId);
		if (!controller || controller.signal.aborted) return false;
		controller.abort();
		const active = this.activeSessions.get(groupId);
		if (active) this.hub.get(active.sessionId)?.stop();
		return true;
	}

	delete(groupId: string): boolean {
		this.requireGroup(groupId);
		if (this.running.has(groupId)) throw new AgentGroupError(409, "群聊正在运行；先取消并等当前部门结束后再删除");
		const members = this.storage.listAgentGroupMembers(groupId);
		for (const conversation of this.storage.listAgentGroupConversations(groupId)) for (const sessionId of Object.values(conversation.workers)) this.hub.remove(sessionId);
		for (const member of members) if (member.sessionId) this.hub.remove(member.sessionId);
		return this.storage.deleteAgentGroup(groupId);
	}

	private requireGroup(id: string): AgentGroupRecord {
		const group = this.storage.getAgentGroup(id);
		if (!group) throw new AgentGroupError(404, "部门群聊不存在");
		return group;
	}

	private appendMessage(message: AgentGroupMessageRecord): void {
		const latest = this.storage.listAgentGroupMessages(message.groupId).at(-1)?.createdAt ?? 0;
		this.storage.appendAgentGroupMessage({ ...message, createdAt: Math.max(message.createdAt, latest + 1) });
	}

	private conversationIdOf(groupId: string, value: unknown): string | undefined {
		if (value === undefined || value === null || value === groupId) return undefined;
		if (typeof value !== "string" || !value.trim()) throw new AgentGroupError(400, "对话编号格式错误");
		const conversation = this.storage.getAgentGroupConversation(value);
		if (!conversation || conversation.groupId !== groupId) throw new AgentGroupError(404, "找不到这个群内的对话");
		return conversation.id;
	}

	private conversationMembers(groupId: string, conversationId?: string) {
		const members = this.storage.listAgentGroupMembers(groupId);
		if (!conversationId) return members;
		const workers = this.storage.getAgentGroupConversation(conversationId)!.workers;
		return members.map((member) => ({ ...member, sessionId: workers[member.agentId] ?? null }));
	}

	private saveWorker(groupId: string, conversationId: string | undefined, memberId: string, agentId: string, sessionId: string): void {
		if (!conversationId) { this.storage.updateAgentGroupMember(memberId, { sessionId }); return; }
		const conversation = this.storage.getAgentGroupConversation(conversationId);
		if (!conversation || conversation.groupId !== groupId) throw new AgentGroupError(404, "对话已不存在");
		this.storage.updateAgentGroupConversation(conversationId, { workers: { ...conversation.workers, [agentId]: sessionId } });
	}

	private conversationMessages(groupId: string, conversationId?: string) {
		const turns = new Set(this.storage.listAgentGroupTurns(groupId).filter((turn) => turn.conversationId === conversationId).map((turn) => turn.id));
		return this.storage.listAgentGroupMessages(groupId).filter((message) => turns.has(message.turnId));
	}

	private view(group: AgentGroupRecord, conversationId?: string) {
		const allTurns = this.storage.listAgentGroupTurns(group.id);
		const turns = allTurns.filter((turn) => turn.conversationId === conversationId);
		const turnIds = new Set(turns.map((turn) => turn.id));
		const legacyTurns = allTurns.filter((turn) => !turn.conversationId);
		const conversations = [
			{ id: group.id, title: legacyTurns[0]?.userMessage.slice(0, 60) ?? "原对话", createdAt: group.createdAt, updatedAt: legacyTurns.at(-1)?.createdAt ?? group.createdAt },
			...this.storage.listAgentGroupConversations(group.id).map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt })),
		].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
		const runningTurn = allTurns.find((turn) => turn.status === "running");
		const running = this.running.has(group.id) && runningTurn?.conversationId === conversationId;
		const lastTurnId = turns.at(-1)?.id;
		return {
			...group,
			activeConversationId: conversationId ?? group.id,
			conversations,
			members: this.conversationMembers(group.id, conversationId),
			turns: turns.map((turn) => {
				const maxCalls = group.collaboration?.maxCalls ?? 0;
				const maxDurationMs = group.collaboration?.maxDurationMs ?? 600_000;
				const elapsedMs = turn.discussion?.elapsedMs ?? Math.max(0, (turn.completedAt ?? Date.now()) - turn.createdAt);
				const maxTokens = group.collaboration?.maxTokens ?? null;
				const usedTokens = turn.discussion?.usage?.tokens ?? null;
				return {
					...turn,
					budget: { maxCalls, remainingCalls: Math.max(0, maxCalls - (turn.discussion?.calls ?? 0)), maxDurationMs, elapsedMs, remainingMs: Math.max(0, maxDurationMs - elapsedMs), maxTokens, remainingTokens: maxTokens !== null && usedTokens !== null ? Math.max(0, maxTokens - usedTokens) : null },
					canResume: Boolean(group.collaboration && turn.id === lastTurnId && !this.running.has(group.id) && (turn.status === "failed" || turn.status === "cancelled") && turn.discussion?.checkpoint && turn.discussion.calls < maxCalls && elapsedMs < maxDurationMs && (maxTokens === null || (usedTokens !== null && usedTokens < maxTokens))),
				};
			}),
			messages: this.storage.listAgentGroupMessages(group.id).filter((message) => turnIds.has(message.turnId)),
			groupRunning: this.running.has(group.id),
			running,
			activeAgentId: running ? this.activeSessions.get(group.id)?.agentId ?? null : null,
			activeAgentName: running ? this.activeSessions.get(group.id)?.agentName ?? null : null,
		};
	}
}
