CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  harness       TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  summary       TEXT,
  topics        TEXT,
  decisions     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  updated_by    TEXT NOT NULL,
  vector_clock  TEXT NOT NULL DEFAULT '{}',
  version       INTEGER DEFAULT 1,
  manual_override INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS embeddings (
  id            TEXT PRIMARY KEY,
  content_hash  TEXT NOT NULL,
  vector        BLOB NOT NULL,
  dimensions    INTEGER NOT NULL,
  source_type   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  chunk_text    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
