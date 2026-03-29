-- Migration 035: Temporal head provenance + thread heads
--
-- Brings daemon-rs parity for DB-native temporal provenance used by
-- MEMORY.md projection and temporal recall fallbacks.

CREATE TABLE IF NOT EXISTS memory_thread_heads (
    agent_id TEXT NOT NULL DEFAULT 'default',
    thread_key TEXT NOT NULL,
    label TEXT NOT NULL,
    project TEXT,
    session_key TEXT,
    source_type TEXT NOT NULL DEFAULT 'summary',
    source_ref TEXT,
    harness TEXT,
    node_id TEXT NOT NULL,
    latest_at TEXT NOT NULL,
    sample TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, thread_key)
);

CREATE INDEX IF NOT EXISTS idx_memory_thread_heads_agent_latest
    ON memory_thread_heads(agent_id, latest_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_thread_heads_agent_project
    ON memory_thread_heads(agent_id, project);
