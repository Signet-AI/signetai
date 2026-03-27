-- Migration 032: Session Transcripts (Lossless Retention)
--
-- Stores raw session transcripts alongside extracted facts.
-- Extraction creates the search surface; the transcript preserves
-- completeness so nothing is permanently lost.
--
-- Compound primary key (session_key, agent_id) matches the TS daemon schema
-- so queries that scope by agent_id work correctly against this table.

CREATE TABLE IF NOT EXISTS session_transcripts (
    session_key TEXT NOT NULL,
    agent_id    TEXT NOT NULL DEFAULT 'default',
    content     TEXT NOT NULL,
    harness     TEXT,
    project     TEXT,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (session_key, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_st_project
    ON session_transcripts(project);
CREATE INDEX IF NOT EXISTS idx_st_created
    ON session_transcripts(created_at);
