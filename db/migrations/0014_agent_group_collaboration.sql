ALTER TABLE agent_groups ADD COLUMN IF NOT EXISTS collaboration JSONB;
ALTER TABLE agent_group_turns ADD COLUMN IF NOT EXISTS discussion JSONB;
ALTER TABLE agent_group_messages ADD COLUMN IF NOT EXISTS metadata JSONB;
