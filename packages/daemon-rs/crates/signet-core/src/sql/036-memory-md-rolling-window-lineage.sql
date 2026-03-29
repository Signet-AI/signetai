-- Migration 036: MEMORY.md rolling-window lineage
--
-- Adds canonical markdown artifact indexing and richer summary job metadata
-- so MEMORY.md can be rebuilt from immutable artifacts plus DB-native state.

CREATE TABLE IF NOT EXISTS memory_artifacts (
    agent_id TEXT NOT NULL DEFAULT 'default',
    source_path TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    session_id TEXT NOT NULL,
    session_key TEXT,
    session_token TEXT NOT NULL,
    project TEXT,
    harness TEXT,
    captured_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    manifest_path TEXT,
    source_node_id TEXT,
    memory_sentence TEXT,
    memory_sentence_quality TEXT,
    content TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, source_path)
);

CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_kind
    ON memory_artifacts(agent_id, source_kind, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_session
    ON memory_artifacts(agent_id, session_token, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_membership
    ON memory_artifacts(agent_id, COALESCE(ended_at, captured_at) DESC);

CREATE TABLE IF NOT EXISTS memory_artifact_tombstones (
    agent_id TEXT NOT NULL DEFAULT 'default',
    session_token TEXT NOT NULL,
    removed_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    removed_paths TEXT NOT NULL,
    PRIMARY KEY (agent_id, session_token)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_artifacts_fts USING fts5(
    content,
    source_path,
    content='memory_artifacts',
    content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memory_artifacts_fts_ai AFTER INSERT ON memory_artifacts BEGIN
    INSERT INTO memory_artifacts_fts(rowid, content, source_path)
    VALUES (new.rowid, new.content, new.source_path);
END;

CREATE TRIGGER IF NOT EXISTS memory_artifacts_fts_ad AFTER DELETE ON memory_artifacts BEGIN
    INSERT INTO memory_artifacts_fts(memory_artifacts_fts, rowid, content, source_path)
    VALUES ('delete', old.rowid, old.content, old.source_path);
END;

CREATE TRIGGER IF NOT EXISTS memory_artifacts_fts_au AFTER UPDATE ON memory_artifacts BEGIN
    INSERT INTO memory_artifacts_fts(memory_artifacts_fts, rowid, content, source_path)
    VALUES ('delete', old.rowid, old.content, old.source_path);
    INSERT INTO memory_artifacts_fts(rowid, content, source_path)
    VALUES (new.rowid, new.content, new.source_path);
END;
