-- 多模型管理：持久化当前对话模型与向量模型选择。
create table if not exists model_settings (
	workspace_id text not null default 'default',
	key text not null,
	value text not null,
	updated_at bigint not null,
	primary key (workspace_id, key)
);
