import type { RecallResponse, RecallResult } from "./memory-search";

export type PublicRecallResult = Omit<RecallResult, "readProvenance">;

export type PublicRecallResponse = Omit<RecallResponse, "results"> & { results: PublicRecallResult[] };

export function publicRecallResult(row: RecallResult): PublicRecallResult {
	const { readProvenance, ...visible } = row;
	return visible;
}

export function publicRecallResponse(response: RecallResponse): PublicRecallResponse {
	return { ...response, results: response.results.map(publicRecallResult) };
}
