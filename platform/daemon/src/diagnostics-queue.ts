/**
 * Per-queue counters and thresholds for the diagnostics surface.
 *
 * Issue #901 lifts `summary_jobs` into the health envelope. The previous
 * `getQueueHealth` helper only read `memory_jobs`; this module splits
 * the per-queue reads into their own type and exposes a single
 * threshold scorer that all surfaces (diagnostics, /api/status,
 * signet status, PR #932's /health/ready) can share.
 */

import type { ReadDb } from "./db-accessor";
import { tableExists } from "./db-helpers";

// ---------------------------------------------------------------------------
// Per-queue counts
// ---------------------------------------------------------------------------

export interface QueueCounts {
	readonly pending: number;
	readonly leased: number;
	readonly completed: number;
	readonly failed: number;
	readonly dead: number;
	/** Age (seconds) of the oldest non-terminal row. 0 when the queue is empty. */
	readonly oldestAgeSec: number;
	/** Age (seconds) of the oldest `dead` row. 0 when no dead rows. */
	readonly oldestDeadAgeSec: number;
	/** Most recent non-null `error` column value across `pending`/`leased`/`dead`. */
	readonly lastError: string | null;
}

export const EMPTY_QUEUE_COUNTS: QueueCounts = {
	pending: 0,
	leased: 0,
	completed: 0,
	failed: 0,
	dead: 0,
	oldestAgeSec: 0,
	oldestDeadAgeSec: 0,
	lastError: null,
};

export interface OldestDeadJob {
	readonly id: string;
	readonly harness: string | null;
	readonly sessionKey: string | null;
	readonly createdAt: string;
	readonly attempts: number;
	readonly error: string | null;
}

// ---------------------------------------------------------------------------
// Queue source identification
// ---------------------------------------------------------------------------

export type QueueSource = "memory" | "summary" | "extraction";

interface QueueCountsQueryResult {
	readonly pending: number;
	readonly leased: number;
	readonly completed: number;
	readonly failed: number;
	readonly dead: number;
	readonly oldestAt: string | null;
	readonly oldestDeadAt: string | null;
	readonly lastError: string | null;
}

interface OldestDeadRow {
	readonly id: string;
	readonly harness: string | null;
	readonly sessionKey: string | null;
	readonly createdAt: string;
	readonly attempts: number;
	readonly error: string | null;
}

function safeQueueRows(db: ReadDb, table: string): QueueCountsQueryResult | undefined {
	if (!tableExists(db, table)) return undefined;
	// Reject anything that isn't obviously a queue table — never feed
	// user-controlled table names into a literal here.
	if (!/^[a-z][a-z0-9_]*$/i.test(table)) return undefined;
	const lastErrorOrder = hasColumn(db, table, "updated_at")
		? "updated_at DESC"
		: hasColumn(db, table, "completed_at")
			? "completed_at DESC, rowid DESC"
			: "rowid DESC";
	const stmt = db.prepare(`
		SELECT
			SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END) AS pending,
			SUM(CASE WHEN status = 'leased'   THEN 1 ELSE 0 END) AS leased,
			SUM(CASE WHEN status = 'completed'THEN 1 ELSE 0 END) AS completed,
			SUM(CASE WHEN status = 'failed'   THEN 1 ELSE 0 END) AS failed,
			SUM(CASE WHEN status = 'dead'     THEN 1 ELSE 0 END) AS dead,
			MIN(CASE WHEN status IN ('pending','leased') THEN created_at END) AS oldestAt,
			MIN(CASE WHEN status = 'dead' THEN created_at END) AS oldestDeadAt,
			(SELECT error FROM ${table}
				WHERE status IN ('pending','leased','dead') AND error IS NOT NULL
				ORDER BY ${lastErrorOrder} LIMIT 1) AS lastError
		FROM ${table}
	`);
	return stmt.get() as QueueCountsQueryResult | undefined;
}

function hasColumn(db: ReadDb, table: string, column: string): boolean {
	if (!tableExists(db, table)) return false;
	if (!/^[a-z][a-z0-9_]*$/i.test(table)) return false;
	if (!/^[a-z][a-z0-9_]*$/i.test(column)) return false;
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ReadonlyArray<{
		name: string;
	}>;
	return rows.some((r) => r.name === column);
}

function jobMemoryRows(db: ReadDb, jobType: string): QueueCountsQueryResult | undefined {
	if (!tableExists(db, "memory_jobs")) return undefined;
	if (!/^[a-z][a-z0-9_]*$/i.test(jobType)) return undefined;
	const stmt = db.prepare(`
		SELECT
			SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END) AS pending,
			SUM(CASE WHEN status = 'leased'   THEN 1 ELSE 0 END) AS leased,
			SUM(CASE WHEN status = 'completed'THEN 1 ELSE 0 END) AS completed,
			SUM(CASE WHEN status = 'failed'   THEN 1 ELSE 0 END) AS failed,
			SUM(CASE WHEN status = 'dead'     THEN 1 ELSE 0 END) AS dead,
			MIN(CASE WHEN status IN ('pending','leased') THEN created_at END) AS oldestAt,
			MIN(CASE WHEN status = 'dead' THEN created_at END) AS oldestDeadAt,
			(SELECT error FROM memory_jobs
				WHERE job_type = ? AND status IN ('pending','leased','dead') AND error IS NOT NULL
				ORDER BY updated_at DESC LIMIT 1) AS lastError
		FROM memory_jobs
		WHERE job_type = ?
	`);
	return stmt.get(jobType, jobType) as QueueCountsQueryResult | undefined;
}

function ageSec(value: string | null): number {
	if (!value) return 0;
	const ts = new Date(value).getTime();
	if (!Number.isFinite(ts)) return 0;
	return Math.max(0, (Date.now() - ts) / 1000);
}

function rowToCounts(row: QueueCountsQueryResult | undefined): QueueCounts {
	if (row === undefined) return EMPTY_QUEUE_COUNTS;
	return {
		pending: row.pending ?? 0,
		leased: row.leased ?? 0,
		completed: row.completed ?? 0,
		failed: row.failed ?? 0,
		dead: row.dead ?? 0,
		oldestAgeSec: ageSec(row.oldestAt),
		oldestDeadAgeSec: ageSec(row.oldestDeadAt),
		lastError: row.lastError ?? null,
	};
}

/**
 * Per-table counts for one queue source.
 *
 * `memory` reads `memory_jobs` table; `summary` reads `summary_jobs`
 * table; `extraction` filters `memory_jobs` by `job_type = 'extraction'`
 * (so the extraction pipeline slice is visible even though it shares
 * the table with other memory jobs).
 */
export function getQueueCounts(db: ReadDb, source: QueueSource): QueueCounts {
	if (source === "memory") return rowToCounts(safeQueueRows(db, "memory_jobs"));
	if (source === "summary") return rowToCounts(safeQueueRows(db, "summary_jobs"));
	if (source === "extraction") return rowToCounts(jobMemoryRows(db, "extraction"));
	// Defensive — TS narrowing treats any unrecognized value as `never`
	// through exhaustive union discrimination.
	return EMPTY_QUEUE_COUNTS;
}

/**
 * Oldest `dead` row's identifying fields. `null` when no dead rows or
 * when the queue table is missing.
 */
export function getOldestDeadJob(db: ReadDb, source: QueueSource): OldestDeadJob | null {
	if (source === "summary") {
		if (!tableExists(db, "summary_jobs")) return null;
		const row = db
			.prepare(
				`SELECT id, harness, session_key AS sessionKey, created_at AS createdAt,
				        attempts, error
				 FROM summary_jobs
				 WHERE status = 'dead'
				 ORDER BY created_at ASC LIMIT 1`,
			)
			.get() as OldestDeadRow | undefined;
		if (!row) return null;
		return {
			id: row.id,
			harness: row.harness,
			sessionKey: row.sessionKey,
			createdAt: row.createdAt,
			attempts: row.attempts,
			error: row.error,
		};
	}
	if (source === "memory" || source === "extraction") {
		if (!tableExists(db, "memory_jobs")) return null;
		const typeFilter = source === "extraction" ? "AND job_type = 'extraction'" : "";
		const row = db
			.prepare(
				`SELECT id, job_type AS harness, memory_id AS sessionKey, created_at AS createdAt,
				        attempts, error
				 FROM memory_jobs
				 WHERE status = 'dead' ${typeFilter}
				 ORDER BY created_at ASC LIMIT 1`,
			)
			.get() as OldestDeadRow | undefined;
		if (!row) return null;
		return {
			id: row.id,
			harness: row.harness,
			sessionKey: row.sessionKey,
			createdAt: row.createdAt,
			attempts: row.attempts,
			error: row.error,
		};
	}
	return null;
}

export interface QueueDiagnosticsSnapshot {
	readonly memory: QueueCounts;
	readonly summary: QueueCounts;
	readonly extraction: QueueCounts;
	readonly oldestDeadSummaryJob: OldestDeadJob | null;
	readonly oldestDeadMemoryJob: OldestDeadJob | null;
	readonly oldestDeadExtractionJob: OldestDeadJob | null;
}

const QUEUE_SNAPSHOT_CACHE_TTL_MS = 30_000;
let queueSnapshotCache = new WeakMap<
	ReadDb,
	{ readonly expiresAt: number; readonly value: QueueDiagnosticsSnapshot }
>();

/**
 * Read the expanded queue diagnostics once and reuse them across status
 * surfaces for a short window. Dedicated diagnostics requests can bypass the
 * cache with `fresh: true`; repair routes invalidate it after mutations.
 */
export function getQueueDiagnosticsSnapshot(
	db: ReadDb,
	options: { readonly fresh?: boolean } = {},
): QueueDiagnosticsSnapshot {
	const now = Date.now();
	const cached = queueSnapshotCache.get(db);
	if (options.fresh !== true && cached && cached.expiresAt > now) return cached.value;

	const value: QueueDiagnosticsSnapshot = {
		memory: getQueueCounts(db, "memory"),
		summary: getQueueCounts(db, "summary"),
		extraction: getQueueCounts(db, "extraction"),
		oldestDeadSummaryJob: getOldestDeadJob(db, "summary"),
		oldestDeadMemoryJob: getOldestDeadJob(db, "memory"),
		oldestDeadExtractionJob: getOldestDeadJob(db, "extraction"),
	};
	queueSnapshotCache.set(db, { expiresAt: now + QUEUE_SNAPSHOT_CACHE_TTL_MS, value });
	return value;
}

export function invalidateQueueDiagnosticsCache(): void {
	queueSnapshotCache = new WeakMap();
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export interface QueueThresholds {
	readonly summaryDeadWarn: number;
	readonly summaryDeadFail: number;
	readonly summaryOldestPendingWarnSec: number;
	readonly summaryOldestPendingFailSec: number;
	readonly summaryOldestDeadWarnSec: number;
	readonly memoryDeadWarn: number;
	readonly memoryDeadFail: number;
	readonly memoryOldestPendingWarnSec: number;
	readonly memoryOldestPendingFailSec: number;
	readonly extractionDeadWarn: number;
	readonly extractionDeadFail: number;
}

export const DEFAULT_QUEUE_THRESHOLDS: QueueThresholds = {
	summaryDeadWarn: 50,
	summaryDeadFail: 500,
	summaryOldestPendingWarnSec: 300,
	summaryOldestPendingFailSec: 1800,
	summaryOldestDeadWarnSec: 86_400,
	memoryDeadWarn: 50,
	memoryDeadFail: 500,
	memoryOldestPendingWarnSec: 300,
	memoryOldestPendingFailSec: 1800,
	extractionDeadWarn: 10,
	extractionDeadFail: 100,
};

export interface QueueScore {
	readonly score: number;
	readonly status: "healthy" | "degraded" | "unhealthy";
}

function clamp01(n: number): number {
	return Math.max(0, Math.min(1, n));
}

function statusForScore(score: number): QueueScore["status"] {
	if (score >= 0.8) return "healthy";
	if (score >= 0.5) return "degraded";
	return "unhealthy";
}

type QueueBreachStatus = "degraded" | "unhealthy" | null;

function deadScore(dead: number, warn: number, fail: number): { penalty: number; status: QueueBreachStatus } {
	if (dead <= warn) return { penalty: 0, status: null };
	if (dead >= fail) return { penalty: 0.6, status: "unhealthy" };
	const t = (dead - warn) / Math.max(1, fail - warn);
	return { penalty: 0.2 + 0.4 * t, status: "degraded" };
}

function ageScore(age: number, warn: number, fail: number): { penalty: number; status: QueueBreachStatus } {
	if (age <= warn) return { penalty: 0, status: null };
	if (age >= fail) return { penalty: 0.4, status: "unhealthy" };
	const t = (age - warn) / Math.max(1, fail - warn);
	return { penalty: 0.1 + 0.3 * t, status: "degraded" };
}

/**
 * Score a single queue's counts against the matching thresholds. The
 * returned status is the worst of the breached thresholds. Status is
 * `null` when no threshold was breached — caller treats that as
 * `healthy` for the queue.
 */
export function scoreCountsWithThresholds(
	counts: QueueCounts,
	source: QueueSource,
	thresholds: QueueThresholds = DEFAULT_QUEUE_THRESHOLDS,
): QueueScore {
	let penalty = 0;
	let worst: QueueScore["status"] | null = null;

	const bump = (candidate: QueueBreachStatus): void => {
		if (candidate === null) return;
		if (candidate === "unhealthy") worst = "unhealthy";
		else if (worst !== "unhealthy") worst = candidate;
	};

	if (source === "summary") {
		const d = deadScore(counts.dead, thresholds.summaryDeadWarn, thresholds.summaryDeadFail);
		penalty += d.penalty;
		bump(d.status);
		const a = ageScore(
			counts.oldestAgeSec,
			thresholds.summaryOldestPendingWarnSec,
			thresholds.summaryOldestPendingFailSec,
		);
		penalty += a.penalty;
		bump(a.status);
		const oldestDead = ageScore(counts.oldestDeadAgeSec, thresholds.summaryOldestDeadWarnSec, Number.POSITIVE_INFINITY);
		penalty += oldestDead.penalty;
		bump(oldestDead.status);
	} else if (source === "memory") {
		const d = deadScore(counts.dead, thresholds.memoryDeadWarn, thresholds.memoryDeadFail);
		penalty += d.penalty;
		bump(d.status);
		const a = ageScore(
			counts.oldestAgeSec,
			thresholds.memoryOldestPendingWarnSec,
			thresholds.memoryOldestPendingFailSec,
		);
		penalty += a.penalty;
		bump(a.status);
	} else if (source === "extraction") {
		const d = deadScore(counts.dead, thresholds.extractionDeadWarn, thresholds.extractionDeadFail);
		penalty += d.penalty;
		bump(d.status);
	}

	const score = clamp01(1 - penalty);
	if (worst === null) {
		return { score, status: "healthy" };
	}
	return { score, status: statusForScore(score) };
}

/**
 * Combine per-queue scores with worst-of semantics. Used by both the
 * `QueueHealth` legacy aggregate status and the new
 * `/api/diagnostics/queue` envelope.
 */
export function worstQueueScore(scores: readonly QueueScore[]): QueueScore {
	if (scores.length === 0) return { score: 1, status: "healthy" };
	let score = 1;
	let worst: QueueScore["status"] = "healthy";
	for (const s of scores) {
		if (s.score < score) score = s.score;
		if (s.status === "unhealthy") worst = "unhealthy";
		else if (s.status === "degraded" && worst !== "unhealthy") worst = "degraded";
	}
	return { score, status: worst };
}
