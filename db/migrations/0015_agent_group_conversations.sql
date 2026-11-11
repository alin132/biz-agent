CREATE TABLE IF NOT EXISTS agent_group_conversations (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL DEFAULT 'default',
 group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL,
 workers JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_agent_group_conversations_group ON agent_group_conversations (workspace_id, group_id, updated_at DESC);
ALTER TABLE agent_group_turns ADD COLUMN IF NOT EXISTS conversation_id TEXT REFERENCES agent_group_conversations(id);
CREATE INDEX IF NOT EXISTS idx_agent_group_turns_conversation ON agent_group_turns (workspace_id, conversation_id, sequence);
