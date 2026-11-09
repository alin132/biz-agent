/**
 * 会话层：把一次"人机对话"包成可被 HTTP 订阅的对象，并落 SQLite。
 *
 * 持久化内容：对话文本、审计流水、流程进度、业务数据、以及 Pi 的 AgentMessage 上下文。
 * 所以服务重启后既能看到历史，也能接着聊（模型不会忘记前文）。
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { flowToolDescription, flowToolName, flowToolParameters } from "../src/core/flowTools.js";
import { ToolRegistry } from "../src/core/registry.js";
import { createBusinessRuntime } from "../src/core/runtime.js";
import type { BusinessRuntime } from "../src/core/runtime.js";
import { findSkill, SKILL_TOOL_NAME, skillToolDescription, skillToolParameters } from "../src/core/skill.js";
import type { SkillDef } from "../src/core/skill.js";
import { runSubWorkflow } from "../src/core/subFlow.js";
import type { AuditEntry, ApprovalRequest, BizContext, ToolDef, WorkflowDef, WorkflowState } from "../src/core/types.js";
import { WorkflowEngine } from "../src/core/workflow.js";
import { createStore } from "../src/store/memory.js";
import type { Store } from "../src/store/memory.js";
import type { PersistedSession, Storage, TranscriptEntry } from "./db/index.js";
import type { AgentModelConfig, AgentMemoryConfig, AgentAdvancedConfig } from "./db/types.js";
import { AgentError } from "./agents/service.js";
import { createSimulatedRuntime } from "./demoScripts.js";
import { getKb } from "./kb/index.js";
import { KB_SEARCH_TOOL_NAME, createKbPiExtension, createKbSearchTool } from "./kb/tool.js";
import { resolveLlm } from "./llm.js";
import type { LlmRuntime } from "./llm.js";
import { isMcpToolName } from "./mcp/names.js";
import { createMcpExtension } from "@earendil-works/pi-coding-agent";
import { createPiMcpTransport } from "./mcp/piTransport.js";
import type { McpRegistry } from "./mcp/registry.js";
import { estimateTokens, summarizeArgs } from "./observability/trace.js";
import type { Observability } from "./observability/collector.js";
import type { WorkflowRepo } from "./workflows.js";
import { createPiBusinessRuntime, createPiBusinessSession } from "./piRuntimeAdapter.js";
import type { PiRuntimeAdapter, PiSessionStats } from "./piRuntimeAdapter.js";
import { createPiSessionHistory, derivePiSessionHistory, piSessionLeafIdOf, piSessionTreeView, serializePiSessionBranch, serializePiSessionHistory } from "./piSessionHistory.js";

export type PermissionMode = "full" | "readonly";

export class PiSessionError extends Error {
	constructor(message: string, readonly status: number, readonly code: string) {
		super(message);
		this.name = "PiSessionError";
	}
}

const PI_BUSINESS_STATE_TYPE = "biz-agent.runtime-state.v1";

interface PiBusinessState {
	workflowId: string;
	activeSkillId: string | null;
	workflowState: WorkflowState;
	baseWorkflowState: WorkflowState;
}

export interface SessionAgent {
	id: string;
	name: string;
	prompt?: string;
	skillIds?: string[];
	kbIds?: string[];
	modelConfig?: AgentModelConfig;
	memoryConfig?: AgentMemoryConfig;
	advancedConfig?: AgentAdvancedConfig;
}

function piSkillsFromPlugins(db: Storage): Array<{ name: string; description: string; instructions: string; files?: Array<{ path: string; contentBase64: string }> }> {
	const skills: Array<{ name: string; description: string; instructions: string; files?: Array<{ path: string; contentBase64: string }> }> = [];
	for (const plugin of db.listPlugins()) {
		if (!plugin.enabled || !plugin.id.startsWith("pi-skill-")) continue;
		const manifest = plugin.manifest as { skills?: unknown };
		if (!Array.isArray(manifest.skills)) continue;
		for (const value of manifest.skills) {
			if (!value || typeof value !== "object") continue;
			const skill = value as Record<string, unknown>;
			if (typeof skill.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.id)) continue;
			if (typeof skill.description !== "string" || typeof skill.instructions !== "string" || !skill.instructions.trim()) continue;
			const files = Array.isArray(skill.files) ? skill.files.flatMap((file) => {
				if (!file || typeof file !== "object") return [];
				const item = file as Record<string, unknown>;
				return typeof item.path === "string" && typeof item.contentBase64 === "string"
					? [{ path: item.path, contentBase64: item.contentBase64 }]
					: [];
			}) : [];
			skills.push({ name: skill.id, description: skill.description, instructions: skill.instructions, ...(files.length ? { files } : {}) });
		}
	}
	return skills;
}

/**
 * 会话构造时的模型解析注入点（P6 多模型管理用）。
 *
 * 返回值三态：
 * - `LlmRuntime`：用这个真实模型；
 * - `undefined`：库里没有这个模型，交回 `resolveLlm()` 按 .env 处理（保持旧行为）；
 * - `null`：明确不连真实模型（模型/供应商停用、密文解不开），回落到模拟模型。
 */
export type SessionModelResolver = (modelId?: string) => LlmRuntime | null | undefined;

/**
 * 把「前端传来的模型名 / 模型行 id」归一成模型行 id（`model-xxx`）。
 *
 * 库里不认识就返回 `null`：会话照样记这个 key（下次启动仍按它解析），只是当下解析不出真实模型。
 */
export type SessionModelKeyResolver = (modelId?: string) => string | null;

/** 前端消费的事件协议。 */
export type WireEvent =
	| { type: "ready"; session: SessionView }
	| { type: "text"; delta: string }
	/** 模型思考过程增量（仅支持 reasoning 的模型会发；前端折叠展示，不混进正文） */
	| { type: "thinking"; delta: string }
	| { type: "tool_start"; id: string; name: string; args: unknown }
	| { type: "tool_end"; id: string; name: string; ok: boolean; result: string; durationMs?: number }
	| { type: "audit"; entry: AuditEntry }
	| { type: "approval"; requestId: string; toolName: string; args: unknown; risk: string }
	| { type: "workflow"; steps: StepView[]; current: number; done: boolean }
	| { type: "skill"; skillId: string | null; name: string; description: string }
	| { type: "done"; text: string; traceId?: string }
	| { type: "error"; message: string; traceId?: string }
	| { type: "busy"; running: boolean }
	| { type: "queue"; followUp: string[] }
	| { type: "context_usage"; tokens: number; estimated: boolean }
	| { type: "compacting"; automatic: boolean; at: number }
	/** 上下文压缩完成：前端据此把消息列表换成「摘要 + 最近 N 条」 */
	| { type: "compacted"; summary: string; before: number; after: number; kept: number; automatic: boolean; at: number; transcript: TranscriptEntry[] }
	/** 计划模式开关变化：前端据此显示/隐藏「计划模式」标记 */
	| { type: "plan"; planMode: boolean; at: number }
	| { type: "thinking_level"; thinkingLevel: ThinkingLevel; at: number };

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
	pendingApprovals?: PendingApprovalView[];
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
	queuedFollowUps: string[];
	/** 最近 20 条调用链 id（倒序，最新的在前）；每轮用户消息一条 */
	traceIds: string[];
	/**
	 * 计划模式：开启后系统提示附加「先给计划、经用户确认再执行」的约束。
	 *
	 * 会话级开关，落进 payload；前端据此显示标记并允许关闭。
	 */
	planMode: boolean;
	thinkingLevel: ThinkingLevel;
	/** 最近一次上下文压缩的时间戳；null = 还没压缩过 */
	compactedAt: number | null;
	compactedAutomatically: boolean;
	/** 最近一次压缩生成的摘要原文（前端要能把它显示回消息列表里） */
	summary: string | null;
	/** 这条对话对应的 Agent id；null = 普通对话 */
	agentId: string | null;
	/** Agent 名字（已删除时回落原 id，便于界面如实展示） */
	agentName: string | null;
	createdAt: number;
	updatedAt: number;
	audit: AuditEntry[];
	transcript: TranscriptEntry[];
	/** 是否从 SQLite 恢复的历史会话 */
	restored: boolean;
	/**
	 * 这条会话选中的模型记录的 id（model-xxx），null = 没单独选过（跟着建会话时的当前模型走）。
	 *
	 * 与「全局当前模型」是两件事：全局那个只影响**之后新建**的会话，改它不会动已有会话。
	 * 选填是兼容老响应（`web/app.js` 与老测试都不认这个字段）。
	 */
	modelKey?: string | null;
	/** 最近一次模型请求看见的输入上下文 token 数。 */
	contextTokens: number;
	/** 是否由本地估算。 */
	contextTokensEstimated: boolean;
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

/** Estimate text-bearing parts of Pi's current conversation state. */
function estimateContextMessages(messages: unknown, systemPrompt?: unknown): number {
	const parts: string[] = [];
	if (typeof systemPrompt === "string") parts.push(systemPrompt);
	if (Array.isArray(messages)) {
		for (const message of messages) {
			if (!message || typeof message !== "object") continue;
			const content = (message as { content?: unknown }).content;
			if (typeof content === "string") {
				parts.push(content);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
						parts.push((block as { text: string }).text);
					}
				}
			}
		}
	}
	return estimateTokens(parts.join("\n"));
}

function transcriptText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"))
		.map((part) => part.text)
		.join("");
}

function transcriptOfPiBranch(entries: ReturnType<ReturnType<typeof createPiSessionHistory>["getBranch"]>): TranscriptEntry[] {
	const transcript: TranscriptEntry[] = [];
	const tools = new Map<string, NonNullable<TranscriptEntry["tools"]>[number]>();
	for (const entry of entries) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			transcript.push({ role: "compaction", text: entry.summary, at: Date.parse(entry.timestamp), automatic: entry.type === "compaction" });
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as AgentMessage & { role: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
		const at = Date.parse(entry.timestamp) || Date.now();
		if (message.role === "user") {
			transcript.push({ role: "user", text: transcriptText(message.content), at, tools: [] });
		} else if (message.role === "assistant") {
			const userTurn = [...transcript].reverse().find((item) => item.role === "user");
			if (userTurn && Array.isArray(message.content)) {
				for (const part of message.content) {
					if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "toolCall") continue;
					const call = part as { id?: unknown; name?: unknown; arguments?: unknown };
					if (typeof call.id !== "string" || typeof call.name !== "string") continue;
					const item = { id: call.id, name: call.name, args: call.arguments ?? {} };
					userTurn.tools ??= [];
					userTurn.tools.push(item);
					tools.set(call.id, item);
				}
			}
			const text = transcriptText(message.content);
			if (text) transcript.push({ role: "assistant", text, at });
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const call = tools.get(message.toolCallId);
			if (call) {
				call.ok = !message.isError;
				call.result = transcriptText(message.content);
			}
		}
	}
	return transcript;
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
	const piState = piBranchState(record);
	return {
		id: record.id,
		workflowId: record.workflowId,
		workflowName: workflow.name,
		mode: record.mode,
		modeLabel: record.modeLabel,
		modelId: record.modelId,
		modelKey: record.modelKey ?? null,
		contextTokens: Math.max(0, Math.round(record.contextTokens ?? estimateContextMessages(record.agentMessages))),
		contextTokensEstimated: record.contextTokensEstimated ?? true,
		planMode: record.planMode ?? false,
		thinkingLevel: record.thinkingLevel ?? "medium",
		compactedAt: piState ? (piState.compaction ? Date.parse(piState.compaction.timestamp) || null : null) : record.compactedAt ?? null,
		compactedAutomatically: piState ? piState.compaction?.type === "compaction" : record.compactedAutomatically ?? false,
		summary: piState ? piState.compaction?.summary ?? null : record.summary ?? null,
		permissionMode: record.permissionMode,
		title: record.title ?? null,
		archived: record.archived ?? false,
		running: false,
		steps: stepsFor(stepsOf, current),
		current,
		done: record.done,
		tools: [...toolNamesFor(workflow, repo, skill), "tool_search"],
		skills: skillViewsFor(repo, activeSkillId),
		activeSkillId,
		queuedFollowUps: [],
		traceIds: [...(record.traceIds ?? [])],
		agentId: record.agentId ?? null,
		// 名字直接落库：恢复时只为了显示个名字就再查一次 Agent 不值得，而且 Agent 可能已被删
		agentName: record.agentName ?? null,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		audit: record.audit ?? [],
		transcript: transcriptFromPersistedRecord(record),
		restored: true,
	};
}

/** Older records may have a model summary without a visible compaction entry. */
function transcriptWithCompaction(record: PersistedSession): TranscriptEntry[] {
	const transcript = record.transcript ?? [];
	if (!record.summary || transcript.some((entry) => entry.role === "compaction")) return transcript;
	return [
		...transcript,
		{ role: "compaction", text: record.summary, at: record.compactedAt ?? Date.now(), automatic: record.compactedAutomatically ?? false },
	];
}

/** Pi's active branch is the conversation source; merge only business timing metadata from the legacy UI projection. */
function transcriptFromPersistedRecord(record: PersistedSession): TranscriptEntry[] {
	const legacy = transcriptWithCompaction(record);
	if (!record.piSessionEntries?.length) return legacy;

	const history = createPiSessionHistory({
		sessionId: record.id,
		piSessionEntries: record.piSessionEntries,
		piSessionLeafId: record.piSessionLeafId,
	});
	const branch = history.getBranch();
	if (!branch.some((entry) => entry.type === "message")) return legacy;

	const legacyUsers = new Map<string, TranscriptEntry[]>();
	const legacyCompactions = new Map<string, TranscriptEntry[]>();
	const legacyTools = new Map<string, NonNullable<TranscriptEntry["tools"]>[number]>();
	for (const entry of legacy) {
		if (entry.role === "user") {
			const queue = legacyUsers.get(entry.text) ?? [];
			queue.push(entry);
			legacyUsers.set(entry.text, queue);
			for (const tool of entry.tools ?? []) legacyTools.set(tool.id, tool);
		} else if (entry.role === "compaction") {
			const queue = legacyCompactions.get(entry.text) ?? [];
			queue.push(entry);
			legacyCompactions.set(entry.text, queue);
		}
	}

	return transcriptOfPiBranch(branch).map((entry) => {
		if (entry.role === "user") {
			const metadata = legacyUsers.get(entry.text)?.shift();
			if (!metadata) return entry;
			return {
				...entry,
				...(metadata.durationMs !== undefined ? { durationMs: metadata.durationMs } : {}),
				tools: entry.tools?.map((tool) => {
					const timing = legacyTools.get(tool.id);
					return timing?.durationMs === undefined ? tool : { ...tool, durationMs: timing.durationMs };
				}),
			};
		}
		if (entry.role === "compaction") {
			const metadata = legacyCompactions.get(entry.text)?.shift();
			return metadata ? { ...entry, before: metadata.before, after: metadata.after, kept: metadata.kept } : entry;
		}
		return entry;
	});
}

function piBranchState(record: PersistedSession) {
	if (!record.piSessionEntries?.length) return null;
	const history = createPiSessionHistory({
		sessionId: record.id,
		piSessionEntries: record.piSessionEntries,
		piSessionLeafId: record.piSessionLeafId,
	});
	const branch = history.getBranch();
	if (!branch.some((entry) => entry.type === "message")) return null;
	return { compaction: [...branch].reverse().find((entry) => entry.type === "compaction" || entry.type === "branch_summary") ?? null };
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

/**
 * Agent 人格提示：把绑定 Agent 的「人格与指令」（agentsMd）渲染成系统提示片段。
 *
 * 为什么放在会话层拼：agentsMd 是**运行时的可变配置**（页面随时能改），
 * 而流程定义、系统提示模板都是持久化/静态的；只有会话构造这一层能拿到"当前这一次对话用哪个 Agent"。
 *
 * 空串返回空串：没写指令的 Agent 与普通对话的系统提示完全一致，不制造"看起来有指令"的假象。
 */
export function agentPromptOf(agentPrompt: string | undefined): string {
	const text = (agentPrompt ?? "").trim();
	if (text.length === 0) {
		return "";
	}
	return [
		"# 你的角色与指令",
		"",
		"以下是这个 Agent 的专属设定，优先级高于上面的通用风格要求：",
		"",
		text,
	].join("\n");
}

/**
 * 知识库提示：把「对话默认检索」的库名渲染成一段系统提示片段。
 *
 * 为什么在会话层拼而不是写进流程定义：流程定义是持久化的，库配置随时会变；
 * 而且模型不知道有这条路就永远不会调 kb_search——"能用"和"会用"是两回事。
 * 没配默认库时返回空串，提示里不出现知识库相关内容（不制造假能力）。
 */
function kbDefaultHintOf(): string {
	try {
		const { kbIds, knowledgeBases } = getKb().getDefaultBindings();
		if (kbIds.length === 0) {
			return "";
		}
		const names = knowledgeBases.map((kb) => `《${kb.name}》`).join("、");
		return [
			"# 知识库",
			"",
			`用户已把 ${names} 设为对话默认检索的资料库。问到产品手册、政策条款、客服话术这类内部资料时，`,
			"先调用 `kb_search` 查资料再回答（不需要先加载技能）：",
			"- 检索词用用户问题里的关键说法，可以换个说法多查一次；",
			"- 回答里引用资料要标出来源，格式如（来源：《文件名》）；",
			"- 真的没查到就如实说没查到，不要编造资料内容。",
		].join("\n");
	} catch {
		// 知识库模块没初始化（例如单测直接造 Session）时不能让会话构造失败
		return "";
	}
}

/**
 * 计划模式的系统提示片段。
 *
 * 为什么单独拼一段而不是改流程定义：计划模式是**会话级开关**（用户随时敲 /plan 打开或关掉），
 * 而流程定义是持久化/共享的——把它写进流程定义等于对所有会话生效。
 *
 * 提示里同时要求"先给计划"和"等确认再执行"，缺一条都达不到效果：
 * 只说"先给计划"模型会自己在同一轮里接着执行；只说"不要动手"模型会干等不输出方案。
 */
export function planModePromptOf(enabled: boolean): string {
	if (!enabled) {
		return "";
	}
	return [
		"# 工作模式：计划模式（已开启）",
		"",
		"这一轮用户开了计划模式。请严格遵守：",
		"- **先给计划，不要执行**：把要做的事拆成有序步骤，说清每步用什么工具、会改哪些数据；",
		"- 给出计划后**停下来等用户确认**，不要在同一轮里接着调用任何工具；",
		"- 用户确认后（他说「按计划做 / 开始 / 执行」）再按步骤执行；用户改计划就按改后的来；",
		"- 需要先看数据才能定计划时，可以先用只读工具查清楚，但绝不写数据、不发消息、不提交。",
	].join("\n");
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
	mode: "simulated" | "live";
	/** 模型展示名会随地换模型变（见 setModel），所以不是 readonly */
	modeLabel: string;
	/** 当前真实生效的模型名；模拟模式恒为 null */
	modelId: string | null;
	/**
	 * 会话选中的模型记录 id（model-xxx）；null = 没单独选过。
	 *
	 * 为什么单独存一份：`modelId` 是「展示 / 记账」用的（可能来自 .env，也可能来自库），
	 * 重启后要按用户当时选的那条模型行**重新解析**，所以必须记住它指向哪一行。
	 * 只存 id 不存 key 的话，重启只能回落到全局当前模型——那正是「换个模型把别的会话也换了」的老问题。
	 */
	modelKey: string | null = null;
	readonly createdAt: number;
	readonly restored: boolean;
	readonly internalGroupSession: boolean;
	readonly auditLog: AuditEntry[] = [];
	readonly transcript: TranscriptEntry[] = [];

	private readonly db: Storage;
	private readonly repo: WorkflowRepo;
	/** Pi Agent/AgentSession 生命周期由 piRuntime 持有。 */
	private built!: BusinessRuntime;
	private unsubscribeAgent?: () => void;
	private piRuntime: PiRuntimeAdapter | null = null;
	private piResourceReload: Promise<{ session: SessionView; piSkills: string[] }> | null = null;
	private readonly piHistory: ReturnType<typeof createPiSessionHistory>;
	private compactionStartedAt = 0;
	private compactionMessagesBefore = 0;
	private runtime!: { model: Model<any>; streamFn: StreamFn; modelRuntime?: LlmRuntime["modelRuntime"] };
	private readonly agentConfig: NonNullable<PersistedSession["agentConfig"]>;
	private readonly ctx: BizContext;
	private readonly registry: ToolRegistry;
	/** 换模型要重建 agent，靠它重新解析运行时（见 setModel） */
	private readonly resolveModel: SessionModelResolver | undefined;
	private readonly resolveModelKeyFn: SessionModelKeyResolver | undefined;
	private readonly mcpRegistry: McpRegistry | undefined;
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
	/** 计划模式开关：会话级，落进 payload（见 planModePromptOf） */
	private planMode = false;
	private thinkingLevel: ThinkingLevel = "medium";
	private autoCompactionEnabled = true;
	/** 最近一次压缩的时间戳与摘要（进视图，前端据此渲染「已压缩」卡片） */
	private compactedAt: number | null = null;
	private summary: string | null = null;
	private compactedAutomatically = false;
	private contextTokens = 0;
	private contextTokensEstimated = true;
	private currentTurnEntry: TranscriptEntry | null = null;
	private currentTurnStartedAt = 0;
	private readonly subscribers = new Set<(event: WireEvent) => void>();
	private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
	private approvalSeq = 0;
	private running = false;
	private compacting = false;
	private stopRequested = false;
	private queuedFollowUps: string[] = [];
	private disposed = false;
	private updatedAt: number;
	/** P9 调用链采集器：不传时行为与 P9 之前完全一致（终端 demo / 单元测试） */
	private readonly obs?: Observability;
	/** 建会话的用户 id（监控按角色收窄 developer 可见的调用链） */
	private readonly createdBy: string | null;
	/**
	 * 这条对话绑定的 Agent id（null = 普通对话）。
	 *
	 * Agent 只是"配置"：它能决定模型、能绑技能/知识库、能改人格指令，但**对话本身仍是会话**。
	 * 绑定落进 payload，所以刷新页面、重启服务后还能看出"我是在跟哪个 Agent 聊"。
	 */
	readonly agentId: string | null;
	/** 建会话那一刻的 Agent 名字快照：Agent 后来被改名/删掉，历史会话仍显示当时的名字 */
	readonly agentName: string | null;
	/**
	 * 建会话那一刻的 Agent 人格指令快照（agentsMd）。
	 *
	 * 与名字同理取快照：会话跑到一半时页面把 Agent 改掉，正在进行的对话不该被半路换脑。
	 * 恢复持久化会话时**不**从库里的 Agent 现读——统一按"建会话当时"的口径，历史对话才可复现。
	 */
	private readonly agentPrompt: string | null;
	/** 建会话那一刻的 Agent 知识库绑定快照（kbIds）：kb_search 的检索范围，空数组 = 没绑。 */
	private readonly agentKbIds: string[];
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
			internalGroupSession?: boolean;
			restore?: PersistedSession;
			newlyDerived?: boolean;
			resolveModel?: SessionModelResolver;
			/** 把 modelId / 模型行 id 归一成模型行 id（会话级模型要记住「选的是哪一行」） */
			resolveModelKey?: SessionModelKeyResolver;
			mcpRegistry?: McpRegistry;
			/** P9：调用链采集器（可选） */
			observability?: Observability;
			/** P9：建会话的用户 id（落进 payload，监控据此收窄权限） */
			ownerId?: string | null;
			/**
			 * 绑定的 Agent（已发布才允许对话）；不传 = 普通对话。
			 *
			 * 三项都要真的注入才算"配置生效"，只存库不注入的话页面里配了半天、对话里毫无变化：
			 * - prompt  人格与指令（agentsMd）→ 进系统提示；
			 * - skillIds 声明的技能 → 建会话时自动加载第一个（工具集与步骤条跟着变）；
			 * - kbIds   声明的知识库 → kb_search 的检索范围（优先级见 kb 模块）。
			 */
			agent?: SessionAgent;
		},
	) {
		this.db = options.db;
		this.workflow = workflow;
		this.obs = options.observability;
		this.resolveModel = options.resolveModel;
		this.resolveModelKeyFn = options.resolveModelKey;
		this.mcpRegistry = options.mcpRegistry;
		const restored = options.restore;
		const resolveModelKey = options.resolveModelKey;
		this.createdBy = restored?.createdBy ?? options.ownerId ?? null;
		this.agentId = restored?.agentId ?? options.agent?.id ?? null;
		// 老会话 payload 里没有 agentName（后补字段），回落到 id 兜底：显示个 id 也好过显示空
		this.agentName = options.agent?.name ?? restored?.agentName ?? (restored?.agentId ? restored.agentId : null);
		this.agentPrompt = options.agent?.prompt ?? null;
		this.agentKbIds = [...(options.agent?.kbIds ?? [])];
		this.agentConfig = structuredClone(restored?.agentConfig ?? {
			modelConfig: options.agent?.modelConfig ?? {},
			memoryConfig: options.agent?.memoryConfig ?? {},
			advancedConfig: options.agent?.advancedConfig ?? {},
		});
		this.autoCompactionEnabled = restored?.piAutoCompactionEnabled ?? true;
		if (!restored && !options.agent) {
			const stored = this.db.getModelSetting("pi.settings.v1");
			if (stored) {
				try {
					const settings = JSON.parse(stored) as { compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number } };
					this.agentConfig.memoryConfig = { reserveTokens: settings.compaction?.reserveTokens, keepRecentTokens: settings.compaction?.keepRecentTokens };
					this.autoCompactionEnabled = settings.compaction?.enabled ?? true;
				} catch {
					throw new Error("已保存的 Pi 压缩设置格式无效");
				}
			}
		}
		if (restored?.traceIds) {
			this.traceIds.push(...restored.traceIds.slice(0, 20));
		}
	this.contextTokens = Math.max(0, Math.round(restored?.contextTokens ?? estimateContextMessages(restored?.agentMessages)));
	this.contextTokensEstimated = restored?.contextTokensEstimated ?? true;

		this.id = restored?.id ?? randomUUID().slice(0, 8);
		this.piHistory = createPiSessionHistory({
			sessionId: this.id,
			cwd: process.cwd(),
			agentMessages: restored?.agentMessages,
			piSessionEntries: restored?.piSessionEntries,
			piSessionLeafId: restored?.piSessionLeafId,
		});
		this.createdAt = restored?.createdAt ?? Date.now();
		this.updatedAt = restored?.updatedAt ?? this.createdAt;
		this.restored = Boolean(restored && !options.newlyDerived);
		this.internalGroupSession = restored?.internalGroupSession ?? options.internalGroupSession ?? false;

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
		// 技能 id 在调用那一刻才取——没加载技能时返回 null，工具就会回落到「对话默认检索」的库，
		// 所以"不加载技能直接问答"也能查到资料（RAG）。切技能后自动跟着走技能的绑定。
		this.registry.registerAll([
			createKbSearchTool({
				getActiveSkillId: () => this.activeSkillId,
				// 读字段而不是构造参数：将来允许改绑定时，工具要在调用那一刻取最新值
				getAgentKbIds: () => this.agentKbIds,
			}),
		]);

		// 历史会话只在原本就是真实模型时才尝试复用真实模型，避免历史配置漂移
		const allowLive = restored ? restored.mode === "live" : true;
		// 解析用哪个模型的优先级：**选中的模型行** > payload 里那份运行时快照 > 库里的当前模型。
		//
		// 为什么不能只用 `restored.modelId`：那是「上一次用的是哪个模型名」的记账，老 payload 里
		// 存的是模型名（如 deepseek-flash），而模型名会重名、会被改。真正能定位到「用户当初选了哪一行」
		// 的是 `modelKey`（model-xxx），所以有 modelKey 时按它重新解析。
		//
		// 不这样做的话，用户把这条会话切成 B 模型、重启之后再进来，恢复出来的却是 payload 里
		// 那份旧快照的 A ——「会话模型要落库，重启后仍是这个模型」就落空了。
		const preferredModel = restored?.modelKey ?? options.modelId ?? restored?.modelId ?? undefined;
		const restoredRuntime = allowLive && restored?.modelId ? options.resolveModel?.(restored.modelId) : undefined;
		const pickedRuntime = allowLive ? options.resolveModel?.(preferredModel) : undefined;
		// 解析结果的三态见 SessionModelResolver：undefined = 库里不认识，那种情况交回 .env 那一套。
		// 恢复出来的旧快照只在「选中的那一行解析不出来」时才拿来兜底（row 被停用/删掉的情形）。
		let live: LlmRuntime | null;
		if (!allowLive) {
			live = null;
		} else if (pickedRuntime !== undefined) {
			live = pickedRuntime;
		} else if (restoredRuntime !== undefined) {
			live = restoredRuntime;
		} else {
			live = resolveLlm(preferredModel);
		}
		// 模拟模型需要工具定义里的 example 参数才能把流程"演"完
		const runtime = live ?? createSimulatedRuntime(this.engine, this.registry);

		this.mode = live ? "live" : "simulated";
		this.modeLabel = live?.label ?? "模拟模型";
		this.modelId = live?.modelId ?? null;
		// 即使当前没有真实运行时，也保留用户选中的模型行；mode 仍明确表示回复来自模拟模型。
		this.modelKey = resolveModelKey?.(preferredModel) ?? null;

		// 流程即工具：把其他流程也装成工具，由模型自己挑；不装自己，天然不递归
		const flowTools = this.buildFlowTools(options.repo);
		this.registry.registerAll(flowTools);
		// 暴露给模型的工具 = 本流程/技能的步骤工具 + flow_xxx + use_skill（不是注册表里全部）
		this.toolNames = toolNamesFor(workflow, options.repo);

		if (restored) {
			this.permissionMode = restored.permissionMode ?? "full";
			this.title = restored.title ?? null;
			this.archived = restored.archived ?? false;
			// 计划模式与压缩结果都要能跨刷新/重启恢复：否则用户会以为开关自己关了、摘要凭空消失
			this.planMode = restored.planMode ?? false;
			this.thinkingLevel = restored.thinkingLevel ?? "medium";
			const piState = piBranchState(restored);
			this.compactedAt = piState ? (piState.compaction ? Date.parse(piState.compaction.timestamp) || null : null) : restored.compactedAt ?? null;
			this.summary = piState ? piState.compaction?.summary ?? null : restored.summary ?? null;
			this.compactedAutomatically = piState ? piState.compaction?.type === "compaction" : restored.compactedAutomatically ?? false;
			this.auditLog.push(...(restored.audit ?? []));
			this.transcript.push(...transcriptFromPersistedRecord(restored));
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

		this.built = this.createBusinessRuntime(runtime, restored?.baseWorkflowState);

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
		} else if (!restored) {
			// 新会话：Agent 声明的技能直接生效，用户不用再手动点一次「用这个技能」。
			// 只在**全新会话**上做：历史会话的 activeSkillId 代表用户当时的选择，不该被配置覆盖；
			// 而且恢复会话时 engine 里已有进度快照，硬加载会把它冲掉。
			this.applyAgentSkill(options.agent?.skillIds ?? []);
		}

		if (!restored || options.newlyDerived) {
			this.persist();
		}

	}

	private bindAgentEvents(): void {
		this.unsubscribeAgent?.();
		this.unsubscribeAgent = this.piRuntime?.subscribe((event) => {
			this.handlePiSessionEvent(event);
			if (event.type === "queue_update") {
				this.queuedFollowUps = [...event.followUp];
				this.emit({ type: "queue", followUp: [...this.queuedFollowUps] });
				this.persist();
			}
			switch (event.type) {
				case "message_update":
					if (event.assistantMessageEvent.type === "text_delta") {
						if (this.agentConfig.modelConfig.stream !== false) {
							this.emit({ type: "text", delta: event.assistantMessageEvent.delta });
						}
					} else if (event.assistantMessageEvent.type === "thinking_delta") {
						// 推理模型的思考增量：单独一路事件，别混进正文（前端折起来看）
						if (this.agentConfig.advancedConfig.showThinking !== false) {
							this.emit({ type: "thinking", delta: event.assistantMessageEvent.delta });
						}
					}
					break;
				case "message_end":
					// 每轮 LLM 调用结束：模型名 + token（真实 usage 优先，否则按内容估算）+ 耗时
					if (event.message.role === "assistant") this.recordLlmEvent(event.message);
					else this.persist();
					break;
				case "tool_execution_start":
					this.toolArgs.set(event.toolCallId, event.args);
					this.currentTurnEntry?.tools?.push({ id: event.toolCallId, name: this.piRuntime?.canonicalToolName(event.toolName) ?? event.toolName, args: event.args });
					this.emit({ type: "tool_start", id: event.toolCallId, name: this.piRuntime?.canonicalToolName(event.toolName) ?? event.toolName, args: event.args });
					break;
				case "tool_execution_end":
					this.recordToolEvent(event.toolCallId, this.piRuntime?.canonicalToolName(event.toolName) ?? event.toolName, !event.isError, event.durationMs, toolResultText(event.result));
					this.emit({
						type: "tool_end",
						id: event.toolCallId,
						name: this.piRuntime?.canonicalToolName(event.toolName) ?? event.toolName,
						ok: !event.isError,
						result: toolResultText(event.result),
						durationMs: event.durationMs,
					});
					this.emitWorkflow();
					this.persist();
					break;
				default:
					break;
			}
		});
	}

	private async ensurePiRuntime(): Promise<PiRuntimeAdapter> {
		if (this.piRuntime) return this.piRuntime;
		const runtime = await createPiBusinessRuntime({
			business: this.built,
			registry: this.registry,
			ctx: this.ctx,
			model: this.runtime.model,
			streamFn: this.runtime.streamFn,
			messages: this.piHistory.buildSessionContext().messages as AgentMessage[],
			sessionManager: this.piHistory,
			extensions: [
				createKbPiExtension({
					getActiveSkillId: () => this.activeSkillId,
					getAgentKbIds: () => this.agentKbIds,
				}),
				createMcpExtension({
					loadConfig: () => this.mcpRegistry?.piConfigSnapshot() ?? { servers: [], errors: [] },
					createTransport: createPiMcpTransport,
				}),
			],
			nativeToolNames: [KB_SEARCH_TOOL_NAME, ...this.registry.all().filter((tool) => isMcpToolName(tool.name)).map((tool) => tool.name)],
			toolNameAliases: this.mcpRegistry?.piToolAliases() ?? {},
			isToolAvailable: (name) => !isMcpToolName(name) || (this.mcpRegistry?.isToolEnabled(name) ?? false),
			cwd: process.cwd(),
			reserveTokens: this.agentConfig.memoryConfig.reserveTokens,
			keepRecentTokens: this.agentConfig.memoryConfig.keepRecentTokens,
			autoCompactionEnabled: this.autoCompactionEnabled,
			modelRuntime: this.liveRuntimeFor()?.modelRuntime,
			piSkills: piSkillsFromPlugins(this.db),
			alwaysActiveToolNames: ["tool_search"],
			skill: {
				name: SKILL_TOOL_NAME,
				description: () => skillToolDescription(this.refreshSkills()),
				contextMessage: () => {
					const active = this.built.skillContext();
					return active ? {
						role: "user",
						timestamp: Date.now(),
						content: `当前技能「${active.name}」的作业指导书：\n\n${active.instructions}`,
					} : null;
				},
				load: (skillId) => {
					const skill = this.activateSkill(skillId);
					return `已加载技能「${skill.name}」（${skill.id}）。接下来按下面的说明执行：\n\n${skill.instructions}`;
				},
			},
			workflow: {
				maxTurns: this.agentConfig.advancedConfig.maxIters ?? 12,
				startRun: this.built.startRun,
				finishTurn: this.built.finishTurn,
				nextPrompt: this.built.nextPrompt,
				limitReached: this.built.limitReached,
				onStateChange: () => this.persistPiBusinessState(),
			},
		});
		this.piRuntime = runtime;
		this.bindAgentEvents();
		runtime.setActiveToolsByName(this.built.toolNames());
		runtime.setThinkingLevel?.(this.thinkingLevel);
		return runtime;
	}

	private handlePiSessionEvent(event: AgentSessionEvent): void {
		if (event.type === "compaction_start") {
			this.compacting = true;
			this.compactionStartedAt = Date.now();
			this.compactionMessagesBefore = this.piHistory.buildSessionContext().messages.length;
			this.emit({ type: "compacting", automatic: event.reason !== "manual", at: this.compactionStartedAt });
			return;
		}
		if (event.type !== "compaction_end") return;

		this.compacting = false;
		if (!event.result) {
			// Automatic failures are finalized by Pi's prompt/overflow recovery lifecycle;
			// emitting an error here could be followed by a successful done for the same turn.
			return;
		}
		const at = Date.now();
		const summary = event.result.summary;
		const messages = this.piHistory.buildSessionContext().messages;
		const before = this.compactionMessagesBefore;
		const after = messages.length;
		const kept = Math.max(0, after - 1);
		const automatic = event.reason !== "manual";
		this.compactedAt = at;
		this.summary = summary;
		this.compactedAutomatically = automatic;
		this.transcript.push({ role: "compaction", text: summary, at, before, after, kept, automatic });
		this.persist();
		this.emit({ type: "compacted", summary, before, after, kept, automatic, at, transcript: [...this.transcript] });
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
		return this.piRuntime?.lastAssistantText() ?? "";
	}
	private lastAssistantMessage(): { stopReason?: string; errorMessage?: string } | undefined {
		return this.piRuntime?.lastAssistantMessage() as { stopReason?: string; errorMessage?: string } | undefined;
	}

	private runtimeMessages(): AgentMessage[] {
		return this.piRuntime?.messages() ?? this.piHistory.buildSessionContext().messages as AgentMessage[];
	}

	private runtimeSystemPrompt(): string {
		return this.piRuntime?.systemPrompt() ?? this.built.systemPrompt;
	}

	private refreshEstimatedContext(): void {
		this.contextTokens = Math.max(0, Math.round(estimateContextMessages(
			this.runtimeMessages(),
			this.runtimeSystemPrompt(),
		)));
		this.contextTokensEstimated = true;
		this.emit({ type: "context_usage", tokens: this.contextTokens, estimated: true });
	}

	/**
	 * LLM 事件：模型名 + 估算 token + 耗时。
	 *
	 * 真实模型通常带 usage（含 input/output/totalTokens），模拟模型的 usage 是 0，
	 * 这时按回复文本估算 —— 监控要的是趋势，不是计费。
	 */
	private recordLlmEvent(message: unknown): void {
		const traceId = this.currentTraceId;
		if (!message || typeof message !== "object") {
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
		const inputUsage = Number(typed.usage?.input);
		if (Number.isFinite(inputUsage) && inputUsage > 0) {
			this.contextTokens = Math.round(inputUsage);
			this.contextTokensEstimated = false;
		} else {
			this.contextTokens = Math.max(0, Math.round(estimateContextMessages(
				this.runtimeMessages(),
				this.runtimeSystemPrompt(),
			)));
			this.contextTokensEstimated = true;
		}
		this.persist();
		this.emit({ type: "context_usage", tokens: this.contextTokens, estimated: this.contextTokensEstimated });

		if (!this.obs || !traceId) {
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
	private recordToolEvent(toolCallId: string, toolName: string, ok: boolean, durationMs?: number, result = ""): void {
		const turnTool = this.currentTurnEntry?.tools?.find((tool) => tool.id === toolCallId);
		if (turnTool) Object.assign(turnTool, { ok, durationMs: Number(durationMs ?? 0), result: result.slice(0, 4000) });
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
	private buildFlowTools(repo: WorkflowRepo): ToolDef[] {
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
							maxTurns: this.agentConfig.advancedConfig.maxIters,
							task: String(args.task ?? target.name),
							createSession: (input) => createPiBusinessSession({
								...input,
								model: this.runtime.model,
								streamFn: this.runtime.streamFn,
								sessionManager: createPiSessionHistory({ sessionId: `flow-${randomUUID()}` }),
								cwd: process.cwd(),
								reserveTokens: this.agentConfig.memoryConfig.reserveTokens,
								keepRecentTokens: this.agentConfig.memoryConfig.keepRecentTokens,
								modelRuntime: this.liveRuntimeFor()?.modelRuntime,
							}),
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
	 * 真正的活动工具集由 Pi AgentSession 切换；会话层只提供业务技能定义与权限边界。
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
	 * 把 Agent 声明的技能装进这个新会话。
	 *
	 * 取第一个**在目录里找得到**的技能：Agent 可能声明了已被删掉的技能 id（技能是运行时数据，
	 * 建 Agent 时合法不代表此刻还在），直接抛错会让整个会话建不出来——降级成"这个技能没装上"，
	 * 用户仍能正常对话，只是要手动选技能。这也是控制台删技能不会连累 Agent 的原因。
	 */
	private applyAgentSkill(skillIds: string[]): void {
		for (const skillId of skillIds) {
			const normalized = String(skillId ?? "").trim();
			if (normalized.length === 0 || !findSkill(this.skills, normalized)) {
				continue;
			}
			try {
				this.activateSkill(normalized);
			} catch {
				// 装配失败也不能把建会话搞崩：会话照常可用，只是没装上这条技能
			}
			return;
		}
	}

	/**
	 * 加载技能：换工具集 + 换状态机（步骤条跟着变），并落库。
	 *
	 * 会话原流程的进度会先快照，退出技能（`clearSkill`）时原样恢复。
	 * 控制台右上角"用这个技能"与模型的 `use_skill` 工具走的是同一条路径。
	 */
	activateSkill(skillId: string): SkillDef {
		if (this.compacting) {
			throw new Error("这条对话正在压缩上下文，等它完成后再切换技能");
		}
		// 先刷新目录：技能可能是会话开着的时候才建的
		const skill = findSkill(this.refreshSkills(), skillId);
		if (!skill) {
			throw new Error(`未注册的技能: ${skillId}`);
		}
		// 传定义而不是 id：runtime 内部那份目录是构造时的快照，新建的技能它不认识
		const applied = this.built.activateSkill(skill);
		this.activeSkillId = skill.id;
		this.toolNames = this.built.toolNames();
		this.piRuntime?.setActiveToolsByName(this.toolNames);
		this.applyPermissionMode(this.permissionMode);
		this.refreshEstimatedContext();
		this.emit({ type: "skill", skillId: skill.id, name: skill.name, description: skill.description });
		this.obs?.record(this.currentTraceId, {
			kind: "skill",
			name: skill.id,
			ok: true,
			payload: { action: "load", name: skill.name },
		});
		this.emitWorkflow();
		this.persistPiBusinessState();
		return applied;
	}

	/** 退出技能，回到会话自己的流程（进度按加载前的快照恢复）。 */
	clearSkill(): void {
		if (this.compacting) {
			throw new Error("这条对话正在压缩上下文，等它完成后再切换技能");
		}
		if (this.activeSkillId === null) {
			return;
		}
		const previousSkillId = this.activeSkillId;
		this.built.clearSkill();
		this.activeSkillId = null;
		this.toolNames = this.built.toolNames();
		this.piRuntime?.setActiveToolsByName(this.toolNames);
		this.applyPermissionMode(this.permissionMode);
		this.refreshEstimatedContext();
		this.emit({ type: "skill", skillId: null, name: this.workflow.name, description: "已退出技能，回到会话自己的流程" });
		this.obs?.record(this.currentTraceId, {
			kind: "skill",
			name: previousSkillId,
			ok: false,
			payload: { action: "exit" },
		});
		this.emitWorkflow();
		this.persistPiBusinessState();
	}

	private piBusinessState(): PiBusinessState {
		return {
			workflowId: this.engine.definition.id,
			activeSkillId: this.activeSkillId,
			workflowState: structuredClone(this.engine.state),
			baseWorkflowState: this.built.baseWorkflowState(),
		};
	}

	private persistPiBusinessState(): void {
		const state = this.piBusinessState();
		const previous = [...this.piHistory.getBranch()].reverse().find((entry) =>
			entry.type === "custom" && entry.customType === PI_BUSINESS_STATE_TYPE,
		);
		if (previous?.type === "custom" && JSON.stringify(previous.data) === JSON.stringify(state)) {
			this.persist();
			return;
		}
		this.piHistory.appendCustomEntry(PI_BUSINESS_STATE_TYPE, state);
		this.persist();
	}

	private restorePiBusinessState(): void {
		const branch = this.piHistory.getBranch();
		const hasAnyState = this.piHistory.getEntries().some((entry) =>
			entry.type === "custom" && entry.customType === PI_BUSINESS_STATE_TYPE,
		);
		const saved = [...branch].reverse().find((entry) =>
			entry.type === "custom" && entry.customType === PI_BUSINESS_STATE_TYPE,
		);
		if (!hasAnyState) return;

		const data = saved?.type === "custom" ? saved.data as Partial<PiBusinessState> : undefined;
		const skill = data?.activeSkillId ? findSkill(this.refreshSkills(), data.activeSkillId) : undefined;
		const workflow = skill?.workflow ?? this.workflow;
		const initialState: WorkflowState = { workflowId: this.workflow.id, stepIndex: 0, completed: [], calls: [] };
		const baseState = data?.baseWorkflowState?.workflowId === this.workflow.id
			? structuredClone(data.baseWorkflowState)
			: initialState;
		const activeState = data?.workflowId === workflow.id && data.workflowState?.workflowId === workflow.id
			? structuredClone(data.workflowState)
			: workflow.id === this.workflow.id ? baseState : { workflowId: workflow.id, stepIndex: 0, completed: [], calls: [] };

		this.engine.reset(this.workflow, baseState);
		this.built = this.createBusinessRuntime(this.runtime, baseState);
		this.activeSkillId = null;
		if (skill) {
			this.built.activateSkill(skill);
			this.activeSkillId = skill.id;
		}
		this.engine.reset(workflow, activeState);
		this.toolNames = this.built.toolNames();
		this.piRuntime?.setActiveToolsByName(this.toolNames);
		this.applyPermissionMode(this.permissionMode);
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
				.map((tool) => tool.name)
				.concat("tool_search");
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
		this.piHistory.appendSessionInfo(this.title ?? "");
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

	/** Build business policy and model request options; Pi owns Agent construction. */
	private createBusinessRuntime(
		runtime: { model: LlmRuntime["model"]; streamFn: LlmRuntime["streamFn"]; modelRuntime?: LlmRuntime["modelRuntime"] },
		baseWorkflowState: WorkflowState | undefined = this.built?.baseWorkflowState(),
	): BusinessRuntime {
		const { modelConfig, advancedConfig } = this.agentConfig;
		const streamFn: StreamFn = (model, context, options) => runtime.streamFn(model, context, {
			...options,
			...(modelConfig.temperature !== undefined ? { temperature: modelConfig.temperature } : {}),
			...(modelConfig.maxTokens !== undefined ? { maxTokens: modelConfig.maxTokens } : {}),
			...(modelConfig.topP !== undefined ? { samplingParams: { ...options?.samplingParams, top_p: modelConfig.topP } } : {}),
			onPayload: async (payload, requestModel) => {
				const previous = await options?.onPayload?.(payload, requestModel);
				const body = previous ?? payload;
				if (modelConfig.topP === undefined || typeof body !== "object" || body === null) return body;
				if (requestModel.api === "anthropic-messages") return { ...body, top_p: modelConfig.topP };
				if (requestModel.api === "google-generative-ai" || requestModel.api === "google-vertex") {
					const config = (body as { config?: Record<string, unknown> }).config;
					return { ...body, config: { ...config, topP: modelConfig.topP } };
				}
				return body;
			},
		});
		this.runtime = { model: runtime.model, streamFn, modelRuntime: runtime.modelRuntime };
		return createBusinessRuntime({
			workflow: this.workflow,
			registry: this.registry,
			engine: this.engine,
			baseWorkflowState,
			maxTurns: advancedConfig.maxIters ?? 12,
			toolNames: this.toolNames,
			skills: this.skills,
			keepToolNames: keepToolNamesFor(this.workflow, this.repo),
			// 三段可选的系统提示片段：
			//   ① Agent 人格指令（谁在说话）
			//   ② 知识库说明（能查什么）
			//   ③ 计划模式约束（这一轮怎么干活）——恢复会话与换模型时都必须带上，
			//      否则「开着计划模式的会话刷新一次就变回随便动手」。
			systemPromptExtras: [
				agentPromptOf(this.agentPrompt ?? undefined),
				kbDefaultHintOf(),
				planModePromptOf(this.planMode),
			].filter((text) => text.length > 0),
		});
	}

	/**
	 * 会话级换模型：只影响这一条会话，不动全局「当前模型」。
	 *
	 * 为什么不能只改全局：全局 current 回答的是「新建会话用哪条模型」，一旦被当成「切换模型」用，
	 * 用户在这条对话里点一下，别的会话下一轮也跟着换——那是串台，不是切换。
	 *
	 * Pi 原生模型运行时可直接切换；其它模型通过更新业务运行配置并让 Pi adapter 懒重建会话。
	 * 历史由 Pi SessionManager 持有，切换模型不会复制 transcript；技能按原样重放。
	 * 审批挂起挂在会话对象上，也不受重建影响。
	 *
	 * 上一轮还在跑时拒绝：半路换模型会让同一轮里前后两次请求用不同模型。
	 */

	/**
	 * 计划模式开关：会话级，落进 payload 才能跨重启保持。
	 *
	 * 计划约束属于业务运行时 system prompt；变更后释放当前 Pi runtime，下一轮由 Pi adapter 用同一历史树重建。
	 * 审批与 SSE 挂在会话对象上，不受重建影响。
	 */
	setPlanMode(enabled: boolean): SessionView {
		if (this.running) {
			throw new Error("这条对话正在执行中，等它跑完再切换计划模式");
		}
		this.planMode = enabled;
		this.rebuildBusinessRuntime();
		this.emit({ type: "plan", planMode: this.planMode, at: Date.now() });
		this.persist();
		return this.view();
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<SessionView> {
		const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		if (!levels.includes(level)) throw new Error("不支持的推理强度");
		if (this.running) throw new Error("这条对话正在执行中，等它跑完再调整推理强度");
		const pi = await this.ensurePiRuntime();
		if (this.disposed) throw new Error("会话已销毁");
		if (!pi.setThinkingLevel) throw new Error("当前 Pi 会话不支持调整推理强度");
		pi.setThinkingLevel(level);
		this.thinkingLevel = level;
		this.persist();
		this.emit({ type: "thinking_level", thinkingLevel: level, at: Date.now() });
		return this.view();
	}

	async piStats(): Promise<PiSessionStats> {
		const pi = await this.ensurePiRuntime();
		const { userMessages, assistantMessages, toolCalls, toolResults, totalMessages, tokens, cost, contextUsage } = pi.stats();
		return { userMessages, assistantMessages, toolCalls, toolResults, totalMessages, tokens, cost, ...(contextUsage ? { contextUsage } : {}) };
	}

	piTree() {
		return piSessionTreeView(this.piHistory);
	}

	derivePiHistory(mode: "fork" | "clone", sessionId: string, entryId?: string) {
		if (this.running || this.pendingApprovals.size > 0) {
			throw new PiSessionError("对话正在执行或等待审批，暂时不能创建 Pi 分支", 409, "pi_session_derivation_busy");
		}
		try {
			return derivePiSessionHistory(this.piHistory, mode, sessionId, entryId);
		} catch (error) {
			throw new PiSessionError(error instanceof Error ? error.message : String(error), 400, "pi_session_derivation_invalid");
		}
	}

	async navigatePiTree(entryId: string): Promise<{ tree: ReturnType<Session["piTree"]>; editorText?: string; session: SessionView }> {
		if (this.running || this.pendingApprovals.size > 0) {
			throw new PiSessionError("对话正在执行或等待审批，暂时不能切换 Pi 分支", 409, "pi_tree_navigation_busy");
		}
		if (!this.piHistory.getEntry(entryId)) {
			throw new PiSessionError("Pi 会话节点不存在", 404, "pi_tree_entry_not_found");
		}
		const pi = await this.ensurePiRuntime();
		const result = await pi.navigateTree(entryId);
		if (result.cancelled) throw new PiSessionError("Pi 分支切换已取消", 409, "pi_tree_navigation_cancelled");
		this.restorePiBusinessState();
		this.transcript.splice(0, this.transcript.length, ...transcriptOfPiBranch(this.piHistory.getBranch()));
		const latestSummary = [...this.piHistory.getBranch()].reverse().find((entry) => entry.type === "compaction" || entry.type === "branch_summary");
		this.summary = latestSummary?.summary ?? null;
		this.compactedAt = latestSummary ? Date.parse(latestSummary.timestamp) || null : null;
		this.compactedAutomatically = latestSummary?.type === "compaction";
		this.refreshEstimatedContext();
		this.persist();
		return { tree: this.piTree(), ...(result.editorText !== undefined ? { editorText: result.editorText } : {}), session: this.view() };
	}

	isRunning(): boolean {
		return this.running;
	}

	setPiTreeLabel(entryId: string, label: string | null) {
		if (this.running) throw new Error("这条对话正在执行中，等它完成后再编辑会话标签");
		if (typeof entryId !== "string" || !this.piHistory.getEntry(entryId)) {
			throw new Error("Pi 会话节点不存在");
		}
		if (label !== null && typeof label !== "string") throw new Error("标签必须是文本或空值");
		const normalized = label?.trim() ?? "";
		if (normalized.length > 80) throw new Error("标签不能超过 80 个字符");
		this.piHistory.appendLabelChange(entryId, normalized || undefined);
		this.persist();
		return this.piTree();
	}

	/** Run Pi's native manual compaction against the current session branch. */
	async compact(): Promise<{ before: number; after: number; kept: number; summary: string; automatic: boolean }> {
		if (this.running) {
			throw new Error("这条对话正在执行中，等它跑完再压缩");
		}
		if (!this.liveRuntimeFor()) {
			throw new Error("当前会话没有可用的真实模型，无法执行 Pi 上下文压缩");
		}
		this.running = true;
		this.emit({ type: "busy", running: true });
		try {
			const pi = await this.ensurePiRuntime();
			if (this.stopRequested || this.disposed) {
				await pi.abort();
				throw new Error(this.disposed ? "会话已销毁" : "压缩已取消");
			}
			const before = this.piHistory.buildSessionContext().messages.length;
			const result = await pi.compact();
			const after = this.piHistory.buildSessionContext().messages.length;
			return {
				before,
				after,
				kept: Math.max(0, after - 1),
				summary: result.summary,
				automatic: false,
			};
		} finally {
			this.running = false;
			this.persist();
			this.emit({ type: "busy", running: false });
		}
	}

	/** 当前会话真实生效的运行时；模拟模式返回 null。 */
	private liveRuntimeFor(): LlmRuntime | null {
		if (this.mode !== "live") {
			return null;
		}
		const selected = this.modelKey ?? this.modelId ?? undefined;
		const resolved = this.resolveModel?.(selected);
		return resolved === undefined ? resolveLlm(selected) : resolved;
	}

	private disposePiRuntime(): void {
		this.unsubscribeAgent?.();
		this.unsubscribeAgent = undefined;
		this.piRuntime?.dispose();
		this.piRuntime = null;
	}

	dispose(): void {
		this.disposed = true;
		for (const requestId of this.pendingApprovals.keys()) {
			this.resolveApproval(requestId, false);
		}
		if (this.piRuntime) void this.piRuntime.abort();
		this.disposePiRuntime();
	}

	async shutdown(): Promise<void> {
		this.disposed = true;
		for (const requestId of this.pendingApprovals.keys()) {
			this.resolveApproval(requestId, false);
		}
		this.unsubscribeAgent?.();
		this.unsubscribeAgent = undefined;
		const runtime = this.piRuntime;
		this.piRuntime = null;
		if (!runtime) return;
		await runtime.abort().catch(() => {});
		await runtime.shutdown();
	}

	async reloadPiResources(): Promise<{ session: SessionView; piSkills: string[] }> {
		if (this.running || this.compacting) throw new Error("这条对话正在执行中，等它完成后再刷新 Pi 资源");
		if (this.piResourceReload) return this.piResourceReload;
		this.piResourceReload = (async () => {
			this.refreshSkills();
			const runtime = this.piRuntime;
			this.piRuntime = null;
			this.unsubscribeAgent?.();
			this.unsubscribeAgent = undefined;
			if (runtime) await runtime.shutdown();
			const refreshed = await this.ensurePiRuntime();
			this.persist();
			return { session: this.view(), piSkills: refreshed.piSkills() };
		})();
		try {
			return await this.piResourceReload;
		} finally {
			this.piResourceReload = null;
		}
	}

	/** Rebuild business policy and let the Pi adapter recreate its runtime from the same session tree. */
	private rebuildBusinessRuntime(messages?: AgentMessage[]): number {
		const runtime = this.mode === "live" ? this.liveRuntimeFor() : this.runtime;
		if (!runtime) return this.runtimeMessages().length;
		const count = (messages ?? this.runtimeMessages()).length;
		this.disposePiRuntime();
		this.built = this.createBusinessRuntime(runtime);
		this.refreshEstimatedContext();
		if (this.activeSkillId !== null) {
			const state = structuredClone(this.engine.state);
			this.activateSkill(this.activeSkillId);
			this.engine.reset(this.engine.definition, state);
		}
		return count;
	}
	async setModel(modelId: string): Promise<SessionView> {
		const key = modelId.trim();
		if (key.length === 0) {
			throw new Error("modelId 不能为空");
		}
		if (this.running) {
			throw new Error("这条对话正在执行中，等它跑完再换模型");
		}

		// `undefined` = 库里不认识 → 交回 .env（与建会话时同一套解析语义，不另造规则）
		const injected = this.resolveModel?.(key);
		const live = injected === undefined ? resolveLlm(key) : injected;
		if (!live) {
			// 模拟模式下仍保存用户选择，方便查看对应上下文配置并在接入真实运行时后生效。
			// 会话的 mode/modeLabel 保持 simulated，不能让选择状态冒充真实模型已经接入。
			const selectedKey = this.resolveModelKeyFn?.(key) ?? null;
			if (this.mode === "simulated" && selectedKey) {
				this.modelKey = selectedKey;
				this.persist();
				return this.view();
			}
			throw new Error("这个模型当前不可用（可能已停用，或供应商配置不完整）");
		}

		const preparedModel = live.prepareModel ? await live.prepareModel : live.model;
		if (this.mode === "live" && this.modelId === live.modelId && this.runtime.model.provider === preparedModel.provider) {
			this.modelKey = this.resolveModelKeyFn?.(key) ?? this.modelKey;
			this.modelId = live.modelId;
			this.modeLabel = live.label;
			this.persist();
			return this.view();
		}
		if (live.modelRuntime && live.prepareModel) {
			const pi = await this.ensurePiRuntime();
			await pi.setModel(preparedModel);
			this.runtime = { ...live, model: preparedModel };
			this.modelId = live.modelId;
			this.mode = "live";
			this.modeLabel = live.label;
			this.modelKey = this.resolveModelKeyFn?.(key) ?? null;
			this.thinkingLevel = pi.getThinkingLevel?.() ?? this.thinkingLevel;
			this.persist();
			return this.view();
		}
		const sameRuntime = this.mode === "live" && this.runtime.model.id === live.modelId && this.runtime.model.provider === live.provider;
		if (sameRuntime) {
			this.modelKey = this.resolveModelKeyFn?.(key) ?? this.modelKey;
			this.modelId = live.modelId;
			this.modeLabel = live.label;
			this.persist();
			return this.view();
		}
		// Rebuild business configuration; Pi recreates the AgentSession from the persisted tree on demand.
		const previousProvider = this.runtime.model.provider;
		this.built = this.createBusinessRuntime(live);
		if (this.piHistory.getHeader() && this.modelId && (this.modelId !== live.modelId || previousProvider !== live.provider)) {
			this.piHistory.appendModelChange(live.provider, live.modelId);
		}
		this.disposePiRuntime();
		this.refreshEstimatedContext();
		if (this.activeSkillId !== null) {
			const state = structuredClone(this.engine.state);
			this.activateSkill(this.activeSkillId);
			this.engine.reset(this.engine.definition, state);
		}
		// runtime 三个字段跟着新运行时走，否则视图与落库记的还是旧模型
		this.modelId = live.modelId;
		this.mode = "live";
		this.modeLabel = live.label;
		this.modelKey = this.resolveModelKeyFn?.(key) ?? null;
		this.persist();
		return this.view();
	}

	/** 写入存储层（SQLite 或 Postgres，由 openStore 决定）。 */
	private persist(): void {
		if (this.disposed) return;
		this.updatedAt = Date.now();
		this.db.save({
			id: this.id,
			internalGroupSession: this.internalGroupSession,
			workflowId: this.workflow.id,
			modelId: this.modelId,
			modelKey: this.modelKey,
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
			piSessionEntries: serializePiSessionHistory(this.piHistory) as unknown[],
			piSessionLeafId: piSessionLeafIdOf(this.piHistory),
			activeSkillId: this.activeSkillId,
			baseWorkflowState: this.built.baseWorkflowState(),
			createdBy: this.createdBy,
			traceIds: [...this.traceIds],
			agentId: this.agentId,
			agentName: this.agentName,
			agentConfig: this.agentConfig,
			piAutoCompactionEnabled: this.autoCompactionEnabled,
			planMode: this.planMode,
			thinkingLevel: this.thinkingLevel,
			compactedAt: this.compactedAt,
			compactedAutomatically: this.compactedAutomatically,
			summary: this.summary,
			contextTokens: this.contextTokens,
			contextTokensEstimated: this.contextTokensEstimated,
		});
	}

	assertChattable(): void {
		if (this.agentId && this.db.getAgent(this.agentId)?.status === "stopped") {
			throw new AgentError("该 Agent 已停用，无法对话", 409, "stopped_not_chattable");
		}
	}

	stop(): boolean {
		if (!this.running) return false;
		this.stopRequested = true;
		for (const requestId of this.pendingApprovals.keys()) {
			this.resolveApproval(requestId, false);
		}
		if (this.piRuntime) void this.piRuntime.abort();
		return true;
	}

	async send(text: string): Promise<void> {
		try { this.assertChattable(); } catch (error) {
			this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (this.running) {
			if (!this.piRuntime || this.compacting || this.stopRequested || this.disposed) {
				this.emit({ type: "error", message: "当前会话暂时不能排队，请稍后重试" });
				return;
			}
			try {
				await this.piRuntime.followUp(text);
				this.transcript.push({ role: "user", text, at: Date.now(), tools: [] });
				this.persist();
			} catch (error) {
				this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		this.running = true;
		this.stopRequested = false;
		this.currentTurnStartedAt = Date.now();
		this.emit({ type: "busy", running: true });
		// 往归档会话里发消息 = 它又活过来了，自动取消归档（落库在 finally 里统一做）
		this.archived = false;
		const turnEntry: TranscriptEntry = { role: "user", text, at: Date.now(), tools: [] };
		this.currentTurnEntry = turnEntry;
		this.transcript.push(turnEntry);

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
			const pi = await this.ensurePiRuntime();
			if (this.stopRequested || this.disposed) {
				await pi.abort();
				failure = this.disposed ? "会话已销毁" : "请求被中断";
				return;
			}
			await pi.prompt(text);
			if (this.built.limitReached()) {
				throw new Error(`已达到最大推理轮数（${this.agentConfig.advancedConfig.maxIters ?? 12}），本轮已停止，请缩小任务范围后重试`);
			}

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
			if (this.currentTurnEntry) this.currentTurnEntry.durationMs = Math.max(0, Date.now() - this.currentTurnStartedAt);
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
			this.currentTurnEntry = null;
			this.currentTurnStartedAt = 0;
		}
	}

	view(): SessionView {
		return {
			pendingApprovals: this.pendingApprovalViews(),
			id: this.id,
			workflowId: this.workflow.id,
			workflowName: this.workflow.name,
			mode: this.mode,
			modeLabel: this.modeLabel,
			modelId: this.modelId,
			modelKey: this.modelKey,
			contextTokens: this.contextTokens,
			contextTokensEstimated: this.contextTokensEstimated,
			permissionMode: this.permissionMode,
			title: this.title,
			archived: this.archived,
			running: this.running,
			...this.workflowView(),
			tools: [...this.toolNames, "tool_search"],
			skills: skillViewsFor(this.repo, this.activeSkillId),
			activeSkillId: this.activeSkillId,
		queuedFollowUps: this.piRuntime?.session.getFollowUpMessages().slice() ?? [...this.queuedFollowUps],
			traceIds: [...this.traceIds],
			agentId: this.agentId,
			agentName: this.agentName,
			planMode: this.planMode,
			thinkingLevel: this.thinkingLevel,
			compactedAt: this.compactedAt,
			compactedAutomatically: this.compactedAutomatically,
			summary: this.summary,
			createdAt: this.createdAt,
			updatedAt: this.updatedAt,
			audit: this.auditLog,
			transcript: this.transcript,
			restored: this.restored,
		};
	}

	exportPiJsonl(): string {
		return `${serializePiSessionBranch(this.piHistory).map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	}

	async exportPiHtml(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "biz-agent-pi-html-"));
		const sessionPath = join(directory, "session.jsonl");
		const outputPath = join(directory, "session.html");
		try {
			const jsonl = serializePiSessionBranch(this.piHistory).map((entry) => JSON.stringify(entry)).join("\n");
			await writeFile(sessionPath, `${jsonl}\n`, "utf8");
			const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
			const exportModulePath = join(dirname(packageEntry), "core", "export-html", "index.js");
			const { exportFromFile } = await import(pathToFileURL(exportModulePath).href) as { exportFromFile(inputPath: string, outputPath: string): Promise<string> };
			await exportFromFile(sessionPath, outputPath);
			return await readFile(outputPath, "utf8");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
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
		/**
		 * 把模型名归一成模型行 id（会话级换模型要落库记「选的是哪一行」）。
		 *
		 * 放在最后而不是 resolveModel 旁边：这是后加的注入点，插在前面会改掉既有调用点的
		 * 第二个参数含义（`smoke` / `scripts` 里有直接 `new SessionHub(db, repo, resolveModel, obs)` 的写法）。
		 */
		private readonly resolveModelKeyFn?: SessionModelKeyResolver,
		private readonly mcpRegistry?: McpRegistry,
	) {}

	create(
		workflowId: string,
		options: {
			modelId?: string;
			internalGroupSession?: boolean;
			ownerId?: string | null;
			agent?: SessionAgent;
		} = {},
	): Session {
		const workflow = this.repo.get(workflowId);
		if (!workflow) {
			const broken = this.repo.errorOf(workflowId);
			throw new Error(broken ? `流程定义已失效（${workflowId}）：${broken}` : `未知流程: ${workflowId}`);
		}
		const session = new Session(workflow, {
			db: this.db,
			repo: this.repo,
			modelId: options.modelId,
			internalGroupSession: options.internalGroupSession,
			ownerId: options.ownerId,
			agent: options.agent,
			observability: this.observability,
			resolveModel: this.resolveModel,
			resolveModelKey: this.resolveModelKeyFn,
			mcpRegistry: this.mcpRegistry,
		});
		this.sessions.set(session.id, session);
		return session;
	}

	derive(
		sourceId: string,
		mode: "fork" | "clone",
		options: { entryId?: string; ownerId?: string | null } = {},
	): { session: Session; editorText?: string } {
		const source = this.get(sourceId);
		const record = this.db.load(sourceId);
		if (!source || !record) throw new Error("session not found");
		const id = randomUUID().slice(0, 8);
		const history = source.derivePiHistory(mode, id, options.entryId);
		const createdAt = Date.now();
		const derived: PersistedSession = {
			...record,
			id,
			title: null,
			archived: false,
			createdAt,
			updatedAt: createdAt,
			done: false,
			transcript: [],
			audit: [],
			traceIds: [],
			createdBy: options.ownerId ?? null,
			piSessionEntries: history.entries,
			piSessionLeafId: history.leafId,
			contextTokens: 0,
			contextTokensEstimated: true,
		};
		const workflow = this.repo.get(record.workflowId);
		if (!workflow) throw new Error(`unknown workflow: ${record.workflowId}`);
		const session = new Session(workflow, {
			db: this.db,
			repo: this.repo,
			restore: derived,
			newlyDerived: true,
			agent: this.agentOf(record.agentId),
			observability: this.observability,
			resolveModel: this.resolveModel,
			resolveModelKey: this.resolveModelKeyFn,
			mcpRegistry: this.mcpRegistry,
		});
		this.sessions.set(session.id, session);
		return { session, ...(history.editorText !== undefined ? { editorText: history.editorText } : {}) };
	}

	/**
	 * 按 id 取 Agent 的运行期描述（人格 / 技能 / 知识库）。
	 *
	 * 三处都返回 undefined 而不是抛错：
	 * - 没绑定 Agent 的普通会话；
	 * - Agent 已被删掉的老会话——历史记录必须还能打开，不能因为配置没了就让它变成打不开的孤儿；
	 * - 存储层偶发读失败。
	 * 代价是这类会话退回默认人格（与加这个功能之前的行为一致），但对话本身照常可用。
	 */
	private agentOf(agentId: string | null | undefined): SessionAgent | undefined {
		const id = (agentId ?? "").trim();
		if (id.length === 0) {
			return undefined;
		}
		try {
			const record = this.db.getAgent(id);
			if (!record) {
				return undefined;
			}
			return {
				id: record.id,
				name: record.name,
				prompt: record.agentsMd,
				skillIds: record.skillIds,
				kbIds: record.kbIds,
				modelConfig: record.modelConfig,
				memoryConfig: record.memoryConfig,
				advancedConfig: record.advancedConfig,
			};
		} catch {
			return undefined;
		}
	}

	/**
	 * 只丢掉内存里那份，**不动存储**，让下一次 get() 走真实的恢复路径。
	 *
	 * 存在的理由只有一个：恢复逻辑（从 payload 重建 + 回查 Agent）在正常使用里
	 * 只在"页面刷新 / 服务重启"时走到，进程内测试够不着——而人格消失恰恰就发生在那里。
	 * 别拿它当"删除会话"用，那走 remove()。
	 */
	drop(id: string): boolean {
		const session = this.sessions.get(id);
		if (!session) return false;
		session.dispose();
		return this.sessions.delete(id);
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
		// 恢复时必须把 Agent 从库里捞回来：会话 payload 只存了 agentId，人格指令/技能/知识库
		// 都不在里面。不补这一步的话，刷新页面重进对话就退回通用默认人格——
		// 「点对话看到的是业务总管」就是这么来的（配置一直在库里，只是没被读出来）。
		const session = new Session(workflow, {
			db: this.db,
			repo: this.repo,
			restore: record,
			agent: this.agentOf(record.agentId),
			observability: this.observability,
			resolveModel: this.resolveModel,
			resolveModelKey: this.resolveModelKeyFn,
			mcpRegistry: this.mcpRegistry,
		});
		this.sessions.set(id, session);
		return session;
	}

	remove(id: string): boolean {
		this.sessions.get(id)?.dispose();
		this.sessions.delete(id);
		return this.db.remove(id);
	}

	/** 删除某个流程下的全部会话（删自定义流程时用；否则这些会话会因为找不到流程而从列表里凭空消失）。 */
	removeByWorkflow(workflowId: string): number {
		let removed = 0;
		for (const record of this.db.list()) {
			if (record.workflowId === workflowId) {
				this.sessions.get(record.id)?.dispose();
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
		for (const session of this.sessions.values()) session.dispose();
		this.sessions.clear();
		return this.db.clear();
	}

	/** Release live Pi sessions without deleting their persisted conversation history. */
	async shutdown(): Promise<void> {
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		await Promise.all(sessions.map((session) => session.shutdown()));
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
			if (record.internalGroupSession) continue;
			const view = viewFromRecord(record, this.repo);
			if (view) {
				views.set(view.id, view);
			}
		}
		for (const session of this.sessions.values()) {
			if (session.internalGroupSession) continue;
			views.set(session.id, session.view());
		}
		return [...views.values()].sort((a, b) => a.updatedAt - b.updatedAt);
	}
}
