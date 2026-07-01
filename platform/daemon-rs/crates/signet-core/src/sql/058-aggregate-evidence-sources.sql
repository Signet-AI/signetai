-- Cross-daemon parity: typed aggregate recall evidence links (TS migration 082).
CREATE TABLE IF NOT EXISTS aggregate_evidence_sources (
    aggregate_memory_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_path TEXT,
    agent_id TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL,
    PRIMARY KEY (aggregate_memory_id, source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_aggregate_evidence_sources_agent
    ON aggregate_evidence_sources(agent_id, aggregate_memory_id);
CREATE INDEX IF NOT EXISTS idx_aggregate_evidence_sources_source
    ON aggregate_evidence_sources(source_kind, source_id);
