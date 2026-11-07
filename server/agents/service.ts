/**
 * Agent 服务：六维配置的增删改 + 状态机。
 *
 * 状态机语义严格对齐 AgentOne（见 AgentOne/docs/technical/02-agent-engine.md §2），
 * 别自己发明额外状态：
 *
 *   draft ──▶ testing ──▶ published ──▶ stopped
 *     ▲          │            │            │
 *     └──────────┴── revert ──┴────────────┘
 *
 * 两条硬规则：
 *  1. 只有 draft / testing / published 可以对话，stopped 一律拒绝；
 *  2. published 不可直接改配置，必须先 revert 回草稿——否则"已上线的 Agent 被悄悄改坏"无从追溯。
 */

import { randomUUID } from "node:crypto";
import type { Storage } from "../db/types.js";
import type { AgentAction, AgentPatch, AgentRecord, AgentStatus } from "../db/types.js";

/** 状态机的合法迁移表：当前态 → 允许的动作 → 目标态 */
const TRANSITIONS: Record<AgentStatus, Partial<Record<AgentAction, AgentStatus>>> = {
	draft: { test: "testing", publish: "published" },
	testing: { publish: "published", revert: "draft" },
	published: { stop: "stopped", revert: "draft" },
	stopped: { revert: "draft" },
};

/** 可以对话的状态：stopped 明确拒绝（对应 AgentOne 的错误码 3003） */
const CHATTABLE: AgentStatus[] = ["draft", "testing", "published"];

export type AgentFailureCode =
	/** 3002：已发布不可直接编辑 */
	| "published_locked"
	/** 3003：stopped 不可对话 */
	| "stopped_not_chattable"
	/** 状态机不允许这次动作 */
	| "illegal_transition";

/** Agent 领域错误：路由层按 status 映射状态码，别在 routes 里 if 一堆字符串 */
export class AgentError extends Error {
	readonly status: number;
	readonly code?: AgentFailureCode;

	constructor(message: string, status: number, code?: AgentFailureCode) {
		super(message);
		this.name = "AgentError";
		this.status = status;
		this.code = code;
	}
}

export interface AgentServiceOptions {
	storage: Storage;
	/** 注入时间与 id，自检可以替换成确定性实现 */
	now?: () => number;
	idFactory?: () => string;
}

const NAME_MAX = 60;
const DESCRIPTION_MAX = 500;
const AGENTS_MD_MAX = 20000;

export class AgentService {
	private readonly storage: Storage;
	private readonly now: () => number;
	private readonly idFactory: () => string;

	constructor(options: AgentServiceOptions) {
		this.storage = options.storage;
		this.now = options.now ?? (() => Date.now());
		this.idFactory = options.idFactory ?? (() => `agent_${randomUUID().replace(/-/g, "").slice(0, 12)}`);
	}

	list(): AgentRecord[] {
		return this.storage.listAgents();
	}

	get(id: string): AgentRecord {
		const record = this.storage.getAgent(id);
		if (!record) throw new AgentError("Agent 不存在", 404);
		return record;
	}

	create(input: {
		name: string;
		description?: string;
		category?: string;
		icon?: string;
		agentsMd?: string;
		modelConfig?: AgentRecord["modelConfig"];
		memoryConfig?: AgentRecord["memoryConfig"];
		advancedConfig?: AgentRecord["advancedConfig"];
		skillIds?: string[];
		kbIds?: string[];
		createdBy?: string | null;
	}): AgentRecord {
		const name = normalizeName(input.name);
		if (name.length === 0) throw new AgentError("请填写 Agent 名称", 400);
		if (name.length > NAME_MAX) throw new AgentError(`Agent 名称不能超过 ${NAME_MAX} 个字`, 400);
		const description = (input.description ?? "").trim();
		if (description.length > DESCRIPTION_MAX) {
			throw new AgentError(`简介不能超过 ${DESCRIPTION_MAX} 个字`, 400);
		}
		const agentsMd = input.agentsMd ?? "";
		if (agentsMd.length > AGENTS_MD_MAX) {
			throw new AgentError(`人格与指令不能超过 ${AGENTS_MD_MAX} 个字`, 400);
		}
		const at = this.now();
		return this.storage.createAgent({
			id: this.idFactory(),
			name,
			description,
			category: (input.category ?? "").trim(),
			icon: (input.icon ?? "").trim(),
			agentsMd,
			modelConfig: sanitizeModelConfig(input.modelConfig),
			memoryConfig: sanitizeMemoryConfig(input.memoryConfig),
			advancedConfig: sanitizeAdvancedConfig(input.advancedConfig),
			skillIds: dedupe(input.skillIds),
			kbIds: dedupe(input.kbIds),
			// 新建一律从草稿起步：不允许直接创建出"已发布"的 Agent
			status: "draft",
			createdBy: input.createdBy ?? null,
			createdAt: at,
			updatedAt: at,
			statusChangedAt: at,
		});
	}

	/**
	 * 更新配置。published 态直接拒绝——先 revert 再改，
	 * 这样"线上 Agent 被改动"这件事永远不会静默发生。
	 */
	update(id: string, patch: AgentPatch): AgentRecord {
		const current = this.get(id);
		if (current.status === "published") {
			throw new AgentError("已发布的 Agent 不能直接修改，请先召回为草稿", 409, "published_locked");
		}
		const next: AgentPatch = { ...patch, updatedAt: this.now() };
		if (patch.name !== undefined) {
			const name = normalizeName(patch.name);
			if (name.length === 0) throw new AgentError("请填写 Agent 名称", 400);
			if (name.length > NAME_MAX) throw new AgentError(`Agent 名称不能超过 ${NAME_MAX} 个字`, 400);
			next.name = name;
		}
		if (patch.description !== undefined && patch.description.length > DESCRIPTION_MAX) {
			throw new AgentError(`简介不能超过 ${DESCRIPTION_MAX} 个字`, 400);
		}
		if (patch.agentsMd !== undefined && patch.agentsMd.length > AGENTS_MD_MAX) {
			throw new AgentError(`人格与指令不能超过 ${AGENTS_MD_MAX} 个字`, 400);
		}
		if (patch.modelConfig !== undefined) next.modelConfig = sanitizeModelConfig(patch.modelConfig);
		if (patch.memoryConfig !== undefined) next.memoryConfig = sanitizeMemoryConfig(patch.memoryConfig);
		if (patch.advancedConfig !== undefined) next.advancedConfig = sanitizeAdvancedConfig(patch.advancedConfig);
		if (patch.skillIds !== undefined) next.skillIds = dedupe(patch.skillIds);
		if (patch.kbIds !== undefined) next.kbIds = dedupe(patch.kbIds);
		return this.storage.updateAgent(id, next)!;
	}

	/** 执行一次状态机动作（试运行 / 发布 / 停用 / 召回） */
	applyAction(id: string, action: AgentAction): AgentRecord {
		const current = this.get(id);
		const target = TRANSITIONS[current.status][action];
		if (!target) {
			throw new AgentError(
				`${statusLabel(current.status)}的 Agent 不能执行「${actionLabel(action)}」`,
				409,
				"illegal_transition",
			);
		}
		return this.storage.setAgentStatus(id, target, this.now())!;
	}

	remove(id: string): void {
		this.get(id);
		this.storage.removeAgent(id);
	}

	/**
	 * 对话前的校验：只有 draft / testing / published 能聊。
	 * stopped 拒绝是 AgentOne 的既有语义（3003），别为了"顺手"放开。
	 */
	assertChattable(id: string): AgentRecord {
		const record = this.get(id);
		if (!CHATTABLE.includes(record.status)) {
			throw new AgentError("该 Agent 已停用，无法对话", 409, "stopped_not_chattable");
		}
		return record;
	}
}

function normalizeName(value: string): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

/** 技能/知识库 id 去重，顺便挡掉非字符串（前端传脏数据不该写进库） */
function dedupe(values?: unknown): string[] {
	if (!Array.isArray(values)) return [];
	return [...new Set(values.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

function clampNumber(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** 模型参数收窄到合法区间：越界值直接钳掉，比报错更贴合"调参"的使用方式 */
function sanitizeModelConfig(input: AgentRecord["modelConfig"] | undefined): AgentRecord["modelConfig"] {
	if (!input) return {};
	const result: AgentRecord["modelConfig"] = {};
	if (typeof input.chatModelId === "string" && input.chatModelId.length > 0) result.chatModelId = input.chatModelId;
	if (typeof input.temperature === "number" && Number.isFinite(input.temperature)) {
		result.temperature = clampNumber(input.temperature, 0, 2);
	}
	if (typeof input.topP === "number" && Number.isFinite(input.topP)) {
		result.topP = clampNumber(input.topP, 0, 1);
	}
	if (typeof input.maxTokens === "number" && Number.isFinite(input.maxTokens)) {
		result.maxTokens = Math.round(clampNumber(input.maxTokens, 1, 128000));
	}
	if (typeof input.stream === "boolean") result.stream = input.stream;
	return result;
}

function sanitizeAdvancedConfig(input: AgentRecord["advancedConfig"] | undefined): AgentRecord["advancedConfig"] {
	const result = { ...input };
	delete result.maxIters;
	delete result.showThinking;
	if (typeof input?.maxIters === "number" && Number.isFinite(input.maxIters)) {
		result.maxIters = Math.round(clampNumber(input.maxIters, 1, 100));
	}
	if (typeof input?.showThinking === "boolean") result.showThinking = input.showThinking;
	return result;
}

function sanitizeMemoryConfig(input: AgentRecord["memoryConfig"] | undefined): AgentRecord["memoryConfig"] {
	if (!input) return {};
	const result: AgentRecord["memoryConfig"] = {};
	if (typeof input.shortTermRounds === "number" && Number.isFinite(input.shortTermRounds)) {
		result.shortTermRounds = Math.round(clampNumber(input.shortTermRounds, 1, 100));
	}
	if (input.overflowStrategy === "sliding_window" || input.overflowStrategy === "summarize") {
		result.overflowStrategy = input.overflowStrategy;
	}
	return result;
}

export function statusLabel(status: AgentStatus): string {
	switch (status) {
		case "draft":
			return "草稿";
		case "testing":
			return "试运行";
		case "published":
			return "已发布";
		case "stopped":
			return "已停用";
	}
}

function actionLabel(action: AgentAction): string {
	switch (action) {
		case "test":
			return "试运行";
		case "publish":
			return "发布";
		case "stop":
			return "停用";
		case "revert":
			return "召回草稿";
	}
}
