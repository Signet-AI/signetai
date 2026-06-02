-- Cross-daemon parity: recall context dedup tables (TS migration 073).
CREATE TABLE IF NOT EXISTS session_context_epochs (
    session_key TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT 'default',
    context_epoch INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    source_ref TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (session_key, agent_id, context_epoch)
);
CREATE INDEX IF NOT EXISTS idx_session_context_epochs_created
    ON session_context_epochs(agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS session_recall_events (
    session_key TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT 'default',
    context_epoch INTEGER NOT NULL DEFAULT 0,
    item_kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    surface TEXT NOT NULL,
    mode TEXT NOT NULL,
    score REAL,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (session_key, agent_id, context_epoch, item_kind, item_id)
);
CREATE INDEX IF NOT EXISTS idx_session_recall_events_session
    ON session_recall_events(session_key, agent_id, context_epoch, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_recall_events_item
    ON session_recall_events(item_kind, item_id, created_at DESC);
