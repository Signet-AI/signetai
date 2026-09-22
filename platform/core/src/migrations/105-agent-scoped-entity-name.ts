import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		DROP TRIGGER IF EXISTS entities_fts_ai;
		DROP TRIGGER IF EXISTS entities_fts_ad;
		DROP TRIGGER IF EXISTS entities_fts_au;
	`);
	db.exec(`
		CREATE TABLE entities_105 (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			entity_type TEXT NOT NULL,
			description TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			canonical_name TEXT,
			mentions INTEGER DEFAULT 0,
			embedding BLOB,
			agent_id TEXT NOT NULL DEFAULT 'default',
			pinned INTEGER NOT NULL DEFAULT 0,
			pinned_at TEXT,
			last_synthesized_at TEXT,
			community_id TEXT REFERENCES entity_communities(id),
			source_id TEXT,
			source_kind TEXT,
			source_path TEXT,
			source_root TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			archived_at TEXT,
			archived_by TEXT,
			archive_reason TEXT,
			proposal_id TEXT,
			proposal_evidence TEXT NOT NULL DEFAULT '[]',
			UNIQUE(agent_id, name)
		);
	`);
	db.exec(`
		INSERT INTO entities_105 (
			rowid, id, name, entity_type, description, created_at, updated_at,
			canonical_name, mentions, embedding, agent_id, pinned, pinned_at,
			last_synthesized_at, community_id, source_id, source_kind,
			source_path, source_root, status, archived_at, archived_by,
			archive_reason, proposal_id, proposal_evidence
		)
		SELECT
			rowid, id, name, entity_type, description, created_at, updated_at,
			canonical_name, mentions, embedding, agent_id, pinned, pinned_at,
			last_synthesized_at, community_id, source_id, source_kind,
			source_path, source_root, status, archived_at, archived_by,
			archive_reason, proposal_id, proposal_evidence
		FROM entities;
	`);

	db.exec(`
		DROP TABLE entities;
		ALTER TABLE entities_105 RENAME TO entities;
	`);
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_entities_canonical_name ON entities(canonical_name);
		CREATE INDEX IF NOT EXISTS idx_entities_agent ON entities(agent_id);
		CREATE INDEX IF NOT EXISTS idx_entities_pinned ON entities(agent_id, pinned, pinned_at DESC);
		CREATE INDEX IF NOT EXISTS idx_entities_order
			ON entities(agent_id, pinned DESC, pinned_at DESC, mentions DESC, updated_at DESC, name);
		CREATE INDEX IF NOT EXISTS idx_entities_extracted_mentions
			ON entities(entity_type, mentions)
			WHERE entity_type = 'extracted';
		CREATE INDEX IF NOT EXISTS idx_entities_source ON entities(agent_id, source_id, source_path);
		CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(agent_id, status, updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_entities_proposal ON entities(agent_id, proposal_id);
	`);
	db.exec(`
		CREATE TRIGGER IF NOT EXISTS entities_fts_ai AFTER INSERT ON entities BEGIN
			INSERT INTO entities_fts(rowid, name, canonical_name)
			VALUES (new.rowid, new.name, new.canonical_name);
		END;
		CREATE TRIGGER IF NOT EXISTS entities_fts_ad AFTER DELETE ON entities BEGIN
			INSERT INTO entities_fts(entities_fts, rowid, name, canonical_name)
			VALUES ('delete', old.rowid, old.name, old.canonical_name);
		END;
		CREATE TRIGGER IF NOT EXISTS entities_fts_au AFTER UPDATE ON entities BEGIN
			INSERT INTO entities_fts(entities_fts, rowid, name, canonical_name)
			VALUES ('delete', old.rowid, old.name, old.canonical_name);
			INSERT INTO entities_fts(rowid, name, canonical_name)
			VALUES (new.rowid, new.name, new.canonical_name);
		END;
		INSERT INTO entities_fts(entities_fts) VALUES ('rebuild');
	`);
}
