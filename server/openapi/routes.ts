/**
 * 开放 API（P4）的 HTTP 入口：`/v1/health` 与 `/v1/chat`。
 *
 * 为什么单独一个模块：`/v1/*` 不走 JWT 守卫（Bearer 是 API Key），
 * 必须在 `server/index.ts` 的静态资源分支**之前**接管，否则会被当成静态文件 404。
 *
 * 统一错误形状：`{ error: { message, type, code } }`（message 中文），
 * 与 OpenAI 客户端习惯一致，调用方不用为每个接口写一套解析。
 *
 * 审计：`/v1/*` 的每个请求都写 `audit_logs`（actor_type="api_key"），
 * 每次都带一个随机 trace_id，响应头里也回 `x-trace-id` 方便对账。
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { bearerToken } from "../auth/jwt.js";
import { can, denyMessage } from "../auth/roles.js";
import type { AuthRuntime } from "../auth/service.js";
import type { Storage, StorageInfo } from "../db/types.js";
import type { ModelService } from "../models/service.js";
import type { ApiKeyService } from "../apiKeys/service.js";
import type { Session, SessionHub } from "../session.js";
import { buildPrompt, ChatRequestError, estimateTokens, parseChatRequest, runSessionTurn } from "./chat.js";

const V1_PREFIX = "/v1/";
const MAX_BODY_BYTES = 1024 * 1024;

/** 从 package.json 读版本（零依赖；读不到就退化成 0.0.0，不影响探针）。 */
const PACKAGE_VERSION = (() => {
	try {
		const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

export interface OpenApiContext {
	storage: Storage;
	auth: AuthRuntime;
	hub: SessionHub;
	models: ModelService;
	apiKeys: ApiKeyService;
	startedAt: number;
	storageInfo: StorageInfo;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		...headers,
	});
	res.end(payload);
}

function sendError(
	res: ServerResponse,
	status: number,
	type: string,
	code: string,
	message: string,
	headers: Record<string, string> = {},
): void {
	json(res, status, { error: { message, type, code } }, headers);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		total += buffer.length;
		if (total > MAX_BODY_BYTES) {
			throw new ChatRequestError("请求体超过 1 MB");
		}
		chunks.push(buffer);
	}
	if (total === 0) {
		return {};
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ChatRequestError("请求体不是合法 JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ChatRequestError("请求体必须是 JSON 对象");
	}
	return parsed as Record<string, unknown>;
}

function audit(
	ctx: OpenApiContext,
	entry: {
		action: string;
		actorId: string | null;
		targetType?: string | null;
		targetId?: string | null;
		detail: unknown;
		traceId: string;
	},
): void {
	try {
		ctx.auth.appendAudit({
			actorType: "api_key",
			actorId: entry.actorId,
			action: entry.action,
			targetType: entry.targetType ?? null,
			targetId: entry.targetId ?? null,
			detail: entry.detail,
			traceId: entry.traceId,
		});
	} catch (error) {
		// 审计写失败不能把已经发出去的响应搞坏（只打日志）
		console.error(`开放 API 审计落库失败: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function completionId(): string {
	return `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function secondsNow(): number {
	return Math.floor(Date.now() / 1000);
}

/** 非流式：等整轮跑完，一次性返回 OpenAI 形状。 */
async function completeChat(
	res: ServerResponse,
	ctx: OpenApiContext,
	session: Session,
	prompt: string,
	traceId: string,
	actorId: string | null,
	startedAt: number,
): Promise<void> {
	const result = await runSessionTurn(session, prompt);
	const latencyMs = Date.now() - startedAt;
	if (!result.ok) {
		sendError(res, 502, "server_error", "model_error", `模型调用失败：${result.message}`);
		audit(ctx, {
			action: "openapi.chat",
			actorId,
			targetType: "session",
			targetId: session.id,
			detail: { method: "POST", pathname: "/v1/chat", stream: false, ok: false, latencyMs },
			traceId,
		});
		return;
	}
	const promptTokens = estimateTokens(prompt);
	const completionTokens = estimateTokens(result.text);
	json(res, 200, {
		id: completionId(),
		object: "chat.completion",
		created: secondsNow(),
		model: session.modelId ?? "simulated",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: result.text },
				finish_reason: "stop",
			},
		],
		usage: {
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			total_tokens: promptTokens + completionTokens,
		},
		sessionId: session.id,
	});
	audit(ctx, {
		action: "openapi.chat",
		actorId,
		targetType: "session",
		targetId: session.id,
		detail: { method: "POST", pathname: "/v1/chat", stream: false, ok: true, latencyMs },
		traceId,
	});
}

// 非流式的失败一律 502：服务端已经接住了请求，是上游模型这一环失败。
// 调用点直接写 status 常量（见 completeChat），这里不再额外包一层。

/** 流式：先写 SSE 头，再把会话的 text 增量逐条转成 OpenAI chunk，最后 `[DONE]`。 */
async function streamChat(
	ctx: OpenApiContext,
	session: Session,
	prompt: string,
	traceId: string,
	actorId: string | null,
	startedAt: number,
	res: ServerResponse,
): Promise<void> {
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	let closed = false;
	// 用 res 的 close 判断"连接断了"，别用 req：请求体读完时 req 也可能 close，
	// 有些客户端还会带 Connection: close，用 req 会把正常响应当成客户端已断开。
	res.on("close", () => {
		closed = true;
	});
	const id = completionId();
	const created = secondsNow();
	const model = session.modelId ?? "simulated";
	const write = (payload: unknown): void => {
		if (closed) {
			return;
		}
		res.write(`data: ${JSON.stringify(payload)}\n\n`);
	};
	write({
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
		sessionId: session.id,
	});
	const result = await runSessionTurn(session, prompt, {
		onDelta: (delta) =>
			write({
				id,
				object: "chat.completion.chunk",
				created,
				model,
				choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
				sessionId: session.id,
			}),
	});
	if (!result.ok) {
		write({ error: { message: `模型调用失败：${result.message}`, type: "server_error", code: "model_error" } });
	} else {
		write({
			id,
			object: "chat.completion.chunk",
			created,
			model,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			sessionId: session.id,
		});
	}
	if (!closed) {
		res.write("data: [DONE]\n\n");
		res.end();
	}
	audit(ctx, {
		action: "openapi.chat",
		actorId,
		targetType: "session",
		targetId: session.id,
		detail: { method: "POST", pathname: "/v1/chat", stream: true, ok: result.ok, latencyMs: Date.now() - startedAt },
		traceId,
	});
}

async function handleChat(req: IncomingMessage, res: ServerResponse, ctx: OpenApiContext, traceId: string): Promise<void> {
	const startedAt = Date.now();
	const token = bearerToken(req.headers.authorization);
	const key = ctx.apiKeys.authenticate(token);
	if (!key) {
		sendError(res, 401, "authentication_error", "invalid_api_key", "API Key 无效或已停用", {
			"WWW-Authenticate": "Bearer",
		});
		audit(ctx, {
			action: "openapi.chat",
			actorId: null,
			detail: { method: "POST", pathname: "/v1/chat", status: 401, reason: "invalid_api_key" },
			traceId,
		});
		return;
	}
	if (!can(key.role, "session.run")) {
		sendError(res, 403, "permission_error", "forbidden", denyMessage(key.role, "session.run"));
		audit(ctx, {
			action: "openapi.chat",
			actorId: key.id,
			detail: { method: "POST", pathname: "/v1/chat", status: 403, role: key.role },
			traceId,
		});
		return;
	}
	const decision = ctx.apiKeys.checkRateLimit(key);
	if (!decision.allowed) {
		const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
		sendError(
			res,
			429,
			"rate_limit_error",
			"rate_limited",
			`请求太频繁，请在 ${retryAfterSeconds} 秒后再试`,
			{ "Retry-After": String(retryAfterSeconds) },
		);
		audit(ctx, {
			action: "openapi.chat",
			actorId: key.id,
			detail: {
				method: "POST",
				pathname: "/v1/chat",
				status: 429,
				rateLimitPerMin: key.rateLimitPerMin,
				retryAfterSeconds,
			},
			traceId,
		});
		return;
	}

	let body: Record<string, unknown>;
	try {
		body = await readJsonBody(req);
	} catch (error) {
		const message = error instanceof ChatRequestError ? error.message : "请求体读取失败";
		sendError(res, 400, "invalid_request_error", "invalid_request", message);
		audit(ctx, {
			action: "openapi.chat",
			actorId: key.id,
			detail: { method: "POST", pathname: "/v1/chat", status: 400, reason: "bad-body" },
			traceId,
		});
		return;
	}

	let session: Session;
	let prompt: string;
	let stream: boolean;
	try {
		const parsed = parseChatRequest(body);
		stream = parsed.stream;
		prompt = buildPrompt(parsed.messages, Boolean(parsed.sessionId));
		if (parsed.sessionId) {
			const existing = ctx.hub.get(parsed.sessionId);
			if (!existing) {
				sendError(res, 404, "not_found_error", "session_not_found", "会话不存在");
				audit(ctx, {
					action: "openapi.chat",
					actorId: key.id,
					targetType: "session",
					targetId: parsed.sessionId,
					detail: { method: "POST", pathname: "/v1/chat", status: 404, reason: "session-not-found" },
					traceId,
				});
				return;
			}
			session = existing;
		} else {
			// 不传 sessionId 就新开一个自动编排会话，用的就是"当前模型"
			session = ctx.hub.create("auto-flow", { modelId: ctx.models.currentModelKey() });
		}
	} catch (error) {
		const message = error instanceof ChatRequestError ? error.message : "创建会话失败";
		const status = error instanceof ChatRequestError ? 400 : 500;
		sendError(
			res,
			status,
			status === 400 ? "invalid_request_error" : "server_error",
			status === 400 ? "invalid_request" : "session_error",
			message,
		);
		audit(ctx, {
			action: "openapi.chat",
			actorId: key.id,
			detail: { method: "POST", pathname: "/v1/chat", status, reason: "session" },
			traceId,
		});
		return;
	}

	if (stream) {
		await streamChat(ctx, session, prompt, traceId, key.id, startedAt, res);
		return;
	}
	await completeChat(res, ctx, session, prompt, traceId, key.id, startedAt);
}

export async function handleOpenApiRoute(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	ctx: OpenApiContext,
): Promise<boolean> {
	const pathname = url.pathname;
	// `/v1` 本身（无子路径）也给 JSON 404，别掉进静态资源分支
	if (pathname !== "/v1" && !pathname.startsWith(V1_PREFIX)) {
		return false;
	}
	const method = req.method ?? "GET";
	const traceId = `trace-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
	res.setHeader("x-trace-id", traceId);

	try {
		if (pathname === "/v1/health") {
			if (method !== "GET") {
				sendError(res, 405, "invalid_request_error", "method_not_allowed", "只支持 GET");
				audit(ctx, {
					action: "openapi.health",
					actorId: null,
					detail: { method, pathname, status: 405 },
					traceId,
				});
				return true;
			}
			json(res, 200, {
				ok: true,
				version: PACKAGE_VERSION,
				model: ctx.models.healthModel(),
				storage: ctx.storageInfo,
				uptimeMs: Date.now() - ctx.startedAt,
			});
			audit(ctx, { action: "openapi.health", actorId: null, detail: { method, pathname, status: 200 }, traceId });
			return true;
		}

		if (pathname === "/v1/chat") {
			if (method !== "POST") {
				sendError(res, 405, "invalid_request_error", "method_not_allowed", "只支持 POST");
				audit(ctx, {
					action: "openapi.chat",
					actorId: null,
					detail: { method, pathname, status: 405 },
					traceId,
				});
				return true;
			}
			await handleChat(req, res, ctx, traceId);
			return true;
		}

		sendError(res, 404, "not_found_error", "not_found", `接口不存在：${pathname}`);
		audit(ctx, { action: "openapi.request", actorId: null, detail: { method, pathname, status: 404 }, traceId });
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`开放 API 出错: ${error instanceof Error ? error.stack ?? message : message}`);
		if (!res.headersSent) {
			sendError(res, 500, "server_error", "internal_error", `服务端内部错误：${message}`);
		} else {
			res.end();
		}
		audit(ctx, { action: "openapi.request", actorId: null, detail: { method, pathname, status: 500 }, traceId });
		return true;
	}
}
