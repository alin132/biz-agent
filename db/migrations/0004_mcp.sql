-- ── MCP 集成（P7）：在 0001 已有的 mcp_servers / mcp_tools 上做必要增量 ──
-- 只服务 Postgres；SQLite 的同一份表结构内建在 server/db/sqlite.ts（见 AGENTS 坑 23）。
-- 幂等：ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS，重复执行不报错。
-- 不改 0001-0003：0001 已经建好两张 MCP 表，这里只补运行时需要的列与索引。

-- env：stdio 子进程的环境变量（只存显式覆盖，其余继承服务进程环境）
alter table mcp_servers add column if not exists env jsonb;

-- 最近一次发现（initialize + tools/list）的结果：ok / error / unknown
alter table mcp_servers add column if not exists last_status text not null default 'unknown';
alter table mcp_servers add column if not exists last_error text;
alter table mcp_servers add column if not exists last_checked_at bigint;

-- 启动时按启用状态扫一遍；工具按 server 查
create index if not exists idx_mcp_servers_workspace on mcp_servers (workspace_id, created_at);
create index if not exists idx_mcp_servers_enabled on mcp_servers (enabled, created_at);
create index if not exists idx_mcp_tools_server on mcp_tools (server_id, enabled);
