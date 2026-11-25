import type { DbOwnerClient } from "./client";
import type { DbOwnerParameter } from "./protocol";
import { DB_OWNER_MAX_WORK_UNITS } from "./protocol";
import type { VectorSearchOptions, VectorSearchResponse } from "@signet/core";
import type { RecallParams, RecallResponse } from "../../recall/search/memory-search";
import type { ResolvedMemoryConfig } from "../../config/memory-config";
import { effectiveRecallLimit, recordRecallPerformed } from "../../telemetry/search/recall";
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
				...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
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
	const response = await client.awaitResult(handle);
	recordRecallPerformed(response, params.telemetrySurface ?? "other", effectiveRecallLimit(params.limit));
	return response;
}
export async function vectorSearchThroughDbOwner(
	client: DbOwnerClient,
	queryEmbedding: readonly number[],
	options: VectorSearchOptions = {},
): Promise<VectorSearchResponse> {
	const maxScanRows = Math.max(1, Math.min(options.maxScanRows ?? DB_OWNER_MAX_WORK_UNITS, DB_OWNER_MAX_WORK_UNITS));
	const handle = client.submit<VectorSearchResponse>(
		{
			kind: "vector_search",
			payload: {
				queryEmbedding,
				options: { ...options, maxScanRows },
			},
		},
		{
			operation: "recall.vector-search",
			lane: "read",
			deadlineMs: 30_000,
			estimatedWorkUnits: maxScanRows,
		},
	);
	return await client.awaitResult(handle);
}
