import { createHash } from "node:crypto";
import {
	SessionManager,
	parseSessionEntries,
	type FileEntry,
	type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const PI_BUSINESS_STATE_TYPE = "biz-agent.runtime-state.v1";

export interface CreatePiSessionHistoryOptions {
	sessionId: string;
	cwd?: string;
	agentMessages?: unknown[];
	piSessionEntries?: unknown[];
	piSessionLeafId?: string | null;
}

/** Pi accepts a narrower session ID alphabet than biz-agent; keep an invalid ID deterministic. */
export function piSessionIdOf(sessionId: string): string {
	if (PI_SESSION_ID_PATTERN.test(sessionId)) return sessionId;
	const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
	return `biz-${digest}`;
}

function parseStoredEntries(entries: unknown[]): FileEntry[] {
	if (entries.length === 0) return [];
	const jsonl = entries.map((entry) => JSON.stringify(entry)).join("\n");
	return parseSessionEntries(jsonl);
}

/** Build a Pi session tree from persisted Pi entries or import a legacy AgentMessage transcript. */
export function createPiSessionHistory(options: CreatePiSessionHistoryOptions): SessionManager {
	const cwd = options.cwd ?? process.cwd();
	const parsed = options.piSessionEntries?.length ? parseStoredEntries(options.piSessionEntries) : undefined;
	const entries = parsed?.some((entry) => Boolean(entry && typeof entry === "object" && "type" in entry && entry.type === "session"))
		? parsed
		: undefined;
	const manager = SessionManager.inMemory(cwd, { id: piSessionIdOf(options.sessionId) }, entries);

	if (!entries) {
		for (const candidate of options.agentMessages ?? []) {
			if (!candidate || typeof candidate !== "object" || !("role" in candidate)) continue;
			const message = candidate as AgentMessage;
			// The active system prompt is assembled by biz-agent for each runtime, not conversation history.
			if (message.role === "system") continue;
			manager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
		}
	} else if (options.piSessionLeafId && manager.getEntry(options.piSessionLeafId)) {
		manager.branch(options.piSessionLeafId);
	}

	return manager;
}

/** Return a JSON-safe snapshot including the Pi session header and append-only entries. */
export function serializePiSessionHistory(manager: SessionManager): FileEntry[] {
	const header = manager.getHeader();
	if (!header) throw new Error("Pi session history is missing its session header");
	return [header, ...manager.getEntries()];
}

/** Serialize the active branch like Pi's CLI export, re-linking it as a linear history. */
export function serializePiSessionBranch(manager: SessionManager): FileEntry[] {
	const header = manager.getHeader();
	if (!header) throw new Error("Pi session history is missing its session header");
	let parentId: string | null = null;
	const branch = manager.getBranch().map((entry) => {
		const linked = { ...entry, parentId };
		parentId = entry.id;
		return linked;
	});
	return [header, ...branch];
}

export function derivePiSessionHistory(
	manager: SessionManager,
	mode: "fork" | "clone",
	sessionId: string,
	entryId?: string,
): { entries: FileEntry[]; leafId: string | null; editorText?: string } {
	const header = manager.getHeader();
	if (!header) throw new Error("Pi session history is missing its session header");
	let branch = manager.getBranch();
	let editorText: string | undefined;
	if (mode === "fork") {
		if (!entryId) throw new Error("fork 必须指定用户消息节点");
		const target = manager.getEntry(entryId);
		if (!target || target.type !== "message" || target.message.role !== "user") {
			throw new Error("只能从 Pi 用户消息节点分叉");
		}
		branch = manager.getBranch(entryId).slice(0, -1);
		const content = target.message.content;
		editorText = typeof content === "string"
			? content
			: content.filter((block) => block.type === "text").map((block) => block.text).join("");
	}
	let parentId: string | null = null;
	const entries = branch.map((entry) => {
		const linked = { ...entry, parentId };
		parentId = entry.id;
		return linked;
	});
	const nextHeader = {
		...header,
		id: piSessionIdOf(sessionId),
		timestamp: new Date().toISOString(),
		parentSession: header.id,
	};
	return { entries: [nextHeader, ...entries], leafId: parentId, ...(editorText !== undefined ? { editorText } : {}) };
}

export function piSessionLeafIdOf(manager: SessionManager): string | null {
	return manager.getLeafId();
}

export interface PiSessionTreeNodeView {
	id: string;
	type: string;
	parentId: string | null;
	timestamp: string;
	label: string;
	bookmark: string | null;
	preview: string;
	active: boolean;
	children: PiSessionTreeNodeView[];
}

function textPreview(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.map((part) => {
		if (!part || typeof part !== "object") return "";
		const block = part as { type?: unknown; text?: unknown; name?: unknown };
		if ((block.type === "text" || block.type === "thinking") && typeof block.text === "string") return block.text;
		if (block.type === "toolCall" && typeof block.name === "string") return `调用工具：${block.name}`;
		return "";
	}).filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 180);
}

function entryPreview(entry: SessionTreeNode["entry"]): { label: string; preview: string } {
	if (entry.type === "message") {
		const message = entry.message;
		const role = message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : message.role === "toolResult" ? "工具结果" : "扩展消息";
		const content = "content" in message ? textPreview(message.content) : "";
		return { label: role, preview: content || (message.role === "toolResult" ? `工具：${message.toolName}` : "（无文本内容）") };
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") return { label: entry.type === "compaction" ? "上下文压缩" : "分支摘要", preview: entry.summary.slice(0, 180) };
	if (entry.type === "model_change") return { label: "模型切换", preview: `${entry.provider} · ${entry.modelId}` };
	if (entry.type === "thinking_level_change") return { label: "推理强度", preview: entry.thinkingLevel };
	if (entry.type === "session_info") return { label: "会话名称", preview: entry.name ?? "（已清空）" };
	if (entry.type === "custom_message") return { label: entry.customType, preview: textPreview(entry.content) };
	if (entry.type === "custom") return { label: entry.customType, preview: "自定义会话标记" };
	if (entry.type === "usage") return { label: "用量记录", preview: `${entry.provider} · ${entry.model}` };
	if (entry.type === "label") return { label: "书签", preview: entry.label ?? "（已移除）" };
	if (entry.type === "context_edit") return { label: "上下文编辑", preview: entry.replacement ? "替换了历史上下文" : "从上下文中隐藏" };
	return { label: "会话记录", preview: "" };
}

/** A privacy-limited view of Pi's actual session tree for the browser UI. */
export function piSessionTreeView(manager: SessionManager): { leafId: string | null; nodes: PiSessionTreeNodeView[] } {
	const active = new Set(manager.getBranch().map((entry) => entry.id));
	const mapNodes = (nodes: SessionTreeNode[]): PiSessionTreeNodeView[] => nodes.flatMap((node) => {
		const { entry } = node;
		if (entry.type === "custom" && entry.customType === PI_BUSINESS_STATE_TYPE) return mapNodes(node.children);
		const preview = entryPreview(entry);
		return [{
			id: entry.id,
			type: entry.type,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			label: preview.label,
			bookmark: node.label ?? null,
			preview: preview.preview,
			active: active.has(entry.id),
			children: mapNodes(node.children),
		}];
	});
	return { leafId: manager.getLeafId(), nodes: mapNodes(manager.getTree()) };
}
