-- Migration 004: Spec compliance fixes
-- Fixes schema to match Signet spec v0.2.1

-- Add missing indexes
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_embeddings_dims ON embeddings(dimensions);

-- Add conflict_log table (Level 3 requirement)
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

-- Note: memories.id type change (INTEGER -> TEXT) requires table rebuild
-- This is handled separately due to SQLite limitations
