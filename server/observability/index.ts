/**
 * 监控与可观测（P9）模块入口。
 *
 * `server/index.ts` 只做两件事：`createObservability({ storage })` 建采集器、
 * `await handleMonitorRoute(...)` 挂 `/api/monitor/*`；具体逻辑都在本目录：
 *   trace.ts     纯函数（trace_id / token 估算 / p95 / range）
 *   collector.ts 内存队列 + 批量 flush + 聚合查询
 *   routes.ts    HTTP 接口与角色收窄
 */

export { createObservability, Observability, ACTIVE_WINDOW_MS } from "./collector.js";
export type {
	FlushResult,
	MonitoredEvent,
	MonitorSummary,
	ObservabilityOptions,
	TraceBeginInput,
} from "./collector.js";
export { handleMonitorRoute } from "./routes.js";
export type { MonitorRouteContext } from "./routes.js";
export {
	ARGS_SUMMARY_MAX,
	DEFAULT_RANGE,
	estimateTokens,
	newTraceId,
	parseRange,
	percentile,
	summarizeArgs,
	TRACE_ID_PATTERN,
} from "./trace.js";
export type { RangeWindow } from "./trace.js";
