import type { MigrationDb } from "./contract";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>).some(
		(row) => row.name === column,
	);
}
export function up(db: MigrationDb): void {
	const requiredMemoryColumns = [
		"content_hash",
		"normalized_content",
		"memory_kind",
		"source_type",
		"source_path",
		"agent_id",
		"visibility",
		"is_deleted",
		"extraction_status",
	] as const;
	if (
		!hasColumn(db, "entity_attributes", "memory_id") ||
		!requiredMemoryColumns.every((column) => hasColumn(db, "memories", column))
	) {
		return;
	}

	db.exec(`
		INSERT OR IGNORE INTO memories
		 (id, content, normalized_content, content_hash, who, why, project,
		  importance, type, tags, pinned, is_deleted, extraction_status,
		  created_at, updated_at, updated_by, source_type, source_id, source_path,
		  agent_id, visibility, memory_kind)
		SELECT attr.id, attr.content, attr.normalized_content,
		       'semantic-attribute:' || attr.id, 'dreaming', 'Derived semantic attribute', NULL,
		       attr.importance, 'semantic', 'semantic,attribute', 0,
		       CASE WHEN attr.status = 'active' THEN 0 ELSE 1 END, 'completed',
		       attr.created_at, attr.updated_at, 'dreaming', 'dreaming', attr.source_id, attr.source_path,
		       attr.agent_id, 'global', 'derived'
		FROM entity_attributes attr
		WHERE attr.memory_id IS NULL
	`);
	db.exec(`
		UPDATE entity_attributes
		SET memory_id = id
		WHERE memory_id IS NULL
		  AND EXISTS (SELECT 1 FROM memories WHERE memories.id = entity_attributes.id)
	`);
	db.exec(`
		INSERT OR IGNORE INTO memory_entity_mentions (memory_id, entity_id)
		SELECT attr.memory_id, aspect.entity_id
		FROM entity_attributes attr
		JOIN entity_aspects aspect ON aspect.id = attr.aspect_id AND aspect.agent_id = attr.agent_id
		WHERE attr.memory_id IS NOT NULL
	`);
	db.exec(`
		UPDATE entities
		SET mentions = (
			SELECT COUNT(*) FROM memory_entity_mentions WHERE entity_id = entities.id
		)
		WHERE EXISTS (SELECT 1 FROM memory_entity_mentions WHERE entity_id = entities.id)
	`);
}
