CREATE TABLE IF NOT EXISTS dreaming_state (
    agent_id TEXT PRIMARY KEY NOT NULL,
    tokens_since_last_pass INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_pass_at TEXT,
    last_pass_id TEXT,
    last_pass_mode TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dreaming_passes (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'incremental',
    status TEXT NOT NULL DEFAULT 'running',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    tokens_consumed INTEGER,
    mutations_applied INTEGER,
    mutations_skipped INTEGER,
    mutations_failed INTEGER,
    summary TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dreaming_passes_agent
    ON dreaming_passes (agent_id, created_at DESC);
