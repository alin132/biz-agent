/**
 * 极简 JWT（HS256）：`header.payload.signature`，用 `node:crypto` 的 HMAC-SHA256 手写。
 *
 * 不引 jsonwebtoken —— 我们要的只有"签发 / 验签 / 过期"三件事，几十行就够，
 * 而且能把 base64url、签名比较、过期判定这些安全细节都用 `timingSafeEqual` 写清楚。
 *
 * 密钥优先级见 `service.ts`：AUTH_SECRET > 环境（含 .env）> 启动时随机生成。
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Role } from "../db/types.js";

/** 默认有效期 8 小时（工人一个班次的量级）。 */
export const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

const HEADER = { alg: "HS256", typ: "JWT" } as const;

export interface TokenClaims {
	/** 用户 id */
	sub: string;
	role: Role;
	workspace_id: string;
	email?: string;
	/** 签发时间（秒） */
	iat: number;
	/** 过期时间（秒） */
	exp: number;
}

export type TokenVerifyResult =
	| { ok: true; claims: TokenClaims }
	| { ok: false; reason: "malformed" | "bad-signature" | "expired" };

export interface SignOptions {
	ttlSeconds?: number;
	/** 注入当前时间（测试过期用），默认 Date.now() */
	now?: number;
}

function base64url(value: string | Buffer): string {
	return (typeof value === "string" ? Buffer.from(value, "utf8") : value).toString("base64url");
}

function signatureOf(signingInput: string, secret: string): string {
	return createHmac("sha256", secret).update(signingInput, "utf8").digest("base64url");
}

/** 签发令牌；`exp = iat + ttl`。 */
export function signToken(
	payload: { sub: string; role: Role; workspace_id: string; email?: string },
	secret: string,
	options: SignOptions = {},
): string {
	const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
	const claims: TokenClaims = {
		sub: payload.sub,
		role: payload.role,
		workspace_id: payload.workspace_id,
		...(payload.email ? { email: payload.email } : {}),
		iat: nowSeconds,
		exp: nowSeconds + (options.ttlSeconds ?? DEFAULT_TTL_SECONDS),
	};
	const signingInput = `${base64url(JSON.stringify(HEADER))}.${base64url(JSON.stringify(claims))}`;
	return `${signingInput}.${signatureOf(signingInput, secret)}`;
}

/**
 * 验签 + 过期判定。任何异常都收敛成 `{ ok: false, reason }`，调用方只需要回 401，
 * 不要区分"签名错"还是"格式错"给客户端看（那是给攻击者的信息）。
 */
export function verifyToken(token: string, secret: string, options: { now?: number } = {}): TokenVerifyResult {
	const parts = token.split(".");
	if (parts.length !== 3) {
		return { ok: false, reason: "malformed" };
	}
	const [header, payload, signature] = parts as [string, string, string];
	if (!header || !payload || !signature) {
		return { ok: false, reason: "malformed" };
	}

	const expected = signatureOf(`${header}.${payload}`, secret);
	const given = Buffer.from(signature, "utf8");
	const wanted = Buffer.from(expected, "utf8");
	if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
		return { ok: false, reason: "bad-signature" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch {
		return { ok: false, reason: "malformed" };
	}
	if (!parsed || typeof parsed !== "object") {
		return { ok: false, reason: "malformed" };
	}
	const claims = parsed as Partial<TokenClaims>;
	if (typeof claims.sub !== "string" || typeof claims.role !== "string" || typeof claims.exp !== "number") {
		return { ok: false, reason: "malformed" };
	}

	const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
	if (claims.exp <= nowSeconds) {
		return { ok: false, reason: "expired" };
	}
	return {
		ok: true,
		claims: {
			sub: claims.sub,
			role: claims.role as Role,
			workspace_id: typeof claims.workspace_id === "string" ? claims.workspace_id : "default",
			...(typeof claims.email === "string" ? { email: claims.email } : {}),
			iat: typeof claims.iat === "number" ? claims.iat : 0,
			exp: claims.exp,
		},
	};
}

/** 从 `Authorization` 头里取 token；没有/格式不对返回 null。 */
export function bearerToken(header: string | undefined): string | null {
	if (typeof header !== "string") {
		return null;
	}
	const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
	return match ? match[1]! : null;
}

/** 只取 payload（不校验签名）—— 仅用于日志/调试，别拿它做鉴权。 */
export function peekClaims(token: string): Partial<TokenClaims> | null {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) {
		return null;
	}
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Partial<TokenClaims>;
	} catch {
		return null;
	}
}
