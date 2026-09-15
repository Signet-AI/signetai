const activeSourceDeletions = new Set<string>();

export const SOURCE_DELETION_IN_PROGRESS_ERROR = "Source deletion is in progress; retry after it completes";

export function beginSourceDeletion(sourceId: string): (() => void) | undefined {
	if (activeSourceDeletions.has(sourceId)) return undefined;
	activeSourceDeletions.add(sourceId);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		activeSourceDeletions.delete(sourceId);
	};
}

export function isSourceDeletionInFlight(): boolean {
	return activeSourceDeletions.size > 0;
}
