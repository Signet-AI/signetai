import { z } from "zod";
import { attempt as attemptRunbookJson } from "@signet/core";
function runbookRecord(value: unknown): Record<string, unknown> | null {
	const parsed = z.record(z.string(), z.unknown()).safeParse(value);
	return parsed.success ? parsed.data : null;
}
function parseRecord(value: string | null): Record<string, unknown> | null {
	if (!value) return null;
	return runbookRecord(attemptRunbookJson(() => JSON.parse(value)));
}

function parseTextList(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseDeferredEvidenceList(
	value: unknown,
): readonly import("./dreaming-runbook").DreamingDeferredEvidenceEntry[] {
	if (!Array.isArray(value)) return [];
	const entries: import("./dreaming-runbook").DreamingDeferredEvidenceEntry[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			entries.push(item);
			continue;
		}
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const entry = runbookRecord(item);
		if (!entry) continue;
		if (typeof entry.agentId === "string" && typeof entry.sourceRef === "string") {
			entries.push({ agentId: entry.agentId, sourceRef: entry.sourceRef });
		}
	}
	return entries;
}

function parseReviewedExcludedEvidenceList(
	value: unknown,
): readonly import("./dreaming-evidence-reviews").DreamingReviewedExcludedEvidenceEntry[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
		const entry = runbookRecord(item);
		if (!entry) return [];
		if (typeof entry.agentId !== "string" || typeof entry.sourceRef !== "string" || typeof entry.reason !== "string")
			return [];
		const agentId = entry.agentId.trim();
		const sourceRef = entry.sourceRef.trim();
		const reason = entry.reason.trim();
		if (!agentId || !sourceRef || !reason) return [];
		return [
			{
				agentId,
				sourceRef,
				reason,
			},
		];
	});
}

function parseRunbook(value: string | null): import("./dreaming-runbook").DreamingRunbookEntry | null {
	const row = parseRecord(value);
	if (!row || typeof row.summary !== "string") return null;
	return {
		summary: row.summary,
		openQuestions: parseTextList(row.openQuestions),
		deferred: parseTextList(row.deferred),
		deferredEvidence: parseDeferredEvidenceList(row.deferredEvidence),
		reviewedExcludedEvidence: parseReviewedExcludedEvidenceList(row.reviewedExcludedEvidence),
	};
}

function parseEvidenceWindow(value: string | null): import("./dreaming-runbook").DreamingEvidenceWindow | null {
	const row = parseRecord(value);
	if (!row || typeof row.cursor !== "object" || row.cursor === null || Array.isArray(row.cursor)) return null;
	const cursor = runbookRecord(row.cursor);
	if (!cursor) return null;
	if (typeof cursor.capturedAt !== "string" || typeof cursor.id !== "string") return null;
	const sources = Array.isArray(row.sources)
		? row.sources.flatMap((source) => {
				if (typeof source !== "object" || source === null || Array.isArray(source)) return [];
				const item = runbookRecord(source);
				if (!item) return [];
				if (
					typeof item.sourceRef !== "string" ||
					typeof item.sourceKind !== "string" ||
					typeof item.sourceId !== "string"
				)
					return [];
				return [
					{
						sourceRef: item.sourceRef,
						sourceKind: item.sourceKind,
						sourceId: item.sourceId,
						sourcePath: typeof item.sourcePath === "string" ? item.sourcePath : null,
						chars: typeof item.chars === "number" && Number.isFinite(item.chars) ? Math.max(0, item.chars) : 0,
					},
				];
			})
		: [];
	return {
		cursor: {
			capturedAt: cursor.capturedAt,
			kind: typeof cursor.kind === "string" ? cursor.kind : null,
			id: cursor.id,
			...(typeof cursor.fragmentOffset === "number" &&
			Number.isSafeInteger(cursor.fragmentOffset) &&
			cursor.fragmentOffset > 0
				? { fragmentOffset: cursor.fragmentOffset }
				: {}),
		},
		sources,
	};
}

function operationResults(
	inputJson: string,
	outputJson: string,
): readonly { readonly operation: string; readonly ok: boolean; readonly error: string | null }[] {
	const input = parseRecord(inputJson);
	const output = parseRecord(outputJson);
	const operations = Array.isArray(input?.operations) ? input.operations : [];
	const items = Array.isArray(output?.items) ? output.items : [];
	const fallbackError = typeof output?.error === "string" ? output.error : null;
	return operations.flatMap((operation, index) => {
		if (typeof operation !== "object" || operation === null || Array.isArray(operation)) return [];
		const name = runbookRecord(operation)?.operation;
		if (typeof name !== "string") return [];
		const item = items[index];
		const result = runbookRecord(item);
		return [
			{
				operation: name,
				ok: result?.ok === true,
				error: typeof result?.error === "string" ? result.error : fallbackError,
			},
		];
	});
}

function summarizeOperations(
	results: readonly { readonly operation: string; readonly ok: boolean; readonly error: string | null }[],
): import("./dreaming-runbook").DreamingRunbookOperations {
	const applied: Record<string, number> = {};
	const failed = new Map<string, { operation: string; error: string | null; count: number }>();
	for (const result of results) {
		if (result.ok) {
			applied[result.operation] = (applied[result.operation] ?? 0) + 1;
			continue;
		}
		const key = `${result.operation}\u0000${result.error ?? ""}`;
		const existing = failed.get(key);
		if (existing === undefined) failed.set(key, { operation: result.operation, error: result.error, count: 1 });
		else existing.count += 1;
	}
	return { applied, failed: [...failed.values()] };
}

export async function readDreamingPassRecord(
	owner: import("../db-owner-client").DbOwnerClient,
	agentId: string,
	passId: string,
	readScope?: ReadScope,
): Promise<import("./dreaming-runbook").DreamingRunbookPass | null> {
	const predicate = dreamingReadPredicate("", readScope);
	const passPredicate = dreamingReadPredicate("p", readScope);
	const raw = await ownerQueryOne<Record<string, unknown>>(
		owner,
		"dreaming.pass-record.read",
		`SELECT agent_id AS agentId, id, mode, status, started_at AS startedAt, completed_at AS completedAt,
		        summary, error, mutations_applied AS mutationsApplied, mutations_failed AS mutationsFailed,
		        evidence_window_json AS evidenceWindowJson, runbook_json AS runbookJson
		 FROM dreaming_passes WHERE ${readScope ? "1=1" : "agent_id = ?"} AND id = ? ${predicate.sql}`,
		[...(readScope ? [] : [agentId]), passId, ...predicate.args],
		{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
	);
	if (raw === undefined) return null;
	const row = z
		.object({
			id: z.string(),
			agentId: z.string(),
			mode: z.string(),
			status: z.string(),
			startedAt: z.string(),
			completedAt: z.string().nullable(),
			summary: z.string().nullable(),
			error: z.string().nullable(),
			mutationsApplied: z.number().nullable(),
			mutationsFailed: z.number().nullable(),
			evidenceWindowJson: z.string().nullable(),
			runbookJson: z.string().nullable(),
		})
		.parse(raw);
	const recordAgentId = row.agentId;
	const [calls, quarantines] = await Promise.all([
		ownerQueryAll<{ inputJson: string; outputJson: string }>(
			owner,
			"dreaming.pass-record.operations",
			`SELECT input_json AS inputJson, output_json AS outputJson
			 FROM dreaming_tool_calls WHERE agent_id = ? AND pass_id = ? AND tool_name = 'apply_ontology_ops' ${predicate.sql}
 ${readScope ? `AND EXISTS (SELECT 1 FROM dreaming_passes p WHERE p.id = dreaming_tool_calls.pass_id AND p.agent_id = dreaming_tool_calls.agent_id ${passPredicate.sql})` : ""}
			 ORDER BY sequence ASC`,
			[recordAgentId, passId, ...predicate.args, ...(readScope ? passPredicate.args : [])],
			{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
		),
		ownerQueryAll<import("./dreaming-runbook").DreamingRunbookPass["quarantines"][number]>(
			owner,
			"dreaming.pass-record.quarantines",
			`SELECT source_kind AS sourceKind, source_id AS sourceId, reason
			 FROM dreaming_evidence_exclusions WHERE agent_id = ? AND pass_id = ? AND resolved_at IS NULL
 ${readScope ? `AND EXISTS (SELECT 1 FROM dreaming_passes p WHERE p.id = dreaming_evidence_exclusions.pass_id AND p.agent_id = dreaming_evidence_exclusions.agent_id ${passPredicate.sql})` : ""}
			 ORDER BY excluded_at DESC, source_kind ASC, source_id ASC`,
			[recordAgentId, passId, ...(readScope ? passPredicate.args : [])],
			{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
		),
	]);
	return {
		passId: row.id,
		mode: row.mode,
		status: row.status,
		startedAt: row.startedAt,
		completedAt: row.completedAt ?? null,
		summary: row.summary ?? null,
		error: row.error ?? null,
		mutationsApplied: typeof row.mutationsApplied === "number" ? row.mutationsApplied : null,
		mutationsFailed: typeof row.mutationsFailed === "number" ? row.mutationsFailed : null,
		operations: summarizeOperations(calls.flatMap((call) => operationResults(call.inputJson, call.outputJson))),
		evidenceWindow: parseEvidenceWindow(row.evidenceWindowJson ?? null),
		runbook: parseRunbook(row.runbookJson ?? null),
		quarantines,
	};
}

import type { ReadScope } from "../read-scope";
import { dreamingReadPredicate } from "./dreaming-read-scope";
import type { DbOwnerClient } from "../db-owner-client";
export async function readDreamingHistoryLinePage(
	owner: DbOwnerClient,
	agentId: string,
	scopeKey: string,
	page: readonly { readonly level: number; readonly idx: number }[],
	lineBytes: number,
	readScope?: ReadScope,
): Promise<readonly { level: number; idx: number; hex: string; bytes: number; passId: string | null }[]> {
	if (page.length === 0 || page.length > 256 || lineBytes < 1 || lineBytes > 4096)
		throw new Error("invalid_history_line_page");
	const predicate = dreamingReadPredicate("", readScope);
	const parent = dreamingReadPredicate("history_pass", readScope);
	return await ownerQueryAll<{
		level: number;
		idx: number;
		hex: string;
		bytes: number;
		passId: string | null;
	}>(
		owner,
		"dreaming.history.lines",
		`SELECT level, idx, hex(substr(CAST(text AS BLOB), 1, ?)) AS hex, length(CAST(text AS BLOB)) AS bytes,
			        pass_id AS passId
			 FROM ${readScope ? `(SELECT level,ROW_NUMBER() OVER(PARTITION BY level ORDER BY idx)-1 AS idx,text,pass_id FROM dreaming_history_nodes WHERE agent_id=? AND scope_key=? ${predicate.sql} AND (pass_id IS NULL OR EXISTS(SELECT 1 FROM dreaming_passes history_pass WHERE history_pass.id=dreaming_history_nodes.pass_id AND history_pass.agent_id=dreaming_history_nodes.agent_id${parent.sql}))) readable_history` : `dreaming_history_nodes WHERE agent_id=? AND scope_key=? ${predicate.sql}`} ${readScope ? "WHERE" : "AND"} (level, idx) IN (VALUES ${page.map(() => "(?, ?)").join(", ")})`,
		[
			lineBytes,
			agentId,
			scopeKey,
			...predicate.args,
			...(readScope ? parent.args : []),
			...page.flatMap((node) => [node.level, node.idx]),
		],
		{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
	);
}

import type { Database } from "bun:sqlite";
import { readScopeSql } from "../read-scope";
import { dreamingPassPartitionInDb } from "../classification-owner";
import { evidenceLeasedByOtherPassesInScopes, releaseDreamingEvidenceLeasesInTx } from "./dreaming-evidence-leases";
import { createHash, randomUUID } from "node:crypto";
import { compartmentForWrite, withWritePrincipal } from "@signet/core";
import type {
	AccountingProvenance,
	DreamingConfig,
	DreamingPolicies,
	LlmCacheRequestAccounting,
	LlmUsage,
} from "@signet/core";
import type { WriteAuthor } from "../auth/audit-owner";
import { authoredAuditStatements } from "../auth/audit-owner";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { DbOwnerDeadlineError, DbOwnerDiedError } from "../db-owner-client";
import {
	type DbOwnerMaintenance,
	ownerDreamingEpisodicBacklog,
	ownerDreamingEpisodicBacklogExists,
	ownerDreamingEpisodicBacklogProbe,
	ownerDreamingHygieneAttention,
	ownerDreamingSurprisalAttention,
	ownerQueryAll,
	ownerQueryOne,
	ownerRunStatement,
	ownerTransaction,
	runOwnerJob,
} from "../db-owner-maintenance";
import type {
	DbOwnerDreamingEpisodicBacklog,
	DbOwnerDreamingEpisodicBacklogExists,
	DbOwnerDreamingEpisodicBacklogProbe,
	DbOwnerDreamingEvidenceSource,
	DbOwnerDreamingHygieneAttention,
	DbOwnerDreamingPassFinalize,
	DbOwnerDreamingSurprisalAttention,
	DbOwnerStatement,
} from "../db-owner-protocol";
import { cancellableOwner } from "../db-owner-sql";
import { DB_OWNER_MAX_WORK_UNITS } from "../db-owner-protocol";
import { getDbOwnerForAccessor, runDbOwnerDomainOperation } from "../db-owner-runtime";
import {
	EPISODIC_CAPTURED_AT_FLOOR,
	type EpisodicCursor,
	type EpisodicSourceRecord,
	readEpisodicSource,
	scanEpisodicSourceCandidates,
	searchEpisodicSources,
	timestampMillis,
	utcTimestampMs,
} from "../episodic-sources";
import { type GraphHygieneCaps, getDreamingHygieneCandidatesInDb } from "../knowledge-graph-hygiene";
import { logger } from "../logger";
import { detectLocalTimeZone } from "../memory-config";
import { type MemoryHeadCommitInput, type MemoryHeadCommitter, readCuratedMemoryHead } from "../memory-head";
import { commitCuratedMemoryHeadInDb, memoryHeadInputError, withContentPassWrites } from "../memory-head-owner";
import type { GraphWriteCaps } from "../ontology-proposals";
import { isPipelineTimeout, recordPipelineError } from "../pipeline-error";
import { normalizePipelineCause, recordPipelineOperation } from "../pipeline-operation";
import { admitSessionTranscriptInDb } from "../session-transcripts";
import { getActiveTelemetry } from "../telemetry";
import { upsertThreadHead } from "../thread-heads";
import { createDreamingAgentTools } from "./dreaming-agent-tools";
import { enqueueDreamingAttentionInTx, getDreamingAttentionWorkloadDiagnostics } from "./dreaming-attention";
import type { DreamingToolCallTrace } from "./dreaming-capabilities";
import { DREAMING_CAPABILITY_IDS, dreamingEvidencePageChars, listDreamingAttention } from "./dreaming-capabilities";
import { renderDreamingEvidence, sanitizeTranscriptForDreaming } from "./dreaming-evidence";
import {
	deliveredOffsetForSource,
	evidenceContentSha256,
	failedOperationEvidence,
	recordDreamingEvidenceConsumptionInTx,
	resolveImportedSourceAttentionInTx,
	SEEN_IMPORTED_SOURCE_ATTENTION_SQL,
	STALLED_EVIDENCE_ATTENTION_SQL,
} from "./dreaming-evidence-consumption";
import {
	collectRejectedDreamingEvidence,
	type RejectedDreamingEvidence,
	recordRejectedDreamingEvidenceInTx,
} from "./dreaming-evidence-retry";
import {
	parseDreamingReviewedExcludedEvidence,
	recordDreamingReviewedExcludedEvidenceInTx,
} from "./dreaming-evidence-reviews";
import { dreamingScopeKey, renderDreamingHistoryForPass } from "./dreaming-history";
import {
	type DreamingLiveEventHub,
	dreamingLiveEvents,
	publishDreamingAgentEvent,
	publishDreamingSessionInfo,
	publishDreamingToolTrace,
} from "./dreaming-live-events";
import type { ApplyDreamingOperationsResult, DreamingOperationRequest } from "./dreaming-operations";
import { DEFAULT_DREAMING_POLICIES } from "./dreaming-policies";
import {
	DREAMING_SURPRISAL_SELECTOR_VERSION,
	type DreamingSurprisalSelection,
	selectDreamingSurprisalInDb,
} from "./dreaming-surprisal";
import {
	beginDreamingEpisodicTokenBacklogMeasurement,
	countDreamingBacklogTokenEntries,
	type DreamingBacklogTokenEntry,
	invalidateDreamingEpisodicTokenBacklog,
	recordDreamingEpisodicTokenBacklog,
	refreshDreamingBacklogTokenCache,
} from "./dreaming-token-cache";
import { countTokens } from "./tokenizer";

export type DreamingMode = "incremental" | "compact" | "incremental-hygiene" | "incremental-content";

export type DreamingEpisodicBacklogProbe =
	| {
			readonly kind: "exact";
			readonly tokens: number;
			readonly hasBacklog: boolean;
			readonly sourcesScanned: number;
	  }
	| {
			readonly kind: "threshold-reached";
			readonly tokenLowerBound: number;
			readonly hasBacklog: true;
			readonly sourcesScanned: number;
	  }
	| {
			readonly kind: "indeterminate";
			readonly tokenLowerBound: number;
			readonly hasBacklog: boolean | null;
			readonly sourcesScanned: number;
	  };

export type DreamingTriggerDecision =
	| { readonly trigger: false }
	| {
			readonly trigger: true;
			readonly reason: "first-run" | "attention" | "token-threshold" | "continuation" | "max-interval";
	  };
export type DreamingPassFocus = "hygiene" | "content";

export interface DreamingState {
	readonly consecutiveFailures: number;
	readonly lastFailureAt: string | null;
	readonly lastPassAt: string | null;
	readonly evidenceCursor: EpisodicCursor | null;
	readonly lastPassId: string | null;
	readonly lastPassMode: string | null;
}
export async function enqueueDreamingHygieneAttention(
	accessor: DbAccessor,
	agentId: string,
	limit = 50,
	caps?: GraphHygieneCaps,
	ownerMaintenance?: DbOwnerMaintenance,
	compartmentId: number | null = null,
): Promise<number> {
	const input: DbOwnerDreamingHygieneAttention = { agentId, limit, caps, compartmentId };
	const options = { deadlineMs: 60_000, estimatedWorkUnits: 100 };
	if (ownerMaintenance) return await ownerMaintenance.dreamingHygieneAttention(input, options);
	return await runDbOwnerDomainOperation(accessor, {
		runWithOwner: async (owner) => await ownerDreamingHygieneAttention(owner, input, options),
		runInline: ({ write }) =>
			write((db) => {
				const candidates = getDreamingHygieneCandidatesInDb(db, input);
				for (const candidate of candidates) {
					enqueueDreamingAttentionInTx(db, {
						...candidate,
						agentId: input.agentId,
						kind: "hygiene",
						compartmentId: input.compartmentId,
						reopen: false,
					});
				}
				return candidates.length;
			}),
	});
}
export async function enqueueDreamingSurprisalAttention(
	accessor: DbAccessor,
	agentId: string,
	cfg: DreamingConfig,
	ownerMaintenance?: DbOwnerMaintenance,
	compartmentId: number | null = null,
): Promise<DreamingSurprisalSelection | null> {
	const surprisal = cfg.surprisal;
	if (!surprisal?.enabled) return null;
	const input: DbOwnerDreamingSurprisalAttention = { agentId, config: surprisal, compartmentId };
	const options = { deadlineMs: 60_000, estimatedWorkUnits: 500 };
	const selection = ownerMaintenance
		? await ownerMaintenance.dreamingSurprisalAttention(input, options)
		: await runDbOwnerDomainOperation(accessor, {
				runWithOwner: async (owner) => await ownerDreamingSurprisalAttention(owner, input, options),
				runInline: ({ read, write }) => {
					const selected = read((db) =>
						selectDreamingSurprisalInDb(db, input.agentId, input.config, null, input.compartmentId),
					);
					if (selected.candidates.length === 0) return selected;
					write((db) => {
						for (const candidate of selected.candidates) {
							enqueueDreamingAttentionInTx(db, {
								agentId: input.agentId,
								kind: "surprisal",
								compartmentId: input.compartmentId,
								subjectRef: `memory:${candidate.id}`,
								details: {
									selector: DREAMING_SURPRISAL_SELECTOR_VERSION,
									score: candidate.score.toFixed(6),
									rank: String(candidate.rank),
									sampleSize: String(candidate.sampleSize),
									dimensions: String(candidate.dimensions),
									capturedAt: candidate.capturedAt,
								},
								priority: Math.round(60 + candidate.score * 40),
								reopen: false,
							});
						}
					});
					return selected;
				},
			});
	if (selection === null) return null;
	logger.info("dreaming", "Embedding-surprisal attention sweep completed", {
		agentId,
		sampled: selection.sampled,
		valid: selection.valid,
		candidates: selection.candidates.length,
		durationMs: selection.durationMs,
		embeddingRequests: selection.embeddingRequests,
		embeddingTokens: selection.embeddingTokens,
		embeddingCostUsd: selection.embeddingCostUsd,
		skippedReason: selection.skippedReason,
	});
	return selection;
}

function parseEpisodicCursor(value: string | null): EpisodicCursor | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as {
			capturedAt?: unknown;
			kind?: unknown;
			id?: unknown;
			fragmentOffset?: unknown;
		};
		if (typeof parsed.capturedAt !== "string" || typeof parsed.id !== "string") return null;
		if (
			parsed.kind !== null &&
			parsed.kind !== "memory" &&
			parsed.kind !== "artifact" &&
			parsed.kind !== "transcript" &&
			parsed.kind !== "summary"
		) {
			return null;
		}
		const fragmentOffset =
			typeof parsed.fragmentOffset === "number" &&
			Number.isSafeInteger(parsed.fragmentOffset) &&
			parsed.fragmentOffset > 0
				? parsed.fragmentOffset
				: undefined;
		return {
			capturedAt: parsed.capturedAt,
			kind: parsed.kind ?? null,
			id: parsed.id,
			...(fragmentOffset ? { fragmentOffset } : {}),
		};
	} catch {
		return null;
	}
}
export function _testParseEpisodicCursor(value: string | null): EpisodicCursor | null {
	return parseEpisodicCursor(value);
}

export interface DreamingPassRow {
	readonly id: string;
	readonly mode: string;
	readonly status: string;
	readonly startedAt: string;
	readonly completedAt: string | null;
	readonly tokensConsumed: number | null;
	readonly tokensInput: number | null;
	readonly tokensOutput: number | null;
	readonly tokensCacheRead: number | null;
	readonly tokensCacheWrite: number | null;
	readonly tokensPeakContext: number | null;
	readonly tokensCost: number | null;
	readonly mutationsApplied: number | null;
	readonly mutationsSkipped: number | null;
	readonly mutationsFailed: number | null;
	readonly summary: string | null;
	readonly error: string | null;
	readonly policyHash: string | null;
	readonly policySource: "default" | "custom" | null;
}

export interface DreamingWorkloadDiagnostics {
	readonly activePasses: number;
	readonly oldestPassAgeMs: number | null;
	readonly pendingAttention: number;
	readonly oldestAttentionAgeMs: number | null;
}

export async function getDreamingWorkloadDiagnostics(
	accessor: DbAccessor,
	agentId: string,
	nowMs = Date.now(),
): Promise<DreamingWorkloadDiagnostics> {
	const attention = await getDreamingAttentionWorkloadDiagnostics(accessor, agentId, nowMs);
	const row = await ownerQueryOne<{ active: number; oldestStartedAt: string | null }>(
		await getDbOwnerForAccessor(accessor),
		"dreaming.workload-diagnostics",
		`SELECT COUNT(*) AS active, MIN(started_at) AS oldestStartedAt
		 FROM dreaming_passes
		 WHERE agent_id = ? AND status = 'running'`,
		[agentId],
		{ deadlineMs: 30_000, estimatedWorkUnits: 2 },
	);
	if (!row || row.active === 0 || row.oldestStartedAt === null) {
		return {
			activePasses: 0,
			oldestPassAgeMs: null,
			pendingAttention: attention.pending,
			oldestAttentionAgeMs: attention.oldestAgeMs,
		};
	}
	const oldestMs = timestampMillis(row.oldestStartedAt);
	return {
		activePasses: row.active,
		oldestPassAgeMs: oldestMs > 0 ? Math.max(0, nowMs - oldestMs) : null,
		pendingAttention: attention.pending,
		oldestAttentionAgeMs: attention.oldestAgeMs,
	};
}

export interface DreamingToolCall {
	readonly id: string;
	readonly passId: string;
	readonly sequence: number;
	readonly toolCallId: string | null;
	readonly toolName: string;
	readonly input: unknown;
	readonly output: unknown;
	readonly success: boolean;
	readonly latencyMs: number;
	readonly createdAt: string;
}

export interface DreamingEvidenceExclusion {
	readonly sourceKind: EpisodicSourceRecord["kind"];
	readonly sourceId: string;
	readonly reason: string;
	readonly failureClass: string;
	readonly sourceFingerprint: string | null;
	readonly retryCount: number;
	readonly lastRequeuedAt: string | null;
	readonly passId: string;
	readonly excludedAt: string;
	readonly requeueRequestedAt: string | null;
	readonly resolvedAt: string | null;
}

export type { DreamingAttention } from "./dreaming-attention";
export interface DreamingAgentExecutor {
	run(input: {
		readonly passId: string;
		readonly prompt: string;
		readonly tools: ReturnType<typeof createDreamingAgentTools>;
		readonly timeoutMs: number;
		readonly maxTokens?: number;
		readonly onEvent?: (event: unknown) => void;
		readonly onSessionInfo?: (info: {
			readonly sessionId?: string;
			readonly model?: string;
			readonly systemPrompt?: string;
		}) => void;
	}): Promise<{
		readonly summary?: string;
		readonly usage?: LlmUsage | null;
		readonly attribution?: DreamingPassAttribution | null;
	}>;
}

export interface DreamingPassAttribution {
	readonly executor: string;
	readonly provider: string;
	readonly model: string;
	readonly locality: "local" | "remote" | "unknown";
}

const DREAMING_WORKLOAD_CLASS = "memory_extraction";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deferredEvidenceKeys(value: unknown, primaryAgentId: string): ReadonlySet<string> | null {
	if (!isRecord(value) || !Array.isArray(value.deferredEvidence)) return new Set();
	const keys = new Set<string>();
	for (const item of value.deferredEvidence) {
		if (typeof item === "string") {
			keys.add(`${primaryAgentId}\u0000${item}`);
			continue;
		}
		if (!isRecord(item) || typeof item.agentId !== "string" || typeof item.sourceRef !== "string") return null;
		keys.add(`${item.agentId}\u0000${item.sourceRef}`);
	}
	return keys;
}

export async function getDreamingState(
	accessor: DbAccessor,
	agentId: string,
	compartmentId: number | null = null,
	readScope?: ReadScope,
): Promise<DreamingState> {
	const predicate = passReadPredicate(
		agentId,
		readScope ?? {
			reach: { kind: "own", agentId },
			compartments: compartmentId === null ? [] : [compartmentId],
			projects: null,
		},
	);
	const row = await ownerQueryOne<{
		consecutive_failures: number;
		last_failure_at: string | null;
		last_pass_at: string | null;
		evidence_cursor: string | null;
		last_pass_id: string | null;
		last_pass_mode: string | null;
	}>(
		await getDbOwnerForAccessor(accessor),
		"dreaming.state.read",
		`SELECT consecutive_failures, last_failure_at,
		        last_pass_at, evidence_cursor, last_pass_id, last_pass_mode
		 FROM dreaming_state WHERE agent_id = ? AND compartment_id IS ? ${predicate.sql}`,
		[agentId, compartmentId, ...predicate.args],
		{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
	);
	if (!row) {
		return {
			consecutiveFailures: 0,
			lastFailureAt: null,
			lastPassAt: null,
			evidenceCursor: null,
			lastPassId: null,
			lastPassMode: null,
		};
	}
	return {
		consecutiveFailures: row.consecutive_failures,
		lastFailureAt: row.last_failure_at,
		lastPassAt: row.last_pass_at,
		evidenceCursor: parseEpisodicCursor(row.evidence_cursor),
		lastPassId: row.last_pass_id,
		lastPassMode: row.last_pass_mode,
	};
}

function resetDreamingTokens(
	db: WriteDb,
	agentId: string,
	passId: string,
	mode: string,
	evidenceCursor: EpisodicCursor | null,
	lastPassAt: string | null,
	compartmentId: number | null,
): void {
	db.prepare(`INSERT INTO dreaming_state
		(agent_id, compartment_id, consecutive_failures, last_failure_at, last_pass_at, evidence_cursor, last_pass_id, last_pass_mode)
		VALUES (?, ?, 0, NULL, ?, ?, ?, ?)
		ON CONFLICT(agent_id, COALESCE(compartment_id,0)) DO UPDATE SET
			consecutive_failures = CASE WHEN julianday(dreaming_state.last_failure_at) > julianday(excluded.last_pass_at) THEN dreaming_state.consecutive_failures ELSE 0 END,
			last_failure_at = CASE WHEN julianday(dreaming_state.last_failure_at) > julianday(excluded.last_pass_at) THEN dreaming_state.last_failure_at ELSE NULL END,
			last_pass_at = CASE WHEN julianday(dreaming_state.last_pass_at) > julianday(excluded.last_pass_at) OR excluded.last_pass_at IS NULL THEN dreaming_state.last_pass_at ELSE excluded.last_pass_at END,
			evidence_cursor = CASE WHEN julianday(dreaming_state.last_pass_at) > julianday(excluded.last_pass_at) THEN dreaming_state.evidence_cursor ELSE excluded.evidence_cursor END,
			last_pass_id = CASE WHEN julianday(dreaming_state.last_pass_at) > julianday(excluded.last_pass_at) THEN dreaming_state.last_pass_id ELSE excluded.last_pass_id END,
			last_pass_mode = CASE WHEN julianday(dreaming_state.last_pass_at) > julianday(excluded.last_pass_at) THEN dreaming_state.last_pass_mode ELSE excluded.last_pass_mode END,
			updated_at = datetime('now')`).run(
		agentId,
		compartmentId,
		lastPassAt,
		evidenceCursor === null ? null : JSON.stringify(evidenceCursor),
		passId,
		mode,
	);
}

export async function recordDreamingFailure(
	accessor: DbAccessor,
	agentId: string,
	compartmentId: number | null = null,
): Promise<void> {
	await ownerTransaction(
		await getDbOwnerForAccessor(accessor),
		"dreaming.state.record-failure",
		[
			ownerRunStatement(
				`INSERT INTO dreaming_state (agent_id, compartment_id, tokens_since_last_pass, consecutive_failures, last_failure_at)
				 VALUES (?, ?, 0, 1, datetime('now'))
				 ON CONFLICT(agent_id, COALESCE(compartment_id,0)) DO UPDATE SET
				 consecutive_failures = dreaming_state.consecutive_failures + 1,
				 last_failure_at = datetime('now'),
				 updated_at = datetime('now')`,
				[agentId, compartmentId],
			),
		],
		{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
	);
}
const EVIDENCE_WATERMARK_FLOOR_MS = Date.parse(EPISODIC_CAPTURED_AT_FLOOR);
function surfacedEvidenceWatermark(items: readonly unknown[]): string | null {
	let watermark: string | null = null;
	for (const item of items) {
		if (!isRecord(item)) continue;
		const capturedAt = typeof item.capturedAt === "string" ? item.capturedAt : null;
		if (capturedAt === null) continue;
		const ms = timestampMillis(capturedAt);
		if (ms <= EVIDENCE_WATERMARK_FLOOR_MS) continue;
		if (watermark === null || ms > timestampMillis(watermark)) watermark = capturedAt;
	}
	return watermark;
}
function nextEvidenceWatermark(surfaced: string, previous: string | null, cutoff: string): string | null {
	const surfacedMs = timestampMillis(surfaced);
	const cutoffMs = timestampMillis(cutoff);
	const capped = surfacedMs > cutoffMs ? cutoff : surfaced;
	if (previous === null) return capped;
	return timestampMillis(capped) > timestampMillis(previous) ? capped : previous;
}

export interface DreamingPassPolicy {
	readonly text: string;
	readonly source: "default" | "custom";
}

export function dreamingPassPolicy(policies: DreamingPolicies, mode: DreamingMode): DreamingPassPolicy {
	const type = dreamingFocusOfMode(mode) ?? "combined";
	const text = policies[type];
	return { text, source: text === DEFAULT_DREAMING_POLICIES[type] ? "default" : "custom" };
}

function createDreamingPassStatements(
	id: string,
	agentId: string,
	mode: DreamingMode,
	policy: DreamingPassPolicy,
	author?: WriteAuthor,
	compartmentId: number | null = null,
): DbOwnerStatement[] {
	const hash = createHash("sha256").update(policy.text).digest("hex");
	return [
		ownerRunStatement(
			`INSERT INTO dreaming_policies (hash, text, created_at)
			 VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))
			 ON CONFLICT(hash) DO NOTHING`,
			[hash, policy.text],
		),
		ownerRunStatement(
			`INSERT INTO dreaming_passes (id, agent_id, mode, status, started_at, created_at, policy_hash, policy_source, compartment_id, scope_key)
			 VALUES (?, ?, ?, 'running', strftime('%Y-%m-%d %H:%M:%f', 'now'), strftime('%Y-%m-%d %H:%M:%f', 'now'), ?, ?, ?, ?)
			 ON CONFLICT(id) DO NOTHING`,
			[id, agentId, mode, hash, policy.source, compartmentId, agentId],
		),
		...authoredAuditStatements(author, "dreaming.started", "dreaming_pass", id, agentId),
	];
}

export async function createDreamingPass(
	accessor: DbAccessor,
	agentId: string,
	mode: DreamingMode,
	policy: DreamingPassPolicy,
	author?: WriteAuthor,
	compartmentId: number | null = null,
): Promise<string> {
	const id = randomUUID();
	await ownerTransaction(
		await getDbOwnerForAccessor(accessor),
		"dreaming.pass.create",
		createDreamingPassStatements(id, agentId, mode, policy, author, compartmentId),
		{ deadlineMs: 10_000, estimatedWorkUnits: 2 },
	);
	dreamingLiveEvents.startPass({ passId: id, agentId, mode });
	return id;
}

export async function createDreamingPassThroughOwner(
	maintenance: DbOwnerMaintenance,
	agentId: string,
	mode: DreamingMode,
	policy: DreamingPassPolicy,
	author?: WriteAuthor,
	compartmentId: number | null = null,
): Promise<string> {
	const id = randomUUID();
	const request = {
		kind: "transaction" as const,
		transaction: { statements: createDreamingPassStatements(id, agentId, mode, policy, author, compartmentId) },
	};
	let creationMayHaveCommitted = false;
	for (;;) {
		try {
			await runOwnerJob<readonly unknown[]>(maintenance.owner, request, "dreaming.pass.create", "maintenance", {
				deadlineMs: 10_000,
				estimatedWorkUnits: 2,
				waitForOwnerCompletionOnDeadline: true,
			});
			dreamingLiveEvents.startPass({ passId: id, agentId, mode });
			return id;
		} catch (error) {
			const uncertain = error instanceof DbOwnerDeadlineError || error instanceof DbOwnerDiedError;
			if (!uncertain && !creationMayHaveCommitted) throw error;
			creationMayHaveCommitted ||= uncertain;
			let persisted: { readonly id: string } | undefined;
			try {
				persisted = await ownerQueryOne<{ readonly id: string }>(
					maintenance.owner,
					"dreaming.pass.create.reconcile",
					"SELECT id FROM dreaming_passes WHERE id = ?",
					[id],
					{ deadlineMs: 10_000, estimatedWorkUnits: 1, waitForOwnerCompletionOnDeadline: true },
				);
			} catch {
				await new Promise<void>((resolve) => setTimeout(resolve, 100));
				continue;
			}
			if (persisted !== undefined) {
				dreamingLiveEvents.startPass({ passId: persisted.id, agentId, mode });
				return persisted.id;
			}
			if (!uncertain) throw error;
		}
	}
}

async function failDreamingPass(accessor: DbAccessor, passId: string, error: string): Promise<void> {
	await ownerTransaction(
		await getDbOwnerForAccessor(accessor),
		"dreaming.pass.fail",
		[
			ownerRunStatement(
				`UPDATE dreaming_passes
				 SET status = 'failed',
				     completed_at = datetime('now'),
				     error = ?
				 WHERE id = ?`,
				[error, passId],
			),
		],
		{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
	);
}

function passReadPredicate(agentId: string, readScope?: ReadScope, alias = "") {
	const requestedScope: ReadScope = readScope ?? { reach: { kind: "own", agentId }, compartments: [], projects: null };
	const scope: ReadScope =
		requestedScope.reach.kind === "shared" || requestedScope.reach.kind === "group"
			? { ...requestedScope, reach: { kind: "own", agentId: requestedScope.reach.agentId } }
			: requestedScope;
	const predicate =
		scope.projects !== null
			? { sql: " AND 0", args: [] }
			: readScopeSql(alias, scope, { visibility: null, memory: null, session: null, source: null });
	return {
		sql: ` AND ${alias ? `${alias}.` : ""}agent_id = ? ${predicate.sql}`,
		args: [
			agentId,
			...predicate.args.map((value) => {
				if (typeof value === "string" || typeof value === "number" || value === null) return value;
				throw new Error("invalid_read_scope");
			}),
		],
	};
}

export async function getDreamingPasses(
	accessor: DbAccessor,
	agentId: string,
	limit = 10,
	readScope?: ReadScope,
): Promise<readonly DreamingPassRow[]> {
	const predicate = dreamingReadPredicate("", readScope);
	return await ownerQueryAll<DreamingPassRow>(
		await getDbOwnerForAccessor(accessor),
		"dreaming.passes.list",
		`SELECT id, mode, status, started_at AS startedAt,
		        completed_at AS completedAt, tokens_consumed AS tokensConsumed,
		        tokens_input AS tokensInput, tokens_output AS tokensOutput,
		        tokens_cache_read AS tokensCacheRead, tokens_cache_write AS tokensCacheWrite,
		        tokens_peak_context AS tokensPeakContext,
		        tokens_cost AS tokensCost,
		        mutations_applied AS mutationsApplied,
		        mutations_skipped AS mutationsSkipped,
		        mutations_failed AS mutationsFailed,
		        summary, error,
		        policy_hash AS policyHash, policy_source AS policySource
		 FROM dreaming_passes
		 WHERE ${readScope ? "1=1" : "agent_id = ?"} ${predicate.sql}
		 ORDER BY created_at DESC
		 LIMIT ?`,
		[...(readScope ? [] : [agentId]), ...predicate.args, limit],
		{ deadlineMs: 30_000, estimatedWorkUnits: Math.max(1, Math.min(limit, 100)) },
	);
}

export interface DreamingPassPolicyRecord {
	readonly hash: string;
	readonly source: "default" | "custom";
	readonly text: string;
}

export async function getDreamingPassPolicy(
	accessor: DbAccessor,
	agentId: string,
	passId: string,
	readScope?: ReadScope,
): Promise<{ readonly policy: DreamingPassPolicyRecord | null } | null> {
	const predicate = dreamingReadPredicate("pass", readScope);
	const row = await ownerQueryOne<{
		readonly hash: string | null;
		readonly source: "default" | "custom" | null;
		readonly text: string | null;
	}>(
		await getDbOwnerForAccessor(accessor),
		"dreaming.pass.policy",
		`SELECT pass.policy_hash AS hash, pass.policy_source AS source, policy.text AS text
		 FROM dreaming_passes pass
		 LEFT JOIN dreaming_policies policy ON policy.hash = pass.policy_hash
		 WHERE ${readScope ? "1=1" : "pass.agent_id = ?"} AND pass.id = ? ${predicate.sql}
		 LIMIT 1`,
		[...(readScope ? [] : [agentId]), passId, ...predicate.args],
		{ deadlineMs: 10_000, estimatedWorkUnits: 1 },
	);
	if (row == null) return null;
	if (row.hash === null || row.source === null || row.text === null) return { policy: null };
	return { policy: { hash: row.hash, source: row.source, text: row.text } };
}

export interface DreamingPassScope extends DreamingPassRow {
	readonly agentId: string;
}

interface DreamingPassReadOptions {
	readonly readScope?: ReadScope;
	readonly signal?: AbortSignal;
}

function dreamingPassSelect(includeAgent = false): string {
	return `SELECT ${includeAgent ? "agent_id AS agentId, " : ""}id, mode, status, started_at AS startedAt,
				completed_at AS completedAt, tokens_consumed AS tokensConsumed,
				tokens_input AS tokensInput, tokens_output AS tokensOutput,
				tokens_cache_read AS tokensCacheRead, tokens_cache_write AS tokensCacheWrite,
		        tokens_peak_context AS tokensPeakContext,
				tokens_cost AS tokensCost,
				mutations_applied AS mutationsApplied,
				mutations_skipped AS mutationsSkipped,
				mutations_failed AS mutationsFailed,
				summary, error,
				policy_hash AS policyHash, policy_source AS policySource
			 FROM dreaming_passes`;
}

export async function getDreamingPass(
	accessor: DbAccessor,
	agentId: string,
	passId: string,
	options: DreamingPassReadOptions = {},
): Promise<DreamingPassScope | null> {
	const predicate = dreamingReadPredicate("", options.readScope);
	return (
		(await ownerQueryOne<DreamingPassScope>(
			await getDbOwnerForAccessor(accessor),
			"dreaming.pass.read",
			`${dreamingPassSelect(true)} WHERE ${options.readScope ? "1=1" : "agent_id = ?"} AND id = ? ${predicate.sql} LIMIT 1`,
			[...(options.readScope ? [] : [agentId]), passId, ...predicate.args],
			{ deadlineMs: 30_000, estimatedWorkUnits: 1, signal: options.signal },
		)) ?? null
	);
}

export async function getActiveDreamingPasses(
	accessor: DbAccessor,
	agentId: string,
	options: DreamingPassReadOptions = {},
): Promise<readonly DreamingPassScope[]> {
	const predicate = dreamingReadPredicate("", options.readScope);
	return await ownerQueryAll<DreamingPassScope>(
		await getDbOwnerForAccessor(accessor),
		"dreaming.passes.active",
		`${dreamingPassSelect(true)} WHERE ${options.readScope ? "1=1" : "agent_id = ?"} AND status = 'running' ${predicate.sql} ORDER BY started_at ASC, id ASC`,
		[...(options.readScope ? [] : [agentId]), ...predicate.args],
		{ deadlineMs: 30_000, estimatedWorkUnits: 10, signal: options.signal },
	);
}

const DREAMING_CODEMODE_PROMPT =
	"Lookups (search_entities, get_entity, list_aspect_claims, validate_proposal, attention_list, zoom_history) are available only inside the codemode tool. Batch the lookups a page needs into one script: call them through tools.<name>(args), parse each JSON result, and print only what you need, carrying ids from results instead of retyping them. Reading and acknowledging evidence (search_evidence, review_evidence) and every write (apply_ontology_ops, runbook_write, memory_head_commit) stay direct tool calls; a script cannot call them.";

const MAX_DREAMING_TOOL_TRACE_JSON_CHARS = 128_000;

function serializeToolTrace(value: unknown): string {
	let json: string | undefined;
	try {
		json = JSON.stringify(value);
	} catch (error) {
		return JSON.stringify({ serializationError: error instanceof Error ? error.message : String(error) });
	}
	if (json === undefined) return "null";
	if (json.length <= MAX_DREAMING_TOOL_TRACE_JSON_CHARS) return json;
	const items = compactTraceItems(value);
	const durable = items === null ? {} : { ok: true, items };
	const previewChars = Math.max(0, MAX_DREAMING_TOOL_TRACE_JSON_CHARS - JSON.stringify(durable).length);
	return JSON.stringify({
		truncated: true,
		originalChars: json.length,
		...durable,
		preview: json.slice(0, previewChars),
	});
}

function compactTraceItems(value: unknown): unknown[] | null {
	if (!isRecord(value) || value.ok !== true || !Array.isArray(value.items)) return null;
	return value.items.map((item) => {
		if (!isRecord(item) || typeof item.content !== "string") return item;
		const { content, ...metadata } = item;
		return { ...metadata, contentChars: content.length, contentSha256: evidenceContentSha256(content) };
	});
}

function parseToolTrace(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return { malformedTrace: true };
	}
}

async function recordDreamingToolCall(
	accessor: DbAccessor,
	agentId: string,
	passId: string,
	sequence: number,
	trace: DreamingToolCallTrace,
): Promise<void> {
	await ownerTransaction(
		await getDbOwnerForAccessor(accessor),
		"dreaming.tool-call.record",
		[
			ownerRunStatement(
				`INSERT INTO dreaming_tool_calls
				 (id, agent_id, pass_id, sequence, tool_call_id, tool_name, input_json, output_json, success, latency_ms, compartment_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT compartment_id FROM dreaming_passes WHERE id = ?))`,
				[
					randomUUID(),
					agentId,
					passId,
					sequence,
					trace.toolCallId || null,
					trace.tool,
					serializeToolTrace(trace.input),
					serializeToolTrace(trace.output),
					trace.output.ok ? 1 : 0,
					Math.max(0, Math.floor(trace.latencyMs)),
					passId,
				],
			),
		],
		{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
	);
}
export async function getDreamingToolCalls(
	accessor: DbAccessor,
	agentId: string,
	passId: string,
	readScope?: ReadScope,
): Promise<readonly DreamingToolCall[]> {
	const predicate = dreamingReadPredicate("", readScope);
	const passPredicate = dreamingReadPredicate("p", readScope);
	const rows = await ownerQueryAll<{
		id: string;
		passId: string;
		sequence: number;
		toolCallId: string | null;
		toolName: string;
		inputJson: string;
		outputJson: string;
		success: number;
		latencyMs: number;
		createdAt: string;
	}>(
		await getDbOwnerForAccessor(accessor),
		"dreaming.tool-calls.list",
		`SELECT id, pass_id AS passId, ${readScope ? "ROW_NUMBER() OVER(ORDER BY sequence,id)-1" : "sequence"} AS sequence, tool_call_id AS toolCallId,
		        tool_name AS toolName, input_json AS inputJson, output_json AS outputJson,
		        success, latency_ms AS latencyMs, created_at AS createdAt
		 FROM dreaming_tool_calls
		 WHERE ${readScope ? "1=1" : "agent_id = ?"} AND pass_id = ? ${predicate.sql}
 ${readScope ? `AND EXISTS (SELECT 1 FROM dreaming_passes p WHERE p.id = dreaming_tool_calls.pass_id AND p.agent_id = dreaming_tool_calls.agent_id ${passPredicate.sql})` : ""}
		 ORDER BY sequence ASC`,
		[...(readScope ? [] : [agentId]), passId, ...predicate.args, ...(readScope ? passPredicate.args : [])],
		{ deadlineMs: 30_000, estimatedWorkUnits: 10 },
	);
	return rows.map((typed) => ({
		id: typed.id,
		passId: typed.passId,
		sequence: typed.sequence,
		toolCallId: typed.toolCallId,
		toolName: typed.toolName,
		input: parseToolTrace(typed.inputJson),
		output: parseToolTrace(typed.outputJson),
		success: typed.success === 1,
		latencyMs: typed.latencyMs,
		createdAt: typed.createdAt,
	}));
}

export async function getDreamingEvidenceExclusions(
	accessor: DbAccessor,
	agentId: string,
	readScope?: ReadScope,
): Promise<readonly DreamingEvidenceExclusion[]> {
	const predicate = passReadPredicate(agentId, readScope);
	return await ownerQueryAll<DreamingEvidenceExclusion>(
		await getDbOwnerForAccessor(accessor),
		"dreaming.evidence-exclusions.list",
		`SELECT source_kind AS sourceKind, source_id AS sourceId, reason,
		        failure_class AS failureClass, source_fingerprint AS sourceFingerprint,
		        retry_count AS retryCount, last_requeued_at AS lastRequeuedAt,
		        pass_id AS passId, excluded_at AS excludedAt,
		        requeue_requested_at AS requeueRequestedAt, resolved_at AS resolvedAt
		 FROM dreaming_evidence_exclusions
		 WHERE resolved_at IS NULL ${predicate.sql}
		 ORDER BY excluded_at DESC, source_kind ASC, source_id ASC LIMIT 500`,
		[...predicate.args],
		{ deadlineMs: 30_000, estimatedWorkUnits: 10 },
	);
}

export function requestDreamingEvidenceRequeueInDb(
	db: WriteDb,
	agentId: string,
	sourceKind: EpisodicSourceRecord["kind"],
	sourceId: string,
	readScope: ReadScope,
): boolean {
	if (sourceKind === "summary") return false;
	const source = readEpisodicSource(db, { agentId, from: `${sourceKind}:${sourceId}`, readScope });
	if (!source) return false;
	const compartmentId = source.compartmentId ?? null;
	const result = db
		.prepare(
			`UPDATE dreaming_evidence_exclusions SET requeue_requested_at = datetime('now')
		 WHERE agent_id = ? AND source_kind = ? AND source_id = ? AND compartment_id IS ? AND resolved_at IS NULL`,
		)
		.run(agentId, source.kind, source.id, compartmentId);
	if (result.changes === 0) return false;
	enqueueDreamingAttentionInTx(db, {
		agentId,
		compartmentId,
		kind: "evidence_requeue",
		subjectRef: `${source.kind}:${source.id}`,
		details: { sourceKind: source.kind, sourceId: source.id },
		priority: 80,
	});
	return true;
}

export async function requestDreamingEvidenceRequeue(
	accessor: DbAccessor,
	agentId: string,
	sourceKind: EpisodicSourceRecord["kind"],
	sourceId: string,
	readScope: ReadScope = { reach: { kind: "own", agentId }, compartments: [], projects: null },
	options: { readonly reviewed?: boolean; readonly signal?: AbortSignal } = {},
): Promise<boolean> {
	const input = { agentId, sourceKind, sourceId, readScope, reviewed: options.reviewed === true };
	return await runDbOwnerDomainOperation(accessor, {
		runWithOwner: async (owner) =>
			await (options.signal ? cancellableOwner(owner, options.signal) : owner).submit<boolean>(
				{ kind: "dreaming_evidence_manual_requeue", input },
				{
					operation: "dreaming.evidence.manual-requeue",
					lane: "write",
					workloadClass: "foreground",
					deadlineMs: 30_000,
					estimatedWorkUnits: 10,
				},
			).result,
		runInline: ({ write }) => {
			if (input.reviewed) throw new Error("review_requeue_requires_owner");
			return write((db) => requestDreamingEvidenceRequeueInDb(db, agentId, sourceKind, sourceId, readScope));
		},
	});
}

export function dreamingPassPrompt(prompt: string, history: string, attention: string): string {
	return `${prompt}

<pass_history>
Earlier Dreaming passes in this scope, oldest first. Recent passes have one line each; older lines cover more passes. Each line reads id+n|text, covering passes id through id+n-1. zoom_history(id, n) opens a line into the two lines under it, and zoom_history(id, 1) returns that pass's full record.
${history}
</pass_history>

<pending_attention>
Pending attention for this pass's scopes as of pass start, one JSON line per kind. Work these records directly. Call attention_list only for a kind marked "more": true, or to re-check a kind after this pass flagged something.
${attention}
</pending_attention>`;
}

export function dreamingPassClock(now: Date, timeZone: string): string {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", {
			timeZone,
			weekday: "long",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			timeZoneName: "longOffset",
		})
			.formatToParts(now)
			.map((part) => [part.type, part.value]),
	);
	return `<current_time>
It is now ${parts.weekday}, ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${timeZone} (${parts.timeZoneName}). Use this for what is current, upcoming, or past due. Relative times inside evidence still resolve against that source's capturedAt, not this time.
</current_time>`;
}

const ATTENTION_KINDS_BY_FOCUS: Readonly<Record<"hygiene" | "content" | "all", readonly string[]>> = {
	hygiene: ["hygiene"],
	content: ["review_due", "contested_claim", "evidence_requeue", "surprisal"],
	all: ["hygiene", "review_due", "contested_claim", "evidence_requeue", "surprisal"],
};
const ATTENTION_ITEMS_PER_KIND = 20;
const ATTENTION_TEXT_CHARS = 400;

function boundAttentionValue(value: unknown): unknown {
	if (typeof value === "string")
		return value.length > ATTENTION_TEXT_CHARS ? `${value.slice(0, ATTENTION_TEXT_CHARS)}…` : value;
	if (Array.isArray(value)) return value.map(boundAttentionValue);
	if (isRecord(value))
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, boundAttentionValue(entry)]));
	return value;
}

export async function renderPendingDreamingAttention(
	accessor: DbAccessor,
	scopes: readonly string[],
	mode: DreamingMode,
	compartmentId: number | null = null,
): Promise<string> {
	const focus = dreamingFocusOfMode(mode) ?? "all";
	const lines: string[] = [];
	for (const scope of scopes) {
		for (const kind of ATTENTION_KINDS_BY_FOCUS[focus]) {
			const items = await listDreamingAttention(accessor, {
				agentId: scope,
				readScope: {
					reach: { kind: "own", agentId: scope },
					compartments: compartmentId === null ? [] : [compartmentId],
					projects: null,
				},
				kind,
				status: "pending",
				limit: ATTENTION_ITEMS_PER_KIND + 1,
				agentFacing: true,
			});
			if (items.length === 0) continue;
			lines.push(
				JSON.stringify({
					scope,
					kind,
					more: items.length > ATTENTION_ITEMS_PER_KIND,
					items: items.slice(0, ATTENTION_ITEMS_PER_KIND).map(boundAttentionValue),
				}),
			);
		}
	}
	return lines.length === 0 ? "none pending" : lines.join("\n");
}

export function dreamingFocusOfMode(mode: DreamingMode): DreamingPassFocus | null {
	if (mode === "incremental-hygiene") return "hygiene";
	if (mode === "incremental-content") return "content";
	return null;
}
function dreamingModeAdvancesEvidence(mode: DreamingMode, hasEpisodicWork: boolean): boolean {
	return mode !== "incremental-hygiene" && hasEpisodicWork;
}
export function dreamingEarlyExitSummary(
	mode: DreamingMode,
	hasPendingHygieneAttention: boolean,
	hasBacklog: boolean,
	hasPendingContentAttention = false,
): string | null {
	if (mode === "incremental-hygiene") {
		return hasPendingHygieneAttention ? null : "No hygiene attention to process";
	}
	if (mode === "incremental-content") {
		return !hasBacklog && !hasPendingContentAttention ? "No new episodic evidence to process" : null;
	}
	if (mode === "incremental") {
		return !hasPendingHygieneAttention && !hasPendingContentAttention && !hasBacklog
			? "No new episodic evidence or semantic attention to process"
			: null;
	}
	return null;
}
export function selectDreamingPassMode(
	lastScheduled: DreamingPassFocus | null,
	hasPendingHygieneAttention: boolean,
	hasBacklog: boolean,
	hasPendingContentAttention = false,
): DreamingMode {
	const hasContentWork = hasBacklog || hasPendingContentAttention;
	if (hasPendingHygieneAttention && hasContentWork) {
		return lastScheduled === "hygiene" ? "incremental-content" : "incremental-hygiene";
	}
	if (hasPendingHygieneAttention) return "incremental-hygiene";
	if (hasContentWork) return "incremental-content";
	return "incremental";
}

export interface DreamingPassLiveOptions {
	readonly hub?: DreamingLiveEventHub;
	readonly compartmentId?: number | null;
	readonly sharedScope?: { readonly evidenceLeaseMs: number; readonly attentionScopes: readonly string[] };
	readonly userRequest?: { readonly sourceRef: string; readonly content: string };
	readonly memoryHeadReader?: (agentId: string, passId?: string) => Promise<Record<string, unknown>>;
}
export function recordDreamingPassTelemetry(input: {
	readonly mode: string;
	readonly outcome: DreamingPassOutcome;
	readonly outcomeCode: DreamingPassOutcomeCode;
	readonly effects: DreamingPassEffects;
	readonly attribution?: DreamingPassAttribution | null;
	readonly usage: {
		readonly inputTokens: number | null;
		readonly outputTokens: number | null;
		readonly cacheReadTokens: number | null;
		readonly cacheCreationTokens: number | null;
		readonly totalTokens?: number | null;
		readonly totalCost: number | null;
		readonly accountingProvenance?: AccountingProvenance;
		readonly cacheRequests?: LlmCacheRequestAccounting | null;
	} | null;
}): void {
	try {
		getActiveTelemetry()?.record("dreaming.pass", {
			mode: input.mode,
			workloadClass: DREAMING_WORKLOAD_CLASS,
			outcome: input.outcome,
			outcomeCode: input.outcomeCode,
			...(input.attribution
				? {
						executor: input.attribution.executor,
						provider: input.attribution.provider,
						model: input.attribution.model,
						locality: input.attribution.locality,
					}
				: {}),
			tokensInput: input.usage?.inputTokens ?? null,
			tokensOutput: input.usage?.outputTokens ?? null,
			tokensCacheRead: input.usage?.cacheReadTokens ?? null,
			tokensCacheWrite: input.usage?.cacheCreationTokens ?? null,
			tokensTotal: input.usage?.totalTokens ?? null,
			cost: input.usage?.totalCost ?? null,
			accountingProvenance: input.usage?.accountingProvenance ?? "unavailable",
			cacheAccountingAvailable: input.usage?.cacheRequests != null,
			cacheRequests: input.usage?.cacheRequests?.requests ?? null,
			cacheHits: input.usage?.cacheRequests?.hits ?? null,
			cacheMisses: input.usage?.cacheRequests?.misses ?? null,
			cacheUnknown: input.usage?.cacheRequests?.unknown ?? null,
			cacheWrites: input.usage?.cacheRequests?.writes ?? null,
			artifactsConsidered: input.effects.artifactsConsidered,
			memoriesCreated: input.effects.memoriesCreated,
			memoriesUpdated: input.effects.memoriesUpdated,
			memoriesSuperseded: input.effects.memoriesSuperseded,
			memoriesRetired: input.effects.memoriesRetired,
			claimsChanged: input.effects.claimsChanged,
			relationshipsChanged: input.effects.relationshipsChanged,
			provenanceLinksChanged: input.effects.provenanceLinksChanged,
			toolCalls: input.effects.toolCalls,
			durationMs: input.effects.durationMs,
		});
	} catch {}
}

export type DreamingPassOutcome = "completed" | "no-op" | "failed" | "cancelled";

export type DreamingPassOutcomeCode =
	| "completed"
	| "no_work"
	| "no_effects"
	| "partial_failure"
	| "mutation_failure"
	| "timeout"
	| "cancelled"
	| "error";

export interface DreamingPassEffects {
	readonly artifactsConsidered: number;
	readonly memoriesCreated: number;
	readonly memoriesUpdated: number;
	readonly memoriesSuperseded: number;
	readonly memoriesRetired: number;
	readonly claimsChanged: number;
	readonly relationshipsChanged: number;
	readonly provenanceLinksChanged: number;
	readonly toolCalls: number;
	readonly durationMs: number;
}

interface DreamingPassEffectState {
	readonly consideredArtifacts: Set<string>;
	readonly createdMemoryIds: Set<string>;
	readonly supersededMemoryIds: Set<string>;
	readonly retiredMemoryIds: Set<string>;
	claimsChanged: number;
	relationshipsChanged: number;
	provenanceLinksChanged: number;
	usefulEffects: number;
}

type DreamingRetirementCandidates = ReadonlyMap<number, ReadonlySet<string>>;

function createDreamingPassEffectState(): DreamingPassEffectState {
	return {
		consideredArtifacts: new Set(),
		createdMemoryIds: new Set(),
		supersededMemoryIds: new Set(),
		retiredMemoryIds: new Set(),
		claimsChanged: 0,
		relationshipsChanged: 0,
		provenanceLinksChanged: 0,
		usefulEffects: 0,
	};
}

function dreamingPassEffects(
	state: DreamingPassEffectState,
	toolCalls: number,
	startedAtMs: number,
): DreamingPassEffects {
	return {
		artifactsConsidered: state.consideredArtifacts.size,
		memoriesCreated: state.createdMemoryIds.size,
		memoriesUpdated: 0,
		memoriesSuperseded: state.supersededMemoryIds.size,
		memoriesRetired: state.retiredMemoryIds.size,
		claimsChanged: state.claimsChanged,
		relationshipsChanged: state.relationshipsChanged,
		provenanceLinksChanged: state.provenanceLinksChanged,
		toolCalls,
		durationMs: Math.max(0, Date.now() - startedAtMs),
	};
}

function isDreamingPassCancellation(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "AbortError") return true;
	const message = error instanceof Error ? error.message : String(error);
	return /\bcancel(?:led|ed)?\b/i.test(message) || (error instanceof Error && error.name === "AbortError");
}

function asResultRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

function countDreamingEvidenceLinks(evidence: readonly unknown[] | undefined): number {
	if (!evidence) return 0;
	const refs = new Set<string>();
	for (const item of evidence) {
		if (!isRecord(item)) continue;
		const sourceRef = typeof item.source_ref === "string" ? item.source_ref : null;
		const sourceKind = typeof item.source_kind === "string" ? item.source_kind : null;
		const sourceId = typeof item.source_id === "string" ? item.source_id : null;
		if (sourceRef !== null) refs.add(sourceRef);
		else if (sourceKind !== null && sourceId !== null) refs.add(`${sourceKind}:${sourceId}`);
	}
	return refs.size;
}

async function addAttributeMemoryId(
	accessor: DbAccessor,
	agentId: string,
	attributeId: string,
	set: Set<string>,
): Promise<void> {
	const row = await ownerQueryOne<{ memoryId: string | null }>(
		await getDbOwnerForAccessor(accessor),
		"dreaming.attribute-memory.read",
		"SELECT memory_id AS memoryId FROM entity_attributes WHERE id = ? AND agent_id = ?",
		[attributeId, agentId],
		{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
	);
	if (typeof row?.memoryId === "string") set.add(row.memoryId);
}

async function collectDreamingRetirementCandidates(
	accessor: DbAccessor,
	agentId: string,
	operations: readonly DreamingOperationRequest[],
): Promise<DreamingRetirementCandidates> {
	const candidates = new Map<number, ReadonlySet<string>>();
	for (let index = 0; index < operations.length; index += 1) {
		const operation = operations[index];
		if (!operation) continue;
		const target = typeof operation.payload.target === "string" ? operation.payload.target : null;
		if (target === null) continue;
		const query =
			operation.operation === "archive_claim_value"
				? "SELECT memory_id AS memoryId FROM entity_attributes WHERE id = ? AND agent_id = ? AND status = 'active' AND memory_id IS NOT NULL"
				: operation.operation === "archive_aspect"
					? "SELECT memory_id AS memoryId FROM entity_attributes WHERE aspect_id = ? AND agent_id = ? AND status = 'active' AND memory_id IS NOT NULL"
					: operation.operation === "archive_entity"
						? `SELECT attr.memory_id AS memoryId
						   FROM entity_attributes attr
						   JOIN entity_aspects asp ON asp.id = attr.aspect_id AND asp.agent_id = attr.agent_id
						   WHERE asp.entity_id = ? AND attr.agent_id = ? AND attr.status = 'active' AND attr.memory_id IS NOT NULL`
						: null;
		if (query === null) continue;
		const rows = await ownerQueryAll<{ memoryId: string }>(
			await getDbOwnerForAccessor(accessor),
			"dreaming.retirement-candidates.read",
			query,
			[target, agentId],
			{ deadlineMs: 30_000, estimatedWorkUnits: 10 },
		);
		if (rows.length > 0) candidates.set(index, new Set(rows.map((row) => row.memoryId)));
	}
	return candidates;
}

async function createdMemoryIdsRetiredByDreamingArchive(
	accessor: DbAccessor,
	agentId: string,
	operation: DreamingOperationRequest,
	createdMemoryIds: ReadonlySet<string>,
): Promise<readonly string[]> {
	const target = typeof operation.payload.target === "string" ? operation.payload.target : null;
	if (target === null) return [];
	const query =
		operation.operation === "archive_claim_value"
			? "SELECT memory_id AS memoryId FROM entity_attributes WHERE id = ? AND agent_id = ? AND memory_id IS NOT NULL"
			: operation.operation === "archive_aspect"
				? "SELECT memory_id AS memoryId FROM entity_attributes WHERE aspect_id = ? AND agent_id = ? AND memory_id IS NOT NULL"
				: operation.operation === "archive_entity"
					? `SELECT attr.memory_id AS memoryId
					   FROM entity_attributes attr
					   JOIN entity_aspects asp ON asp.id = attr.aspect_id AND asp.agent_id = attr.agent_id
					   WHERE asp.entity_id = ? AND attr.agent_id = ? AND attr.memory_id IS NOT NULL`
					: null;
	if (query === null) return [];
	const rows = await ownerQueryAll<{ memoryId: string }>(
		await getDbOwnerForAccessor(accessor),
		"dreaming.retired-memory.read",
		query,
		[target, agentId],
		{ deadlineMs: 30_000, estimatedWorkUnits: 10 },
	);
	return rows.map((row) => row.memoryId).filter((memoryId) => createdMemoryIds.has(memoryId));
}

async function recordDreamingOperationEffects(
	accessor: DbAccessor,
	agentId: string,
	state: DreamingPassEffectState,
	result: ApplyDreamingOperationsResult,
	operations: readonly DreamingOperationRequest[],
	retirementCandidates: DreamingRetirementCandidates,
): Promise<void> {
	for (const item of result.items) {
		if (!item.ok) continue;
		const operation = operations[item.index];
		if (!operation) continue;
		const details = asResultRecord(item.result);
		const deduped = details?.deduped === true;
		const reviewRequired = details?.reviewRequired === true;
		if (operation.operation === "flag" || operation.operation === "decline_attention" || reviewRequired) {
			continue;
		}
		if (deduped) continue;
		state.usefulEffects++;
		const isClaimOperation =
			operation.operation === "add_claim_value" ||
			operation.operation === "set_claim_value" ||
			operation.operation === "supersede_claim_value" ||
			operation.operation === "archive_claim_value" ||
			operation.operation === "create_policy";
		if (isClaimOperation) state.claimsChanged += 1;
		if (
			operation.operation === "create_link" ||
			operation.operation === "update_link" ||
			operation.operation === "archive_link"
		) {
			state.relationshipsChanged += 1;
		}
		if (operation.operation === "merge_entities" && typeof details?.relationshipsChanged === "number") {
			state.relationshipsChanged += Math.max(0, details.relationshipsChanged);
		}
		const materializesMemory =
			operation.operation === "add_claim_value" ||
			operation.operation === "set_claim_value" ||
			operation.operation === "create_policy" ||
			(operation.operation === "supersede_claim_value" && details?.replacementCreated === true);
		if (materializesMemory) state.provenanceLinksChanged += countDreamingEvidenceLinks(operation.evidence);

		if (
			operation.operation === "add_claim_value" ||
			operation.operation === "set_claim_value" ||
			operation.operation === "create_policy"
		) {
			if (typeof details?.memoryId === "string") state.createdMemoryIds.add(details.memoryId);
			const supersededAttributeIds = Array.isArray(details?.supersededAttributeIds)
				? details.supersededAttributeIds
				: details?.previousWasActive === true && typeof details.previousAttributeId === "string"
					? [details.previousAttributeId]
					: [];
			for (const id of supersededAttributeIds) {
				if (typeof id === "string") await addAttributeMemoryId(accessor, agentId, id, state.supersededMemoryIds);
			}
		}
		if (operation.operation === "supersede_claim_value") {
			const replacementAttributeId =
				typeof details?.replacementAttributeId === "string" ? details.replacementAttributeId : null;
			if (Array.isArray(details?.supersededAttributeIds)) {
				for (const id of details.supersededAttributeIds) {
					if (typeof id === "string") {
						await addAttributeMemoryId(
							accessor,
							agentId,
							id,
							replacementAttributeId === null ? state.retiredMemoryIds : state.supersededMemoryIds,
						);
					}
				}
			}
			if (replacementAttributeId !== null && details?.replacementCreated === true) {
				await addAttributeMemoryId(accessor, agentId, replacementAttributeId, state.createdMemoryIds);
			}
		}
		for (const memoryId of retirementCandidates.get(item.index) ?? []) {
			state.retiredMemoryIds.add(memoryId);
		}
		for (const memoryId of await createdMemoryIdsRetiredByDreamingArchive(
			accessor,
			agentId,
			operation,
			state.createdMemoryIds,
		)) {
			state.retiredMemoryIds.add(memoryId);
		}
	}
}

async function resolveRequeuedDreamingEvidence(
	accessor: DbAccessor,
	agentId: string,
	passId: string,
	result: ApplyDreamingOperationsResult,
	operations: readonly DreamingOperationRequest[],
): Promise<void> {
	const statements = [];
	const seen = new Set<string>();
	for (const item of result.items) {
		if (!item.ok) continue;
		const operation = operations[item.index];
		for (const rawEvidence of operation?.evidence ?? []) {
			if (!isRecord(rawEvidence)) continue;
			const sourceRef =
				typeof rawEvidence.source_ref === "string"
					? rawEvidence.source_ref.trim()
					: typeof rawEvidence.source_kind === "string" && typeof rawEvidence.source_id === "string"
						? `${rawEvidence.source_kind.trim()}:${rawEvidence.source_id.trim()}`
						: "";
			const separator = sourceRef.indexOf(":");
			if (separator <= 0) continue;
			const kind = sourceRef.slice(0, separator);
			const id = sourceRef.slice(separator + 1);
			if (!["memory", "artifact", "transcript", "summary"].includes(kind)) continue;
			const key = `${kind}:${id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			statements.push(
				ownerRunStatement(
					`UPDATE dreaming_evidence_exclusions
					 SET resolved_at = datetime('now')
					 WHERE agent_id = ? AND source_kind = ? AND source_id = ?
					   AND requeue_requested_at IS NOT NULL AND resolved_at IS NULL`,
					[agentId, kind, id],
				),
				ownerRunStatement(
					`UPDATE dreaming_attention
					 SET resolved_at = datetime('now'), resolved_by_pass_id = ?
					 WHERE agent_id = ? AND kind = 'evidence_requeue' AND subject_ref = ? AND resolved_at IS NULL`,
					[passId, agentId, key],
				),
			);
		}
	}
	if (statements.length === 0) return;
	await ownerTransaction(await getDbOwnerForAccessor(accessor), "dreaming.evidence-requeue.resolve", statements, {
		deadlineMs: 30_000,
		estimatedWorkUnits: statements.length,
	});
}

async function readDreamingEvidenceSource(
	accessor: DbAccessor,
	agentId: string,
	sourceRef: string,
): Promise<EpisodicSourceRecord | null> {
	const input: DbOwnerDreamingEvidenceSource = { agentId, sourceRef };
	return await runDbOwnerDomainOperation(accessor, {
		runWithOwner: async (owner) => {
			const handle = owner.submit<EpisodicSourceRecord | null>(
				{ kind: "dreaming_evidence_source", input },
				{
					operation: "dreaming.evidence.source",
					lane: "read",
					workloadClass: "foreground",
					deadlineMs: 30_000,
					estimatedWorkUnits: 10,
				},
			);
			return await handle.result;
		},
		runInline: ({ read }) => read((db) => readEpisodicSource(db, { agentId: input.agentId, from: input.sourceRef })),
	});
}

export function isPiCompactionStart(event: unknown): event is { type: "compaction_start"; reason?: string } {
	return typeof event === "object" && event !== null && (event as { type?: unknown }).type === "compaction_start";
}

export function runDreamingAgentPass(
	...args: Parameters<typeof executeDreamingAgentPass>
): ReturnType<typeof executeDreamingAgentPass> {
	return withWritePrincipal(undefined, () => executeDreamingAgentPass(...args));
}

async function executeDreamingAgentPass(
	accessor: DbAccessor,
	executor: DreamingAgentExecutor,
	cfg: DreamingConfig,
	_agentsDir: string,
	agentId: string,
	scopes: readonly string[],
	mode: DreamingMode,
	existingPassId?: string,
	writeCaps?: GraphWriteCaps,
	liveOptions?: DreamingPassLiveOptions,
	ownerMaintenance?: DbOwnerMaintenance,
): Promise<{ passId: string; applied: number; skipped: number; failed: number; summary: string }> {
	const excluded = await ownerQueryOne<{ id: string }>(
		ownerMaintenance?.owner ?? (await getDbOwnerForAccessor(accessor)),
		"dreaming.pass.agent-policy",
		`SELECT a.id FROM agents a WHERE instr(',' || ? || ',', ',' || a.id || ',') > 0
		AND (a.archived_at IS NOT NULL OR (a.kind='organization' AND EXISTS (
			SELECT 1 FROM organization o WHERE o.id=1 AND o.claimed_at IS NOT NULL AND o.agent_model='personal'
		))) LIMIT 1`,
		[[...new Set([agentId, ...scopes])].join(",")],
		{ deadlineMs: 10_000, estimatedWorkUnits: 1 },
	);
	if (excluded) throw new Error("org_policy");
	for (const scope of scopes) invalidateDreamingEpisodicTokenBacklog(scope);
	const policy = dreamingPassPolicy(cfg.policies, mode);
	const passId =
		existingPassId ??
		(await (ownerMaintenance
			? createDreamingPassThroughOwner(
					ownerMaintenance,
					agentId,
					mode,
					policy,
					undefined,
					liveOptions?.compartmentId ?? null,
				)
			: createDreamingPass(accessor, agentId, mode, policy, undefined, liveOptions?.compartmentId ?? null)));
	const live = liveOptions?.hub ?? dreamingLiveEvents;
	live.startPass({ passId, agentId, mode });
	live.publish(passId, "lifecycle", { phase: "preparing", mode });
	const passStartedAtMs = Date.now();
	const effects = createDreamingPassEffectState();
	let toolCallSequence = 0;
	let applied = 0;
	let failed = 0;
	try {
		const historyScopes = liveOptions?.userRequest !== undefined ? [agentId] : scopes;
		await ownerTransaction(
			await getDbOwnerForAccessor(accessor),
			"dreaming.pass.scope-key",
			[
				ownerRunStatement("UPDATE dreaming_passes SET scope_key = ? WHERE id = ? AND status = 'running'", [
					dreamingScopeKey(historyScopes),
					passId,
				]),
			],
			{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
		);
		const persistedPartition = await ownerQueryOne<{ compartmentId: number | null; valid: number; excluded: number }>(
			await getDbOwnerForAccessor(accessor),
			"dreaming.pass.partition",
			`SELECT p.compartment_id AS compartmentId, f.valid AS valid, EXISTS(SELECT 1 FROM agents a JOIN organization o ON o.id = 1 WHERE a.id = p.agent_id AND a.kind = 'organization' AND o.claimed_at IS NOT NULL AND o.agent_model = 'personal') AS excluded FROM dreaming_passes p JOIN dreaming_pass_fences f ON f.pass_id = p.id WHERE p.id = ? AND p.agent_id = ? AND p.status = 'running'`,
			[passId, agentId],
			{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
		);
		if (!persistedPartition || !persistedPartition.valid) throw new Error("compartment_mismatch");
		if (persistedPartition.excluded) throw new Error("org_policy");
		const compartmentId = persistedPartition.compartmentId;
		if (liveOptions?.compartmentId !== undefined && liveOptions.compartmentId !== compartmentId)
			throw new Error("compartment_mismatch");
		const basePrompt =
			scopes.length > 1 ? `${policy.text}\n\n<agent_scopes>\n${scopes.join("\n")}\n</agent_scopes>` : policy.text;
		const toolPrompt = cfg.codemode ? `${basePrompt}\n\n${DREAMING_CODEMODE_PROMPT}` : basePrompt;
		const prompt = liveOptions?.userRequest
			? `${toolPrompt}

The authenticated user requested this scoped maintenance task. Their instruction was recorded as evidence before this pass. Address it using the same audited tools and citation requirements; report any unsupported change rather than bypassing validation.
<user_request>
${JSON.stringify(liveOptions.userRequest)}
</user_request>`
			: toolPrompt;
		const cutoffRow = await ownerQueryOne<{ now: string }>(
			await getDbOwnerForAccessor(accessor),
			"dreaming.pass.cutoff",
			"SELECT datetime('now') AS now",
			[],
			{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
		);
		const cutoff = cutoffRow?.now ?? new Date().toISOString();
		const attentionScopes = liveOptions?.sharedScope?.attentionScopes ?? scopes;
		const [hasPendingHygieneAttention, hasPendingContentAttention, hasPendingAttention] = await Promise.all([
			Promise.all(
				attentionScopes.map(
					async (scope) =>
						(await ownerQueryOne<{ present: number }>(
							await getDbOwnerForAccessor(accessor),
							"dreaming.attention.hygiene-present",
							"SELECT 1 AS present FROM dreaming_attention WHERE agent_id = ? AND compartment_id IS ? AND kind = 'hygiene' AND resolved_at IS NULL LIMIT 1",
							[scope, compartmentId],
							{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
						)) !== undefined,
				),
			).then((values) => values.some(Boolean)),
			Promise.all(
				attentionScopes.map(
					async (scope) =>
						(await ownerQueryOne<{ present: number }>(
							await getDbOwnerForAccessor(accessor),
							"dreaming.attention.content-present",
							"SELECT 1 AS present FROM dreaming_attention WHERE agent_id = ? AND compartment_id IS ? AND kind IN ('review_due', 'contested_claim', 'evidence_requeue', 'surprisal') AND resolved_at IS NULL LIMIT 1",
							[scope, compartmentId],
							{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
						)) !== undefined,
				),
			).then((values) => values.some(Boolean)),
			Promise.all(
				attentionScopes.map(
					async (scope) =>
						(await ownerQueryOne<{ present: number }>(
							await getDbOwnerForAccessor(accessor),
							"dreaming.attention.present",
							"SELECT 1 AS present FROM dreaming_attention WHERE agent_id = ? AND compartment_id IS ? AND resolved_at IS NULL LIMIT 1",
							[scope, compartmentId],
							{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
						)) !== undefined,
				),
			).then((values) => values.some(Boolean)),
		]);
		const hasBacklogByScope = new Map(
			await Promise.all(
				scopes.map(
					async (scope) =>
						[scope, await hasDreamingEpisodicBacklog(accessor, scope, ownerMaintenance, compartmentId)] as const,
				),
			),
		);
		const hasBacklog = [...hasBacklogByScope.values()].some(Boolean);
		const earlyExitSummary = liveOptions?.userRequest
			? null
			: dreamingEarlyExitSummary(
					mode,
					hasPendingHygieneAttention,
					hasBacklog,
					hasPendingContentAttention || (hasPendingAttention && !hasPendingHygieneAttention),
				);
		if (earlyExitSummary !== null) {
			const statements = [
				ownerRunStatement(
					`UPDATE dreaming_passes SET status = 'completed', completed_at = datetime('now'),
					 tokens_consumed = 0, mutations_applied = 0, mutations_skipped = 0,
					 mutations_failed = 0, summary = ? WHERE id = ?`,
					[earlyExitSummary, passId],
				),
			];
			if (dreamingModeAdvancesEvidence(mode, hasBacklog)) {
				for (const scope of scopes) {
					if (hasBacklogByScope.get(scope) === true) {
						statements.push(
							ownerRunStatement(
								`INSERT INTO dreaming_state
									 (agent_id, compartment_id, consecutive_failures, last_failure_at, last_pass_at, evidence_cursor, last_pass_id, last_pass_mode)
									 VALUES (?, ?, 0, NULL, ?, NULL, ?, ?)
									 ON CONFLICT(agent_id, COALESCE(compartment_id,0)) DO UPDATE SET
									   consecutive_failures = 0, last_failure_at = NULL, last_pass_at = CASE WHEN julianday(dreaming_state.last_pass_at) > julianday(excluded.last_pass_at) THEN dreaming_state.last_pass_at ELSE excluded.last_pass_at END,
									   evidence_cursor = NULL, last_pass_id = excluded.last_pass_id,
									   last_pass_mode = excluded.last_pass_mode, updated_at = datetime('now')`,
								[scope, compartmentId, cutoff, passId, mode],
							),
						);
					}
				}
			}
			await ownerTransaction(await getDbOwnerForAccessor(accessor), "dreaming.pass.complete-no-work", statements, {
				deadlineMs: 30_000,
				estimatedWorkUnits: statements.length,
			});
			recordDreamingPassTelemetry({
				mode,
				outcome: "no-op",
				outcomeCode: "no_work",
				effects: dreamingPassEffects(effects, 0, passStartedAtMs),
				usage: null,
			});
			recordPipelineOperation({
				operationClass: "dreaming",
				outcome: "skipped",
				accepted: 0,
				skipped: 1,
				retried: 0,
				failed: 0,
				durationMs: Date.now() - passStartedAtMs,
				queueAgeMs: 0,
			});
			live.finish(passId, "completed", { summary: earlyExitSummary, outcome: "no_work" });
			return { passId, applied: 0, skipped: 0, failed: 0, summary: earlyExitSummary };
		}

		let applyCallbackReported = false;
		let memoryHeadCommitInput: MemoryHeadCommitInput | null = null;
		let memoryHeadCommitRejection = null as { readonly code: string; readonly error: string } | null;
		const memoryHeadCommitter: MemoryHeadCommitter = {
			read: (scopeId) => (liveOptions?.memoryHeadReader ?? readCuratedMemoryHead)(scopeId, passId),
			async commit(input) {
				if (mode !== "incremental-content" || input.agentId !== agentId || input.passId !== passId) {
					memoryHeadCommitRejection = {
						code: "PASS_NOT_AUTHORIZED",
						error: "only the active content pass may stage its memory-head commit",
					};
					return { ok: false, ...memoryHeadCommitRejection };
				}
				if (memoryHeadCommitInput !== null) {
					memoryHeadCommitInput = null;
					memoryHeadCommitRejection = {
						code: "MULTIPLE_COMMIT_ATTEMPTS",
						error: "a content pass may stage only one memory-head commit",
					};
					return { ok: false, ...memoryHeadCommitRejection };
				}
				const invalid = memoryHeadInputError(input);
				if (invalid !== null) {
					memoryHeadCommitRejection = invalid;
					return { ok: false, ...invalid };
				}
				memoryHeadCommitInput = input;
				return { ok: true, code: "STAGED_FOR_FINALIZATION" };
			},
		};
		let retirementCandidates: DreamingRetirementCandidates = new Map();
		const rejectedEvidence: RejectedDreamingEvidence[] = [];
		const surfacedWatermarkByScope = new Map<string, string>();
		const surfacedTranscriptRefsByScope = new Map<string, Set<string>>();
		const tools = createDreamingAgentTools({
			allowedAgentIds: liveOptions?.userRequest !== undefined ? [agentId] : scopes,
			codemode: cfg.codemode,
			...(mode === "incremental-content"
				? {}
				: {
						capabilityIds: DREAMING_CAPABILITY_IDS.filter(
							(id) => id !== "memory_head_read" && id !== "memory_head_commit",
						),
					}),
			evidenceDeliveryDeadline: Date.now() + Math.floor(cfg.timeout / 2),
			evidenceLeaseMs: liveOptions?.sharedScope?.evidenceLeaseMs ?? cfg.timeout * 2,
			compartmentId,
			passDeadline: Date.now() + cfg.timeout,
			...(cfg.maxPassTokens === undefined ? {} : { evidenceTokenBudget: cfg.maxPassTokens }),
			evidenceChars: dreamingEvidencePageChars(cfg.maxInputTokens),
			accessor,
			agentId,
			memoryHeadCommitter,
			actor: "dreaming",
			passId,
			mode,
			writeCaps,
			async onOperationsAboutToApply(operations, scopeId) {
				retirementCandidates = await collectDreamingRetirementCandidates(accessor, scopeId, operations);
			},
			async onOperationsApplied(result, operations, scopeId) {
				applyCallbackReported = true;
				applied += result.items.filter((item) => item.ok).length;
				failed += result.items.filter((item) => !item.ok).length;
				if (!result.ok && result.items.length === 0) failed++;
				await recordDreamingOperationEffects(accessor, scopeId, effects, result, operations, retirementCandidates);
				retirementCandidates = new Map();
				await resolveRequeuedDreamingEvidence(accessor, scopeId, passId, result, operations);
				rejectedEvidence.push(
					...(await collectRejectedDreamingEvidence(accessor, scopeId, result, operations, passId)),
				);
			},
			async onToolCall(trace) {
				publishDreamingToolTrace(passId, trace, live);
				await recordDreamingToolCall(accessor, agentId, passId, ++toolCallSequence, trace);
				if (trace.tool === "search_evidence" && trace.output.ok === true && Array.isArray(trace.output.items)) {
					const input = isRecord(trace.input) ? trace.input : null;
					const scope = input !== null && typeof input.agentId === "string" ? input.agentId : agentId;
					const transcriptRefs = surfacedTranscriptRefsByScope.get(scope) ?? new Set<string>();
					for (const item of trace.output.items) {
						const record = isRecord(item) ? item : null;
						const sourceRef = typeof record?.sourceRef === "string" ? record.sourceRef : null;
						const kind = typeof record?.kind === "string" ? record.kind : null;
						const id = typeof record?.id === "string" ? record.id : null;
						if (sourceRef !== null) effects.consideredArtifacts.add(sourceRef);
						else if (kind !== null && id !== null) effects.consideredArtifacts.add(`${kind}:${id}`);
						else effects.consideredArtifacts.add(`anonymous:${effects.consideredArtifacts.size}`);
						if (sourceRef?.startsWith("transcript:")) transcriptRefs.add(sourceRef);
					}
					if (transcriptRefs.size > 0) surfacedTranscriptRefsByScope.set(scope, transcriptRefs);
					if (input === null || typeof input.sourceRef !== "string") {
						const scope = input !== null && typeof input.agentId === "string" ? input.agentId : agentId;
						const surfaced = surfacedEvidenceWatermark(trace.output.items);
						if (surfaced !== null) {
							const current = surfacedWatermarkByScope.get(scope);
							if (current === undefined || timestampMillis(surfaced) > timestampMillis(current)) {
								surfacedWatermarkByScope.set(scope, surfaced);
							}
						}
					}
				}
				if (trace.tool === "apply_ontology_ops") {
					if (!trace.output.ok && !applyCallbackReported) {
						const input = isRecord(trace.input) ? trace.input : null;
						const operations = input?.operations;
						if (Array.isArray(operations)) {
							const evidenceOperations = operations.flatMap((operation) => {
								if (!isRecord(operation)) return [];
								return [{ evidence: Array.isArray(operation.evidence) ? operation.evidence : [] }];
							});
							const operationAgentId =
								typeof input?.agentId === "string" && input.agentId.trim().length > 0 ? input.agentId.trim() : agentId;
							rejectedEvidence.push(
								...(await collectRejectedDreamingEvidence(
									accessor,
									operationAgentId,
									{ ok: false, items: [] },
									evidenceOperations,
									passId,
								)),
							);
						}
						failed++;
					}
					applyCallbackReported = false;
				}
			},
		});
		const passPrompt = dreamingPassPrompt(
			prompt,
			await renderDreamingHistoryForPass(accessor, agentId, historyScopes, compartmentId),
			await renderPendingDreamingAttention(
				accessor,
				liveOptions?.sharedScope?.attentionScopes ?? historyScopes,
				mode,
				compartmentId,
			),
		).concat("\n\n", dreamingPassClock(new Date(), detectLocalTimeZone()));
		logger.info("dreaming", "Starting agentic dreaming pass", {
			mode,
			promptChars: passPrompt.length,
		});
		const executorResult = await executor.run({
			passId,
			prompt: passPrompt,
			tools,
			timeoutMs: cfg.timeout,
			maxTokens: cfg.maxOutputTokens ?? undefined,
			onEvent: (event) => {
				if (isPiCompactionStart(event)) {
					logger.warn("dreaming", "Pi auto-compaction fired inside a Dreaming pass", {
						passId,
						reason: event.reason ?? null,
					});
				}
				publishDreamingAgentEvent(passId, event, live);
			},
			onSessionInfo: (info) => publishDreamingSessionInfo(passId, info, live),
		});
		if (mode === "incremental-content" && memoryHeadCommitInput === null) {
			const rejection = memoryHeadCommitRejection;
			throw new Error(
				rejection === null
					? "Content pass finalization requires a successful memory-head commit: the agent ended without calling memory_head_commit"
					: `Content pass finalization requires a successful memory-head commit: memory_head_commit was rejected (${rejection.code}): ${rejection.error}`,
			);
		}
		const summary = executorResult.summary?.trim() || "Agentic Dreaming pass completed";
		const attribution = executorResult.attribution ?? null;
		const usage = executorResult.usage ?? null;
		const tokensConsumed = usage?.totalTokens ?? null;
		const nextWatermarkByScope = new Map<string, string | null>();
		for (const scope of scopes) {
			const previous =
				(
					await ownerQueryOne<{ lastPassAt: string | null }>(
						await getDbOwnerForAccessor(accessor),
						"dreaming.state.watermark",
						"SELECT last_pass_at AS lastPassAt FROM dreaming_state WHERE agent_id = ? AND compartment_id IS ?",
						[scope, compartmentId],
						{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
					)
				)?.lastPassAt ?? null;
			const surfaced = surfacedWatermarkByScope.get(scope);
			nextWatermarkByScope.set(
				scope,
				surfaced === undefined ? previous : nextEvidenceWatermark(surfaced, previous, cutoff),
			);
		}
		const transcriptManifestEntries: Array<{ scope: string; source: EpisodicSourceRecord; content: string }> = [];
		for (const [scope, refs] of surfacedTranscriptRefsByScope) {
			for (const sourceRef of refs) {
				const source = await readDreamingEvidenceSource(accessor, scope, sourceRef);
				if (source !== null && source.completed)
					transcriptManifestEntries.push({ scope, source, content: sanitizeTranscriptForDreaming(source.content) });
			}
		}
		const finalizeInput: DbOwnerDreamingPassFinalize = {
			passId,
			mode,
			agentId,
			scopes,
			transcriptManifestEntries,
			tokensConsumed,
			inputTokens: usage?.inputTokens ?? null,
			outputTokens: usage?.outputTokens ?? null,
			cacheReadTokens: usage?.cacheReadTokens ?? null,
			cacheCreationTokens: usage?.cacheCreationTokens ?? null,
			peakContextTokens: usage?.peakContextTokens ?? null,
			totalCost: usage?.totalCost ?? null,
			applied,
			failed,
			summary,
			rejectedEvidence,
			memoryHeadCommitInput,
			hasBacklogByScope: [...hasBacklogByScope].map(([scope, scopeHasBacklog]) => ({
				scope,
				hasBacklog: scopeHasBacklog,
			})),
			nextWatermarkByScope: [...nextWatermarkByScope].map(([scope, watermark]) => ({ scope, watermark })),
		};
		await runDbOwnerDomainOperation(accessor, {
			runWithOwner: async (owner) => {
				const finalize = owner.submit<null>(
					{ kind: "dreaming_pass_finalize", input: finalizeInput },
					{
						operation: "dreaming.pass.finalize",
						lane: "write",
						workloadClass: "foreground",
						deadlineMs: 60_000,
						estimatedWorkUnits: 500,
					},
				);
				return await finalize.result;
			},
			runInline: async ({ write }) => {
				const result = await write((db) => {
					finalizeDreamingPassInDb(db, finalizeInput);
					return null;
				});
				if (mode === "incremental-content" && compartmentId === null) {
					try {
						const projection = await (liveOptions?.memoryHeadReader ?? readCuratedMemoryHead)(agentId);
						if (projection.publication === "pending") {
							logger.warn("dreaming", "Content pass completed with a pending MEMORY.md projection", {
								passId,
								agentId,
								error: projection.publicationError,
							});
						}
					} catch (error) {
						logger.warn("dreaming", "Content pass completed but MEMORY.md projection retry failed", {
							passId,
							agentId,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
				return result;
			},
		});
		const outcome: DreamingPassOutcome =
			failed > 0
				? effects.usefulEffects === 0
					? "failed"
					: "completed"
				: effects.usefulEffects === 0
					? "no-op"
					: "completed";
		const outcomeCode: DreamingPassOutcomeCode =
			effects.usefulEffects === 0
				? failed > 0
					? "mutation_failure"
					: "no_effects"
				: failed > 0
					? "partial_failure"
					: "completed";
		recordDreamingPassTelemetry({
			mode,
			outcome,
			outcomeCode,
			effects: dreamingPassEffects(effects, toolCallSequence, passStartedAtMs),
			attribution,
			usage,
		});
		recordPipelineOperation({
			operationClass: "dreaming",
			outcome: failed > 0 ? (applied > 0 ? "partial" : "failed") : "completed",
			accepted: applied,
			skipped: 0,
			retried: 0,
			failed,
			durationMs: Date.now() - passStartedAtMs,
			queueAgeMs: 0,
		});
		live.finish(passId, "completed", {
			summary,
			applied,
			failed,
			outcome,
		});

		return { passId, applied, skipped: 0, failed, summary };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		recordPipelineError("decision", isPipelineTimeout(error) ? "DECISION_TIMEOUT" : "DECISION_INVALID");
		logger.error("dreaming", "Agentic dreaming pass failed", undefined, { error: message });
		try {
			await failDreamingPass(accessor, passId, message);
		} finally {
			live.finish(passId, isDreamingPassCancellation(error) ? "cancelled" : "failed", { error: message });
			recordDreamingPassTelemetry({
				mode,
				outcome: isDreamingPassCancellation(error) ? "cancelled" : "failed",
				outcomeCode: isDreamingPassCancellation(error) ? "cancelled" : isPipelineTimeout(error) ? "timeout" : "error",
				effects: dreamingPassEffects(effects, toolCallSequence, passStartedAtMs),
				usage: null,
			});
		}
		recordPipelineOperation({
			operationClass: "dreaming",
			outcome: applied > 0 ? "partial" : "failed",
			accepted: applied,
			skipped: 0,
			retried: 0,
			failed: Math.max(1, failed),
			durationMs: Date.now() - passStartedAtMs,
			queueAgeMs: 0,
			causeFamily: normalizePipelineCause(error),
		});
		throw error;
	}
}
const MAX_FAILURE_BACKOFF_MULTIPLIER = 6;
const FAILURE_BACKOFF_BASE_MS = 5 * 60 * 1000;
export const DREAMING_EVIDENCE_KINDS = ["memory", "artifact", "transcript"] as const;

function writeDreamingTranscriptManifestInTx(
	db: WriteDb,
	params: {
		readonly passId: string;
		readonly entries: readonly {
			readonly scope: string;
			readonly source: EpisodicSourceRecord;
			readonly content: string;
		}[];
	},
): void {
	const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'").get();
	if (table == null) return;
	const statement = db.prepare(
		`INSERT INTO session_summaries (
			id, project, depth, kind, content, token_count,
			earliest_at, latest_at, session_key, harness,
			agent_id, source_type, source_ref, meta_json, created_at, compartment_id, author_user_id
		) VALUES (?, ?, 0, 'session', ?, ?, ?, ?, ?, ?, ?, 'transcript', ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
			project = excluded.project,
			content = excluded.content,
			token_count = excluded.token_count,
			earliest_at = excluded.earliest_at,
			latest_at = excluded.latest_at,
			session_key = excluded.session_key,
			harness = excluded.harness,
			agent_id = excluded.agent_id,
			source_type = excluded.source_type,
			source_ref = excluded.source_ref,
			meta_json = excluded.meta_json,
			compartment_id = excluded.compartment_id,
			author_user_id = excluded.author_user_id`,
	);
	const now = new Date().toISOString();
	for (const entry of params.entries) {
		if (
			!entry.source.completed ||
			entry.content.trim().length === 0 ||
			!admitSessionTranscriptInDb(db, {
				agentId: entry.scope,
				sessionKey: entry.source.id,
				capturedAt: entry.source.capturedAt,
			})
		)
			continue;
		const partition = dreamingPassPartitionInDb(db, params.passId, entry.scope);
		const compartmentId = compartmentForWrite(db, {
			agentId: entry.scope,
			sessionKey: entry.source.id,
			parentCompartment: partition.compartmentId,
		});
		if (compartmentId !== partition.compartmentId) throw new Error("compartment_mismatch");
		const content = entry.content.trim();
		const contentHash = createHash("sha256").update(content).digest("hex");
		const existing = db
			.prepare(
				`SELECT id FROM session_summaries
				 WHERE agent_id = ? AND session_key = ? AND depth = 0
				   AND COALESCE(source_type, 'summary') IN ('summary', 'checkpoint') AND compartment_id IS ?
				 LIMIT 1`,
			)
			.get(entry.scope, entry.source.id, compartmentId) as { id: string } | null;
		const nodeId =
			existing?.id ??
			`transcript:${entry.scope}:${entry.source.id}${compartmentId === null ? "" : `:c${compartmentId}`}`;
		const speaker = db
			.prepare("SELECT speaker_user_id FROM session_transcripts WHERE agent_id = ? AND session_key = ?")
			.get(entry.scope, entry.source.id)?.speaker_user_id;
		statement.run(
			nodeId,
			entry.source.project,
			content,
			countTokens(content),
			entry.source.capturedAt,
			entry.source.capturedAt,
			entry.source.id,
			entry.source.harness,
			entry.scope,
			entry.source.id,
			JSON.stringify({
				source: "dreaming-content-pass",
				passId: params.passId,
				sourceRef: `transcript:${entry.source.id}`,
				contentHash,
			}),
			now,
			compartmentId,
			typeof speaker === "string" ? speaker : null,
		);
		if (compartmentId !== null) continue;
		upsertThreadHead(db as unknown as Database, {
			agentId: entry.scope,
			nodeId,
			content,
			latestAt: now,
			project: entry.source.project,
			sessionKey: entry.source.id,
			sourceType: "transcript",
			sourceRef: entry.source.id,
			harness: entry.source.harness,
		});
	}
}
export function finalizeDreamingPassInDb(db: WriteDb, input: DbOwnerDreamingPassFinalize): void {
	const partition = dreamingPassPartitionInDb(db, input.passId, input.agentId);
	for (const scope of input.scopes) dreamingPassPartitionInDb(db, input.passId, scope);
	const peerHeldEvidence = evidenceLeasedByOtherPassesInScopes(db, input.passId, input.scopes);
	let memoryHeadResult: Record<string, unknown> | null = null;
	withContentPassWrites(db, input.passId, () =>
		writeDreamingTranscriptManifestInTx(db, {
			passId: input.passId,
			entries: input.transcriptManifestEntries as Array<{
				scope: string;
				source: EpisodicSourceRecord;
				content: string;
			}>,
		}),
	);
	if (input.mode === "incremental-content") {
		const commitInput = input.memoryHeadCommitInput;
		if (commitInput === null)
			throw new Error(
				"Content pass finalization requires a successful memory-head commit: the agent ended without calling memory_head_commit",
			);
		if (commitInput.agentId !== input.agentId || commitInput.passId !== input.passId) {
			throw new Error("Content pass memory-head commit does not match its finalizing pass");
		}
		memoryHeadResult = commitCuratedMemoryHeadInDb(db, commitInput);
		if (memoryHeadResult.ok !== true) {
			const code = typeof memoryHeadResult.code === "string" ? memoryHeadResult.code : "unknown";
			const error = typeof memoryHeadResult.error === "string" ? memoryHeadResult.error : "commit was rejected";
			throw new Error(`Content pass finalization requires a successful memory-head commit (${code}): ${error}`);
		}
	} else if (input.memoryHeadCommitInput !== null) {
		throw new Error("Only an incremental-content pass may commit the memory head");
	}
	recordRejectedDreamingEvidenceInTx(db, input.passId, input.rejectedEvidence as RejectedDreamingEvidence[]);
	if (memoryHeadResult !== null) {
		const row = db.prepare("SELECT runbook_json AS runbookJson FROM dreaming_passes WHERE id = ?").get(input.passId) as
			| { runbookJson: string | null }
			| undefined;
		let manifest: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(row?.runbookJson ?? "{}");
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) manifest = parsed as Record<string, unknown>;
		} catch {
			manifest = {};
		}
		manifest.memoryHead = memoryHeadResult;
		db.prepare("UPDATE dreaming_passes SET runbook_json = ? WHERE id = ?").run(JSON.stringify(manifest), input.passId);
	}
	if (input.mode !== "incremental-hygiene") {
		const runbook = db
			.prepare("SELECT runbook_json AS runbookJson FROM dreaming_passes WHERE id = ?")
			.get(input.passId) as { runbookJson: string | null } | null;
		let parsedRunbook: Record<string, unknown> | null = {};
		try {
			const parsed: unknown = JSON.parse(runbook?.runbookJson ?? "{}");
			parsedRunbook = isRecord(parsed) ? parsed : null;
		} catch {
			parsedRunbook = null;
		}
		const runbookDeferred = parsedRunbook === null ? null : deferredEvidenceKeys(parsedRunbook, input.agentId);
		const failedEvidence = failedOperationEvidence(db, input.passId, input.agentId, input.scopes);
		const deferredEvidence =
			runbookDeferred === null ? null : new Set([...runbookDeferred, ...failedEvidence.sources, ...peerHeldEvidence]);
		const reviewedExcludedEvidence =
			parsedRunbook === null ? null : parseDreamingReviewedExcludedEvidence(parsedRunbook);
		if (deferredEvidence !== null && reviewedExcludedEvidence !== null) {
			recordDreamingEvidenceConsumptionInTx(db, {
				passId: input.passId,
				deferredEvidence,
				withheldScopes: failedEvidence.scopes,
				filedSources: failedEvidence.filedSources,
				filedCitations: failedEvidence.filedCitations,
			});
			recordDreamingReviewedExcludedEvidenceInTx(db, {
				passId: input.passId,
				scopeIds: new Set(input.scopes),
				entries: reviewedExcludedEvidence,
				deferredEvidence,
			});
		}
		resolveImportedSourceAttentionInTx(db, input.passId, input.scopes);
	}
	if (
		dreamingModeAdvancesEvidence(
			input.mode as DreamingMode,
			input.hasBacklogByScope.some((item) => item.hasBacklog),
		)
	) {
		const watermarks = new Map(input.nextWatermarkByScope.map((item) => [item.scope, item.watermark]));
		for (const item of input.hasBacklogByScope) {
			if (!item.hasBacklog) continue;
			resetDreamingTokens(
				db,
				item.scope,
				input.passId,
				input.mode,
				null,
				watermarks.get(item.scope) ?? null,
				partition.compartmentId,
			);
		}
	}
	db.prepare(
		`UPDATE dreaming_passes SET status = 'completed', completed_at = datetime('now'),
		 tokens_consumed = ?, tokens_input = ?, tokens_output = ?,
		 tokens_cache_read = ?, tokens_cache_write = ?, tokens_peak_context = ?, tokens_cost = ?,
		 mutations_applied = ?, mutations_skipped = ?,
		 mutations_failed = ?, summary = ? WHERE id = ?`,
	).run(
		input.tokensConsumed,
		input.inputTokens,
		input.outputTokens,
		input.cacheReadTokens,
		input.cacheCreationTokens,
		input.peakContextTokens ?? null,
		input.totalCost,
		input.applied,
		0,
		input.failed,
		input.summary,
		input.passId,
	);
	releaseDreamingEvidenceLeasesInTx(db, input.passId);
}
export const DREAMING_FAILURE_HALT_THRESHOLD = 5;
export const DREAMING_HALT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const DREAMING_SCHEDULE_BACKLOG_MAX_SOURCES = 50;
export function isDreamingScopeHalted(state: DreamingState, nowMs = Date.now()): boolean {
	if (state.consecutiveFailures < DREAMING_FAILURE_HALT_THRESHOLD) return false;
	const failedAt = state.lastFailureAt === null ? Number.NaN : utcTimestampMs(state.lastFailureAt);
	return Number.isFinite(failedAt) && nowMs - failedAt < DREAMING_HALT_COOLDOWN_MS;
}
export async function isDreamingHaltActive(
	accessor: DbAccessor,
	agentId: string,
	nowMs = Date.now(),
	compartmentId: number | null = null,
): Promise<boolean> {
	return isDreamingScopeHalted(await getDreamingState(accessor, agentId, compartmentId), nowMs);
}

interface DreamingBacklogRead {
	readonly entries: readonly DreamingBacklogTokenEntry[];
	readonly hasBacklog: boolean | null;
	readonly complete: boolean;
	readonly sourcesScanned: number;
}

function boundedDreamingBacklogSourceLimit(maxSources: number): number {
	if (!Number.isFinite(maxSources)) throw new RangeError("Dreaming backlog source limit must be finite");
	return Math.max(1, Math.min(Math.floor(maxSources), DREAMING_SCHEDULE_BACKLOG_MAX_SOURCES));
}

function validDreamingBacklogEntry(
	db: ReadDb,
	agentId: string,
	source: EpisodicSourceRecord,
	useConsumption: boolean,
	offsetOverride?: number,
): DreamingBacklogTokenEntry | null {
	const offset = offsetOverride ?? (useConsumption ? deliveredOffsetForSource(db, agentId, source) : 0);
	const text = renderDreamingEvidence(source).slice(offset);
	return text.length === 0
		? null
		: {
				key: `${source.kind}:${source.id}:${offset}`,
				revision: source.sourceRevision ?? source.capturedAt,
				text,
			};
}

function backlogReadFromSources(
	sources: readonly EpisodicSourceRecord[],
	sourceLimit: number | null,
	entryFor: (source: EpisodicSourceRecord) => DreamingBacklogTokenEntry | null,
): DreamingBacklogRead {
	const countedSources = sourceLimit === null ? sources : sources.slice(0, sourceLimit);
	const entries = countedSources.flatMap((source) => {
		const entry = entryFor(source);
		return entry === null ? [] : [entry];
	});
	const lookahead = sourceLimit === null ? undefined : sources[sourceLimit];
	return {
		entries,
		hasBacklog: entries.length > 0 || (lookahead !== undefined && entryFor(lookahead) !== null),
		complete: sourceLimit === null || sources.length <= sourceLimit,
		sourcesScanned: countedSources.length,
	};
}

function withCandidateScanResult(
	read: DreamingBacklogRead,
	candidateScan: { readonly complete: boolean } | null,
): DreamingBacklogRead {
	if (candidateScan === null || candidateScan.complete) return read;
	return {
		...read,
		hasBacklog: read.hasBacklog === true ? true : null,
		complete: false,
	};
}

function readDreamingEpisodicBacklogInDb(
	db: ReadDb,
	agentId: string,
	sourceLimit: number | null,
	compartmentId: number | null = null,
): DreamingBacklogRead {
	const candidateScan =
		sourceLimit === null
			? null
			: scanEpisodicSourceCandidates(db, agentId, sourceLimit, { exactCompartment: compartmentId });
	const candidateRefs = candidateScan?.refs;
	const queued = searchEpisodicSources(db, {
		agentId,
		exactCompartment: compartmentId,
		query: "",
		excludeDelivered: true,
		limit: sourceLimit === null ? null : sourceLimit + 1,
		order: sourceLimit === null ? "newest" : "none",
		candidateRefs,
	});
	return withCandidateScanResult(
		backlogReadFromSources(queued, sourceLimit, (source) => validDreamingBacklogEntry(db, agentId, source, true)),
		candidateScan,
	);
}
export function getDreamingEpisodicTokenBacklogInDb(
	db: ReadDb,
	agentId: string,
	compartmentId: number | null = null,
): Promise<number> {
	const read = readDreamingEpisodicBacklogInDb(db, agentId, null, compartmentId);
	return refreshDreamingBacklogTokenCache(
		compartmentId === null ? agentId : `${agentId}\u0000${compartmentId}`,
		read.entries,
	);
}

function ensureDreamingTokenThreshold(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError("Dreaming token threshold must be a finite non-negative safe integer");
	}
	return value;
}
export function probeDreamingEpisodicBacklogInDb(
	db: ReadDb,
	agentId: string,
	tokenThreshold: number,
	maxSources: number,
	compartmentId: number | null = null,
): Promise<DreamingEpisodicBacklogProbe> {
	const threshold = ensureDreamingTokenThreshold(tokenThreshold);
	const sourceLimit = boundedDreamingBacklogSourceLimit(maxSources);
	const read = readDreamingEpisodicBacklogInDb(db, agentId, sourceLimit, compartmentId);
	return countDreamingBacklogTokenEntries(
		compartmentId === null ? agentId : `${agentId}\u0000${compartmentId}`,
		read.entries,
		read.complete ? undefined : threshold,
	).then((result) => {
		if (read.complete && read.hasBacklog !== null) {
			return {
				kind: "exact",
				tokens: result.tokens,
				hasBacklog: read.hasBacklog,
				sourcesScanned: read.sourcesScanned,
			};
		}
		if (result.entriesCounted > 0 && result.tokens >= threshold) {
			return {
				kind: "threshold-reached",
				tokenLowerBound: result.tokens,
				hasBacklog: true,
				sourcesScanned: result.entriesCounted,
			};
		}
		return {
			kind: "indeterminate",
			tokenLowerBound: result.tokens,
			hasBacklog: read.hasBacklog,
			sourcesScanned: result.entriesCounted,
		};
	});
}
export function hasDreamingEpisodicBacklogInDb(
	db: ReadDb,
	agentId: string,
	compartmentId: number | null = null,
): boolean {
	return readDreamingEpisodicBacklogInDb(db, agentId, 1, compartmentId).hasBacklog ?? true;
}

export async function getDreamingEpisodicTokenBacklog(
	accessor: DbAccessor,
	agentId: string,
	ownerMaintenance?: DbOwnerMaintenance,
	compartmentId: number | null = null,
): Promise<number> {
	const input: DbOwnerDreamingEpisodicBacklog = { agentId, compartmentId };
	const measurementGeneration = beginDreamingEpisodicTokenBacklogMeasurement(
		compartmentId === null ? agentId : `${agentId}\u0000${compartmentId}`,
	);
	const options = { deadlineMs: 60_000, estimatedWorkUnits: DB_OWNER_MAX_WORK_UNITS };
	const count = ownerMaintenance
		? await ownerMaintenance.dreamingEpisodicBacklog(input, options)
		: await runDbOwnerDomainOperation(accessor, {
				runWithOwner: async (owner) => await ownerDreamingEpisodicBacklog(owner, input, options),
				runInline: ({ read }) =>
					read((db) => getDreamingEpisodicTokenBacklogInDb(db, input.agentId, input.compartmentId)),
			});
	recordDreamingEpisodicTokenBacklog(
		compartmentId === null ? agentId : `${agentId}\u0000${compartmentId}`,
		count,
		measurementGeneration,
	);
	return count;
}

export async function probeDreamingEpisodicBacklog(
	accessor: DbAccessor,
	agentId: string,
	tokenThreshold: number,
	ownerMaintenance?: DbOwnerMaintenance,
	compartmentId: number | null = null,
): Promise<DreamingEpisodicBacklogProbe> {
	const measurementGeneration = beginDreamingEpisodicTokenBacklogMeasurement(
		compartmentId === null ? agentId : `${agentId}\u0000${compartmentId}`,
	);
	const input: DbOwnerDreamingEpisodicBacklogProbe = {
		agentId,
		compartmentId,
		tokenThreshold: ensureDreamingTokenThreshold(tokenThreshold),
		maxSources: DREAMING_SCHEDULE_BACKLOG_MAX_SOURCES,
	};
	const options = { deadlineMs: 60_000, estimatedWorkUnits: input.maxSources * 10 };
	const result = ownerMaintenance
		? await ownerMaintenance.dreamingEpisodicBacklogProbe(input, options)
		: await runDbOwnerDomainOperation(accessor, {
				runWithOwner: async (owner) => await ownerDreamingEpisodicBacklogProbe(owner, input, options),
				runInline: ({ read }) =>
					read((db) =>
						probeDreamingEpisodicBacklogInDb(
							db,
							input.agentId,
							input.tokenThreshold,
							input.maxSources,
							input.compartmentId,
						),
					),
			});
	if (result.kind === "exact")
		recordDreamingEpisodicTokenBacklog(
			compartmentId === null ? agentId : `${agentId}\u0000${compartmentId}`,
			result.tokens,
			measurementGeneration,
		);
	else invalidateDreamingEpisodicTokenBacklog(compartmentId === null ? agentId : `${agentId}\u0000${compartmentId}`);
	return result;
}

export async function hasDreamingEpisodicBacklog(
	accessor: DbAccessor,
	agentId: string,
	ownerMaintenance?: DbOwnerMaintenance,
	compartmentId: number | null = null,
): Promise<boolean> {
	const input: DbOwnerDreamingEpisodicBacklogExists = { agentId, compartmentId };
	const options = { deadlineMs: 30_000, estimatedWorkUnits: 10 };
	if (ownerMaintenance) return await ownerMaintenance.dreamingEpisodicBacklogExists(input, options);
	return await runDbOwnerDomainOperation(accessor, {
		runWithOwner: async (owner) => await ownerDreamingEpisodicBacklogExists(owner, input, options),
		runInline: ({ read }) => read((db) => hasDreamingEpisodicBacklogInDb(db, input.agentId, input.compartmentId)),
	});
}

export async function shouldTriggerDreaming(
	accessor: DbAccessor,
	cfg: DreamingConfig,
	agentId: string,
	nowMs = Date.now(),
	episodicTokens?: number,
): Promise<boolean> {
	const tokens = episodicTokens ?? (await getDreamingEpisodicTokenBacklog(accessor, agentId));
	const signal: DreamingEpisodicBacklogProbe = {
		kind: "exact",
		tokens,
		hasBacklog: tokens > 0,
		sourcesScanned: 0,
	};
	return (await evaluateDreamingTrigger(accessor, cfg, agentId, signal, nowMs)).trigger;
}

export async function evaluateDreamingTrigger(
	accessor: DbAccessor,
	cfg: DreamingConfig,
	agentId: string,
	backlog: DreamingEpisodicBacklogProbe,
	nowMs = Date.now(),
	compartmentId: number | null = null,
): Promise<DreamingTriggerDecision> {
	const state = await getDreamingState(accessor, agentId, compartmentId);
	const hasAttention =
		(await ownerQueryOne<{ present: number }>(
			await getDbOwnerForAccessor(accessor),
			"dreaming.attention.present",
			`SELECT 1 AS present FROM dreaming_attention
			 WHERE agent_id = ? AND compartment_id IS ? AND resolved_at IS NULL
			   AND NOT ${STALLED_EVIDENCE_ATTENTION_SQL} AND NOT ${SEEN_IMPORTED_SOURCE_ATTENTION_SQL} LIMIT 1`,
			[agentId, compartmentId],
			{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
		)) !== undefined;
	if (isDreamingScopeHalted(state, nowMs)) return { trigger: false };
	if (state.consecutiveFailures > 0) {
		const exp = Math.min(state.consecutiveFailures, MAX_FAILURE_BACKOFF_MULTIPLIER);
		const failedAt = state.lastFailureAt === null ? Number.NaN : utcTimestampMs(state.lastFailureAt);
		if (!Number.isFinite(failedAt) || nowMs - failedAt < FAILURE_BACKOFF_BASE_MS * 2 ** exp) return { trigger: false };
	}

	if (hasAttention) return { trigger: true, reason: "attention" };
	if (cfg.backfillOnFirstRun && state.lastPassAt === null) {
		return backlog.hasBacklog !== false ? { trigger: true, reason: "first-run" } : { trigger: false };
	}
	const consumptionTable = await ownerQueryOne<{ present: number }>(
		await getDbOwnerForAccessor(accessor),
		"dreaming.evidence.consumption-schema",
		"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'dreaming_evidence_consumption' LIMIT 1",
		[],
		{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
	);
	if (backlog.kind === "threshold-reached" || (backlog.kind === "exact" && backlog.tokens >= cfg.tokenThreshold)) {
		return { trigger: true, reason: "token-threshold" };
	}
	if (consumptionTable !== undefined && state.lastPassId !== null) {
		const reviewsTable = await ownerQueryOne<{ present: number }>(
			await getDbOwnerForAccessor(accessor),
			"dreaming.evidence.reviews-schema",
			"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'dreaming_evidence_reviews' LIMIT 1",
			[],
			{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
		);
		const reviewedPredicate =
			reviewsTable === undefined
				? ""
				: `AND NOT EXISTS (
					SELECT 1 FROM dreaming_evidence_reviews der
					WHERE der.agent_id = dreaming_evidence_consumption.agent_id
					  AND der.source_kind = dreaming_evidence_consumption.source_kind
					  AND der.source_id = dreaming_evidence_consumption.source_id
					  AND der.source_captured_at = dreaming_evidence_consumption.source_captured_at
					  AND der.source_entry_id = dreaming_evidence_consumption.source_entry_id
					  AND der.source_revision = dreaming_evidence_consumption.source_revision
				)`;
		const hasContinuation =
			(await ownerQueryOne<{ present: number }>(
				await getDbOwnerForAccessor(accessor),
				"dreaming.evidence.continuation",
				`SELECT 1 AS present
					 FROM dreaming_evidence_consumption
					 WHERE agent_id = ? AND pass_id = ?
					   AND delivered_offset > 0 AND delivered_offset < source_length
					   ${reviewedPredicate}
					 LIMIT 1`,
				[agentId, state.lastPassId],
				{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
			)) !== undefined;
		if (hasContinuation) return { trigger: true, reason: "continuation" };
	}
	const lastPassMs = state.lastPassAt === null ? Number.NaN : utcTimestampMs(state.lastPassAt);
	if (backlog.hasBacklog !== false && Number.isFinite(lastPassMs) && nowMs - lastPassMs >= cfg.maxInterval) {
		return { trigger: true, reason: "max-interval" };
	}
	return { trigger: false };
}
