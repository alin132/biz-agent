-- P2 初始 schema（Postgres）：
--   ① 现在就要用的两张表（sessions / workflows），列与 SQLite 版的单表 payload 设计对齐；
--   ② 后续阶段（P3 安全 / P4 开放 API / P5 知识库 / P7 MCP / P8 IM / P9 可观测）先把表建好，
--      字段够用即可——真正用到的阶段再补 0002、0003…，不回头改这一份。
--
-- 幂等：整个文件在一个事务里跑一次，跑完记进 schema_migrations，不会重复执行；
-- 同时所有 DDL 都带 if not exists，手工重放排查也不会炸。

-- 向量检索（P5 知识库）与模糊匹配（无 embedding key 时的关键词回退）都要这两个扩展。
-- pgvector/pgvector:pg16 镜像自带 vector；pg_trgm 是 PG 自带 contrib。
create extension if not exists vector;
create extension if not exists pg_trgm;

-- ── 工作空间（P2 先固定一行 default；多租户留到需要时开） ──────────────────────
create table if not exists workspaces (
	id         text primary key,
	name       text not null,
	created_at timestamptz not null default now()
);
insert into workspaces (id, name) values ('default', '默认工作空间') on conflict (id) do nothing;

-- ── 会话（P2）：payload = 整条 PersistedSession 的 JSON，语义与 SQLite 的 payload 列一致 ──
create table if not exists sessions (
	id           text primary key,
	workspace_id text not null default 'default',
	workflow_id  text not null,
	title        text,
	archived     boolean not null default false,
	done         boolean not null default false,
	created_at   bigint not null,
	updated_at   bigint not null,
	payload      jsonb not null
);
create index if not exists idx_sessions_workspace_updated on sessions (workspace_id, updated_at desc);

-- ── 自定义流程（P2）：内置流程在代码里不落库；definition = { systemPrompt, steps }，skill = 技能文案 ──
create table if not exists workflows (
	id           text primary key,
	workspace_id text not null default 'default',
	name         text not null,
	definition   jsonb not null,
	skill        jsonb,
	created_at   bigint not null,
	updated_at   bigint not null
);
create index if not exists idx_workflows_workspace on workflows (workspace_id, created_at);

-- ── 成员与 RBAC（P3）：口令只存 scrypt 派生结果，四角色固定 ────────────────────
create table if not exists users (
	id            text primary key,
	workspace_id  text not null default 'default',
	email         text not null unique,
	name          text,
	password_hash text,
	role          text not null default 'developer'
		check (role in ('owner', 'developer', 'operator', 'auditor')),
	disabled      boolean not null default false,
	created_at    bigint not null,
	last_login_at bigint
);

-- ── 开放 API（P4）：API Key 只存前缀 + 哈希，明文只在创建时返回一次 ─────────────
create table if not exists api_keys (
	id                 text primary key,
	workspace_id       text not null default 'default',
	name               text not null,
	prefix             text not null,
	key_hash           text not null,
	role               text not null default 'operator'
		check (role in ('owner', 'developer', 'operator', 'auditor')),
	rate_limit_per_min integer not null default 60,
	disabled           boolean not null default false,
	last_used_at       bigint,
	created_at         bigint not null,
	revoked_at         bigint
);
create index if not exists idx_api_keys_prefix on api_keys (prefix);

-- ── 知识库 RAG（P5）：文档 → 分块 → pgvector；embedding 维度按默认模型 1024 预留 ──
create table if not exists knowledge_bases (
	id                   text primary key,
	workspace_id         text not null default 'default',
	name                 text not null,
	description          text,
	embedding_model      text,
	chunk_size           integer not null default 800,
	chunk_overlap        integer not null default 100,
	similarity_threshold real not null default 0.3,
	created_at           bigint not null,
	updated_at           bigint not null
);

create table if not exists kb_documents (
	id          text primary key,
	kb_id       text not null references knowledge_bases (id) on delete cascade,
	filename    text not null,
	mime        text,
	bytes       bigint,
	status      text not null default 'pending',
	error       text,
	chunk_count integer not null default 0,
	created_at  bigint not null,
	updated_at  bigint not null
);
create index if not exists idx_kb_documents_kb on kb_documents (kb_id, created_at desc);

create table if not exists kb_chunks (
	id         bigserial primary key,
	doc_id     text not null references kb_documents (id) on delete cascade,
	kb_id      text not null,
	seq        integer not null,
	heading    text,
	content    text not null,
	tokens     integer,
	embedding  vector(1024),
	created_at bigint not null
);
create index if not exists idx_kb_chunks_doc on kb_chunks (doc_id, seq);
-- 关键词检索（没配 embedding key 时的回退路径）：分词 + 三元组模糊匹配
create index if not exists idx_kb_chunks_fts on kb_chunks using gin (to_tsvector('simple', content));
create index if not exists idx_kb_chunks_trgm on kb_chunks using gin (content gin_trgm_ops);
-- 语义检索：余弦距离 HNSW 索引（pgvector >= 0.5）
create index if not exists idx_kb_chunks_embedding on kb_chunks using hnsw (embedding vector_cosine_ops);

-- 技能 ↔ 知识库绑定（P5）：一条技能可挂多个库，加载技能时都参与检索
create table if not exists skill_kb_bindings (
	skill_id text not null,
	kb_id    text not null references knowledge_bases (id) on delete cascade,
	primary key (skill_id, kb_id)
);

-- ── MCP 集成（P7）：服务 + 发现到的工具 ────────────────────────────────────
create table if not exists mcp_servers (
	id           text primary key,
	workspace_id text not null default 'default',
	name         text not null,
	transport    text not null default 'stdio'
		check (transport in ('stdio', 'sse', 'http')),
	command      text,
	args         jsonb,
	url          text,
	headers      jsonb,
	enabled      boolean not null default true,
	created_at   bigint not null,
	updated_at   bigint not null
);

create table if not exists mcp_tools (
	id          text primary key,
	server_id   text not null references mcp_servers (id) on delete cascade,
	name        text not null,
	description text,
	input_schema jsonb,
	enabled     boolean not null default true,
	created_at  bigint not null,
	unique (server_id, name)
);

-- ── IM Bot 网关（P8）：凭证只存密文；会话映射把外部会话对到本平台会话 ──────────
create table if not exists im_bots (
	id              text primary key,
	workspace_id    text not null default 'default',
	name            text not null,
	platform        text not null default 'dingtalk'
		check (platform in ('dingtalk', 'wecom')),
	app_key         text,
	app_secret_enc  text,
	sign_secret_enc text,
	workflow_id     text,
	enabled         boolean not null default true,
	created_at      bigint not null,
	updated_at      bigint not null
);

create table if not exists im_sessions (
	id              text primary key,
	bot_id          text not null references im_bots (id) on delete cascade,
	conversation_id text not null,
	external_user_id text,
	session_id      text,
	created_at      bigint not null,
	updated_at      bigint not null,
	unique (bot_id, conversation_id)
);

-- ── 监控与可观测（P9）：审计落库 + trace/trace_event 调用链 ──────────────────
create table if not exists audit_logs (
	id           bigserial primary key,
	workspace_id text not null default 'default',
	session_id   text,
	trace_id     text,
	user_id      text,
	tool_name    text not null,
	risk         text,
	ok           boolean not null,
	duration_ms  integer,
	args         jsonb,
	result       text,
	created_at   bigint not null
);
create index if not exists idx_audit_logs_created on audit_logs (created_at desc);
create index if not exists idx_audit_logs_session on audit_logs (session_id, created_at desc);

create table if not exists traces (
	id           text primary key,
	workspace_id text not null default 'default',
	session_id   text,
	workflow_id  text,
	skill_id     text,
	started_at   bigint not null,
	finished_at  bigint,
	status       text not null default 'running',
	error        text
);
create index if not exists idx_traces_created on traces (started_at desc);

create table if not exists trace_events (
	id         bigserial primary key,
	trace_id   text not null references traces (id) on delete cascade,
	seq        integer not null,
	kind       text not null,
	name       text,
	payload    jsonb,
	created_at bigint not null
);
create index if not exists idx_trace_events_trace on trace_events (trace_id, seq);
