/**
 * API Key 运行时：存储门面 + 令牌桶限流。
 *
 * 令牌桶而不是固定窗口：开放 API 的调用往往是"闲一阵、突刺一阵"，
 * 令牌桶允许在 rateLimitPerMin 的容量内突发，又不会因为窗口边界被刷两倍流量。
 *
 * 容量 = `rateLimitPerMin`，每 `60000 / rateLimitPerMin` 毫秒回一个令牌。
 * 状态全在内存（单实例部署；重启清零，与登录限流一致）。
 */

import type { ApiKeyRecord, Storage } from "../db/types.js";
import { ApiKeyStore } from "./store.js";
import type { ApiKeyView } from "./store.js";

export interface RateLimitDecision {
	allowed: boolean;
	/** 被限流时还要等多久（毫秒），用来算 `Retry-After` */
	retryAfterMs: number;
	remaining: number;
}

interface BucketState {
	tokens: number;
	updatedAt: number;
}

export class TokenBucketLimiter {
	private readonly buckets = new Map<string, BucketState>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	take(key: string, limitPerMinute: number): RateLimitDecision {
		const capacity = Math.max(1, Math.trunc(limitPerMinute));
		const at = this.now();
		const refillPerMs = capacity / 60_000;
		const state = this.buckets.get(key);
		let tokens = capacity;
		if (state) {
			tokens = Math.min(capacity, state.tokens + Math.max(0, at - state.updatedAt) * refillPerMs);
		}
		if (tokens >= 1) {
			tokens -= 1;
			this.buckets.set(key, { tokens, updatedAt: at });
			return { allowed: true, retryAfterMs: 0, remaining: Math.floor(tokens) };
		}
		const retryAfterMs = Math.ceil((1 - tokens) / refillPerMs);
		this.buckets.set(key, { tokens, updatedAt: at });
		return { allowed: false, retryAfterMs, remaining: 0 };
	}

	/** 清一个 key 的桶（测试/运维用）；不传就全清。 */
	reset(key?: string): void {
		if (key === undefined) {
			this.buckets.clear();
			return;
		}
		this.buckets.delete(key);
	}

	size(): number {
		return this.buckets.size;
	}
}

export interface ApiKeyServiceOptions {
	/** 注入时钟（令牌桶测试用） */
	now?: () => number;
}

export class ApiKeyService {
	readonly store: ApiKeyStore;
	readonly limiter: TokenBucketLimiter;

	constructor(storage: Storage, options: ApiKeyServiceOptions = {}) {
		this.store = new ApiKeyStore(storage);
		this.limiter = new TokenBucketLimiter(options.now);
	}

	list(): ApiKeyView[] {
		return this.store.list();
	}

	create(body: Record<string, unknown>): { item: ApiKeyView; key: string } {
		return this.store.create(body);
	}

	update(id: string, body: Record<string, unknown>): ApiKeyView {
		return this.store.update(id, body);
	}

	revoke(id: string): ApiKeyView {
		return this.store.revoke(id);
	}

	authenticate(rawToken: string | null): ApiKeyRecord | null {
		return this.store.authenticate(rawToken);
	}

	/** 按这把 Key 的 `rateLimitPerMin` 走令牌桶。 */
	checkRateLimit(record: ApiKeyRecord): RateLimitDecision {
		return this.limiter.take(record.id, record.rateLimitPerMin);
	}
}

export function createApiKeyService(storage: Storage, options: ApiKeyServiceOptions = {}): ApiKeyService {
	return new ApiKeyService(storage, options);
}
