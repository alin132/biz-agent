CREATE TABLE IF NOT EXISTS memories (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL DEFAULT 'default',
 owner_id TEXT NOT NULL,
 agent_id TEXT,
 session_id TEXT,
 content TEXT NOT NULL,
 source TEXT NOT NULL,
 created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (workspace_id, owner_id, agent_id, session_id, updated_at DESC);
