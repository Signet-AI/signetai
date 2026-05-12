CREATE TABLE IF NOT EXISTS ontology_proposals (
    id          TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL DEFAULT 'default',
    operation   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'applied', 'rejected', 'failed')),
    payload     TEXT NOT NULL,
    confidence  REAL NOT NULL DEFAULT 0.0
        CHECK (confidence >= 0.0 AND confidence <= 1.0),
    rationale   TEXT NOT NULL DEFAULT '',
    evidence    TEXT NOT NULL DEFAULT '[]',
    risk        TEXT,
    source_kind TEXT,
    source_id   TEXT,
    source_path TEXT,
    source_root TEXT,
    created_by  TEXT NOT NULL DEFAULT 'ontology-proposal',
    applied_by  TEXT,
    rejected_by TEXT,
    result      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    applied_at  TEXT,
    rejected_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ontology_proposals_agent_status
    ON ontology_proposals(agent_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ontology_proposals_agent_operation
    ON ontology_proposals(agent_id, operation, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ontology_proposals_source
    ON ontology_proposals(agent_id, source_kind, source_id);
