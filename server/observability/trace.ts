/**
 * 可观测的纯函数集合：trace_id 生成、token 估算、p95、range 解析、参数摘要。
 *
 * 这里刻意不碰存储与 HTTP——自检脚本（`scripts/observability-selftest.ts`）直接断言这些细节，
 * 采集器与路由只做编排。
 */

import { randomBytes } from "node:crypto";

/** trace_id 的形状：`tr_` + 12 位 base36。前端路由、测试断言都认这一条正则。 */
export const TRACE_ID_PATTERN = /^tr_[0-9a-z]{12}$/;

/** 生成一条新的调用链 id（每轮用户消息一条）。 */
export function newTraceId(): string {
	// 8 字节随机数转 base36 后一定超过 12 位，截末尾 12 位（保持固定长度）
	const raw = randomBytes(8).toString("hex");
	const body = BigInt(`0x${raw}`).toString(36);
	return `tr_${body.length >= 12 ? body.slice(-12) : body.padStart(12, "0")}`;
}

/** 参数摘要上限：trace_events.payload 里只放这么多字符，避免把大对象写进库。 */
export const ARGS_SUMMARY_MAX = 200;

/** 工具参数摘要（≤200 字）：解析失败也不抛，坏数据不能影响主流程。 */
export function summarizeArgs(args: unknown): string {
	if (args === undefined || args === null) {
		return "";
	}
	let text: string;
	try {
		text = typeof args === "string" ? args : JSON.stringify(args);
	} catch {
		text = String(args);
	}
	if (text.length <= ARGS_SUMMARY_MAX) {
		return text;
	}
	return `${text.slice(0, ARGS_SUMMARY_MAX)}…`;
}

/**
 * 估算 token 数：没有真实 usage（模拟模型）时用它兜底。
 *
 * 中文/日文/韩文按 1 字 ≈ 1 token，其余非空白字符按 4 字符 ≈ 1 token——
 * 与常见 tokenizer 的量级一致，用来做趋势足够，不当计费依据。
 */
export function estimateTokens(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	let wide = 0;
	let narrow = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code >= 0x2e80) {
			wide += 1;
		} else if (!/\s/.test(char)) {
			narrow += 1;
		}
	}
	return wide + Math.ceil(narrow / 4);
}

/** 最近秩（nearest-rank）百分位：空数组返回 0，结果一定是原数组里的一个值。 */
export function percentile(values: number[], p: number): number {
	if (values.length === 0) {
		return 0;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length);
	const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
	return sorted[index]!;
}

/** `GET /api/monitor/summary?range=` 支持的时间窗。 */
export interface RangeWindow {
	/** 规范化后的写法（小写、无空格），例如 `24h` */
	value: string;
	ms: number;
}

const RANGE_PATTERN = /^(\d+)([smhd])$/;
const UNIT_MS: Record<string, number> = {
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

/** 默认时间窗：24 小时（与 `messages24h` / `active24h` 的语义一致）。 */
export const DEFAULT_RANGE = "24h";

/**
 * 解析 `range` 查询参数；不传返回默认 24h，写错返回 null（路由层转 400）。
 * 不设下限/上限之外的限制：`30m`、`1h`、`24h`、`7d` 都合法。
 */
export function parseRange(raw: string | null | undefined): RangeWindow | null {
	const value = (raw ?? "").trim().toLowerCase();
	if (value.length === 0) {
		return { value: DEFAULT_RANGE, ms: 24 * UNIT_MS.h! };
	}
	const match = RANGE_PATTERN.exec(value);
	if (!match) {
		return null;
	}
	const amount = Number(match[1]);
	const unit = match[2]!;
	if (!Number.isFinite(amount) || amount <= 0) {
		return null;
	}
	return { value: `${amount}${unit}`, ms: amount * UNIT_MS[unit]! };
}
