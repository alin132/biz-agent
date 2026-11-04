/**
 * 开放 API 的 `/v1/chat`：把 OpenAI 形状的请求翻译成会话层的一次 `Session.send()`。
 *
 * 为什么复用会话层而不是另起一套模型调用：会话层已经封装了技能/工具/审批/审计/SSE，
 * 开放 API 只是换了一种"入口协议"，行为必须和控制台里聊天完全一致。
 *
 * 事件协议（`WireEvent`）是唯一真相（见 `server/session.ts`）：
 * - `text` → 增量正文（流式响应里的 delta）
 * - `done` → 本轮结束（带最终正文）
 * - `error` → 本轮失败
 */

import type { Session, WireEvent } from "../session.js";

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ParsedChatRequest {
	messages: ChatMessage[];
	stream: boolean;
	sessionId: string | null;
}

const ROLES = new Set(["system", "user", "assistant"]);
const MAX_MESSAGES = 200;
const MAX_CONTENT = 200_000;

export class ChatRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChatRequestError";
	}
}

/** 解析并校验请求体；不合法直接抛 ChatRequestError（路由统一转 400）。 */
export function parseChatRequest(body: Record<string, unknown>): ParsedChatRequest {
	const rawMessages = body.messages;
	if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
		throw new ChatRequestError("messages 必须是非空数组");
	}
	if (rawMessages.length > MAX_MESSAGES) {
		throw new ChatRequestError(`messages 最多 ${MAX_MESSAGES} 条`);
	}
	const messages: ChatMessage[] = [];
	for (const item of rawMessages) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new ChatRequestError("messages 的每一项必须是 { role, content } 对象");
		}
		const entry = item as Record<string, unknown>;
		const role = entry.role;
		if (typeof role !== "string" || !ROLES.has(role)) {
			throw new ChatRequestError("role 只能是 system / user / assistant");
		}
		const content = entry.content;
		if (typeof content !== "string" || content.trim().length === 0) {
			throw new ChatRequestError("每条 message 的 content 必须是非空字符串");
		}
		if (content.length > MAX_CONTENT) {
			throw new ChatRequestError(`单条 content 不能超过 ${MAX_CONTENT} 个字符`);
		}
		messages.push({ role: role as ChatMessage["role"], content });
	}
	if (!messages.some((message) => message.role === "user")) {
		throw new ChatRequestError("messages 里至少要有一条 user 消息");
	}
	if (body.sessionId !== undefined && body.sessionId !== null) {
		if (typeof body.sessionId !== "string" || body.sessionId.trim().length === 0) {
			throw new ChatRequestError("sessionId 必须是非空字符串");
		}
	}
	if (body.stream !== undefined && typeof body.stream !== "boolean") {
		throw new ChatRequestError("stream 必须是布尔值");
	}
	return {
		messages,
		stream: body.stream === true,
		sessionId: typeof body.sessionId === "string" ? body.sessionId.trim() : null,
	};
}

/**
 * 拼一次 prompt：
 * - 续聊（带 sessionId）只送最后一条 user 消息——历史已经在该会话的上下文里；
 * - 单条消息直接用原文；
 * - 多轮批量请求把角色前缀一起带上，让模型知道谁说了什么。
 */
export function buildPrompt(messages: ChatMessage[], hasSession: boolean): string {
	const lastUser = [...messages].reverse().find((message) => message.role === "user");
	if (!lastUser) {
		throw new ChatRequestError("messages 里至少要有一条 user 消息");
	}
	if (hasSession || messages.length === 1) {
		return lastUser.content;
	}
	const labels: Record<ChatMessage["role"], string> = { system: "System", user: "User", assistant: "Assistant" };
	return messages.map((message) => `${labels[message.role]}：${message.content}`).join("\n");
}

/** 估算用量：没有分词器，按 4 字符 ≈ 1 token 粗算（够 OpenAI 客户端展示）。 */
export function estimateTokens(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	return Math.max(1, Math.ceil(text.length / 4));
}

export type SessionTurnResult = { ok: true; text: string } | { ok: false; message: string };

export interface RunTurnOptions {
	/** 每个正文增量回调（流式响应写 SSE 用） */
	onDelta?: (delta: string) => void;
	timeoutMs?: number;
}

/**
 * 跑一轮并等结果。超时/失败都返回 `{ok:false}`，不抛——
 * 路由根据 `ok` 决定是写 JSON 错误还是 SSE 错误事件。
 */
export function runSessionTurn(session: Session, prompt: string, options: RunTurnOptions = {}): Promise<SessionTurnResult> {
	const timeoutMs = options.timeoutMs ?? 120_000;
	return new Promise<SessionTurnResult>((resolve) => {
		let text = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe: (() => void) | undefined;
		const finish = (result: SessionTurnResult): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			unsubscribe?.();
			resolve(result);
		};
		const listener = (event: WireEvent): void => {
			if (event.type === "text") {
				text += event.delta;
				options.onDelta?.(event.delta);
				return;
			}
			if (event.type === "done") {
				finish({ ok: true, text: event.text.length > 0 ? event.text : text });
				return;
			}
			if (event.type === "error") {
				finish({ ok: false, message: event.message });
			}
		};
		unsubscribe = session.subscribe(listener);
		timer = setTimeout(() => finish({ ok: false, message: "模型响应超时" }), timeoutMs);
		void session.send(prompt).catch((error: unknown) => {
			finish({ ok: false, message: error instanceof Error ? error.message : String(error) });
		});
	});
}
