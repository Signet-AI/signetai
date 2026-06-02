-- Cross-daemon parity: epistemic_assertions (TS migration 071).
CREATE TABLE IF NOT EXISTS epistemic_assertions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL DEFAULT 'default',
    subject_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    claim_attribute_id TEXT REFERENCES entity_attributes(id) ON DELETE SET NULL,
    predicate TEXT NOT NULL CHECK (
        predicate IN ('claims', 'believes', 'observed', 'decided', 'prefers', 'denies', 'questions')
    ),
    content TEXT NOT NULL,
    normalized_content TEXT NOT NULL,
    speaker TEXT,
    asserted_at TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
    evidence TEXT NOT NULL DEFAULT '[]',
    source_kind TEXT,
    source_id TEXT,
    source_path TEXT,
    source_root TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'superseded')),
    supersedes_assertion_id TEXT REFERENCES epistemic_assertions(id) ON DELETE SET NULL,
    archived_at TEXT,
    archived_by TEXT,
    archive_reason TEXT,
    created_by TEXT NOT NULL DEFAULT 'operator',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_epistemic_assertions_agent_entity
    ON epistemic_assertions(agent_id, subject_entity_id, status, asserted_at DESC);
CREATE INDEX IF NOT EXISTS idx_epistemic_assertions_agent_speaker
    ON epistemic_assertions(agent_id, speaker, asserted_at DESC);
CREATE INDEX IF NOT EXISTS idx_epistemic_assertions_agent_predicate
    ON epistemic_assertions(agent_id, predicate, status, asserted_at DESC);
CREATE INDEX IF NOT EXISTS idx_epistemic_assertions_agent_source
    ON epistemic_assertions(agent_id, source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_epistemic_assertions_claim
    ON epistemic_assertions(agent_id, claim_attribute_id);
