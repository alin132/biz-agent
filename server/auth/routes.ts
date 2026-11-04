/**
 * 认证与审计接口：`/api/auth/*` 与 `/api/audit`。
 *
 * 为什么单独一个文件：`server/index.ts` 是 400 多行的零框架路由，P3 只在它里面加
 * 「一行鉴权 + 一行分发」，具体逻辑放这儿，避免把主文件撑大。
 *
 * 出参统一 `{ ... }` / 出错 `{ error }`，与现有接口一致；状态码：
 *   200 成功 / 201 已创建 / 400 入参不合法 / 401 未登录或口令错 / 403 角色不够 / 409 邮箱已存在 / 429 限流
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuditLogRecord, UserPatch } from "../db/types.js";
import { can, denyMessage, permissionsOf, ROLE_LABELS } from "./roles.js";
import type { AuthRuntime, AuthUser } from "./service.js";

/** 与 index.ts 的 `json()` 同样的出参格式（那边是内部函数，不导出；这里复制一份更简单）。 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

/** 读 JSON 请求体；空体当 `{}`，坏 JSON 当 400（返回 null 由调用方处理）。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	if (raw.length === 0) {
		return {};
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** 客户端 IP：优先反向代理头，其次 socket（限流 key 用，不要求精确）。 */
export function clientIp(req: IncomingMessage): string {
	const forwarded = req.headers["x-forwarded-for"];
	const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
	if (typeof first === "string" && first.trim().length > 0) {
		return first.split(",")[0]!.trim();
	}
	return req.socket?.remoteAddress ?? "unknown";
}

/** 对外用户视图：绝不带 passwordHash；disabled/createdAt/lastLoginAt 是成员页要展示的观测字段。 */
function publicUser(user: AuthUser): {
	id: string;
	email: string;
	name: string | null;
	role: string;
	disabled: boolean;
	createdAt: number;
	lastLoginAt: number | null;
} {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role,
		disabled: user.disabled,
		createdAt: user.createdAt,
		lastLoginAt: user.lastLoginAt,
	};
}

/**
 * 处理 `/api/auth/*` 与 `/api/audit`；返回 `true` 表示这个请求已被接管。
 *
 * 注意：`/api/auth/login|logout` 在 `index.ts` 的鉴权里是公开路径；
 * `/api/auth/me`、`/api/auth/users`、`/api/audit` 自己验令牌与角色（`/api/audit` 的
 * 权限校验其实已经由 guard 做过一次，这里再兜一层，免得以后调整顺序漏掉）。
 */
export async function handleAuthRoute(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	auth: AuthRuntime,
): Promise<boolean> {
	const pathname = url.pathname;
	const method = req.method ?? "GET";

	/* ---------------- POST /api/auth/login ---------------- */
	if (pathname === "/api/auth/login") {
		if (method !== "POST") {
			sendJson(res, 405, { error: "只支持 POST" });
			return true;
		}
		const body = await readJsonBody(req);
		if (!body) {
			sendJson(res, 400, { error: "请求体不是合法 JSON" });
			return true;
		}
		const outcome = auth.login(String(body.email ?? ""), String(body.password ?? ""), clientIp(req));
		if (!outcome.ok) {
			sendJson(res, outcome.status, { error: outcome.error });
			return true;
		}
		// 登录就把 mode / permissions 一起给出去：前端登录后不必再等一次 /api/auth/me 才知道按钮该不该置灰
		sendJson(res, 200, {
			token: outcome.token,
			user: publicUser(outcome.user),
			mode: auth.mode,
			permissions: permissionsOf(outcome.user.role),
		});
		return true;
	}

	/* ---------------- POST /api/auth/logout ---------------- */
	if (pathname === "/api/auth/logout") {
		if (method !== "POST") {
			sendJson(res, 405, { error: "只支持 POST" });
			return true;
		}
		// 无状态 JWT：这里不维护黑名单，只记一条审计并让前端清掉本地 token
		const user = auth.userOf(req) ?? auth.authenticate(req);
		if (user) {
			auth.appendAudit({ actorType: "user", actorId: user.id, action: "auth.logout", targetType: "user", targetId: user.id });
		}
		sendJson(res, 200, { ok: true });
		return true;
	}

	/* ---------------- GET /api/auth/me ---------------- */
	if (pathname === "/api/auth/me") {
		if (method !== "GET") {
			sendJson(res, 405, { error: "只支持 GET" });
			return true;
		}
		// AUTH_MODE=off 时 guard 已经挂了演示所有者，前端不必先登录
		const user = auth.userOf(req) ?? auth.authenticate(req);
		if (!user) {
			sendJson(res, 401, { error: "未登录或登录已过期" });
			return true;
		}
		sendJson(res, 200, {
			mode: auth.mode,
			user: publicUser(user),
			permissions: permissionsOf(user.role),
		});
		return true;
	}

	/* ---------------- GET/POST /api/auth/users（成员管理） ---------------- */
	if (pathname === "/api/auth/users") {
		const actor = auth.userOf(req) ?? auth.authenticate(req);
		if (!actor) {
			sendJson(res, 401, { error: "未登录或登录已过期" });
			return true;
		}
		if (!can(actor.role, "member.manage")) {
			sendJson(res, 403, { error: denyMessage(actor.role, "member.manage") });
			return true;
		}

		if (method === "GET") {
			sendJson(res, 200, {
				items: auth.listUsers().map((user) => ({ ...publicUser(user), roleLabel: ROLE_LABELS[user.role] })),
			});
			return true;
		}

		if (method === "POST") {
			const body = await readJsonBody(req);
			if (!body) {
				sendJson(res, 400, { error: "请求体不是合法 JSON" });
				return true;
			}
			const result = auth.createUser({
				email: String(body.email ?? ""),
				password: String(body.password ?? ""),
				role: String(body.role ?? "developer") as AuthUser["role"],
				name: typeof body.name === "string" ? body.name : null,
			});
			if (!result.ok) {
				sendJson(res, result.status, { error: result.error });
				return true;
			}
			auth.appendAudit({
				actorType: "user",
				actorId: actor.id,
				action: "user.create",
				targetType: "user",
				targetId: result.user.id,
				detail: { email: result.user.email, role: result.user.role },
			});
			sendJson(res, 201, { user: publicUser(result.user) });
			return true;
		}

		sendJson(res, 405, { error: "只支持 GET / POST" });
		return true;
	}

	/* ---------------- PATCH/DELETE /api/auth/users/:id（成员写接口） ---------------- */
	const memberMatch = /^\/api\/auth\/users\/([^/]+)$/.exec(pathname);
	if (memberMatch) {
		const actor = auth.userOf(req) ?? auth.authenticate(req);
		if (!actor) {
			sendJson(res, 401, { error: "未登录或登录已过期" });
			return true;
		}
		if (!can(actor.role, "member.manage")) {
			sendJson(res, 403, { error: denyMessage(actor.role, "member.manage") });
			return true;
		}
		let id: string;
		try {
			id = decodeURIComponent(memberMatch[1]!);
		} catch {
			sendJson(res, 400, { error: "成员 id 不合法" });
			return true;
		}

		if (method === "PATCH") {
			const body = await readJsonBody(req);
			if (!body) {
				sendJson(res, 400, { error: "请求体不是合法 JSON" });
				return true;
			}
			// 三个字段都可选，但至少给一个：空 PATCH 只会白写一条审计
			if (body.role === undefined && body.disabled === undefined && body.name === undefined) {
				sendJson(res, 400, { error: "至少要传一个要修改的字段（role / disabled / name）" });
				return true;
			}
			// 这里只做形状搬运，合法性/保护规则由 service.updateMember 统一判定
			const patch: UserPatch = {};
			if (body.role !== undefined) patch.role = body.role as AuthUser["role"];
			if (body.disabled !== undefined) patch.disabled = body.disabled as boolean;
			if (body.name !== undefined) patch.name = body.name as string | null;
			const result = auth.updateMember(id, patch, actor.id);
			if (!result.ok) {
				sendJson(res, result.status, { error: result.error });
				return true;
			}
			sendJson(res, 200, {
				user: { ...publicUser(result.user), roleLabel: ROLE_LABELS[result.user.role] },
			});
			return true;
		}

		if (method === "DELETE") {
			const result = auth.removeMember(id, actor.id);
			if (!result.ok) {
				sendJson(res, result.status, { error: result.error });
				return true;
			}
			sendJson(res, 200, { removed: true });
			return true;
		}

		sendJson(res, 405, { error: "只支持 PATCH / DELETE" });
		return true;
	}

	/* ---------------- GET /api/audit ---------------- */
	if (pathname === "/api/audit") {
		if (method !== "GET") {
			sendJson(res, 405, { error: "只支持 GET" });
			return true;
		}
		const actor = auth.userOf(req) ?? auth.authenticate(req);
		if (!actor) {
			sendJson(res, 401, { error: "未登录或登录已过期" });
			return true;
		}
		if (!can(actor.role, "audit.read")) {
			sendJson(res, 403, { error: denyMessage(actor.role, "audit.read") });
			return true;
		}

		const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
		const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
		const action = (url.searchParams.get("action") ?? "").trim();
		const actorId = (url.searchParams.get("actor") ?? "").trim();
		const actorType = (url.searchParams.get("actorType") ?? "").trim();
		const targetType = (url.searchParams.get("targetType") ?? "").trim();
		// q 只做动作/目标的模糊匹配，长度上限防止拿超长串扫全表
		const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
		const from = parseTimeParam(url.searchParams.get("from"));
		if (from === null) {
			sendJson(res, 400, { error: "from 不是合法时间（支持毫秒时间戳或 ISO 时间字符串）" });
			return true;
		}
		const to = parseTimeParam(url.searchParams.get("to"));
		if (to === null) {
			sendJson(res, 400, { error: "to 不是合法时间（支持毫秒时间戳或 ISO 时间字符串）" });
			return true;
		}
		// 只把真正传了的条件放进 filter：DAO 用"字段存在"判断是否追加 WHERE
		const filter = {
			...(action ? { action } : {}),
			...(actorId ? { actor: actorId } : {}),
			...(actorType ? { actorType } : {}),
			...(targetType ? { targetType } : {}),
			...(q ? { q } : {}),
			...(from !== undefined ? { from } : {}),
			...(to !== undefined ? { to } : {}),
		};
		const items: AuditLogRecord[] = auth.listAudit({ limit, offset, ...filter });
		const total = auth.countAudit(filter);
		sendJson(res, 200, { total, limit, offset, items });
		return true;
	}

	return false;
}

/** 解析并夹取整数（`limit` / `offset` 这类查询参数）。 */
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
	const value = raw === null ? Number.NaN : Number(raw);
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * 审计时间过滤参数：支持毫秒时间戳（`1767225600000`）与 ISO 时间（`2026-01-01T00:00:00Z`）。
 * 返回 `undefined` = 没传；`null` = 传了但解析不了（路由层转 400）。
 */
function parseTimeParam(raw: string | null): number | undefined | null {
	const value = (raw ?? "").trim();
	if (value.length === 0) {
		return undefined;
	}
	if (/^\d+$/.test(value)) {
		const numeric = Number(value);
		return Number.isSafeInteger(numeric) ? numeric : null;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}
