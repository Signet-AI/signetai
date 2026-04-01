-- Migration 038: skill invocation tracking
-- Mirrors the JS daemon ledger for overview usage analytics and
-- procedural-memory usage counters.

CREATE TABLE IF NOT EXISTS skill_invocations (
    id          TEXT PRIMARY KEY,
    skill_name  TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    source      TEXT NOT NULL CHECK(source IN ('agent','scheduler','api')),
    latency_ms  INTEGER NOT NULL,
    success     INTEGER NOT NULL DEFAULT 1,
    error_text  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_skill_inv_name ON skill_invocations(skill_name, created_at);
CREATE INDEX IF NOT EXISTS idx_skill_inv_agent ON skill_invocations(agent_id, created_at);
