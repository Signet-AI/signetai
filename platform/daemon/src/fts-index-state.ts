/**
 * Process-local snapshot of the persistent FTS completeness state.
 *
 * Recall reads this value without touching SQLite. The database owner and the
 * FTS triggers keep the persistent counters current; startup hydrates the
 * snapshot once, and owner backfill updates it when progress is committed.
 */

let incomplete = true;

export function setFtsIndexIncomplete(value: boolean): void {
	incomplete = value;
}

export function isFtsIndexIncomplete(): boolean {
	return incomplete;
}

export function resetFtsIndexState(): void {
	incomplete = true;
}
