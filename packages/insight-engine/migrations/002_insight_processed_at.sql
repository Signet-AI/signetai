-- Migration 002: Add insight_processed_at to memories table
-- Tracks when each memory was last included in an insight synthesis pass
-- NULL = never processed; ISO date string = last synthesis timestamp

-- SQLite ALTER TABLE IF NOT EXISTS column is not supported in older versions,
-- so we use a safe conditional approach via a trigger workaround:
-- Just run the ALTER and ignore the error if column already exists.
-- The migrate.js script handles the "duplicate column" error gracefully.

ALTER TABLE memories ADD COLUMN insight_processed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_insight_processed
  ON memories(insight_processed_at)
  WHERE insight_processed_at IS NULL;
