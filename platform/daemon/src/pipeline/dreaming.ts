import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AccountingProvenance,
	DreamingConfig,
	IdentityContextFileEntry,
	LlmCacheRequestAccounting,
	LlmUsage,
} from "@signet/core";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import type {
	DbOwnerDreamingEpisodicBacklog,
	DbOwnerDreamingEpisodicBacklogExists,
	DbOwnerDreamingEpisodicBacklogProbe,
	DbOwnerDreamingEvidenceSource,
	DbOwnerDreamingHygieneAttention,
	DbOwnerDreamingPassFinalize,
	DbOwnerDreamingSurprisalAttention,
} from "../db-owner-protocol";
import {
	ownerDreamingEpisodicBacklog,
	ownerDreamingEpisodicBacklogExists,
	ownerDreamingEpisodicBacklogProbe,
	ownerDreamingHygieneAttention,
	ownerDreamingSurprisalAttention,
	ownerTransaction,
	ownerQueryAll,
	ownerQueryOne,
	ownerRunStatement,
	runOwnerJob,
	ownerChanges,
	type DbOwnerMaintenance,
} from "../db-owner-maintenance";
import { DbOwnerDeadlineError, DbOwnerDiedError } from "../db-owner-client";
import { DB_OWNER_MAX_WORK_UNITS } from "../db-owner-protocol";
import { getDbOwnerForAccessor, runDbOwnerDomainOperation } from "../db-owner-runtime";
import {
	EPISODIC_CAPTURED_AT_FLOOR,
	scanEpisodicSourceCandidates,
	type EpisodicCursor,
	type EpisodicSourceRecord,
	readEpisodicSource,
	readRecentEpisodicSources,
	searchEpisodicSources,
	timestampMillis,
	utcTimestampMs,
} from "../episodic-sources";
import { type GraphHygieneCaps, getDreamingHygieneCandidatesInDb } from "../knowledge-graph-hygiene";
import { logger } from "../logger";
import type { GraphWriteCaps } from "../ontology-proposals";
import { isPipelineTimeout, recordPipelineError } from "../pipeline-error";
import { normalizePipelineCause, recordPipelineOperation } from "../pipeline-operation";
import { getActiveTelemetry } from "../telemetry";
import { upsertThreadHead } from "../thread-heads";
import { createDreamingAgentTools } from "./dreaming-agent-tools";
import { enqueueDreamingAttentionInTx, getDreamingAttentionWorkloadDiagnostics } from "./dreaming-attention";
import type { DreamingToolCallTrace } from "./dreaming-capabilities";
import { DREAMING_CAPABILITY_IDS, dreamingEvidencePageChars, listDreamingAttention } from "./dreaming-capabilities";
import { readCuratedMemoryHead, type MemoryHeadCommitInput, type MemoryHeadCommitter } from "../memory-head";
import { commitCuratedMemoryHeadInDb, withContentPassWrites } from "../memory-head-owner";
import { renderDreamingEvidence, sanitizeTranscriptForDreaming } from "./dreaming-evidence";
import {
	deliveredOffsetForSource,
	evidenceContentSha256,
	failedOperationEvidence,
	recordDreamingEvidenceConsumptionInTx,
} from "./dreaming-evidence-consumption";
import {
	parseDreamingReviewedExcludedEvidence,
	recordDreamingReviewedExcludedEvidenceInTx,
} from "./dreaming-evidence-reviews";
import {
	type RejectedDreamingEvidence,
	collectRejectedDreamingEvidence,
	recordRejectedDreamingEvidenceInTx,
} from "./dreaming-evidence-retry";
import type { ApplyDreamingOperationsResult, DreamingOperationRequest } from "./dreaming-operations";
import {
	DREAMING_SURPRISAL_SELECTOR_VERSION,
	type DreamingSurprisalSelection,
	selectDreamingSurprisalInDb,
} from "./dreaming-surprisal";
import {
	type DreamingBacklogTokenEntry,
	countDreamingBacklogTokenEntries,
	beginDreamingEpisodicTokenBacklogMeasurement,
	invalidateDreamingEpisodicTokenBacklog,
	recordDreamingEpisodicTokenBacklog,
	refreshDreamingBacklogTokenCache,
} from "./dreaming-token-cache";
import {
	dreamingLiveEvents,
	publishDreamingAgentEvent,
	publishDreamingSessionInfo,
	publishDreamingToolTrace,
	type DreamingLiveEventHub,
} from "./dreaming-live-events";
import { countTokens } from "./tokenizer";
import { dreamingScopeKey, renderDreamingHistoryForPass } from "./dreaming-history";
import { detectLocalTimeZone } from "../memory-config";

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
): Promise<number> {
	const input: DbOwnerDreamingHygieneAttention = { agentId, limit, caps };
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
): Promise<DreamingSurprisalSelection | null> {
	const surprisal = cfg.surprisal;
	if (!surprisal?.enabled) return null;
	const input: DbOwnerDreamingSurprisalAttention = { agentId, config: surprisal };
	const options = { deadlineMs: 60_000, estimatedWorkUnits: 500 };
	const selection = ownerMaintenance
		? await ownerMaintenance.dreamingSurprisalAttention(input, options)
		: await runDbOwnerDomainOperation(accessor, {
				runWithOwner: async (owner) => await ownerDreamingSurprisalAttention(owner, input, options),
				runInline: ({ read, write }) => {
					const selected = read((db) => selectDreamingSurprisalInDb(db, input.agentId, input.config, null));
					if (selected.candidates.length === 0) return selected;
					write((db) => {
						for (const candidate of selected.candidates) {
							enqueueDreamingAttentionInTx(db, {
								agentId: input.agentId,
								kind: "surprisal",
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

function readDreamingState(db: ReadDb, agentId: string): DreamingState {
	let row:
		| {
				consecutive_failures: number;
				last_failure_at: string | null;
				last_pass_at: string | null;
				evidence_cursor: string | null;
				last_pass_id: string | null;
				last_pass_mode: string | null;
		  }
		| undefined;
	try {
		row = db
			.prepare(
				`SELECT consecutive_failures, last_failure_at,
				        last_pass_at, evidence_cursor, last_pass_id, last_pass_mode
				 FROM dreaming_state WHERE agent_id = ?`,
			)
			.get(agentId) as typeof row;
	} catch {
		row = undefined;
	}
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

export async function getDreamingState(accessor: DbAccessor, agentId: string): Promise<DreamingState> {
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
		 FROM dreaming_state WHERE agent_id = ?`,
		[agentId],
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
): void {
	const exists = db.prepare("SELECT 1 FROM dreaming_state WHERE agent_id = ?").get(agentId);
	if (exists) {
		db.prepare(
			`UPDATE dreaming_state
			 SET consecutive_failures = 0,
			     last_failure_at = NULL,
			     last_pass_at = ?,
			     evidence_cursor = ?,
			     last_pass_id = ?,
			     last_pass_mode = ?,
			     updated_at = datetime('now')
			 WHERE agent_id = ?`,
		).run(lastPassAt, evidenceCursor === null ? null : JSON.stringify(evidenceCursor), passId, mode, agentId);
	} else {
		db.prepare(
			`INSERT INTO dreaming_state
			 (agent_id, consecutive_failures, last_failure_at, last_pass_at, evidence_cursor, last_pass_id, last_pass_mode)
			 VALUES (?, 0, NULL, ?, ?, ?, ?)`,
		).run(agentId, lastPassAt, evidenceCursor === null ? null : JSON.stringify(evidenceCursor), passId, mode);
	}
}

export async function recordDreamingFailure(accessor: DbAccessor, agentId: string): Promise<void> {
	await ownerTransaction(
		await getDbOwnerForAccessor(accessor),
		"dreaming.state.record-failure",
		[
			ownerRunStatement(
				`INSERT INTO dreaming_state (agent_id, tokens_since_last_pass, consecutive_failures, last_failure_at)
				 VALUES (?, 0, 1, datetime('now'))
				 ON CONFLICT(agent_id) DO UPDATE SET
				 consecutive_failures = dreaming_state.consecutive_failures + 1,
				 last_failure_at = datetime('now'),
				 updated_at = datetime('now')`,
				[agentId],
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

export async function createDreamingPass(accessor: DbAccessor, agentId: string, mode: DreamingMode): Promise<string> {
	const id = randomUUID();
	await ownerTransaction(
		await getDbOwnerForAccessor(accessor),
		"dreaming.pass.create",
		[
			ownerRunStatement(
				`INSERT INTO dreaming_passes (id, agent_id, mode, status, started_at, created_at)
				 VALUES (?, ?, ?, 'running', strftime('%Y-%m-%d %H:%M:%f', 'now'), strftime('%Y-%m-%d %H:%M:%f', 'now'))`,
				[id, agentId, mode],
			),
		],
		{ deadlineMs: 10_000, estimatedWorkUnits: 1 },
	);
	dreamingLiveEvents.startPass({ passId: id, agentId, mode });
	return id;
}

export async function createDreamingPassThroughOwner(
	maintenance: DbOwnerMaintenance,
	agentId: string,
	mode: DreamingMode,
): Promise<string> {
	const id = randomUUID();
	const request = {
		kind: "query" as const,
		statement: {
			sql: `INSERT INTO dreaming_passes (id, agent_id, mode, status, started_at, created_at)
			 VALUES (?, ?, ?, 'running', strftime('%Y-%m-%d %H:%M:%f', 'now'), strftime('%Y-%m-%d %H:%M:%f', 'now'))
			 ON CONFLICT(id) DO NOTHING`,
			params: [id, agentId, mode],
			result: "run" as const,
		},
	};
	let creationMayHaveCommitted = false;
	for (;;) {
		try {
			await runOwnerJob<{ readonly changes: number }>(
				maintenance.owner,
				request,
				"dreaming.pass.create",
				"maintenance",
				{ deadlineMs: 10_000, estimatedWorkUnits: 1, waitForOwnerCompletionOnDeadline: true },
			);
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

export async function getDreamingPasses(
	accessor: DbAccessor,
	agentId: string,
	limit = 10,
): Promise<readonly DreamingPassRow[]> {
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
		        summary, error
		 FROM dreaming_passes
		 WHERE agent_id = ?
		 ORDER BY created_at DESC
		 LIMIT ?`,
		[agentId, limit],
		{ deadlineMs: 30_000, estimatedWorkUnits: Math.max(1, Math.min(limit, 100)) },
	);
}

export interface DreamingPassScope extends DreamingPassRow {
	readonly agentId: string;
}

interface DreamingPassReadOptions {
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
				summary, error
			 FROM dreaming_passes`;
}

export async function getDreamingPass(
	accessor: DbAccessor,
	agentId: string,
	passId: string,
	options: DreamingPassReadOptions = {},
): Promise<DreamingPassScope | null> {
	return (
		(await ownerQueryOne<DreamingPassScope>(
			await getDbOwnerForAccessor(accessor),
			"dreaming.pass.read",
			`${dreamingPassSelect(true)} WHERE agent_id = ? AND id = ? LIMIT 1`,
			[agentId, passId],
			{ deadlineMs: 30_000, estimatedWorkUnits: 1, signal: options.signal },
		)) ?? null
	);
}

export async function getActiveDreamingPasses(
	accessor: DbAccessor,
	agentId: string,
	options: DreamingPassReadOptions = {},
): Promise<readonly DreamingPassScope[]> {
	return await ownerQueryAll<DreamingPassScope>(
		await getDbOwnerForAccessor(accessor),
		"dreaming.passes.active",
		`${dreamingPassSelect(true)} WHERE agent_id = ? AND status = 'running' ORDER BY started_at ASC, id ASC`,
		[agentId],
		{ deadlineMs: 30_000, estimatedWorkUnits: 10, signal: options.signal },
	);
}

const DREAMING_CODEMODE_PROMPT =
	"Lookups (search_entities, get_entity, list_aspect_claims, validate_proposal, attention_list, zoom_history) are available only inside the codemode tool. Batch the lookups a page needs into one script: call them through tools.<name>(args), parse each JSON result, and print only what you need, carrying ids from results instead of retyping them. Reading evidence (search_evidence) and every write (apply_ontology_ops, runbook_write, memory_head_commit) stay direct tool calls; a script cannot call them.";

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
				 (id, agent_id, pass_id, sequence, tool_call_id, tool_name, input_json, output_json, success, latency_ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
): Promise<readonly DreamingToolCall[]> {
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
		`SELECT id, pass_id AS passId, sequence, tool_call_id AS toolCallId,
		        tool_name AS toolName, input_json AS inputJson, output_json AS outputJson,
		        success, latency_ms AS latencyMs, created_at AS createdAt
		 FROM dreaming_tool_calls
		 WHERE agent_id = ? AND pass_id = ?
		 ORDER BY sequence ASC`,
		[agentId, passId],
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
): Promise<readonly DreamingEvidenceExclusion[]> {
	return await ownerQueryAll<DreamingEvidenceExclusion>(
		await getDbOwnerForAccessor(accessor),
		"dreaming.evidence-exclusions.list",
		`SELECT source_kind AS sourceKind, source_id AS sourceId, reason,
		        failure_class AS failureClass, source_fingerprint AS sourceFingerprint,
		        retry_count AS retryCount, last_requeued_at AS lastRequeuedAt,
		        pass_id AS passId, excluded_at AS excludedAt,
		        requeue_requested_at AS requeueRequestedAt, resolved_at AS resolvedAt
		 FROM dreaming_evidence_exclusions
		 WHERE agent_id = ? AND resolved_at IS NULL
		 ORDER BY excluded_at DESC, source_kind ASC, source_id ASC`,
		[agentId],
		{ deadlineMs: 30_000, estimatedWorkUnits: 10 },
	);
}

export async function requestDreamingEvidenceRequeue(
	accessor: DbAccessor,
	agentId: string,
	sourceKind: EpisodicSourceRecord["kind"],
	sourceId: string,
): Promise<boolean> {
	const attentionId = randomUUID();
	const result = await ownerTransaction(
		await getDbOwnerForAccessor(accessor),
		"dreaming.evidence-requeue.request",
		[
			ownerRunStatement(
				`UPDATE dreaming_evidence_exclusions
				 SET requeue_requested_at = datetime('now')
				 WHERE agent_id = ? AND source_kind = ? AND source_id = ? AND resolved_at IS NULL`,
				[agentId, sourceKind, sourceId],
			),
			ownerRunStatement(
				`INSERT INTO dreaming_attention
				 (id, agent_id, kind, subject_ref, details_json, priority)
				 SELECT ?, ?, 'evidence_requeue', ?, ?, ?
				 WHERE EXISTS (
				   SELECT 1 FROM dreaming_evidence_exclusions
				   WHERE agent_id = ? AND source_kind = ? AND source_id = ? AND resolved_at IS NULL
				 )
				 ON CONFLICT(agent_id, kind, subject_ref) DO UPDATE SET
				   details_json = excluded.details_json,
				   priority = MAX(dreaming_attention.priority, excluded.priority),
				   resolved_at = NULL,
				   resolved_by_pass_id = NULL`,
				[
					attentionId,
					agentId,
					`${sourceKind}:${sourceId}`,
					JSON.stringify({ sourceKind, sourceId }),
					80,
					agentId,
					sourceKind,
					sourceId,
				],
			),
		],
		{ deadlineMs: 30_000, estimatedWorkUnits: 2 },
	);
	return ownerChanges(result[0]) > 0;
}

function _fetchEpisodicEvidence(
	db: ReadDb,
	agentId: string,
	since: string | null,
	limit: number,
	cursor: EpisodicCursor | null,
): readonly EpisodicSourceRecord[] {
	const sources = readRecentEpisodicSources(db, agentId, limit, DREAMING_EVIDENCE_KINDS, since, "oldest", cursor);
	if (!cursor?.fragmentOffset || cursor.kind === null) return sources;
	const resumed = readEpisodicSource(db, { agentId, from: `${cursor.kind}:${cursor.id}` });
	if (!resumed) return sources;
	return [resumed, ...sources.filter((source) => source.kind !== resumed.kind || source.id !== resumed.id)].slice(
		0,
		limit,
	);
}

function _readIdentityFile(
	dir: string,
	entry: IdentityContextFileEntry,
): { readonly content: string; readonly unreadable: boolean } {
	const path = join(dir, entry.path);
	if (!existsSync(path)) return { content: "", unreadable: false };
	try {
		const raw = readFileSync(path, "utf-8").trim();
		if (!raw) return { content: "", unreadable: false };
		const budget = entry.budget ?? 4_000;
		return {
			content: raw.length <= budget ? raw : `${raw.slice(0, budget)}\n[truncated]`,
			unreadable: false,
		};
	} catch (err) {
		logger.warn("dreaming", "Could not read identity file", { name: entry.path, error: String(err) });
		return { content: "", unreadable: true };
	}
}
export const DREAMING_AGENT_PROMPT = `You are a bounded Signet maintenance agent. Your task is to maintain durable, evidence-cited semantic understanding as the relevant entities, relationships, and claims change over time. Attach each claim to its entity and aspect rather than allowing it to exist as standalone.

## Process

Purpose: maintain durable, evidence-cited semantic understanding in the knowledge graph. The graph is a derived structure; every write carries provenance (an attention id for hygiene, an exact quote from episodic evidence for content). Use the pass history (shown below, zoom_history for detail) as the dedup source: the previous pass's viewed sources and changes are the cutoff.

An install may have several agent scopes (listed in <agent_scopes> when there is more than one): the scoped tools take an agentId, so address any scope you need — each write is attributed to the agent you name. attention_list without an agentId lists the whole install's attention queue, with each record carrying its owning agentId.

### State targets

- Hygiene queue: dreaming_attention pending records (kind=hygiene)
- Exploration hints: bounded embedding-surprisal records (kind=surprisal); these are not evidence
- Graph: entities, aspects, claims, links (active/archived/pinned)
- Evidence: episodic store (memories, artifacts, completed transcripts)
- Pass history: one line per earlier pass, coarser for older passes, each openable with zoom_history down to the pass's runbook note

### Per-pass process

1. Read the pass history below. Establish cutoff: sources viewed, changes applied, deferred items. Zoom (zoom_history) into any line that mentions work you are about to repeat, resume, or re-defer before acting on it.
2. Work the pending hygiene records listed in <pending_attention>. Process ALL of them first, before any content work:
   - Inspect the flagged target (get_entity — check aspects, claims, pinned).
   - Archive or merge it, citing its attention id (provenance: "attention:<uuid>", or attention:$<index> for a flag you minted in the same batch).
   - \`attribute_over_cap\` / \`aspect_over_cap\` flags: the write gate rejects new claims or aspects past the cap, so consolidate the flagged target — merge_aspects to fold over-cap aspects together, supersede_claim_value to collapse duplicate claim keys, archive_claim_value for stale snapshots. Consolidation (merge_aspects) may exceed the attribute cap; it is the remedy the cap forces.
   - If you discover junk the queue did not flag, mint a flag op and archive in the same batch.
   - If you inspect a flagged target and judge it should stay as it is (a deliberate keep — e.g. a live entity with a non-concrete type, or an over-cap aspect you chose not to consolidate), close the record with decline_attention citing its attention id. Declining is an affirmative judgment: only decline records you actually inspected, and never decline records you could not complete this pass — defer those with a named blocker instead.
3. Take the surprisal hints listed in <pending_attention>. These are bounded exploration hints, not evidence and not hygiene provenance. For each hint, inspect its memory:<id> subjectRef with search_evidence in the owning scope. Treat the score only as a priority signal: if the source establishes a useful, settled fact, use a normal content operation with an exact quote; if it is valid but not useful or is noise, use decline_attention after inspecting it. Never create a claim or entity from the score alone, and never cite attention:<id> for a content operation. A surprisal hint must not bypass the evidence cursor or audited apply path.
4. Take the review_due records listed in <pending_attention>. For expired records, inspect the cited memory with search_evidence using its subjectRef, then supersede the matching active claim with supersede_claim_value. Use the supplied entityId, aspectId, attributeId, and claimKey when present. The replacement must state that the planned event remains unconfirmed; never rewrite it as if the event happened. Cite an exact quote from the original memory. Do not supersede approaching records. When creating or setting a future temporal claim, set payload.reviewAfter to the referenced ISO timestamp. Then take the contested_claim records with reason source_changed: the claim's source was edited after the claim was filed. Read the source's current text with search_evidence using details.sourceRef. If it still states the claim, close the record with decline_attention. If it states a different value, supersede the claim with supersede_claim_value citing an exact quote from the current text, then close the record with decline_attention. If it no longer states the claim, archive it with archive_claim_value and provenance attention:<id>. For reason source_removed the source no longer exists: archive the claim the same way unless search_evidence finds other evidence that still states it, in which case close the record with decline_attention.
5. Only when the hygiene queue is clear: find new evidence since the cutoff. Read unprocessed evidence one page at a time with search_evidence — omit the query, since, and before to take the next page of the durable delivery queue. A page holds one excerpt per source; a source with contentHasNext continues by itself on a later page, so do not page through queued sources with sourceRef and offset. File what each page establishes (or mark a source you have read in full as reviewed or deferred) before asking for the next page, so the work is kept if the pass runs out of time; stop when hasMore is false or the queue reports deliveryClosed. Use a query or sourceRef only to look up specific history or verify a citation. Prefer evidence from completed transcript sessions; historical summary rows are not part of the default delivery path. A transcript with completed: false is mid-stream — defer filing from it with the named blocker "transcript still mid-stream" (re-check completed each pass: a session still active when re-checked is a re-verified blocker, not a repeated one), and note the deferral in the pass log, because its states may be contradicted by the session's end. For each new source:
   - search_entities for subjects it establishes.
   - File claims only for what the source establishes as settled fact: outcomes, decisions, shipped changes, stable behavior. Do not file instructions that were merely suggested, hypotheses or diagnoses, open questions, or intermediate states of an ongoing investigation. When a source shows an attempt and its outcome, file the outcome.
   - A concrete deliverable the assistant produced for the user's own project, plan, or situation (a budget, schedule, draft, plan, or specific recommendation the user asked for) is a durable fact about that project: file its specifics as a claim on the project, worded as proposed or drafted rather than confirmed. Generic information not tied to the user's own circumstances is not. Work the user asks for on behalf of their own job, business, employer, trip, or event is their own situation.
   - When the user asks for advice, the advice is not a durable fact, but what the user discloses about themselves to get it is: their situation, constraints, habits, preferences, and how they feel about them (for example, that they work from home and miss socializing with colleagues). File those as claims about the user even when the conversation reaches no decision.
   - For every source, do this before deciding it has nothing to file: list each statement the user makes about themselves — something they own, bought, did, attended, plan, like or dislike, a person or pet in their life, a place, a date, an amount, or a count. Each one is a claim to file about the user, quoted exactly. A conversation that is mostly generic advice still has these statements; file them and skip only the advice. A source with even one such statement is never excluded.
   - The user is a person entity. Use the user's name when the source states it; otherwise use the entity named "User". Search for it first and reuse it. When a source shows several named speakers, such as a group chat or messages with authors, file each speaker's statements on that speaker's own person entity, and never file a named speaker's statements on "User".
   - An excerpt that continues on a later page (contentHasNext) is not a reason to defer: file what this excerpt establishes now, and the rest arrives on a later page.
   - Filing about a subject that does not exist yet takes three apply_ontology_ops calls in order: create_entity, then create_aspect with the returned entity id, then add_claim_value with the entity and aspect ids, putting every claim for that aspect in the one call. Do all three in this pass. A missing entity or aspect, or a claim you have not checked yet, is work to do now, never a blocker.
   - Copy each sourceRef character for character from the search_evidence result.
   - The only valid reasons to defer a source are a transcript that is still mid-stream and a tool error you could not fix after correcting the call.
   - Bias toward action and carry each source to completion within this pass: filed claims, a reviewed exclusion, or one of those deferrals. Never end a pass with work you could have done, and never stop at describing what should be filed. If your pass log would say a fact was found but not filed, file it before writing the log.
   - If you inspect an entire source revision and it contains no durable fact, no self-disclosure by the user, and no deliverable produced for the user's own situation, add it to reviewedExcludedEvidence with the owning agentId, sourceRef, and a specific reason. The agentId must be the scope used for search_evidence. This is terminal for that immutable revision; do not use it for a temporary blocker, which belongs in deferredEvidence.
   - File one fact per claim, and keep every date, amount, count, and name the source gives for it. Never combine two facts into one claim: two projects with different start dates are two claims, each with its own date.
   - Say what each named thing is when a claim names it: "listens to music on Spotify, their music streaming service", "keeps their savings at Monzo, their bank", "saw The 1975, a band, live". People later ask by kind ("which streaming service", "what bank"), and a claim that only names the thing cannot be found that way.
   - Resolve every relative time ("yesterday", "last weekend", "three weeks ago", "next month") against the source's capturedAt and write the absolute date in the claim ("On 2023-03-19 the user completed the Walk for Hunger"). Then set the claim's time: occurredAt for an event, validFrom (and validUntil once it ends) for a state that holds over time, with timePrecision (day, week, month, year, or approximate). A vague time with no anchor ("recently") stays as written and gets no time fields. Dates and states belong in claims, never in entity names: name an entity for what it is ("Universal Studios Hollywood trip"), not when or how it stood ("trip (planned as of 2023-05-30)"), so later passes find it again under the same name. The same holds for claim keys: a key names the attribute ("instagram_followers", "house_budget"), never its value or date ("instagram_followers_1300", "lentil-soup-plan-2023-05-22"), so a later value for the same attribute lands in the same slot and supersedes the old one.
   - A claim must be a complete statement: it names the subject and the fact about it. A bare label ("SHIP-WITH-FIXES"), a fragment ("Root cause confirmed."), or an implementation detail without its subject is not a claim — do not file it.
   - Before adding a claim, check the target aspect's existing claims; if one covers the same key or is contradicted by the new evidence, supersede it (supersede_claim_value) instead of adding alongside.
   - Attach before you add: file a claim under an existing aspect that covers its domain rather than creating a new aspect. When an entity is at its aspect cap, restructure in this pass instead of stopping or deferring: merge overlapping aspects (merge_aspects) or rename one to cover both (rename_aspect), each with a reason, then file the claim.
   - The evidence source and the graph target must use the same agent scope: search evidence with the agentId of the entity you will update, then pass that same agentId to apply_ontology_ops. A source found in another scope cannot support a write here.
   - create_entity only for durable subjects clearly established by the source.
   - When the evidence supports a possible relationship, merge, or other ontology change but the relationship is ambiguous rather than settled, do not apply it immediately. Emit the normal ontology operation with risk: "review_required". Its reason must be a concise, human-readable explanation that names the entities and the proposed relationship; the exact evidence citation remains required. The daemon will place it in the user's review queue for confirmation, not treat the queue as a work-deferral mechanism.
   - Validate before writing (validate_proposal).
6. Write the pass log (runbook_write) last. Its summary is read back by a human who did not watch the pass: write a specific entity-named change manifest, not process narration. Use Markdown, max 2000 chars, with these sections when applicable: ## Updated, ## Created, ## Deferred, ## No-op. Under every section, each line must name the entity or entity id, state the exact change (claim filed or superseded, aspect touched, entity/aspect/link archived or merged, or why no change was needed), and cite the source or provenance reference (memory, artifact, or transcript as kind:id; hygiene attention:<id>). Deferred and No-op lines must state the specific blocker or reason; never use generic categories such as "content-related" or "ongoing structural process". Omit empty sections. Put the same deferred items and open questions in the runbook's deferred and openQuestions fields.

### What counts as durable

A write is durable when the source establishes it as settled fact: an outcome, a decision, a shipped change, or a stable behavior, attached to the entity and aspect it belongs to. A concrete deliverable produced for the user's own project or situation is durable too, recorded as proposed rather than confirmed. An entity is removable when it is non-concrete (zero active aspects/claims, non-concrete type, legacy-only deps) or an exact-canonical duplicate (same canonical name, same scope). Trust your judgment beyond that.

### Must not

- You may not archive an entity that has active aspects or claims.
- You may not merge entities across agent scopes.
- You may not write without provenance: hygiene ops need an attention id; content ops need an exact quote.
- You may not file a claim without an exact quote, or a relationship the source does not state.
- You may not touch pinned entities, source-root entities, or topology entities.
- You may not rewrite an existing claim without evidence that supersedes it.
- You may not rename an entity or aspect without evidence that establishes the new name.
- You may not defer without a named blocker, and not the same blocker twice in a row.

### Done

The pass is done when:

- Every pending hygiene record is resolved: archived, merged, or declined after inspection — or deferred with a named blocker (not the same blocker twice in a row).
- Deferred records stay pending: deferral is not a close — the record is re-examined next pass.
- Every claim filed is a complete statement attached to an entity and aspect — no bare labels or fragments.
- Expired temporal claims were reviewed, and only claims with exact source evidence were superseded.
- Every write in the batch has valid provenance.
- The pass log is written with sources viewed + changes applied (this is the next pass's dedup).
- No flag is left unresolved for a target you archived; no writes attempted against pinned or source-root entities.
`;
export const DREAMING_HYGIENE_AGENT_PROMPT = `You are a bounded Signet maintenance agent. Your task is to maintain durable, evidence-cited semantic understanding as the relevant entities, relationships, and claims change over time. Attach each claim to its entity and aspect rather than allowing it to exist as standalone.

## Process

Purpose: maintain durable, evidence-cited semantic understanding in the knowledge graph. This is a HYGIENE pass: process the attention queue — inspect flagged targets and archive or merge them with attention provenance, minting flags for junk the queue missed. Content maintenance (claims, entities) belongs to content passes, which cite exact quotes from episodic evidence. Use the pass history (shown below, zoom_history for detail) as the dedup source: the previous pass's changes are the cutoff.

An install may have several agent scopes (listed in <agent_scopes> when there is more than one): the scoped tools take an agentId, so address any scope you need — each write is attributed to the agent you name. attention_list without an agentId lists the whole install's attention queue, with each record carrying its owning agentId.

### State targets

- Hygiene queue: dreaming_attention pending records (kind=hygiene)
- Graph: entities, aspects, claims, links (active/archived/pinned)
- Pass history: one line per earlier pass, coarser for older passes, each openable with zoom_history down to the pass's runbook note

### Per-pass process

1. Read the pass history below. Establish cutoff: sources viewed, changes applied, deferred items. Zoom (zoom_history) into any line that mentions work you are about to repeat, resume, or re-defer before acting on it.
2. Work the pending hygiene records listed in <pending_attention>. Process ALL of them:
   - Inspect the flagged target (get_entity — check aspects, claims, pinned).
   - Archive or merge it, citing its attention id (provenance: "attention:<uuid>", or attention:$<index> for a flag you minted in the same batch).
   - If you discover junk the queue did not flag, mint a flag op and archive in the same batch.
   - If you inspect a flagged target and judge it should stay as it is (a deliberate keep — e.g. a live entity with a non-concrete type, or an over-cap aspect you chose not to consolidate), close the record with decline_attention citing its attention id. Declining is an affirmative judgment: only decline records you actually inspected, and never decline records you could not complete this pass — defer those with a named blocker instead.
   - Leave kind=surprisal records pending. They are content-pass exploration hints and must be inspected with exact evidence by a content pass.
3. Write the pass log (runbook_write) last. Its summary is read back by a human who did not watch the pass: write a specific entity-named change manifest, not process narration. Use Markdown, max 2000 chars, with these sections when applicable: ## Updated, ## Created, ## Deferred, ## No-op. Under every section, each line must name the entity or entity id, state the exact change (claim filed or superseded, aspect touched, entity/aspect/link archived or merged, or why no change was needed), and cite the source or provenance reference (memory, artifact, or transcript as kind:id; hygiene attention:<id>). Deferred and No-op lines must state the specific blocker or reason; never use generic categories such as "content-related" or "ongoing structural process". Omit empty sections. Put the same deferred items and open questions in the runbook's deferred and openQuestions fields.

### What counts as durable

An entity is removable when it is non-concrete (zero active aspects/claims, non-concrete type, legacy-only deps) or an exact-canonical duplicate (same canonical name, same scope). Trust your judgment beyond that.

### Must not

- You may not archive an entity that has active aspects or claims.
- You may not merge entities across agent scopes.
- You may not write without provenance: hygiene ops need an attention id.
- You may not make content writes: claims and entities need exact-quote citations from episodic evidence and belong to content passes.
- You may not touch pinned entities, source-root entities, or topology entities.
- You may not defer without a named blocker, and not the same blocker twice in a row.

### Done

The pass is done when:

- Every pending hygiene record is resolved: archived, merged, or declined after inspection — or deferred with a named blocker (not the same blocker twice in a row).
- Deferred records stay pending: deferral is not a close — the record is re-examined next pass.
- Every write in the batch carries attention provenance.
- The pass log is written with changes applied (this is the next pass's dedup).
- No flag is left unresolved for a target you archived; no writes attempted against pinned or source-root entities.
`;
export const DREAMING_CONTENT_AGENT_PROMPT = `You are a bounded Signet maintenance agent. Your task is to maintain durable, evidence-cited semantic understanding as the relevant entities, relationships, and claims change over time. Attach each claim to its entity and aspect rather than allowing it to exist as standalone.

## Process

Purpose: maintain durable, evidence-cited semantic understanding in the knowledge graph. This is a CONTENT pass: process review work, inspect bounded surprisal hints, and find new evidence since the cutoff; extract/update claims with exact-quote citations and create entities only for durable subjects. Hygiene archives/merges belong to hygiene passes, which process structural attention. Use the pass history (shown below, zoom_history for detail) as the dedup source: the previous pass's viewed sources and changes are the cutoff.

An install may have several agent scopes (listed in <agent_scopes> when there is more than one): the scoped tools take an agentId, so address any scope you need — each write is attributed to the agent you name. attention_list without an agentId lists the whole install's attention queue, with each record carrying its owning agentId.

### State targets

- Exploration hints: bounded embedding-surprisal records (kind=surprisal); these are not evidence
- Graph: entities, aspects, claims, links (active/archived/pinned)
- Evidence: episodic store (memories, artifacts, completed transcripts)
- Pass history: one line per earlier pass, coarser for older passes, each openable with zoom_history down to the pass's runbook note

### Per-pass process

1. Read the pass history below. Establish cutoff: sources viewed, changes applied, deferred items. Zoom (zoom_history) into any line that mentions work you are about to repeat, resume, or re-defer before acting on it.
2. Take the review_due records listed in <pending_attention>. For expired records, inspect the cited memory with search_evidence using its subjectRef, then supersede the matching active claim with supersede_claim_value. Use the supplied entityId, aspectId, attributeId, and claimKey when present. The replacement must state that the planned event remains unconfirmed; never rewrite it as if the event happened. Cite an exact quote from the original memory. Do not supersede approaching records. When creating or setting a future temporal claim, set payload.reviewAfter to the referenced ISO timestamp. Then take the contested_claim records with reason source_changed: the claim's source was edited after the claim was filed. Read the source's current text with search_evidence using details.sourceRef. If it still states the claim, close the record with decline_attention. If it states a different value, supersede the claim with supersede_claim_value citing an exact quote from the current text, then close the record with decline_attention. If it no longer states the claim, archive it with archive_claim_value and provenance attention:<id>. For reason source_removed the source no longer exists: archive the claim the same way unless search_evidence finds other evidence that still states it, in which case close the record with decline_attention.
3. Take the surprisal hints listed in <pending_attention>. These are bounded exploration hints, not evidence and not hygiene provenance. Inspect each hint's memory:<id> subjectRef with search_evidence in the owning scope. If the source establishes a useful settled fact, use a normal content operation with an exact quote; otherwise decline_attention after inspection. Never create a claim or entity from the score alone, and never cite attention:<id> for a content operation.
4. Find new evidence since the cutoff. Read unprocessed evidence one page at a time with search_evidence — omit the query, since, and before to take the next page of the durable delivery queue. A page holds one excerpt per source; a source with contentHasNext continues by itself on a later page, so do not page through queued sources with sourceRef and offset. File what each page establishes (or mark a source you have read in full as reviewed or deferred) before asking for the next page, so the work is kept if the pass runs out of time; stop when hasMore is false or the queue reports deliveryClosed. Use a query or sourceRef only to look up specific history or verify a citation. Prefer evidence from completed transcript sessions; historical summary rows are not part of the default delivery path. A transcript with completed: false is mid-stream — defer filing from it with the named blocker "transcript still mid-stream" (re-check completed each pass: a session still active when re-checked is a re-verified blocker, not a repeated one), and note the deferral in the pass log, because its states may be contradicted by the session's end. For each new source:
   - search_entities for subjects it establishes.
   - File claims only for what the source establishes as settled fact: outcomes, decisions, shipped changes, stable behavior. Do not file instructions that were merely suggested, hypotheses or diagnoses, open questions, or intermediate states of an ongoing investigation. When a source shows an attempt and its outcome, file the outcome.
   - A concrete deliverable the assistant produced for the user's own project, plan, or situation (a budget, schedule, draft, plan, or specific recommendation the user asked for) is a durable fact about that project: file its specifics as a claim on the project, worded as proposed or drafted rather than confirmed. Generic information not tied to the user's own circumstances is not. Work the user asks for on behalf of their own job, business, employer, trip, or event is their own situation.
   - When the user asks for advice, the advice is not a durable fact, but what the user discloses about themselves to get it is: their situation, constraints, habits, preferences, and how they feel about them (for example, that they work from home and miss socializing with colleagues). File those as claims about the user even when the conversation reaches no decision.
   - For every source, do this before deciding it has nothing to file: list each statement the user makes about themselves — something they own, bought, did, attended, plan, like or dislike, a person or pet in their life, a place, a date, an amount, or a count. Each one is a claim to file about the user, quoted exactly. A conversation that is mostly generic advice still has these statements; file them and skip only the advice. A source with even one such statement is never excluded.
   - The user is a person entity. Use the user's name when the source states it; otherwise use the entity named "User". Search for it first and reuse it. When a source shows several named speakers, such as a group chat or messages with authors, file each speaker's statements on that speaker's own person entity, and never file a named speaker's statements on "User".
   - An excerpt that continues on a later page (contentHasNext) is not a reason to defer: file what this excerpt establishes now, and the rest arrives on a later page.
   - Filing about a subject that does not exist yet takes three apply_ontology_ops calls in order: create_entity, then create_aspect with the returned entity id, then add_claim_value with the entity and aspect ids, putting every claim for that aspect in the one call. Do all three in this pass. A missing entity or aspect, or a claim you have not checked yet, is work to do now, never a blocker.
   - Copy each sourceRef character for character from the search_evidence result.
   - The only valid reasons to defer a source are a transcript that is still mid-stream and a tool error you could not fix after correcting the call.
   - Bias toward action and carry each source to completion within this pass: filed claims, a reviewed exclusion, or one of those deferrals. Never end a pass with work you could have done, and never stop at describing what should be filed. If your pass log would say a fact was found but not filed, file it before writing the log.
   - If you inspect an entire source revision and it contains no durable fact, no self-disclosure by the user, and no deliverable produced for the user's own situation, add it to reviewedExcludedEvidence with the owning agentId, sourceRef, and a specific reason. The agentId must be the scope used for search_evidence. This is terminal for that immutable revision; do not use it for a temporary blocker, which belongs in deferredEvidence.
   - File one fact per claim, and keep every date, amount, count, and name the source gives for it. Never combine two facts into one claim: two projects with different start dates are two claims, each with its own date.
   - Say what each named thing is when a claim names it: "listens to music on Spotify, their music streaming service", "keeps their savings at Monzo, their bank", "saw The 1975, a band, live". People later ask by kind ("which streaming service", "what bank"), and a claim that only names the thing cannot be found that way.
   - Resolve every relative time ("yesterday", "last weekend", "three weeks ago", "next month") against the source's capturedAt and write the absolute date in the claim ("On 2023-03-19 the user completed the Walk for Hunger"). Then set the claim's time: occurredAt for an event, validFrom (and validUntil once it ends) for a state that holds over time, with timePrecision (day, week, month, year, or approximate). A vague time with no anchor ("recently") stays as written and gets no time fields. Dates and states belong in claims, never in entity names: name an entity for what it is ("Universal Studios Hollywood trip"), not when or how it stood ("trip (planned as of 2023-05-30)"), so later passes find it again under the same name. The same holds for claim keys: a key names the attribute ("instagram_followers", "house_budget"), never its value or date ("instagram_followers_1300", "lentil-soup-plan-2023-05-22"), so a later value for the same attribute lands in the same slot and supersedes the old one.
   - A claim must be a complete statement: it names the subject and the fact about it. A bare label ("SHIP-WITH-FIXES"), a fragment ("Root cause confirmed."), or an implementation detail without its subject is not a claim — do not file it.
   - Before adding a claim, check the target aspect's existing claims; if one covers the same key or is contradicted by the new evidence, supersede it (supersede_claim_value) instead of adding alongside.
   - Attach before you add: file a claim under an existing aspect that covers its domain rather than creating a new aspect. When an entity is at its aspect cap, restructure in this pass instead of stopping or deferring: merge overlapping aspects (merge_aspects) or rename one to cover both (rename_aspect), each with a reason, then file the claim.
   - The evidence source and the graph target must use the same agent scope: search evidence with the agentId of the entity you will update, then pass that same agentId to apply_ontology_ops. A source found in another scope cannot support a write here.
   - create_entity only for durable subjects clearly established by the source.
   - When the evidence supports a possible relationship, merge, or other ontology change but the relationship is ambiguous rather than settled, do not apply it immediately. Emit the normal ontology operation with risk: "review_required". Its reason must be a concise, human-readable explanation that names the entities and the proposed relationship; the exact evidence citation remains required. The daemon will place it in the user's review queue for confirmation, not treat the queue as a work-deferral mechanism.
   - Validate before writing (validate_proposal).
5. Update MEMORY.md: call memory_head_read; its committedEntries are the last published entries whose support still holds, with that support, returned even when your own writes left the head stale. Then call memory_head_commit exactly once with the complete set of entries to retain, each with exact source/quote support. The pass cannot finish without this commit, even when nothing changed: resubmit the committedEntries, or submit an empty entry set only if committedEntries is empty and nothing durable qualifies yet, which clears the head.
6. Write the pass log (runbook_write) last. Its summary is read back by a human who did not watch the pass: write a specific entity-named change manifest, not process narration. Use Markdown, max 2000 chars, with these sections when applicable: ## Updated, ## Created, ## Deferred, ## No-op. Under every section, each line must name the entity or entity id, state the exact change (claim filed or superseded, aspect touched, entity/aspect/link archived or merged, or why no change was needed), and cite the source or provenance reference (memory, artifact, or transcript as kind:id; hygiene attention:<id>). Deferred and No-op lines must state the specific blocker or reason; never use generic categories such as "content-related" or "ongoing structural process". Omit empty sections. Put the same deferred items and open questions in the runbook's deferred and openQuestions fields.

### What counts as durable

A write is durable when the source establishes it as settled fact: an outcome, a decision, a shipped change, or a stable behavior, attached to the entity and aspect it belongs to. A concrete deliverable produced for the user's own project or situation is durable too, recorded as proposed rather than confirmed. Trust your judgment beyond that.

### Must not

- You may not write without provenance: content ops need an exact quote.
- You may not file a claim without an exact quote, or a relationship the source does not state.
- You may not make hygiene writes: archives and merges need attention records, which hygiene passes process. The one exception is archive_claim_value for a contested_claim record.
- You may not touch pinned entities, source-root entities, or topology entities.
- You may not rewrite an existing claim without evidence that supersedes it.
- You may not rename an entity or aspect without evidence that establishes the new name.
- You may not defer without a named blocker, and not the same blocker twice in a row.

### Done

The pass is done when:

- Every claim filed is a complete statement attached to an entity and aspect — no bare labels or fragments.
- Deferred records stay pending: deferral is not a close — the source is re-examined next pass.
- Every write in the batch cites an exact quote from episodic evidence in the same agent scope as the graph target.
- Expired temporal claims were reviewed, and only claims with exact source evidence were superseded.
- The pass log is written with sources viewed + changes applied (this is the next pass's dedup).
- No writes attempted against pinned or source-root entities.
`;
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
): Promise<string> {
	const focus = dreamingFocusOfMode(mode) ?? "all";
	const lines: string[] = [];
	for (const scope of scopes) {
		for (const kind of ATTENTION_KINDS_BY_FOCUS[focus]) {
			const items = await listDreamingAttention(accessor, {
				agentId: scope,
				kind,
				status: "pending",
				limit: ATTENTION_ITEMS_PER_KIND + 1,
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

export function dreamingPromptForMode(mode: DreamingMode): string {
	if (mode === "incremental-hygiene") return DREAMING_HYGIENE_AGENT_PROMPT;
	if (mode === "incremental-content") return DREAMING_CONTENT_AGENT_PROMPT;
	return DREAMING_AGENT_PROMPT;
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

export async function runDreamingAgentPass(
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
	for (const scope of scopes) invalidateDreamingEpisodicTokenBacklog(scope);
	const passId =
		existingPassId ??
		(await (ownerMaintenance
			? createDreamingPassThroughOwner(ownerMaintenance, agentId, mode)
			: createDreamingPass(accessor, agentId, mode)));
	const live = liveOptions?.hub ?? dreamingLiveEvents;
	live.startPass({ passId, agentId, mode });
	live.publish(passId, "lifecycle", { phase: "preparing", mode });
	const passStartedAtMs = Date.now();
	const effects = createDreamingPassEffectState();
	let toolCallSequence = 0;
	let applied = 0;
	let failed = 0;
	try {
		const basePrompt =
			scopes.length > 1
				? `${dreamingPromptForMode(mode)}\n\n<agent_scopes>\n${scopes.join("\n")}\n</agent_scopes>`
				: dreamingPromptForMode(mode);
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
		const [hasPendingHygieneAttention, hasPendingContentAttention, hasPendingAttention] = await Promise.all([
			Promise.all(
				scopes.map(
					async (scope) =>
						(await ownerQueryOne<{ present: number }>(
							await getDbOwnerForAccessor(accessor),
							"dreaming.attention.hygiene-present",
							"SELECT 1 AS present FROM dreaming_attention WHERE agent_id = ? AND kind = 'hygiene' AND resolved_at IS NULL LIMIT 1",
							[scope],
							{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
						)) !== undefined,
				),
			).then((values) => values.some(Boolean)),
			Promise.all(
				scopes.map(
					async (scope) =>
						(await ownerQueryOne<{ present: number }>(
							await getDbOwnerForAccessor(accessor),
							"dreaming.attention.content-present",
							"SELECT 1 AS present FROM dreaming_attention WHERE agent_id = ? AND kind IN ('review_due', 'contested_claim', 'evidence_requeue', 'surprisal') AND resolved_at IS NULL LIMIT 1",
							[scope],
							{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
						)) !== undefined,
				),
			).then((values) => values.some(Boolean)),
			Promise.all(
				scopes.map(
					async (scope) =>
						(await ownerQueryOne<{ present: number }>(
							await getDbOwnerForAccessor(accessor),
							"dreaming.attention.present",
							"SELECT 1 AS present FROM dreaming_attention WHERE agent_id = ? AND resolved_at IS NULL LIMIT 1",
							[scope],
							{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
						)) !== undefined,
				),
			).then((values) => values.some(Boolean)),
		]);
		const hasBacklogByScope = new Map(
			await Promise.all(
				scopes.map(
					async (scope) => [scope, await hasDreamingEpisodicBacklog(accessor, scope, ownerMaintenance)] as const,
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
									 (agent_id, consecutive_failures, last_failure_at, last_pass_at, evidence_cursor, last_pass_id, last_pass_mode)
									 VALUES (?, 0, NULL, ?, NULL, ?, ?)
									 ON CONFLICT(agent_id) DO UPDATE SET
									   consecutive_failures = 0, last_failure_at = NULL, last_pass_at = excluded.last_pass_at,
									   evidence_cursor = NULL, last_pass_id = excluded.last_pass_id,
									   last_pass_mode = excluded.last_pass_mode, updated_at = datetime('now')`,
								[scope, cutoff, passId, mode],
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
				rejectedEvidence.push(...(await collectRejectedDreamingEvidence(accessor, scopeId, result, operations)));
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
								)),
							);
						}
						failed++;
					}
					applyCallbackReported = false;
				}
			},
		});
		const historyScopes = liveOptions?.userRequest !== undefined ? [agentId] : scopes;
		await ownerTransaction(
			await getDbOwnerForAccessor(accessor),
			"dreaming.pass.scope-key",
			[
				ownerRunStatement("UPDATE dreaming_passes SET scope_key = ? WHERE id = ?", [
					dreamingScopeKey(historyScopes),
					passId,
				]),
			],
			{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
		);
		const passPrompt = dreamingPassPrompt(
			prompt,
			await renderDreamingHistoryForPass(accessor, agentId, historyScopes),
			await renderPendingDreamingAttention(accessor, historyScopes, mode),
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
			onEvent: (event) => publishDreamingAgentEvent(passId, event, live),
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
		const tokensConsumed = usage?.totalTokens ?? countTokens(passPrompt);
		const nextWatermarkByScope = new Map<string, string | null>();
		for (const scope of scopes) {
			const previous =
				(
					await ownerQueryOne<{ lastPassAt: string | null }>(
						await getDbOwnerForAccessor(accessor),
						"dreaming.state.watermark",
						"SELECT last_pass_at AS lastPassAt FROM dreaming_state WHERE agent_id = ?",
						[scope],
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
				if (mode === "incremental-content") {
					try {
						const projection = await memoryHeadCommitter.read(agentId);
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
const DREAMING_EVIDENCE_KINDS = ["memory", "artifact", "transcript"] as const;

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
			agent_id, source_type, source_ref, meta_json, created_at
		) VALUES (?, ?, 0, 'session', ?, ?, ?, ?, ?, ?, ?, 'transcript', ?, ?, ?)
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
			meta_json = excluded.meta_json`,
	);
	const now = new Date().toISOString();
	for (const entry of params.entries) {
		if (!entry.source.completed || entry.content.trim().length === 0) continue;
		const content = entry.content.trim();
		const contentHash = createHash("sha256").update(content).digest("hex");
		const existing = db
			.prepare(
				`SELECT id FROM session_summaries
				 WHERE agent_id = ? AND session_key = ? AND depth = 0
				   AND COALESCE(source_type, 'summary') IN ('summary', 'checkpoint')
				 LIMIT 1`,
			)
			.get(entry.scope, entry.source.id) as { id: string } | null;
		const nodeId = existing?.id ?? `transcript:${entry.scope}:${entry.source.id}`;
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
		);
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
		const deferredEvidence = runbookDeferred === null ? null : new Set([...runbookDeferred, ...failedEvidence.sources]);
		const reviewedExcludedEvidence =
			parsedRunbook === null ? null : parseDreamingReviewedExcludedEvidence(parsedRunbook);
		if (deferredEvidence !== null && reviewedExcludedEvidence !== null) {
			recordDreamingEvidenceConsumptionInTx(db, {
				passId: input.passId,
				deferredEvidence,
				withheldScopes: failedEvidence.scopes,
				filedSources: failedEvidence.filedSources,
			});
			recordDreamingReviewedExcludedEvidenceInTx(db, {
				passId: input.passId,
				scopeIds: new Set(input.scopes),
				entries: reviewedExcludedEvidence,
				deferredEvidence,
			});
		}
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
			resetDreamingTokens(db, item.scope, input.passId, input.mode, null, watermarks.get(item.scope) ?? null);
		}
	}
}
export const DREAMING_FAILURE_HALT_THRESHOLD = 5;
export const DREAMING_HALT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const DREAMING_SCHEDULE_BACKLOG_MAX_SOURCES = 50;
export function isDreamingScopeHalted(state: DreamingState, nowMs = Date.now()): boolean {
	if (state.consecutiveFailures < DREAMING_FAILURE_HALT_THRESHOLD) return false;
	const failedAt = state.lastFailureAt === null ? Number.NaN : utcTimestampMs(state.lastFailureAt);
	return Number.isFinite(failedAt) && nowMs - failedAt < DREAMING_HALT_COOLDOWN_MS;
}
export function isDreamingScopeBackedOff(state: DreamingState, nowMs = Date.now()): boolean {
	if (state.consecutiveFailures <= 0) return false;
	const exp = Math.min(state.consecutiveFailures, MAX_FAILURE_BACKOFF_MULTIPLIER);
	const failedAt = state.lastFailureAt === null ? Number.NaN : utcTimestampMs(state.lastFailureAt);
	return !Number.isFinite(failedAt) || nowMs - failedAt < FAILURE_BACKOFF_BASE_MS * 2 ** exp;
}
export async function isDreamingHaltActive(
	accessor: DbAccessor,
	agentId: string,
	nowMs = Date.now(),
): Promise<boolean> {
	return isDreamingScopeHalted(await getDreamingState(accessor, agentId), nowMs);
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

function sourceRecordKey(source: EpisodicSourceRecord): string {
	return `${source.kind}:${source.id}`;
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

function readDreamingEpisodicBacklogInDb(db: ReadDb, agentId: string, sourceLimit: number | null): DreamingBacklogRead {
	const candidateScan = sourceLimit === null ? null : scanEpisodicSourceCandidates(db, agentId, sourceLimit);
	const candidateRefs = candidateScan?.refs;
	const hasConsumption =
		db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dreaming_evidence_consumption'").get() !=
		null;
	if (hasConsumption) {
		const queued = searchEpisodicSources(db, {
			agentId,
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

	const state = readDreamingState(db, agentId);
	const queued = readRecentEpisodicSources(
		db,
		agentId,
		sourceLimit === null ? null : sourceLimit + 1,
		DREAMING_EVIDENCE_KINDS,
		state.evidenceCursor ? null : state.lastPassAt,
		sourceLimit === null ? "newest" : "none",
		state.evidenceCursor,
		candidateRefs,
	);
	const resumed =
		state.evidenceCursor?.fragmentOffset !== undefined && state.evidenceCursor.kind !== null
			? readEpisodicSource(db, { agentId, from: `${state.evidenceCursor.kind}:${state.evidenceCursor.id}` })
			: null;
	const resumedEntry =
		resumed === null
			? null
			: validDreamingBacklogEntry(db, agentId, resumed, false, state.evidenceCursor?.fragmentOffset ?? 0);
	const queuedSourceKeys = new Set(queued.map(sourceRecordKey));
	const resumedIsQueued = resumed !== null && queuedSourceKeys.has(sourceRecordKey(resumed));
	const resumedSource = resumedEntry !== null && resumed !== null && !resumedIsQueued ? resumed : null;
	const resumedKey = resumedSource === null ? null : sourceRecordKey(resumedSource);
	const availableSources = resumedSource === null ? queued : [resumedSource, ...queued];
	const read = backlogReadFromSources(availableSources, sourceLimit, (source) => {
		const offset =
			resumedKey !== null && sourceRecordKey(source) === resumedKey
				? (state.evidenceCursor?.fragmentOffset ?? 0)
				: undefined;
		return validDreamingBacklogEntry(db, agentId, source, false, offset);
	});
	return withCandidateScanResult(read, candidateScan);
}
export function getDreamingEpisodicTokenBacklogInDb(db: ReadDb, agentId: string): Promise<number> {
	const read = readDreamingEpisodicBacklogInDb(db, agentId, null);
	return refreshDreamingBacklogTokenCache(agentId, read.entries);
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
): Promise<DreamingEpisodicBacklogProbe> {
	const threshold = ensureDreamingTokenThreshold(tokenThreshold);
	const sourceLimit = boundedDreamingBacklogSourceLimit(maxSources);
	const read = readDreamingEpisodicBacklogInDb(db, agentId, sourceLimit);
	return countDreamingBacklogTokenEntries(agentId, read.entries, read.complete ? undefined : threshold).then(
		(result) => {
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
		},
	);
}
export function hasDreamingEpisodicBacklogInDb(db: ReadDb, agentId: string): boolean {
	return readDreamingEpisodicBacklogInDb(db, agentId, 1).hasBacklog ?? true;
}

export async function getDreamingEpisodicTokenBacklog(
	accessor: DbAccessor,
	agentId: string,
	ownerMaintenance?: DbOwnerMaintenance,
): Promise<number> {
	const input: DbOwnerDreamingEpisodicBacklog = { agentId };
	const measurementGeneration = beginDreamingEpisodicTokenBacklogMeasurement(agentId);
	const options = { deadlineMs: 60_000, estimatedWorkUnits: DB_OWNER_MAX_WORK_UNITS };
	const count = ownerMaintenance
		? await ownerMaintenance.dreamingEpisodicBacklog(input, options)
		: await runDbOwnerDomainOperation(accessor, {
				runWithOwner: async (owner) => await ownerDreamingEpisodicBacklog(owner, input, options),
				runInline: ({ read }) => read((db) => getDreamingEpisodicTokenBacklogInDb(db, input.agentId)),
			});
	recordDreamingEpisodicTokenBacklog(agentId, count, measurementGeneration);
	return count;
}

export async function probeDreamingEpisodicBacklog(
	accessor: DbAccessor,
	agentId: string,
	tokenThreshold: number,
	ownerMaintenance?: DbOwnerMaintenance,
): Promise<DreamingEpisodicBacklogProbe> {
	const measurementGeneration = beginDreamingEpisodicTokenBacklogMeasurement(agentId);
	const input: DbOwnerDreamingEpisodicBacklogProbe = {
		agentId,
		tokenThreshold: ensureDreamingTokenThreshold(tokenThreshold),
		maxSources: DREAMING_SCHEDULE_BACKLOG_MAX_SOURCES,
	};
	const options = { deadlineMs: 60_000, estimatedWorkUnits: input.maxSources * 10 };
	const result = ownerMaintenance
		? await ownerMaintenance.dreamingEpisodicBacklogProbe(input, options)
		: await runDbOwnerDomainOperation(accessor, {
				runWithOwner: async (owner) => await ownerDreamingEpisodicBacklogProbe(owner, input, options),
				runInline: ({ read }) =>
					read((db) => probeDreamingEpisodicBacklogInDb(db, input.agentId, input.tokenThreshold, input.maxSources)),
			});
	if (result.kind === "exact") recordDreamingEpisodicTokenBacklog(agentId, result.tokens, measurementGeneration);
	else invalidateDreamingEpisodicTokenBacklog(agentId);
	return result;
}

export async function hasDreamingEpisodicBacklog(
	accessor: DbAccessor,
	agentId: string,
	ownerMaintenance?: DbOwnerMaintenance,
): Promise<boolean> {
	const input: DbOwnerDreamingEpisodicBacklogExists = { agentId };
	const options = { deadlineMs: 30_000, estimatedWorkUnits: 10 };
	if (ownerMaintenance) return await ownerMaintenance.dreamingEpisodicBacklogExists(input, options);
	return await runDbOwnerDomainOperation(accessor, {
		runWithOwner: async (owner) => await ownerDreamingEpisodicBacklogExists(owner, input, options),
		runInline: ({ read }) => read((db) => hasDreamingEpisodicBacklogInDb(db, input.agentId)),
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
): Promise<DreamingTriggerDecision> {
	const state = await getDreamingState(accessor, agentId);
	const hasAttention =
		(await ownerQueryOne<{ present: number }>(
			await getDbOwnerForAccessor(accessor),
			"dreaming.attention.present",
			"SELECT 1 AS present FROM dreaming_attention WHERE agent_id = ? AND resolved_at IS NULL LIMIT 1",
			[agentId],
			{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
		)) !== undefined;
	if (isDreamingScopeHalted(state, nowMs) || isDreamingScopeBackedOff(state, nowMs)) return { trigger: false };

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
