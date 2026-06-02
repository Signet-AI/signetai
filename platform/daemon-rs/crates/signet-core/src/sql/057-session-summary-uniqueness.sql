-- Cross-daemon parity: session summary uniqueness index (TS migration 046).
-- Drops legacy index, creates unique partial index for agent-scoped summaries.
DROP INDEX IF EXISTS idx_summaries_session_depth;
CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_session_agent_depth
    ON session_summaries(agent_id, session_key, depth)
    WHERE session_key IS NOT NULL
      AND COALESCE(source_type, 'summary') = 'summary';
