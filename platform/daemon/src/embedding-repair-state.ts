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

export type EmbeddingRepairCheckpointStatus = "running" | "complete" | "failed";

export interface EmbeddingRepairCheckpoint {
	readonly checkpointId: string;
	readonly agentId: string;
	readonly model: string;
	readonly status: EmbeddingRepairCheckpointStatus;
	readonly batches: number;
	readonly selected: number;
	readonly written: number;
	readonly failed: number;
	readonly stale: number;
	readonly crossAgentHashConflicts: number;
	readonly lastError: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface EmbeddingRepairCheckpointUpdate {
	readonly batches?: number;
	readonly selected?: number;
	readonly written?: number;
	readonly failed?: number;
	readonly stale?: number;
	readonly crossAgentHashConflicts?: number;
	readonly status?: EmbeddingRepairCheckpointStatus;
	readonly lastError?: string | null;
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

interface CheckpointRow {
	readonly checkpoint_id: string;
	readonly agent_id: string;
	readonly model: string;
	readonly status: EmbeddingRepairCheckpointStatus;
	readonly batches: number;
	readonly selected: number;
	readonly written: number;
	readonly failed: number;
	readonly stale: number;
	readonly cross_agent_hash_conflicts: number;
	readonly last_error: string | null;
	readonly created_at: string;
	readonly updated_at: string;
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

function checkpointFromRow(row: CheckpointRow): EmbeddingRepairCheckpoint {
	return {
		checkpointId: row.checkpoint_id,
		agentId: row.agent_id,
		model: row.model,
		status: row.status,
		batches: row.batches,
		selected: row.selected,
		written: row.written,
		failed: row.failed,
		stale: row.stale,
		crossAgentHashConflicts: row.cross_agent_hash_conflicts,
		lastError: row.last_error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function readCheckpoint(db: ReadDb, checkpointId: string): CheckpointRow | null {
	return (
		(db
			.prepare(
				`SELECT checkpoint_id, agent_id, model, status, batches, selected, written,
					failed, stale, cross_agent_hash_conflicts, last_error, created_at, updated_at
				 FROM embedding_repair_checkpoints WHERE checkpoint_id = ?`,
			)
			.get(checkpointId) as unknown as CheckpointRow | null) ?? null
	);
}

export function readEmbeddingRepairCheckpoint(
	accessor: DbAccessor,
	checkpointId: string,
): EmbeddingRepairCheckpoint | null {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb((db: ReadDb) => {
		const row = readCheckpoint(db, checkpointId);
		return row === null ? null : checkpointFromRow(row);
	}, "embedding-repair-state.ts:read-checkpoint");
}

export function ensureEmbeddingRepairCheckpoint(
	accessor: DbAccessor,
	checkpointId: string,
	agentId: string,
	model: string,
	now = Date.now(),
): EmbeddingRepairCheckpoint {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	return accessor.withWriteTx((db: WriteDb) => {
		const nowIso = iso(now);
		db.prepare(
			`INSERT OR IGNORE INTO embedding_repair_checkpoints
				(checkpoint_id, agent_id, model, status, batches, selected, written, failed,
				 stale, cross_agent_hash_conflicts, last_error, created_at, updated_at)
			 VALUES (?, ?, ?, 'running', 0, 0, 0, 0, 0, 0, NULL, ?, ?)`,
		).run(checkpointId, agentId, model, nowIso, nowIso);
		const row = readCheckpoint(db, checkpointId);
		if (row === null) throw new Error(`embedding repair checkpoint ${checkpointId} was not initialized`);
		if (row.agent_id !== agentId || row.model !== model) {
			throw new Error(`embedding repair checkpoint ${checkpointId} does not match the requested agent or model`);
		}
		return checkpointFromRow(row);
	}, "embedding-repair-state.ts:ensure-checkpoint");
}

export function updateEmbeddingRepairCheckpoint(
	accessor: DbAccessor,
	checkpointId: string,
	update: EmbeddingRepairCheckpointUpdate,
	now = Date.now(),
): EmbeddingRepairCheckpoint {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	return accessor.withWriteTx((db: WriteDb) => {
		const current = readCheckpoint(db, checkpointId);
		if (current === null) throw new Error(`embedding repair checkpoint ${checkpointId} was not found`);
		const nowIso = iso(now);
		db.prepare(
			`UPDATE embedding_repair_checkpoints
			 SET status = COALESCE(?, status),
			batches = batches + ?,
			     selected = selected + ?,
			     written = written + ?,
			     failed = failed + ?,
			     stale = stale + ?,
			     cross_agent_hash_conflicts = cross_agent_hash_conflicts + ?,
			     last_error = ?,
			     updated_at = ?
			 WHERE checkpoint_id = ?`,
		).run(
			update.status ?? null,
			update.batches ?? 1,
			update.selected ?? 0,
			update.written ?? 0,
			update.failed ?? 0,
			update.stale ?? 0,
			update.crossAgentHashConflicts ?? 0,
			update.lastError === undefined ? current.last_error : update.lastError,
			nowIso,
			checkpointId,
		);
		const row = readCheckpoint(db, checkpointId);
		if (row === null) throw new Error(`embedding repair checkpoint ${checkpointId} disappeared`);
		return checkpointFromRow(row);
	}, "embedding-repair-state.ts:update-checkpoint");
}

export function acquireEmbeddingRepairLease(
	accessor: DbAccessor,
	cooldownMs: number,
	hourlyBudget: number,
	now = Date.now(),
): EmbeddingRepairAdmission {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	return accessor.withWriteTx((db: import("./db-accessor").WriteDb) => {
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
	}, "embedding-repair-state.ts:101");
}

export function readEmbeddingRepairState(accessor: DbAccessor): EmbeddingRepairState | null {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb((db: import("./db-accessor").ReadDb) => {
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
	}, "embedding-repair-state.ts:139");
}

export function isEmbeddingRepairLeaseActive(db: ReadDb, lease: EmbeddingRepairLease, now = Date.now()): boolean {
	const row = readBudget(db);
	const expiresAt = row === null ? null : parseMs(row.lease_expires_at);
	return row?.lease_id === lease.id && expiresAt !== null && expiresAt > now;
}

export function loadEmbeddingRepairFailures(
	accessor: DbAccessor,
	keys: readonly EmbeddingRepairKey[],
	model: string,
): ReadonlyMap<string, EmbeddingRepairFailure> {
	if (keys.length === 0) return new Map();
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb((db: import("./db-accessor").ReadDb) => {
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
	}, "embedding-repair-state.ts:160");
}

export function finishEmbeddingRepairLease(
	accessor: DbAccessor,
	lease: EmbeddingRepairLease,
	outcome: {
		readonly successful: readonly EmbeddingRepairKey[];
		/** Number of committed rows when the caller uses a bounded repair action. */
		readonly affected?: number;
		readonly failed: readonly EmbeddingRepairKey[];
		readonly model: string;
		readonly pollMs: number;
		readonly eligibility: EmbeddingRepairEligibility;
		readonly error?: string;
	},
	now = Date.now(),
): boolean {
	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
		return accessor.withWriteTx((db: import("./db-accessor").WriteDb) => {
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
			// A lease serializes attempted work, but the hourly budget represents
			// completed repair work. A pressure abort can still persist failure
			// backoff while releasing its lease without spending a batch slot.
			const charged = outcome.successful.length > 0 || (outcome.affected ?? 0) > 0;
			const error = outcome.error ?? (outcome.failed.length > 0 ? "embedding provider returned no vector" : null);
			db.prepare(
				`UPDATE embedding_repair_budget
			 SET window_started_at = ?, batches_started = ?, last_completed_at = ?, last_affected = ?,
			     lease_id = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
			 WHERE id = 1 AND lease_id = ?`,
			).run(
				inWindow ? current.window_started_at : iso(now),
				batchesStarted + (charged ? 1 : 0),
				iso(now),
				outcome.affected ?? outcome.successful.length,
				error,
				iso(now),
				lease.id,
			);
			return true;
		}, "embedding-repair-state.ts:191");
	} catch (error) {
		// A failure while persisting provider/backoff accounting must not strand
		// the durable lease until its expiry. Best-effort release preserves the
		// original error while allowing the next repair request to proceed.
		try {
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
			accessor.withWriteTx((db: import("./db-accessor").WriteDb) => {
				db.prepare(
					`UPDATE embedding_repair_budget
					 SET lease_id = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
					 WHERE id = 1 AND lease_id = ?`,
				).run(error instanceof Error ? error.message : String(error), iso(now), lease.id);
			}, "embedding-repair-state.ts:release-after-finish-error");
		} catch {
			// Preserve the original failure; a later lease-expiry recovery can
			// still reclaim the row if the fallback transaction also fails.
		}
		throw error;
	}
}

export function computeRetryBackoffMs(attempts: number, pollMs: number): number {
	if (attempts <= 1) return Math.max(pollMs * 5, 60_000);
	if (attempts === 2) return Math.max(pollMs * 25, 5 * 60_000);
	if (attempts === 3) return Math.max(pollMs * 150, 30 * 60_000);
	return Math.max(pollMs * 300, 60 * 60_000);
}
