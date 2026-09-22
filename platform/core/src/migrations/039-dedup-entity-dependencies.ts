import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		DELETE FROM entity_dependencies
		WHERE id NOT IN (
			SELECT MIN(id) FROM entity_dependencies
			GROUP BY source_entity_id, target_entity_id,
			         dependency_type, agent_id
		)
	`);

	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS
			idx_entity_deps_unique
		ON entity_dependencies(
			source_entity_id, target_entity_id,
			dependency_type, agent_id
		)
	`);
}
