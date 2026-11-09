CREATE TABLE IF NOT EXISTS agent_groups (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL DEFAULT 'default',
	name TEXT NOT NULL,
	created_by TEXT,
	created_at BIGINT NOT NULL,
	updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_group_members (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL DEFAULT 'default',
	group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
	agent_id TEXT NOT NULL,
	agent_name TEXT NOT NULL,
	position INTEGER NOT NULL,
	session_id TEXT,
	added_at BIGINT NOT NULL,
	UNIQUE (group_id, agent_id),
	UNIQUE (group_id, position)
);

CREATE TABLE IF NOT EXISTS agent_group_turns (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL DEFAULT 'default',
	group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
	sequence INTEGER NOT NULL,
	user_message TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
	created_at BIGINT NOT NULL,
	completed_at BIGINT,
	UNIQUE (group_id, sequence)
);

CREATE TABLE IF NOT EXISTS agent_group_messages (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL DEFAULT 'default',
	group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
	turn_id TEXT NOT NULL REFERENCES agent_group_turns(id) ON DELETE CASCADE,
	role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
	agent_id TEXT,
	agent_name TEXT,
	content TEXT NOT NULL,
	is_error BOOLEAN NOT NULL DEFAULT FALSE,
	created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_groups_workspace_updated ON agent_groups (workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_group_members_group_position ON agent_group_members (workspace_id, group_id, position);
CREATE INDEX IF NOT EXISTS idx_agent_group_members_session ON agent_group_members (workspace_id, session_id);
CREATE INDEX IF NOT EXISTS idx_agent_group_turns_group_sequence ON agent_group_turns (workspace_id, group_id, sequence);
CREATE INDEX IF NOT EXISTS idx_agent_group_messages_group_order ON agent_group_messages (workspace_id, group_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_agent_group_messages_turn_order ON agent_group_messages (workspace_id, turn_id, created_at, id);
