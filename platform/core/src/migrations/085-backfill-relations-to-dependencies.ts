import type { MigrationDb } from "./contract";

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
	const selectParts: string[] = ["id", "source_entity_id", "target_entity_id"];
	const colParts: string[] = ["id", "source_entity_id", "target_entity_id"];
	selectParts.push("relation_type");
	colParts.push("dependency_type");
	selectParts.push("strength", "created_at");
	colParts.push("strength", "created_at");
	selectParts.push("'default'");
	colParts.push("agent_id");
	selectParts.push("NULL");
	colParts.push("aspect_id");
	if (hasRelConfidence && hasDepConfidence) {
		selectParts.push("confidence");
		colParts.push("confidence");
	}
	if (hasDepReason) {
		selectParts.push("'extracted'");
		colParts.push("reason");
	}
	if (hasDepStatus) {
		selectParts.push("'active'");
		colParts.push("status");
	}
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
