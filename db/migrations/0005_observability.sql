-- P9 监控与可观测（Postgres 增量）：
--   0001 已经建好 traces / trace_events，但事件表只有 payload（jsonb），
--   而监控列表与聚合要按 ok / ms 过滤（工具失败数、p95、模型平均耗时），
--   把它们拆成列既省解析也让索引有用。全部 DDL 幂等，可在已有库上重复执行。
--
-- 注意：这里只加列与索引，不建表（表在 0001 里已经建好）；
-- SQLite 侧对应的 DDL 在 server/db/sqlite.ts 内建，别只改这一份。

alter table trace_events add column if not exists ok boolean;
alter table trace_events add column if not exists ms integer;

-- 采集器重试时靠 (trace_id, seq) 幂等：重复批次 on conflict do nothing
create unique index if not exists uq_trace_events_trace_seq on trace_events (trace_id, seq);

-- 监控列表/聚合：按事件类型过滤、按时间窗倒序
create index if not exists idx_trace_events_kind on trace_events (kind, created_at desc);
create index if not exists idx_traces_session on traces (session_id, started_at desc);
create index if not exists idx_traces_status on traces (status, started_at desc);

-- 审计查询增强（actorType / targetType 过滤）
create index if not exists idx_audit_logs_actor_type on audit_logs (actor_type, created_at desc);
create index if not exists idx_audit_logs_target_type on audit_logs (target_type, created_at desc);
