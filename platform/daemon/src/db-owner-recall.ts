import type { DbOwnerClient } from "./db-owner-client";
import type { DbOwnerParameter } from "./db-owner-protocol";

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
	return await handle.result;
}
