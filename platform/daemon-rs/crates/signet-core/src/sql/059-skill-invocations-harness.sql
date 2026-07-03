-- Migration 059: harness skill-invocation indexes (parity with TS 082).
-- The harness/session_id/tool_use_id/... columns are added via
-- add_column_if_missing in ensure_cross_daemon_parity_columns (SQLite ALTER
-- has no IF NOT EXISTS); this file creates the indexes once those exist.

DROP INDEX IF EXISTS idx_skill_inv_dedupe;

CREATE UNIQUE INDEX idx_skill_inv_dedupe
    ON skill_invocations(agent_id, harness, session_id, tool_use_id)
    WHERE harness IS NOT NULL AND session_id IS NOT NULL AND tool_use_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_skill_inv_harness
    ON skill_invocations(harness, created_at);
