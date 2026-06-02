-- Cross-daemon parity: entity_communities (TS migration 037).
CREATE TABLE IF NOT EXISTS entity_communities (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT,
    cohesion REAL DEFAULT 0.0,
    member_count INTEGER DEFAULT 0,
    source_id TEXT,
    source_kind TEXT,
    source_path TEXT,
    source_root TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entity_communities_agent ON entity_communities(agent_id);
CREATE INDEX IF NOT EXISTS idx_entity_communities_source ON entity_communities(agent_id, source_id, source_path);
