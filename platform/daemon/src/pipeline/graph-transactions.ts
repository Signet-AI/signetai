import type { WriteDb } from "../db-accessor";

export interface DecrementInput {
	readonly entityIds: readonly string[];
}

export interface DecrementResult {
	readonly entitiesOrphaned: number;
}
export function txDecrementEntityMentions(db: WriteDb, input: DecrementInput): DecrementResult {
	if (input.entityIds.length === 0) return { entitiesOrphaned: 0 };
	for (const entityId of input.entityIds) {
		db.prepare(
			`UPDATE entities
			 SET mentions = MAX(0, mentions - 1)
			 WHERE id = ?`,
		).run(entityId);
	}
	const placeholders = input.entityIds.map(() => "?").join(", ");
	const orphaned = db
		.prepare(`SELECT id FROM entities WHERE mentions = 0 AND id IN (${placeholders})`)
		.all(...input.entityIds) as Array<{ id: string }>;

	if (orphaned.length > 0) {
		const orphanedPlaceholders = orphaned.map(() => "?").join(", ");
		const ids = orphaned.map((r) => r.id);
		db.prepare(
			`DELETE FROM relations
			 WHERE source_entity_id IN (${orphanedPlaceholders})
			    OR target_entity_id IN (${orphanedPlaceholders})`,
		).run(...ids, ...ids);
		db.prepare(
			`DELETE FROM memory_entity_mentions
			 WHERE entity_id IN (${orphanedPlaceholders})`,
		).run(...ids);
		db.prepare(`DELETE FROM entities WHERE id IN (${orphanedPlaceholders})`).run(...ids);
	}

	return { entitiesOrphaned: orphaned.length };
}
