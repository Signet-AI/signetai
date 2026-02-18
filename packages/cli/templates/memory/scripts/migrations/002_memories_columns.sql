-- Migration 002: Add missing columns to memories table

ALTER TABLE memories ADD COLUMN updated_at TEXT;
ALTER TABLE memories ADD COLUMN updated_by TEXT DEFAULT 'legacy';
ALTER TABLE memories ADD COLUMN vector_clock TEXT DEFAULT '{}';
ALTER TABLE memories ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE memories ADD COLUMN manual_override INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN confidence REAL DEFAULT 1.0;
ALTER TABLE memories ADD COLUMN source_id TEXT;
ALTER TABLE memories ADD COLUMN source_type TEXT DEFAULT 'manual';
ALTER TABLE memories ADD COLUMN category TEXT;

-- Backfill updated_at from created_at
UPDATE memories SET updated_at = created_at WHERE updated_at IS NULL;
