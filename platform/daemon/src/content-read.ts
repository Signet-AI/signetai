import type { ftsShardTables } from "@signet/core";

import type { ReadScope } from "./read-scope";
import { getDbAccessor } from "./db-accessor";
import { getDbOwnerForAccessor } from "./db-owner-runtime";

import type { NamedContentReadRequest } from "./named-content-reads";
type FtsBase = Parameters<typeof ftsShardTables>[0];
export type AuthoredExportTable = "memories" | "session_transcripts" | "memory_artifacts";
export type ContentReadRequest =
	| {
			readonly op: "export_content";
			readonly table: AuthoredExportTable;
			readonly author: string;
			readonly scope: ReadScope;
			readonly row: number;
			readonly offset: number;
			readonly length: number;
			readonly expectedBytes: number;
			readonly expectedUpdatedAt: string | null;
	  }
	| NamedContentReadRequest
	| {
			readonly op: "readable_pointers";
			readonly scope: ReadScope;
			readonly references: readonly {
				readonly kind: "memory" | "session" | "summary" | "artifact" | "document";
				readonly id: string;
			}[];
	  }
	| {
			readonly op: "continuity";
			readonly scope: ReadScope;
			readonly latest: boolean;
			readonly project?: string;
			readonly limit: number;
	  }
	| { readonly op: "dedupe_compartment"; readonly writeScope: import("@signet/core").CompartmentWriteScope }
	| {
			readonly op: "forget_candidates";
			readonly legacy: boolean;
			readonly scope: ReadScope;
			readonly request: import("./memory-forget-read").ForgetCandidatesRequest;
			readonly ids?: readonly string[];
			readonly mutation: {
				readonly sql: string;
				readonly args: readonly import("./db-owner-protocol").DbOwnerParameter[];
			};
	  }
	| { readonly op: "timeline"; readonly scope: ReadScope; readonly tzOffsetMin: number }
	| {
			readonly op: "blackbox_list";
			readonly scope: ReadScope;
			readonly agentId: string;
			readonly project?: string;
			readonly limit: number;
	  }
	| {
			readonly op: "blackbox";
			readonly scope: ReadScope;
			readonly agentId: string;
			readonly project?: string;
			readonly sessionKey: string;
			readonly at?: string;
			readonly limit: number;
	  }
	| {
			readonly op: "import_file";
			readonly scope: ReadScope;
			readonly subject: import("./read-scope").AudienceSubject;
			readonly jobId: string;
			readonly fileId: string;
			readonly cursor?: number;
	  }
	| {
			readonly op: "import_bytes";
			readonly scope: ReadScope;
			readonly subject: import("./read-scope").AudienceSubject;
			readonly jobId: string;
			readonly fileId: string;
			readonly recordId: string;
			readonly offset: number;
			readonly length: number;
	  }
	| {
			readonly op: "source_snapshot";
			readonly scope: ReadScope;
			readonly source: import("@signet/core").SignetSourceEntry;
			readonly agentId: string;
			readonly includeLocalDiscord: boolean;
	  }
	| {
			readonly op: "source_eligibility";
			readonly scope: ReadScope;
			readonly sourceId: string;
			readonly legacyRoot?: string;
	  }
	| {
			readonly op: "source_access";
			readonly scope: ReadScope;
			readonly sourceId: string;
			readonly agentId: string;
			readonly subject: import("./read-scope").AudienceSubject;
	  }
	| {
			readonly op: "projection_rows";
			readonly scope: ReadScope;
			readonly query: import("./umap-projection").ProjectionQuery;
	  }
	| {
			readonly op: "similar";
			readonly scope: ReadScope;
			readonly vector: readonly number[];
			readonly excludeId: string;
			readonly limit: number;
			readonly type?: string;
	  }
	| {
			readonly op: "embeddings";
			readonly scope: ReadScope;
			readonly vectors: boolean;
			readonly limit: number;
			readonly offset: number;
	  }
	| {
			readonly op: "documents";
			readonly scope: ReadScope;
			readonly localGlobal?: boolean;
			readonly memoryScope?: ReadScope;
			readonly mode: "list" | "detail" | "chunks";
			readonly id?: string;
			readonly status?: string;
			readonly limit: number;
			readonly offset: number;
	  }
	| {
			readonly op: "summary_expand";
			readonly id: string;
			readonly agentId: string;
			readonly scope: ReadScope;
			readonly includeTranscript: boolean;
			readonly transcriptCharLimit?: number;
	  }
	| {
			readonly op: "transcripts";
			readonly scope: ReadScope;
			readonly mode: "list" | "detail" | "search";
			readonly sessionKey?: string;
			readonly query?: string;
			readonly excludeSessionKey?: string;
			readonly limit: number;
	  }
	| {
			readonly op: "summaries";
			readonly scope: ReadScope;
			readonly depth?: number;
			readonly sessionKey?: string;
			readonly limit: number;
			readonly offset: number;
	  }
	| {
			readonly op: "checkpoints";
			readonly scope: ReadScope;
			readonly sessionKey?: string;
			readonly project?: string;
			readonly limit: number;
	  }
	| { readonly op: "shards"; readonly base: FtsBase; readonly scope: ReadScope }
	| {
			readonly op: "export";
			readonly table: AuthoredExportTable;
			readonly author: string;
			readonly scope: ReadScope;
			readonly cursor: number;
			readonly limit: number;
	  };

function estimatedReadWork(request: ContentReadRequest): number {
	if ("parameters" in request && request.op === "sources.import.export")
		return 1 + (request.filters?.cursor ? 0 : (request.filters?.offset ?? 0));
	if ("parameters" in request)
		return request.op === "memory.projection.ledger"
			? 5000
			: request.op.startsWith("sources.health_")
				? 10000
				: request.op === "sources.import.list"
					? 100
					: request.op === "sources.import.rejections"
						? 100
						: request.op === "sources.import.files"
							? 1000
							: request.op === "sources.stats_artifacts" || request.op === "sources.stats_chunks"
								? 10000
								: 32;
	switch (request.op) {
		case "export_content":
			return Math.ceil(request.length / 65536);
		case "readable_pointers":
			return request.references.length;
		case "projection_rows":
			return (request.query.limit ?? 100) + (request.query.offset ?? 0);
		case "forget_candidates":
			return Math.min(request.request.limit, 200);
		case "documents":
			return request.mode === "detail" ? 1 : request.mode === "chunks" ? 1000 : request.limit + request.offset;
		case "transcripts":
			return request.mode === "detail" ? 1 : request.limit;
		case "export":
			return Math.min(request.limit, 200);
		default:
			return "limit" in request && typeof request.limit === "number"
				? request.limit + ("offset" in request && typeof request.offset === "number" ? request.offset : 0)
				: request.op === "source_snapshot"
					? 1000
					: 1;
	}
}
export async function contentRead<Result>(
	request: ContentReadRequest,
	signal?: AbortSignal,
	options: { readonly deadlineMs?: number } = {},
): Promise<Result> {
	const owner = await getDbOwnerForAccessor(getDbAccessor());
	const handle = owner.submit<Result>(
		{ kind: "content_read", request },
		{
			operation: `content.read.${request.op}`,
			lane: "read",
			deadlineMs: options.deadlineMs ?? 5000,
			estimatedWorkUnits: estimatedReadWork(request),
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
