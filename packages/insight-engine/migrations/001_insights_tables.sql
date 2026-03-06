-- Migration 001: Add insights and insight_sources tables
-- Safe to run against the live memories.db — only creates NEW tables, never modifies existing ones

CREATE TABLE IF NOT EXISTS insights (
  id TEXT PRIMARY KEY,
  cluster_entity_id TEXT,
  cluster_label TEXT,
  source_memory_ids TEXT NOT NULL DEFAULT '[]',
  source_entity_ids TEXT DEFAULT '[]',
  insight TEXT NOT NULL,
  connections TEXT DEFAULT '[]',
  themes TEXT DEFAULT '[]',
  importance REAL DEFAULT 0.7,
  model_used TEXT,
  synthesis_version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  applied_to_synthesis INTEGER DEFAULT 0,
  is_deleted INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_insights_entity      ON insights(cluster_entity_id);
CREATE INDEX IF NOT EXISTS idx_insights_created     ON insights(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_insights_synthesis   ON insights(applied_to_synthesis);
CREATE INDEX IF NOT EXISTS idx_insights_deleted     ON insights(is_deleted);

CREATE TABLE IF NOT EXISTS insight_sources (
  insight_id TEXT NOT NULL REFERENCES insights(id),
  memory_id  TEXT NOT NULL,
  PRIMARY KEY (insight_id, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_insight_sources_memory ON insight_sources(memory_id);
CREATE INDEX IF NOT EXISTS idx_insight_sources_insight ON insight_sources(insight_id);
