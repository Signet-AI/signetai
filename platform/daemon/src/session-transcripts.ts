import { readScopeSql } from "./read-scope";
import { purgeHookUploadSessionBatchInTx } from "./transcript-capture-owner";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { compartmentForWrite } from "@signet/core";
import { dirname, join } from "node:path";
import { attempt, resolveWorkspaceLayout, redactCredentials } from "@signet/core";
import { extractAnchorTerms } from "./anchor-terms";
import {
	evidenceCompartmentInTx,
	recordEvidenceCitationsInTx,
	readSessionFinalizerAuthorInTx,
	type CitationEvidence,
} from "./db-helpers";
import type { WriteCheckpointParams } from "./session-checkpoints";
import { auditAuthoredWriteInTx, requireWriteAuthor, type WriteAuthor } from "./auth/audit-owner";
import { type DbAccessor, getDbAccessor, prepareTypedStatement, type ReadDb, type WriteDb } from "./db-accessor";
import {
	dbOwnerSessionFinalizerAuthor,
	dbOwnerCommitCompactionSummary,
	dbOwnerWriteSessionTranscript,
	getDbOwnerForAccessor,
} from "./db-owner-runtime";
import { linkDerivedMemorySourcesInTx, markDerivedMemoriesStaleForSourceInTx } from "./derived-memory-provenance";
import { logger } from "./logger";
import { sanitizeFtsQuery } from "./memory-search";
import { enqueueDreamingAttentionInTx } from "./pipeline/dreaming-attention";
import { normalizeSessionKey } from "./session-end-state";
import {
	redactTranscriptFileBatch,
	removeTranscriptDeletionTemp,
	type TranscriptFileCheckpoint,
} from "./session-transcript-files";
import type {
	TranscriptBypass,
	TranscriptCaptureInput,
	TranscriptDeleteInput,
	TranscriptDeleteResult,
	TranscriptLifecycleInput,
	TranscriptLifecycleResult,
} from "./session-transcript-lifecycle";
import { captureTranscriptOwned, type TranscriptCaptureAdmission } from "./session-transcript-lifecycle";
import {
	derivedPurgeOutcome,
	purgeColdEvidenceInTx,
	purgeMemoryEmbeddingsInTx,
	purgeMemoryInTx,
} from "./source-purge-tx";
import { upsertThreadHead } from "./thread-heads";
import { txForgetMemory } from "./transactions";
import { writeTranscriptAudit } from "./transcript-audit";
import { redactSessionTranscriptUploadBatchInTx } from "./transcript-import-commit";
import {
	canonicalTranscriptPath,
	digestTranscriptTurns,
	legacyTranscriptTurns,
	readCanonicalTranscriptSessionKeys,
	sanitizeHarnessPath,
	sessionSeqCacheKey,
	type TranscriptIdentity,
	type TranscriptSessionKeyClassification,
	transcriptPrefix,
	transcriptTextToTurns,
} from "./transcript-jsonl";
import { normalizeSessionTranscript } from "./transcript-normalization";

interface EvidenceTurn {
	readonly role: string;
	readonly content: string;
	readonly timestamp?: number;
}

function evidenceTurns(harness: string, transcript: string, raw?: string): readonly EvidenceTurn[] {
	if (!raw) return transcriptTextToTurns(transcript).filter((turn) => turn.content.length > 0);
	const records: EvidenceTurn[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const value: unknown = attempt(() => JSON.parse(line));
		const candidates: readonly unknown[] = Array.isArray(value) ? value : [value];
		for (const record of candidates) {
			if (typeof record !== "object" || record === null || Array.isArray(record)) continue;
			const stamp = "timestamp" in record ? record.timestamp : "captured_at" in record ? record.captured_at : undefined;
			const timestamp = typeof stamp === "string" ? Date.parse(stamp) : typeof stamp === "number" ? stamp : Number.NaN;
			const normalized = normalizeSessionTranscript(harness, JSON.stringify(record));
			for (const turn of transcriptTextToTurns(normalized))
				records.push({ ...turn, ...(Number.isFinite(timestamp) ? { timestamp } : {}) });
		}
	}
	return (records.length > 0 ? records : transcriptTextToTurns(transcript)).filter((turn) => turn.content.length > 0);
}

export function filterTranscriptMessagesInDb<T extends EvidenceTurn>(
	db: ReadDb,
	input: { readonly agentId: string; readonly sessionKey: string | null; readonly sessionId?: string | null },
	turns: readonly T[],
): readonly T[] {
	const key = input.sessionKey ?? input.sessionId;
	if (
		!key ||
		!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_transcript_deletions'").get()
	)
		return turns;
	const row = prepareTypedStatement<{ watermark: string }>(
		db,
		"SELECT watermark FROM session_transcript_deletions WHERE agent_id = ? AND session_key = ?",
	).get(input.agentId, normalizeSessionKey(key));
	if (!row) return turns;
	const prefixes = prepareTypedStatement<{ generation: number; origin: string; record_count: number }>(
		db,
		"SELECT generation,origin,record_count FROM session_transcript_deleted_prefixes WHERE agent_id = ? AND session_key = ? ORDER BY generation,origin",
	).all(input.agentId, normalizeSessionKey(key));
	let offset = 0;
	for (const generation of new Set(prefixes.map((prefix) => prefix.generation))) {
		for (const prefix of prefixes.filter((prefix) => prefix.generation === generation)) {
			const count = Math.min(turns.length - offset, prefix.record_count);
			const receipt = prepareTypedStatement<{ record_hash: string }>(
				db,
				"SELECT record_hash FROM session_transcript_deleted_positions WHERE agent_id = ? AND session_key = ? AND generation = ? AND origin = ? AND position = ?",
			).get(input.agentId, normalizeSessionKey(key), generation, prefix.origin, count);
			if (receipt && transcriptPrefix(turns.slice(offset, offset + count)) === receipt.record_hash) {
				offset += count;
				break;
			}
		}
	}
	const watermark = Date.parse(row.watermark);
	return turns.filter((turn, index) => (turn.timestamp === undefined ? index >= offset : turn.timestamp > watermark));
}

export function filterTranscriptRecordsInDb(
	db: ReadDb,
	input: {
		readonly agentId: string;
		readonly sessionKey: string | null;
		readonly sessionId?: string | null;
		readonly harness: string;
		readonly transcript: string;
		readonly rawTranscript?: string;
	},
): string {
	const turns = evidenceTurns(input.harness, input.transcript, input.rawTranscript);
	const kept = filterTranscriptMessagesInDb(db, input, turns);
	if (kept === turns || (kept.length === turns.length && !input.rawTranscript)) return input.transcript;
	return kept
		.map((turn) =>
			turn.role === "unknown" ? turn.content : `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`,
		)
		.join("\n");
}

export async function commitCompactionSummary(accessor: DbAccessor, input: CompactionSummaryInput): Promise<boolean> {
	return await dbOwnerCommitCompactionSummary(await getDbOwnerForAccessor(accessor), input, {
		operation: "hooks.session-summary.memory.write",
	});
}

export interface CompactionSummaryInput {
	readonly author: WriteAuthor;
	readonly agentId: string;
	readonly sessionKey: string | null;
	readonly harness: string;
	readonly project: string | null;
	readonly summary: string;
	readonly summaryId: string;
	readonly now: string;
	readonly capturedAt?: string;
}

export async function sessionFinalizerAuthor(
	accessor: DbAccessor,
	agentId: string,
	sessionKey: string,
): Promise<WriteAuthor> {
	return await dbOwnerSessionFinalizerAuthor(accessor, agentId, sessionKey);
}

export function writeSessionCheckpointInTx(db: WriteDb, params: WriteCheckpointParams, maxPerSession: number): void {
	const admittedAuthor = requireWriteAuthor(params.author);
	const author =
		params.trigger === "ttl_expired" && admittedAuthor.credential === "system"
			? readSessionFinalizerAuthorInTx(db, params.agentId, params.sessionKey)
			: admittedAuthor;
	const compartment = compartmentForWrite(db, { agentId: params.agentId, sessionKey: params.sessionKey });
	const now = new Date().toISOString();
	const json = (values: readonly string[] | undefined) => (values?.length ? JSON.stringify(values) : null);
	db.prepare(`INSERT INTO session_checkpoints
		(id,session_key,harness,project,project_normalized,trigger,digest,prompt_count,memory_queries,recent_remembers,focal_entity_ids,focal_entity_names,active_aspect_ids,surfaced_constraint_count,traversal_memory_count,created_at,agent_id,compartment_id,author_user_id)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
		crypto.randomUUID(),
		params.sessionKey,
		params.harness,
		params.project ?? null,
		params.projectNormalized ?? null,
		params.trigger,
		redactCredentials(params.digest),
		params.promptCount,
		json(params.memoryQueries),
		json(params.recentRemembers.map((text) => redactCredentials(text))),
		json(params.focalEntityIds),
		json(params.focalEntityNames),
		json(params.activeAspectIds),
		params.surfacedConstraintCount ?? null,
		params.traversalMemoryCount ?? null,
		now,
		params.agentId,
		compartment,
		author.userId,
	);
	db.prepare(`DELETE FROM session_checkpoints WHERE id IN (
		SELECT id FROM session_checkpoints WHERE session_key=? AND agent_id=? ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET ?
	)`).run(params.sessionKey, params.agentId, maxPerSession);
}

export function commitCompactionSummaryInTx(db: WriteDb, input: CompactionSummaryInput): boolean {
	if (
		!admitSessionTranscriptInDb(db, {
			agentId: input.agentId,
			sessionKey: input.sessionKey,
			capturedAt: input.capturedAt,
		})
	)
		return false;
	const evidence: CitationEvidence[] =
		input.sessionKey &&
		prepareTypedStatement<{ session_key: string }>(
			db,
			"SELECT session_key FROM session_transcripts WHERE agent_id=? AND session_key=?",
		).get(input.agentId, input.sessionKey)
			? [{ kind: "transcript", id: input.sessionKey }]
			: [];
	const compartmentId = compartmentForWrite(db, {
		agentId: input.agentId,
		sessionKey: input.sessionKey,
		memoryId: input.summaryId,
		parentCompartment: evidenceCompartmentInTx(db, input.agentId, evidence),
	});
	db.prepare(
		`INSERT INTO memories (
			id, content, type, importance, source_id, source_type,
			who, tags, project, agent_id, created_at, updated_at, updated_by,
			memory_kind, compartment_id, author_user_id
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.summaryId,
		input.summary,
		"session_summary",
		0.8,
		input.sessionKey,
		input.harness,
		"system",
		`session,summary,${input.harness}`,
		input.project,
		input.agentId,
		input.now,
		input.now,
		"system",
		null,
		compartmentId,
		input.author.userId,
	);

	auditAuthoredWriteInTx(db, input.author, "summary.created", "memory", input.summaryId, input.agentId);
	const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'`).get();
	if (!table) return true;
	const nodeId = input.sessionKey
		? `${JSON.stringify([input.agentId, input.sessionKey])}:compaction:${Date.parse(input.now)}`
		: crypto.randomUUID();
	db.prepare(
		`INSERT INTO session_summaries (
			id, project, depth, kind, content, token_count,
			earliest_at, latest_at, session_key, harness,
			agent_id, source_type, source_ref, meta_json, created_at, compartment_id, author_user_id
		) VALUES (?, ?, 0, 'session', ?, ?, ?, ?, ?, ?, ?, 'compaction', ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,token_count=excluded.token_count,latest_at=excluded.latest_at,compartment_id=excluded.compartment_id,author_user_id=excluded.author_user_id`,
	).run(
		nodeId,
		input.project,
		input.summary,
		Math.ceil(input.summary.length / 4),
		input.now,
		input.now,
		input.sessionKey,
		input.harness,
		input.agentId,
		input.sessionKey,
		JSON.stringify({ source: "compaction-complete" }),
		input.now,
		compartmentId,
		input.author.userId,
	);
	recordEvidenceCitationsInTx(db, {
		agentId: input.agentId,
		derivedKind: "memory",
		derivedId: input.summaryId,
		evidence: [...evidence, { kind: "summary", id: nodeId }],
	});
	upsertThreadHead(db, {
		agentId: input.agentId,
		nodeId,
		content: input.summary,
		latestAt: input.now,
		project: input.project,
		sessionKey: input.sessionKey,
		sourceType: "compaction",
		sourceRef: input.sessionKey,
		harness: input.harness,
	});
	return true;
}

interface TranscriptRow {
	readonly session_key: string;
	readonly project: string | null;
	readonly seen_at: string;
	readonly excerpt?: string | null;
	readonly content?: string;
	readonly rank?: number | null;
}

interface StoredTranscriptBackfillRow {
	readonly session_key: string;
	readonly content: string;
	readonly harness: string | null;
	readonly project: string | null;
	readonly agent_id: string | null;
	readonly created_at: string | null;
	readonly updated_at?: string | null;
}

const CANONICAL_BACKFILL_RETRY_BASE_MS = 60_000;
const CANONICAL_BACKFILL_RETRY_MAX_MS = 60 * 60_000;

interface CanonicalBackfillRetry {
	readonly attempts: number;
	readonly retryAt: number;
}

interface CanonicalBackfillGap {
	readonly markdownFailures?: number;
	readonly databaseOk?: boolean;
	readonly markerWritten?: boolean;
	readonly threw?: boolean;
}

const canonicalBackfills = new Set<string>();
const canonicalBackfillRuns = new Map<string, Promise<void>>();
const canonicalBackfillRetries = new Map<string, CanonicalBackfillRetry>();

const OMP_UUID_LIKE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}[:-][0-9a-f]{4}[:-][0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TranscriptDeletionRow {
	readonly generation: number;
	readonly receipt_generation: number;
	readonly project: string | null;
	readonly harness: string | null;
	readonly counts: string;
	readonly blocked: number;
	readonly ended: number;
	readonly phase: string;
	readonly hard: number;
	readonly watermark: string;
	readonly opened_at: string | null;
	readonly pending_start: number;
	readonly lifecycle_intent_seq: number;
}

function transcriptDeletion(
	db: Parameters<typeof prepareTypedStatement>[0],
	agentId: string,
	sessionKey: string,
): TranscriptDeletionRow | undefined {
	if (!tableExistsInDatabase(db, "session_transcript_deletions")) return undefined;
	return prepareTypedStatement<TranscriptDeletionRow>(
		db,
		"SELECT * FROM session_transcript_deletions WHERE agent_id = ? AND session_key = ?",
	).get(agentId, sessionKey);
}

export function admitSessionTranscriptInDb(
	db: Parameters<typeof prepareTypedStatement>[0],
	input: {
		readonly agentId: string;
		readonly sessionKey: string | null;
		readonly sessionId?: string | null;
		readonly capturedAt?: string;
		readonly live?: boolean;
	},
): boolean {
	const key = input.sessionKey ?? input.sessionId;
	if (!key) return true;
	const row =
		transcriptDeletion(db, input.agentId, key) ?? transcriptDeletion(db, input.agentId, normalizeSessionKey(key));
	if (!row) return true;
	return (
		row.blocked === 0 &&
		(input.live !== true || row.ended === 0) &&
		row.phase === "complete" &&
		row.opened_at !== null &&
		input.capturedAt !== undefined &&
		Date.parse(input.capturedAt) > Date.parse(row.watermark) &&
		Date.parse(input.capturedAt) >= Date.parse(row.opened_at)
	);
}

export function updateTranscriptLifecycleInTx(
	db: WriteDb,
	input: TranscriptLifecycleInput,
): TranscriptLifecycleResult | readonly TranscriptBypass[] {
	if (input.action === "restore")
		return prepareTypedStatement<TranscriptBypass>(
			db,
			`SELECT agent_id,session_key FROM session_transcript_deletions WHERE blocked = 1 AND ended = 0 ${input.after ? "AND (agent_id,session_key) > (?,?)" : ""} ORDER BY agent_id,session_key LIMIT 100`,
		).all(...(input.after ?? []));
	let row = transcriptDeletion(db, input.agentId, input.sessionKey);
	if (!row) return { generation: 0, bypassed: false, lifecycleIntentSeq: 0 };
	if (input.intents) {
		if (input.intents.length > 1024) throw new Error("Too many transcript lifecycle intents");
		for (const intent of input.intents) {
			if (intent.seq <= row.lifecycle_intent_seq) {
				logger.warn("transcripts", "Skipped lifecycle intent behind owner high-water", {
					keyHash: createHash("sha256")
						.update(JSON.stringify([input.agentId, input.sessionKey]))
						.digest("hex"),
					intentSeq: intent.seq,
					ownerSeq: row.lifecycle_intent_seq,
				});
				continue;
			}
			updateTranscriptLifecycleInTx(db, {
				agentId: input.agentId,
				sessionKey: input.sessionKey,
				action: intent.action,
			});
			db.prepare(
				"UPDATE session_transcript_deletions SET lifecycle_intent_seq = ? WHERE agent_id = ? AND session_key = ?",
			).run(intent.seq, input.agentId, input.sessionKey);
			const current = transcriptDeletion(db, input.agentId, input.sessionKey);
			if (!current) throw new Error("Transcript lifecycle state disappeared");
			row = current;
		}
	}
	if (input.action !== "status") {
		const seq = Math.max(row.lifecycle_intent_seq, Date.now() * 1024) + 1;
		db.prepare(
			"UPDATE session_transcript_deletions SET lifecycle_intent_seq = ? WHERE agent_id = ? AND session_key = ?",
		).run(seq, input.agentId, input.sessionKey);
		row = { ...row, lifecycle_intent_seq: seq };
	}
	if (input.action === "end")
		db.prepare(
			"UPDATE session_transcript_deletions SET ended = 1, pending_start = 0 WHERE agent_id = ? AND session_key = ?",
		).run(input.agentId, input.sessionKey);
	if (input.action === "start" && row.ended === 1 && row.phase !== "complete") {
		db.prepare("UPDATE session_transcript_deletions SET pending_start = 1 WHERE agent_id = ? AND session_key = ?").run(
			input.agentId,
			input.sessionKey,
		);
	}
	if (input.action === "start" && row.ended === 1 && row.phase === "complete") {
		db.prepare(
			"UPDATE session_transcript_deletions SET generation = generation + 1, blocked = 0, ended = 0, opened_at = ? WHERE agent_id = ? AND session_key = ?",
		).run(new Date().toISOString(), input.agentId, input.sessionKey);
		return { generation: row.generation + 1, bypassed: false, lifecycleIntentSeq: row.lifecycle_intent_seq };
	}
	return {
		generation: row.generation,
		bypassed: row.blocked === 1 && input.action !== "end" && row.ended === 0,
		lifecycleIntentSeq: row.lifecycle_intent_seq,
	};
}

export async function captureSessionTranscriptOwned(
	db: ReadDb,
	input: TranscriptCaptureInput,
	basePath: string,
): Promise<TranscriptCaptureAdmission> {
	if (input.kind === "promotion") {
		const replacements = input.input.replacements
			.filter((entry) => admitSessionTranscriptInDb(db, entry.identity))
			.map((entry) => ({
				...entry,
				transcript: filterTranscriptRecordsInDb(db, { ...entry.identity, transcript: entry.transcript }),
			}));
		return { status: "admitted", capture: { ...input, input: { ...input.input, basePath, replacements } } };
	}
	if (
		!admitSessionTranscriptInDb(db, {
			...input.input,
			live: input.kind === "turns" && input.input.sourceFormat === "live",
		})
	)
		return null;
	if (input.kind === "audit")
		return writeTranscriptAudit({
			...input.input,
			preview:
				input.input.preview === undefined
					? undefined
					: filterTranscriptRecordsInDb(db, {
							...input.input,
							harness: "unknown",
							transcript: input.input.preview,
							rawTranscript: input.input.preview,
						}),
			basePath,
		});
	if (input.kind === "turns") return { status: "admitted", capture: { ...input, input: { ...input.input, basePath } } };

	return {
		status: "admitted",
		capture: {
			...input,
			input: { ...input.input, basePath, transcript: filterTranscriptRecordsInDb(db, input.input) },
		},
	};
}

function deletionCounts(value: string): Record<string, number> {
	const parsed: unknown = JSON.parse(value);
	if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid deletion counts");
	return Object.fromEntries(
		Object.entries(parsed).map(([key, count]) => {
			if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
				throw new Error("Invalid deletion count");
			return [key, count];
		}),
	);
}

function deletionResult(
	row: TranscriptDeletionRow,
): Extract<TranscriptDeleteResult, { readonly status: "complete" | "pending" }> {
	const counts = deletionCounts(row.counts);
	return {
		status: row.phase === "complete" ? "complete" : "pending",
		lifecycleIntentSeq: row.lifecycle_intent_seq,
		counts,
		retainedPinned: counts.retainedPinned ?? 0,
		generation: row.receipt_generation,
		bypassed: row.blocked === 1 && row.ended === 0,
	};
}

export function deleteSessionTranscriptInTx(
	db: WriteDb,
	input: TranscriptDeleteInput,
	basePath: string,
	deadlineAt: number,
): TranscriptDeleteResult {
	const memoryRead = input.readScope ? readScopeSql("m", input.readScope) : { sql: "", args: [] };
	const evidenceRead = (alias: string) =>
		input.readScope
			? readScopeSql(alias, input.readScope, { visibility: null, memory: null, session: "session_key", source: null })
			: { sql: "", args: [] };
	const previous = transcriptDeletion(db, input.agentId, input.sessionKey);
	const stored = prepareTypedStatement<{ harness: string | null; project: string | null; content: string }>(
		db,
		`SELECT harness, project, content FROM session_transcripts t WHERE agent_id = ? AND session_key = ?${evidenceRead("t").sql}`,
	).get(input.agentId, input.sessionKey, ...evidenceRead("t").args);
	const claim = prepareTypedStatement<{ harness: string | null }>(
		db,
		"SELECT harness FROM session_claims WHERE agent_id = ? AND session_key = ? AND state = 'active' AND expires_at > ?",
	).get(input.agentId, input.sessionKey, new Date().toISOString());
	const live =
		input.live ??
		(claim
			? { harness: claim.harness ?? "unknown", project: stored?.project ?? previous?.project ?? null }
			: undefined);
	const found = stored ?? previous ?? live;
	if (!found || (input.project !== undefined && found.project !== input.project)) return { status: "not_found" };
	const generation = previous?.generation ?? 1;
	if (input.generation !== undefined && input.generation !== generation) return { status: "conflict", generation };
	const scope = [input.agentId, input.sessionKey, generation];
	if (previous?.receipt_generation !== generation) {
		const counts = { transcripts: Number(stored !== undefined) };
		db.prepare("DELETE FROM session_extract_cursors WHERE agent_id = ? AND session_key = ?").run(
			input.agentId,
			input.sessionKey,
		);
		db.prepare(
			"UPDATE transcript_import_conversations SET state = 'removed' WHERE agent_id = ? AND canonical_key = ?",
		).run(input.agentId, input.sessionKey);
		db.prepare(
			"INSERT INTO session_transcript_deletions (agent_id,session_key,generation,receipt_generation,watermark,harness,project,hard,counts,ended,phase) VALUES (?,?,?,?,?,?,?,?,?,?,'prefix') ON CONFLICT(agent_id,session_key) DO UPDATE SET receipt_generation = excluded.receipt_generation, watermark = excluded.watermark, blocked = 1, ended = excluded.ended, pending_start = 0, phase = 'prefix', counts = excluded.counts, hard = excluded.hard, harness = excluded.harness, project = excluded.project",
		).run(
			input.agentId,
			input.sessionKey,
			generation,
			generation,
			new Date().toISOString(),
			stored?.harness ?? live?.harness ?? previous?.harness ?? null,
			found.project,
			Number(input.hard),
			JSON.stringify(counts),
			live ? 0 : 1,
		);
		db.prepare(
			"INSERT INTO session_transcript_deleted_prefixes (agent_id,session_key,generation,origin,record_count,record_hash) VALUES (?,?,?,'row',?,?)",
		).run(...scope, 0, transcriptPrefix([]));
		db.prepare(
			"UPDATE session_transcript_deletions SET lifecycle_intent_seq = ? WHERE agent_id = ? AND session_key = ?",
		).run(Math.max(previous?.lifecycle_intent_seq ?? 0, Date.now() * 1024) + 1, input.agentId, input.sessionKey);
		for (const sourceKey of [input.sessionKey, `session:${input.sessionKey}`])
			db.prepare(
				"INSERT OR IGNORE INTO session_transcript_deleted_sources (agent_id,session_key,generation,kind,id) VALUES (?,?,?,'transcript',?)",
			).run(...scope, sourceKey);
	}
	if (input.hard && previous?.hard === 0)
		db.prepare(
			"UPDATE session_transcript_deletions SET hard = 1, phase = CASE WHEN phase = 'evidence' THEN phase ELSE 'memories' END WHERE agent_id = ? AND session_key = ?",
		).run(input.agentId, input.sessionKey);
	const row = transcriptDeletion(db, input.agentId, input.sessionKey);
	if (!row) throw new Error("Deletion admission disappeared");
	if (row.phase === "complete") return deletionResult(row);
	const counts = deletionCounts(row.counts);
	const add = (key: string, value: number): void => {
		counts[key] = (counts[key] ?? 0) + value;
	};
	let budget = Date.now() < deadlineAt - 100 ? 64 : 0;
	let phase = row.phase;
	if (phase === "prefix") return deletionResult(row);
	if (phase === "evidence" && budget > 0) {
		for (const [kind, table, column] of [
			["artifact", "memory_artifacts", "source_path"],
			["summary", "session_summaries", "id"],
		]) {
			const sources = prepareTypedStatement<{ id: string }>(
				db,
				`SELECT ${column} AS id FROM ${table} t WHERE t.agent_id = ? AND ${kind === "artifact" ? "COALESCE(NULLIF(t.session_key, ''),t.session_id)" : "t.session_key"} IN (?, ?) ${kind === "artifact" ? "AND t.source_kind IN ('transcript','summary','compaction','manifest')" : ""} AND NOT EXISTS (SELECT 1 FROM session_transcript_deleted_sources d WHERE d.agent_id = t.agent_id AND d.session_key = ? AND d.generation = ? AND d.kind = ? AND d.id = t.${column})${evidenceRead("t").sql} LIMIT ?`,
			).all(
				input.agentId,
				input.sessionKey,
				`session:${input.sessionKey}`,
				input.sessionKey,
				generation,
				kind,
				...evidenceRead("t").args,
				budget,
			);
			for (const source of sources) {
				db.prepare(
					"INSERT OR IGNORE INTO session_transcript_deleted_sources (agent_id,session_key,generation,kind,id) VALUES (?,?,?,?,?)",
				).run(...scope, kind, source.id);
				if (kind === "artifact")
					db.prepare(
						"INSERT OR IGNORE INTO session_transcript_delete_files (agent_id,session_key,generation,path) VALUES (?,?,?,?)",
					).run(...scope, source.id.split("#")[0]);
			}
			budget -= sources.length;
			if (budget === 0) break;
		}
		if (budget > 0) phase = "memories";
	}
	const affected =
		"SELECT kind,id FROM session_transcript_deleted_sources WHERE agent_id = ? AND session_key = ? AND generation = ? AND outcome = 'deleted'";
	while (phase === "memories" && budget > 0 && Date.now() < deadlineAt - 100) {
		const memory = prepareTypedStatement<{
			id: string;
			pinned: number;
			source_id: string | null;
			source_type: string | null;
			type: string;
		}>(
			db,
			`
			SELECT m.id,m.pinned,m.source_id,m.source_type,m.type FROM session_transcript_deleted_sources d
			JOIN derived_memory_sources s ON s.agent_id = d.agent_id AND s.source_kind = d.kind AND s.source_id = d.id
			JOIN memories m ON m.agent_id = s.agent_id AND m.id = s.derived_memory_id
			WHERE d.agent_id = ? AND d.session_key = ? AND d.generation = ? AND d.outcome = 'deleted'${memoryRead.sql}
			UNION ALL
			SELECT m.id,m.pinned,m.source_id,m.source_type,m.type FROM memories m
			WHERE m.agent_id = ? AND m.source_id IN (?, ?) AND (m.type = 'session_summary' OR m.source_type IN ('transcript','session','session_summary','checkpoint'))
			AND NOT EXISTS (SELECT 1 FROM session_transcript_deleted_sources d WHERE d.agent_id = m.agent_id AND d.session_key = ? AND d.generation = ? AND d.kind = 'memory' AND d.id = m.id)${memoryRead.sql}
			UNION ALL
			SELECT m.id,m.pinned,m.source_id,m.source_type,m.type FROM session_transcript_deleted_sources d JOIN memories m ON m.agent_id = d.agent_id AND m.id = d.id
			WHERE d.agent_id = ? AND d.session_key = ? AND d.generation = ? AND d.kind = 'memory' AND d.outcome = 'deleted' AND ? = 1${memoryRead.sql}
			LIMIT 1`,
		).get(
			...scope,
			...memoryRead.args,
			input.agentId,
			input.sessionKey,
			`session:${input.sessionKey}`,
			input.sessionKey,
			generation,
			...memoryRead.args,
			...scope,
			row.hard,
			...memoryRead.args,
		);
		if (!memory) {
			phase = "cleanup";
			break;
		}
		const external = db
			.prepare(
				`SELECT 1 FROM derived_memory_sources WHERE agent_id = ? AND derived_memory_id = ? AND (source_kind,source_id) NOT IN (${affected}) LIMIT 1`,
			)
			.get(input.agentId, memory.id, ...scope);
		const sourceType = memory.source_type ?? (memory.type === "session_summary" ? "transcript" : null);
		const sourceKind = ["session", "session_summary", "checkpoint"].includes(sourceType ?? "")
			? "transcript"
			: sourceType;
		const otherProvenance =
			memory.source_id !== null &&
			!db
				.prepare(
					"SELECT 1 FROM session_transcript_deleted_sources WHERE agent_id = ? AND session_key = ? AND generation = ? AND kind = ? AND id = ? AND outcome = 'deleted' LIMIT 1",
				)
				.get(...scope, sourceKind, memory.source_id);
		const outcome = derivedPurgeOutcome(memory.pinned === 1, Boolean(external), Boolean(otherProvenance));
		const old = prepareTypedStatement<{ outcome: string }>(
			db,
			"SELECT outcome FROM session_transcript_deleted_sources WHERE agent_id = ? AND session_key = ? AND generation = ? AND kind = 'memory' AND id = ?",
		).get(...scope, memory.id);
		if (outcome !== "deleted") {
			if (memory.source_id !== null && !otherProvenance)
				db.prepare(
					"UPDATE memories SET source_id = NULL, source_type = NULL, stale_at=CASE WHEN ?='mixed' THEN COALESCE(stale_at,?) ELSE stale_at END WHERE id = ? AND agent_id = ?",
				).run(outcome, row.watermark, memory.id, input.agentId);
			if (outcome === "mixed") {
				const sources = prepareTypedStatement<{ source_kind: string; source_id: string }>(
					db,
					`SELECT source_kind,source_id FROM derived_memory_sources WHERE agent_id = ? AND derived_memory_id = ? AND (source_kind,source_id) IN (${affected})`,
				).all(input.agentId, memory.id, ...scope);
				for (const source of sources)
					markDerivedMemoriesStaleForSourceInTx(db, {
						agentId: input.agentId,
						sourceKind: source.source_kind,
						sourceId: source.source_id,
						staleAt: row.watermark,
						derivedMemoryId: memory.id,
					});
				enqueueDreamingAttentionInTx(db, {
					agentId: input.agentId,
					kind: "evidence_requeue",
					subjectRef: `memory:${memory.id}`,
					details: { reason: "source_removed", sourceRef: `transcript:${input.sessionKey}` },
					priority: 60,
					reopen: true,
				});
			}
			if (old?.outcome !== outcome) add(outcome === "pinned" ? "retainedPinned" : "retainedMixed", 1);
		}
		if (outcome === "deleted") {
			const result =
				input.readScope && row.hard === 1
					? { status: "deleted" }
					: txForgetMemory(db, {
							memoryId: memory.id,
							reason: "session transcript deleted",
							force: false,
							preservePinnedDerived: true,
							changedBy: input.changedBy,
							changedAt: row.watermark,
							ctx: { actorType: "operator" },
						});
			if (result.status === "pinned_requires_force") throw new Error("Pinned memory changed during deletion");
			add("embeddings", purgeMemoryEmbeddingsInTx(db, memory.id, input.readScope));
			db.prepare(
				"UPDATE entity_attributes SET status = 'archived', archived_at = ?, archive_reason = 'session transcript deleted' WHERE memory_id = ? AND agent_id = ?",
			).run(row.watermark, memory.id, input.agentId);
			if (!old) add("memories", 1);
			if (old?.outcome === "mixed") {
				add("memories", 1);
				counts.retainedMixed = Math.max(0, (counts.retainedMixed ?? 0) - 1);
			}
		}
		db.prepare(
			`DELETE FROM aggregate_evidence_sources WHERE agent_id = ? AND aggregate_memory_id = ? AND (source_kind,source_id) IN (${affected})`,
		).run(input.agentId, memory.id, ...scope);
		db.prepare(
			`DELETE FROM aggregate_memory_sources WHERE agent_id = ? AND aggregate_memory_id = ? AND source_memory_id IN (SELECT id FROM session_transcript_deleted_sources WHERE agent_id = ? AND session_key = ? AND generation = ? AND kind = 'memory' AND outcome = 'deleted')`,
		).run(input.agentId, memory.id, ...scope);
		add(
			"sourceEdges",
			db
				.prepare(
					`DELETE FROM derived_memory_sources WHERE agent_id = ? AND derived_memory_id = ? AND (source_kind,source_id) IN (${affected}) RETURNING source_id`,
				)
				.all(input.agentId, memory.id, ...scope).length,
		);
		if (outcome === "deleted" && row.hard === 1) purgeMemoryInTx(db, memory.id, input.readScope);
		db.prepare(
			"INSERT INTO session_transcript_deleted_sources (agent_id,session_key,generation,kind,id,outcome) VALUES (?,?,?,'memory',?,?) ON CONFLICT(agent_id,session_key,generation,kind,id) DO UPDATE SET outcome = excluded.outcome",
		).run(...scope, memory.id, outcome);
		budget--;
	}
	if (Date.now() >= deadlineAt - 100) budget = 0;
	if (phase === "cleanup" && budget > 0) {
		for (const key of [input.sessionKey, `session:${input.sessionKey}`])
			purgeColdEvidenceInTx(db, key, input.agentId, input.readScope);
		const hookRows = purgeHookUploadSessionBatchInTx(db, input.agentId, input.sessionKey);
		if (hookRows > 0) {
			add("hookUploadRows", hookRows);
			budget = 0;
		}
		const redacted = redactSessionTranscriptUploadBatchInTx(db, input.agentId, input.sessionKey);
		if (redacted !== 0) {
			add("uploadedBytes", Math.max(0, redacted));
			budget = 0;
		}
	}
	if (phase === "cleanup" && budget > 0) {
		const jobs = prepareTypedStatement<{ audit_path: string | null }>(
			db,
			"DELETE FROM transcript_capture_jobs WHERE id IN (SELECT id FROM transcript_capture_jobs WHERE agent_id = ? AND session_key IN (?, ?) LIMIT ?) RETURNING audit_path",
		).all(input.agentId, input.sessionKey, `session:${input.sessionKey}`, budget);
		for (const job of jobs)
			if (job.audit_path)
				db.prepare(
					"INSERT OR IGNORE INTO session_transcript_delete_files (agent_id,session_key,generation,path) VALUES (?,?,?,?)",
				).run(...scope, job.audit_path);
		add("captureJobs", jobs.length);
		budget -= jobs.length;
		for (const [key, table, column] of [
			["artifacts", "memory_artifacts", "source_path"],
			["summaries", "session_summaries", "id"],
		]) {
			if (budget === 0) break;
			const items = prepareTypedStatement<{ id: string }>(
				db,
				`SELECT ${column} AS id FROM ${table} t WHERE agent_id = ? AND ${table === "memory_artifacts" ? "COALESCE(NULLIF(session_key, ''),session_id)" : "session_key"} IN (?, ?) ${table === "memory_artifacts" ? "AND source_kind IN ('transcript','summary','compaction','manifest')" : ""}${evidenceRead("t").sql} LIMIT ?`,
			).all(input.agentId, input.sessionKey, `session:${input.sessionKey}`, ...evidenceRead("t").args, budget);
			for (const item of items) {
				if (table === "session_summaries") {
					db.prepare("DELETE FROM session_summary_children WHERE parent_id = ? OR child_id = ?").run(item.id, item.id);
					db.prepare("DELETE FROM session_summary_memories WHERE summary_id = ?").run(item.id);
					db.prepare("DELETE FROM memory_thread_heads WHERE agent_id = ? AND node_id = ?").run(input.agentId, item.id);
				}
				db.prepare(`DELETE FROM ${table} WHERE agent_id = ? AND ${column} = ?`).run(input.agentId, item.id);
			}
			add(key, items.length);
			budget -= items.length;
		}
		if (budget > 0) {
			db.prepare(
				"INSERT OR IGNORE INTO session_transcript_delete_files (agent_id,session_key,generation,path) VALUES (?,?,?,?)",
			).run(...scope, canonicalTranscriptPath(basePath, row.harness ?? "unknown"));
			phase = "files";
		}
	}
	db.prepare(
		"UPDATE session_transcript_deletions SET counts = ?, phase = ? WHERE agent_id = ? AND session_key = ?",
	).run(JSON.stringify(counts), phase, input.agentId, input.sessionKey);
	return deletionResult({ ...row, counts: JSON.stringify(counts), phase });
}

function fileCheckpoint(value: string | null): TranscriptFileCheckpoint | null {
	if (value === null) return null;
	const parsed: unknown = JSON.parse(value);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("inode" in parsed) ||
		typeof parsed.inode !== "number" ||
		!("device" in parsed) ||
		typeof parsed.device !== "number" ||
		!("outputInode" in parsed) ||
		typeof parsed.outputInode !== "number" ||
		!("offset" in parsed) ||
		typeof parsed.offset !== "number" ||
		!("bytes" in parsed) ||
		typeof parsed.bytes !== "number" ||
		!("records" in parsed) ||
		typeof parsed.records !== "number" ||
		!("ready" in parsed) ||
		typeof parsed.ready !== "boolean"
	)
		throw new Error("Invalid transcript cleanup checkpoint");
	return {
		inode: parsed.inode,
		device: parsed.device,
		outputInode: parsed.outputInode,
		offset: parsed.offset,
		bytes: parsed.bytes,
		records: parsed.records,
		ready: parsed.ready,
		line: "line" in parsed && typeof parsed.line === "string" ? parsed.line : null,
		prefixCount: "prefixCount" in parsed && typeof parsed.prefixCount === "number" ? parsed.prefixCount : 0,
		prefixHash: "prefixHash" in parsed && typeof parsed.prefixHash === "string" ? parsed.prefixHash : "0".repeat(64),
	};
}

export async function deleteSessionTranscriptOwned(
	db: WriteDb,
	input: TranscriptDeleteInput,
	basePath: string,
	transact: <T>(operation: () => T) => T | Promise<T>,
	deadlineAt: number,
): Promise<TranscriptDeleteResult> {
	const admitted = await transact(() => deleteSessionTranscriptInTx(db, input, basePath, deadlineAt));
	if (admitted.status !== "pending") return admitted;
	const prefix = transcriptDeletion(db, input.agentId, input.sessionKey);
	if (prefix?.phase === "prefix") {
		const stored = prepareTypedStatement<{ content: string; harness: string | null }>(
			db,
			"SELECT content,harness FROM session_transcripts WHERE agent_id = ? AND session_key = ?",
		).get(input.agentId, input.sessionKey);
		const turns = evidenceTurns(stored?.harness ?? "unknown", stored?.content ?? "", stored?.content);
		const receipt = prepareTypedStatement<{ record_count: number; record_hash: string }>(
			db,
			"SELECT record_count,record_hash FROM session_transcript_deleted_prefixes WHERE agent_id = ? AND session_key = ? AND generation = ? AND origin = 'row'",
		).get(input.agentId, input.sessionKey, prefix.receipt_generation);
		if (!receipt) throw new Error("Transcript prefix receipt disappeared");
		let count = receipt.record_count;
		let hash = receipt.record_hash;
		while (count < turns.length) {
			if (Date.now() >= deadlineAt - 350)
				return { ...deletionResult(prefix), pendingReason: "Prefix receipt budget exhausted" };
			await transact(() => {
				for (const turn of turns.slice(count, count + 512)) {
					hash = transcriptPrefix([turn], hash);
					db.prepare(
						"INSERT INTO session_transcript_deleted_positions (agent_id,session_key,generation,origin,position,record_hash) VALUES (?,?,?,'row',?,?)",
					).run(input.agentId, input.sessionKey, prefix.receipt_generation, ++count, hash);
				}
				db.prepare(
					"UPDATE session_transcript_deleted_prefixes SET record_count = ?,record_hash = ? WHERE agent_id = ? AND session_key = ? AND generation = ? AND origin = 'row'",
				).run(count, hash, input.agentId, input.sessionKey, prefix.receipt_generation);
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		await transact(() => {
			db.prepare("DELETE FROM session_transcripts WHERE agent_id = ? AND session_key = ?").run(
				input.agentId,
				input.sessionKey,
			);
			db.prepare(
				"UPDATE session_transcript_deletions SET phase = 'evidence' WHERE agent_id = ? AND session_key = ?",
			).run(input.agentId, input.sessionKey);
			deleteSessionTranscriptInTx(db, input, basePath, deadlineAt);
		});
	}
	for (let batch = 0; batch < 4; batch++) {
		const row = transcriptDeletion(db, input.agentId, input.sessionKey);
		if (!row) throw new Error("Deletion state disappeared");
		if (row.phase !== "files") return deletionResult(row);
		const file = prepareTypedStatement<{ path: string; checkpoint: string | null }>(
			db,
			"SELECT path,checkpoint FROM session_transcript_delete_files WHERE agent_id = ? AND session_key = ? AND generation = ? AND done = 0 ORDER BY path LIMIT 1",
		).get(input.agentId, input.sessionKey, row.receipt_generation);
		if (!file) {
			await transact(() => {
				db.prepare(
					"UPDATE session_transcript_deletions SET phase = 'complete', generation = generation + pending_start, blocked = CASE WHEN pending_start = 1 THEN 0 ELSE blocked END, ended = CASE WHEN pending_start = 1 THEN 0 ELSE ended END, opened_at = CASE WHEN pending_start = 1 THEN ? ELSE opened_at END, pending_start = 0 WHERE agent_id = ? AND session_key = ?",
				).run(new Date().toISOString(), input.agentId, input.sessionKey);
			});
			const completed = transcriptDeletion(db, input.agentId, input.sessionKey);
			if (!completed) throw new Error("Completed deletion disappeared");
			return deletionResult(completed);
		}
		if (Date.now() >= deadlineAt - 350) return { ...deletionResult(row), pendingReason: "Owner job budget exhausted" };
		try {
			const result = await redactTranscriptFileBatch({
				basePath,
				path: file.path,
				agentId: input.agentId,
				sessionKey: input.sessionKey,
				generation: row.receipt_generation,
				checkpoint: fileCheckpoint(file.checkpoint),
				onReplace: async () => {
					for (;;) {
						if (Date.now() >= deadlineAt - 350) throw new Error("Owner temp invalidation budget exhausted");
						const pending = prepareTypedStatement<{ agent_id: string; session_key: string; generation: number }>(
							db,
							"SELECT agent_id,session_key,generation FROM session_transcript_delete_files WHERE path = ? AND done = 0 AND checkpoint IS NOT NULL AND NOT (agent_id = ? AND session_key = ? AND generation = ?) LIMIT 64",
						).all(file.path, input.agentId, input.sessionKey, row.receipt_generation);
						for (const other of pending)
							await removeTranscriptDeletionTemp({
								basePath,
								path: file.path,
								agentId: other.agent_id,
								sessionKey: other.session_key,
								generation: other.generation,
							});
						await transact(() => {
							for (const other of pending)
								db.prepare(
									"UPDATE session_transcript_delete_files SET checkpoint = NULL WHERE agent_id = ? AND session_key = ? AND generation = ? AND path = ?",
								).run(other.agent_id, other.session_key, other.generation, file.path);
						});
						if (pending.length < 64) return;
						await new Promise<void>((resolve) => setImmediate(resolve));
					}
				},
				onPrefix:
					file.path !== canonicalTranscriptPath(basePath, row.harness ?? "unknown")
						? undefined
						: async (positions, reset) => {
								await transact(() => {
									db.prepare(
										"INSERT INTO session_transcript_deleted_prefixes (agent_id,session_key,generation,origin,record_count,record_hash) VALUES (?,?,?,?,0,?) ON CONFLICT(agent_id,session_key,generation,origin) DO NOTHING",
									).run(input.agentId, input.sessionKey, row.receipt_generation, file.path, transcriptPrefix([]));
									if (reset)
										db.prepare(
											"DELETE FROM session_transcript_deleted_positions WHERE agent_id = ? AND session_key = ? AND generation = ? AND origin = ?",
										).run(input.agentId, input.sessionKey, row.receipt_generation, file.path);
									for (const position of positions)
										db.prepare(
											"INSERT OR REPLACE INTO session_transcript_deleted_positions (agent_id,session_key,generation,origin,position,record_hash) VALUES (?,?,?,?,?,?)",
										).run(
											input.agentId,
											input.sessionKey,
											row.receipt_generation,
											file.path,
											position.position,
											position.hash,
										);
								});
							},
			});
			await transact(() => {
				if (file.path === canonicalTranscriptPath(basePath, row.harness ?? "unknown") && result.checkpoint?.ready)
					db.prepare(
						"INSERT INTO session_transcript_deleted_prefixes (agent_id,session_key,generation,origin,record_count,record_hash) VALUES (?,?,?,?,?,?) ON CONFLICT(agent_id,session_key,generation,origin) DO UPDATE SET record_count = excluded.record_count, record_hash = excluded.record_hash",
					).run(
						input.agentId,
						input.sessionKey,
						row.receipt_generation,
						file.path,
						result.checkpoint.prefixCount,
						result.checkpoint.prefixHash,
					);
				db.prepare(
					"UPDATE session_transcript_delete_files SET checkpoint = ?, done = ? WHERE agent_id = ? AND session_key = ? AND generation = ? AND path = ?",
				).run(
					result.checkpoint ? JSON.stringify(result.checkpoint) : null,
					Number(result.done),
					input.agentId,
					input.sessionKey,
					row.receipt_generation,
					file.path,
				);
				if (result.done) {
					const counts = deletionCounts(row.counts);
					counts.records = (counts.records ?? 0) + (result.checkpoint?.records ?? 0);
					counts.filePathsCleaned = (counts.filePathsCleaned ?? 0) + 1;
					db.prepare("UPDATE session_transcript_deletions SET counts = ? WHERE agent_id = ? AND session_key = ?").run(
						JSON.stringify(counts),
						input.agentId,
						input.sessionKey,
					);
				}
			});
		} catch (error) {
			logger.warn("transcripts", "Transcript byte cleanup pending", {
				agentId: input.agentId,
				sessionKey: input.sessionKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return { ...deletionResult(row), pendingReason: error instanceof Error ? error.message : String(error) };
		}
	}
	const row = transcriptDeletion(db, input.agentId, input.sessionKey);
	if (!row) throw new Error("Deletion state disappeared");
	return deletionResult(row);
}

export function canonicalizeTranscriptLookup(value: string): string {
	const trimmed = value.trim();
	return OMP_UUID_LIKE_SESSION_ID.test(trimmed) ? trimmed.replace(/:/g, "-") : trimmed;
}

export interface StoredTranscriptInfo {
	readonly sessionKey: string;
	readonly agentId: string;
	readonly content: string;
	readonly harness: string | null;
	readonly project: string | null;
	readonly createdAt: string;
	readonly updatedAt: string | null;
	readonly completedAt: string | null;
	readonly contentHash: string | null;
}

export interface SessionTranscriptUpsertOptions {
	readonly author?: WriteAuthor;
	readonly rawTranscript?: string;
	readonly completedAt?: string;
	readonly preserveExistingContent?: boolean;
	readonly signal?: AbortSignal;
}

export interface TranscriptHit {
	readonly sessionKey: string;
	readonly project: string | null;
	readonly updatedAt: string;
	readonly excerpt: string;
	readonly rank: number;
}

interface BackfillSeen {
	readonly classification: TranscriptSessionKeyClassification;
}

function createBackfillSeenReader(basePath: string, agentId?: string): (harness: string) => Promise<BackfillSeen> {
	const seen = new Map<string, Promise<BackfillSeen>>();
	return (harness: string) => {
		const key = sanitizeHarnessPath(harness);
		const existing = seen.get(key);
		if (existing) return existing;
		const loaded = readCanonicalTranscriptSessionKeys({ basePath, harness, agentId }).then((classification) => ({
			classification,
		}));
		seen.set(key, loaded);
		return loaded;
	};
}

function markBackfillCanonical(
	classification: TranscriptSessionKeyClassification,
	key: string,
	transcript: string,
): void {
	classification.liveOnlyKeys.delete(key);
	classification.canonicalKeys.add(key);
	classification.completedDigests.set(key, digestTranscriptTurns(transcriptTextToTurns(transcript)));
	classification.legacyLayoutKeys.delete(key);
}

function diagnoseCompletedMismatch(
	classification: TranscriptSessionKeyClassification,
	key: string,
	input: TranscriptIdentity & { readonly transcript: string },
): boolean {
	const completedDigest = classification.completedDigests.get(key);
	if (!completedDigest || completedDigest === digestTranscriptTurns(transcriptTextToTurns(input.transcript)))
		return false;
	if (
		classification.legacyLayoutKeys.has(key) &&
		completedDigest === digestTranscriptTurns(legacyTranscriptTurns(input.transcript))
	) {
		logger.info("transcripts", "Legacy completed transcript representation matches its source", {
			harness: input.harness,
			sessionKey: input.sessionKey,
			sourceFormat: input.sourceFormat,
			sourcePath: input.sourcePath,
		});
		return false;
	}
	logger.warn("transcripts", "Divergent completed transcript representation retained", {
		harness: input.harness,
		sessionKey: input.sessionKey,
		sourceFormat: input.sourceFormat,
		sourcePath: input.sourcePath,
	});
	return true;
}

function tableExists(name: string): boolean {
	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
		return getDbAccessor().withReadDb((db: ReadDb) => tableExistsInDatabase(db, name), "db:transcript.table.exists");
	} catch {
		return false;
	}
}

function sessionTranscriptsHasColumn(column: string): boolean {
	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
		return getDbAccessor().withReadDb((db: ReadDb) => {
			const cols = db.prepare("PRAGMA table_info(session_transcripts)").all<Record<string, unknown>>();
			return cols.some((col) => col.name === column);
		}, "db:transcript.column.exists");
	} catch {
		return false;
	}
}

function parseArtifactFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } | null {
	const text = content.replace(/\r\n?/g, "\n");
	if (!text.startsWith("---\n")) return null;
	const end = text.indexOf("\n---\n", 4);
	if (end === -1) return null;
	const frontmatter: Record<string, string> = {};
	for (const line of text.slice(4, end).split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const raw = line.slice(idx + 1).trim();
		if (raw === "null") continue;
		if (raw.startsWith('"')) {
			try {
				const parsed = JSON.parse(raw);
				if (typeof parsed === "string") frontmatter[key] = parsed;
				continue;
			} catch {
				frontmatter[key] = raw.slice(1, -1);
				continue;
			}
		}
		if (raw.length > 0) frontmatter[key] = raw;
	}
	return { frontmatter, body: text.slice(end + 5) };
}

async function backfillMarkdownTranscriptArtifacts(
	basePath: string,
	agentId: string | undefined,
	getSeen: (harness: string) => Promise<BackfillSeen>,
): Promise<number> {
	const memoryDir = resolveWorkspaceLayout(basePath).transcripts;
	if (!existsSync(memoryDir)) return 0;
	let failures = 0;
	const liveOnlyReplacements = new Map<
		string,
		Map<string, { readonly identity: TranscriptIdentity; readonly transcript: string }>
	>();
	const files = readdirSync(memoryDir).filter((name) => name.endsWith("--transcript.md"));
	for (const [i, name] of files.entries()) {
		const path = join(memoryDir, name);
		try {
			const parsed = parseArtifactFrontmatter(readFileSync(path, "utf8"));
			if (parsed?.frontmatter.kind !== "transcript") continue;
			const rowAgentId = parsed.frontmatter.agent_id || "default";
			if (agentId && rowAgentId !== agentId) continue;
			const harness = parsed.frontmatter.harness || "unknown";
			const input = {
				basePath,
				agentId: rowAgentId,
				harness,
				sessionKey: parsed.frontmatter.session_key || null,
				sessionId: parsed.frontmatter.session_id || null,
				project: parsed.frontmatter.project || null,
				capturedAt: parsed.frontmatter.captured_at || new Date().toISOString(),
				sourceFormat: "markdown" as const,
				sourcePath: `memory/${name}`,
				transcript: parsed.body,
			};
			const { classification } = await getSeen(harness);
			const key = sessionSeqCacheKey(input);
			if (classification.canonicalKeys.has(key)) {
				if (diagnoseCompletedMismatch(classification, key, input)) failures++;
				continue;
			}
			if (classification.liveOnlyKeys.has(key)) {
				const replacements =
					liveOnlyReplacements.get(harness) ||
					new Map<string, { readonly identity: TranscriptIdentity; readonly transcript: string }>();
				replacements.set(key, {
					identity: {
						agentId: input.agentId,
						harness: input.harness,
						sessionKey: input.sessionKey,
						sessionId: input.sessionId,
						sourceFormat: "markdown",
					},
					transcript: input.transcript,
				});
				liveOnlyReplacements.set(harness, replacements);
				continue;
			}
			if (await captureTranscriptOwned({ kind: "backfill", input })) {
				markBackfillCanonical(classification, key, input.transcript);
			}
		} catch (error) {
			failures++;
			logger.warn("transcripts", "Markdown transcript backfill failed", {
				error: error instanceof Error ? error.message : String(error),
				path,
			});
		}
		if (i > 0 && i % 100 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
	}
	for (const [harness, replacements] of liveOnlyReplacements.entries()) {
		if (replacements.size === 0) continue;
		const jsonlPath = canonicalTranscriptPath(basePath, harness);
		try {
			const entries = [...replacements.values()];
			const first = entries[0];
			if (!first) continue;
			const admitted = await captureTranscriptOwned({
				kind: "promotion",
				input: { basePath, agentId: first.identity.agentId, harness, sessionKey: null, replacements: entries },
			});
			const { classification } = await getSeen(harness);
			for (const key of admitted) {
				const replacement = replacements.get(key);
				if (replacement) markBackfillCanonical(classification, key, replacement.transcript);
			}
		} catch (error) {
			failures++;
			logger.warn("transcripts", "Markdown transcript backfill rewrite failed", {
				error: error instanceof Error ? error.message : String(error),
				harness,
				path: jsonlPath,
			});
		}
	}
	return failures;
}

async function backfillDatabaseTranscripts(
	basePath: string,
	agentId: string | undefined,
	getSeen: (harness: string) => Promise<BackfillSeen>,
): Promise<boolean> {
	if (!tableExists("session_transcripts")) return true;
	const PAGE_SIZE = 100;
	const liveOnlyReplacements = new Map<
		string,
		Map<string, { readonly identity: TranscriptIdentity; readonly transcript: string }>
	>();
	let mismatches = 0;
	try {
		let offset = 0;
		while (true) {
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
			const rows = getDbAccessor().withReadDb((db: ReadDb) => {
				const cols = db.prepare("PRAGMA table_info(session_transcripts)").all() as ReadonlyArray<
					Record<string, unknown>
				>;
				const hasUpdated = cols.some((col) => col.name === "updated_at");
				const agentFilter = !agentId
					? ""
					: agentId === "default"
						? "WHERE COALESCE(NULLIF(TRIM(agent_id), ''), 'default') = ?"
						: "WHERE agent_id = ?";
				const sql = hasUpdated
					? `SELECT session_key, content, harness, project, agent_id, created_at, updated_at
						FROM session_transcripts
						${agentFilter}
						ORDER BY agent_id, harness, session_key, rowid
						LIMIT ? OFFSET ?`
					: `SELECT session_key, content, harness, project, agent_id, created_at, NULL AS updated_at
						FROM session_transcripts
						${agentFilter}
						ORDER BY agent_id, harness, session_key, rowid
						LIMIT ? OFFSET ?`;
				const params = agentId ? [agentId, PAGE_SIZE, offset] : [PAGE_SIZE, offset];
				return db.prepare(sql).all(...params) as unknown as StoredTranscriptBackfillRow[];
			}, "db:transcript.backfill.page");
			if (rows.length === 0) break;
			for (const row of rows) {
				const rowAgentId = row.agent_id?.trim() || "default";
				if (agentId && rowAgentId !== agentId) continue;
				const harness = row.harness?.trim() || "unknown";
				const input = {
					basePath,
					agentId: rowAgentId,
					harness,
					sessionKey: row.session_key,
					project: row.project,
					capturedAt: row.updated_at || row.created_at || new Date().toISOString(),
					sourceFormat: "db" as const,
					transcript: row.content,
				};
				const { classification } = await getSeen(harness);
				const key = sessionSeqCacheKey(input);
				if (classification.canonicalKeys.has(key)) {
					if (diagnoseCompletedMismatch(classification, key, input)) mismatches++;
					continue;
				}
				if (classification.liveOnlyKeys.has(key)) {
					const replacements =
						liveOnlyReplacements.get(harness) ||
						new Map<string, { readonly identity: TranscriptIdentity; readonly transcript: string }>();
					replacements.set(key, {
						identity: {
							agentId: input.agentId,
							harness: input.harness,
							sessionKey: input.sessionKey,
							sourceFormat: "db",
						},
						transcript: input.transcript,
					});
					liveOnlyReplacements.set(harness, replacements);
					continue;
				}
				if (await captureTranscriptOwned({ kind: "backfill", input })) {
					markBackfillCanonical(classification, key, input.transcript);
				}
			}
			offset += PAGE_SIZE;
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		for (const [harness, replacements] of liveOnlyReplacements.entries()) {
			if (replacements.size === 0) continue;
			const entries = [...replacements.values()];
			const first = entries[0];
			if (!first) continue;
			const admitted = await captureTranscriptOwned({
				kind: "promotion",
				input: { basePath, agentId: first.identity.agentId, harness, sessionKey: null, replacements: entries },
			});
			const { classification } = await getSeen(harness);
			for (const key of admitted) {
				const replacement = replacements.get(key);
				if (replacement) markBackfillCanonical(classification, key, replacement.transcript);
			}
		}
	} catch (error) {
		logger.warn("transcripts", "Database transcript backfill failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
	return mismatches === 0;
}

const BACKFILL_MARKER = ".canonical-transcript-backfill-v1";

function markerScope(agentId?: string): string {
	return (agentId?.trim() || "all").replace(/[^a-zA-Z0-9._-]+/g, "-") || "default";
}

function getMarkerPath(basePath: string, agentId?: string): string {
	return join(resolveWorkspaceLayout(basePath).transcripts, `${BACKFILL_MARKER}.${markerScope(agentId)}`);
}

function markerMatches(path: string, agentId?: string): boolean {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { readonly agent_id?: unknown };
		return parsed.agent_id === (agentId?.trim() || "*");
	} catch (error) {
		logger.warn("transcripts", "Ignoring invalid transcript backfill marker", {
			error: error instanceof Error ? error.message : String(error),
			path,
		});
		return false;
	}
}

export function ensureCanonicalTranscriptHistory(basePath: string, agentId?: string): Promise<void> {
	const key = `${basePath}:${agentId ?? "*"}`;
	if (canonicalBackfills.has(key)) return Promise.resolve();
	const running = canonicalBackfillRuns.get(key);
	if (running) return running;
	const retry = canonicalBackfillRetries.get(key);
	if (retry && Date.now() < retry.retryAt) return Promise.resolve();
	const run = runCanonicalTranscriptBackfill(key, basePath, agentId).finally(() => {
		canonicalBackfillRuns.delete(key);
	});
	canonicalBackfillRuns.set(key, run);
	return run;
}

async function runCanonicalTranscriptBackfill(key: string, basePath: string, agentId?: string): Promise<void> {
	let incomplete: CanonicalBackfillGap | null = { threw: true };
	try {
		incomplete = await backfillCanonicalTranscriptHistory(basePath, agentId);
	} finally {
		if (incomplete) {
			deferCanonicalBackfillRetry(key, basePath, agentId, incomplete);
		} else {
			canonicalBackfills.add(key);
			canonicalBackfillRetries.delete(key);
		}
	}
}

function deferCanonicalBackfillRetry(
	key: string,
	basePath: string,
	agentId: string | undefined,
	gap: CanonicalBackfillGap,
): void {
	const attempts = (canonicalBackfillRetries.get(key)?.attempts ?? 0) + 1;
	const retryInMs = Math.min(CANONICAL_BACKFILL_RETRY_BASE_MS * 2 ** (attempts - 1), CANONICAL_BACKFILL_RETRY_MAX_MS);
	canonicalBackfillRetries.set(key, { attempts, retryAt: Date.now() + retryInMs });
	logger.warn("transcripts", "Canonical transcript backfill incomplete; retry deferred", {
		agentId: agentId ?? "*",
		basePath,
		...gap,
		attempts,
		retryInMs,
	});
}

async function backfillCanonicalTranscriptHistory(
	basePath: string,
	agentId?: string,
): Promise<CanonicalBackfillGap | null> {
	const markerPath = getMarkerPath(basePath, agentId);
	if (existsSync(markerPath) && markerMatches(markerPath, agentId)) return null;

	const getSeen = createBackfillSeenReader(basePath, agentId);
	const markdownFailures = await backfillMarkdownTranscriptArtifacts(basePath, agentId, getSeen);
	const databaseOk = await backfillDatabaseTranscripts(basePath, agentId, getSeen);
	if (markdownFailures > 0 || !databaseOk) return { markdownFailures, databaseOk };
	return writeMarker(markerPath, agentId) ? null : { markerWritten: false };
}

function writeMarker(markerPath: string, agentId?: string): boolean {
	try {
		mkdirSync(dirname(markerPath), { recursive: true });
		writeFileSync(
			markerPath,
			JSON.stringify({ completed_at: new Date().toISOString(), agent_id: agentId ?? "*" }),
			"utf8",
		);
		return true;
	} catch (error) {
		logger.warn("transcripts", "Failed to write backfill marker", {
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

function hasUpdatedAt(): boolean {
	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
		return getDbAccessor().withReadDb((db: ReadDb) => {
			const cols = db.prepare("PRAGMA table_info(session_transcripts)").all<Record<string, unknown>>();
			return cols.some((col) => col.name === "updated_at");
		}, "db:transcript.updated-at.exists");
	} catch {
		return false;
	}
}

function cleanExcerpt(text: string): string {
	return text
		.replace(/^(?:Human|User|Assistant):\s*/gim, "")
		.replace(/\s+/g, " ")
		.trim();
}

function buildExcerpt(content: string, query: string): string {
	const base = cleanExcerpt(content);
	if (base.length <= 220) return base;

	const terms = query
		.toLowerCase()
		.split(/\W+/)
		.filter((term) => term.length >= 3)
		.slice(0, 8);
	const lower = base.toLowerCase();

	for (const term of terms) {
		const idx = lower.indexOf(term);
		if (idx === -1) continue;
		const start = Math.max(0, idx - 90);
		const end = Math.min(base.length, idx + 130);
		const prefix = start > 0 ? "..." : "";
		const suffix = end < base.length ? "..." : "";
		return `${prefix}${base.slice(start, end).trim()}${suffix}`;
	}

	return `${base.slice(0, 217).trim()}...`;
}

export function upsertSessionTranscript(
	sessionKey: string,
	transcript: string,
	harness: string,
	project: string | null,
	agentId: string,
	capturedAt?: string,
	accessor?: DbAccessor,
	options?: SessionTranscriptUpsertOptions,
): boolean {
	if (sessionKey.trim().length === 0 || transcript.trim().length === 0) return false;

	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
		return (accessor ?? getDbAccessor()).withWriteTx((db: WriteDb) => {
			return (
				writeSessionTranscriptRow(db, { sessionKey, transcript, harness, project, agentId, capturedAt, ...options }) ===
				"written"
			);
		}, "db:transcript.row.upsert");
	} catch (error) {
		logger.warn("transcripts", "Transcript upsert failed", {
			error: error instanceof Error ? error.message : String(error),
			sessionKey,
		});
		return false;
	}
}

export type SessionTranscriptWriteInput = Omit<SessionTranscriptUpsertOptions, "signal"> & {
	readonly sessionKey: string;
	readonly transcript: string;
	readonly harness: string;
	readonly project: string | null;
	readonly agentId: string;
	readonly capturedAt?: string;
	readonly sameProjectOnly?: boolean;
	readonly append?: boolean;
};

export function writeSessionTranscriptRow(
	db: WriteDb,
	input: SessionTranscriptWriteInput,
): "written" | "skipped" | "conflict" {
	const { sessionKey, harness, project, agentId, capturedAt } = input;
	const transcript = input.append ? input.transcript : filterTranscriptRecordsInDb(db, input);
	if (sessionKey.trim().length === 0 || transcript.trim().length === 0) return "skipped";
	if (!tableExistsInDatabase(db, "session_transcripts")) return "skipped";
	if (!admitSessionTranscriptInDb(db, { ...input, live: input.append === true })) return "skipped";
	if (input.sameProjectOnly) {
		const owner = db
			.prepare(
				"SELECT COALESCE(project, '') AS project FROM session_transcripts WHERE session_key = ? AND agent_id = ?",
			)
			.get(sessionKey, agentId) as { project: string } | null | undefined;
		if (owner != null && owner.project !== (project ?? "")) return "conflict";
	}
	const existing =
		input.append || input.preserveExistingContent ? readExactTranscriptContent(db, sessionKey, agentId) : undefined;
	const retainedTranscript = input.append
		? [existing?.trimEnd(), transcript.trim()].filter((part) => part && part.trim().length > 0).join("\n")
		: mergeTranscriptContent(existing ?? "", transcript);
	const now = capturedAt ?? new Date().toISOString();
	const cols = db.prepare("PRAGMA table_info(session_transcripts)").all<Record<string, unknown>>();
	const hasUpdated = cols.some((col) => col.name === "updated_at");
	const hasCompleted = cols.some((col) => col.name === "completed_at");
	const hasHash = cols.some((col) => col.name === "content_hash");
	const contentHash = createHash("sha256").update(retainedTranscript).digest("hex");
	const previous = prepareTypedStatement<{ speaker_user_id: string | null }>(
		db,
		"SELECT speaker_user_id FROM session_transcripts WHERE agent_id=? AND session_key=?",
	).get(agentId, sessionKey);
	if (input.author && previous?.speaker_user_id && previous.speaker_user_id !== input.author.userId) return "conflict";
	const speakerUserId = input.author?.userId ?? previous?.speaker_user_id ?? null;
	const insertColumns = ["session_key", "content", "harness", "project", "agent_id", "created_at", "compartment_id"];
	const values: unknown[] = [
		sessionKey,
		retainedTranscript,
		harness,
		project,
		agentId,
		now,
		compartmentForWrite(db, { agentId, sessionKey }),
	];
	const updates = [
		"content = excluded.content",
		"harness = excluded.harness",
		"project = COALESCE(excluded.project, session_transcripts.project)",
		"agent_id = excluded.agent_id",
		"compartment_id = excluded.compartment_id",
	];
	insertColumns.push("speaker_user_id");
	values.push(speakerUserId);
	updates.push("speaker_user_id = COALESCE(session_transcripts.speaker_user_id,excluded.speaker_user_id)");
	const sameContent = hasHash
		? "(session_transcripts.content_hash = excluded.content_hash OR (session_transcripts.content_hash IS NULL AND session_transcripts.content = excluded.content))"
		: "session_transcripts.content = excluded.content";
	if (hasUpdated) {
		insertColumns.push("updated_at");
		values.push(now);
		updates.push(
			`updated_at = CASE WHEN ${sameContent} THEN session_transcripts.updated_at ELSE excluded.updated_at END`,
		);
	}
	if (hasCompleted) {
		insertColumns.push("completed_at");
		values.push(input.completedAt ?? null);
		updates.push(
			input.completedAt
				? "completed_at = CASE WHEN session_transcripts.completed_at IS NULL THEN excluded.completed_at ELSE session_transcripts.completed_at END"
				: `completed_at = CASE WHEN ${sameContent} THEN session_transcripts.completed_at ELSE NULL END`,
		);
	}
	if (hasHash) {
		insertColumns.push("content_hash");
		values.push(contentHash);
		updates.push("content_hash = excluded.content_hash");
	}
	db.prepare(
		`INSERT INTO session_transcripts (${insertColumns.join(", ")})
		 VALUES (${insertColumns.map(() => "?").join(", ")})
		 ON CONFLICT(agent_id, session_key) DO UPDATE SET ${updates.join(", ")}`,
	).run(...values);
	return "written";
}

export async function upsertSessionTranscriptAsync(
	sessionKey: string,
	transcript: string,
	harness: string,
	project: string | null,
	agentId: string,
	capturedAt?: string,
	accessor: DbAccessor = getDbAccessor(),
	options?: SessionTranscriptUpsertOptions,
): Promise<boolean> {
	if (sessionKey.trim().length === 0 || transcript.trim().length === 0) return false;

	try {
		return await writeSessionTranscriptAsync(
			{ sessionKey, transcript, harness, project, agentId, capturedAt, ...options },
			accessor,
		);
	} catch (error) {
		if (options?.signal?.aborted) throw error;
		logger.warn("transcripts", "Async transcript upsert failed", {
			error: error instanceof Error ? error.message : String(error),
			sessionKey,
		});
		return false;
	}
}

export async function appendSessionTranscriptAsync(
	input: {
		readonly author: WriteAuthor;
		readonly sessionKey: string;
		readonly agentId: string;
		readonly harness: string;
		readonly project: string | null;
		readonly transcript: string;
	},
	accessor: DbAccessor = getDbAccessor(),
): Promise<void> {
	const author = requireWriteAuthor(input.author);
	const written = await writeSessionTranscriptAsync(
		{ ...input, author, append: true, capturedAt: new Date().toISOString() },
		accessor,
	);
	if (!written) throw new Error("Transcript append did not write a row");
}

async function writeSessionTranscriptAsync(
	input: SessionTranscriptWriteInput & { readonly signal?: AbortSignal },
	accessor: DbAccessor,
): Promise<boolean> {
	const { signal, ...write } = input;
	return (
		(await dbOwnerWriteSessionTranscript(await getDbOwnerForAccessor(accessor), write, {
			operation: "transcripts.upsert",
			signal,
		})) === "written"
	);
}

function readExactTranscriptContent(db: WriteDb, sessionKey: string, agentId: string): string | undefined {
	const row = db
		.prepare("SELECT content FROM session_transcripts WHERE session_key = ? AND agent_id = ?")
		.get(sessionKey, agentId) as { content?: string } | null | undefined;
	return row?.content;
}

function mergeTranscriptContent(existing: string, incoming: string): string {
	if (existing.length === 0) return incoming;
	if (incoming.length === 0 || existing === incoming || existing.includes(incoming)) return existing;
	if (incoming.includes(existing)) return incoming;
	return `${existing}\n${incoming}`;
}
export function markSessionTranscriptCompletedInTx(
	db: WriteDb,
	sessionKey: string,
	agentId: string,
	completedAt: string,
): boolean {
	updateTranscriptLifecycleInTx(db, { agentId, sessionKey, action: "end" });
	const columns = db.prepare("PRAGMA table_info(session_transcripts)").all<Record<string, unknown>>();
	if (!columns.some((column) => column.name === "completed_at")) return false;
	const hasUpdated = columns.some((column) => column.name === "updated_at");
	const set = hasUpdated ? "completed_at = ?, updated_at = ?" : "completed_at = ?";
	const args = hasUpdated ? [completedAt, completedAt, sessionKey, agentId] : [completedAt, sessionKey, agentId];
	const result = db
		.prepare(`UPDATE session_transcripts SET ${set} WHERE session_key = ? AND agent_id = ? AND completed_at IS NULL`)
		.run(...args);
	return result.changes > 0;
}
export function markSessionTranscriptCompleted(
	sessionKey: string,
	agentId: string,
	completedAt = new Date().toISOString(),
	accessor?: DbAccessor,
): boolean {
	if (sessionKey.trim().length === 0 || agentId.trim().length === 0) return false;
	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
		return (accessor ?? getDbAccessor()).withWriteTx((db: WriteDb) => {
			if (!tableExistsInDatabase(db, "session_transcripts")) return false;
			return markSessionTranscriptCompletedInTx(db, sessionKey, agentId, completedAt);
		}, "db:transcript.row.complete");
	} catch (error) {
		logger.warn("transcripts", "Transcript completion marker failed", {
			error: error instanceof Error ? error.message : String(error),
			sessionKey,
		});
		return false;
	}
}

function tableExistsInDatabase(
	db: { prepare(sql: string): { get(...args: unknown[]): unknown } },
	table: string,
): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null;
}
export function getStoredSessionTranscriptInfo(sessionKey: string, agentId: string): StoredTranscriptInfo | undefined {
	if (!tableExists("session_transcripts")) return undefined;
	const aliases = [...new Set([sessionKey, canonicalizeTranscriptLookup(sessionKey)])];
	const placeholders = aliases.map(() => "?").join(", ");
	const hasUpdated = hasUpdatedAt();
	const hasCompleted = sessionTranscriptsHasColumn("completed_at");
	const hasHash = sessionTranscriptsHasColumn("content_hash");
	const updatedAtExpr = hasUpdated ? "updated_at" : "NULL AS updated_at";
	const completedAtExpr = hasCompleted ? "completed_at" : "NULL AS completed_at";
	const contentHashExpr = hasHash ? "content_hash" : "NULL AS content_hash";
	const seenExpr = hasUpdated ? "COALESCE(updated_at, created_at)" : "created_at";
	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
		return getDbAccessor().withReadDb((db: ReadDb) => {
			const row = db
				.prepare(
					`SELECT session_key, agent_id, content, harness, project, created_at, ${updatedAtExpr}, ${completedAtExpr}, ${contentHashExpr}
					 FROM session_transcripts
					 WHERE agent_id = ? AND session_key IN (${placeholders})
					 ORDER BY CASE WHEN session_key = ? THEN 0 ELSE 1 END, ${seenExpr} DESC
					 LIMIT 1`,
				)
				.get(agentId, ...aliases, sessionKey) as
				| {
						session_key: string;
						agent_id: string;
						content: string;
						harness: string | null;
						project: string | null;
						created_at: string;
						updated_at?: string | null;
						completed_at?: string | null;
						content_hash?: string | null;
				  }
				| undefined;
			if (!row) return undefined;
			return {
				sessionKey: row.session_key,
				agentId: row.agent_id,
				content: row.content,
				harness: row.harness,
				project: row.project,
				createdAt: row.created_at,
				updatedAt: row.updated_at ?? null,
				completedAt: row.completed_at ?? null,
				contentHash: row.content_hash ?? null,
			};
		}, "db:transcript.info.read");
	} catch {
		return undefined;
	}
}

function readStoredSessionTranscriptInfo(
	db: ReadDb,
	sessionKey: string,
	agentId: string,
): StoredTranscriptInfo | undefined {
	const aliases = [...new Set([sessionKey, canonicalizeTranscriptLookup(sessionKey)])];
	const placeholders = aliases.map(() => "?").join(", ");
	const cols = db.prepare("PRAGMA table_info(session_transcripts)").all<Record<string, unknown>>();
	const hasUpdated = cols.some((col) => col.name === "updated_at");
	const hasCompleted = cols.some((col) => col.name === "completed_at");
	const hasHash = cols.some((col) => col.name === "content_hash");
	const updatedAtExpr = hasUpdated ? "updated_at" : "NULL AS updated_at";
	const completedAtExpr = hasCompleted ? "completed_at" : "NULL AS completed_at";
	const contentHashExpr = hasHash ? "content_hash" : "NULL AS content_hash";
	const seenExpr = hasUpdated ? "COALESCE(updated_at, created_at)" : "created_at";
	const row = db
		.prepare(
			`SELECT session_key, agent_id, content, harness, project, created_at, ${updatedAtExpr}, ${completedAtExpr}, ${contentHashExpr}
			 FROM session_transcripts
			 WHERE agent_id = ? AND session_key IN (${placeholders})
			 ORDER BY CASE WHEN session_key = ? THEN 0 ELSE 1 END, ${seenExpr} DESC
			 LIMIT 1`,
		)
		.get(agentId, ...aliases, sessionKey) as
		| {
				session_key: string;
				agent_id: string;
				content: string;
				harness: string | null;
				project: string | null;
				created_at: string;
				updated_at?: string | null;
				completed_at?: string | null;
				content_hash?: string | null;
		  }
		| undefined;
	if (!row) return undefined;
	return {
		sessionKey: row.session_key,
		agentId: row.agent_id,
		content: row.content,
		harness: row.harness,
		project: row.project,
		createdAt: row.created_at,
		updatedAt: row.updated_at ?? null,
		completedAt: row.completed_at ?? null,
		contentHash: row.content_hash ?? null,
	};
}
export async function getStoredSessionTranscriptInfoAsync(
	sessionKey: string,
	agentId: string,
	accessor: DbAccessor = getDbAccessor(),
	signal?: AbortSignal,
): Promise<StoredTranscriptInfo | undefined> {
	if (sessionKey.trim().length === 0 || agentId.trim().length === 0) return undefined;
	try {
		return await accessor.withReadDbAsync(
			(db) => {
				if (!tableExistsInDatabase(db, "session_transcripts")) return undefined;
				return readStoredSessionTranscriptInfo(db, sessionKey, agentId);
			},
			{ siteToken: "db:transcript.info.read-async", operation: "transcripts.lookup", signal },
		);
	} catch (error) {
		if (signal?.aborted) throw error;
		return undefined;
	}
}

export function getSessionTranscriptContent(
	sessionKey: string,
	agentId: string,
	project: string | undefined,
): string | undefined {
	if (!tableExists("session_transcripts")) return undefined;
	const aliases = [...new Set([sessionKey, canonicalizeTranscriptLookup(sessionKey)])];
	const placeholders = aliases.map(() => "?").join(", ");
	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
		return getDbAccessor().withReadDb((db: ReadDb) => {
			const row = db
				.prepare(
					`SELECT content FROM session_transcripts
					 WHERE agent_id = ? AND session_key IN (${placeholders})${project === undefined ? "" : " AND project = ?"}
					 ORDER BY CASE WHEN session_key = ? THEN 0 ELSE 1 END, ${hasUpdatedAt() ? "COALESCE(updated_at, created_at)" : "created_at"} DESC
					 LIMIT 1`,
				)
				.get(agentId, ...aliases, ...(project === undefined ? [] : [project]), sessionKey) as
				| { content: string }
				| undefined;
			return row?.content;
		}, "db:transcript.content.read");
	} catch {
		return undefined;
	}
}

export interface StaleLiveSession {
	sessionKey: string;
	agentId: string;
	harness: string | null;
	project: string | null;
	content: string;
	lastActivityAt: string;
}
export function findStaleLiveSessions(staleOlderThanMs: number, limit = 50): StaleLiveSession[] {
	if (staleOlderThanMs <= 0 || !tableExists("session_transcripts") || !sessionTranscriptsHasColumn("completed_at"))
		return [];
	const cutoff = new Date(Date.now() - staleOlderThanMs).toISOString();
	const lastActivity = hasUpdatedAt() ? "updated_at" : "created_at";
	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
		return getDbAccessor().withReadDb((db: ReadDb) => {
			const rows = db
				.prepare(
					`SELECT session_key, agent_id, harness, project, content, ${lastActivity} AS last_activity
					 FROM session_transcripts
					 WHERE ${lastActivity} < ?
					   AND completed_at IS NULL
					   AND length(content) > 0
					 ORDER BY ${lastActivity} ASC
					 LIMIT ?`,
				)
				.all(cutoff, limit) as Array<{
				session_key: string;
				agent_id: string;
				harness: string | null;
				project: string | null;
				content: string;
				last_activity: string;
			}>;
			return rows.map((row) => ({
				sessionKey: row.session_key,
				agentId: row.agent_id,
				harness: row.harness,
				project: row.project,
				content: row.content,
				lastActivityAt: row.last_activity,
			}));
		}, "db:transcript.stale.list");
	} catch {
		return [];
	}
}

export function searchTranscriptFallback(params: {
	readonly query: string;
	readonly agentId: string;
	readonly sessionKey?: string;
	readonly project?: string;
	readonly limit: number;
	readonly allowScanFallback?: boolean;
}): TranscriptHit[] {
	const limit = Math.max(1, Math.min(8, Math.trunc(params.limit)));
	if (!tableExists("session_transcripts")) return [];

	const seenExpr = hasUpdatedAt() ? "COALESCE(st.updated_at, st.created_at)" : "st.created_at";
	const sameProject = (project: string | null): number =>
		params.project && project && params.project === project ? 0 : 1;
	const exactQuery = params.query.trim();
	if (exactQuery.length > 0) {
		const aliases = [...new Set([exactQuery, canonicalizeTranscriptLookup(exactQuery)])];
		const hasSessionId = sessionTranscriptsHasColumn("session_id");
		const placeholders = aliases.map(() => "?").join(", ");
		const keyPredicates = [`st.session_key IN (${placeholders})`];
		if (hasSessionId) keyPredicates.push(`st.session_id IN (${placeholders})`);
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
		const exactRows: TranscriptRow[] = getDbAccessor().withReadDb((db: ReadDb) => {
			const args: unknown[] = [
				params.agentId,
				...aliases,
				...(hasSessionId ? aliases : []),
				exactQuery,
				params.project ?? "",
				limit,
			];
			return db
				.prepare(
					[
						`SELECT st.session_key, st.project, ${seenExpr} AS seen_at, st.content, 0 AS rank`,
						"FROM session_transcripts st",
						"WHERE st.agent_id = ?",
						`AND (${keyPredicates.join(" OR ")})`,
						`ORDER BY CASE WHEN st.session_key = ? THEN 0 ELSE 1 END, CASE WHEN st.project = ? THEN 0 ELSE 1 END, ${seenExpr} DESC LIMIT ?`,
					].join("\n"),
				)
				.all(...args) as unknown as TranscriptRow[];
		}, "db:transcript.search.exact");
		if (exactRows.length > 0) {
			return exactRows
				.map((row) => ({
					sessionKey: row.session_key,
					project: row.project,
					updatedAt: row.seen_at,
					excerpt: buildExcerpt(typeof row.content === "string" ? row.content : "", params.query),
					rank: 0,
				}))
				.sort((a, b) => sameProject(a.project) - sameProject(b.project))
				.slice(0, limit);
		}
	}

	try {
		if (tableExists("session_transcripts_fts")) {
			const anchors = extractAnchorTerms(params.query)
				.map((term) => term.replace(/[_:/.-]+/g, " "))
				.join(" ");
			const ftsQueries = [...new Set([sanitizeFtsQuery(params.query), sanitizeFtsQuery(anchors)].filter(Boolean))];
			for (const fts of ftsQueries) {
				try {
					const rows: TranscriptRow[] =
						// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
						getDbAccessor().withReadDb((db: ReadDb) => {
							const parts = [
								`SELECT st.session_key, st.project, ${seenExpr} AS seen_at,`,
								`snippet(session_transcripts_fts, 0, '', '', ' … ', 18) AS excerpt,`,
								"bm25(session_transcripts_fts) AS rank",
								"FROM session_transcripts_fts",
								"JOIN session_transcripts st ON st.rowid = session_transcripts_fts.rowid",
								"WHERE session_transcripts_fts MATCH ?",
								"AND st.agent_id = ?",
							];
							const args: unknown[] = [fts, params.agentId];
							if (params.sessionKey) {
								parts.push("AND st.session_key != ?");
								args.push(params.sessionKey);
							}
							parts.push(`ORDER BY rank ASC, ${seenExpr} DESC LIMIT ?`);
							args.push(limit * 2);
							return db.prepare(parts.join("\n")).all(...args) as unknown as TranscriptRow[];
						}, "db:transcript.search.fts");

					const hits = rows
						.map((row) => ({
							sessionKey: row.session_key,
							project: row.project,
							updatedAt: row.seen_at,
							excerpt: buildExcerpt(typeof row.excerpt === "string" ? row.excerpt : "", params.query),
							rank: typeof row.rank === "number" ? row.rank : 0,
						}))
						.filter((row) => row.excerpt.length > 0)
						.sort((a, b) => sameProject(a.project) - sameProject(b.project) || a.rank - b.rank)
						.slice(0, limit);
					if (hits.length > 0) return hits;
				} catch (error) {
					logger.warn(
						"transcripts",
						params.allowScanFallback === false
							? "Transcript FTS query failed, skipping scan fallback"
							: "Transcript FTS query failed, falling back to LIKE",
						{
							error: error instanceof Error ? error.message : String(error),
						},
					);
				}
			}
		}
	} catch (error) {
		logger.warn("transcripts", "Transcript FTS table check failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	if (params.allowScanFallback === false) return [];

	const words = params.query
		.toLowerCase()
		.split(/\W+/)
		.filter((term) => term.length >= 3)
		.slice(0, 5);
	const anchors = extractAnchorTerms(params.query).slice(0, 5);
	const terms = anchors.length > 0 ? anchors : words;
	if (terms.length === 0) return [];

	try {
		const rows: TranscriptRow[] =
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
			getDbAccessor().withReadDb((db: ReadDb) => {
				const score = terms.map(() => "CASE WHEN LOWER(st.content) LIKE ? THEN 1 ELSE 0 END").join(" + ");
				const any = terms.map(() => "LOWER(st.content) LIKE ?").join(" OR ");
				const parts = [
					`SELECT st.session_key, st.project, ${seenExpr} AS seen_at, st.content, ${score} AS rank`,
					"FROM session_transcripts st",
					"WHERE st.agent_id = ?",
				];
				const args: unknown[] = [];
				for (const term of terms) {
					args.push(`%${term}%`);
				}
				args.push(params.agentId);
				if (params.sessionKey) {
					parts.push("AND st.session_key != ?");
					args.push(params.sessionKey);
				}
				parts.push(`AND (${any})`);
				for (const term of terms) {
					args.push(`%${term}%`);
				}
				parts.push(`ORDER BY rank DESC, ${seenExpr} DESC LIMIT ?`);
				args.push(limit);
				return db.prepare(parts.join("\n")).all(...args) as unknown as TranscriptRow[];
			}, "db:transcript.search.like");

		return rows
			.map((row) => ({
				sessionKey: row.session_key,
				project: row.project,
				updatedAt: row.seen_at,
				excerpt: buildExcerpt(typeof row.content === "string" ? row.content : "", params.query),
				rank: typeof row.rank === "number" ? row.rank : 0,
			}))
			.filter((row) => row.excerpt.length > 0)
			.sort((a, b) => sameProject(a.project) - sameProject(b.project) || b.rank - a.rank)
			.slice(0, limit);
	} catch (error) {
		logger.warn("transcripts", "Transcript fallback search failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}
