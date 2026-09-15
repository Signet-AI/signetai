const activeSourceDeletions = new Set<string>();
const activeSourceMutations = new Set<string>();

export const SOURCE_DELETION_IN_PROGRESS_ERROR = "Source deletion is in progress; retry after it completes";
export const SOURCE_OPERATION_IN_PROGRESS_ERROR = "Source operation is in progress; retry after it completes";

export function beginSourceDeletion(sourceId: string): (() => void) | undefined {
	if (activeSourceDeletions.has(sourceId) || activeSourceMutations.has(sourceId)) return undefined;
	return claimSourceOperation(activeSourceDeletions, sourceId);
}

export function beginSourceMutation(sourceId: string): (() => void) | undefined {
	if (activeSourceDeletions.has(sourceId) || activeSourceMutations.has(sourceId)) return undefined;
	return claimSourceOperation(activeSourceMutations, sourceId);
}

export function isSourceDeletionInFlight(sourceId: string): boolean {
	return activeSourceDeletions.has(sourceId);
}

export function isSourceOperationInFlight(sourceId: string): boolean {
	return activeSourceDeletions.has(sourceId) || activeSourceMutations.has(sourceId);
}

function claimSourceOperation(operations: Set<string>, sourceId: string): () => void {
	operations.add(sourceId);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		operations.delete(sourceId);
	};
}
