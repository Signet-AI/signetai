export type DbOwnerLane = "read" | "write" | "maintenance" | "verify";
export type DbOwnerWorkloadClass = "foreground" | "maintenance";
export const DB_OWNER_MAX_QUEUE_DEPTH = 64;
export const DB_OWNER_MAX_WORK_UNITS = 10_000;
export const DB_OWNER_MAX_DEADLINE_MS = 60_000;
export const DB_OWNER_MAX_MAINTENANCE_DEADLINE_MS = 15 * 60_000;
export const DB_OWNER_MAX_RESULT_BYTES = 1_048_576;
export const DB_OWNER_MAX_TRANSACTION_STATEMENTS = 128;
export const VECTOR_REPAIR_MAX_ROWS_PER_BATCH = 50;
export const VECTOR_REPAIR_MAX_BYTES_PER_BATCH = 256 * 1024;
export const VECTOR_REPAIR_MAX_BATCH_DEADLINE_MS = 2_000;
export const VECTOR_REPAIR_MAX_WORK_UNITS_PER_BATCH = 100;
export type DbOwnerCancellation = "pending" | "requested" | "started";
export type DbOwnerOutcome = "completed" | "cancelled" | "timed_out" | "failed" | "owner_died";

export type DbOwnerParameter = string | number | boolean | null | { readonly type: "bytes"; readonly base64: string };

export interface DbOwnerStatement {
	readonly sql: string;
	readonly params?: readonly DbOwnerParameter[];
	readonly result: "all" | "get" | "run";
	readonly maxResultBytes?: number;
	readonly transactional?: boolean;
	readonly readonly?: boolean;
	readonly requireChanges?: boolean;
}

export interface DbOwnerTransaction {
	readonly statements: readonly DbOwnerStatement[];
}

export interface DbOwnerSourceSnapshotArtifact {
	readonly sourcePath: string;
	readonly sourceSha256: string;
	readonly sourceKind: string;
	readonly sessionId: string;
	readonly sessionKey: string | null;
	readonly sessionToken: string;
	readonly project: string | null;
	readonly harness: string | null;
	readonly capturedAt: string;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
	readonly manifestPath: string | null;
	readonly sourceNodeId: string | null;
	readonly memorySentence: string | null;
	readonly memorySentenceQuality: string | null;
	readonly content: string;
	readonly updatedAt: string;
	readonly sourceMtimeMs: number | null;
	readonly sourceId: string;
	readonly sourceRoot: string | null;
	readonly sourceExternalId: string | null;
	readonly sourceParentPath: string | null;
	readonly sourceMetaJson: string | null;
}

export interface DbOwnerSourceSnapshotImport {
	readonly agentId: string;
	readonly sourceId: string;
	readonly sourceRoot: string;
	readonly includeLocalDiscord: boolean;
	readonly artifacts: readonly DbOwnerSourceSnapshotArtifact[];
}

export interface DbOwnerSourceGraphIndex {
	readonly agentId: string;
	readonly sourceId: string;
	readonly sourceName: string;
	readonly root: string;
	readonly filePath: string;
	readonly content: string;
}

export interface DbOwnerSourceGraphFilePurge {
	readonly agentId: string;
	readonly sourceId: string;
	readonly root: string;
	readonly filePath: string;
}

export interface DbOwnerSourceGraphPurge {
	readonly agentId?: string;
	readonly sourceId: string;
	readonly root: string;
}

export interface DbOwnerSourcePurge {
	readonly agentId?: string;
	readonly sourceId: string;
}

export interface DbOwnerSourceArtifactPurge {
	readonly agentId: string;
	readonly sourceId: string;
	readonly sourcePath: string;
}

export interface DbOwnerSourceArtifactIndex {
	readonly agentId: string;
	readonly sourceId: string;
	readonly sourceKind: string;
	readonly sourceRoot: string;
	readonly sourcePath: string;
	readonly sourceParentPath?: string;
	readonly displayName?: string;
	readonly content: string;
}
export interface DbOwnerNativeMemoryIndex {
	readonly agentId: string;
	readonly sourcePath: string;
	readonly sourceHash: string;
	readonly sourceKind: string;
	readonly harness: string;
	readonly content: string;
	readonly sourceMtimeMs: number;
	readonly sourceId: string | null;
	readonly sourceRoot: string | null;
	readonly sourceExternalId: string | null;
	readonly sourceParentPath: string | null;
	readonly sourceMetaJson: string | null;
	readonly displayName: string;
	readonly embedding?: {
		readonly config: {
			readonly provider: string;
			readonly model: string;
			readonly dimensions: number;
			readonly base_url: string;
			readonly api_key?: string;
			readonly profile?: string;
			readonly warmNative?: boolean;
			readonly indexGeneration?: string;
			readonly llamaCppMaxInputTokens?: number;
		};
		readonly chunks: readonly {
			readonly id: string;
			readonly chunkText: string;
		}[];
	};
	readonly checkpoint?: {
		readonly sourceKey: string;
		readonly scanned: number;
		readonly cursor: string | null;
		readonly frontier: readonly string[] | null;
		readonly complete: boolean;
	};
	readonly checkpointOnProviderFailure?: {
		readonly sourceKey: string;
		readonly scanned: number;
		readonly cursor: string | null;
		readonly frontier: readonly string[] | null;
		readonly complete: boolean;
	};
	readonly graph?: {
		readonly sourceId: string;
		readonly sourceName: string;
		readonly root: string;
	};
}

export interface DbOwnerSourceArtifactFields {
	readonly agentId: string;
	readonly sourcePath: string;
	readonly sourceSha256: string;
	readonly sourceKind: string;
	readonly sessionId: string;
	readonly sessionKey: string | null;
	readonly sessionToken: string;
	readonly project: string | null;
	readonly harness: string | null;
	readonly capturedAt: string;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
	readonly manifestPath: string | null;
	readonly sourceNodeId: string | null;
	readonly memorySentence: string | null;
	readonly memorySentenceQuality: string | null;
	readonly content: string;
	readonly updatedAt: string;
	readonly sourceMtimeMs: number | null;
	readonly sourceId: string | null;
	readonly sourceRoot: string | null;
	readonly sourceExternalId: string | null;
	readonly sourceParentPath: string | null;
	readonly sourceMetaJson: string | null;
}

export interface DbOwnerSourceArtifactUpsert {
	readonly fields: DbOwnerSourceArtifactFields;
	readonly conflictGuardSourceId?: boolean;
}

export interface DbOwnerSourceEvidenceEligibility {
	readonly agentId: string;
	readonly sourceEntryId: string;
	readonly legacyObsidianRoot?: string;
}

import type { CompletedTranscriptCommit } from "./transcript-import-commit";

export interface DbOwnerTranscriptBulkCommit {
	readonly agentId: string;
	readonly jobId: string;
	readonly generation: number;
	readonly leaseToken: string;
	readonly sourceId: string;
	readonly harness: string;
	readonly commits: readonly CompletedTranscriptCommit[];
	readonly inventory?: {
		readonly fileId: string;
		readonly records: readonly import("./transcript-import-scan").InventoryRecord[];
		readonly previousByteOffset: number;
		readonly checkpoint: import("./transcript-import-scan").TranscriptCheckpoint;
		readonly complete: boolean;
	};
}
export type DbOwnerRequest =
	| { readonly kind: "memory_head"; readonly request: import("./memory-head").MemoryHeadRequest }
	| { readonly kind: "initialize"; readonly agentsDir?: string }
	| { readonly kind: "query"; readonly statement: DbOwnerStatement }
	| { readonly kind: "transaction"; readonly transaction: DbOwnerTransaction }
	| {
			readonly kind: "batch";
			readonly statements: readonly DbOwnerStatement[];
			readonly requireChanges?: boolean;
	  }
	| {
			readonly kind: "recall";
			readonly payload: DbOwnerRecallPayload;
	  }
	| {
			readonly kind: "vector_search";
			readonly payload: DbOwnerVectorSearchPayload;
	  }
	| { readonly kind: "vector_repair"; readonly input: DbOwnerVectorRepairInput }
	| { readonly kind: "source_snapshot_import"; readonly input: DbOwnerSourceSnapshotImport }
	| { readonly kind: "source_graph_index"; readonly input: DbOwnerSourceGraphIndex }
	| { readonly kind: "source_graph_file_purge"; readonly input: DbOwnerSourceGraphFilePurge }
	| { readonly kind: "source_graph_purge"; readonly input: DbOwnerSourceGraphPurge }
	| { readonly kind: "source_purge"; readonly input: DbOwnerSourcePurge }
	| { readonly kind: "source_artifact_index"; readonly input: DbOwnerSourceArtifactIndex }
	| { readonly kind: "source_native_memory_index"; readonly input: DbOwnerNativeMemoryIndex }
	| { readonly kind: "source_artifact_purge"; readonly input: DbOwnerSourceArtifactPurge }
	| { readonly kind: "source_artifact_upsert"; readonly input: DbOwnerSourceArtifactUpsert }
	| { readonly kind: "source_artifact_upsert_batch"; readonly input: readonly DbOwnerSourceArtifactUpsert[] }
	| { readonly kind: "source_evidence_eligibility"; readonly input: DbOwnerSourceEvidenceEligibility }
	| { readonly kind: "transcript_bulk_commit"; readonly input: DbOwnerTranscriptBulkCommit }
	| { readonly kind: "dreaming_hygiene_attention"; readonly input: DbOwnerDreamingHygieneAttention }
	| { readonly kind: "dreaming_surprisal_attention"; readonly input: DbOwnerDreamingSurprisalAttention }
	| { readonly kind: "dreaming_episodic_backlog"; readonly input: DbOwnerDreamingEpisodicBacklog }
	| { readonly kind: "dreaming_episodic_backlog_probe"; readonly input: DbOwnerDreamingEpisodicBacklogProbe }
	| { readonly kind: "dreaming_episodic_backlog_exists"; readonly input: DbOwnerDreamingEpisodicBacklogExists }
	| { readonly kind: "dreaming_evidence_search"; readonly input: DbOwnerDreamingEvidenceSearch }
	| { readonly kind: "dreaming_evidence_source"; readonly input: DbOwnerDreamingEvidenceSource }
	| { readonly kind: "dreaming_pass_finalize"; readonly input: DbOwnerDreamingPassFinalize }
	| { readonly kind: "dreaming_review_due"; readonly input: DbOwnerDreamingReviewDue }
	| { readonly kind: "dreaming_evidence_classify"; readonly input: DbOwnerDreamingEvidenceClassify }
	| { readonly kind: "dreaming_evidence_requeue"; readonly input: DbOwnerDreamingEvidenceRequeue }
	| { readonly kind: "embedding_migration_progress"; readonly configuredBaseUrl?: string }
	| { readonly kind: "health_ready" }
	| { readonly kind: "diagnostics"; readonly trackerStats: DbOwnerProviderTrackerStats }
	| {
			readonly kind: "vector_backfill";
			readonly expectedDimensions: number;
			readonly maxBatches?: number;
			readonly batchSize?: number;
	  }
	| { readonly kind: "vacuum_conversion" }
	| { readonly kind: "incremental_vacuum"; readonly pages: number }
	| { readonly kind: "sleep"; readonly durationMs: number };

export interface DbOwnerRecallPayload {
	readonly params: unknown;
	readonly config: unknown;
	readonly agentId?: string;
	readonly query?: string;
	readonly queryEmbedding?: readonly number[] | null;
}

export interface DbOwnerVectorSearchPayload {
	readonly queryEmbedding: readonly number[];
	readonly options?: {
		readonly limit?: number;
		readonly type?: string;
		readonly excludeAggregateRecall?: boolean;
		readonly maxScanRows?: number;
	};
}

export type DbOwnerVectorRepairOperation = "resync" | "clean-orphans";

export interface DbOwnerVectorRepairAudit {
	readonly action: string;
	readonly actor: string;
	readonly reason: string;
	readonly actorType: "operator" | "agent" | "daemon";
	readonly requestId?: string;
}

export interface DbOwnerVectorRepairInput {
	readonly operation: DbOwnerVectorRepairOperation;
	readonly agentId: string;
	readonly checkpointId: string;
	readonly batchSize?: number;
	readonly maxVectorBytes?: number;
	readonly audit: DbOwnerVectorRepairAudit;
}

export type DbOwnerVectorRepairPhase = "orphan-vectors" | "missing-vectors" | "orphan-embeddings" | "complete";

export interface DbOwnerVectorRepairResult {
	readonly operation: DbOwnerVectorRepairOperation;
	readonly agentId: string;
	readonly checkpointId: string;
	readonly phase: DbOwnerVectorRepairPhase;
	readonly status: "running" | "complete" | "failed";
	readonly cursor: string | null;
	readonly processed: number;
	readonly skipped: number;
	readonly failed: number;
	readonly affected: number;
	readonly remaining: number;
	readonly remainingStatus: "none" | "some";
	readonly batchRows: number;
	readonly batchBytes: number;
	readonly batchProcessed: number;
	readonly batchSkipped: number;
	readonly batchFailed: number;
	readonly batchAffected: number;
	readonly operationId: string;
	readonly error?: string;
}

export interface DbOwnerDreamingHygieneAttention {
	readonly agentId: string;
	readonly limit?: number;
	readonly caps?: {
		readonly maxAspectsPerEntity: number;
		readonly maxAttributesPerAspect: number;
	};
}

export interface DbOwnerDreamingSurprisalAttention {
	readonly agentId: string;
	readonly config: {
		readonly enabled: boolean;
		readonly sampleSize: number;
		readonly minObservations: number;
		readonly neighborCount: number;
		readonly treeLeafSize: number;
		readonly maxCandidates: number;
		readonly minScore: number;
	};
}
export interface DbOwnerDreamingEpisodicBacklog {
	readonly agentId: string;
}
export interface DbOwnerDreamingEpisodicBacklogProbe {
	readonly agentId: string;
	readonly tokenThreshold: number;
	readonly maxSources: number;
}
export interface DbOwnerDreamingEpisodicBacklogExists {
	readonly agentId: string;
}

export interface DbOwnerDreamingEvidenceSearch {
	readonly agentId: string;
	readonly query?: string;
	readonly since?: string;
	readonly before?: string;
	readonly kind?: "memory" | "artifact" | "transcript" | "summary";
	readonly limit?: number;
	readonly sourceRef?: string;
	readonly offset?: number;
	readonly chunkSize?: number;
}

export interface DbOwnerDreamingEvidenceSource {
	readonly agentId: string;
	readonly sourceRef: string;
}

export interface DbOwnerDreamingPassFinalize {
	readonly passId: string;
	readonly mode: string;
	readonly agentId: string;
	readonly scopes: readonly string[];
	readonly transcriptManifestEntries: readonly unknown[];
	readonly tokensConsumed: number;
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
	readonly cacheReadTokens: number | null;
	readonly cacheCreationTokens: number | null;
	readonly totalCost: number | null;
	readonly applied: number;
	readonly failed: number;
	readonly summary: string;
	readonly rejectedEvidence: readonly unknown[];
	readonly memoryHeadResult: Record<string, unknown> | null;
	readonly hasBacklogByScope: readonly { readonly scope: string; readonly hasBacklog: boolean }[];
	readonly nextWatermarkByScope: readonly { readonly scope: string; readonly watermark: string | null }[];
}

export interface DbOwnerDreamingReviewDue {
	readonly agentId?: string;
	readonly nowMs: number;
	readonly limit: number;
}

export interface DbOwnerDreamingEvidenceOperation {
	readonly evidence?: readonly unknown[];
}

export interface DbOwnerDreamingEvidenceClassify {
	readonly agentId: string;
	readonly result: unknown;
	readonly operations: readonly DbOwnerDreamingEvidenceOperation[];
}

export interface DbOwnerDreamingEvidenceRequeue {
	readonly nowMs: number;
	readonly policy: {
		readonly cooldownMs: number;
		readonly hourlyBudget: number;
		readonly maxAttempts: number;
	};
}

export interface DbOwnerProviderTrackerStats {
	readonly total: number;
	readonly successes: number;
	readonly failures: number;
	readonly timeouts: number;
}

export interface DbOwnerJob {
	readonly id: string;
	readonly operation: string;
	readonly lane: DbOwnerLane;
	readonly allowWriteBlocked?: boolean;
	readonly workloadClass: DbOwnerWorkloadClass;
	readonly enqueuedAt: number;
	readonly deadlineAt: number;
	readonly estimatedWorkUnits: number;
	readonly cancellation: DbOwnerCancellation;
	readonly request: DbOwnerRequest;
}

export interface DbOwnerJobMetrics {
	readonly startedAt: number;
	readonly finishedAt: number;
}

export type DbOwnerCommand =
	| { readonly type: "submit"; readonly job: DbOwnerJob }
	| { readonly type: "cancel"; readonly jobId: string }
	| { readonly type: "set_write_blocked"; readonly blocked: boolean }
	| { readonly type: "shutdown" };

export type DbOwnerFailureCause = "provider_unavailable" | "internal_error";

export interface DbOwnerSerializedError {
	readonly name: string;
	readonly message: string;
	readonly code?: string | number;
	readonly sqliteCode?: string | number;
	readonly causeFamily?: DbOwnerFailureCause;
}

export type DbOwnerEvent =
	| { readonly type: "ready"; readonly pid: number }
	| { readonly type: "started"; readonly jobId: string; readonly workloadClass: DbOwnerWorkloadClass }
	| {
			readonly type: "result";
			readonly jobId: string;
			readonly outcome: DbOwnerOutcome;
			readonly result?: unknown;
			readonly metrics?: DbOwnerJobMetrics;
			readonly error?: DbOwnerSerializedError;
	  }
	| { readonly type: "fatal"; readonly error: DbOwnerSerializedError };

function serializedCauseFamily(error: unknown): DbOwnerFailureCause | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const causeFamily = (error as Record<string, unknown>).causeFamily;
	if (causeFamily === "provider_unavailable" || causeFamily === "internal_error") return causeFamily;
	return undefined;
}

function serializedErrorField(error: unknown, key: "code" | "sqliteCode"): string | number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const value = (error as Record<string, unknown>)[key];
	return typeof value === "string" || typeof value === "number" ? value : undefined;
}

export function serializeError(error: unknown): DbOwnerSerializedError {
	const causeFamily = serializedCauseFamily(error);
	const code = serializedErrorField(error, "code");
	const sqliteCode = serializedErrorField(error, "sqliteCode");
	return {
		name: error instanceof Error ? error.name : "Error",
		message: error instanceof Error ? error.message : String(error),
		...(code === undefined ? {} : { code }),
		...(sqliteCode === undefined ? {} : { sqliteCode }),
		...(causeFamily === undefined ? {} : { causeFamily }),
	};
}
