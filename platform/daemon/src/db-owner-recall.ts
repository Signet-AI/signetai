import type { DbOwnerClient } from "./db-owner-client";
import type { DbOwnerParameter } from "./db-owner-protocol";
import type { RecallParams, RecallResponse } from "./memory-search";
import type { ResolvedMemoryConfig } from "./memory-config";

/**
 * Minimal recall seam for the Phase C plumbing proof. Category migrations can
 * replace their synchronous recall query with this helper without learning
 * whether the client has one owner or a future set of read lanes.
 */
export async function recallThroughDbOwner<Row extends object>(
	client: DbOwnerClient,
	sql: string,
	params: readonly DbOwnerParameter[] = [],
	options: { readonly deadlineMs?: number } = {},
): Promise<readonly Row[]> {
	const handle = client.submit<Row[]>(
		{ kind: "query", statement: { sql, params, result: "all" } },
		{ operation: "recall.read", lane: "read", deadlineMs: options.deadlineMs ?? 5_000 },
	);
	return await client.awaitResult(handle);
}

/** Execute the full hybrid recall algorithm inside the owner read lane. */
export async function hybridRecallThroughDbOwner(
	client: DbOwnerClient,
	params: RecallParams,
	config: ResolvedMemoryConfig,
	options: { readonly deadlineMs?: number; readonly queryEmbedding?: readonly number[] | null } = {},
): Promise<RecallResponse> {
	const handle = client.submit<RecallResponse>(
		{
			kind: "recall",
			payload: {
				params,
				config,
				query: params.query,
				...(options.queryEmbedding !== undefined ? { queryEmbedding: options.queryEmbedding } : {}),
			},
		},
		{
			operation: "recall.hybrid",
			lane: "read",
			deadlineMs: options.deadlineMs ?? 30_000,
			estimatedWorkUnits: Math.max(1, Math.min(10_000, (params.limit ?? 10) * 100)),
		},
	);
	return await client.awaitResult(handle);
}
