/**
 * 登录限流：同一「邮箱 + IP」连续失败 5 次锁 5 分钟。
 *
 * 内存 Map 即可（单实例部署；重启清零 —— 重启本身已经让爆破变贵了）。
 * 每次 `check()` 顺手清理过期项，避免长期运行把 Map 撑大。
 */

export interface RateLimitState {
	/** 当前窗口内已失败次数 */
	failures: number;
	/** 锁定到什么时候（毫秒时间戳）；0 表示没锁 */
	lockedUntil: number;
	/** 窗口起点 */
	firstFailedAt: number;
}

export interface RateLimitDecision {
	blocked: boolean;
	/** 还要等多久（毫秒）；没锁则为 0 */
	retryAfterMs: number;
}

export interface RateLimitOptions {
	maxFailures?: number;
	windowMs?: number;
	/** 注入时钟（测试窗口滑动用） */
	now?: () => number;
}

export class LoginRateLimiter {
	private readonly buckets = new Map<string, RateLimitState>();
	private readonly maxFailures: number;
	private readonly windowMs: number;
	private readonly now: () => number;

	constructor(options: RateLimitOptions = {}) {
		this.maxFailures = options.maxFailures ?? 5;
		this.windowMs = options.windowMs ?? 5 * 60 * 1000;
		this.now = options.now ?? Date.now;
	}

	/** 失败次数（测试与日志用）。 */
	failuresOf(key: string): number {
		this.sweep();
		return this.buckets.get(key)?.failures ?? 0;
	}

	/** 现在能不能试。 */
	check(key: string): RateLimitDecision {
		this.sweep();
		const state = this.buckets.get(key);
		if (!state) {
			return { blocked: false, retryAfterMs: 0 };
		}
		const at = this.now();
		if (state.lockedUntil > at) {
			return { blocked: true, retryAfterMs: state.lockedUntil - at };
		}
		return { blocked: false, retryAfterMs: 0 };
	}

	/** 记一次失败；到阈值就锁窗口。 */
	fail(key: string): RateLimitState {
		const at = this.now();
		const state = this.buckets.get(key);
		if (!state || at - state.firstFailedAt > this.windowMs) {
			const fresh: RateLimitState = { failures: 1, lockedUntil: 0, firstFailedAt: at };
			if (fresh.failures >= this.maxFailures) {
				fresh.lockedUntil = at + this.windowMs;
			}
			this.buckets.set(key, fresh);
			return fresh;
		}
		state.failures += 1;
		if (state.failures >= this.maxFailures) {
			state.lockedUntil = at + this.windowMs;
		}
		return state;
	}

	/** 登录成功：清掉这个 key 的所有记录。 */
	succeed(key: string): void {
		this.buckets.delete(key);
	}

	/** 清掉窗口外、又没锁定的条目（锁定的留着，否则锁会被提前解开）。 */
	sweep(): void {
		const at = this.now();
		for (const [key, state] of this.buckets) {
			const staleWindow = at - state.firstFailedAt > this.windowMs;
			const unlocked = state.lockedUntil <= at;
			if (staleWindow && unlocked) {
				this.buckets.delete(key);
			}
		}
	}

	/** 当前条目数（测试用）。 */
	size(): number {
		this.sweep();
		return this.buckets.size;
	}
}
