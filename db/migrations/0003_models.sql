-- ── 多模型管理（P6）：供应商 + 模型 ──
-- 只服务 Postgres；SQLite 的同一份表结构内建在 server/db/sqlite.ts（见 AGENTS 坑 23）。
-- 幂等：CREATE TABLE / INDEX IF NOT EXISTS，重复执行不报错。
-- api_key_encrypted 存 AES-256-GCM 密文（{v,iv,tag,data} 的 JSON 文本），永远不存明文。

create table if not exists model_providers (
	id                text primary key,
	workspace_id      text not null default 'default',
	name              text not null unique,
	kind              text not null default 'openai'
		check (kind in ('openai', 'deepseek', 'ollama', 'anthropic', 'custom')),
	base_url          text,
	api_key_encrypted text,
	enabled           boolean not null default true,
	created_at        bigint not null,
	updated_at        bigint not null
);

create table if not exists models (
	id             text primary key,
	workspace_id   text not null default 'default',
	provider_id    text not null references model_providers (id) on delete cascade,
	name           text not null,
	model_id       text not null,
	kind           text not null default 'chat'
		check (kind in ('chat', 'embedding')),
	enabled        boolean not null default true,
	context_window integer,
	created_at     bigint not null,
	updated_at     bigint not null
);

create index if not exists idx_models_provider on models (provider_id, kind);
