import { randomUUID } from "node:crypto";
import type {
	DbOwnerVectorRepairInput,
	DbOwnerVectorRepairOperation,
	DbOwnerVectorRepairPhase,
	DbOwnerVectorRepairResult,
} from "./db-owner-protocol";
import { VECTOR_REPAIR_MAX_BYTES_PER_BATCH, VECTOR_REPAIR_MAX_ROWS_PER_BATCH } from "./db-owner-protocol";

interface SqliteStatement {
	all(...params: readonly unknown[]): unknown[];
	get(...params: readonly unknown[]): unknown;
	run(...params: readonly unknown[]): { readonly changes?: number };
}

export interface VectorRepairDb {
	prepare(sql: string): SqliteStatement;
}

interface CheckpointRow {
	readonly operation: DbOwnerVectorRepairOperation;
	readonly agent_id: string;
	readonly checkpoint_id: string;
	readonly phase: DbOwnerVectorRepairPhase;
	readonly cursor: string | null;
	readonly processed: number;
	readonly skipped: number;
	readonly failed: number;
	readonly affected: number;
	readonly remaining: number;
	readonly status: "running" | "complete" | "failed";
	readonly last_error: string | null;
}

interface CandidateRow {
	readonly id: string;
	readonly vector_bytes?: number;
	readonly dimensions?: number;
}

interface BatchCounters {
	batchRows: number;
	batchBytes: number;
	batchProcessed: number;
	batchSkipped: number;
	batchFailed: number;
	batchAffected: number;
}

/** Raised by an inline test owner when the request signal is already aborted. */
export class VectorRepairAbortError extends Error {
	constructor(message = "vector repair owner job was cancelled") {
		super(message);
		this.name = "DB_OWNER_CANCELLED";
	}
}

export interface VectorRepairOwnerOptions {
	readonly shouldAbort?: () => boolean;
}

const INITIAL_PHASE: Record<DbOwnerVectorRepairOperation, DbOwnerVectorRepairPhase> = {
	resync: "missing-vectors",
	"clean-orphans": "orphan-embeddings",
};

function numberValue(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function changes(result: unknown): number {
	return Math.max(0, Math.floor(numberValue((result as { changes?: unknown } | null)?.changes)));
}

function nowIso(): string {
	return new Date().toISOString();
}

function normalizeAgentId(agentId: string): string {
	const normalized = agentId.trim();
	if (normalized.length === 0) throw new Error("vector repair requires a resolved agent id");
	return normalized;
}

function boundedBatchSize(value: number | undefined): number {
	if (value === undefined) return VECTOR_REPAIR_MAX_ROWS_PER_BATCH;
	if (!Number.isFinite(value) || value <= 0) throw new RangeError("vector repair batch size must be positive");
	return Math.max(1, Math.min(VECTOR_REPAIR_MAX_ROWS_PER_BATCH, Math.floor(value)));
}

function boundedVectorBytes(value: number | undefined): number {
	if (value === undefined) return VECTOR_REPAIR_MAX_BYTES_PER_BATCH;
	if (!Number.isFinite(value) || value <= 0) throw new RangeError("vector repair byte budget must be positive");
	return Math.max(1, Math.min(VECTOR_REPAIR_MAX_BYTES_PER_BATCH, Math.floor(value)));
}

function operationId(operation: DbOwnerVectorRepairOperation, phase: DbOwnerVectorRepairPhase): string {
	if (operation === "clean-orphans") return "repair.vector-clean.orphan-embeddings";
	if (phase === "orphan-vectors") return "repair.vector-resync.orphan-vectors";
	return "repair.vector-resync.missing-vectors";
}

function tableExists(db: VectorRepairDb, name: string): boolean {
	return db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

function vectorLookupTable(db: VectorRepairDb): "vec_embeddings" | "vec_embeddings_rowids" {
	return tableExists(db, "vec_embeddings_rowids") ? "vec_embeddings_rowids" : "vec_embeddings";
}

function vectorTableDimensions(db: VectorRepairDb): number | null {
	const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_embeddings'").get() as
		| { sql?: unknown }
		| undefined;
	if (typeof row?.sql !== "string") return null;
	const match = row.sql.match(/\bembedding\s+FLOAT\s*\[\s*(\d+)\s*\]/i);
	if (match === null) return null;
	const dimensions = Number.parseInt(match[1] ?? "", 10);
	return Number.isInteger(dimensions) && dimensions > 0 ? dimensions : null;
}

function byteLength(value: unknown): number | null {
	if (value instanceof ArrayBuffer) return value.byteLength;
	if (ArrayBuffer.isView(value)) return value.byteLength;
	return null;
}

function blobForInsert(value: unknown): Buffer | null {
	if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
	if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	return null;
}

function containsNonFiniteFloat32(value: Uint8Array): boolean {
	if (value.byteLength === 0 || value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return false;
	const copy = new Uint8Array(value.byteLength);
	copy.set(value);
	return new Float32Array(copy.buffer).some((number) => !Number.isFinite(number));
}

function quarantineVector(db: VectorRepairDb, id: string, dimensions: number, reason: string): void {
	if (!tableExists(db, "vec_embeddings_quarantine")) return;
	db.prepare(
		`INSERT OR REPLACE INTO vec_embeddings_quarantine (rowid, dimensions, reason, quarantinedAt)
		 VALUES (?, ?, ?, ?)`,
	).run(id, Math.max(0, Math.floor(dimensions)), reason, nowIso());
}

function cursorPredicate(
	alias: string,
	cursor: string | null,
): { readonly sql: string; readonly params: readonly unknown[] } {
	return cursor === null ? { sql: "", params: [] } : { sql: ` AND ${alias}.id > ?`, params: [cursor] };
}

function missingVectorWhere(
	db: VectorRepairDb,
	agentId: string,
	cursor: string | null,
): { readonly sql: string; readonly params: readonly unknown[] } {
	const keyset = cursorPredicate("e", cursor);
	const vectorTable = vectorLookupTable(db);
	const quarantineJoin = tableExists(db, "vec_embeddings_quarantine")
		? "\n			LEFT JOIN vec_embeddings_quarantine q ON q.rowid = e.id"
		: "";
	const quarantinePredicate = quarantineJoin.length > 0 ? "\n			  AND q.rowid IS NULL" : "";
	return {
		sql: `
			FROM embeddings e
			LEFT JOIN ${vectorTable} v ON v.id = e.id
			${quarantineJoin}
			WHERE v.id IS NULL
			${quarantinePredicate}
			  AND COALESCE(NULLIF(e.agent_id, ''), 'default') = ?
			${keyset.sql}`,
		params: [agentId, ...keyset.params],
	};
}

function orphanEmbeddingWhere(
	agentId: string,
	cursor: string | null,
): { readonly sql: string; readonly params: readonly unknown[] } {
	const keyset = cursorPredicate("e", cursor);
	return {
		sql: `
			FROM embeddings e
			LEFT JOIN memories m ON e.source_type = 'memory' AND e.source_id = m.id
			LEFT JOIN memories m2
				ON e.source_type = 'memory'
				AND e.content_hash = m2.content_hash
				AND m2.is_deleted = 0
				AND COALESCE(NULLIF(m2.agent_id, ''), 'default') = COALESCE(NULLIF(e.agent_id, ''), NULLIF(m.agent_id, ''), 'default')
			WHERE e.source_type = 'memory'
			  AND (m.id IS NULL OR m.is_deleted = 1)
			  AND m2.id IS NULL
			  AND COALESCE(NULLIF(e.agent_id, ''), NULLIF(m.agent_id, ''), 'default') = ?
			${keyset.sql}`,
		params: [agentId, ...keyset.params],
	};
}

function hasRemaining(
	db: VectorRepairDb,
	operation: DbOwnerVectorRepairOperation,
	phase: DbOwnerVectorRepairPhase,
	agentId: string,
	cursor: string | null,
): number {
	if (phase === "complete") return 0;
	if (operation === "resync" && phase === "orphan-vectors") return 0;
	const query =
		operation === "resync" ? missingVectorWhere(db, agentId, cursor) : orphanEmbeddingWhere(agentId, cursor);
	return db.prepare(`SELECT 1 ${query.sql} LIMIT 1`).get(...query.params) != null ? 1 : 0;
}

function hasCandidate(db: VectorRepairDb, operation: DbOwnerVectorRepairOperation, agentId: string): boolean {
	return hasRemaining(db, operation, INITIAL_PHASE[operation], agentId, null) > 0;
}

function readCheckpoint(
	db: VectorRepairDb,
	operation: DbOwnerVectorRepairOperation,
	agentId: string,
): CheckpointRow | null {
	return (
		(db
			.prepare(
				`SELECT operation, agent_id, checkpoint_id, phase, cursor, processed, skipped, failed,
					affected, remaining, status, last_error
			 FROM vector_repair_checkpoints
			 WHERE operation = ? AND agent_id = ?`,
			)
			.get(operation, agentId) as CheckpointRow | null | undefined) ?? null
	);
}

function ensureCheckpoint(db: VectorRepairDb, input: DbOwnerVectorRepairInput): CheckpointRow {
	const operation = input.operation;
	const agentId = normalizeAgentId(input.agentId);
	const now = nowIso();
	db.prepare(
		`INSERT OR IGNORE INTO vector_repair_checkpoints
			(operation, agent_id, checkpoint_id, phase, cursor, processed, skipped, failed, affected, remaining, status, last_error, created_at, updated_at)
		 VALUES (?, ?, ?, ?, NULL, 0, 0, 0, 0, 0, 'running', NULL, ?, ?)`,
	).run(operation, agentId, input.checkpointId, INITIAL_PHASE[operation], now, now);

	let row = readCheckpoint(db, operation, agentId);
	if (row === null) throw new Error("vector repair checkpoint was not initialized");

	if (row.status === "complete" && hasCandidate(db, operation, agentId)) {
		db.prepare(
			`UPDATE vector_repair_checkpoints
			 SET checkpoint_id = ?, phase = ?, cursor = NULL, processed = 0, skipped = 0,
				 failed = 0, affected = 0, remaining = 0, status = 'running', last_error = NULL, updated_at = ?
			 WHERE operation = ? AND agent_id = ?`,
		).run(input.checkpointId, INITIAL_PHASE[operation], now, operation, agentId);
		row = readCheckpoint(db, operation, agentId);
		if (row === null) throw new Error("vector repair checkpoint reset failed");
	} else if (row.status === "failed") {
		db.prepare(
			`UPDATE vector_repair_checkpoints
			 SET status = 'running', last_error = NULL, updated_at = ?
			 WHERE operation = ? AND agent_id = ?`,
		).run(now, operation, agentId);
		row = readCheckpoint(db, operation, agentId);
		if (row === null) throw new Error("vector repair checkpoint resume failed");
	}
	return row;
}

function checkpointResult(
	row: CheckpointRow,
	operationIdValue: string,
	counters: BatchCounters,
	error?: string,
): DbOwnerVectorRepairResult {
	return {
		operation: row.operation,
		agentId: row.agent_id,
		checkpointId: row.checkpoint_id,
		phase: row.phase,
		status: row.status,
		cursor: row.cursor,
		processed: row.processed,
		skipped: row.skipped,
		failed: row.failed,
		affected: row.affected,
		remaining: row.remaining,
		remainingStatus: row.remaining === 0 ? "none" : "some",
		batchRows: counters.batchRows,
		batchBytes: counters.batchBytes,
		batchProcessed: counters.batchProcessed,
		batchSkipped: counters.batchSkipped,
		batchFailed: counters.batchFailed,
		batchAffected: counters.batchAffected,
		operationId: operationIdValue,
		...(error === undefined ? {} : { error }),
	};
}

function writeAudit(
	db: VectorRepairDb,
	input: DbOwnerVectorRepairInput,
	phase: DbOwnerVectorRepairPhase,
	operationIdValue: string,
	counters: BatchCounters,
	remaining: number,
): void {
	const agentId = normalizeAgentId(input.agentId);
	db.prepare(
		`INSERT INTO memory_history
			(id, memory_id, event, old_content, new_content, changed_by, reason, metadata, created_at, actor_type, session_id, request_id)
		 VALUES (?, 'system', 'none', NULL, NULL, ?, ?, ?, ?, ?, NULL, ?)`,
	).run(
		randomUUID(),
		input.audit.actor,
		input.audit.reason,
		JSON.stringify({
			repairAction: input.audit.action,
			operationId: operationIdValue,
			phase,
			checkpointId: readCheckpoint(db, input.operation, agentId)?.checkpoint_id ?? input.checkpointId,
			processed: counters.batchProcessed,
			skipped: counters.batchSkipped,
			failed: counters.batchFailed,
			affected: counters.batchAffected,
			remaining,
		}),
		nowIso(),
		input.audit.actorType,
		input.audit.requestId ?? null,
	);
}

function updateCheckpoint(
	db: VectorRepairDb,
	row: CheckpointRow,
	values: {
		readonly phase: DbOwnerVectorRepairPhase;
		readonly cursor: string | null;
		readonly processed: number;
		readonly skipped: number;
		readonly failed: number;
		readonly affected: number;
		readonly remaining: number;
		readonly status: "running" | "complete" | "failed";
		readonly lastError: string | null;
	},
): CheckpointRow {
	db.prepare(
		`UPDATE vector_repair_checkpoints
		 SET phase = ?, cursor = ?, processed = ?, skipped = ?, failed = ?, affected = ?,
			 remaining = ?, status = ?, last_error = ?, updated_at = ?
		 WHERE operation = ? AND agent_id = ?`,
	).run(
		values.phase,
		values.cursor,
		values.processed,
		values.skipped,
		values.failed,
		values.affected,
		values.remaining,
		values.status,
		values.lastError,
		nowIso(),
		row.operation,
		row.agent_id,
	);
	const updated = readCheckpoint(db, row.operation, row.agent_id);
	if (updated === null) throw new Error("vector repair checkpoint disappeared during update");
	return updated;
}

function emptyCounters(): BatchCounters {
	return { batchRows: 0, batchBytes: 0, batchProcessed: 0, batchSkipped: 0, batchFailed: 0, batchAffected: 0 };
}

function guard(options: VectorRepairOwnerOptions): void {
	if (options.shouldAbort?.() === true) throw new VectorRepairAbortError();
}

function listMissingVectors(
	db: VectorRepairDb,
	agentId: string,
	cursor: string | null,
	limit: number,
): readonly CandidateRow[] {
	const query = missingVectorWhere(db, agentId, cursor);
	return db
		.prepare(`SELECT e.id, length(e.vector) AS vector_bytes, e.dimensions ${query.sql} ORDER BY e.id LIMIT ?`)
		.all(...query.params, limit) as CandidateRow[];
}

function processMissingVectors(
	db: VectorRepairDb,
	row: CheckpointRow,
	input: DbOwnerVectorRepairInput,
	limit: number,
	maxBytes: number,
	options: VectorRepairOwnerOptions,
): { readonly row: CheckpointRow; readonly counters: BatchCounters } {
	const counters = emptyCounters();
	const candidates = listMissingVectors(db, row.agent_id, row.cursor, limit);
	const dimensions = vectorTableDimensions(db);
	let cursor = row.cursor;
	let lastError: string | null = null;
	const insert = db.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)");

	for (const candidate of candidates) {
		guard(options);
		if (typeof candidate.id !== "string") continue;
		const declaredBytes = Math.floor(numberValue(candidate.vector_bytes, -1));
		const declaredDimensions = Math.floor(numberValue(candidate.dimensions, -1));
		const expectedDimensions = dimensions ?? declaredDimensions;
		if (
			declaredDimensions <= 0 ||
			expectedDimensions <= 0 ||
			declaredDimensions !== expectedDimensions ||
			declaredBytes <= 0 ||
			declaredBytes > VECTOR_REPAIR_MAX_BYTES_PER_BATCH ||
			declaredBytes !== expectedDimensions * Float32Array.BYTES_PER_ELEMENT
		) {
			cursor = candidate.id;
			quarantineVector(db, candidate.id, expectedDimensions, "embedding blob has invalid dimensions or byte length");
			counters.batchRows += 1;
			counters.batchProcessed += 1;
			counters.batchSkipped += 1;
			continue;
		}
		if (declaredBytes > maxBytes || (counters.batchBytes > 0 && counters.batchBytes + declaredBytes > maxBytes)) break;

		const source = db
			.prepare("SELECT vector FROM embeddings WHERE id = ? AND COALESCE(NULLIF(agent_id, ''), 'default') = ?")
			.get(candidate.id, row.agent_id) as { vector?: unknown } | undefined;
		const raw = source?.vector;
		const actualBytes = byteLength(raw);
		const blob = blobForInsert(raw);
		if (actualBytes === null || blob === null || actualBytes !== declaredBytes || actualBytes % 4 !== 0) {
			cursor = candidate.id;
			quarantineVector(db, candidate.id, expectedDimensions, "embedding blob is not a valid binary vector");
			counters.batchRows += 1;
			counters.batchProcessed += 1;
			counters.batchSkipped += 1;
			continue;
		}
		if (containsNonFiniteFloat32(blob)) {
			cursor = candidate.id;
			quarantineVector(db, candidate.id, expectedDimensions, "embedding vector contains a non-finite value");
			counters.batchRows += 1;
			counters.batchProcessed += 1;
			counters.batchSkipped += 1;
			continue;
		}

		try {
			guard(options);
			const changed = changes(insert.run(candidate.id, blob));
			cursor = candidate.id;
			counters.batchRows += 1;
			counters.batchProcessed += 1;
			counters.batchBytes += actualBytes;
			counters.batchAffected += changed;
		} catch (error) {
			counters.batchFailed += 1;
			lastError = error instanceof Error ? error.message : String(error);
			break;
		}
	}

	if (counters.batchFailed > 0) {
		const remaining = hasRemaining(db, input.operation, row.phase, row.agent_id, cursor);
		const next = updateCheckpoint(db, row, {
			phase: row.phase,
			cursor,
			processed: row.processed + counters.batchProcessed,
			skipped: row.skipped + counters.batchSkipped,
			failed: row.failed + counters.batchFailed,
			affected: row.affected + counters.batchAffected,
			remaining,
			status: "failed",
			lastError,
		});
		writeAudit(db, input, next.phase, operationId(input.operation, next.phase), counters, remaining);
		return { row: next, counters };
	}

	if (
		candidates.length === 0 ||
		(cursor !== null &&
			counters.batchRows > 0 &&
			hasRemaining(db, input.operation, row.phase, row.agent_id, cursor) === 0)
	) {
		const remaining = hasRemaining(db, input.operation, row.phase, row.agent_id, cursor);
		if (remaining === 0) {
			const next = updateCheckpoint(db, row, {
				phase: "complete",
				cursor: null,
				processed: row.processed + counters.batchProcessed,
				skipped: row.skipped + counters.batchSkipped,
				failed: row.failed,
				affected: row.affected + counters.batchAffected,
				remaining: 0,
				status: "complete",
				lastError: null,
			});
			writeAudit(db, input, next.phase, operationId(input.operation, row.phase), counters, 0);
			return { row: next, counters };
		}
	}

	const remaining = hasRemaining(db, input.operation, row.phase, row.agent_id, cursor);
	const next = updateCheckpoint(db, row, {
		phase: row.phase,
		cursor,
		processed: row.processed + counters.batchProcessed,
		skipped: row.skipped + counters.batchSkipped,
		failed: row.failed,
		affected: row.affected + counters.batchAffected,
		remaining,
		status: "running",
		lastError: null,
	});
	writeAudit(db, input, next.phase, operationId(input.operation, next.phase), counters, remaining);
	return { row: next, counters };
}

function listOrphanEmbeddings(
	db: VectorRepairDb,
	agentId: string,
	cursor: string | null,
	limit: number,
): readonly CandidateRow[] {
	const query = orphanEmbeddingWhere(agentId, cursor);
	return db.prepare(`SELECT e.id ${query.sql} ORDER BY e.id LIMIT ?`).all(...query.params, limit) as CandidateRow[];
}

function processOrphanEmbeddings(
	db: VectorRepairDb,
	row: CheckpointRow,
	input: DbOwnerVectorRepairInput,
	limit: number,
	options: VectorRepairOwnerOptions,
): { readonly row: CheckpointRow; readonly counters: BatchCounters } {
	const counters = emptyCounters();
	const candidates = listOrphanEmbeddings(db, row.agent_id, row.cursor, limit);
	let cursor = row.cursor;
	const removeVec = tableExists(db, "vec_embeddings") ? db.prepare("DELETE FROM vec_embeddings WHERE id = ?") : null;
	const removeEmbedding = db.prepare("DELETE FROM embeddings WHERE id = ?");
	for (const candidate of candidates) {
		guard(options);
		if (typeof candidate.id !== "string") continue;
		if (removeVec !== null) removeVec.run(candidate.id);
		const changed = changes(removeEmbedding.run(candidate.id));
		cursor = candidate.id;
		counters.batchRows += 1;
		counters.batchProcessed += 1;
		counters.batchAffected += changed;
	}

	const remaining = hasRemaining(db, input.operation, row.phase, row.agent_id, cursor);
	const complete = candidates.length === 0 || remaining === 0;
	const next = updateCheckpoint(db, row, {
		phase: complete ? "complete" : row.phase,
		cursor: complete ? null : cursor,
		processed: row.processed + counters.batchProcessed,
		skipped: row.skipped,
		failed: row.failed,
		affected: row.affected + counters.batchAffected,
		remaining: complete ? 0 : remaining,
		status: complete ? "complete" : "running",
		lastError: null,
	});
	writeAudit(db, input, next.phase, operationId(input.operation, row.phase), counters, next.remaining);
	return { row: next, counters };
}

/**
 * Execute one bounded vector-repair batch inside an already-open transaction.
 * The caller owns BEGIN/COMMIT/ROLLBACK so the durable cursor and mutations
 * share one commit boundary.
 */
export function applyVectorRepairBatch(
	db: VectorRepairDb,
	input: DbOwnerVectorRepairInput,
	options: VectorRepairOwnerOptions = {},
): DbOwnerVectorRepairResult {
	const agentId = normalizeAgentId(input.agentId);
	const limit = boundedBatchSize(input.batchSize);
	const maxBytes = boundedVectorBytes(input.maxVectorBytes);
	const noWork = emptyCounters();

	if (input.operation === "resync" && !tableExists(db, "vec_embeddings")) {
		let row = readCheckpoint(db, input.operation, agentId);
		if (row === null) row = ensureCheckpoint(db, { ...input, agentId });
		const error = "vec_embeddings table not found; restart daemon to initialize vector index";
		row = updateCheckpoint(db, row, {
			phase: row.phase,
			cursor: row.cursor,
			processed: row.processed,
			skipped: row.skipped,
			failed: row.failed,
			affected: row.affected,
			remaining: row.remaining,
			status: "failed",
			lastError: error,
		});
		writeAudit(db, input, row.phase, operationId(input.operation, row.phase), noWork, row.remaining);
		return checkpointResult(row, operationId(input.operation, row.phase), noWork, error);
	}

	let row = ensureCheckpoint(db, { ...input, agentId });
	if (input.operation === "resync" && row.phase === "orphan-vectors") {
		row = updateCheckpoint(db, row, {
			phase: "missing-vectors",
			cursor: null,
			processed: row.processed,
			skipped: row.skipped,
			failed: row.failed,
			affected: row.affected,
			remaining: hasRemaining(db, input.operation, "missing-vectors", agentId, null),
			status: "running",
			lastError: null,
		});
	}
	if (row.status === "complete" || row.phase === "complete") {
		return checkpointResult(row, operationId(input.operation, row.phase), noWork);
	}

	const result =
		input.operation === "resync"
			? processMissingVectors(db, row, input, limit, maxBytes, options)
			: processOrphanEmbeddings(db, row, input, limit, options);
	row = result.row;
	return checkpointResult(row, operationId(input.operation, row.phase), result.counters, row.last_error ?? undefined);
}

/** Read the durable checkpoint without changing it. Used after a timed-out request. */
export function readVectorRepairCheckpoint(
	db: VectorRepairDb,
	operation: DbOwnerVectorRepairOperation,
	agentId: string,
): CheckpointRow | null {
	return readCheckpoint(db, operation, normalizeAgentId(agentId));
}
