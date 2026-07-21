-- Migration 060: unified ingest queue lease/priority indexes (parity with TS 088).
-- The agent_id / lease_owner / lease_token / lease_expires_at / priority /
-- planning_attempts / planning_started_at / last_planning_at / plan_hash columns
-- are added via add_column_if_missing in ensure_cross_daemon_parity_columns
-- (SQLite ALTER has no IF NOT EXISTS); this file creates the indexes once those
-- columns exist. The agent_id backfill also runs from the columns function so it
-- can reference documents.agent_id (added by the document-scope-columns parity).

-- Lease lookup: agent-scoped, by status, highest priority first, oldest first.
CREATE INDEX IF NOT EXISTS idx_memory_jobs_lease
    ON memory_jobs(agent_id, status, priority DESC, created_at);

-- Reaper lookup: leased/planning/applying rows past their per-row TTL.
CREATE INDEX IF NOT EXISTS idx_memory_jobs_stale
    ON memory_jobs(status, lease_expires_at)
    WHERE status IN ('leased','planning','applying');
