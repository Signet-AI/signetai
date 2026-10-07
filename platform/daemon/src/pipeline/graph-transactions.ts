import type { WriteDb } from "../db-accessor";

export interface DecrementInput {
	readonly entityIds: readonly string[];
}
export function txDecrementEntityMentions(db: WriteDb, input: DecrementInput): void {
	if (input.entityIds.length === 0) return;
	const decrement = db.prepare(
		`UPDATE entities
		 SET mentions = MAX(0, mentions - 1)
		 WHERE id = ?`,
	);
	for (const entityId of input.entityIds) decrement.run(entityId);
}
