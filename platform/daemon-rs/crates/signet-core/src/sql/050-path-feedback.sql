-- Cross-daemon parity: path_feedback tables (TS migration 041).
CREATE TABLE IF NOT EXISTS path_feedback_events (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_key TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    path_hash TEXT NOT NULL,
    path_json TEXT NOT NULL,
    rating REAL NOT NULL,
    reward REAL NOT NULL DEFAULT 0,
    reward_forward REAL NOT NULL DEFAULT 0,
    reward_update REAL NOT NULL DEFAULT 0,
    reward_downstream REAL NOT NULL DEFAULT 0,
    reward_dead_end REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_path_feedback_events_agent_path
    ON path_feedback_events(agent_id, path_hash);
CREATE INDEX IF NOT EXISTS idx_path_feedback_events_session
    ON path_feedback_events(session_key);
CREATE INDEX IF NOT EXISTS idx_path_feedback_events_memory
    ON path_feedback_events(memory_id);

CREATE TABLE IF NOT EXISTS path_feedback_stats (
    agent_id TEXT NOT NULL,
    path_hash TEXT NOT NULL,
    path_json TEXT NOT NULL,
    q_value REAL NOT NULL DEFAULT 0,
    sample_count INTEGER NOT NULL DEFAULT 0,
    positive_count INTEGER NOT NULL DEFAULT 0,
    negative_count INTEGER NOT NULL DEFAULT 0,
    neutral_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, path_hash)
);

CREATE TABLE IF NOT EXISTS entity_retrieval_stats (
    agent_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    session_count INTEGER NOT NULL DEFAULT 0,
    last_session_key TEXT,
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, entity_id)
);

CREATE TABLE IF NOT EXISTS entity_cooccurrence (
    agent_id TEXT NOT NULL,
    source_entity_id TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    session_count INTEGER NOT NULL DEFAULT 0,
    last_session_key TEXT,
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, source_entity_id, target_entity_id)
);

CREATE TABLE IF NOT EXISTS path_feedback_sessions (
    agent_id TEXT NOT NULL,
    session_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, session_key)
);
