-- P10：Agent 实体（六维配置 + 状态机）。
-- 六维对应列：基础信息(name/description/category/icon)、人格与指令(agents_md)、
-- 模型策略(model_config)、记忆(memory_config)、能力绑定(skill_ids/kb_ids)、高级(advanced_config)。
-- 状态机 draft → testing → published → stopped；状态与状态时间单独成列，列表页要按 status 过滤与排序。
CREATE TABLE IF NOT EXISTS agents (
	id                TEXT PRIMARY KEY,
	workspace_id      TEXT NOT NULL DEFAULT 'default',
	name              TEXT NOT NULL,
	description       TEXT NOT NULL DEFAULT '',
	category          TEXT NOT NULL DEFAULT '',
	icon              TEXT NOT NULL DEFAULT '',
	agents_md         TEXT NOT NULL DEFAULT '',
	model_config      JSONB NOT NULL DEFAULT '{}'::jsonb,
	memory_config     JSONB NOT NULL DEFAULT '{}'::jsonb,
	advanced_config   JSONB NOT NULL DEFAULT '{}'::jsonb,
	skill_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
	kb_ids            JSONB NOT NULL DEFAULT '[]'::jsonb,
	status            TEXT NOT NULL DEFAULT 'draft',
	created_by        TEXT,
	created_at        BIGINT NOT NULL,
	updated_at        BIGINT NOT NULL,
	status_changed_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_status ON agents (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents (workspace_id, updated_at DESC);
