-- Migration 033: Session Extract Cursors
--
-- Tracks the last transcript offset processed by mid-session checkpoint
-- extraction. Enables delta extraction: each checkpoint only processes
-- content since the previous extraction, avoiding duplicate summaries.

CREATE TABLE IF NOT EXISTS session_extract_cursors (
    session_key TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    last_offset INTEGER NOT NULL DEFAULT 0,
    last_extract_at TEXT NOT NULL,
    PRIMARY KEY (session_key, agent_id)
);
