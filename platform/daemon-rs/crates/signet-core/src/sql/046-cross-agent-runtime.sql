-- Rust runtime backing tables for cross-agent API parity.
--
-- TypeScript keeps this state in memory; daemon-rs persists it so restarts and
-- shadow comparisons have a stable substrate.

CREATE TABLE IF NOT EXISTS agent_presence (
    key          TEXT PRIMARY KEY,
    session_key  TEXT,
    agent_id     TEXT,
    harness      TEXT NOT NULL DEFAULT 'unknown',
    project      TEXT,
    runtime_path TEXT,
    provider     TEXT,
    started_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_presence_last_seen
    ON agent_presence(last_seen_at);

CREATE INDEX IF NOT EXISTS idx_agent_presence_agent_session
    ON agent_presence(agent_id, session_key);

CREATE TABLE IF NOT EXISTS agent_messages (
    id              TEXT PRIMARY KEY,
    created_at      TEXT NOT NULL,
    from_agent_id   TEXT,
    from_session_key TEXT,
    to_agent_id     TEXT,
    to_session_key  TEXT,
    content         TEXT NOT NULL,
    type            TEXT NOT NULL DEFAULT 'info',
    broadcast       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_created
    ON agent_messages(created_at);

CREATE INDEX IF NOT EXISTS idx_agent_messages_agents
    ON agent_messages(from_agent_id, to_agent_id);
