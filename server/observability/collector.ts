/**
 * 调用链采集器（P9）：内存队列 + 200ms 批量 flush，写入绝不阻塞对话主流程。
 *
 * 设计取舍：
 * - `begin()` / `record()` / `finish()` 只改内存（O(1)），真正的 SQL 在 `flush()` 里；
 * - flush 一批写成两条 SQL：trace upsert（一条多值 INSERT）+ trace_events 批量 INSERT；
 * - 写失败**重试 1 次**，仍失败就整批丢弃并计数（`droppedCount`），绝不让监控把业务拖挂；
 * - 定时器 `unref()`，不阻止进程退出；`createObservability()` 额外挂 exit/SIGINT/SIGTERM 做最后一次 flush；
 * - 查询接口（summary / traces / 详情）先 `flush()` 再查，保证刚结束的一轮对话立刻可见。
 *
 * PG 后端的 DAO 是同步桥（Atomics.wait），所以 flush 会阻塞主线程毫秒级；
 * 200ms 一次 + 批量两条 SQL 已经把频率压到很低，这是当前同步契约下的取舍。
 */

import { DEFAULT_WORKSPACE_ID } from "../db/types.js";
import type {
	MonitorStats,
	Storage,
	TraceEventInput,
	TraceEventKind,
	TraceEventRecord,
	TraceFilter,
	TraceRecord,
	TraceStatus,
	TraceSummaryRecord,
} from "../db/types.js";
import { TRACE_ID_PATTERN, newTraceId, parseRange, percentile } from "./trace.js";
import type { RangeWindow } from "./trace.js";

/** `sessions.active24h` 固定看 24 小时（字段名就是契约）。 */
export const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ObservabilityOptions {
	storage: Storage;
	/** flush 间隔，默认 200ms */
	flushIntervalMs?: number;
	/** 队列达到这个条数就立即 flush，避免一次超长对话把内存堆起来 */
	maxBatchSize?: number;
	/** 注入时钟（自检用） */
	now?: () => number;
	/** MCP 工具名 → 服务名（会话层记 mcp 事件时用，避免可观测模块依赖 MCP 注册表） */
	resolveMcpServer?: (toolName: string) => string | undefined;
	/** 写入失败等内部错误（默认 console.error；自检可静音） */
	onLog?: (message: string) => void;
	/** 是否启动定时器，默认 true；自检把它关掉、手动 flush */
	autoStart?: boolean;
	/** 调用链保留天数：>0 时启动后与每小时清理一次过期数据；0 / 负数 = 不清理。默认读 TRACE_RETENTION_DAYS（未配=30） */
	retentionDays?: number;
	/** 清理检查间隔，默认 1 小时 */
	purgeIntervalMs?: number;
}

export interface TraceBeginInput {
	sessionId?: string | null;
	workflowId?: string | null;
	skillId?: string | null;
}

/** 采集器对外暴露的事件形状（payload 由调用方决定，会话层写参数摘要等）。 */
export interface MonitoredEvent {
	kind: TraceEventKind;
	name?: string | null;
	ok?: boolean | null;
	ms?: number | null;
	payload?: unknown;
}

/** `GET /api/monitor/summary` 的出参。 */
export interface MonitorSummary {
	sessions: { total: number; active24h: number };
	messages24h: number;
	toolCalls: { total: number; ok: number; failed: number; avgMs: number };
	skills: { id: string; calls: number }[];
	mcp: { server: string; calls: number; failed: number }[];
	model: { model: string; calls: number; avgMs: number }[];
	errors: number;
	p95Ms: number;
}

export interface FlushResult {
	/** 本批成功写入的 trace 条数 */
	traces: number;
	/** 本批成功写入的事件条数 */
	events: number;
	/** 本批丢弃的条数（trace + 事件） */
	dropped: number;
}

interface TraceState {
	record: TraceRecord;
	/** 有未落库的改动（begin 或 finish 之后） */
	dirty: boolean;
	/** 下一个事件序号（每个 trace 从 1 开始） */
	nextSeq: number;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class Observability {
	private readonly storage: Storage;
	private readonly flushIntervalMs: number;
	private readonly maxBatchSize: number;
	private readonly now: () => number;
	private readonly resolveMcpServer?: (toolName: string) => string | undefined;
	private readonly onLog: (message: string) => void;
	private readonly traces = new Map<string, TraceState>();
	private queue: TraceEventInput[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;
	private purgeTimer: ReturnType<typeof setInterval> | null = null;
	private readonly retentionDays: number;
	private readonly purgeIntervalMs: number;
	private closed = false;
	private droppedTraceCountValue = 0;
	private droppedEventCountValue = 0;
	private flushCount = 0;

	constructor(options: ObservabilityOptions) {
		this.storage = options.storage;
		this.flushIntervalMs = options.flushIntervalMs ?? 200;
		this.maxBatchSize = options.maxBatchSize ?? 200;
		this.now = options.now ?? (() => Date.now());
		this.resolveMcpServer = options.resolveMcpServer;
		this.onLog = options.onLog ?? ((message) => console.error(message));
		this.retentionDays = options.retentionDays ?? 30;
		this.purgeIntervalMs = options.purgeIntervalMs ?? 60 * 60 * 1000;
		if (options.autoStart !== false) {
			this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
			// 不阻止进程退出：该退就退，退出前由 exit/SIGINT/SIGTERM 钩子补一次 flush
			this.timer.unref?.();
			if (this.retentionDays > 0) {
				// 启动先清一次（上次异常退出可能留下过期数据），之后每小时一次
				this.purgeExpired();
				this.purgeTimer = setInterval(() => this.purgeExpired(), this.purgeIntervalMs);
				this.purgeTimer.unref?.();
			}
		}
	}

	/** 开一条调用链（每轮用户消息一条）；返回的 trace_id 会进 done/error 事件与 SessionView。 */
	begin(input: TraceBeginInput = {}): string {
		const traceId = newTraceId();
		const record: TraceRecord = {
			id: traceId,
			workspaceId: DEFAULT_WORKSPACE_ID,
			sessionId: input.sessionId ?? null,
			workflowId: input.workflowId ?? null,
			skillId: input.skillId ?? null,
			startedAt: this.now(),
			finishedAt: null,
			status: "running",
			error: null,
		};
		this.traces.set(traceId, { record, dirty: true, nextSeq: 1 });
		return traceId;
	}

	/** 记一个关键节点；traceId 为空或已经结束的链直接忽略（不阻塞、不抛错）。 */
	record(traceId: string | null | undefined, event: MonitoredEvent): void {
		if (!traceId) {
			return;
		}
		const state = this.traces.get(traceId);
		if (!state) {
			return;
		}
		const seq = state.nextSeq;
		state.nextSeq += 1;
		this.queue.push({
			traceId,
			seq,
			kind: event.kind,
			name: event.name ?? null,
			ok: event.ok ?? null,
			ms: event.ms ?? null,
			payload: event.payload ?? null,
			createdAt: this.now(),
		});
		if (this.queue.length >= this.maxBatchSize) {
			// 一次超长对话（工具很多）别把队列撑爆：达到阈值就地刷一次
			this.flush();
		}
	}

	/** 结束一条调用链：成功 / 失败（error 文案进 traces.error）。 */
	finish(traceId: string | null | undefined, status: Exclude<TraceStatus, "running">, error?: string | null): void {
		if (!traceId) {
			return;
		}
		const state = this.traces.get(traceId);
		if (!state) {
			return;
		}
		state.record.finishedAt = this.now();
		state.record.status = status;
		state.record.error = error ?? null;
		state.dirty = true;
	}

	/** 把内存队列同步落库；返回本批写入/丢弃条数（自检直接断言它）。 */
	flush(): FlushResult {
		const result: FlushResult = { traces: 0, events: 0, dropped: 0 };
		if (this.closed) {
			return result;
		}

		const dirtyStates = [...this.traces.values()].filter((state) => state.dirty);
		if (dirtyStates.length > 0) {
			const records = dirtyStates.map((state) => state.record);
			const saved = this.writeWithRetry(() => this.storage.saveTraces(records));
			if (saved) {
				result.traces = records.length;
				for (const state of dirtyStates) {
					state.dirty = false;
					// 已经结束的 trace 落库后就可以从内存里删掉，避免长期进程无限增长
					if (state.record.status !== "running") {
						this.traces.delete(state.record.id);
					}
				}
			} else {
				result.dropped += records.length;
				this.droppedTraceCountValue += records.length;
				for (const state of dirtyStates) {
					this.traces.delete(state.record.id);
				}
			}
		}

		if (this.queue.length > 0) {
			const batch = this.queue;
			this.queue = [];
			const saved = this.writeWithRetry(() => this.storage.appendTraceEvents(batch));
			if (saved) {
				result.events = batch.length;
			} else {
				result.dropped += batch.length;
				this.droppedEventCountValue += batch.length;
			}
		}

		this.flushCount += 1;
		return result;
	}

	/** 停止定时器并做最后一次 flush（进程优雅关闭时调用）。 */
	close(): void {
		if (this.closed) {
			return;
		}
		this.flush();
		this.closed = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (this.purgeTimer) {
			clearInterval(this.purgeTimer);
			this.purgeTimer = null;
		}
	}

	/**
	 * 清理保留期之外的调用链（`retentionDays` 天前）。失败只记日志、绝不抛错——
	 * 监控清理不该影响对话主流程。
	 */
	purgeExpired(nowMs: number = this.now()): { traces: number; events: number } {
		if (this.retentionDays <= 0) {
			return { traces: 0, events: 0 };
		}
		const cutoff = nowMs - this.retentionDays * 24 * 60 * 60 * 1000;
		try {
			const removed = this.storage.purgeTracesBefore(cutoff);
			if (removed.traces > 0 || removed.events > 0) {
				this.onLog(
					`[monitor] 清理保留期外的调用链：${removed.traces} 条 trace / ${removed.events} 条事件（保留 ${this.retentionDays} 天）`,
				);
			}
			return removed;
		} catch (error) {
			this.onLog(`[monitor] 清理调用链失败（不影响对话）：${describeError(error)}`);
			return { traces: 0, events: 0 };
		}
	}

	/** 累计丢弃条数（trace + 事件）；监控页可以据此报警。 */
	get droppedCount(): number {
		return this.droppedTraceCountValue + this.droppedEventCountValue;
	}

	get droppedEventCount(): number {
		return this.droppedEventCountValue;
	}

	get droppedTraceCount(): number {
		return this.droppedTraceCountValue;
	}

	get queueSize(): number {
		return this.queue.length;
	}

	get flushedTimes(): number {
		return this.flushCount;
	}

	/** MCP 工具名 → 服务名（会话层记 mcp 事件用）。 */
	mcpServerOf(toolName: string): string | undefined {
		return this.resolveMcpServer?.(toolName);
	}

	/**
	 * 监控聚合。`range` 不合法时按默认 24h（路由层会先校验并回 400）。
	 * 先 flush 一次：刚结束的一轮对话要能立刻在首页看到。
	 */
	summary(range: string = "24h"): MonitorSummary {
		const window: RangeWindow = parseRange(range) ?? { value: "24h", ms: 24 * 60 * 60 * 1000 };
		this.flush();
		const now = this.now();
		const stats: MonitorStats = this.storage.monitorStats(now - window.ms, now - ACTIVE_WINDOW_MS);
		return {
			sessions: stats.sessions,
			messages24h: stats.messages,
			toolCalls: {
				total: stats.toolCalls.total,
				ok: stats.toolCalls.ok,
				failed: stats.toolCalls.failed,
				avgMs: Math.round(stats.toolCalls.avgMs),
			},
			skills: stats.skills,
			mcp: stats.mcp,
			model: stats.model.map((row) => ({ model: row.model, calls: row.calls, avgMs: Math.round(row.avgMs) })),
			errors: stats.errors,
			p95Ms: Math.round(percentile(stats.toolDurations, 95)),
		};
	}

	listTraces(filter: TraceFilter): TraceSummaryRecord[] {
		this.flush();
		return this.storage.listTraces(filter);
	}

	countTraces(filter: Omit<TraceFilter, "limit" | "offset">): number {
		this.flush();
		return this.storage.countTraces(filter);
	}

	getTrace(traceId: string): TraceSummaryRecord | undefined {
		this.flush();
		return this.storage.getTrace(traceId);
	}

	listTraceEvents(traceId: string): TraceEventRecord[] {
		this.flush();
		return this.storage.listTraceEvents(traceId);
	}

	/** 写一批；失败重试 1 次，仍失败返回 false（调用方丢弃并计数）。 */
	private writeWithRetry(work: () => void): boolean {
		try {
			work();
			return true;
		} catch {
			try {
				work();
				return true;
			} catch (error) {
				this.onLog(`可观测数据写入失败（已重试 1 次，本批丢弃）：${describeError(error)}`);
				return false;
			}
		}
	}
}

/**
 * 生产入口：建采集器并挂进程退出钩子（尽量把队列里的事件刷出去）。
 * 自检脚本用 `new Observability()`，避免给进程挂一堆监听器。
 */
export function createObservability(options: ObservabilityOptions): Observability {
	const observability = new Observability(options);
	const flush = (): void => {
		try {
			observability.flush();
		} catch {
			// 退出阶段不再抛：存储可能已经关闭
		}
	};
	process.on("exit", flush);
	process.on("SIGINT", flush);
	process.on("SIGTERM", flush);
	return observability;
}

export { TRACE_ID_PATTERN };
