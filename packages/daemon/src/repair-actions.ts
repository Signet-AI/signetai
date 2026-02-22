/**
 * Policy-gated repair actions for the memory pipeline.
 *
 * Each action checks the policy gate and rate limiter before running.
 * Operators bypass the autonomousEnabled check; agents do not.
 * All actions respect autonomousFrozen regardless of actor type.
 */

import type { DbAccessor, WriteDb } from "./db-accessor";
import type { EmbeddingConfig } from "./memory-config";
import { countChanges, vectorToBlob, syncVecInsert, syncVecDeleteBySourceExceptHash } from "./db-helpers";
import { insertHistoryEvent } from "./transactions";
import { logger } from "./logger";
import type { PipelineV2Config } from "./memory-config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RepairContext {
	readonly reason: string;
	readonly actor: string;
	readonly actorType: "operator" | "agent" | "daemon";
	readonly requestId?: string;
}

export interface RepairResult {
	readonly action: string;
	readonly success: boolean;
	readonly affected: number;
	readonly message: string;
}

export interface RepairGateCheck {
	readonly allowed: boolean;
	readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

interface RateLimiterEntry {
	lastRunAt: number;
	hourlyCount: number;
	hourResetAt: number;
}

export interface RateLimiter {
	check(
		action: string,
		cooldownMs: number,
		hourlyBudget: number,
	): RepairGateCheck;
	record(action: string): void;
}

export function createRateLimiter(): RateLimiter {
	const state = new Map<string, RateLimiterEntry>();

	return {
		check(
			action: string,
			cooldownMs: number,
			hourlyBudget: number,
		): RepairGateCheck {
			const now = Date.now();
			const entry = state.get(action);

			if (!entry) return { allowed: true };

			if (now - entry.lastRunAt < cooldownMs) {
				const remainingMs = cooldownMs - (now - entry.lastRunAt);
				return {
					allowed: false,
					reason: `cooldown active, ${remainingMs}ms remaining`,
				};
			}

			// Reset hourly counter if the window has passed
			const effectiveCount =
				now >= entry.hourResetAt ? 0 : entry.hourlyCount;
			if (effectiveCount >= hourlyBudget) {
				return {
					allowed: false,
					reason: `hourly budget exhausted (${hourlyBudget} runs/hr)`,
				};
			}

			return { allowed: true };
		},

		record(action: string): void {
			const now = Date.now();
			const entry = state.get(action);

			if (!entry) {
				state.set(action, {
					lastRunAt: now,
					hourlyCount: 1,
					hourResetAt: now + 60 * 60 * 1000,
				});
				return;
			}

			// Reset hourly count if the window has passed
			if (now >= entry.hourResetAt) {
				entry.hourlyCount = 1;
				entry.hourResetAt = now + 60 * 60 * 1000;
			} else {
				entry.hourlyCount++;
			}
			entry.lastRunAt = now;
		},
	};
}

// ---------------------------------------------------------------------------
// Policy gate
// ---------------------------------------------------------------------------

export function checkRepairGate(
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	action: string,
	cooldownMs: number,
	hourlyBudget: number,
): RepairGateCheck {
	if (cfg.autonomousFrozen) {
		return { allowed: false, reason: "autonomousFrozen is set" };
	}

	// Agents require autonomousEnabled; operators and daemon bypass this check
	if (ctx.actorType === "agent" && !cfg.autonomousEnabled) {
		return {
			allowed: false,
			reason: "autonomousEnabled is false; agents cannot trigger repairs",
		};
	}

	return limiter.check(action, cooldownMs, hourlyBudget);
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

function writeRepairAudit(
	db: WriteDb,
	action: string,
	ctx: RepairContext,
	affected: number,
	message: string,
): void {
	insertHistoryEvent(db, {
		memoryId: "system",
		event: "none",
		oldContent: null,
		newContent: null,
		changedBy: ctx.actor,
		reason: ctx.reason,
		metadata: JSON.stringify({ repairAction: action, affected, message }),
		createdAt: new Date().toISOString(),
		actorType: ctx.actorType,
		requestId: ctx.requestId,
	});
}

// ---------------------------------------------------------------------------
// Repair actions
// ---------------------------------------------------------------------------

const DEFAULT_REQUEUE_BATCH = 50;
// FTS rebuilds are heavyweight; cap their hourly budget at 5
const FTS_HOURLY_BUDGET = 5;

/**
 * Reset dead jobs to pending so the worker will retry them.
 */
export function requeueDeadJobs(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	maxBatch: number = DEFAULT_REQUEUE_BATCH,
): RepairResult {
	const action = "requeueDeadJobs";
	const gate = checkRepairGate(
		cfg,
		ctx,
		limiter,
		action,
		cfg.repairRequeueCooldownMs,
		cfg.repairRequeueHourlyBudget,
	);

	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			message: gate.reason ?? "denied by policy gate",
		};
	}

	const affected = accessor.withWriteTx((db) => {
		const dead = db
			.prepare("SELECT id FROM memory_jobs WHERE status = 'dead' LIMIT ?")
			.all(maxBatch) as Array<{ id: string }>;

		if (dead.length === 0) return 0;

		const placeholders = dead.map(() => "?").join(", ");
		const ids = dead.map((r) => r.id);
		const now = new Date().toISOString();
		const result = db
			.prepare(
				`UPDATE memory_jobs
				 SET status = 'pending', attempts = 0, updated_at = ?
				 WHERE id IN (${placeholders})`,
			)
			.run(now, ...ids);

		const count = countChanges(result);
		const msg = `requeued ${count} dead job(s) to pending`;
		writeRepairAudit(db, action, ctx, count, msg);
		return count;
	});

	limiter.record(action);
	logger.info("pipeline", "repair: requeued dead jobs", {
		affected,
		actor: ctx.actor,
		reason: ctx.reason,
	});

	return {
		action,
		success: true,
		affected,
		message: `requeued ${affected} dead job(s) to pending`,
	};
}

/**
 * Release jobs stuck in 'leased' state past the lease timeout.
 */
export function releaseStaleLeases(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
): RepairResult {
	const action = "releaseStaleLeases";
	const gate = checkRepairGate(
		cfg,
		ctx,
		limiter,
		action,
		cfg.repairRequeueCooldownMs,
		cfg.repairRequeueHourlyBudget,
	);

	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			message: gate.reason ?? "denied by policy gate",
		};
	}

	const cutoff = new Date(Date.now() - cfg.leaseTimeoutMs).toISOString();

	const affected = accessor.withWriteTx((db) => {
		const now = new Date().toISOString();
		const result = db
			.prepare(
				`UPDATE memory_jobs
				 SET status = 'pending', leased_at = NULL, updated_at = ?
				 WHERE status = 'leased' AND leased_at < ?`,
			)
			.run(now, cutoff);

		const count = countChanges(result);
		const msg = `released ${count} stale lease(s) back to pending`;
		writeRepairAudit(db, action, ctx, count, msg);
		return count;
	});

	limiter.record(action);
	logger.info("pipeline", "repair: released stale leases", {
		affected,
		cutoff,
		actor: ctx.actor,
		reason: ctx.reason,
	});

	return {
		action,
		success: true,
		affected,
		message: `released ${affected} stale lease(s) back to pending`,
	};
}

/**
 * Check FTS row count against active memory count, optionally rebuilding.
 * Uses a longer cooldown since FTS rebuilds are expensive.
 */
export function checkFtsConsistency(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	repair: boolean = false,
): RepairResult {
	const action = "checkFtsConsistency";
	const gate = checkRepairGate(
		cfg,
		ctx,
		limiter,
		action,
		cfg.repairReembedCooldownMs,
		FTS_HOURLY_BUDGET,
	);

	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			message: gate.reason ?? "denied by policy gate",
		};
	}

	const { memCount, ftsCount } = accessor.withReadDb((db) => {
		const memRow = db
			.prepare("SELECT COUNT(*) as n FROM memories WHERE is_deleted = 0")
			.get() as { n: number };
		const ftsRow = db
			.prepare("SELECT COUNT(*) as n FROM memories_fts")
			.get() as { n: number };
		return { memCount: memRow.n, ftsCount: ftsRow.n };
	});

	// FTS5 external content tables include tombstones, so ftsCount >=
	// memCount is normal. Only flag when the gap exceeds 10%, matching
	// the threshold in diagnostics.ts getIndexHealth().
	const mismatch =
		memCount > 0 && ftsCount > memCount * 1.1;

	if (mismatch && repair) {
		accessor.withWriteTx((db) => {
			db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
			writeRepairAudit(
				db,
				action,
				ctx,
				1,
				`FTS rebuilt: ${memCount} active vs ${ftsCount} FTS rows`,
			);
		});
	}

	limiter.record(action);

	const message = mismatch
		? `FTS mismatch: ${memCount} active memories vs ${ftsCount} FTS rows${repair ? " — rebuilt" : ""}`
		: `FTS consistent: ${memCount} active, ${ftsCount} FTS rows`;

	logger.info("pipeline", "repair: FTS consistency check", {
		memCount,
		ftsCount,
		mismatch,
		repaired: mismatch && repair,
		actor: ctx.actor,
	});

	return {
		action,
		success: true,
		affected: mismatch ? 1 : 0,
		message,
	};
}

/**
 * Trigger a retention sweep immediately via the retention worker handle.
 */
export function triggerRetentionSweep(
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	retentionHandle: { sweep(): unknown },
): RepairResult {
	const action = "triggerRetentionSweep";
	const gate = checkRepairGate(
		cfg,
		ctx,
		limiter,
		action,
		cfg.repairRequeueCooldownMs,
		cfg.repairRequeueHourlyBudget,
	);

	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			message: gate.reason ?? "denied by policy gate",
		};
	}

	retentionHandle.sweep();
	limiter.record(action);

	logger.info("pipeline", "repair: retention sweep triggered", {
		actor: ctx.actor,
		reason: ctx.reason,
	});

	return {
		action,
		success: true,
		affected: 0,
		message: "retention sweep triggered",
	};
}

// ---------------------------------------------------------------------------
// Embedding gap diagnostics
// ---------------------------------------------------------------------------

export interface EmbeddingGapStats {
	readonly unembedded: number;
	readonly total: number;
	readonly coverage: string;
}

export function getEmbeddingGapStats(
	accessor: DbAccessor,
): EmbeddingGapStats {
	return accessor.withReadDb((db) => {
		const totalRow = db
			.prepare("SELECT COUNT(*) as n FROM memories WHERE is_deleted = 0")
			.get() as { n: number };
		const unembeddedRow = db
			.prepare(
				`SELECT COUNT(*) as n FROM memories m
				 LEFT JOIN embeddings e
				   ON e.source_type = 'memory' AND e.source_id = m.id
				 WHERE m.is_deleted = 0 AND e.id IS NULL`,
			)
			.get() as { n: number };

		const total = totalRow.n;
		const unembedded = unembeddedRow.n;
		const pct = total > 0 ? ((total - unembedded) / total) * 100 : 100;

		return {
			unembedded,
			total,
			coverage: `${pct.toFixed(1)}%`,
		};
	});
}

// ---------------------------------------------------------------------------
// Re-embed missing memories
// ---------------------------------------------------------------------------

const DEFAULT_REEMBED_BATCH = 50;

interface UnembeddedMemory {
	readonly id: string;
	readonly content: string;
	readonly content_hash: string;
}

/**
 * Backfill embeddings for memories that have no vector.
 *
 * Embedding fetches are async network calls so this function is async
 * and carefully avoids calling the provider inside a write transaction.
 */
export async function reembedMissingMemories(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	embeddingFn: (
		content: string,
		cfg: EmbeddingConfig,
	) => Promise<number[] | null>,
	embeddingCfg: EmbeddingConfig,
	batchSize: number = DEFAULT_REEMBED_BATCH,
	dryRun: boolean = false,
): Promise<RepairResult> {
	const action = "reembedMissingMemories";
	const gate = checkRepairGate(
		cfg,
		ctx,
		limiter,
		action,
		cfg.repairReembedCooldownMs,
		cfg.repairReembedHourlyBudget,
	);

	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			message: gate.reason ?? "denied by policy gate",
		};
	}

	// Step 1: read unembedded memories (outside any write tx)
	const unembedded = accessor.withReadDb((db) => {
		return db
			.prepare(
				`SELECT m.id, m.content, m.content_hash
				 FROM memories m
				 LEFT JOIN embeddings e
				   ON e.source_type = 'memory' AND e.source_id = m.id
				 WHERE m.is_deleted = 0 AND e.id IS NULL
				 ORDER BY m.created_at ASC
				 LIMIT ?`,
			)
			.all(batchSize) as UnembeddedMemory[];
	});

	if (unembedded.length === 0) {
		return {
			action,
			success: true,
			affected: 0,
			message: "no unembedded memories found",
		};
	}

	if (dryRun) {
		const stats = getEmbeddingGapStats(accessor);
		return {
			action,
			success: true,
			affected: 0,
			message: `dry run: ${unembedded.length} memories in this batch, ${stats.unembedded} total unembedded`,
		};
	}

	// Step 2: fetch embeddings async (outside any transaction)
	const results: Array<{
		memory: UnembeddedMemory;
		vector: readonly number[];
	}> = [];

	for (const mem of unembedded) {
		try {
			const vec = await embeddingFn(mem.content, embeddingCfg);
			if (vec) {
				results.push({ memory: mem, vector: vec });
			}
		} catch (err) {
			logger.warn("pipeline", "re-embed: embedding failed", {
				memoryId: mem.id,
				error: (err as Error).message,
			});
		}
	}

	if (results.length === 0) {
		return {
			action,
			success: false,
			affected: 0,
			message: `embedding provider returned no vectors for ${unembedded.length} memories`,
		};
	}

	// Step 3: batch-write embeddings in a single write tx
	const written = accessor.withWriteTx((db) => {
		const now = new Date().toISOString();
		let count = 0;

		for (const { memory, vector } of results) {
			const embId = crypto.randomUUID();
			const blob = vectorToBlob(vector);
			syncVecDeleteBySourceExceptHash(
				db,
				"memory",
				memory.id,
				memory.content_hash,
			);
			db.prepare(
				`DELETE FROM embeddings
				 WHERE source_type = 'memory' AND source_id = ?
				   AND content_hash <> ?`,
			).run(memory.id, memory.content_hash);
			const result = db
				.prepare(
					`INSERT INTO embeddings
					 (id, content_hash, vector, dimensions, source_type,
					  source_id, chunk_text, created_at)
					 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)
					 ON CONFLICT(content_hash) DO UPDATE SET
					   vector = excluded.vector,
					   dimensions = excluded.dimensions,
					   source_type = excluded.source_type,
					   source_id = excluded.source_id,
					   chunk_text = excluded.chunk_text,
					   created_at = excluded.created_at`,
				)
				.run(
					embId,
					memory.content_hash,
					blob,
					vector.length,
					memory.id,
					memory.content,
					now,
				);
			if (countChanges(result) > 0) {
				syncVecInsert(db, embId, vector);
				count++;
			}
		}

		const msg = `re-embedded ${count} of ${unembedded.length} memories`;
		writeRepairAudit(db, action, ctx, count, msg);
		return count;
	});

	limiter.record(action);
	logger.info("pipeline", "repair: re-embedded missing memories", {
		affected: written,
		attempted: unembedded.length,
		actor: ctx.actor,
		reason: ctx.reason,
	});

	return {
		action,
		success: true,
		affected: written,
		message: `re-embedded ${written} of ${unembedded.length} memories`,
	};
}
