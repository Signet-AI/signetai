import type { ReadDb } from "./db-accessor";
import { tableExists } from "./db-helpers";

export interface QueueCounts {
	readonly pending: number;
	readonly leased: number;
	readonly completed: number;
	readonly failed: number;
	readonly dead: number;
	readonly oldestAgeSec: number;
	readonly oldestDeadAgeSec: number;
	readonly lastError: string | null;
	readonly completeness: "exact" | "truncated" | "unknown";
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
	completeness: "exact",
};

const QUEUE_DIAGNOSTICS_COUNT_LIMIT = 1_000;

export interface OldestDeadJob {
	readonly id: string;
	readonly harness: string | null;
	readonly sessionKey: string | null;
	readonly createdAt: string;
	readonly attempts: number;
	readonly error: string | null;
}

export type QueueSource = "memory" | "summary";

interface QueueCountsQueryResult {
	readonly pending: number;
	readonly leased: number;
	readonly completed: number;
	readonly failed: number;
	readonly dead: number;
	readonly oldestAt: string | null;
	readonly oldestDeadAt: string | null;
	readonly lastError: string | null;
	readonly completeness: "exact" | "truncated";
}

interface OldestDeadRow {
	readonly id: string;
	readonly harness: string | null;
	readonly sessionKey: string | null;
	readonly createdAt: string;
	readonly attempts: number;
	readonly error: string | null;
}

function safeQueueRows(db: ReadDb, table: string, predicate = "1 = 1"): QueueCountsQueryResult | undefined {
	if (!tableExists(db, table)) return undefined;
	if (!/^[a-z][a-z0-9_]*$/i.test(table)) return undefined;
	if (table !== "memory_jobs") return undefined;
	if (!hasColumn(db, table, "updated_at") || !hasColumn(db, table, "created_at")) return undefined;

	try {
		const counts = { pending: 0, leased: 0, completed: 0, failed: 0, dead: 0 };
		let truncated = false;
		for (const status of Object.keys(counts) as Array<keyof typeof counts>) {
			const rows = db
				.prepare(
					`SELECT status
					 FROM ${table} INDEXED BY idx_memory_jobs_diagnostics_status_created_at
					 WHERE status = ? AND ${predicate}
					 LIMIT ${QUEUE_DIAGNOSTICS_COUNT_LIMIT + 1}`,
				)
				.all(status) as ReadonlyArray<{ readonly status: string }>;
			if (rows.length > QUEUE_DIAGNOSTICS_COUNT_LIMIT) {
				counts[status] = QUEUE_DIAGNOSTICS_COUNT_LIMIT;
				truncated = true;
			} else {
				counts[status] = rows.length;
			}
		}

		const oldest = db
			.prepare(
				`SELECT created_at AS oldestAt
				 FROM ${table} INDEXED BY idx_memory_jobs_pressure_created_at
				 WHERE status IN ('pending', 'leased') AND ${predicate}
				 ORDER BY created_at ASC LIMIT 1`,
			)
			.get() as { readonly oldestAt?: string | null } | undefined;
		const oldestDead = db
			.prepare(
				`SELECT created_at AS oldestDeadAt
				 FROM ${table} INDEXED BY idx_memory_jobs_diagnostics_status_created_at
				 WHERE status = 'dead' AND ${predicate}
				 ORDER BY created_at ASC LIMIT 1`,
			)
			.get() as { readonly oldestDeadAt?: string | null } | undefined;
		const lastError = db
			.prepare(
				`SELECT error
				 FROM ${table} INDEXED BY idx_memory_jobs_diagnostics_error_updated_at
				 WHERE status IN ('pending', 'leased', 'dead') AND ${predicate} AND error IS NOT NULL
				 ORDER BY updated_at DESC LIMIT 1`,
			)
			.get() as { readonly error?: string | null } | undefined;

		return {
			...counts,
			oldestAt: oldest?.oldestAt ?? null,
			oldestDeadAt: oldestDead?.oldestDeadAt ?? null,
			lastError: lastError?.error ?? null,
			completeness: truncated ? "truncated" : "exact",
		};
	} catch {
		return undefined;
	}
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
		completeness: row.completeness,
	};
}
export function getQueueCounts(db: ReadDb, source: QueueSource): QueueCounts {
	if (source === "memory") {
		if (!tableExists(db, "memory_jobs")) return { ...EMPTY_QUEUE_COUNTS, completeness: "unknown" };
		const row = safeQueueRows(db, "memory_jobs", "job_type <> 'extract'");
		return row === undefined ? { ...EMPTY_QUEUE_COUNTS, completeness: "unknown" } : rowToCounts(row);
	}
	if (source === "summary") return EMPTY_QUEUE_COUNTS;
	return EMPTY_QUEUE_COUNTS;
}

const QUEUE_PRESSURE_DEPTH_LIMIT = 1_001;

interface QueuePressureQueryResult {
	readonly depth: number;
	readonly oldestAt: string | null;
}
function getQueuePressureQueryResult(db: ReadDb, source: QueueSource): QueuePressureQueryResult | undefined {
	const table = source === "memory" ? "memory_jobs" : "summary_jobs";
	const statusIndex = source === "memory" ? "idx_memory_jobs_pressure_status" : "idx_summary_jobs_pressure_status";
	const createdIndex =
		source === "memory" ? "idx_memory_jobs_pressure_created_at" : "idx_summary_jobs_pressure_created_at";
	const predicate = source === "memory" ? " AND job_type <> 'extract'" : "";
	if (!tableExists(db, table)) return undefined;

	try {
		const rows = db
			.prepare(
				`SELECT 1
				 FROM ${table} INDEXED BY ${statusIndex}
				 WHERE status IN ('pending', 'leased')${predicate}
				 LIMIT ${QUEUE_PRESSURE_DEPTH_LIMIT}`,
			)
			.all();
		const oldest = db
			.prepare(
				`SELECT created_at AS oldestAt
				 FROM ${table} INDEXED BY ${createdIndex}
				 WHERE status IN ('pending', 'leased')${predicate}
				 ORDER BY created_at ASC
				 LIMIT 1`,
			)
			.get() as { readonly oldestAt?: string | null } | undefined;
		return { depth: rows.length, oldestAt: oldest?.oldestAt ?? null };
	} catch {
		return undefined;
	}
}

export interface QueuePressureSnapshot {
	readonly memoryQueueDepth: number | undefined;
	readonly summaryQueueDepth: number | undefined;
	readonly oldestJobAgeSec: number | undefined;
}
export function getQueuePressureSnapshot(db: ReadDb): QueuePressureSnapshot {
	const memory = getQueuePressureQueryResult(db, "memory");
	const summary = getQueuePressureQueryResult(db, "summary");
	const oldestAt = [memory?.oldestAt, summary?.oldestAt].filter(
		(value): value is string => value !== undefined && value !== null,
	);
	const ages = oldestAt.map((value) => ageSec(value));
	return {
		memoryQueueDepth: memory?.depth,
		summaryQueueDepth: summary?.depth,
		oldestJobAgeSec: ages.length === 0 ? undefined : Math.max(...ages),
	};
}
export function getOldestDeadJob(db: ReadDb, source: QueueSource): OldestDeadJob | null {
	if (source === "summary") return null;
	if (source === "memory") {
		if (!tableExists(db, "memory_jobs")) return null;
		const row = db
			.prepare(
				`SELECT id, job_type AS harness, memory_id AS sessionKey, created_at AS createdAt,
				        attempts, error
				 FROM memory_jobs
					 WHERE status = 'dead' AND job_type <> 'extract'
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
	readonly oldestDeadSummaryJob: OldestDeadJob | null;
	readonly oldestDeadMemoryJob: OldestDeadJob | null;
}

const QUEUE_SNAPSHOT_CACHE_TTL_MS = 30_000;
let queueSnapshotCache = new WeakMap<
	ReadDb,
	{ readonly expiresAt: number; readonly value: QueueDiagnosticsSnapshot }
>();
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
		oldestDeadSummaryJob: null,
		oldestDeadMemoryJob: getOldestDeadJob(db, "memory"),
	};
	queueSnapshotCache.set(db, { expiresAt: now + QUEUE_SNAPSHOT_CACHE_TTL_MS, value });
	return value;
}

export function invalidateQueueDiagnosticsCache(): void {
	queueSnapshotCache = new WeakMap();
}

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
	}

	const score = clamp01(1 - penalty);
	if (worst === null) {
		return { score, status: "healthy" };
	}
	return { score, status: statusForScore(score) };
}
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
