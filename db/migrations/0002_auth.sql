-- P3 企业安全（Postgres 增量）：audit_logs 从"工具调用形状"扩展成"平台动作形状"。
--
-- 0001 里 audit_logs 是按 P9 的工具调用设计建的（tool_name / ok / args / result），
-- P3 要记的是平台动作（登录、建会话、改技能…）：actor_type / actor_id / action / target_* / detail。
-- 两张形状共用一张表：P3 的行不填 tool_name/ok，P9 的行不填 action/actor_*。
-- 所以这里既加列，也把 0001 里 `tool_name` / `ok` 的 NOT NULL 放开。
--
-- 幂等：add column if not exists 可以重复跑；drop not null 本身幂等。
-- 全部 DDL 在事务里跑一次（server/db/migrations.ts），跑完记进 schema_migrations。

alter table audit_logs add column if not exists actor_type  text;
alter table audit_logs add column if not exists actor_id    text;
alter table audit_logs add column if not exists action      text;
alter table audit_logs add column if not exists target_type text;
alter table audit_logs add column if not exists target_id   text;
alter table audit_logs add column if not exists detail      jsonb;

alter table audit_logs alter column tool_name drop not null;
alter table audit_logs alter column ok        drop not null;

-- 审计查询：按动作过滤、按操作者过滤，都倒序取（GET /api/audit）
create index if not exists idx_audit_logs_action on audit_logs (action, created_at desc);
create index if not exists idx_audit_logs_actor  on audit_logs (actor_id, created_at desc);

-- 登录邮箱大小写不敏感（应用侧也会 trim+小写，这里是库层兜底）
create unique index if not exists idx_users_email_lower on users (lower(email));
