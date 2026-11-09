WITH ranked_running_turns AS (
	SELECT id,
		row_number() OVER (PARTITION BY workspace_id, group_id ORDER BY created_at, id) AS position
	FROM agent_group_turns
	WHERE status = 'running'
)
UPDATE agent_group_turns
SET status = 'failed', completed_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
WHERE id IN (SELECT id FROM ranked_running_turns WHERE position > 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_group_turns_one_running_per_group
	ON agent_group_turns (workspace_id, group_id)
	WHERE status = 'running';
