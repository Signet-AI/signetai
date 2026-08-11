import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";

const HOUR_MS = 60 * 60 * 1000;
// A batch can make sequential provider calls. Keep the owner lease alive for
// the whole hourly accounting window so a slow but healthy batch cannot be
// duplicated by a restarted daemon halfway through that work.
const MIN_LEASE_MS = HOUR_MS;

export interface EmbeddingRepairKey {
	readonly id: string;
	readonly contentHash: string;
}

export interface EmbeddingRepairLease {
	readonly id: string;
}

export interface EmbeddingRepairAdmission {
	readonly allowed: boolean;
	readonly lease?: EmbeddingRepairLease;
	readonly reason?: string;
}

export interface EmbeddingRepairFailure {
	readonly attempts: number;
	readonly retryAt: number;
}

export type EmbeddingRepairEligibility = boolean | ((db: WriteDb) => boolean);

export interface EmbeddingRepairState {
	readonly windowStartedAt: string;
	readonly batchesStarted: number;
	readonly lastCompletedAt: string | null;
	readonly lastAffected: number;
	readonly leaseExpiresAt: string | null;
	readonly lastError: string | null;
}

interface BudgetRow {
	readonly window_started_at: string;
	readonly batches_started: number;
	readonly last_completed_at: string | null;
	readonly last_affected: number;
	readonly lease_id: string | null;
	readonly lease_expires_at: string | null;
	readonly last_error: string | null;
}

interface FailureRow {
	readonly memory_id: string;
	readonly content_hash: string;
	readonly attempts: number;
	readonly retry_at: string;
}

function iso(now: number): string {
	return new Date(now).toISOString();
}

function parseMs(value: string | null): number | null {
	if (value === null) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function readBudget(db: ReadDb): BudgetRow | null {
	return (
		(db
			.prepare(
				"SELECT window_started_at, batches_started, last_completed_at, last_affected, lease_id, lease_expires_at, last_error FROM embedding_repair_budget WHERE id = 1",
			)
			.get() as unknown as BudgetRow | null) ?? null
	);
}

function ensureBudget(db: WriteDb, now: number): BudgetRow {
	const nowIso = iso(now);
	db.prepare(
		`INSERT OR IGNORE INTO embedding_repair_budget
		 (id, window_started_at, batches_started, last_completed_at, last_affected, lease_id, lease_expires_at, last_error, updated_at)
		 VALUES (1, ?, 0, NULL, 0, NULL, NULL, NULL, ?)`,
	).run(nowIso, nowIso);
	const row = readBudget(db);
	if (row == null) throw new Error("embedding repair budget was not initialized");
	return row;
}

function validWindowStart(value: string, now: number): number | null {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && parsed <= now ? parsed : null;
}

export function acquireEmbeddingRepairLease(
	accessor: DbAccessor,
	cooldownMs: number,
	hourlyBudget: number,
	now = Date.now(),
): EmbeddingRepairAdmission {
	return accessor.withWriteTx((db) => {
		const row = ensureBudget(db, now);
		const leaseExpiry = parseMs(row.lease_expires_at);
		if (row.lease_id !== null && leaseExpiry !== null && leaseExpiry > now) {
			return { allowed: false, reason: "embedding repair already in progress" };
		}

		const lastCompletedAt = parseMs(row.last_completed_at);
		if (lastCompletedAt !== null && now - lastCompletedAt < cooldownMs) {
			return {
				allowed: false,
				reason: `embedding repair cooldown active, ${cooldownMs - (now - lastCompletedAt)}ms remaining`,
			};
		}

		const windowStartedAt = validWindowStart(row.window_started_at, now);
		const inWindow = windowStartedAt !== null && now - windowStartedAt < HOUR_MS;
		const batchesStarted = inWindow ? row.batches_started : 0;
		if (batchesStarted >= hourlyBudget) {
			return { allowed: false, reason: `embedding repair hourly budget exhausted (${hourlyBudget} batches/hr)` };
		}

		// A lease serializes provider work. The hourly slot is charged only when
		// finishEmbeddingRepairLease can persist an outcome for the active profile.
		const lease: EmbeddingRepairLease = { id: crypto.randomUUID() };
		const windowStart = inWindow ? row.window_started_at : iso(now);
		const leaseMs = Math.max(MIN_LEASE_MS, cooldownMs);
		db.prepare(
			`UPDATE embedding_repair_budget
			 SET window_started_at = ?, batches_started = ?, lease_id = ?, lease_expires_at = ?, last_error = NULL, updated_at = ?
			 WHERE id = 1`,
		).run(windowStart, batchesStarted, lease.id, iso(now + leaseMs), iso(now));
		return { allowed: true, lease };
	});
}

export function readEmbeddingRepairState(accessor: DbAccessor): EmbeddingRepairState | null {
	return accessor.withReadDb((db) => {
		const row = readBudget(db);
		if (row == null) return null;
		return {
			windowStartedAt: row.window_started_at,
			batchesStarted: row.batches_started,
			lastCompletedAt: row.last_completed_at,
			lastAffected: row.last_affected,
			leaseExpiresAt: row.lease_expires_at,
			lastError: row.last_error,
		};
	});
}

export function loadEmbeddingRepairFailures(
	accessor: DbAccessor,
	keys: readonly EmbeddingRepairKey[],
	model: string,
): ReadonlyMap<string, EmbeddingRepairFailure> {
	if (keys.length === 0) return new Map();
	return accessor.withReadDb((db) => {
		const failures = new Map<string, EmbeddingRepairFailure>();
		const query = db.prepare(
			"SELECT memory_id, content_hash, attempts, retry_at FROM embedding_repair_backoff WHERE memory_id = ? AND content_hash = ? AND model = ?",
		);
		for (const key of keys) {
			const row = query.get(key.id, key.contentHash, model) as unknown as FailureRow | null;
			const retryAt = row == null ? null : parseMs(row.retry_at);
			if (row != null && retryAt !== null)
				failures.set(`${key.id}:${key.contentHash}:${model}`, { attempts: row.attempts, retryAt });
		}
		return failures;
	});
}

export function finishEmbeddingRepairLease(
	accessor: DbAccessor,
	lease: EmbeddingRepairLease,
	outcome: {
		readonly successful: readonly EmbeddingRepairKey[];
		readonly failed: readonly EmbeddingRepairKey[];
		readonly model: string;
		readonly pollMs: number;
		readonly eligibility: EmbeddingRepairEligibility;
		readonly error?: string;
	},
	now = Date.now(),
): boolean {
	return accessor.withWriteTx((db) => {
		const current = readBudget(db);
		if (current == null || current.lease_id !== lease.id) return false;
		const eligible = typeof outcome.eligibility === "function" ? outcome.eligibility(db) : outcome.eligibility;
		if (!eligible) {
			db.prepare(
				`UPDATE embedding_repair_budget
				 SET lease_id = NULL, lease_expires_at = NULL, updated_at = ?
				 WHERE id = 1 AND lease_id = ?`,
			).run(iso(now), lease.id);
			return false;
		}

		const deleteFailure = db.prepare(
			"DELETE FROM embedding_repair_backoff WHERE memory_id = ? AND content_hash = ? AND model = ?",
		);
		const readFailure = db.prepare(
			"SELECT attempts FROM embedding_repair_backoff WHERE memory_id = ? AND content_hash = ? AND model = ?",
		);
		const writeFailure = db.prepare(
			`INSERT INTO embedding_repair_backoff (memory_id, content_hash, model, attempts, retry_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(memory_id, content_hash, model) DO UPDATE SET
			   attempts = excluded.attempts, retry_at = excluded.retry_at, updated_at = excluded.updated_at`,
		);

		for (const key of outcome.successful) deleteFailure.run(key.id, key.contentHash, outcome.model);
		for (const key of outcome.failed) {
			const previous = readFailure.get(key.id, key.contentHash, outcome.model) as { attempts: number } | null;
			const attempts = (previous?.attempts ?? 0) + 1;
			const retryMs = computeRetryBackoffMs(attempts, outcome.pollMs);
			writeFailure.run(key.id, key.contentHash, outcome.model, attempts, iso(now + retryMs), iso(now));
		}

		const windowStartedAt = validWindowStart(current.window_started_at, now);
		const inWindow = windowStartedAt !== null && now - windowStartedAt < HOUR_MS;
		const batchesStarted = inWindow ? current.batches_started : 0;
		const error = outcome.error ?? (outcome.failed.length > 0 ? "embedding provider returned no vector" : null);
		db.prepare(
			`UPDATE embedding_repair_budget
			 SET window_started_at = ?, batches_started = ?, last_completed_at = ?, last_affected = ?,
			     lease_id = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
			 WHERE id = 1 AND lease_id = ?`,
		).run(
			inWindow ? current.window_started_at : iso(now),
			batchesStarted + 1,
			iso(now),
			outcome.successful.length,
			error,
			iso(now),
			lease.id,
		);
		return true;
	});
}

export function computeRetryBackoffMs(attempts: number, pollMs: number): number {
	if (attempts <= 1) return Math.max(pollMs * 5, 60_000);
	if (attempts === 2) return Math.max(pollMs * 25, 5 * 60_000);
	if (attempts === 3) return Math.max(pollMs * 150, 30 * 60_000);
	return Math.max(pollMs * 300, 60 * 60_000);
}
