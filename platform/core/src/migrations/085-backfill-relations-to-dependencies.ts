/**
 * Migration 085: Backfill relations into entity_dependencies.
 *
 * The extraction pipeline writes extracted entity triples into the `relations`
 * table (legacy), while graph diagnostics and traversal read from
 * `entity_dependencies` (current). No code was bridging them, so extracted
 * relations were invisible to graph traversal: edgeCount was always 0.
 *
 * This migration copies every existing `relations` row into
 * `entity_dependencies`, mapping columns across the schema difference.
 * Idempotent — INSERT OR IGNORE skips rows that already exist (matched on
 * source_entity_id, target_entity_id, dependency_type, agent_id via the
 * idx_entity_deps_unique index).
 */
import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('relations', 'entity_dependencies')")
		.all() as ReadonlyArray<Record<string, unknown>>;
	const tableNames = new Set(tables.map((r) => String(r.name)));

	if (!tableNames.has("relations") || !tableNames.has("entity_dependencies")) return;

	const relCols = db.prepare("PRAGMA table_info(relations)").all() as ReadonlyArray<Record<string, unknown>>;
	const depCols = db.prepare("PRAGMA table_info(entity_dependencies)").all() as ReadonlyArray<Record<string, unknown>>;
	const rel = new Set(relCols.map((c) => String(c.name)));
	const dep = new Set(depCols.map((c) => String(c.name)));

	if (!rel.has("source_entity_id") || !rel.has("relation_type")) return;
	if (!dep.has("source_entity_id") || !dep.has("dependency_type") || !dep.has("agent_id")) return;

	const hasRelConfidence = rel.has("confidence");
	const hasRelUpdated = rel.has("updated_at");
	const hasDepConfidence = dep.has("confidence");
	const hasDepReason = dep.has("reason");
	const hasDepStatus = dep.has("status");

	// Build the SELECT expression list for INSERT INTO entity_dependencies.
	// INSERT ... SELECT matches by position, so we use positional mapping.
	const selectParts: string[] = ["id", "source_entity_id", "target_entity_id"];
	const colParts: string[] = ["id", "source_entity_id", "target_entity_id"];

	// dependency_type <- relation_type
	selectParts.push("relation_type");  // value only, no alias needed
	colParts.push("dependency_type");

	// strength, created_at
	selectParts.push("strength", "created_at");
	colParts.push("strength", "created_at");

	// agent_id — relations has none, use 'default'
	selectParts.push("'default'");
	colParts.push("agent_id");

	// aspect_id — always NULL for extracted relations
	selectParts.push("NULL");
	colParts.push("aspect_id");

	// confidence (optional)
	if (hasRelConfidence && hasDepConfidence) {
		selectParts.push("confidence");
		colParts.push("confidence");
	}

	// reason (optional)
	if (hasDepReason) {
		selectParts.push("'extracted'");
		colParts.push("reason");
	}

	// status (optional)
	if (hasDepStatus) {
		selectParts.push("'active'");
		colParts.push("status");
	}

	// updated_at (optional)
	if (hasRelUpdated && dep.has("updated_at")) {
		selectParts.push("updated_at");
		colParts.push("updated_at");
	}

	const selectClause = selectParts.join(", ");
	const colsClause = colParts.join(", ");

	db.exec(
		`INSERT OR IGNORE INTO entity_dependencies (${colsClause})
		 SELECT ${selectClause}
		 FROM relations
		 WHERE source_entity_id IS NOT NULL
		   AND target_entity_id IS NOT NULL
		   AND relation_type IS NOT NULL`,
	);
}
