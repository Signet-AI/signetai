/**
 * Dreaming agent — periodic smart-model consolidation of the knowledge graph.
 *
 * Reads accumulated session summaries and the current entity graph,
 * produces structured graph mutations (create, merge, update, delete,
 * supersede), and applies them transactionally.
 *
 * See docs/specs/approved/dreaming-memory-consolidation.md
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type DreamingConfig,
	type IdentityContextFileEntry,
	resolveSpecialIdentityFiles,
	resolveStartupIdentityFiles,
} from "@signet/core";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import {
	type EpisodicCursor,
	type EpisodicSourceRecord,
	readEpisodicSource,
	readRecentEpisodicSources,
} from "../episodic-sources";
import { getDreamingHygieneCandidatesInDb } from "../knowledge-graph-hygiene";
import { logger } from "../logger";
import { createDreamingAgentTools } from "./dreaming-agent-tools";
import {
	type DreamingAttention,
	enqueueDreamingAttentionInTx,
	getDreamingAttention,
	getDreamingAttentionInDb,
	getDreamingAttentionSnapshots,
	renderDreamingAttentionForPrompt,
	resolveDreamingAttentionInTx,
} from "./dreaming-attention";
import type { DreamingToolCallTrace } from "./dreaming-capabilities";
import {
	type DreamingEvidenceFragment,
	createDreamingAgentEvidence,
	nextDreamingEvidenceFragment,
	renderDreamingEvidence,
} from "./dreaming-evidence";
import type { ApplyDreamingOperationsResult, DreamingOperationRequest } from "./dreaming-operations";
import {
	readDreamingRunbook,
	recordDreamingEvidenceWindowInTx,
	renderDreamingRunbookForPrompt,
} from "./dreaming-runbook";
import { countTokens } from "./tokenizer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DreamingMode = "incremental" | "compact";

export interface DreamingState {
	readonly consecutiveFailures: number;
	readonly lastFailureAt: string | null;
	readonly lastPassAt: string | null;
	readonly evidenceCursor: EpisodicCursor | null;
	readonly lastPassId: string | null;
	readonly lastPassMode: string | null;
}

/** Queue bounded deterministic graph cleanup work for the next Dreaming pass. */
export function enqueueDreamingHygieneAttention(accessor: DbAccessor, agentId: string, limit = 50): number {
	return accessor.withWriteTx((db) => {
		const candidates = getDreamingHygieneCandidatesInDb(db, { agentId, limit });
		for (const candidate of candidates) {
			enqueueDreamingAttentionInTx(db, {
				agentId,
				kind: "hygiene",
				subjectRef: candidate.subjectRef,
				details: candidate.details,
				priority: candidate.priority,
				reopen: false,
			});
		}
		return candidates.length;
	});
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

/** Exported for cursor round-trip tests. */
export function _testParseEpisodicCursor(value: string | null): EpisodicCursor | null {
	return parseEpisodicCursor(value);
}

interface DreamingPassRow {
	readonly id: string;
	readonly mode: string;
	readonly status: string;
	readonly startedAt: string;
	readonly completedAt: string | null;
	readonly tokensConsumed: number | null;
	readonly mutationsApplied: number | null;
	readonly mutationsSkipped: number | null;
	readonly mutationsFailed: number | null;
	readonly summary: string | null;
	readonly error: string | null;
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
	readonly passId: string;
	readonly excludedAt: string;
	readonly requeueRequestedAt: string | null;
	readonly resolvedAt: string | null;
}

export type { DreamingAttention } from "./dreaming-attention";

/** Routed bounded-agent executor. The daemon creates the tools and owns all writes. */
export interface DreamingAgentExecutor {
	run(input: {
		readonly passId: string;
		readonly prompt: string;
		readonly tools: ReturnType<typeof createDreamingAgentTools>;
		readonly timeoutMs: number;
		readonly maxTokens: number;
	}): Promise<{ readonly summary?: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Keep evidence cited by an agent operation that the daemon rejects. The
 * agentic calls preserve this audit/requeue trail even when citation
 * validation fails before the operation service can return per-item results.
 */
function rejectedAgentEvidence(
	result: ApplyDreamingOperationsResult,
	operations: readonly Pick<DreamingOperationRequest, "evidence">[],
	sources: readonly EpisodicSourceRecord[],
): readonly EpisodicSourceRecord[] {
	const rejectedIndexes = new Set<number>(result.items.filter((item) => !item.ok).map((item) => item.index));
	const rejectedOperations =
		rejectedIndexes.size > 0
			? operations.filter((_operation, index) => rejectedIndexes.has(index))
			: result.ok
				? []
				: operations;
	const references = new Set<string>();
	for (const operation of rejectedOperations) {
		for (const evidence of operation.evidence ?? []) {
			if (!isRecord(evidence)) continue;
			const sourceRef = readNonEmptyString(evidence.source_ref);
			if (sourceRef) references.add(sourceRef);
		}
	}
	return sources.filter((source) => references.has(`${source.kind}:${source.id}`));
}

/** Recover cited sources when tool-schema validation rejects an operation before the apply seam runs. */
function operationEvidenceFromToolInput(input: unknown): readonly Pick<DreamingOperationRequest, "evidence">[] {
	if (!isRecord(input) || !Array.isArray(input.operations)) return [];
	return input.operations.flatMap((operation) => {
		if (!isRecord(operation) || !Array.isArray(operation.evidence)) return [];
		return [{ evidence: operation.evidence }];
	});
}

// ---------------------------------------------------------------------------
// Dreaming state DB helpers
// ---------------------------------------------------------------------------

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
		// The constellation can be read while an old workspace migrates.
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

export function getDreamingState(accessor: DbAccessor, agentId: string): DreamingState {
	return accessor.withReadDb((db) => readDreamingState(db, agentId));
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

export function recordDreamingFailure(accessor: DbAccessor, agentId: string): void {
	accessor.withWriteTx((db) => {
		const exists = db.prepare("SELECT 1 FROM dreaming_state WHERE agent_id = ?").get(agentId);
		if (exists) {
			db.prepare(
				`UPDATE dreaming_state
				 SET consecutive_failures = consecutive_failures + 1,
				     last_failure_at = datetime('now'),
				     updated_at = datetime('now')
				 WHERE agent_id = ?`,
			).run(agentId);
		} else {
			db.prepare(
				`INSERT INTO dreaming_state (agent_id, tokens_since_last_pass, consecutive_failures, last_failure_at)
				 VALUES (?, 0, 1, datetime('now'))`,
			).run(agentId);
		}
	});
}

// ---------------------------------------------------------------------------
// Dreaming pass records
// ---------------------------------------------------------------------------

export function createDreamingPass(accessor: DbAccessor, agentId: string, mode: DreamingMode): string {
	const id = randomUUID();
	accessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO dreaming_passes (id, agent_id, mode, status, started_at, created_at)
			 VALUES (?, ?, ?, 'running', datetime('now'), datetime('now'))`,
		).run(id, agentId, mode);
	});
	return id;
}

function failDreamingPass(accessor: DbAccessor, passId: string, error: string): void {
	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE dreaming_passes
			 SET status = 'failed',
			     completed_at = datetime('now'),
			     error = ?
			 WHERE id = ?`,
		).run(error, passId);
	});
}

export function getDreamingPasses(accessor: DbAccessor, agentId: string, limit = 10): readonly DreamingPassRow[] {
	return accessor.withReadDb((db) => {
		return db
			.prepare(
				`SELECT id, mode, status, started_at AS startedAt,
				        completed_at AS completedAt, tokens_consumed AS tokensConsumed,
				        mutations_applied AS mutationsApplied,
				        mutations_skipped AS mutationsSkipped,
				        mutations_failed AS mutationsFailed,
				        summary, error
				 FROM dreaming_passes
				 WHERE agent_id = ?
				 ORDER BY created_at DESC
				 LIMIT ?`,
			)
			.all(agentId, limit) as DreamingPassRow[];
	});
}

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
	return JSON.stringify({
		truncated: true,
		originalChars: json.length,
		preview: json.slice(0, MAX_DREAMING_TOOL_TRACE_JSON_CHARS),
	});
}

function parseToolTrace(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return { malformedTrace: true };
	}
}

function recordDreamingToolCall(
	accessor: DbAccessor,
	agentId: string,
	passId: string,
	sequence: number,
	trace: DreamingToolCallTrace,
): void {
	accessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO dreaming_tool_calls
			 (id, agent_id, pass_id, sequence, tool_call_id, tool_name, input_json, output_json, success, latency_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
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
		);
	});
}

/** Return the Pi capability trace for one scoped Dreaming pass. */
export function getDreamingToolCalls(
	accessor: DbAccessor,
	agentId: string,
	passId: string,
): readonly DreamingToolCall[] {
	return accessor.withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT id, pass_id AS passId, sequence, tool_call_id AS toolCallId,
				        tool_name AS toolName, input_json AS inputJson, output_json AS outputJson,
				        success, latency_ms AS latencyMs, created_at AS createdAt
				 FROM dreaming_tool_calls
				 WHERE agent_id = ? AND pass_id = ?
				 ORDER BY sequence ASC`,
				)
				.all(agentId, passId)
				.map((row) => {
					const typed = row as {
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
					};
					return {
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
					};
				}) as DreamingToolCall[],
	);
}

export function getDreamingEvidenceExclusions(
	accessor: DbAccessor,
	agentId: string,
): readonly DreamingEvidenceExclusion[] {
	return accessor.withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT source_kind AS sourceKind, source_id AS sourceId, reason,
				        pass_id AS passId, excluded_at AS excludedAt,
				        requeue_requested_at AS requeueRequestedAt, resolved_at AS resolvedAt
				 FROM dreaming_evidence_exclusions
				 WHERE agent_id = ? AND resolved_at IS NULL
				 ORDER BY excluded_at DESC, source_kind ASC, source_id ASC`,
				)
				.all(agentId) as DreamingEvidenceExclusion[],
	);
}

export function requestDreamingEvidenceRequeue(
	accessor: DbAccessor,
	agentId: string,
	sourceKind: EpisodicSourceRecord["kind"],
	sourceId: string,
): boolean {
	return accessor.withWriteTx((db) => {
		const result = db
			.prepare(
				`UPDATE dreaming_evidence_exclusions
				 SET requeue_requested_at = datetime('now')
				 WHERE agent_id = ? AND source_kind = ? AND source_id = ? AND resolved_at IS NULL`,
			)
			.run(agentId, sourceKind, sourceId) as { changes: number };
		if (result.changes === 0) return false;
		enqueueDreamingAttentionInTx(db, {
			agentId,
			kind: "evidence_requeue",
			subjectRef: `${sourceKind}:${sourceId}`,
			details: { sourceKind, sourceId },
			priority: 80,
		});
		return true;
	});
}

function recordDreamingEvidenceExclusionsInTx(
	db: WriteDb,
	agentId: string,
	passId: string,
	sources: readonly EpisodicSourceRecord[],
	reason: string,
): void {
	const statement = db.prepare(
		`INSERT INTO dreaming_evidence_exclusions
		 (agent_id, source_kind, source_id, reason, pass_id, excluded_at, requeue_requested_at, resolved_at)
			 VALUES (?, ?, ?, ?, ?, datetime('now'), NULL, NULL)
		 ON CONFLICT(agent_id, source_kind, source_id) DO UPDATE SET
		   reason = excluded.reason,
		   pass_id = excluded.pass_id,
		   excluded_at = excluded.excluded_at,
		   requeue_requested_at = NULL,
		   resolved_at = NULL`,
	);
	for (const source of sources) statement.run(agentId, source.kind, source.id, reason, passId);
}

function resolveRequeuedEvidenceInTx(db: WriteDb, agentId: string, sources: readonly EpisodicSourceRecord[]): void {
	const statement = db.prepare(
		`UPDATE dreaming_evidence_exclusions
		 SET resolved_at = datetime('now')
		 WHERE agent_id = ? AND source_kind = ? AND source_id = ?
		   AND requeue_requested_at IS NOT NULL AND resolved_at IS NULL`,
	);
	for (const source of sources) statement.run(agentId, source.kind, source.id);
}

// ---------------------------------------------------------------------------
// Data fetching for prompt assembly
// ---------------------------------------------------------------------------

function fetchEpisodicEvidence(
	db: ReadDb,
	agentId: string,
	since: string | null,
	limit: number,
	cursor: EpisodicCursor | null,
): readonly EpisodicSourceRecord[] {
	const sources = readRecentEpisodicSources(db, agentId, limit, undefined, since, "oldest", cursor);
	if (!cursor?.fragmentOffset || cursor.kind === null) return sources;
	const resumed = readEpisodicSource(db, { agentId, from: `${cursor.kind}:${cursor.id}` });
	if (!resumed) return sources;
	return [resumed, ...sources.filter((source) => source.kind !== resumed.kind || source.id !== resumed.id)].slice(
		0,
		limit,
	);
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

interface RenderedIdentityBlock {
	readonly content: string;
	readonly unreadablePaths: readonly string[];
}

function readIdentityFile(
	dir: string,
	entry: IdentityContextFileEntry,
): { readonly content: string; readonly unreadable: boolean } {
	const path = join(dir, entry.path);
	// Identity files are optional context. A missing file is ordinary, not a
	// degraded pass or a reason to fill the daemon logs every five minutes.
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

/**
 * The Dreaming agent's complete fixed prompt. No identity files, no working
 * memory, no injected evidence window: the agent drives everything through the
 * tool surface (attention_list, search_evidence, runbook_read) following this
 * process contract. Hardcoded so users cannot accidentally mutate the process.
 */
export const DREAMING_AGENT_PROMPT = `You are a bounded Signet maintenance agent. Your task is to maintain durable, evidence-cited semantic understanding as the relevant entities, relationships, and claims change over time. Attach each claim to its entity and aspect rather than allowing it to exist as standalone.

## Process

Purpose: maintain durable, evidence-cited semantic understanding in the knowledge graph. The graph is a derived structure; every write carries provenance (an attention id for hygiene, an exact quote from episodic evidence for content). Use the pass log (runbook_read) as the dedup source: the previous pass's viewed sources and changes are the cutoff.

An install may have several agent scopes (listed in <agent_scopes> when there is more than one): the scoped tools take an agentId, so address any scope you need — each write is attributed to the agent you name. attention_list without an agentId lists the whole install's hygiene queue, with each record carrying its owning agentId.

### State targets

- Hygiene queue: dreaming_attention pending records (kind=hygiene)
- Graph: entities, aspects, claims, links (active/archived/pinned)
- Evidence: episodic store (memories, artifacts, transcripts, summaries)
- Pass log: dreaming_passes + runbook notes (what changed, what was viewed)

### Per-pass process

1. Read the pass log (runbook_read). Establish cutoff: sources viewed, changes applied, deferred items.
2. Query the attention queue (attention_list, kind=hygiene, status=pending). Process ALL pending hygiene records first, before any content work:
   - Inspect the flagged target (get_entity — check aspects, claims, pinned).
   - Archive or merge it, citing its attention id (provenance: "attention:<uuid>", or attention:$<index> for a flag you minted in the same batch).
   - If you discover junk the queue did not flag, mint a flag op and archive in the same batch.
3. Only when the hygiene queue is clear: find new evidence since the cutoff. First LIST recent sources with search_evidence — pass since and omit the query so it returns the newest sources; only after seeing what is there, narrow with a query if the list is large. For each new source:
   - search_entities for subjects it establishes.
   - Extract/update claims with exact-quote evidence from that source.
   - create_entity only for durable subjects clearly established by the source.
   - Validate before writing (validate_proposal).
4. Write the pass log (runbook_write): what changed, which sources were viewed, anything deferred with exact names.

### Safe

- Archive attention-flagged entities that are non-concrete (zero active aspects/claims, non-concrete type, legacy-only deps).
- Merge exact-canonical duplicates (same canonical name, same scope).
- Add/set/supersede claims with exact quotes from an episodic source.
- Create entities for durable subjects the source clearly establishes.
- Rename/update entities only with evidence.

### Unsafe

- Archive any entity with active aspects/claims.
- Merge entities across agent scopes.
- Any write without provenance: hygiene ops need an attention id; content ops need an exact quote.
- Claims without exact quotes, or relationships the source does not state.
- Touch pinned entities, source-root entities, or topology entities.
- Rewrite existing claims without evidence that supersedes them.

### Verification (before finishing)

- Every write in the batch has valid provenance.
- Hygiene queue is drained, or remaining records are explicitly deferred with reasons in the pass log.
- Pass log written with sources viewed + changes applied (this is the next pass's dedup).
- No flag left unresolved for a target you archived.
- No writes attempted against pinned or source-root entities.
`;

// ---------------------------------------------------------------------------
// Main dreaming orchestrator
// ---------------------------------------------------------------------------

/**
 * Bounded tool-loop Dreaming pass. The daemon owns evidence selection,
 * exclusion/cursor bookkeeping, tool construction, and audited writes.
 */
export async function runDreamingAgentPass(
	accessor: DbAccessor,
	executor: DreamingAgentExecutor,
	cfg: DreamingConfig,
	agentsDir: string,
	agentId: string,
	scopes: readonly string[],
	mode: DreamingMode,
	existingPassId?: string,
): Promise<{ passId: string; applied: number; skipped: number; failed: number; summary: string }> {
	const passId = existingPassId ?? createDreamingPass(accessor, agentId, mode);
	const passStartedAt = new Date().toISOString();
	try {
		const prompt =
			scopes.length > 1
				? `${DREAMING_AGENT_PROMPT}\n\n<agent_scopes>\n${scopes.join("\n")}\n</agent_scopes>`
				: DREAMING_AGENT_PROMPT;

		// SQLite-format watermark so string comparisons against stored source
		// dates stay consistent (ISO timestamps would mis-order).
		const cutoff = accessor.withReadDb(
			(db) => (db.prepare("SELECT datetime('now') AS now").get() as { now: string }).now,
		);

		// One Dreaming pass covers the whole install: it only runs when some
		// scope has pending attention or an episodic backlog. Scheduled checks
		// are already gated by shouldTriggerDreaming; this protects manual
		// triggers and compact runs from spending tokens on nothing.
		const hasPendingAttention = scopes.some((scope) =>
			accessor.withReadDb((db) => getDreamingAttentionInDb(db, scope, 1).length > 0),
		);
		const totalBacklog = scopes.reduce((total, scope) => total + getDreamingEpisodicTokenBacklog(accessor, scope), 0);
		if (mode === "incremental" && !hasPendingAttention && totalBacklog === 0) {
			const summary = "No new episodic evidence or semantic attention to process";
			accessor.withWriteTx((db) => {
				db.prepare(
					`UPDATE dreaming_passes SET status = 'completed', completed_at = datetime('now'),
					 tokens_consumed = 0, mutations_applied = 0, mutations_skipped = 0,
					 mutations_failed = 0, summary = ? WHERE id = ?`,
				).run(summary, passId);
				for (const scope of scopes) resetDreamingTokens(db, scope, passId, mode, null, cutoff);
			});
			return { passId, applied: 0, skipped: 0, failed: 0, summary };
		}

		let applied = 0;
		let failed = 0;
		let toolCallSequence = 0;
		let applyCallbackReported = false;
		const rejectedEvidence: EpisodicSourceRecord[] = [];
		const tools = createDreamingAgentTools({
			accessor,
			agentId,
			actor: "dreaming",
			passId,
			onOperationsApplied(result, operations) {
				applyCallbackReported = true;
				applied += result.items.filter((item) => item.ok).length;
				failed += result.items.filter((item) => !item.ok).length;
				if (!result.ok && result.items.length === 0) failed++;
				rejectedEvidence.push(...rejectedAgentEvidence(result, operations, []));
			},
			onToolCall(trace) {
				recordDreamingToolCall(accessor, agentId, passId, ++toolCallSequence, trace);
				if (trace.tool === "apply_ontology_ops") {
					if (!trace.output.ok && !applyCallbackReported) {
						rejectedEvidence.push(
							...rejectedAgentEvidence({ ok: false, items: [] }, operationEvidenceFromToolInput(trace.input), []),
						);
						failed++;
					}
					applyCallbackReported = false;
				}
			},
		});
		logger.info("dreaming", "Starting agentic dreaming pass", {
			mode,
			promptChars: prompt.length,
		});
		const outcome = await executor.run({
			passId,
			prompt,
			tools,
			timeoutMs: cfg.timeout,
			maxTokens: cfg.maxOutputTokens,
		});
		const summary = `${outcome.summary?.trim() || "Agentic Dreaming pass completed"}`;
		const tokensConsumed = countTokens(prompt);
		accessor.withWriteTx((db) => {
			db.prepare(
				`UPDATE dreaming_passes SET status = 'completed', completed_at = datetime('now'),
				 tokens_consumed = ?, mutations_applied = ?, mutations_skipped = ?,
				 mutations_failed = ?, summary = ? WHERE id = ?`,
			).run(tokensConsumed, applied, 0, failed, summary, passId);
			recordDreamingEvidenceExclusionsInTx(db, agentId, passId, rejectedEvidence, "semantic_operation_rejected");
			// The evidence queue resets to the pass watermark for EVERY scope:
			// the next pass's backlog counts only sources captured after this
			// pass began. The agent's own pass log (runbook_write) carries the
			// viewed-source dedup.
			for (const scope of scopes) resetDreamingTokens(db, scope, passId, mode, null, cutoff);
		});
		return { passId, applied, skipped: 0, failed, summary };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("dreaming", "Agentic dreaming pass failed", undefined, { error: message });
		failDreamingPass(accessor, passId, message);
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Threshold check
// ---------------------------------------------------------------------------

// Max backoff: 5min * 2^6 = ~5.3 hours.
const MAX_FAILURE_BACKOFF_MULTIPLIER = 6;
const FAILURE_BACKOFF_BASE_MS = 5 * 60 * 1000;

// A scope that fails this many consecutive passes is halted: automatic
// scheduling stops for the cooldown below instead of retrying forever on
// the backoff ceiling (~5.3h per attempt). Explicit triggers bypass the
// gate, and any successful pass resets the counter, so a halt self-heals
// on the next forced or post-cooldown pass (#1059).
export const DREAMING_FAILURE_HALT_THRESHOLD = 5;
export const DREAMING_HALT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function isDreamingScopeHalted(state: DreamingState, nowMs = Date.now()): boolean {
	if (state.consecutiveFailures < DREAMING_FAILURE_HALT_THRESHOLD) return false;
	const failedAt = state.lastFailureAt === null ? Number.NaN : Date.parse(state.lastFailureAt);
	return Number.isFinite(failedAt) && nowMs - failedAt < DREAMING_HALT_COOLDOWN_MS;
}

/** Cheap sweep pre-check: one indexed dreaming_state row, no attention scan. */
export function isDreamingHaltActive(accessor: DbAccessor, agentId: string, nowMs = Date.now()): boolean {
	return isDreamingScopeHalted(getDreamingState(accessor, agentId), nowMs);
}

/**
 * The worker's backlog is the episodic evidence it has not yet reasoned over,
 * not a separately maintained token counter. This keeps the trigger aligned
 * with every supported input source.
 */
export function getDreamingEpisodicTokenBacklog(accessor: DbAccessor, agentId: string): number {
	return accessor.withReadDb((db) => getDreamingEpisodicTokenBacklogInDb(db, agentId));
}

export function getDreamingEpisodicTokenBacklogInDb(db: ReadDb, agentId: string): number {
	const state = readDreamingState(db, agentId);
	const queued = readRecentEpisodicSources(
		db,
		agentId,
		500,
		undefined,
		state.evidenceCursor ? null : state.lastPassAt,
		"newest",
		state.evidenceCursor,
	);
	const resumed =
		state.evidenceCursor?.fragmentOffset && state.evidenceCursor.kind !== null
			? readEpisodicSource(db, { agentId, from: `${state.evidenceCursor.kind}:${state.evidenceCursor.id}` })
			: null;
	const remaining = resumed ? renderDreamingEvidence(resumed).slice(state.evidenceCursor?.fragmentOffset) : "";
	return (
		queued.reduce((total, source) => total + countTokens(renderDreamingEvidence(source)), 0) + countTokens(remaining)
	);
}

export function shouldTriggerDreaming(
	accessor: DbAccessor,
	cfg: DreamingConfig,
	agentId: string,
	nowMs = Date.now(),
	episodicTokens = getDreamingEpisodicTokenBacklog(accessor, agentId),
): boolean {
	const state = getDreamingState(accessor, agentId);
	const hasAttention = accessor.withReadDb((db) => getDreamingAttentionInDb(db, agentId, 1).length > 0);

	// Hard halt after repeated consecutive failures: no automatic scheduling
	// for the cooldown window. Explicit operator triggers bypass this gate.
	if (isDreamingScopeHalted(state, nowMs)) return false;

	// Back off by wall clock, not by evidence volume. A transient provider outage
	// must not require exponentially more incoming evidence before recovery.
	if (state.consecutiveFailures > 0) {
		const exp = Math.min(state.consecutiveFailures, MAX_FAILURE_BACKOFF_MULTIPLIER);
		const failedAt = state.lastFailureAt === null ? Number.NaN : Date.parse(state.lastFailureAt);
		if (!Number.isFinite(failedAt) || nowMs - failedAt < FAILURE_BACKOFF_BASE_MS * 2 ** exp) return false;
	}

	// First run only backfills actual episodic evidence, except for explicit
	// scoped attention that has been queued for a Dreaming review.
	if (cfg.backfillOnFirstRun && state.lastPassAt === null) return episodicTokens > 0 || hasAttention;
	if (hasAttention || episodicTokens >= cfg.tokenThreshold) return true;

	// A low-volume stream must not wait indefinitely for the batch ceiling.
	// This is deliberately a maximum wait rather than an unconditional cron:
	// empty ledgers never trigger a pass.
	const lastPassMs = state.lastPassAt === null ? Number.NaN : Date.parse(state.lastPassAt);
	return episodicTokens > 0 && Number.isFinite(lastPassMs) && nowMs - lastPassMs >= cfg.maxInterval;
}
