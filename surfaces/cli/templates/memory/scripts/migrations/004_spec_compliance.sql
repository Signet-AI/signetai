CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_embeddings_dims ON embeddings(dimensions);
CREATE TABLE IF NOT EXISTS conflict_log (
  id            TEXT PRIMARY KEY,
  table_name    TEXT NOT NULL,
  record_id     TEXT NOT NULL,
  local_version TEXT NOT NULL,
  remote_version TEXT NOT NULL,
  resolution    TEXT NOT NULL,
  resolved_at   TEXT NOT NULL,
  resolved_by   TEXT NOT NULL
);
