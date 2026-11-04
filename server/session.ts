/**
 * 会话层：把一次"人机对话"包成可被 HTTP 订阅的对象，并落 SQLite。
 *
 * 持久化内容：对话文本、审计流水、流程进度、业务数据、以及 Pi 的 AgentMessage 上下文。
 * 所以服务重启后既能看到历史，也能接着聊（模型不会忘记前文）。
 */

import { randomUUID } from "node:crypto";
import type { Agent, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { flowToolDescription, flowToolName, flowToolParameters } from "../src/core/flowTools.js";
import { ToolRegistry } from "../src/core/registry.js";
import { createBusinessAgent } from "../src/core/runtime.js";
import type { BusinessAgent } from "../src/core/runtime.js";
import { findSkill, SKILL_TOOL_NAME, skillToolDescription, skillToolParameters } from "../src/core/skill.js";
import type { SkillDef } from "../src/core/skill.js";
import { lastAssistantTextOf, runSubWorkflow } from "../src/core/subFlow.js";
import type { AuditEntry, ApprovalRequest, BizContext, ToolDef, WorkflowDef } from "../src/core/types.js";
import { WorkflowEngine } from "../src/core/workflow.js";
import { createStore } from "../src/store/memory.js";
import type { Store } from "../src/store/memory.js";
import type { PersistedSession, Storage, TranscriptEntry } from "./db/index.js";
import { createSimulatedRuntime } from "./demoScripts.js";
import { KB_SEARCH_TOOL_NAME, createKbSearchTool } from "./kb/tool.js";
import { resolveLlm } from "./llm.js";
import type { LlmRuntime } from "./llm.js";
import { isMcpToolName } from "./mcp/names.js";
import { estimateTokens, summarizeArgs } from "./observability/trace.js";
import type { Observability } from "./observability/collector.js";
import type { WorkflowRepo } from "./workflows.js";

export type PermissionMode = "full" | "readonly";

/**
 * 会话构造时的模型解析注入点（P6 多模型管理用）。
 *
 * 返回值三态：
 * - `LlmRuntime`：用这个真实模型；
 * - `undefined`：库里没有这个模型，交回 `resolveLlm()` 按 .env 处理（保持旧行为）；
 * - `null`：明确不连真实模型（模型/供应商停用、密文解不开），回落到模拟模型。
 */
export type SessionModelResolver = (modelId?: string) => LlmRuntime | null | undefined;

/** 前端消费的事件协议。 */
export type WireEvent =
	| { type: "ready"; session: SessionView }
	| { type: "text"; delta: string }
	| { type: "tool_start"; id: string; name: string; args: unknown }
	| { type: "tool_end"; id: string; name: string; ok: boolean; result: string; durationMs?: number }
	| { type: "audit"; entry: AuditEntry }
	| { type: "approval"; requestId: string; toolName: string; args: unknown; risk: string }
	| { type: "workflow"; steps: StepView[]; current: number; done: boolean }
	| { type: "skill"; skillId: string | null; name: string; description: string }
	| { type: "done"; text: string; traceId?: string }
	| { type: "error"; message: string; traceId?: string }
	| { type: "busy"; running: boolean };

export interface StepView {
	id: string;
	title: string;
	status: "done" | "active" | "pending";
}

/** 技能列表项：控制台用它展示"这个会话能加载哪些技能"。 */
export interface SkillView {
	id: string;
	name: string;
	/** 一句话触发条件（和系统提示里的技能目录同一句） */
	description: string;
	/** 是否当前加载中 */
	active: boolean;
	builtin: boolean;
	/** 技能内部步骤数：0 表示不预设步骤（自动编排那种） */
	steps: number;
}

export interface SessionView {
	id: string;
	workflowId: string;
	workflowName: string;
	mode: "simulated" | "live";
	/** 模型展示名，例如 "DeepSeek · deepseek-v4-pro" */
	modeLabel: string;
	modelId: string | null;
	permissionMode: PermissionMode;
	/** 用户自定义标题；null 表示用首条消息自动派生 */
	title: string | null;
	/** 已归档：默认不占侧栏位置，但还能打开继续聊 */
	archived: boolean;
	running: boolean;
	steps: StepView[];
	current: number;
	done: boolean;
	/** 本次会话注册给模型的全部工具名（含 flow_xxx 与 use_skill）。 */
	tools: string[];
	/** 可加载的技能目录（内置流程 + 自定义流程，都能当技能用） */
	skills: SkillView[];
	/** 当前加载的技能 id；null = 跑会话自己的流程 */
	activeSkillId: string | null;
	/** 最近 20 条调用链 id（倒序，最新的在前）；每轮用户消息一条 */
	traceIds: string[];
	createdAt: number;
	updatedAt: number;
	audit: AuditEntry[];
	transcript: TranscriptEntry[];
	/** 是否从 SQLite 恢复的历史会话 */
	restored: boolean;
}

/**
 * 一条挂起中的审批（会话视角）。
 *
 * 审批是同步语义：工具调用在原地等 `resolveApproval()`，所以这份列表只反映
 * 「此刻真的卡在等待里」的请求，不落库、重启即消失。
 */
export interface PendingApprovalView {
	requestId: string;
	toolName: string;
	risk: string;
	args: Record<string, unknown>;
	/** 请求发出的时间戳（毫秒），列表按它升序 */
	askedAt: number;
}

/** 全局待办里的一条：会话视角的审批 + 它在哪个会话上（审批中心按此跳转）。 */
export interface GlobalApprovalView extends PendingApprovalView {
	sessionId: string;
	/** 自定义标题；null 表示前端按首条消息派生 */
	sessionTitle: string | null;
	workflowId: string;
	workflowName: string;
	/** 会话是否已归档（只标注、不过滤：挂起的审批不因为归档就消失，批完它才继续） */
	archived: boolean;
}

/** 自定义标题的最大长度；前端输入框与后端截断用同一个上限。 */
export const TITLE_MAX_LENGTH = 80;

/** SessionView.traceIds 保留的条数（最近 N 条，倒序）。 */
export const TRACE_HISTORY_LIMIT = 20;

/** 从助手消息里拼出可估算 token 的文本（text / thinking 块）。 */
function assistantTextOf(message: unknown): string {
	if (!message || typeof message !== "object") {
		return "";
	}
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return "";
	}
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") {
			continue;
		}
		const typed = block as { type?: string; text?: unknown };
		if ((typed.type === "text" || typed.type === "thinking") && typeof typed.text === "string") {
			parts.push(typed.text);
		}
	}
	return parts.join("");
}

/**
 * 规范化用户输入的会话标题：控制字符转空格、折叠连续空白、截断超长。
 * 规范化后为空返回 null —— 表示清除自定义标题，前端恢复「用首条消息派生」。
 */
export function normalizeTitle(input: string): string | null {
	const flat = input
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (flat.length === 0) {
		return null;
	}
	return flat.length > TITLE_MAX_LENGTH ? flat.slice(0, TITLE_MAX_LENGTH) : flat;
}

/** 按流程定义装配工具。流程自带 `createTools`，所以这里没有针对某个流程的 case。 */
function createRegistry(workflow: WorkflowDef, store: Store): ToolRegistry {
	return new ToolRegistry().registerAll(workflow.createTools(store));
}

/** 从工具结果里抽出给前端展示的文本。 */
function toolResultText(result: unknown): string {
	if (!result || typeof result !== "object") {
		return String(result ?? "");
	}
	const content = (result as { content?: { type: string; text?: string }[] }).content;
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

function stepsFor(workflow: WorkflowDef, current: number): StepView[] {
	return workflow.steps.map((step, index) => ({
		id: step.id,
		title: step.title,
		status: index < current ? "done" : index === current ? "active" : "pending",
	}));
}

/** 用数据库记录拼一个只读视图（不创建 agent）。 */
function viewFromRecord(record: PersistedSession, repo: WorkflowRepo): SessionView | null {
	const workflow = repo.get(record.workflowId);
	if (!workflow) {
		return null;
	}
	const activeSkillId = record.activeSkillId ?? null;
	const skill = activeSkillId ? repo.skill(activeSkillId) : undefined;
	// 加载技能时会话的步骤条显示的是技能的步骤
	const stepsOf = skill?.workflow ?? workflow;
	const current = record.workflow?.stepIndex ?? 0;
	return {
		id: record.id,
		workflowId: record.workflowId,
		workflowName: workflow.name,
		mode: record.mode,
		modeLabel: record.modeLabel,
		modelId: record.modelId,
		permissionMode: record.permissionMode,
		title: record.title ?? null,
		archived: record.archived ?? false,
		running: false,
		steps: stepsFor(stepsOf, current),
		current,
		done: record.done,
		tools: toolNamesFor(workflow, repo, skill),
		skills: skillViewsFor(repo, activeSkillId),
		activeSkillId,
		traceIds: [...(record.traceIds ?? [])],
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		audit: record.audit ?? [],
		transcript: record.transcript ?? [],
		restored: true,
	};
}

/**
 * MCP 工具（P7）：由 MCP 注册表在运行期发现，走平台工具目录暴露。
 *
 * 为什么这里还要显式并一次：`repo.toolNames()` 只有「自动编排」这类"手上是整个目录"的会话会全量装；
 * 普通流程会话的初始工具集是步骤 via 的工具。MCP 工具是跨流程的通用能力，必须对每个会话可见
 * （技能加载后也要保留），否则注册完 MCP 服务只有自动编排能用。
 */
function mcpToolNamesFor(repo: WorkflowRepo): string[] {
	return repo.toolNames().filter(isMcpToolName);
}

/** 换技能后仍然保留的工具：技能加载器 + 知识库检索 + 其他流程的 flow_xxx + MCP 工具。 */
function keepToolNamesFor(workflow: WorkflowDef, repo: WorkflowRepo): string[] {
	const flowTools = repo
		.all()
		.filter((target) => target.id !== workflow.id)
		.map((target) => flowToolName(target.id));
	return [SKILL_TOOL_NAME, KB_SEARCH_TOOL_NAME, ...flowTools, ...mcpToolNamesFor(repo)];
}

/** 当前会话装给模型的工具名：流程/技能自己的能力工具 + 流程工具 + 技能加载器 + MCP 工具。 */
function toolNamesFor(workflow: WorkflowDef, repo: WorkflowRepo, skill?: SkillDef): string[] {
	// 技能没声明工具（自动编排那种）= 手上是整个工具目录
	const base =
		skill && skill.tools.length > 0
			? skill.tools
			: workflow.steps.length === 0
				? repo.toolNames()
				: [...new Set(workflow.steps.flatMap((step) => step.via))];
	return [...new Set([...base, ...mcpToolNamesFor(repo), ...keepToolNamesFor(workflow, repo)])];
}

/** 技能目录视图；`active` 标记当前加载中的那条。 */
function skillViewsFor(repo: WorkflowRepo, activeSkillId: string | null): SkillView[] {
	return repo.skills().map((skill) => ({
		id: skill.id,
		name: skill.name,
		description: skill.description,
		active: skill.id === activeSkillId,
		builtin: repo.isBuiltin(skill.id),
		steps: skill.steps.length,
	}));
}

export class Session {
	readonly id: string;
	readonly workflow: WorkflowDef;
	readonly store: Store;
	readonly engine: WorkflowEngine;
	readonly mode: "simulated" | "live";
	readonly modeLabel: string;
	readonly modelId: string | null;
	readonly createdAt: number;
	readonly restored: boolean;
	readonly auditLog: AuditEntry[] = [];
	readonly transcript: TranscriptEntry[] = [];

	private readonly db: Storage;
	private readonly repo: WorkflowRepo;
	private readonly agent: Agent;
	/** 运行时装配结果（技能加载 / 退出要改它的工具集与状态机） */
	private built!: BusinessAgent;
	private readonly ctx: BizContext;
	private readonly registry: ToolRegistry;
	/** 当前暴露给模型的工具名；加载/退出技能会整体更换 */
	private toolNames: string[];
	/** 可加载的技能目录（内置 + 自定义流程，构造时快照，`refreshSkills()` 可就地刷新） */
	readonly skills: SkillDef[];
	/** `use_skill` 的工具定义：刷新目录时要原地改它的参数枚举（AgentTool 持有同一个 parameters 对象） */
	private readonly skillTool: ToolDef;
	/** 当前加载的技能 id；null = 跑会话自己的流程 */
	private activeSkillId: string | null = null;
	private permissionMode: PermissionMode = "full";
	private title: string | null = null;
	private archived = false;
	private readonly subscribers = new Set<(event: WireEvent) => void>();
	private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
	private approvalSeq = 0;
	private running = false;
	private updatedAt: number;
	/** P9 调用链采集器：不传时行为与 P9 之前完全一致（终端 demo / 单元测试） */
	private readonly obs?: Observability;
	/** 建会话的用户 id（监控按角色收窄 developer 可见的调用链） */
	private readonly createdBy: string | null;
	/** 当前这一轮的 trace_id；null = 没有在跑的轮次 */
	private currentTraceId: string | null = null;
	/** 最近 20 条 trace_id（倒序，最新的在前） */
	private readonly traceIds: string[] = [];
	/** 工具调用参数摘要：tool_execution_end 不带 args，按 toolCallId 记下开始时的参数 */
	private readonly toolArgs = new Map<string, unknown>();
	/**
	 * 审批元数据：审批完成时补一条 resolved 事件（含等待毫秒），
	 * 同时给「审批中心」提供挂起中的待办（toolName / risk / args / askedAt）。
	 * 生命周期与 `pendingApprovals` 一致：解析时删除，所以不会留下"幽灵待办"。
	 */
	private readonly approvalMeta = new Map<string, PendingApprovalView>();

	constructor(
		workflow: WorkflowDef,
		options: {
			db: Storage;
			repo: WorkflowRepo;
			modelId?: string;
			restore?: PersistedSession;
			resolveModel?: SessionModelResolver;
			/** P9：调用链采集器（可选） */
			observability?: Observability;
			/** P9：建会话的用户 id（落进 payload，监控据此收窄权限） */
			ownerId?: string | null;
		},
	) {
		this.db = options.db;
		this.workflow = workflow;
		this.obs = options.observability;
		const restored = options.restore;
		this.createdBy = restored?.createdBy ?? options.ownerId ?? null;
		if (restored?.traceIds) {
			this.traceIds.push(...restored.traceIds.slice(0, 20));
		}

		this.id = restored?.id ?? randomUUID().slice(0, 8);
		this.createdAt = restored?.createdAt ?? Date.now();
		this.updatedAt = restored?.updatedAt ?? this.createdAt;
		this.restored = Boolean(restored);

		this.store = restored?.store ?? createStore();
		this.engine = new WorkflowEngine(workflow, restored?.workflow);
		this.repo = options.repo;
		this.registry = createRegistry(workflow, this.store);
		// 技能要能整换上"别的业务的工具"，所以工具目录全部先进注册表（只按需暴露，见 toolNamesFor）
		for (const tool of options.repo.allTools(this.store)) {
			if (!this.registry.has(tool.name)) {
				this.registry.registerAll([tool]);
			}
		}
		this.skills = options.repo.skills();
		this.skillTool = this.buildSkillTool();
		this.registry.registerAll([this.skillTool]);
		// 知识库检索是会话级能力（不进业务工具目录，所以没有 example 演示脚本）：
		// 技能 id 在调用那一刻才取——没加载技能时会话自己的流程就是当前技能，切技能后自动跟着走
		this.registry.registerAll([
			createKbSearchTool({ getActiveSkillId: () => this.activeSkillId ?? this.workflow.id }),
		]);

		// 历史会话只在原本就是真实模型时才尝试复用真实模型，避免历史配置漂移
		const allowLive = restored ? restored.mode === "live" : true;
		const preferredModelId = restored?.modelId ?? options.modelId ?? undefined;
		// 多模型管理（P6）：库里有当前模型就用它；`undefined` 表示库里不认识，按 .env 旧逻辑解析
		const injected = allowLive ? options.resolveModel?.(preferredModelId) : undefined;
		const live = allowLive ? (injected === undefined ? resolveLlm(preferredModelId) : injected) : null;
		// 模拟模型需要工具定义里的 example 参数才能把流程"演"完
		const runtime = live ?? createSimulatedRuntime(workflow, this.engine, this.registry);

		this.mode = live ? "live" : "simulated";
		this.modeLabel = live?.label ?? "模拟模型";
		this.modelId = live?.modelId ?? null;

		// 流程即工具：把其他流程也装成工具，由模型自己挑；不装自己，天然不递归
		const flowTools = this.buildFlowTools(options.repo, runtime);
		this.registry.registerAll(flowTools);
		// 暴露给模型的工具 = 本流程/技能的步骤工具 + flow_xxx + use_skill（不是注册表里全部）
		this.toolNames = toolNamesFor(workflow, options.repo);

		if (restored) {
			this.permissionMode = restored.permissionMode ?? "full";
			this.title = restored.title ?? null;
			this.archived = restored.archived ?? false;
			this.auditLog.push(...(restored.audit ?? []));
			this.transcript.push(...(restored.transcript ?? []));
		}

		const ctx: BizContext = {
			tenantId: "tenant-demo",
			userId: "u-001",
			traceId: `trace-${this.id}`,
			allow: ["*"],
			requireApproval: [],
			audit: (entry) => {
				this.auditLog.push(entry);
				this.emit({ type: "audit", entry });
			},
			requestApproval: (request) => this.awaitApproval(request),
		};
		this.ctx = ctx;
		this.applyPermissionMode(this.permissionMode);

		const built = createBusinessAgent({
			workflow,
			registry: this.registry,
			ctx,
			model: runtime.model,
			streamFn: runtime.streamFn,
			engine: this.engine,
			maxTurns: 12,
			messages: restored?.agentMessages as AgentMessage[] | undefined,
			toolNames: this.toolNames,
			skills: this.skills,
			keepToolNames: keepToolNamesFor(workflow, options.repo),
		});
		this.agent = built.agent;
		this.built = built;

		// 恢复上次加载的技能：技能进度也存在 payload 里（workflow 字段就是当时的状态机）
		if (restored?.activeSkillId) {
			const skill = findSkill(this.skills, restored.activeSkillId);
			if (skill) {
				this.built.activateSkill(skill.id);
				this.engine.reset(skill.workflow, restored.workflow);
				this.activeSkillId = skill.id;
				this.toolNames = this.built.toolNames();
				this.applyPermissionMode(this.permissionMode);
			}
		}

		if (!restored) {
			this.persist();
		}

		this.agent.subscribe((event) => {
			switch (event.type) {
				case "message_update":
					if (event.assistantMessageEvent.type === "text_delta") {
						this.emit({ type: "text", delta: event.assistantMessageEvent.delta });
					}
					break;
				case "message_end":
					// 每轮 LLM 调用结束：模型名 + token（真实 usage 优先，否则按内容估算）+ 耗时
					this.recordLlmEvent(event.message);
					break;
				case "tool_execution_start":
					this.toolArgs.set(event.toolCallId, event.args);
					this.emit({ type: "tool_start", id: event.toolCallId, name: event.toolName, args: event.args });
					break;
				case "tool_execution_end":
					this.recordToolEvent(event.toolCallId, event.toolName, !event.isError, event.durationMs);
					this.emit({
						type: "tool_end",
						id: event.toolCallId,
						name: event.toolName,
						ok: !event.isError,
						result: toolResultText(event.result),
						durationMs: event.durationMs,
					});
					this.emitWorkflow();
					break;
				default:
					break;
			}
		});
	}

	subscribe(listener: (event: WireEvent) => void): () => void {
		this.subscribers.add(listener);
		return () => {
			this.subscribers.delete(listener);
		};
	}

	private emit(event: WireEvent): void {
		for (const listener of this.subscribers) {
			listener(event);
		}
	}

	private emitWorkflow(): void {
		this.emit({ type: "workflow", ...this.workflowView() });
	}

	private workflowView(): { steps: StepView[]; current: number; done: boolean } {
		const current = this.engine.state.stepIndex;
		// 加载技能后状态机换成了技能那条流程，步骤条要跟着换
		return { steps: stepsFor(this.engine.definition, current), current, done: this.engine.done };
	}

	/** 从后往前找最后一条助手文本；子 agent 取结果也用它。 */
	private lastAssistantText(): string {
		return lastAssistantTextOf(this.agent);
	}
	private lastAssistantMessage(): { stopReason?: string; errorMessage?: string } | undefined {
		const messages = this.agent.state.messages;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]!;
			if (message.role === "assistant") {
				return message as { stopReason?: string; errorMessage?: string };
			}
		}
		return undefined;
	}

	/**
	 * LLM 事件：模型名 + 估算 token + 耗时。
	 *
	 * 真实模型通常带 usage（含 input/output/totalTokens），模拟模型的 usage 是 0，
	 * 这时按回复文本估算 —— 监控要的是趋势，不是计费。
	 */
	private recordLlmEvent(message: unknown): void {
		const traceId = this.currentTraceId;
		if (!this.obs || !traceId || !message || typeof message !== "object") {
			return;
		}
		const typed = message as {
			role?: string;
			model?: string;
			provider?: string;
			stopReason?: string;
			durationMs?: number;
			usage?: { input?: number; output?: number; totalTokens?: number };
		};
		if (typed.role !== "assistant") {
			return;
		}
		const text = assistantTextOf(message);
		const usageTotal = Number(typed.usage?.totalTokens ?? 0);
		const estimated = !Number.isFinite(usageTotal) || usageTotal <= 0;
		const totalTokens = estimated ? estimateTokens(text) : usageTotal;
		const inputTokens = estimated ? totalTokens : Number(typed.usage?.input ?? 0);
		const outputTokens = estimated ? 0 : Number(typed.usage?.output ?? 0);
		this.obs.record(traceId, {
			kind: "llm",
			name: typed.model ?? this.modelId ?? this.modeLabel,
			ms: Number(typed.durationMs ?? 0),
			ok: typed.stopReason !== "error" && typed.stopReason !== "aborted",
			payload: {
				model: typed.model ?? this.modelId ?? this.modeLabel,
				provider: typed.provider ?? this.mode,
				stopReason: typed.stopReason ?? null,
				inputTokens,
				outputTokens,
				totalTokens,
				estimated,
			},
		});
	}

	/** 工具事件：工具名 + ok + 耗时 + 参数摘要（≤200 字）；MCP 工具再补一条 mcp 事件。 */
	private recordToolEvent(toolCallId: string, toolName: string, ok: boolean, durationMs?: number): void {
		const args = this.toolArgs.get(toolCallId);
		this.toolArgs.delete(toolCallId);
		const traceId = this.currentTraceId;
		if (!this.obs || !traceId) {
			return;
		}
		const ms = Number(durationMs ?? 0);
		this.obs.record(traceId, {
			kind: "tool",
			name: toolName,
			ok,
			ms,
			payload: { args: summarizeArgs(args) },
		});
		if (isMcpToolName(toolName)) {
			const server = this.obs.mcpServerOf(toolName) ?? toolName;
			this.obs.record(traceId, {
				kind: "mcp",
				name: server,
				ok,
				ms,
				payload: { server, tool: toolName },
			});
		}
	}

	/**
	 * 把"其他流程"各包成一个工具，让模型自己挑流程。
	 *
	 * 子 agent 复用同一个 ctx / store / 模型：审批事件仍然挂在本会话上等用户点，
	 * 审计流水也记在本会话，业务数据（store）也一样——用户看到的就是一次对话。
	 * 子 agent 的注册表只装目标流程自己的工具，不含流程工具，所以不会无限递归。
	 */
	private buildFlowTools(repo: WorkflowRepo, runtime: { model: Model<any>; streamFn: StreamFn }): ToolDef[] {
		return repo
			.all()
			.filter((target) => target.id !== this.workflow.id)
			.map((target) => ({
				name: flowToolName(target.id),
				description: flowToolDescription(target),
				category: "流程",
				risk: "medium" as const,
				parameters: flowToolParameters(),
				execute: async (args: Record<string, unknown>) => {
					try {
						const result = await runSubWorkflow({
							workflow: target,
							store: this.store,
							ctx: this.ctx,
							model: runtime.model,
							streamFn: runtime.streamFn,
							task: String(args.task ?? target.name),
						});
						const status = result.done ? "流程走完" : "提前结束";
						return { content: `「${target.name}」执行完成（${status}）：\n${result.text || "（没有产出文本）"}` };
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return { content: `流程「${target.name}」执行失败：${message}`, isError: true };
					}
				},
			}));
	}

	/**
	 * `use_skill` 工具：由模型自己决定加载哪条技能。
	 *
	 * 工具结果就是技能正文——进上下文等于把"作业指导书"交给模型；
	 * 真正的工具集切换在 `activateSkill` 里（改 agent.state.tools，不重建 agent）。
	 */
	private buildSkillTool(): ToolDef {
		const skills = this.repo.skills();
		return {
			name: SKILL_TOOL_NAME,
			description: skillToolDescription(skills),
			category: "技能",
			risk: "low",
			parameters: skillToolParameters(skills),
			example: { skillId: skills[0]?.id ?? "" },
			execute: async (args: Record<string, unknown>) => {
				const skillId = String(args.skillId ?? "");
				try {
					const skill = this.activateSkill(skillId);
					return {
						content: `已加载技能「${skill.name}」（${skill.id}）。接下来按下面的说明执行：\n\n${skill.instructions}`,
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return { content: `加载技能失败：${message}`, isError: true };
				}
			},
		};
	}

	/**
	 * 技能目录就地刷新：控制台可以在会话开着的时候新建/改/删技能，
	 * 但 `this.skills` 与 `use_skill` 的工具参数枚举都是构造时的快照——
	 * 不刷新的话「刚建的技能加载不了」，模型也看不到它的 id。
	 *
	 * `AgentTool.parameters` 与这里的 `skillTool.parameters` 是同一个对象引用，
	 * 所以改枚举要改**对象内部**（不能替换 parameters 本身，那样 AgentTool 看不到）。
	 */
	private refreshSkills(): SkillDef[] {
		const fresh = this.repo.skills();
		this.skills.length = 0;
		this.skills.push(...fresh);
		const properties = (this.skillTool.parameters as { properties?: Record<string, unknown> }).properties;
		const skillId = properties?.skillId as { enum?: string[] } | undefined;
		if (skillId) {
			skillId.enum = fresh.map((skill) => skill.id);
		}
		this.skillTool.description = skillToolDescription(fresh);
		return fresh;
	}

	/**
	 * 加载技能：换工具集 + 换状态机（步骤条跟着变），并落库。
	 *
	 * 会话原流程的进度会先快照，退出技能（`clearSkill`）时原样恢复。
	 * 控制台右上角"用这个技能"与模型的 `use_skill` 工具走的是同一条路径。
	 */
	activateSkill(skillId: string): SkillDef {
		// 先刷新目录：技能可能是会话开着的时候才建的
		const skill = findSkill(this.refreshSkills(), skillId);
		if (!skill) {
			throw new Error(`未注册的技能: ${skillId}`);
		}
		// 传定义而不是 id：runtime 内部那份目录是构造时的快照，新建的技能它不认识
		const applied = this.built.activateSkill(skill);
		this.activeSkillId = skill.id;
		this.toolNames = this.built.toolNames();
		this.applyPermissionMode(this.permissionMode);
		this.emit({ type: "skill", skillId: skill.id, name: skill.name, description: skill.description });
		this.obs?.record(this.currentTraceId, {
			kind: "skill",
			name: skill.id,
			ok: true,
			payload: { action: "load", name: skill.name },
		});
		this.emitWorkflow();
		this.persist();
		return applied;
	}

	/** 退出技能，回到会话自己的流程（进度按加载前的快照恢复）。 */
	clearSkill(): void {
		if (this.activeSkillId === null) {
			return;
		}
		const previousSkillId = this.activeSkillId;
		this.built.clearSkill();
		this.activeSkillId = null;
		this.toolNames = this.built.toolNames();
		this.applyPermissionMode(this.permissionMode);
		this.emit({ type: "skill", skillId: null, name: this.workflow.name, description: "已退出技能，回到会话自己的流程" });
		this.obs?.record(this.currentTraceId, {
			kind: "skill",
			name: previousSkillId,
			ok: false,
			payload: { action: "exit" },
		});
		this.emitWorkflow();
		this.persist();
	}

	/** 只读观察：技能被删时 Hub 要找出"还挂着这条技能"的会话。 */
	get skillId(): string | null {
		return this.activeSkillId;
	}

	private awaitApproval(request: ApprovalRequest): Promise<boolean> {
		this.approvalSeq++;
		const requestId = `apv-${this.approvalSeq}`;
		const askedAt = Date.now();
		this.approvalMeta.set(requestId, {
			requestId,
			toolName: request.toolName,
			risk: request.risk,
			args: request.args,
			askedAt,
		});
		this.obs?.record(this.currentTraceId, {
			kind: "approval",
			name: request.toolName,
			ok: null,
			ms: null,
			payload: { phase: "waiting", requestId, risk: request.risk, args: summarizeArgs(request.args) },
		});
		this.emit({ type: "approval", requestId, toolName: request.toolName, args: request.args, risk: request.risk });
		return new Promise<boolean>((resolve) => {
			this.pendingApprovals.set(requestId, (approved) => {
				this.pendingApprovals.delete(requestId);
				resolve(approved);
			});
		});
	}

	resolveApproval(requestId: string, approved: boolean): boolean {
		const resolver = this.pendingApprovals.get(requestId);
		if (!resolver) {
			return false;
		}
		const meta = this.approvalMeta.get(requestId);
		if (meta) {
			this.approvalMeta.delete(requestId);
			this.obs?.record(this.currentTraceId, {
				kind: "approval",
				name: meta.toolName,
				ok: approved,
				ms: Date.now() - meta.askedAt,
				payload: { phase: "resolved", requestId, approved },
			});
		}
		resolver(approved);
		return true;
	}

	/**
	 * 只读观察：这个会话此刻挂起中的审批（审批中心 / 会话级接口共用）。
	 *
	 * 按 askedAt 升序——先问的先显示，和人工处理顺序一致。
	 */
	pendingApprovalViews(): PendingApprovalView[] {
		const views: PendingApprovalView[] = [];
		for (const meta of this.approvalMeta.values()) {
			views.push({
				requestId: meta.requestId,
				toolName: meta.toolName,
				risk: meta.risk,
				args: meta.args,
				askedAt: meta.askedAt,
			});
		}
		return views.sort((a, b) => a.askedAt - b.askedAt);
	}

	private applyPermissionMode(mode: PermissionMode): void {
		this.permissionMode = mode;
		if (mode === "full") {
			this.ctx.allow = ["*"];
		} else {
			this.ctx.allow = this.registry
				.select(this.toolNames)
				.filter((tool) => tool.risk === "low")
				.map((tool) => tool.name);
		}
	}

	/**
	 * 切换权限模式。
	 *
	 * 权限钩子持有的是 ctx 对象引用，所以在线修改 ctx.allow 会立刻生效，
	 * 不需要重建 agent。只读模式下只剩低风险工具可调。
	 */
	setPermissionMode(mode: PermissionMode): PermissionMode {
		this.applyPermissionMode(mode);
		this.persist();
		return this.permissionMode;
	}

	/**
	 * 设置自定义标题；传空字符串（或只有空白）则清除，前端恢复「用首条消息派生」。
	 * 超长按 TITLE_MAX_LENGTH 截断，不会报错。
	 */
	setTitle(title: string): string | null {
		this.title = normalizeTitle(title);
		this.persist();
		return this.title;
	}

	/**
	 * 归档 / 取消归档。归档只是"从默认列表里收起来"，会话本身照常能打开、能继续聊；
	 * 已归档的会话一收到新消息就自动取消归档（见 send）。
	 */
	setArchived(archived: boolean): boolean {
		this.archived = archived;
		this.persist();
		return this.archived;
	}

	/** 写入存储层（SQLite 或 Postgres，由 openStore 决定）。 */
	private persist(): void {
		this.updatedAt = Date.now();
		this.db.save({
			id: this.id,
			workflowId: this.workflow.id,
			modelId: this.modelId,
			mode: this.mode,
			modeLabel: this.modeLabel,
			permissionMode: this.permissionMode,
			title: this.title,
			archived: this.archived,
			createdAt: this.createdAt,
			updatedAt: this.updatedAt,
			done: this.engine.done,
			transcript: this.transcript,
			audit: this.auditLog,
			workflow: this.engine.state,
			store: this.store,
			agentMessages: this.agent.state.messages as unknown[],
			activeSkillId: this.activeSkillId,
			createdBy: this.createdBy,
			traceIds: [...this.traceIds],
		});
	}

	async send(text: string): Promise<void> {
		if (this.running) {
			this.emit({ type: "error", message: "上一轮还在执行中，请稍候" });
			return;
		}

		this.running = true;
		this.emit({ type: "busy", running: true });
		// 往归档会话里发消息 = 它又活过来了，自动取消归档（落库在 finally 里统一做）
		this.archived = false;
		this.transcript.push({ role: "user", text, at: Date.now() });

		// P9：每轮用户消息开一条调用链；trace_id 会进 done/error 负载与 SessionView.traceIds。
		// 采集器只入内存队列（200ms 批量落库），这里没有任何同步 IO。
		const traceId = this.obs?.begin({
			sessionId: this.id,
			workflowId: this.workflow.id,
			skillId: this.activeSkillId,
		}) ?? null;
		if (traceId) {
			this.currentTraceId = traceId;
			// 审计条目（AuditEntry.traceId）跟着这一轮走，和调用链对得上
			this.ctx.traceId = traceId;
			this.traceIds.unshift(traceId);
			if (this.traceIds.length > TRACE_HISTORY_LIMIT) {
				this.traceIds.length = TRACE_HISTORY_LIMIT;
			}
		}
		let failure: string | null = null;

		try {
			await this.agent.prompt(text);

			const last = this.lastAssistantMessage();
			if (last && (last.stopReason === "error" || last.stopReason === "aborted")) {
				const reason = last.stopReason === "aborted" ? "请求被中断" : "模型调用失败";
				const detail = last.errorMessage ?? "服务端未返回具体原因";
				failure = `${reason}：${detail}`;
				this.emit({ type: "error", message: failure, ...(traceId ? { traceId } : {}) });
				return;
			}

			const reply = this.lastAssistantText();
			this.transcript.push({ role: "assistant", text: reply, at: Date.now() });
			this.emit({ type: "done", text: reply, ...(traceId ? { traceId } : {}) });
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
			this.emit({ type: "error", message: failure, ...(traceId ? { traceId } : {}) });
		} finally {
			if (traceId) {
				// 成功 / 失败都收尾：失败文案进 traces.error，详情页能直接看到
				this.obs?.finish(traceId, failure ? "error" : "ok", failure);
				this.currentTraceId = null;
			}
			this.running = false;
			// 无论成功失败都落库，保证重启后能看到这次尝试
			this.persist();
			this.emit({ type: "busy", running: false });
			this.emitWorkflow();
		}
	}

	view(): SessionView {
		return {
			id: this.id,
			workflowId: this.workflow.id,
			workflowName: this.workflow.name,
			mode: this.mode,
			modeLabel: this.modeLabel,
			modelId: this.modelId,
			permissionMode: this.permissionMode,
			title: this.title,
			archived: this.archived,
			running: this.running,
			...this.workflowView(),
			tools: this.toolNames,
			skills: skillViewsFor(this.repo, this.activeSkillId),
			activeSkillId: this.activeSkillId,
			traceIds: [...this.traceIds],
			createdAt: this.createdAt,
			updatedAt: this.updatedAt,
			audit: this.auditLog,
			transcript: this.transcript,
			restored: this.restored,
		};
	}
}

export class SessionHub {
	private readonly sessions = new Map<string, Session>();

	constructor(
		private readonly db: Storage,
		private readonly repo: WorkflowRepo,
		/** P6：会话构造时注入"当前模型"解析（不传则完全保持 .env 行为） */
		private readonly resolveModel?: SessionModelResolver,
		/** P9：调用链采集器（不传 = 不采集，终端 demo / 单测保持原行为） */
		private readonly observability?: Observability,
	) {}

	create(workflowId: string, options: { modelId?: string; ownerId?: string | null } = {}): Session {
		const workflow = this.repo.get(workflowId);
		if (!workflow) {
			const broken = this.repo.errorOf(workflowId);
			throw new Error(broken ? `流程定义已失效（${workflowId}）：${broken}` : `未知流程: ${workflowId}`);
		}
		const session = new Session(workflow, {
			db: this.db,
			repo: this.repo,
			modelId: options.modelId,
			ownerId: options.ownerId,
			observability: this.observability,
			resolveModel: this.resolveModel,
		});
		this.sessions.set(session.id, session);
		return session;
	}

	/** 内存优先；没有则从存储层恢复。 */
	get(id: string): Session | undefined {
		const cached = this.sessions.get(id);
		if (cached) {
			return cached;
		}
		const record = this.db.load(id);
		if (!record) {
			return undefined;
		}
		const workflow = this.repo.get(record.workflowId);
		if (!workflow) {
			return undefined;
		}
		const session = new Session(workflow, {
			db: this.db,
			repo: this.repo,
			restore: record,
			observability: this.observability,
			resolveModel: this.resolveModel,
		});
		this.sessions.set(id, session);
		return session;
	}

	remove(id: string): boolean {
		this.sessions.delete(id);
		return this.db.remove(id);
	}

	/** 删除某个流程下的全部会话（删自定义流程时用；否则这些会话会因为找不到流程而从列表里凭空消失）。 */
	removeByWorkflow(workflowId: string): number {
		let removed = 0;
		for (const record of this.db.list()) {
			if (record.workflowId === workflowId) {
				this.sessions.delete(record.id);
				if (this.db.remove(record.id)) {
					removed += 1;
				}
			}
		}
		return removed;
	}

	/**
	 * 技能被删除时清掉引用它的会话（否则视图里会挂着一个已经不存在的技能）。
	 * 内存里的会话就地退出技能（走 `clearSkill`，会发 `skill` 事件并落库）；
	 * 只存在库里的老会话直接改 payload——这份 payload 是重启后恢复的唯一来源。
	 */
	detachSkill(skillId: string): number {
		let cleared = 0;
		for (const session of this.sessions.values()) {
			if (session.skillId === skillId) {
				session.clearSkill();
				cleared += 1;
			}
		}
		for (const record of this.db.list()) {
			if (record.activeSkillId === skillId) {
				this.db.save({ ...record, activeSkillId: null });
				cleared += 1;
			}
		}
		return cleared;
	}

	clear(): number {
		this.sessions.clear();
		return this.db.clear();
	}

	count(): number {
		return this.db.count();
	}

	/**
	 * 全局待办：把所有会话里挂起中的审批合并成一份（审批中心用），按 askedAt 升序。
	 *
	 * 只遍历内存里的会话——审批是同步挂起，只有"正在等"的会话才会有待办；
	 * 从库里恢复的历史会话不可能挂着请求（重启后没有任何 resolver 能放行它）。
	 * 已归档会话**不过滤**，只用 `archived` 标注：审批不因为会话被收起来就消失，
	 * 藏起来只会让那次工具调用永远卡住（要等人工处理）。
	 */
	pendingApprovals(): GlobalApprovalView[] {
		const items: GlobalApprovalView[] = [];
		for (const session of this.sessions.values()) {
			const pending = session.pendingApprovalViews();
			if (pending.length === 0) {
				continue;
			}
			// 一个会话只取一次视图：view() 会拼审计/对话，别按条重复算
			const view = session.view();
			for (const approval of pending) {
				items.push({
					sessionId: view.id,
					sessionTitle: view.title,
					workflowId: view.workflowId,
					workflowName: view.workflowName,
					archived: view.archived,
					...approval,
				});
			}
		}
		return items.sort((a, b) => a.askedAt - b.askedAt);
	}

	list(): SessionView[] {
		const views = new Map<string, SessionView>();
		for (const record of this.db.list()) {
			const view = viewFromRecord(record, this.repo);
			if (view) {
				views.set(view.id, view);
			}
		}
		for (const session of this.sessions.values()) {
			views.set(session.id, session.view());
		}
		return [...views.values()].sort((a, b) => a.updatedAt - b.updatedAt);
	}
}
