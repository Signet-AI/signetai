-- Migration 032: Session Transcripts (Lossless Retention)
--
-- Stores raw session transcripts alongside extracted facts.
-- Extraction creates the search surface; the transcript preserves
-- completeness so nothing is permanently lost.
--
-- Single-column primary key on session_key. Migration 034 upgrades
-- this to a compound (session_key, agent_id) key for multi-agent support.

CREATE TABLE IF NOT EXISTS session_transcripts (
    session_key TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    harness     TEXT,
    project     TEXT,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_st_project
    ON session_transcripts(project);
CREATE INDEX IF NOT EXISTS idx_st_created
    ON session_transcripts(created_at);
