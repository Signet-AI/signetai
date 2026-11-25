import type { ftsShardTables } from "@signet/core";
type FtsBase = Parameters<typeof ftsShardTables>[0];
import type { ReadScope } from "./read-scope";
import { getDbAccessor } from "./db-accessor";
import { getDbOwnerForAccessor } from "./db-owner-runtime";

export type ContentReadRequest =
	| { readonly op: "shards"; readonly base: FtsBase; readonly scope: ReadScope }
	| {
			readonly op: "export";
			readonly table: "memories" | "session_transcripts" | "memory_artifacts";
			readonly author: string;
			readonly scope: ReadScope;
			readonly cursor: string;
			readonly limit: number;
	  };

export async function contentRead<Result>(request: ContentReadRequest, signal?: AbortSignal): Promise<Result> {
	const owner = await getDbOwnerForAccessor(getDbAccessor());
	const handle = owner.submit<Result>(
		{ kind: "content_read", request },
		{
			operation: `content.read.${request.op}`,
			lane: "read",
			deadlineMs: 5000,
			estimatedWorkUnits: 500,
		},
	);
	const abort = () => handle.cancel();
	if (signal?.aborted) abort();
	signal?.addEventListener("abort", abort, { once: true });
	try {
		return await handle.result;
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}
