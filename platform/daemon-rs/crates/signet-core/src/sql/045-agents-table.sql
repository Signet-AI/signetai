-- TypeScript parity: migration 043 agents table.
--
-- This file is not part of the Rust migration version sequence. It is applied
-- from ensure_cross_daemon_parity_tables so fresh Rust databases expose the
-- same agent roster table expected by TS daemon routes.

CREATE TABLE IF NOT EXISTS agents (
    id           TEXT PRIMARY KEY,
    name         TEXT,
    read_policy  TEXT NOT NULL DEFAULT 'isolated',
    policy_group TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

INSERT OR IGNORE INTO agents (id, name, read_policy, created_at, updated_at)
VALUES ('default', 'default', 'shared', datetime('now'), datetime('now'));

CREATE INDEX IF NOT EXISTS idx_memories_agent_id
    ON memories(agent_id);

CREATE INDEX IF NOT EXISTS idx_memories_agent_visibility
    ON memories(agent_id, visibility);
