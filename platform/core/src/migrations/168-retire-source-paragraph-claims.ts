import type { MigrationDb } from "./contract";

function hasTable(db: MigrationDb, table: string): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null;
}

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
		(row) => row.name === column,
	);
}

export function up(db: MigrationDb): void {
	if (
		!hasTable(db, "entity_attributes") ||
		!hasTable(db, "entity_aspects") ||
		!hasTable(db, "entities") ||
		!hasColumn(db, "entity_attributes", "source_root") ||
		!hasColumn(db, "entities", "source_root")
	) {
		return;
	}
	const now = new Date().toISOString();
	db.exec(`
		CREATE TEMP TABLE retired_source_paragraphs AS
		SELECT attr.id, attr.memory_id, attr.agent_id, asp.entity_id
		FROM entity_attributes attr
		JOIN entity_aspects asp ON asp.id = attr.aspect_id
		JOIN entities e ON e.id = asp.entity_id
		WHERE e.entity_type IN ('source_document', 'source_document_reference')
		  AND attr.source_root IS NOT NULL
		  AND attr.source_root = e.source_root
		  AND attr.source_id = e.source_id
		  AND attr.source_root NOT IN ('dreaming', 'dreaming_attention')
	`);
	if (hasColumn(db, "entity_attributes", "memory_id") && hasTable(db, "memories")) {
		if (hasTable(db, "memory_history")) {
			db.prepare(
				`INSERT INTO memory_history (id, memory_id, event, old_content, new_content, changed_by, reason, metadata, created_at)
				 SELECT lower(hex(randomblob(16))), mem.id, 'deleted', mem.content, NULL, 'migration:168',
				        'Source paragraph claims retired', '{"force":true}', ?
				 FROM memories mem
				 JOIN retired_source_paragraphs retired ON retired.memory_id = mem.id
				 WHERE mem.is_deleted = 0`,
			).run(now);
		}
		if (hasTable(db, "derived_memory_sources") && hasColumn(db, "memories", "stale_at")) {
			db.prepare(
				`UPDATE memories
				 SET stale_at = ?
				 WHERE stale_at IS NULL
				   AND is_deleted = 0
				   AND id IN (
				     SELECT dms.derived_memory_id
				     FROM derived_memory_sources dms
				     JOIN retired_source_paragraphs retired ON retired.agent_id = dms.agent_id
				     WHERE (dms.source_kind = 'memory' AND dms.source_id = retired.memory_id)
				        OR (dms.source_kind = 'ontology_claim' AND dms.source_id = retired.id)
				   )`,
			).run(now);
		}
		const forget = [
			"is_deleted = 1",
			...(["deleted_at", "updated_at"] as const)
				.filter((column) => hasColumn(db, "memories", column))
				.map((column) => `${column} = $now`),
			...(hasColumn(db, "memories", "updated_by") ? ["updated_by = 'migration:168'"] : []),
			...(hasColumn(db, "memories", "version") ? ["version = version + 1"] : []),
		];
		db.prepare(
			`UPDATE memories
			 SET ${forget.join(", ")}
			 WHERE is_deleted = 0
			   AND id IN (SELECT memory_id FROM retired_source_paragraphs WHERE memory_id IS NOT NULL)`,
		).run({ $now: now });
		if (hasTable(db, "memory_entity_mentions")) {
			db.exec(`
				DELETE FROM memory_entity_mentions
				WHERE memory_id IN (SELECT memory_id FROM retired_source_paragraphs WHERE memory_id IS NOT NULL)
			`);
		}
	}
	if (hasTable(db, "ontology_contradictions")) {
		db.prepare(
			`UPDATE ontology_contradictions
			 SET status = 'resolved', resolved_at = ?, resolution_reason = 'source paragraph claims retired', updated_at = ?
			 WHERE status = 'active'
			   AND (left_attribute_id IN (SELECT id FROM retired_source_paragraphs)
			     OR right_attribute_id IN (SELECT id FROM retired_source_paragraphs))`,
		).run(now, now);
	}
	db.exec(`
		DELETE FROM entity_attributes WHERE id IN (SELECT id FROM retired_source_paragraphs);
		DELETE FROM entity_aspects
		WHERE entity_id IN (
		    SELECT id FROM entities WHERE entity_type IN ('source_document', 'source_document_reference')
		  )
		  AND NOT EXISTS (SELECT 1 FROM entity_attributes attr WHERE attr.aspect_id = entity_aspects.id);
		DROP TABLE retired_source_paragraphs;
	`);
}
