import { requestMemoryHead, type MemoryHeadRequest } from "./memory-head";
export const CURATED_MEMORY_HEAD_MAX_TOKENS = 1000;
export type MemoryHeadResult = {
	readonly ok: boolean;
	readonly code?: string;
	readonly error?: string;
	readonly revision?: number;
	readonly hash?: string;
	readonly changedIds?: readonly string[];
};
export function readCuratedMemoryHead(agentId: string): Promise<Record<string, unknown>> {
	return requestMemoryHead({ action: "read", agentId });
}
export function commitCuratedMemoryHead(
	input: Extract<MemoryHeadRequest, { action: "commit" }>["input"],
): Promise<MemoryHeadResult> {
	return requestMemoryHead({ action: "commit", input });
}
