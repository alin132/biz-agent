-- 本地插件包清单与技能归属。
create table if not exists plugins (
	id text primary key,
	workspace_id text not null default 'default',
	name text not null,
	version text not null,
	description text not null default '',
	manifest jsonb not null,
	enabled boolean not null default true,
	created_at bigint not null,
	updated_at bigint not null
);

alter table workflows add column if not exists plugin_id text;
