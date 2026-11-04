/**
 * 开放 API 的 API Key 存储门面（P4）。
 *
 * 安全约定：
 * - 明文只在 `create()` 里生成并返回一次，库里只落 `sha256(key)`；
 * - 出参只给 `prefix`（明文前 8 位）方便人辨认，绝不能把 hash 或明文再吐出去；
 * - 吊销是软删除（`revokedAt` + `disabled`），保留线索供审计。
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { ApiKeyRecord, Role, Storage } from "../db/types.js";
import { isRole } from "../auth/roles.js";
import { safeEqualHex, sha256Hex } from "../models/crypto.js";

export class ApiKeyError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApiKeyError";
	}
}

/** 明文前缀：一眼能看出这是 biz-agent 的开放 API Key。 */
export const API_KEY_PREFIX = "bk_";
/** 随机部分 32 字节（base64url 后 43 个字符，可直接放进 Authorization 头）。 */
const KEY_RANDOM_BYTES = 32;
const MAX_NAME = 80;
const DEFAULT_RATE_LIMIT = 60;
const MAX_RATE_LIMIT = 6000;

export interface ApiKeyView {
	id: string;
	name: string;
	prefix: string;
	role: Role;
	rateLimitPerMin: number;
	disabled: boolean;
	revoked: boolean;
	revokedAt: number | null;
	lastUsedAt: number | null;
	createdAt: number;
}

/** 生成一把新 Key：明文 + 前缀 + sha256（三者同源，调用方只需要明文）。 */
export function generateApiKey(): { key: string; prefix: string; keyHash: string } {
	const key = `${API_KEY_PREFIX}${randomBytes(KEY_RANDOM_BYTES).toString("base64url")}`;
	return { key, prefix: key.slice(0, 8), keyHash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
	return sha256Hex(key);
}

function toView(record: ApiKeyRecord): ApiKeyView {
	return {
		id: record.id,
		name: record.name,
		prefix: record.prefix,
		role: record.role,
		rateLimitPerMin: record.rateLimitPerMin,
		disabled: record.disabled,
		revoked: record.revokedAt !== null,
		revokedAt: record.revokedAt,
		lastUsedAt: record.lastUsedAt,
		createdAt: record.createdAt,
	};
}

function parseName(value: unknown, fallback: string): string {
	if (value === undefined || value === null) {
		return fallback;
	}
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ApiKeyError(400, "API Key 名称不能为空");
	}
	const name = value.trim();
	if (name.length > MAX_NAME) {
		throw new ApiKeyError(400, `API Key 名称不能超过 ${MAX_NAME} 个字符`);
	}
	return name;
}

function parseRole(value: unknown, fallback: Role = "operator"): Role {
	if (value === undefined || value === null) {
		return fallback;
	}
	if (!isRole(value)) {
		throw new ApiKeyError(400, "角色只能是 owner / developer / operator / auditor");
	}
	return value;
}

function parseRateLimit(value: unknown, fallback: number): number {
	if (value === undefined || value === null) {
		return fallback;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > MAX_RATE_LIMIT) {
		throw new ApiKeyError(400, `rateLimitPerMin 必须是 1~${MAX_RATE_LIMIT} 的整数`);
	}
	return Math.trunc(value);
}

export class ApiKeyStore {
	constructor(private readonly storage: Storage) {}

	list(): ApiKeyView[] {
		return this.storage.listApiKeys().map(toView);
	}

	/** 创建：返回明文 `key`（**唯一一次**）与列表用的视图。 */
	create(body: Record<string, unknown>): { item: ApiKeyView; key: string } {
		const name = parseName(body.name, "未命名 API Key");
		const role = parseRole(body.role);
		const rateLimitPerMin = parseRateLimit(body.rateLimitPerMin, DEFAULT_RATE_LIMIT);
		const generated = generateApiKey();
		const record = this.storage.createApiKey({
			id: `key-${randomUUID().slice(0, 8)}`,
			name,
			prefix: generated.prefix,
			keyHash: generated.keyHash,
			role,
			rateLimitPerMin,
			disabled: false,
			lastUsedAt: null,
			createdAt: Date.now(),
			revokedAt: null,
		});
		return { item: toView(record), key: generated.key };
	}

	update(id: string, body: Record<string, unknown>): ApiKeyView {
		const current = this.storage.listApiKeys().find((record) => record.id === id);
		if (!current) {
			throw new ApiKeyError(404, "API Key 不存在");
		}
		if (current.revokedAt !== null) {
			throw new ApiKeyError(409, "这个 API Key 已吊销，不能再修改");
		}
		const patch: Parameters<Storage["updateApiKey"]>[1] = {};
		if ("name" in body) {
			patch.name = parseName(body.name, current.name);
		}
		if ("role" in body) {
			patch.role = parseRole(body.role, current.role);
		}
		if ("rateLimitPerMin" in body) {
			patch.rateLimitPerMin = parseRateLimit(body.rateLimitPerMin, current.rateLimitPerMin);
		}
		if ("disabled" in body) {
			if (typeof body.disabled !== "boolean") {
				throw new ApiKeyError(400, "disabled 必须是布尔值");
			}
			patch.disabled = body.disabled;
		}
		const updated = this.storage.updateApiKey(id, patch);
		if (!updated) {
			throw new ApiKeyError(404, "API Key 不存在");
		}
		return toView(updated);
	}

	/** 吊销（软删除）：之后用这把 Key 一律 401，但记录仍可在列表/审计里看到。 */
	revoke(id: string): ApiKeyView {
		const current = this.storage.listApiKeys().find((record) => record.id === id);
		if (!current) {
			throw new ApiKeyError(404, "API Key 不存在");
		}
		if (current.revokedAt !== null) {
			return toView(current);
		}
		const updated = this.storage.updateApiKey(id, { revokedAt: Date.now(), disabled: true });
		if (!updated) {
			throw new ApiKeyError(404, "API Key 不存在");
		}
		return toView(updated);
	}

	/**
	 * Bearer 令牌 → 可用 Key。停用/吊销/不存在都返回 null（路由统一 401，不告诉调用方是哪一步错）。
	 * 命中后顺手更新 last_used_at，管理页能看到"最近使用"。
	 */
	authenticate(rawToken: string | null): ApiKeyRecord | null {
		if (!rawToken || !rawToken.startsWith(API_KEY_PREFIX)) {
			return null;
		}
		const expected = hashApiKey(rawToken);
		const record = this.storage.getApiKeyByHash(expected);
		// 再做一次常数时间的哈希比对：即便将来 DAO 换成"按 prefix 查再比对"，这里也不会退化成 ==
		if (!record || !safeEqualHex(record.keyHash, expected)) {
			return null;
		}
		if (record.disabled || record.revokedAt !== null) {
			return null;
		}
		try {
			this.storage.touchApiKey(record.id, Date.now());
		} catch {
			// 更新时间失败不影响本次鉴权
		}
		return record;
	}
}
