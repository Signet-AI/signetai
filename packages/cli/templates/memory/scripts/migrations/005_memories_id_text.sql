-- Migration 005: Convert memories.id from INTEGER to TEXT (UUID)
-- SQLite requires table rebuild for column type changes

-- Step 1: Create new table with correct schema
CREATE TABLE memories_new (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL DEFAULT 'fact',
  category        TEXT,
  content         TEXT NOT NULL,
  confidence      REAL DEFAULT 1.0,
  source_id       TEXT,
  source_type     TEXT DEFAULT 'manual',
  tags            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by      TEXT NOT NULL DEFAULT 'legacy',
  vector_clock    TEXT NOT NULL DEFAULT '{}',
  version         INTEGER DEFAULT 1,
  manual_override INTEGER DEFAULT 0,
  -- Legacy fields (keep for compatibility)
  who             TEXT,
  why             TEXT,
  project         TEXT,
  session_id      TEXT,
  importance      REAL DEFAULT 0.5,
  last_accessed   TEXT,
  access_count    INTEGER DEFAULT 0,
  pinned          INTEGER DEFAULT 0
);

-- Step 2: Copy data with UUID conversion
INSERT INTO memories_new (
  id, type, category, content, confidence, source_id, source_type, tags,
  created_at, updated_at, updated_by, vector_clock, version, manual_override,
  who, why, project, session_id, importance, last_accessed, access_count, pinned
)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || 
        substr(hex(randomblob(2)),2) || '-' || 
        substr('89ab', abs(random()) % 4 + 1, 1) || 
        substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
  COALESCE(type, 'fact'),
  category,
  content,
  COALESCE(confidence, 1.0),
  source_id,
  COALESCE(source_type, 'manual'),
  tags,
  COALESCE(created_at, datetime('now')),
  COALESCE(updated_at, datetime('now')),
  COALESCE(updated_by, 'legacy'),
  COALESCE(vector_clock, '{}'),
  COALESCE(version, 1),
  COALESCE(manual_override, 0),
  who,
  why,
  project,
  session_id,
  COALESCE(importance, 0.5),
  last_accessed,
  COALESCE(access_count, 0),
  COALESCE(pinned, 0)
FROM memories;

-- Step 3: Drop old table and rename
DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;

-- Step 4: Recreate indexes
CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_category ON memories(category);
CREATE INDEX idx_memories_source ON memories(source_type, source_id);
CREATE INDEX idx_memories_created ON memories(created_at DESC);

-- Step 5: Recreate FTS triggers
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES('delete', old.rowid, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
