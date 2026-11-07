-- 知识库「对话默认检索」：这些库在问答时直接参与检索，不需要先加载技能。
-- 与 SQLite 的 kb_default_bindings 表对应（见 server/kb/schema.ts）。
create table if not exists kb_default_bindings (
	kb_id text primary key
);
