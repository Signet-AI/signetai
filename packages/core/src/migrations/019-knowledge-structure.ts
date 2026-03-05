/**
 * Migration 019: Knowledge Architecture Structure
 *
 * Adds structural backbone for the knowledge graph:
 * - Backfills agent_id on existing entities table
 * - Creates entity_aspects, entity_attributes, entity_dependencies, task_meta
 *
 * Part of KA-1 (Schema + Types + Read/Write Helpers).
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	// -- 1a. Backfill agent_id on entities (idempotent) --
	const entityCols = db.prepare("PRAGMA table_info(entities)").all() as ReadonlyArray<
		Record<string, unknown>
	>;
	const entityColNames = new Set(
		entityCols.flatMap((c) => (typeof c.name === "string" ? [c.name] : [])),
	);

	if (!entityColNames.has("agent_id")) {
		db.exec(
			"ALTER TABLE entities ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'",
		);
	}
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_entities_agent ON entities(agent_id)",
	);

	// -- 1b. entity_aspects --
	db.exec(`
		CREATE TABLE IF NOT EXISTS entity_aspects (
			id             TEXT PRIMARY KEY,
			entity_id      TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
			agent_id       TEXT NOT NULL DEFAULT 'default',
			name           TEXT NOT NULL,
			canonical_name TEXT NOT NULL,
			weight         REAL NOT NULL DEFAULT 0.5,
			created_at     TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(entity_id, canonical_name)
		);

		CREATE INDEX IF NOT EXISTS idx_entity_aspects_entity ON entity_aspects(entity_id);
		CREATE INDEX IF NOT EXISTS idx_entity_aspects_agent ON entity_aspects(agent_id);
		CREATE INDEX IF NOT EXISTS idx_entity_aspects_weight ON entity_aspects(weight DESC);
	`);

	// -- 1c. entity_attributes --
	db.exec(`
		CREATE TABLE IF NOT EXISTS entity_attributes (
			id                 TEXT PRIMARY KEY,
			aspect_id          TEXT REFERENCES entity_aspects(id) ON DELETE SET NULL,
			agent_id           TEXT NOT NULL DEFAULT 'default',
			memory_id          TEXT REFERENCES memories(id) ON DELETE SET NULL,
			kind               TEXT NOT NULL,
			content            TEXT NOT NULL,
			normalized_content TEXT NOT NULL,
			confidence         REAL NOT NULL DEFAULT 0.0,
			importance         REAL NOT NULL DEFAULT 0.5,
			status             TEXT NOT NULL DEFAULT 'active',
			superseded_by      TEXT,
			created_at         TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_entity_attributes_aspect ON entity_attributes(aspect_id);
		CREATE INDEX IF NOT EXISTS idx_entity_attributes_agent ON entity_attributes(agent_id);
		CREATE INDEX IF NOT EXISTS idx_entity_attributes_kind ON entity_attributes(kind);
		CREATE INDEX IF NOT EXISTS idx_entity_attributes_status ON entity_attributes(status);
	`);

	// -- 1d. entity_dependencies --
	db.exec(`
		CREATE TABLE IF NOT EXISTS entity_dependencies (
			id                TEXT PRIMARY KEY,
			source_entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
			target_entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
			agent_id          TEXT NOT NULL DEFAULT 'default',
			aspect_id         TEXT REFERENCES entity_aspects(id) ON DELETE SET NULL,
			dependency_type   TEXT NOT NULL,
			strength          REAL NOT NULL DEFAULT 0.5,
			created_at        TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_entity_dependencies_source ON entity_dependencies(source_entity_id);
		CREATE INDEX IF NOT EXISTS idx_entity_dependencies_target ON entity_dependencies(target_entity_id);
		CREATE INDEX IF NOT EXISTS idx_entity_dependencies_agent ON entity_dependencies(agent_id);
	`);

	// -- 1e. task_meta --
	db.exec(`
		CREATE TABLE IF NOT EXISTS task_meta (
			entity_id        TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
			agent_id         TEXT NOT NULL DEFAULT 'default',
			status           TEXT NOT NULL,
			expires_at       TEXT,
			retention_until  TEXT,
			completed_at     TEXT,
			updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_task_meta_agent ON task_meta(agent_id);
		CREATE INDEX IF NOT EXISTS idx_task_meta_status ON task_meta(status);
		CREATE INDEX IF NOT EXISTS idx_task_meta_retention ON task_meta(retention_until);
	`);
}
