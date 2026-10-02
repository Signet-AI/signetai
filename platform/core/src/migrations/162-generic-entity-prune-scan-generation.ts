import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS generic_entity_prune_scan_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			generation INTEGER NOT NULL
		);
		INSERT OR IGNORE INTO generic_entity_prune_scan_state (id, generation) VALUES (1, 0);

		CREATE TRIGGER IF NOT EXISTS trg_entities_prune_scan_insert
		AFTER INSERT ON entities
		BEGIN
			UPDATE generic_entity_prune_scan_state SET generation = generation + 1 WHERE id = 1;
		END;
		CREATE TRIGGER IF NOT EXISTS trg_entities_prune_scan_delete
		AFTER DELETE ON entities
		BEGIN
			UPDATE generic_entity_prune_scan_state SET generation = generation + 1 WHERE id = 1;
		END;
		CREATE TRIGGER IF NOT EXISTS trg_entities_prune_scan_update
		AFTER UPDATE OF name, canonical_name, entity_type, agent_id, pinned, updated_at ON entities
		BEGIN
			UPDATE generic_entity_prune_scan_state SET generation = generation + 1 WHERE id = 1;
		END;

		CREATE TRIGGER IF NOT EXISTS trg_skill_meta_prune_scan_insert
		AFTER INSERT ON skill_meta
		BEGIN
			UPDATE generic_entity_prune_scan_state SET generation = generation + 1 WHERE id = 1;
		END;
		CREATE TRIGGER IF NOT EXISTS trg_skill_meta_prune_scan_update
		AFTER UPDATE OF entity_id ON skill_meta
		BEGIN
			UPDATE generic_entity_prune_scan_state SET generation = generation + 1 WHERE id = 1;
		END;
		CREATE TRIGGER IF NOT EXISTS trg_skill_meta_prune_scan_delete
		AFTER DELETE ON skill_meta
		BEGIN
			UPDATE generic_entity_prune_scan_state SET generation = generation + 1 WHERE id = 1;
		END;
	`);
}
