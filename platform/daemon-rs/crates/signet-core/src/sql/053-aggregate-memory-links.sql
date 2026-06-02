-- Cross-daemon parity: aggregate_memory_sources (TS migration 074).
CREATE TABLE IF NOT EXISTS aggregate_memory_sources (
    aggregate_memory_id TEXT NOT NULL,
    source_memory_id TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL,
    PRIMARY KEY (aggregate_memory_id, source_memory_id)
);
CREATE INDEX IF NOT EXISTS idx_aggregate_memory_sources_agent
    ON aggregate_memory_sources(agent_id, aggregate_memory_id);
