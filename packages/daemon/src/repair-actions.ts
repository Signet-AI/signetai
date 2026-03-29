/**
 * Policy-gated repair actions for the memory pipeline.
 *
 * Each action checks the policy gate and rate limiter before running.
 * Operators bypass the autonomousEnabled check; agents do not.
 * All actions respect autonomousFrozen regardless of actor type.
 */

import type { LlmProvider } from "@signet/core";
import { normalizeAndHashContent } from "./content-normalization";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import {
	countChanges,
	syncVecDeleteByEmbeddingIds,
	syncVecDeleteBySourceExceptHash,
	syncVecInsert,
	vectorToBlob,
} from "./db-helpers";
import { type UnembeddedRow, countUnembeddedMemories, listUnembeddedMemories } from "./embedding-coverage";
import { logger } from "./logger";
import type { EmbeddingConfig } from "./memory-config";
import type { PipelineV2Config } from "./memory-config";
import { recoverStaleLeases } from "./pipeline/stale-leases";
import { insertHistoryEvent } from "./transactions";

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
	check(action: string, cooldownMs: number, hourlyBudget: number): RepairGateCheck;
	record(action: string): void;
}

export function createRateLimiter(): RateLimiter {
	const state = new Map<string, RateLimiterEntry>();

	return {
		check(action: string, cooldownMs: number, hourlyBudget: number): RepairGateCheck {
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
			const effectiveCount = now >= entry.hourResetAt ? 0 : entry.hourlyCount;
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
	if (cfg.autonomous.frozen) {
		return { allowed: false, reason: "autonomous.frozen is set" };
	}

	// Agents require autonomous.enabled; operators and daemon bypass this check
	if (ctx.actorType === "agent" && !cfg.autonomous.enabled) {
		return {
			allowed: false,
			reason: "autonomous.enabled is false; agents cannot trigger repairs",
		};
	}

	// Operators and daemon bypass rate limiting — only agents are throttled
	if (ctx.actorType === "operator" || ctx.actorType === "daemon") {
		return { allowed: true };
	}

	return limiter.check(action, cooldownMs, hourlyBudget);
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

function writeRepairAudit(db: WriteDb, action: string, ctx: RepairContext, affected: number, message: string): void {
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
	const gate = checkRepairGate(cfg, ctx, limiter, action, cfg.repair.requeueCooldownMs, cfg.repair.requeueHourlyBudget);

	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			message: gate.reason ?? "denied by policy gate",
		};
	}

	// Requeue both memory_jobs and summary_jobs in a single transaction
	// so the rate limiter only records on full success.
	const { memoryCount, summaryCount } = accessor.withWriteTx((db) => {
		// --- memory_jobs ---
		let memoryCount = 0;
		const dead = db.prepare("SELECT id FROM memory_jobs WHERE status = 'dead' LIMIT ?").all(maxBatch) as Array<{
			id: string;
		}>;

		if (dead.length > 0) {
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

			memoryCount = countChanges(result);
			const msg = `requeued ${memoryCount} dead job(s) to pending`;
			writeRepairAudit(db, action, ctx, memoryCount, msg);
		}

		// --- summary_jobs (issue #181) ---
		// Share the maxBatch budget: only requeue up to the remaining capacity
		const summaryBudget = maxBatch - memoryCount;
		let summaryCount = 0;
		const tableExists = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'summary_jobs'")
			.get();

		if (tableExists && summaryBudget > 0) {
			const deadSummary = db
				.prepare("SELECT id FROM summary_jobs WHERE status = 'dead' LIMIT ?")
				.all(summaryBudget) as Array<{ id: string }>;

			if (deadSummary.length > 0) {
				const placeholders = deadSummary.map(() => "?").join(", ");
				const ids = deadSummary.map((r) => r.id);
				const result = db
					.prepare(
						`UPDATE summary_jobs
						 SET status = 'pending', attempts = 0, error = NULL
						 WHERE id IN (${placeholders})`,
					)
					.run(...ids);
				summaryCount = countChanges(result);
				const msg = `requeued ${summaryCount} dead summary job(s) to pending`;
				writeRepairAudit(db, action, ctx, summaryCount, msg);
			}
		}

		return { memoryCount, summaryCount };
	});

	const totalAffected = memoryCount + summaryCount;

	limiter.record(action);
	logger.info("pipeline", "repair: requeued dead jobs", {
		memoryJobs: memoryCount,
		summaryJobs: summaryCount,
		total: totalAffected,
		actor: ctx.actor,
		reason: ctx.reason,
	});

	return {
		action,
		success: true,
		affected: totalAffected,
		message: `requeued ${memoryCount} dead memory job(s) and ${summaryCount} dead summary job(s) to pending`,
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
	const gate = checkRepairGate(cfg, ctx, limiter, action, cfg.repair.requeueCooldownMs, cfg.repair.requeueHourlyBudget);

	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			message: gate.reason ?? "denied by policy gate",
		};
	}

	const cutoff = new Date(Date.now() - cfg.worker.leaseTimeoutMs).toISOString();

	const result = accessor.withWriteTx((db) => {
		const now = new Date().toISOString();
		const recovered = recoverStaleLeases(db, { cutoff, now });
		const msg =
			recovered.dead > 0
				? `released ${recovered.pending} stale lease(s) back to pending and dead-lettered ${recovered.dead} exhausted job(s)`
				: `released ${recovered.pending} stale lease(s) back to pending`;
		writeRepairAudit(db, action, ctx, recovered.total, msg);
		return {
			msg,
			recovered,
		};
	});

	limiter.record(action);
	logger.info("pipeline", "repair: released stale leases", {
		affected: result.recovered.total,
		pending: result.recovered.pending,
		dead: result.recovered.dead,
		cutoff,
		actor: ctx.actor,
		reason: ctx.reason,
	});

	return {
		action,
		success: true,
		affected: result.recovered.total,
		message: result.msg,
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
	repair = false,
): RepairResult {
	const action = "checkFtsConsistency";
	const gate = checkRepairGate(cfg, ctx, limiter, action, cfg.repair.reembedCooldownMs, FTS_HOURLY_BUDGET);

	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			message: gate.reason ?? "denied by policy gate",
		};
	}

	const { memCount, ftsCount, ftsMissing } = accessor.withReadDb((db) => {
		const memRow = db.prepare("SELECT COUNT(*) as n FROM memories WHERE is_deleted = 0").get() as { n: number };

		// Guard against missing FTS table (can happen on upgrades)
		let ftsN = 0;
		let missing = false;
		try {
			const ftsRow = db.prepare("SELECT COUNT(*) as n FROM memories_fts").get() as { n: number };
			ftsN = ftsRow.n;
		} catch {
			missing = true;
		}
		return { memCount: memRow.n, ftsCount: ftsN, ftsMissing: missing };
	});

	// If FTS table is missing entirely, report it (startup self-heal
	// via ensureFtsTable should have caught this, but handle gracefully)
	if (ftsMissing) {
		limiter.record(action);
		const msg = repair
			? "FTS table missing — restart daemon to trigger self-healing rebuild"
			: "FTS table missing — run with repair=true or restart daemon";
		logger.warn("pipeline", "repair: FTS table missing", {
			memCount,
			actor: ctx.actor,
		});
		return {
			action,
			success: true,
			affected: 0,
			message: msg,
		};
	}

	// FTS5 external content tables include tombstones, so ftsCount >=
	// memCount is normal. Only flag when the gap exceeds 10%, matching
	// the threshold in diagnostics.ts getIndexHealth().
	const mismatch = memCount > 0 && ftsCount > memCount * 1.1;

	if (mismatch && repair) {
		accessor.withWriteTx((db) => {
			db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')").run();
			writeRepairAudit(db, action, ctx, 1, `FTS rebuilt: ${memCount} active vs ${ftsCount} FTS rows`);
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
	const gate = checkRepairGate(cfg, ctx, limiter, action, cfg.repair.requeueCooldownMs, cfg.repair.requeueHourlyBudget);

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

export function getEmbeddingGapStats(accessor: DbAccessor): EmbeddingGapStats {
	return accessor.withReadDb((db) => {
		const totalRow = db.prepare("SELECT COUNT(*) as n FROM memories WHERE is_deleted = 0").get() as { n: number };
		const total = totalRow.n;
		const unembedded = countUnembeddedMemories(db);
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

interface ReembedBatchOutcome {
	readonly selected: number;
	readonly written: number;
	readonly failed: number;
}

let reembedInProgress = false;

async function reembedMissingMemoriesBatch(
	accessor: DbAccessor,
	embeddingFn: (content: string, cfg: EmbeddingConfig) => Promise<number[] | null>,
	embeddingCfg: EmbeddingConfig,
	batchSize: number,
): Promise<ReembedBatchOutcome> {
	const unembedded = accessor.withReadDb((db) => {
		return listUnembeddedMemories(db, batchSize) as UnembeddedRow[];
	});

	if (unembedded.length === 0) {
		return {
			selected: 0,
			written: 0,
			failed: 0,
		};
	}

	const results: Array<{
		memory: UnembeddedRow;
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
			selected: unembedded.length,
			written: 0,
			failed: unembedded.length,
		};
	}

	const written = accessor.withWriteTx((db) => {
		const now = new Date().toISOString();
		let count = 0;
		// Hoisted outside loop (pattern: db.prepare inside a loop is flagged)
		const writeHash = db.prepare("UPDATE memories SET content_hash = ? WHERE id = ? AND content_hash IS NULL");
		// Guard against unique constraint violation: idx_memories_content_hash_unique
		// is a partial unique index on (content_hash) WHERE content_hash IS NOT NULL AND is_deleted = 0.
		// If another non-deleted memory already owns the same hash, writing it back would throw
		// and abort the entire batch. Skip the write-back in that case -- the dedup worker
		// will soft-delete the duplicate in a later pass.
		const checkHash = db.prepare(
			`SELECT id FROM memories WHERE content_hash = ? AND is_deleted = 0 AND id <> ? LIMIT 1`,
		);

		for (const { memory, vector } of results) {
			const contentHash =
				typeof memory.contentHash === "string" && memory.contentHash.trim().length > 0
					? memory.contentHash
					: normalizeAndHashContent(memory.content).contentHash;

			// Write computed hash back to the memories row when it was NULL.
			// Without this, the embedding-coverage queries can never use the
			// content_hash match branch for these rows, so they keep showing up
			// as unembedded and the backfill cycles indefinitely.
			if (!memory.contentHash) {
				const collision = checkHash.get(contentHash, memory.id) as { id: string } | undefined;
				if (!collision) writeHash.run(contentHash, memory.id);
			}

			const embId = crypto.randomUUID();
			const blob = vectorToBlob(vector);
			syncVecDeleteBySourceExceptHash(db, "memory", memory.id, contentHash);
			db.prepare(
				`DELETE FROM embeddings
				 WHERE source_type = 'memory' AND source_id = ?
				   AND content_hash <> ?`,
			).run(memory.id, contentHash);
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
					   chunk_text = excluded.chunk_text,
					   created_at = excluded.created_at`,
				)
				.run(embId, contentHash, blob, vector.length, memory.id, memory.content, now);
			// Resolve actual embedding ID (may differ from embId on conflict)
			const actualRow = db.prepare("SELECT id FROM embeddings WHERE content_hash = ?").get(contentHash) as
				| { id: string }
				| undefined;
			if (actualRow) {
				syncVecInsert(db, actualRow.id, vector);
				count++;
			}
		}

		return count;
	});

	return {
		selected: unembedded.length,
		written,
		failed: unembedded.length - results.length,
	};
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
	embeddingFn: (content: string, cfg: EmbeddingConfig) => Promise<number[] | null>,
	embeddingCfg: EmbeddingConfig,
	batchSize: number = DEFAULT_REEMBED_BATCH,
	dryRun = false,
	runToCompletion = false,
	cooldownMsOverride?: number,
): Promise<RepairResult> {
	const action = "reembedMissingMemories";
	const effectiveCooldownMs =
		typeof cooldownMsOverride === "number" && Number.isFinite(cooldownMsOverride)
			? Math.max(0, Math.floor(cooldownMsOverride))
			: cfg.repair.reembedCooldownMs;
	const gate = checkRepairGate(cfg, ctx, limiter, action, effectiveCooldownMs, cfg.repair.reembedHourlyBudget);

	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			message: gate.reason ?? "denied by policy gate",
		};
	}

	const normalizedBatchSize =
		Number.isFinite(batchSize) && batchSize > 0 ? Math.max(1, Math.floor(batchSize)) : DEFAULT_REEMBED_BATCH;

	const initialStats = getEmbeddingGapStats(accessor);
	if (initialStats.unembedded === 0) {
		return {
			action,
			success: true,
			affected: 0,
			message: "no unembedded memories found",
		};
	}

	if (dryRun) {
		return {
			action,
			success: true,
			affected: 0,
			message: `dry run: ${Math.min(normalizedBatchSize, initialStats.unembedded)} memories in this batch, ${initialStats.unembedded} total unembedded`,
		};
	}

	if (reembedInProgress) {
		return {
			action,
			success: false,
			affected: 0,
			message: "re-embed already in progress",
		};
	}

	reembedInProgress = true;
	try {
		let attempted = 0;
		let written = 0;
		let failed = 0;
		let batches = 0;

		while (true) {
			const outcome = await reembedMissingMemoriesBatch(accessor, embeddingFn, embeddingCfg, normalizedBatchSize);

			if (outcome.selected === 0) break;

			attempted += outcome.selected;
			written += outcome.written;
			failed += outcome.failed;
			batches++;

			if (!runToCompletion) break;
			if (outcome.selected < normalizedBatchSize) break;
			if (outcome.written === 0) break;
		}

		if (attempted === 0) {
			return {
				action,
				success: true,
				affected: 0,
				message: "no unembedded memories found",
			};
		}

		if (written === 0) {
			return {
				action,
				success: false,
				affected: 0,
				message: `embedding provider returned no vectors for ${attempted} memories`,
			};
		}

		const remaining = getEmbeddingGapStats(accessor).unembedded;
		const scope = runToCompletion ? `across ${batches} batch(es)` : "in one batch";
		const msg =
			failed > 0
				? `re-embedded ${written} of ${attempted} memories ${scope} (${failed} failed, ${remaining} still missing)`
				: `re-embedded ${written} of ${attempted} memories ${scope} (${remaining} still missing)`;

		accessor.withWriteTx((db) => {
			writeRepairAudit(db, action, ctx, written, msg);
		});

		limiter.record(action);
		logger.info("pipeline", "repair: re-embedded missing memories", {
			affected: written,
			attempted,
			failed,
			remaining,
			batches,
			runToCompletion,
			actor: ctx.actor,
			reason: ctx.reason,
		});

		return {
			action,
			success: true,
			affected: written,
			message: msg,
		};
	} finally {
		reembedInProgress = false;
	}
}

// ---------------------------------------------------------------------------
// Clean orphaned embeddings
// ---------------------------------------------------------------------------

/**
 * Remove embeddings whose source memory is deleted or missing, unless the
 * vector is still covering an active memory with the same content hash.
 * Syncs vec_embeddings to match.
 */
export function cleanOrphanedEmbeddings(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
): RepairResult {
	const action = "cleanOrphanedEmbeddings";
	const gate = checkRepairGate(cfg, ctx, limiter, action, cfg.repair.requeueCooldownMs, cfg.repair.requeueHourlyBudget);

	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			message: gate.reason ?? "denied by policy gate",
		};
	}

	const affected = accessor.withWriteTx((db) => {
		const orphans = db
			.prepare(
				`SELECT e.id FROM embeddings e
				 LEFT JOIN memories m ON e.source_type = 'memory' AND e.source_id = m.id
				 LEFT JOIN memories m2
				   ON e.source_type = 'memory'
				  AND e.content_hash = m2.content_hash
				  AND m2.is_deleted = 0
				 WHERE e.source_type = 'memory'
				   AND (m.id IS NULL OR m.is_deleted = 1)
				   AND m2.id IS NULL`,
			)
			.all() as Array<{ id: string }>;

		if (orphans.length === 0) return 0;

		const ids = orphans.map((r) => r.id);
		syncVecDeleteByEmbeddingIds(db, ids);

		const placeholders = ids.map(() => "?").join(", ");
		const result = db.prepare(`DELETE FROM embeddings WHERE id IN (${placeholders})`).run(...ids);

		const count = countChanges(result);
		const msg = `cleaned ${count} orphaned embedding(s)`;
		writeRepairAudit(db, action, ctx, count, msg);
		return count;
	});

	limiter.record(action);
	logger.info("pipeline", "repair: cleaned orphaned embeddings", {
		affected,
		actor: ctx.actor,
		reason: ctx.reason,
	});

	return {
		action,
		success: true,
		affected,
		message: `cleaned ${affected} orphaned embedding(s)`,
	};
}

// ---------------------------------------------------------------------------
// Resync vec index
// ---------------------------------------------------------------------------

interface VecResyncStats {
	readonly vecAvailable: boolean;
	readonly inserted: number;
	readonly deleted: number;
	readonly skipped: number;
}

function blobToFloat32Vector(raw: unknown): Float32Array | null {
	if (raw instanceof Float32Array) return raw;
	if (raw instanceof ArrayBuffer) {
		if (raw.byteLength % 4 !== 0) return null;
		return new Float32Array(raw.slice(0));
	}
	if (ArrayBuffer.isView(raw)) {
		const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
		if (buffer.byteLength % 4 !== 0) return null;
		return new Float32Array(buffer);
	}
	return null;
}

/**
 * Reconcile vec_embeddings with embeddings by deleting orphan vec rows
 * and inserting rows missing from the vec index.
 */
export function resyncVectorIndex(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
): RepairResult {
	const action = "resyncVectorIndex";
	const gate = checkRepairGate(cfg, ctx, limiter, action, cfg.repair.reembedCooldownMs, cfg.repair.reembedHourlyBudget);

	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			message: gate.reason ?? "denied by policy gate",
		};
	}

	const stats: VecResyncStats = accessor.withWriteTx((db): VecResyncStats => {
		try {
			db.prepare("SELECT 1 FROM vec_embeddings LIMIT 1").get();
		} catch {
			return {
				vecAvailable: false,
				inserted: 0,
				deleted: 0,
				skipped: 0,
			};
		}

		const orphanRows = db
			.prepare(
				`SELECT v.id
				 FROM vec_embeddings v
				 LEFT JOIN embeddings e ON e.id = v.id
				 WHERE e.id IS NULL`,
			)
			.all() as Array<{ id: string }>;

		let deleted = 0;
		if (orphanRows.length > 0) {
			const remove = db.prepare("DELETE FROM vec_embeddings WHERE id = ?");
			for (const row of orphanRows) {
				const result = remove.run(row.id);
				if (countChanges(result) > 0) deleted++;
			}
		}

		const missingRows = db
			.prepare(
				`SELECT e.id, e.vector
				 FROM embeddings e
				 LEFT JOIN vec_embeddings v ON v.id = e.id
				 WHERE v.id IS NULL`,
			)
			.all() as Array<{ id: string; vector: unknown }>;

		let inserted = 0;
		let skipped = 0;
		const insert = db.prepare("INSERT OR REPLACE INTO vec_embeddings (id, embedding) VALUES (?, ?)");

		for (const row of missingRows) {
			const vector = blobToFloat32Vector(row.vector);
			if (!vector) {
				skipped++;
				continue;
			}
			const result = insert.run(row.id, vector);
			if (countChanges(result) > 0) inserted++;
		}

		const affected = inserted + deleted;
		const msg =
			skipped > 0
				? `resynced vec index (+${inserted}/-${deleted}, skipped ${skipped} malformed vector(s))`
				: `resynced vec index (+${inserted}/-${deleted})`;
		writeRepairAudit(db, action, ctx, affected, msg);

		return {
			vecAvailable: true,
			inserted,
			deleted,
			skipped,
		};
	});

	if (!stats.vecAvailable) {
		return {
			action,
			success: false,
			affected: 0,
			message: "vec_embeddings table not found; restart daemon to initialize vector index",
		};
	}

	limiter.record(action);
	const affected = stats.inserted + stats.deleted;
	const message =
		stats.skipped > 0
			? `resynced vec index (+${stats.inserted}/-${stats.deleted}, skipped ${stats.skipped} malformed vector(s))`
			: `resynced vec index (+${stats.inserted}/-${stats.deleted})`;

	logger.info("pipeline", "repair: resynced vec index", {
		affected,
		inserted: stats.inserted,
		deleted: stats.deleted,
		skipped: stats.skipped,
		actor: ctx.actor,
		reason: ctx.reason,
	});

	return {
		action,
		success: true,
		affected,
		message,
	};
}

// ---------------------------------------------------------------------------
// Deduplication stats (read-only)
// ---------------------------------------------------------------------------

export interface DedupStats {
	readonly exactClusters: number;
	readonly exactExcess: number;
	readonly totalActive: number;
}

export function getDedupStats(accessor: DbAccessor): DedupStats {
	return accessor.withReadDb((db) => {
		const row = db
			.prepare(
				`SELECT COUNT(*) AS clusters, COALESCE(SUM(excess), 0) AS excess_total
				 FROM (
					SELECT content_hash, COUNT(*) - 1 AS excess
					FROM memories
					WHERE is_deleted = 0 AND pinned = 0 AND manual_override = 0
					  AND content_hash IS NOT NULL
					GROUP BY content_hash
					HAVING COUNT(*) > 1
				 )`,
			)
			.get() as { clusters: number; excess_total: number } | undefined;

		const totalRow = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE is_deleted = 0").get() as { n: number };

		return {
			exactClusters: row?.clusters ?? 0,
			exactExcess: row?.excess_total ?? 0,
			totalActive: totalRow.n,
		};
	});
}

// ---------------------------------------------------------------------------
// Deduplication action
// ---------------------------------------------------------------------------

interface DedupCandidate {
	readonly id: string;
	readonly content: string;
	readonly content_hash: string;
	readonly tags: string | null;
	readonly importance: number;
	readonly access_count: number;
	readonly update_count: number;
	readonly updated_at: string;
	readonly pinned: number;
	readonly manual_override: number;
}

export interface DedupResult extends RepairResult {
	readonly clusters: number;
}

function scoreDedupCandidate(c: DedupCandidate): number {
	let s = c.importance * 3;
	s += Math.min(c.access_count, 50) / 50;
	s += Math.min(c.update_count, 20) / 20;
	// Recency tiebreaker — normalized to a small range
	const updatedMs = new Date(c.updated_at).getTime();
	s += updatedMs / 1e15; // tiny but deterministic
	if (c.pinned) s += 100;
	if (c.manual_override) s += 100;
	return s;
}

function mergeTags(existing: string | null, incoming: string | null): string | null {
	const a = existing
		? existing
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean)
		: [];
	const b = incoming
		? incoming
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean)
		: [];
	const merged = [...new Set([...a, ...b])];
	return merged.length > 0 ? merged.join(",") : null;
}

function processCluster(
	db: WriteDb,
	candidates: readonly DedupCandidate[],
	ctx: RepairContext,
): { keeperId: string; removed: number } | null {
	// Safety: skip if any member is protected
	if (candidates.some((c) => c.pinned || c.manual_override)) {
		return null;
	}

	if (candidates.length < 2) return null;

	// Score and pick keeper
	let bestIdx = 0;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < candidates.length; i++) {
		const score = scoreDedupCandidate(candidates[i]);
		if (score > bestScore) {
			bestScore = score;
			bestIdx = i;
		}
	}

	const keeper = candidates[bestIdx];
	const losers = candidates.filter((_, i) => i !== bestIdx);
	const now = new Date().toISOString();

	// Merge tags into keeper
	let mergedTags = keeper.tags;
	for (const loser of losers) {
		mergedTags = mergeTags(mergedTags, loser.tags);
	}

	if (mergedTags !== keeper.tags) {
		db.prepare("UPDATE memories SET tags = ?, updated_at = ? WHERE id = ?").run(mergedTags, now, keeper.id);
	}

	// Audit keeper
	insertHistoryEvent(db, {
		memoryId: keeper.id,
		event: "merged",
		oldContent: null,
		newContent: null,
		changedBy: ctx.actor,
		reason: `dedup: merged ${losers.length} duplicate(s)`,
		metadata: JSON.stringify({
			mergedFrom: losers.map((l) => l.id),
			mergedTags,
		}),
		createdAt: now,
		actorType: ctx.actorType,
		requestId: ctx.requestId,
	});

	// Soft-delete losers
	for (const loser of losers) {
		db.prepare("UPDATE memories SET is_deleted = 1, deleted_at = ?, updated_at = ? WHERE id = ?").run(
			now,
			now,
			loser.id,
		);

		insertHistoryEvent(db, {
			memoryId: loser.id,
			event: "deleted",
			oldContent: loser.content,
			newContent: null,
			changedBy: ctx.actor,
			reason: `dedup: duplicate of ${keeper.id}`,
			metadata: null,
			createdAt: now,
			actorType: ctx.actorType,
			requestId: ctx.requestId,
		});
	}

	return { keeperId: keeper.id, removed: losers.length };
}

export async function deduplicateMemories(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	options?: {
		batchSize?: number;
		semanticThreshold?: number;
		dryRun?: boolean;
		semanticEnabled?: boolean;
	},
): Promise<DedupResult> {
	const action = "deduplicateMemories";
	const gate = checkRepairGate(cfg, ctx, limiter, action, cfg.repair.dedupCooldownMs, cfg.repair.dedupHourlyBudget);

	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			clusters: 0,
			message: gate.reason ?? "denied by policy gate",
		};
	}

	const batchSize = options?.batchSize ?? cfg.repair.dedupBatchSize;
	const semanticThreshold = options?.semanticThreshold ?? cfg.repair.dedupSemanticThreshold;
	const dryRun = options?.dryRun ?? false;
	const semanticEnabled = options?.semanticEnabled ?? false;

	// Phase 1: Exact hash clusters
	const hashClusters = accessor.withReadDb((db) => {
		return db
			.prepare(
				`SELECT content_hash, COALESCE(scope, '__NULL__') AS scope_key, COUNT(*) AS cnt
				 FROM memories
				 WHERE is_deleted = 0 AND pinned = 0 AND manual_override = 0
				   AND content_hash IS NOT NULL
				 GROUP BY content_hash, scope_key
				 HAVING COUNT(*) > 1
				 ORDER BY cnt DESC
				 LIMIT ?`,
			)
			.all(batchSize) as Array<{ content_hash: string; scope_key: string; cnt: number }>;
	});

	if (dryRun) {
		const totalExcess = hashClusters.reduce((sum, c) => sum + c.cnt - 1, 0);
		let semanticClusterCount = 0;
		if (semanticEnabled) {
			const semanticClusters = await findSemanticDuplicates(accessor, semanticThreshold, batchSize);
			semanticClusterCount = semanticClusters.length;
		}
		limiter.record(action);
		const parts = [`${hashClusters.length} exact cluster(s), ${totalExcess} excess duplicate(s)`];
		if (semanticEnabled) {
			parts.push(`${semanticClusterCount} semantic cluster(s)`);
		}
		return {
			action,
			success: true,
			affected: 0,
			clusters: hashClusters.length + semanticClusterCount,
			message: `dry run: ${parts.join(", ")}`,
		};
	}

	let totalRemoved = 0;
	let totalClusters = 0;

	// Process exact hash clusters (scope-aware: only dedup within same scope)
	for (const cluster of hashClusters) {
		const removed = accessor.withWriteTx((db) => {
			const scopeFilter = cluster.scope_key === "__NULL__" ? "AND scope IS NULL" : "AND scope = ?";
			const scopeArgs = cluster.scope_key === "__NULL__" ? [] : [cluster.scope_key];
			const candidates = db
				.prepare(
					`SELECT id, content, content_hash, tags, importance,
							access_count, update_count, updated_at, pinned, manual_override
					 FROM memories
					 WHERE content_hash = ? AND is_deleted = 0
					   AND pinned = 0 AND manual_override = 0
					   ${scopeFilter}
					 ORDER BY importance DESC`,
				)
				.all(cluster.content_hash, ...scopeArgs) as DedupCandidate[];

			const result = processCluster(db, candidates, ctx);
			return result?.removed ?? 0;
		});

		if (removed > 0) {
			totalRemoved += removed;
			totalClusters++;
		}
	}

	// Phase 2: Semantic clusters (only if exact phase didn't fill batch)
	if (semanticEnabled && totalClusters < batchSize) {
		const semanticClusters = await findSemanticDuplicates(accessor, semanticThreshold, batchSize - totalClusters);

		for (const cluster of semanticClusters) {
			const removed = accessor.withWriteTx((db) => {
				const ids = cluster.map((c) => c.id);
				const placeholders = ids.map(() => "?").join(", ");
				const candidates = db
					.prepare(
						`SELECT id, content, content_hash, tags, importance,
								access_count, update_count, updated_at, pinned, manual_override
						 FROM memories
						 WHERE id IN (${placeholders}) AND is_deleted = 0`,
					)
					.all(...ids) as DedupCandidate[];

				const result = processCluster(db, candidates, ctx);
				return result?.removed ?? 0;
			});

			if (removed > 0) {
				totalRemoved += removed;
				totalClusters++;
			}
		}
	}

	limiter.record(action);
	const msg = `deduplicated ${totalRemoved} memory/memories across ${totalClusters} cluster(s)`;

	logger.info("pipeline", "repair: deduplication complete", {
		affected: totalRemoved,
		clusters: totalClusters,
		semanticEnabled,
		actor: ctx.actor,
		reason: ctx.reason,
	});

	return {
		action,
		success: true,
		affected: totalRemoved,
		clusters: totalClusters,
		message: msg,
	};
}

// ---------------------------------------------------------------------------
// Semantic duplicate finder
// ---------------------------------------------------------------------------

interface SemanticCandidate {
	readonly id: string;
	readonly embeddingId: string;
}

async function findSemanticDuplicates(
	accessor: DbAccessor,
	threshold: number,
	maxClusters: number,
): Promise<Array<Array<{ id: string }>>> {
	const clusters: Array<Array<{ id: string }>> = [];
	const seen = new Set<string>();

	const candidates = accessor.withReadDb((db) => {
		return db
			.prepare(
				`SELECT m.id, e.id AS embedding_id
				 FROM memories m
				 JOIN embeddings e ON e.source_type = 'memory' AND e.source_id = m.id
				 WHERE m.is_deleted = 0 AND m.pinned = 0 AND m.manual_override = 0
				 ORDER BY m.created_at ASC
				 LIMIT 500`,
			)
			.all() as Array<{ id: string; embedding_id: string }>;
	});

	for (const candidate of candidates) {
		if (seen.has(candidate.id)) continue;
		if (clusters.length >= maxClusters) break;

		const neighbors = accessor.withReadDb((db) => {
			// Get the vector for this candidate's embedding
			const vecRow = db.prepare("SELECT embedding FROM vec_embeddings WHERE id = ?").get(candidate.embedding_id) as
				| { embedding: ArrayBuffer }
				| undefined;

			if (!vecRow) return [];

			const queryVec = new Float32Array(vecRow.embedding);
			// KNN search for nearby vectors
			const rows = db
				.prepare(
					`SELECT e.source_id, v.distance
					 FROM vec_embeddings v
					 JOIN embeddings e ON v.id = e.id
					 JOIN memories m ON e.source_id = m.id
					 WHERE v.embedding MATCH ? AND k = 6
					   AND m.is_deleted = 0 AND m.pinned = 0 AND m.manual_override = 0
					 ORDER BY v.distance`,
				)
				.all(queryVec) as Array<{ source_id: string; distance: number }>;

			// Convert distance to cosine similarity and filter
			return rows
				.filter((r) => r.source_id !== candidate.id)
				.filter((r) => {
					const similarity = 1 - r.distance;
					return similarity >= threshold;
				})
				.map((r) => ({ id: r.source_id }));
		});

		if (neighbors.length > 0) {
			const cluster = [{ id: candidate.id }, ...neighbors];
			for (const member of cluster) {
				seen.add(member.id);
			}
			clusters.push(cluster);
		}
	}

	return clusters;
}

// ---------------------------------------------------------------------------
// Reclassify extracted entities via LLM
// ---------------------------------------------------------------------------

const VALID_ENTITY_TYPES = new Set(["person", "project", "system", "tool", "concept", "skill", "task"]);

const DEFAULT_RECLASSIFY_BATCH = 20;
const MIN_RECLASSIFY_BATCH = 5;
const MAX_RECLASSIFY_BATCH = 30;

interface ExtractedEntity {
	readonly id: string;
	readonly name: string;
	readonly canonical_name: string | null;
}

interface ReclassifyEntry {
	readonly i: number;
	readonly type: string;
}

function tryParseJsonArray(raw: string): unknown {
	// Strip markdown fences if present
	const stripped = raw
		.replace(/^```(?:json)?\s*/m, "")
		.replace(/```\s*$/m, "")
		.trim();
	try {
		return JSON.parse(stripped);
	} catch {
		return null;
	}
}

/**
 * Reclassify entities whose entity_type is 'extracted' by asking an
 * LLM to infer the actual type from the entity name.
 */
export async function reclassifyEntities(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	provider: LlmProvider | null,
	options?: { batchSize?: number; dryRun?: boolean },
): Promise<RepairResult> {
	const action = "reclassifyEntities";
	const gate = checkRepairGate(cfg, ctx, limiter, action, 300000, 5);

	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			message: gate.reason ?? "denied by policy gate",
		};
	}

	const batchSize =
		typeof options?.batchSize === "number" && options.batchSize > 0
			? Math.max(MIN_RECLASSIFY_BATCH, Math.min(Math.floor(options.batchSize), MAX_RECLASSIFY_BATCH))
			: DEFAULT_RECLASSIFY_BATCH;

	const dryRun = options?.dryRun ?? false;

	const entities = accessor.withReadDb((db) => {
		return db
			.prepare(
				`SELECT id, name, canonical_name
				 FROM entities
				 WHERE entity_type = 'extracted'
				 LIMIT ?`,
			)
			.all(batchSize) as ExtractedEntity[];
	});

	if (entities.length === 0) {
		limiter.record(action);
		return {
			action,
			success: true,
			affected: 0,
			message: "no entities with type 'extracted' found",
		};
	}

	if (!provider) {
		return {
			action,
			success: false,
			affected: 0,
			message: "no LLM provider available",
		};
	}

	const entityList = entities.map((e, idx) => `${idx + 1}. ${e.canonical_name ?? e.name}`).join("\n");

	const prompt = `Classify each entity into one of these types: person, project, system, tool, concept, skill, task

Entities:
${entityList}

Respond with ONLY a JSON array, no other text:
[{"i": 1, "type": "person"}, {"i": 2, "type": "project"}, ...]
/no_think`;

	let responseText: string;
	try {
		responseText = await provider.generate(prompt, { timeoutMs: 30000 });
	} catch (err: unknown) {
		const errMsg = err instanceof Error ? err.message : String(err);
		logger.warn("pipeline", "repair: reclassify LLM call failed", {
			error: errMsg,
			actor: ctx.actor,
		});
		return {
			action,
			success: false,
			affected: 0,
			message: `LLM call failed: ${errMsg}`,
		};
	}

	const parsed = tryParseJsonArray(responseText);
	if (!Array.isArray(parsed)) {
		logger.warn("pipeline", "repair: reclassify LLM response not parseable", {
			responsePreview: responseText.slice(0, 200),
			actor: ctx.actor,
		});
		return {
			action,
			success: false,
			affected: 0,
			message: "LLM response was not a valid JSON array",
		};
	}

	// Build a map of 1-based index -> validated type
	const classifications = new Map<number, string>();
	for (const entry of parsed) {
		if (typeof entry === "object" && entry !== null && "i" in entry && "type" in entry) {
			const rec = entry as Record<string, unknown>;
			const idx = typeof rec.i === "number" ? rec.i : -1;
			const entityType = typeof rec.type === "string" ? rec.type.toLowerCase().trim() : "";
			if (idx >= 1 && idx <= entities.length && VALID_ENTITY_TYPES.has(entityType)) {
				classifications.set(idx, entityType);
			}
		}
	}

	if (dryRun) {
		limiter.record(action);
		const preview = Array.from(classifications.entries())
			.slice(0, 10)
			.map(([idx, type]) => `${entities[idx - 1].name} -> ${type}`)
			.join(", ");
		return {
			action,
			success: true,
			affected: 0,
			message: `dry run: ${classifications.size} of ${entities.length} would be reclassified (${preview})`,
		};
	}

	const affected = accessor.withWriteTx((db) => {
		const now = new Date().toISOString();
		let count = 0;

		for (const [idx, entityType] of classifications) {
			const entity = entities[idx - 1];
			const result = db
				.prepare(
					`UPDATE entities SET entity_type = ?, updated_at = ?
					 WHERE id = ? AND entity_type = 'extracted'`,
				)
				.run(entityType, now, entity.id);

			if (countChanges(result) > 0) {
				count++;
			}
		}

		const msg = `reclassified ${count} entity/entities from 'extracted'`;
		writeRepairAudit(db, action, ctx, count, msg);
		return count;
	});

	limiter.record(action);
	logger.info("pipeline", "repair: reclassified extracted entities", {
		affected,
		total: entities.length,
		classified: classifications.size,
		actor: ctx.actor,
		reason: ctx.reason,
	});

	return {
		action,
		success: true,
		affected,
		message: `reclassified ${affected} entity/entities from 'extracted' (${entities.length} queried, ${classifications.size} valid classifications)`,
	};
}

// ---------------------------------------------------------------------------
// pruneChunkGroupEntities
// ---------------------------------------------------------------------------

/**
 * Delete chunk_group entities — document-chunk indexing artifacts with no
 * semantic role in the knowledge graph. They have 0 mentions, no aspects,
 * no attributes, and no dependencies. FK cascades clean entity_aspects and
 * entity_dependencies automatically.
 */
export function pruneChunkGroupEntities(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	options?: { batchSize?: number; dryRun?: boolean },
): RepairResult {
	const action = "pruneChunkGroupEntities";
	const gate = checkRepairGate(cfg, ctx, limiter, action, 60_000, 5);
	if (!gate.allowed) {
		return { action, success: false, affected: 0, message: gate.reason ?? "denied" };
	}

	const batchSize = options?.batchSize ?? 500;

	const total = accessor.withReadDb(
		(db) =>
			(db.prepare("SELECT COUNT(*) as n FROM entities WHERE entity_type = 'chunk_group'").get() as { n: number }).n,
	);

	if (options?.dryRun) {
		return {
			action,
			success: true,
			affected: total,
			message: `dry-run: would delete ${total} chunk_group entities`,
		};
	}

	const affected = accessor.withWriteTx((db) => {
		const ids = db.prepare("SELECT id FROM entities WHERE entity_type = 'chunk_group' LIMIT ?").all(batchSize) as {
			id: string;
		}[];
		if (ids.length === 0) return 0;
		const placeholders = ids.map(() => "?").join(",");
		db.prepare(`DELETE FROM entities WHERE id IN (${placeholders})`).run(...ids.map((r) => r.id));
		writeRepairAudit(db, action, ctx, ids.length, `deleted ${ids.length} chunk_group entities`);
		return ids.length;
	});

	limiter.record(action);
	logger.info("pipeline", "repair: pruned chunk_group entities", { affected, actor: ctx.actor });
	return { action, success: true, affected, message: `deleted ${affected} chunk_group entities` };
}

// ---------------------------------------------------------------------------
// pruneSingletonExtractedEntities
// ---------------------------------------------------------------------------

/**
 * Delete extracted entities with mention_count <= maxMentions that have no
 * entity_aspects or entity_attributes — transient extractions that never
 * became meaningful knowledge. Cleans memory_entity_mentions and relations
 * manually (no FK cascade on those tables).
 */
export function pruneSingletonExtractedEntities(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	options?: { batchSize?: number; dryRun?: boolean; maxMentions?: number },
): RepairResult {
	const action = "pruneSingletonExtractedEntities";
	const gate = checkRepairGate(cfg, ctx, limiter, action, 60_000, 10);
	if (!gate.allowed) {
		return { action, success: false, affected: 0, message: gate.reason ?? "denied" };
	}

	const batchSize = options?.batchSize ?? 200;
	const maxMentions = options?.maxMentions ?? 1;

	const candidates = accessor.withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT e.id FROM entities e
				 WHERE e.entity_type = 'extracted'
				   AND e.mentions <= ?
				   AND NOT EXISTS (SELECT 1 FROM entity_aspects WHERE entity_id = e.id LIMIT 1)
				   AND NOT EXISTS (
				     -- Entity has no attributes connected via aspects (non-null aspect_id path)
				     SELECT 1 FROM entity_attributes ea
				     JOIN entity_aspects asp ON asp.id = ea.aspect_id
				     WHERE asp.entity_id = e.id LIMIT 1
				   )
				   AND NOT EXISTS (
				     -- Entity has no stub attributes (aspect_id IS NULL) written by structuralBackfill
				     SELECT 1 FROM entity_attributes ea
				     WHERE ea.aspect_id IS NULL
				       AND ea.memory_id IN (
				         SELECT memory_id FROM memory_entity_mentions WHERE entity_id = e.id
				       )
				     LIMIT 1
				   )
				 LIMIT ?`,
				)
				.all(maxMentions, batchSize) as { id: string }[],
	);

	if (options?.dryRun) {
		return {
			action,
			success: true,
			affected: candidates.length,
			message: `dry-run: would delete ${candidates.length} singleton extracted entities`,
		};
	}

	if (candidates.length === 0) {
		return { action, success: true, affected: 0, message: "no singleton extracted entities found" };
	}

	const affected = accessor.withWriteTx((db) => {
		const ids = candidates.map((r) => r.id);
		const placeholders = ids.map(() => "?").join(",");
		// Clean mention links (no FK cascade)
		db.prepare(`DELETE FROM memory_entity_mentions WHERE entity_id IN (${placeholders})`).run(...ids);
		// Clean relations (no FK cascade)
		db.prepare(
			`DELETE FROM relations WHERE source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders})`,
		).run(...ids, ...ids);
		// Delete entities — cascades entity_aspects and entity_dependencies
		db.prepare(`DELETE FROM entities WHERE id IN (${placeholders})`).run(...ids);
		writeRepairAudit(db, action, ctx, ids.length, `deleted ${ids.length} singleton extracted entities`);
		return ids.length;
	});

	limiter.record(action);
	logger.info("pipeline", "repair: pruned singleton extracted entities", {
		affected,
		actor: ctx.actor,
	});
	return {
		action,
		success: true,
		affected,
		message: `deleted ${affected} singleton extracted entities`,
	};
}

// ---------------------------------------------------------------------------
// structuralBackfill
// ---------------------------------------------------------------------------

/**
 * For memories that have entity links but no entity_attributes yet, create
 * stub attribute rows and enqueue structural_classify jobs so the
 * classification worker can annotate the clean entity set.
 */
export function structuralBackfill(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	options?: { batchSize?: number; dryRun?: boolean },
): RepairResult {
	const action = "structuralBackfill";
	const gate = checkRepairGate(cfg, ctx, limiter, action, 60_000, 20);
	if (!gate.allowed) {
		return { action, success: false, affected: 0, message: gate.reason ?? "denied" };
	}

	const batchSize = options?.batchSize ?? 100;

	const rows = accessor.withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT m.id as memory_id, m.content,
				        e.id as entity_id, e.entity_type, e.canonical_name, e.agent_id
				 FROM memories m
				 JOIN memory_entity_mentions mem ON mem.memory_id = m.id
				 JOIN entities e ON e.id = mem.entity_id
				 WHERE m.is_deleted = 0
				   AND e.entity_type != 'chunk_group'
				   AND NOT EXISTS (SELECT 1 FROM entity_attributes WHERE memory_id = m.id LIMIT 1)
				 GROUP BY m.id
				 LIMIT ?`,
				)
				.all(batchSize) as Array<{
				memory_id: string;
				content: string;
				entity_id: string;
				entity_type: string;
				canonical_name: string;
				agent_id: string;
			}>,
	);

	if (rows.length === 0 || options?.dryRun) {
		return {
			action,
			success: true,
			affected: rows.length,
			message: options?.dryRun
				? `dry-run: would process ${rows.length} unassigned memories`
				: "no unassigned memories with entity links found",
		};
	}

	let attributesCreated = 0;
	let classifyEnqueued = 0;

	accessor.withWriteTx((db) => {
		const now = new Date().toISOString();
		for (const row of rows) {
			const attrId = crypto.randomUUID();
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
				  confidence, importance, status, created_at, updated_at)
				 VALUES (?, NULL, ?, ?, 'attribute', ?, ?, 0.5, 0.5, 'active', ?, ?)`,
			).run(attrId, row.agent_id, row.memory_id, row.content, row.content, now, now);
			attributesCreated++;

			const payload = JSON.stringify({
				memory_id: row.memory_id,
				entity_id: row.entity_id,
				entity_name: row.canonical_name,
				entity_type: row.entity_type,
				fact_content: row.content,
				attribute_id: attrId,
			});
			const jobId = crypto.randomUUID();
			db.prepare(
				`INSERT INTO memory_jobs
				 (id, memory_id, job_type, status, payload, attempts, max_attempts, created_at, updated_at)
				 VALUES (?, ?, 'structural_classify', 'pending', ?, 0, 3, ?, ?)`,
			).run(jobId, row.memory_id, payload, now, now);
			classifyEnqueued++;
		}
		writeRepairAudit(
			db,
			action,
			ctx,
			attributesCreated,
			`created ${attributesCreated} stubs, enqueued ${classifyEnqueued} classify jobs`,
		);
	});

	limiter.record(action);
	logger.info("pipeline", "repair: structural backfill", {
		attributesCreated,
		classifyEnqueued,
		actor: ctx.actor,
	});
	return {
		action,
		success: true,
		affected: attributesCreated,
		message: `created ${attributesCreated} stubs, enqueued ${classifyEnqueued} classify jobs`,
	};
}

// ---------------------------------------------------------------------------
// backfillSkippedSessions
// ---------------------------------------------------------------------------

/**
 * Find summary_jobs that completed without producing a session summary
 * (skipped by the significance gate) and re-enqueue them for extraction.
 */
export function backfillSkippedSessions(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	options?: { limit?: number; dryRun?: boolean },
): RepairResult {
	const action = "backfillSkippedSessions";
	const gate = checkRepairGate(cfg, ctx, limiter, action, 60_000, 20);
	if (!gate.allowed) {
		return { action, success: false, affected: 0, message: gate.reason ?? "denied" };
	}

	const limit = options?.limit ?? 50;

	const tableExists = accessor.withReadDb((db) => {
		const jobs = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'summary_jobs'").get();
		const summaries = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'")
			.get();
		return jobs && summaries;
	});
	if (!tableExists) {
		return { action, success: true, affected: 0, message: "required tables not found" };
	}

	const skipped = accessor.withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT sj.id FROM summary_jobs sj
				 LEFT JOIN session_summaries ss ON ss.session_key = sj.session_key
				 WHERE sj.status = 'completed'
				   AND ss.id IS NULL
				 LIMIT ?`,
				)
				.all(limit) as Array<{ id: string }>,
	);

	if (skipped.length === 0 || options?.dryRun) {
		return {
			action,
			success: true,
			affected: skipped.length,
			message: options?.dryRun
				? `dry-run: would re-enqueue ${skipped.length} skipped session(s)`
				: "no skipped sessions found",
		};
	}

	const count = accessor.withWriteTx((db) => {
		const placeholders = skipped.map(() => "?").join(", ");
		const ids = skipped.map((r) => r.id);
		const result = db
			.prepare(
				`UPDATE summary_jobs
				 SET status = 'pending', attempts = 0, error = NULL
				 WHERE id IN (${placeholders})`,
			)
			.run(...ids);
		const affected = countChanges(result);
		writeRepairAudit(db, action, ctx, affected, `re-enqueued ${affected} skipped session(s)`);
		return affected;
	});

	limiter.record(action);
	logger.info("pipeline", "repair: backfill skipped sessions", {
		affected: count,
		actor: ctx.actor,
		reason: ctx.reason,
	});

	return {
		action,
		success: true,
		affected: count,
		message: `re-enqueued ${count} skipped session(s) for extraction`,
	};
}

// ---------------------------------------------------------------------------
// Dead memory hygiene
// ---------------------------------------------------------------------------

export interface DeadMemory {
	readonly id: string;
	readonly content: string;
	readonly confidence: number;
	readonly last_accessed: string | null;
	readonly importance: number;
	readonly reason: "low_confidence" | "never_accessed" | "stale";
}

export const DEAD_MEMORY_DEFAULT_CONFIDENCE = 0.1;
export const DEAD_MEMORY_DEFAULT_ACCESS_DAYS = 90;

export interface DeadMemoryOpts {
	/** Max confidence to flag as dead. Default: 0.10. */
	readonly maxConfidence?: number;
	/** Days since last access (or creation if never accessed) to flag as stale. Default: 90. */
	readonly maxAccessDays?: number;
	/** Max rows to return. Default: 200. */
	readonly limit?: number;
}

/**
 * Find memories that are candidates for deletion:
 * - Low confidence (below threshold), OR
 * - Never accessed and old, OR
 * - Not accessed in maxAccessDays
 *
 * Never flags memories with importance > 0.8 regardless of other criteria.
 */
export function findDeadMemories(db: ReadDb, opts: DeadMemoryOpts = {}): DeadMemory[] {
	const maxConf = opts.maxConfidence ?? DEAD_MEMORY_DEFAULT_CONFIDENCE;
	const maxDays = opts.maxAccessDays ?? DEAD_MEMORY_DEFAULT_ACCESS_DAYS;
	const limit = opts.limit ?? 200;

	const rows = db
		.prepare(
			`SELECT id, content, confidence, last_accessed, importance
			 FROM memories
			 WHERE is_deleted = 0
			   AND importance <= 0.8
			   AND (
			     confidence < ?
			     OR (last_accessed IS NULL AND julianday('now') - julianday(created_at) > ?)
			     OR (last_accessed IS NOT NULL AND julianday('now') - julianday(last_accessed) > ?)
			   )
			 ORDER BY confidence ASC, last_accessed ASC NULLS FIRST
			 LIMIT ?`,
		)
		.all(maxConf, maxDays, maxDays, limit) as Array<{
		id: string;
		content: string;
		confidence: number;
		last_accessed: string | null;
		importance: number;
	}>;

	return rows.map((row) => {
		let reason: DeadMemory["reason"];
		if (row.confidence < maxConf) {
			reason = "low_confidence";
		} else if (row.last_accessed === null) {
			reason = "never_accessed";
		} else {
			reason = "stale";
		}
		return { ...row, reason };
	});
}

/**
 * Soft-delete a batch of memories by ID in a single transaction.
 * Returns the number actually deleted (skips already-deleted).
 */
export function forgetDeadMemories(accessor: DbAccessor, ids: readonly string[]): number {
	if (ids.length === 0) return 0;
	const now = new Date().toISOString();
	return accessor.withWriteTx((db) => {
		const stmt = db.prepare("UPDATE memories SET is_deleted = 1, deleted_at = ? WHERE id = ? AND is_deleted = 0");
		let total = 0;
		for (const id of ids) {
			total += countChanges(stmt.run(now, id));
		}
		writeRepairAudit(
			db,
			"forget-dead-memories",
			{
				actor: "api",
				reason: "dead-memory hygiene",
				actorType: "system",
				requestId: null,
			},
			total,
			`soft-deleted ${total} dead memories`,
		);
		return total;
	});
}
