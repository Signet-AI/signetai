import type { ftsShardTables } from "@signet/core";
type FtsBase = Parameters<typeof ftsShardTables>[0];
import type { ReadScope } from "./read-scope";
import { getDbAccessor } from "./db-accessor";
import { getDbOwnerForAccessor } from "./db-owner-runtime";

export type ContentReadRequest =
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
			readonly op: "scoped_query";
			readonly scope: ReadScope;
			readonly subject?: import("./read-scope").AudienceSubject;
			readonly statement: import("./db-owner-protocol").DbOwnerStatement;
	  }
	| {
			readonly op: "source_access";
			readonly scope: ReadScope;
			readonly sourceId: string;
			readonly agentId: string;
			readonly subject: import("./read-scope").AudienceSubject;
	  }
	| {
			readonly op: "projection";
			readonly scope: ReadScope;
			readonly dimensions: 2 | 3;
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
			readonly table: "memories" | "session_transcripts" | "memory_artifacts";
			readonly author: string;
			readonly scope: ReadScope;
			readonly cursor: number;
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
