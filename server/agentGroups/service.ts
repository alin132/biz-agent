import { randomUUID } from "node:crypto";
import type { Storage, AgentGroupRecord, AgentGroupTurnRecord, AgentGroupMessageRecord } from "../db/types.js";
import type { SessionHub } from "../session.js";

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
				storage.updateAgentGroupTurn(turn.id, { status: "failed", completedAt: now });
				const turnMessages = storage.listAgentGroupTurnMessages(turn.id);
				const repliedAgentIds = new Set(turnMessages.filter((message) => message.role === "agent" && !message.isError).map((message) => message.agentId));
				const recordedAgentIds = new Set(turnMessages.filter((message) => message.role === "agent").map((message) => message.agentId));
				for (const member of storage.listAgentGroupMembers(group.id)) {
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

	get(groupId: string) {
		const group = this.requireGroup(groupId);
		return this.view(group);
	}

	create(input: { name: unknown; agentIds: unknown; createdBy: string | null }) {
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
		const now = Date.now();
		const group = this.storage.createAgentGroup({ id: id("group"), name, createdBy: input.createdBy, createdAt: now, updatedAt: now });
		agents.forEach((agent, position) => this.storage.addAgentGroupMember({
			id: id("member"), groupId: group.id, agentId: agent.id, agentName: agent.name, position, sessionId: null, addedAt: now,
		}));
		return this.view(group);
	}

	async send(groupId: string, value: unknown) {
		const group = this.requireGroup(groupId);
		const userMessage = typeof value === "string" ? value.trim() : "";
		if (!userMessage) throw new AgentGroupError(400, "请填写群聊消息");
		if (userMessage.length > MAX_MESSAGE_LENGTH) throw new AgentGroupError(400, `消息不能超过 ${MAX_MESSAGE_LENGTH} 个字`);
		if (this.running.has(groupId) || this.storage.listAgentGroupTurns(groupId).some((entry) => entry.status === "running")) {
			throw new AgentGroupError(409, "这个部门群聊正在处理上一轮");
		}
		const members = this.storage.listAgentGroupMembers(groupId);
		if (members.length < 2) throw new AgentGroupError(409, "群组成员不足，至少需要两个部门 Agent");
		this.running.add(groupId);
		const controller = new AbortController();
		this.controllers.set(groupId, controller);
		let turn: AgentGroupTurnRecord | undefined;
		let failed = false;
		const repliedAgentIds = new Set<string>();
		try {
			const sequence = Math.max(0, ...this.storage.listAgentGroupTurns(groupId).map((entry) => entry.sequence)) + 1;
			turn = { id: id("turn"), groupId, sequence, userMessage, status: "running", createdAt: Date.now(), completedAt: null };
			this.storage.updateAgentGroup(groupId, { updatedAt: turn.createdAt });
			try {
				this.storage.createAgentGroupTurn(turn);
			} catch (error) {
				if (isRunningTurnConflict(error)) throw new AgentGroupError(409, "这个部门群聊正在处理上一轮");
				throw error;
			}
			this.appendMessage({ id: id("gmsg"), groupId, turnId: turn.id, role: "user", agentId: null, agentName: null, content: userMessage, isError: false, createdAt: Date.now() });
			const priorReplies: AgentGroupReplyContext[] = [];
			const priorMessages = this.storage.listAgentGroupMessages(groupId);
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
							this.storage.updateAgentGroupMember(member.id, { sessionId: session.id });
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
		} catch (error) {
			if (turn) this.storage.updateAgentGroupTurn(turn.id, { status: "failed", completedAt: Date.now() });
			throw error;
		} finally {
			this.running.delete(groupId);
			this.controllers.delete(groupId);
		}
		return this.get(groupId);
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
		for (const member of members) if (member.sessionId) this.hub.remove(member.sessionId);
		return this.storage.deleteAgentGroup(groupId);
	}

	private requireGroup(id: string): AgentGroupRecord {
		const group = this.storage.getAgentGroup(id);
		if (!group) throw new AgentGroupError(404, "部门群聊不存在");
		return group;
	}

	private appendMessage(message: AgentGroupMessageRecord): void {
		this.storage.appendAgentGroupMessage(message);
	}

	private view(group: AgentGroupRecord) {
		return {
			...group,
			members: this.storage.listAgentGroupMembers(group.id),
			turns: this.storage.listAgentGroupTurns(group.id),
			messages: this.storage.listAgentGroupMessages(group.id),
			running: this.running.has(group.id),
			activeAgentId: this.activeSessions.get(group.id)?.agentId ?? null,
			activeAgentName: this.activeSessions.get(group.id)?.agentName ?? null,
		};
	}
}
