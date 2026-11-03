/**
 * 会话层：把一次"人机对话"包成可被 HTTP 订阅的对象，并落 SQLite。
 *
 * 持久化内容：对话文本、审计流水、流程进度、业务数据、以及 Pi 的 AgentMessage 上下文。
 * 所以服务重启后既能看到历史，也能接着聊（模型不会忘记前文）。
 */

import { randomUUID } from "node:crypto";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { ToolRegistry } from "../src/core/registry.js";
import { createBusinessAgent } from "../src/core/runtime.js";
import type { AuditEntry, ApprovalRequest, BizContext, WorkflowDef } from "../src/core/types.js";
import { WorkflowEngine } from "../src/core/workflow.js";
import { createStore } from "../src/store/memory.js";
import type { Store } from "../src/store/memory.js";
import { createApprovalTools } from "../src/tools/approval.js";
import { createDataTools } from "../src/tools/data.js";
import { createTicketTools } from "../src/tools/ticket.js";
import { approvalWorkflow } from "../src/workflows/approval.js";
import { dataWorkflow } from "../src/workflows/data.js";
import { ticketWorkflow } from "../src/workflows/ticket.js";
import type { PersistedSession, SessionDb, TranscriptEntry } from "./db.js";
import { createSimulatedRuntime } from "./demoScripts.js";
import { resolveLlm } from "./llm.js";

export const WORKFLOWS: Record<string, WorkflowDef> = {
	"ticket-flow": ticketWorkflow,
	"data-flow": dataWorkflow,
	"approval-flow": approvalWorkflow,
};

export type PermissionMode = "full" | "readonly";

/** 前端消费的事件协议。 */
export type WireEvent =
	| { type: "ready"; session: SessionView }
	| { type: "text"; delta: string }
	| { type: "tool_start"; id: string; name: string; args: unknown }
	| { type: "tool_end"; id: string; name: string; ok: boolean; result: string; durationMs?: number }
	| { type: "audit"; entry: AuditEntry }
	| { type: "approval"; requestId: string; toolName: string; args: unknown; risk: string }
	| { type: "workflow"; steps: StepView[]; current: number; done: boolean }
	| { type: "done"; text: string }
	| { type: "error"; message: string }
	| { type: "busy"; running: boolean };

export interface StepView {
	id: string;
	title: string;
	status: "done" | "active" | "pending";
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
	running: boolean;
	steps: StepView[];
	current: number;
	done: boolean;
	createdAt: number;
	updatedAt: number;
	audit: AuditEntry[];
	transcript: TranscriptEntry[];
	/** 是否从 SQLite 恢复的历史会话 */
	restored: boolean;
}

function createRegistry(workflowId: string, store: Store): ToolRegistry {
	const registry = new ToolRegistry();
	switch (workflowId) {
		case "ticket-flow":
			registry.registerAll(createTicketTools(store));
			break;
		case "data-flow":
			registry.registerAll(createDataTools(store));
			break;
		case "approval-flow":
			registry.registerAll(createApprovalTools(store));
			break;
		default:
			throw new Error(`未知流程: ${workflowId}`);
	}
	return registry;
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
function viewFromRecord(record: PersistedSession): SessionView | null {
	const workflow = WORKFLOWS[record.workflowId];
	if (!workflow) {
		return null;
	}
	const current = record.workflow?.stepIndex ?? 0;
	return {
		id: record.id,
		workflowId: record.workflowId,
		workflowName: workflow.name,
		mode: record.mode,
		modeLabel: record.modeLabel,
		modelId: record.modelId,
		permissionMode: record.permissionMode,
		running: false,
		steps: stepsFor(workflow, current),
		current,
		done: record.done,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		audit: record.audit ?? [],
		transcript: record.transcript ?? [],
		restored: true,
	};
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

	private readonly db: SessionDb;
	private readonly agent: Agent;
	private readonly ctx: BizContext;
	private readonly registry: ToolRegistry;
	private readonly toolNames: string[];
	private permissionMode: PermissionMode = "full";
	private readonly subscribers = new Set<(event: WireEvent) => void>();
	private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
	private approvalSeq = 0;
	private running = false;
	private updatedAt: number;

	constructor(
		workflow: WorkflowDef,
		options: { db: SessionDb; modelId?: string; restore?: PersistedSession },
	) {
		this.db = options.db;
		this.workflow = workflow;
		const restored = options.restore;

		this.id = restored?.id ?? randomUUID().slice(0, 8);
		this.createdAt = restored?.createdAt ?? Date.now();
		this.updatedAt = restored?.updatedAt ?? this.createdAt;
		this.restored = Boolean(restored);

		this.store = restored?.store ?? createStore();
		this.engine = new WorkflowEngine(workflow, restored?.workflow);
		this.registry = createRegistry(workflow.id, this.store);
		this.toolNames = [...new Set(workflow.steps.flatMap((step) => step.via))];

		// 历史会话只在原本就是真实模型时才尝试复用真实模型，避免历史配置漂移
		const allowLive = restored ? restored.mode === "live" : true;
		const preferredModelId = restored?.modelId ?? options.modelId ?? undefined;
		const live = allowLive ? resolveLlm(preferredModelId) : null;
		const runtime = live ?? createSimulatedRuntime(workflow, this.engine);

		this.mode = live ? "live" : "simulated";
		this.modeLabel = live?.label ?? "模拟模型";
		this.modelId = live?.modelId ?? null;

		if (restored) {
			this.permissionMode = restored.permissionMode ?? "full";
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
		});
		this.agent = built.agent;

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
				case "tool_execution_start":
					this.emit({ type: "tool_start", id: event.toolCallId, name: event.toolName, args: event.args });
					break;
				case "tool_execution_end":
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
		return { steps: stepsFor(this.workflow, current), current, done: this.engine.done };
	}

	private lastAssistantText(): string {
		const messages = this.agent.state.messages;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]!;
			if (message.role === "assistant") {
				return message.content
					.filter((block) => block.type === "text")
					.map((block) => (block as { text: string }).text)
					.join("");
			}
		}
		return "";
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

	private awaitApproval(request: ApprovalRequest): Promise<boolean> {
		this.approvalSeq++;
		const requestId = `apv-${this.approvalSeq}`;
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
		resolver(approved);
		return true;
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

	/** 写入 SQLite。 */
	private persist(): void {
		this.updatedAt = Date.now();
		this.db.save({
			id: this.id,
			workflowId: this.workflow.id,
			modelId: this.modelId,
			mode: this.mode,
			modeLabel: this.modeLabel,
			permissionMode: this.permissionMode,
			createdAt: this.createdAt,
			updatedAt: this.updatedAt,
			done: this.engine.done,
			transcript: this.transcript,
			audit: this.auditLog,
			workflow: this.engine.state,
			store: this.store,
			agentMessages: this.agent.state.messages as unknown[],
		});
	}

	async send(text: string): Promise<void> {
		if (this.running) {
			this.emit({ type: "error", message: "上一轮还在执行中，请稍候" });
			return;
		}

		this.running = true;
		this.emit({ type: "busy", running: true });
		this.transcript.push({ role: "user", text, at: Date.now() });

		try {
			await this.agent.prompt(text);

			const last = this.lastAssistantMessage();
			if (last && (last.stopReason === "error" || last.stopReason === "aborted")) {
				const reason = last.stopReason === "aborted" ? "请求被中断" : "模型调用失败";
				const detail = last.errorMessage ?? "服务端未返回具体原因";
				this.emit({ type: "error", message: `${reason}：${detail}` });
				return;
			}

			const reply = this.lastAssistantText();
			this.transcript.push({ role: "assistant", text: reply, at: Date.now() });
			this.emit({ type: "done", text: reply });
		} catch (error) {
			this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
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
			running: this.running,
			...this.workflowView(),
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
	private readonly db: SessionDb;

	constructor(db: SessionDb) {
		this.db = db;
	}

	create(workflowId: string, options: { modelId?: string } = {}): Session {
		const workflow = WORKFLOWS[workflowId];
		if (!workflow) {
			throw new Error(`未知流程: ${workflowId}`);
		}
		const session = new Session(workflow, { db: this.db, modelId: options.modelId });
		this.sessions.set(session.id, session);
		return session;
	}

	/** 内存优先；没有则从 SQLite 恢复。 */
	get(id: string): Session | undefined {
		const cached = this.sessions.get(id);
		if (cached) {
			return cached;
		}
		const record = this.db.load(id);
		if (!record) {
			return undefined;
		}
		const workflow = WORKFLOWS[record.workflowId];
		if (!workflow) {
			return undefined;
		}
		const session = new Session(workflow, { db: this.db, restore: record });
		this.sessions.set(id, session);
		return session;
	}

	remove(id: string): boolean {
		this.sessions.delete(id);
		return this.db.remove(id);
	}

	clear(): number {
		this.sessions.clear();
		return this.db.clear();
	}

	list(): SessionView[] {
		const views = new Map<string, SessionView>();
		for (const record of this.db.list()) {
			const view = viewFromRecord(record);
			if (view) {
				views.set(view.id, view);
			}
		}
		for (const session of this.sessions.values()) {
			views.set(session.id, session.view());
		}
		return [...views.values()].sort((a, b) => a.updatedAt - b.updatedAt);
	}

	/** 列出可选流程（给前端下拉用）。 */
	static catalog(): { id: string; name: string; steps: { id: string; title: string }[] }[] {
		return Object.values(WORKFLOWS).map((workflow) => ({
			id: workflow.id,
			name: workflow.name,
			steps: workflow.steps.map((step) => ({ id: step.id, title: step.title })),
		}));
	}
}
