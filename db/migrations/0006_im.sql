-- P8 IM Bot 网关（Postgres 增量）：
--   0001 已经建好 im_bots / im_sessions（凭证列、会话映射列都在），
--   这里只补钉钉回调需要的新增列与查询索引；全部 DDL 幂等，可在已有库上重复执行。
--
-- 注意：这里不改 0001-0005，也不建表；SQLite 侧对应 DDL 内建在 server/db/sqlite.ts，
-- 老库缺列靠 PRAGMA table_info + ALTER TABLE 自愈（AGENTS 坑 19/23）。

-- 机器人：钉钉后台的 robotCode、可选 AES 回调密钥、最近一次回调时间
alter table im_bots add column if not exists robot_code text;
alter table im_bots add column if not exists aes_key_enc text;
alter table im_bots add column if not exists last_callback_at bigint;

-- 会话映射：最近处理过的 msgId（幂等双保险；内存 LRU 之外再落一层）
alter table im_sessions add column if not exists last_msg_id text;

-- 列表页：按工作空间列机器人、按机器人列/数会话映射
create index if not exists idx_im_bots_workspace on im_bots (workspace_id, created_at asc);
create index if not exists idx_im_sessions_bot on im_sessions (bot_id, updated_at desc);
