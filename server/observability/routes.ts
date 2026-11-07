/**
 * 监控接口（P9）：`/api/monitor/*`。
 *
 * 权限分两层：
 *   1. `server/auth/roles.ts` 的 `permissionFor()` 把 summary 映射到 `session.read`
 *      （四种角色都能看首页），把 traces 映射到 `audit.read`（operator 在 guard 层就 403）；
 *   2. 这里再按角色收窄：developer 只能看**自己创建的会话**的调用链，owner / auditor 看全部。
 *      会话的创建者记在 `PersistedSession.createdBy`（P9 新增的 payload 字段，不需要迁移）。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRuntime, AuthUser } from "../auth/service.js";
import type { Storage, TraceFilter, TraceSummaryRecord } from "../db/types.js";
import { parseRange } from "./trace.js";
import type { Observability } from "./collector.js";

export interface MonitorRouteContext {
	observability: Observability;
	storage: Storage;
	auth: AuthRuntime;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
	const value = raw === null ? Number.NaN : Number(raw);
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(Math.max(Math.trunc(value), min), max);
}

/** 该用户创建的会话 id（developer 看调用链时收窄范围用）。 */
function ownedSessionIds(storage: Storage, userId: string): Set<string> {
	const ids = new Set<string>();
	for (const record of storage.list()) {
		if (record.createdBy === userId) {
			ids.add(record.id);
		}
	}
	return ids;
}

/** 列表项：ms 表示整轮耗时；running 时为 null。 */
function toTraceItem(trace: TraceSummaryRecord): Record<string, unknown> {
	return {
		traceId: trace.id,
		sessionId: trace.sessionId,
		startedAt: trace.startedAt,
		finishedAt: trace.finishedAt,
		ms: trace.finishedAt === null ? null : trace.finishedAt - trace.startedAt,
		status: trace.status,
		model: trace.model,
		toolCount: trace.toolCount,
		...(trace.error ? { error: trace.error } : {}),
	};
}

function toTraceDetail(trace: TraceSummaryRecord): Record<string, unknown> {
	return {
		...toTraceItem(trace),
		workflowId: trace.workflowId,
		skillId: trace.skillId,
	};
}

export async function handleMonitorRoute(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	ctx: MonitorRouteContext,
): Promise<boolean> {
	const pathname = url.pathname;
	if (pathname !== "/api/monitor" && !pathname.startsWith("/api/monitor/")) {
		return false;
	}
	const method = req.method ?? "GET";
	if (method !== "GET") {
		sendJson(res, 405, { error: "监控接口只支持 GET" });
		return true;
	}

	const actor: AuthUser | null = ctx.auth.userOf(req) ?? ctx.auth.authenticate(req);
	if (!actor) {
		sendJson(res, 401, { error: "未登录或登录已过期" });
		return true;
	}

	/* ---------------- GET /api/monitor/summary ---------------- */
	if (pathname === "/api/monitor/summary") {
		const window = parseRange(url.searchParams.get("range"));
		if (!window) {
			sendJson(res, 400, { error: "range 写法不对，只支持 30m / 1h / 24h / 7d 这类「数字 + s/m/h/d」" });
			return true;
		}
		sendJson(res, 200, ctx.observability.summary(window.value));
		return true;
	}

	/* ---------------- GET /api/monitor/traces ---------------- */
	if (pathname === "/api/monitor/traces") {
		// guard 已经把 operator 挡在外面；这里只处理"developer 只能看自己的会话"
		const owned = actor.role === "developer" ? ownedSessionIds(ctx.storage, actor.id) : null;
		const sessionId = (url.searchParams.get("sessionId") ?? "").trim();
		if (owned && sessionId.length > 0 && !owned.has(sessionId)) {
			sendJson(res, 403, { error: "当前角色是开发者，只能查看自己创建的会话的调用链" });
			return true;
		}
		const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
		const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
		const filter: TraceFilter = { limit, offset };
		if (url.searchParams.has("range")) {
			const window = parseRange(url.searchParams.get("range"));
			if (!window) {
				sendJson(res, 400, { error: "时间范围不合法" });
				return true;
			}
			filter.to = Date.now();
			filter.from = filter.to - window.ms;
		}
		if (sessionId.length > 0) {
			filter.sessionId = sessionId;
		} else if (owned) {
			filter.sessionIds = [...owned];
		}
		const items = ctx.observability.listTraces(filter).map(toTraceItem);
		const total = ctx.observability.countTraces({
			...(filter.from !== undefined ? { from: filter.from, to: filter.to } : {}),
			...(filter.sessionId ? { sessionId: filter.sessionId } : {}),
			...(filter.sessionIds ? { sessionIds: filter.sessionIds } : {}),
		});
		sendJson(res, 200, { total, items });
		return true;
	}

	/* ---------------- GET /api/monitor/traces/:id ---------------- */
	const detail = /^\/api\/monitor\/traces\/([^/]+)$/.exec(pathname);
	if (detail) {
		let traceId: string;
		try {
			traceId = decodeURIComponent(detail[1]!);
		} catch {
			sendJson(res, 400, { error: "调用链 id 不是合法的 URL 编码" });
			return true;
		}
		const trace = ctx.observability.getTrace(traceId);
		if (!trace) {
			sendJson(res, 404, { error: "调用链不存在" });
			return true;
		}
		if (actor.role === "developer") {
			const owned = ownedSessionIds(ctx.storage, actor.id);
			if (!trace.sessionId || !owned.has(trace.sessionId)) {
				sendJson(res, 403, { error: "当前角色是开发者，只能查看自己创建的会话的调用链" });
				return true;
			}
		}
		const events = ctx.observability.listTraceEvents(traceId).map((event) => ({
			seq: event.seq,
			kind: event.kind,
			name: event.name,
			ok: event.ok,
			ms: event.ms,
			payload: event.payload,
		}));
		sendJson(res, 200, { trace: toTraceDetail(trace), events });
		return true;
	}

	// /api/monitor 本身与未知子路径：别掉回静态资源分支
	if (pathname === "/api/monitor" || pathname.startsWith("/api/monitor/")) {
		sendJson(res, 404, { error: "not found" });
		return true;
	}
	return false;
}
