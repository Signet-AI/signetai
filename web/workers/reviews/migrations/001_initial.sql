CREATE TABLE IF NOT EXISTS reviews (
  id          TEXT    PRIMARY KEY,
  target_type TEXT    NOT NULL CHECK (target_type IN ('skill', 'mcp')),
  target_id   TEXT    NOT NULL,
  display_name TEXT   NOT NULL,
  rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title        TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  received_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_target
  ON reviews (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_reviews_updated
  ON reviews (updated_at DESC);
