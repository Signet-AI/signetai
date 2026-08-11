/**
 * Policy-gated repair actions for the memory pipeline.
 *
 * Each action checks the policy gate and rate limiter before running.
 * Operators bypass the autonomousEnabled check; agents do not.
 * All actions respect autonomousFrozen regardless of actor type.
 */

import {
	memoriesFtsNeedsTokenizerRepair,
	readMemoriesFtsIndexRowCount,
	readMemoriesFtsSql,
	recreateMemoriesFts,
} from "@signet/core";
import { normalizeAndHashContent } from "./content-normalization";
import type { IntegrityCheckStatus } from "./database-integrity";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { toFtsSchemaQueryDb } from "./db-accessor";
import {
	countChanges,
	readLiveVecDimensions,
	syncVecDeleteByEmbeddingIds,
	syncVecDeleteBySourceExceptHash,
	syncVecInsert,
	tableExists,
	vectorToBlob,
} from "./db-helpers";
import {
	type UnembeddedRow,
	countEmbeddingMigrationRows,
	countUnembeddedMemories,
	listEmbeddingMigrationRows,
	listEmbeddingMigrationSources,
	listUnembeddedMemories,
} from "./embedding-coverage";
import { type EmbeddingMigrationCoverage, stagingCoverage } from "./embedding-index-migration";
import { readEmbeddingIndexState } from "./embedding-index-state";
import { type EmbeddingRepairState, readEmbeddingRepairState } from "./embedding-repair-state";
import { classifyEntityQuality } from "./entity-quality";
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
	/** Present on dry-run previews; ids the action *would* touch (capped). */
	readonly preview?: readonly string[];
	/** Count of rows that matched the filter (capped for log size). */
	readonly totalMatching?: number;
	readonly details?: Readonly<Record<string, unknown>>;
}

/** Filters accepted by `requeueDeadJobs` / `cancelObsoleteJobs` / `pruneTerminalJobs`. */
export interface JobFilterOptions {
	readonly dryRun?: boolean;
	readonly ids?: readonly string[];
	readonly tables?: readonly ("memory" | "summary")[];
	readonly olderThanMs?: number;
	readonly errorPattern?: string;
	readonly retentionMs?: number;
	readonly maxBatch?: number;
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

async function withRepairWriteTx<T>(accessor: DbAccessor, fn: (db: WriteDb) => T): Promise<T> {
	if (accessor.withWriteTxAsync) {
		return accessor.withWriteTxAsync(fn);
	}
	return accessor.withWriteTx(fn);
}

// Hold an autonomous rebuild until the same mismatch is observed on a second
// check, so a transient spike from in-flight artifact writes cannot trigger a
// rebuild on every maintenance cycle (#1142).
let ftsMismatchPendingRebuild = false;
let ftsRebuildInFlight = false;

/** Reset the FTS rebuild confirmation state (for tests). */
export function resetFtsRebuildConfirmation(): void {
	ftsMismatchPendingRebuild = false;
	ftsRebuildInFlight = false;
}

// ---- Issue #901 shared constants ----
/** Capped number of ids returned in dry-run previews. */
const PREVIEW_CAP = 100;
/** Hard cap on rows touched by a single apply/cancel/prune call. */
const MAX_BATCH_HARD_CAP = 1000;
const RETIRED_SUMMARY_REPAIR_MESSAGE =
	"summary worker retired; session transcripts are completed at session end and delivered directly to Dreaming";

function rejectRetiredSummaryRepair(
	action: string,
	options: { readonly tables?: readonly ("memory" | "summary")[] },
): RepairResult | null {
	if (!options.tables?.includes("summary")) return null;
	return { action, success: false, affected: 0, message: RETIRED_SUMMARY_REPAIR_MESSAGE };
}

/**
 * Reset dead jobs to pending so the worker will retry them.
 *
 * Issue #901 — accepts an `options` parameter for selective requeue:
 * `dryRun` returns a preview without mutating data; `ids` targets a
 * specific set; `olderThanMs` and `errorPattern` narrow further. All
 * options compose, default behavior is preserved when `options` is
 * omitted (existing callers stay correct).
 */

/**
 * Allocate the bounded requeue budget across selected queues so a default
 * both-queue repair makes progress in every non-empty queue (issue #1052).
 *
 * Each selected non-empty queue receives one reserved slot; the remaining
 * capacity is split, and capacity a queue cannot use (fewer matches than its
 * share) is refilled from the other queue. Single-table selections keep the
 * full cap.
 */
export function requeueDeadJobs(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	maxBatchOrOptions: number | JobFilterOptions = DEFAULT_REQUEUE_BATCH,
): RepairResult {
	const action = "requeueDeadJobs";
	const options: JobFilterOptions =
		typeof maxBatchOrOptions === "number" ? { maxBatch: maxBatchOrOptions } : maxBatchOrOptions;
	const maxBatch = options.maxBatch ?? DEFAULT_REQUEUE_BATCH;
	const dryRun = options.dryRun === true;
	const retired = rejectRetiredSummaryRepair(action, options);
	if (retired) return retired;

	const gate = checkRepairGate(cfg, ctx, limiter, action, cfg.repair.requeueCooldownMs, cfg.repair.requeueHourlyBudget);
	if (!gate.allowed) {
		return { action, success: false, affected: 0, message: gate.reason ?? "denied by policy gate" };
	}

	const result = accessor.withWriteTx((db) => {
		const wantsMemory = !options.tables || options.tables.includes("memory");
		const selected = wantsMemory
			? buildDeadRequeueSql(db, "memory_jobs", maxBatch, options)
			: { sql: "", params: [], ids: [], totalMatching: 0 };
		const ids = selected.ids;
		if (dryRun) {
			return {
				affected: 0,
				preview: ids.map((row) => row.id).slice(0, PREVIEW_CAP),
				totalMatching: selected.totalMatching,
			};
		}
		if (ids.length === 0)
			return { affected: 0, preview: [] as readonly string[], totalMatching: selected.totalMatching };
		const placeholders = ids.map(() => "?").join(", ");
		const now = new Date().toISOString();
		const changed = db
			.prepare(`UPDATE memory_jobs SET status = 'pending', attempts = 0, updated_at = ? WHERE id IN (${placeholders})`)
			.run(now, ...ids.map((row) => row.id));
		const affected = countChanges(changed);
		writeRepairAudit(db, action, ctx, affected, `requeued ${affected} dead memory job(s) to pending`);
		return { affected, preview: [] as readonly string[], totalMatching: selected.totalMatching };
	});

	if (!dryRun) limiter.record(action);
	logger.info("pipeline", "repair: requeued dead memory jobs", {
		affected: result.affected,
		dryRun,
		previewCount: result.preview.length,
		totalMatching: result.totalMatching,
		actor: ctx.actor,
		reason: ctx.reason,
	});
	return {
		action,
		success: true,
		affected: dryRun ? 0 : result.affected,
		message: dryRun
			? `dry-run: ${result.totalMatching} memory job(s) match requeue filter; preview shows ${result.preview.length}`
			: `requeued ${result.affected} dead memory job(s) to pending`,
		preview: dryRun ? result.preview : undefined,
		totalMatching: dryRun ? result.totalMatching : undefined,
	};
}

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
 * Check FTS row count and tokenizer definition, optionally rebuilding.
 * Uses a longer cooldown since FTS recreation is expensive.
 */
export async function checkFtsConsistency(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	repair = false,
): Promise<RepairResult> {
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

	const { memCount, ftsCount, ftsMissing, tokenizerDrift } = accessor.withReadDb((db) => {
		const memRow = db.prepare("SELECT COUNT(*) as n FROM memories").get() as { n: number };

		// Guard against missing FTS index state (can happen on upgrades before
		// self-heal). Count the physical docsize rows, not the external-content
		// table, whose COUNT(*) resolves through memories and includes tombstones.
		let ftsN: number | null = null;
		try {
			ftsN = readMemoriesFtsIndexRowCount(toFtsSchemaQueryDb(db));
		} catch {
			// Missing FTS shadow state.
		}
		const missing = ftsN === null;
		const ftsSql = missing ? null : readMemoriesFtsSql(toFtsSchemaQueryDb(db));
		return {
			memCount: memRow.n,
			ftsCount: ftsN ?? 0,
			ftsMissing: missing,
			tokenizerDrift: memoriesFtsNeedsTokenizerRepair(ftsSql),
		};
	});

	// If FTS table is missing entirely, report it (startup self-heal
	// via ensureFtsTable should have caught this, but handle gracefully)
	if (ftsMissing) {
		limiter.record(action);
		const msg = repair
			? "FTS index state missing — restart daemon to trigger self-healing rebuild"
			: "FTS index state missing — run with repair=true or restart daemon";
		logger.warn("pipeline", "repair: FTS index state missing", {
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

	if (tokenizerDrift) {
		if (repair) {
			if (ftsRebuildInFlight) {
				limiter.record(action);
				return {
					action,
					success: true,
					affected: 0,
					message: "FTS rebuild already in progress",
				};
			}
			ftsRebuildInFlight = true;
			await withRepairWriteTx(accessor, (db) => {
				recreateMemoriesFts(db);
				writeRepairAudit(db, action, ctx, 1, "FTS recreated with unicode61 tokenizer");
			}).finally(() => {
				ftsRebuildInFlight = false;
			});
			// The recreate is itself a full rebuild; any prior mismatch is moot.
			ftsMismatchPendingRebuild = false;
		}

		limiter.record(action);
		const message = repair
			? "FTS tokenizer drift detected — recreated with unicode61 tokenizer"
			: "FTS tokenizer drift detected — run with repair=true to recreate";
		logger.warn("pipeline", "repair: FTS tokenizer drift", {
			memCount,
			ftsCount,
			repaired: repair,
			actor: ctx.actor,
		});
		return {
			action,
			success: true,
			affected: 1,
			message,
		};
	}

	// The physical FTS index must contain one document for every canonical
	// memory row, including tombstones. Async writer admission keeps a repair
	// out of the request call stack while preserving the existing transaction.
	const mismatch = memCount !== ftsCount;

	let rebuilt = false;
	if (mismatch && repair) {
		// Operator-triggered repairs are explicit intent and rebuild at once;
		// autonomous repair waits for a second observation so a transient
		// mismatch cannot trigger a synchronous rebuild every cycle (#1142).
		const confirmed = ctx.actorType === "operator" || ftsMismatchPendingRebuild;
		if (confirmed) {
			if (ftsRebuildInFlight) {
				limiter.record(action);
				return {
					action,
					success: true,
					affected: 0,
					message: "FTS rebuild already in progress",
				};
			}
			ftsRebuildInFlight = true;
			await withRepairWriteTx(accessor, (db) => {
				db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')").run();
				writeRepairAudit(db, action, ctx, 1, `FTS rebuilt: ${memCount} canonical vs ${ftsCount} indexed rows`);
			}).finally(() => {
				ftsRebuildInFlight = false;
			});
			ftsMismatchPendingRebuild = false;
			rebuilt = true;
		} else {
			ftsMismatchPendingRebuild = true;
			logger.warn("pipeline", "repair: FTS mismatch observed, deferring rebuild until it persists", {
				memCount,
				ftsCount,
				actor: ctx.actor,
			});
		}
	} else if (!mismatch) {
		ftsMismatchPendingRebuild = false;
	}

	limiter.record(action);

	const message = mismatch
		? rebuilt
			? `FTS mismatch: ${memCount} canonical vs ${ftsCount} indexed rows — rebuilt`
			: `FTS mismatch: ${memCount} canonical vs ${ftsCount} indexed rows (rebuild deferred until mismatch persists)`
		: `FTS consistent: ${memCount} canonical, ${ftsCount} indexed rows`;

	logger.info("pipeline", "repair: FTS consistency check", {
		memCount,
		ftsCount,
		mismatch,
		repaired: rebuilt,
		actor: ctx.actor,
	});

	return {
		action,
		success: true,
		affected: rebuilt ? 1 : 0,
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
	readonly embedded: number;
	readonly complete: boolean;
	readonly coverage: string;
	readonly staging: EmbeddingMigrationCoverage | null;
	/** Durable autonomous-tracker admission and completion state. */
	readonly repair: EmbeddingRepairState | null;
}

export function getEmbeddingGapStats(accessor: DbAccessor): EmbeddingGapStats {
	const repair = readEmbeddingRepairState(accessor);
	return accessor.withReadDb((db) => {
		const totalRow = db.prepare("SELECT COUNT(*) as n FROM memories WHERE is_deleted = 0").get() as { n: number };
		const total = totalRow.n;
		const unembedded = countUnembeddedMemories(db);
		const embedded = total - unembedded;
		const state = tableExists(db, "embedding_index_state") ? readEmbeddingIndexState(db) : null;
		const staging =
			state?.staging && tableExists(db, "embeddings_staging")
				? stagingCoverage(db, state.staging.dimensions, state.staging.fingerprint)
				: null;
		const complete = unembedded === 0 && (staging === null || staging.ready);
		// Floor to one decimal so a near-complete store never rounds up to
		// 100% while embeddings are still missing (issue #906). When the
		// store is complete the ratio is exactly 100%.
		const pct = total > 0 ? (embedded / total) * 100 : 100;
		const displayed = complete ? pct : Math.floor(pct * 10) / 10;

		return {
			unembedded,
			total,
			embedded,
			complete,
			coverage: `${displayed.toFixed(1)}%`,
			staging,
			repair,
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
			"SELECT id FROM memories WHERE content_hash = ? AND is_deleted = 0 AND id <> ? LIMIT 1",
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

export async function reembedModelMigration(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	embeddingFn: (content: string, cfg: EmbeddingConfig) => Promise<number[] | null>,
	embeddingCfg: EmbeddingConfig,
	agentId: string,
	batchSize = DEFAULT_REEMBED_BATCH,
	dryRun = false,
	all = false,
	readVecDimensions: (db: ReadDb) => number | null = readLiveVecDimensions,
): Promise<RepairResult> {
	const action = "reembedModelMigration";
	const gate = checkRepairGate(cfg, ctx, limiter, action, 0, cfg.repair.reembedHourlyBudget);
	if (!gate.allowed) return { action, success: false, affected: 0, message: gate.reason ?? "denied by policy gate" };
	const size =
		Number.isFinite(batchSize) && batchSize > 0 ? Math.min(500, Math.floor(batchSize)) : DEFAULT_REEMBED_BATCH;
	const { rows, totalMatching, sources, liveVecDimensions } = accessor.withReadDb((db) => ({
		rows: listEmbeddingMigrationRows(db, embeddingCfg.model, embeddingCfg.dimensions, all, size, agentId),
		totalMatching: countEmbeddingMigrationRows(db, embeddingCfg.model, embeddingCfg.dimensions, all, agentId),
		sources: listEmbeddingMigrationSources(db, embeddingCfg.model, embeddingCfg.dimensions, all, agentId),
		liveVecDimensions: readVecDimensions(db),
	}));
	const vecDimensionMismatch = liveVecDimensions !== null && liveVecDimensions !== embeddingCfg.dimensions;
	const details = {
		selected: totalMatching,
		selectedThisBatch: rows.length,
		agentId,
		// Provider identity was not persisted by historical schemas. Report that
		// explicitly rather than implying a provider mismatch can be inferred.
		sources: sources.map((source) => ({ ...source, provider: "not-recorded" })),
		target: { provider: embeddingCfg.provider, model: embeddingCfg.model, dimensions: embeddingCfg.dimensions },
		estimatedBatches: Math.ceil(totalMatching / size),
		vecDimensions: liveVecDimensions,
		vectorIndexRebuildRequired: sources.some(
			(source) => source.dimensions !== null && source.dimensions !== embeddingCfg.dimensions,
		),
	};
	if (dryRun)
		return {
			action,
			success: true,
			affected: 0,
			message: `dry run: ${totalMatching} memories selected; ${rows.length} in the next batch`,
			totalMatching,
			details,
		};
	// Refuse a live run when the vec_embeddings virtual table is pinned to a
	// different dimension than the configured target. syncVecInsert would
	// otherwise throw a dimension mismatch that db-helpers silently swallows,
	// leaving embeddings updated but vec_embeddings serving stale vectors until
	// a daemon restart. The operator must restart the daemon (which rebuilds
	// the vec table at the new dimension) and then re-run the migration.
	if (vecDimensionMismatch) {
		return {
			action,
			success: false,
			affected: 0,
			message: `vector index is FLOAT[${liveVecDimensions}] but the configured target is FLOAT[${embeddingCfg.dimensions}]; restart the daemon to resize the vector index, then re-run the migration`,
			totalMatching,
			details,
		};
	}
	let written = 0;
	let failed = 0;
	for (const row of rows) {
		let vector: number[] | null;
		try {
			vector = await embeddingFn(row.content, embeddingCfg);
		} catch (error) {
			failed++;
			logger.warn("pipeline", "re-embed migration: embedding failed", {
				memoryId: row.id,
				error: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		if (!vector || vector.length !== embeddingCfg.dimensions) {
			failed++;
			continue;
		}
		try {
			const wrote = accessor.withWriteTx((db): boolean => {
				const current = db.prepare("SELECT content_hash FROM memories WHERE id = ? AND is_deleted = 0").get(row.id) as
					| { content_hash: string }
					| undefined;
				if (!current) return false;
				const id = crypto.randomUUID();
				db.prepare(
					`INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at) VALUES (?, ?, ?, ?, 'memory', ?, ?, datetime('now')) ON CONFLICT(content_hash) DO UPDATE SET vector=excluded.vector, dimensions=excluded.dimensions, source_id=excluded.source_id, chunk_text=excluded.chunk_text, created_at=excluded.created_at`,
				).run(id, current.content_hash, vectorToBlob(vector), vector.length, row.id, row.content);
				const embedding = db.prepare("SELECT id FROM embeddings WHERE content_hash = ?").get(current.content_hash) as
					| { id: string }
					| undefined;
				if (!embedding) return false;
				syncVecInsert(db, embedding.id, vector);
				db.prepare("UPDATE memories SET embedding_model = ? WHERE id = ?").run(embeddingCfg.model, row.id);
				return true;
			});
			if (wrote) written++;
		} catch (error) {
			failed++;
			logger.warn("pipeline", "re-embed migration: write failed", {
				memoryId: row.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const message = `re-embedded ${written} of ${rows.length} selected memories${
		failed > 0 ? ` (${failed} failed)` : ""
	}`;
	if (written > 0) {
		try {
			accessor.withWriteTx((db) => writeRepairAudit(db, action, ctx, written, message));
		} catch (error) {
			// The repair work is already committed per-row; a failed audit write
			// must not discard the partial-progress result the caller needs.
			logger.warn("pipeline", "re-embed migration: audit write failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		limiter.record(action);
	}
	return {
		action,
		success: failed === 0,
		affected: written,
		message,
		totalMatching,
		details: { ...details, failed },
	};
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
		if (!syncVecDeleteByEmbeddingIds(db, ids)) {
			throw new Error("failed to reconcile vec_embeddings before orphan cleanup");
		}

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
				     -- Entity has no stub attributes (aspect_id IS NULL)
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
// pruneGenericEntities
// ---------------------------------------------------------------------------

interface GenericEntityCandidate {
	readonly id: string;
	readonly name: string;
	readonly entity_type: string;
	reason?: string;
}

function deleteEntityGraphRows(db: WriteDb, ids: readonly string[]): void {
	if (ids.length === 0) return;
	const placeholders = ids.map(() => "?").join(",");
	const aspectIds = db
		.prepare(`SELECT id FROM entity_aspects WHERE entity_id IN (${placeholders})`)
		.all(...ids) as Array<{ id: string }>;
	if (aspectIds.length > 0) {
		const aspectPlaceholders = aspectIds.map(() => "?").join(",");
		db.prepare(`DELETE FROM entity_attributes WHERE aspect_id IN (${aspectPlaceholders})`).run(
			...aspectIds.map((row) => row.id),
		);
	}
	db.prepare(`DELETE FROM memory_entity_mentions WHERE entity_id IN (${placeholders})`).run(...ids);
	db.prepare(
		`DELETE FROM relations WHERE source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders})`,
	).run(...ids, ...ids);
	db.prepare(
		`DELETE FROM entity_dependencies WHERE source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders})`,
	).run(...ids, ...ids);
	db.prepare(`DELETE FROM entity_retrieval_stats WHERE entity_id IN (${placeholders})`).run(...ids);
	db.prepare(
		`DELETE FROM entity_cooccurrence WHERE source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders})`,
	).run(...ids, ...ids);
	db.prepare(`DELETE FROM entity_aspects WHERE entity_id IN (${placeholders})`).run(...ids);
	db.prepare(`DELETE FROM entities WHERE id IN (${placeholders})`).run(...ids);
}

/**
 * Delete concrete-ontology violations such as pronouns, metadata labels,
 * headings, discourse fragments, and non-concrete extraction types. Defaults
 * to dry-run at the route layer so operators can inspect candidates first.
 */
export function pruneGenericEntities(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	options?: { batchSize?: number; dryRun?: boolean; agentId?: string },
): RepairResult {
	const action = "pruneGenericEntities";
	const gate = checkRepairGate(cfg, ctx, limiter, action, 60_000, 10);
	if (!gate.allowed) {
		return { action, success: false, affected: 0, message: gate.reason ?? "denied" };
	}

	const batchSize = Math.max(1, Math.min(Math.floor(options?.batchSize ?? 100), 500));
	const agentId = options?.agentId ?? "default";
	const candidates = accessor.withReadDb((db) => {
		const candidates: GenericEntityCandidate[] = [];
		const pageSize = Math.max(batchSize * 10, 500);
		let offset = 0;
		const selectPage = db.prepare(
			`SELECT e.id, e.name, e.entity_type
			 FROM entities e
			 WHERE e.agent_id = ?
			   AND COALESCE(e.pinned, 0) = 0
			   AND e.entity_type NOT IN ('skill')
			   AND NOT EXISTS (SELECT 1 FROM skill_meta sm WHERE sm.entity_id = e.id)
			 ORDER BY e.updated_at DESC
			 LIMIT ? OFFSET ?`,
		);

		for (;;) {
			const rows = selectPage.all(agentId, pageSize, offset) as GenericEntityCandidate[];
			if (rows.length === 0) break;
			for (const row of rows) {
				const quality = classifyEntityQuality(row.name, row.entity_type);
				if (!quality.ok) {
					candidates.push({ ...row, reason: quality.reason });
					if (candidates.length >= batchSize) return candidates;
				}
			}
			offset += rows.length;
		}
		return candidates;
	});

	if (options?.dryRun ?? true) {
		const preview = candidates
			.slice(0, 10)
			.map((row) => `${row.name} (${row.reason ?? "invalid"})`)
			.join(", ");
		return {
			action,
			success: true,
			affected: candidates.length,
			message: `dry-run: would delete ${candidates.length} generic/non-concrete entities${preview ? `: ${preview}` : ""}`,
		};
	}

	if (candidates.length === 0) {
		return { action, success: true, affected: 0, message: "no generic/non-concrete entities found" };
	}

	const affected = accessor.withWriteTx((db) => {
		const ids = candidates.map((row) => row.id);
		deleteEntityGraphRows(db, ids);
		writeRepairAudit(
			db,
			action,
			ctx,
			ids.length,
			`deleted ${ids.length} generic/non-concrete entities for agent ${agentId}`,
		);
		return ids.length;
	});

	limiter.record(action);
	logger.info("pipeline", "repair: pruned generic/non-concrete entities", {
		affected,
		agentId,
		actor: ctx.actor,
	});
	return { action, success: true, affected, message: `deleted ${affected} generic/non-concrete entities` };
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
				actorType: "daemon",
				requestId: undefined,
			},
			total,
			`soft-deleted ${total} dead memories`,
		);
		return total;
	});
}

// ---------------------------------------------------------------------------
// SQLite integrity check
// ---------------------------------------------------------------------------

export interface IntegrityCheckResult {
	readonly ok: boolean;
	readonly messages: readonly string[];
	readonly quickCheck: IntegrityCheckStatus;
	readonly fullCheck: IntegrityCheckStatus;
}

function readIntegrityCheck(db: ReadDb, pragma: "quick_check" | "integrity_check"): IntegrityCheckStatus {
	const key = pragma === "quick_check" ? "quick_check" : "integrity_check";
	const rows = db.prepare(`PRAGMA ${pragma}`).all() as ReadonlyArray<Record<string, unknown>>;
	const messages = rows.map((row) => String(row[key] ?? ""));
	if (messages.length === 1 && messages[0] === "ok") return { ok: true, messages: [] };
	return { ok: false, messages };
}

/**
 * Run both SQLite integrity modes. quick_check is cheap and useful for
 * broad damage; integrity_check is the authoritative result for indexes.
 */
export function integrityCheck(accessor: DbAccessor): IntegrityCheckResult {
	return accessor.withReadDb((db) => {
		const quickCheck = readIntegrityCheck(db, "quick_check");
		const fullCheck = readIntegrityCheck(db, "integrity_check");
		return { ok: fullCheck.ok, messages: fullCheck.messages, quickCheck, fullCheck };
	});
}

// ---------------------------------------------------------------------------
// Rebuild derived search indexes
// ---------------------------------------------------------------------------

export interface RebuildIndexesResult {
	readonly integrity: { ok: boolean; messages: readonly string[] };
	readonly fts: { repaired: boolean; message: string };
	readonly embeddings: { reembedded: number; totalMissing: number };
	readonly summary: string;
}

/**
 * Run a coordinated repair of all derived search indexes in sequence:
 * 1. PRAGMA integrity_check — fail fast if DB is corrupt
 * 2. FTS consistency check + rebuild if needed
 * 3. Re-embed memories missing vector embeddings
 *
 * Intended for recovery after SQLite repair or schema migration.
 */
export async function rebuildDerivedIndexes(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	embeddingFn: (content: string, cfg: EmbeddingConfig) => Promise<number[] | null>,
	embeddingCfg: EmbeddingConfig,
): Promise<RebuildIndexesResult> {
	const integrity = integrityCheck(accessor);

	// Step 1: FTS rebuild
	const ftsResult = await checkFtsConsistency(accessor, cfg, ctx, limiter, true);

	// Step 2: Re-embed missing memories (batch of 200, not full sweep)
	const reembedResult = await reembedMissingMemoriesBatch(accessor, embeddingFn, embeddingCfg, 200);

	const parts: string[] = [];
	if (!integrity.ok) {
		parts.push(`integrity: ${integrity.messages.length} issue(s)`);
	} else {
		parts.push("integrity: ok");
	}
	if (ftsResult.affected > 0) {
		parts.push("FTS: repaired");
	} else {
		parts.push("FTS: consistent");
	}
	parts.push(`embeddings: re-embedded ${reembedResult.written} of ${reembedResult.selected} missing`);

	return {
		integrity,
		fts: { repaired: ftsResult.affected > 0, message: ftsResult.message },
		embeddings: { reembedded: reembedResult.written, totalMissing: reembedResult.selected - reembedResult.written },
		summary: parts.join(" · "),
	};
}

// ---------------------------------------------------------------------------
// Internal helpers shared by selective repair actions (issue #901)
// ---------------------------------------------------------------------------

interface DeadMatchRow {
	readonly id: string;
}

interface BuiltSql {
	readonly sql: string;
	readonly params: readonly unknown[];
	readonly ids: readonly DeadMatchRow[];
	readonly totalMatching: number;
}

/**
 * Build a parameterized SELECT that enumerates dead rows matching the
 * filter. The `placeholderIdColumn` arg identifies the column that
 * uniquely identifies the row inside the memory queue.
 */
function buildDeadRequeueWhere(
	db: ReadDb,
	table: "memory_jobs",
	options: JobFilterOptions,
): { where: string[]; params: unknown[] } | null {
	if (!tableExists(db, table)) {
		return null;
	}

	const where: string[] = ["status = 'dead'"];
	const params: unknown[] = [];
	if (table === "memory_jobs") {
		// The extraction worker is gone. Startup already promoted each legacy
		// extract source to Dreaming before terminalizing its job, so requeueing
		// it would create work with no consumer.
		where.push("job_type <> 'extract'");
	}

	if (options.ids && options.ids.length > 0) {
		const placeholders = options.ids.map(() => "?").join(", ");
		where.push(`id IN (${placeholders})`);
		params.push(...options.ids);
	}
	if (options.olderThanMs !== undefined && options.olderThanMs > 0) {
		const cutoff = new Date(Date.now() - options.olderThanMs).toISOString();
		where.push("created_at < ?");
		params.push(cutoff);
	}
	if (options.errorPattern !== undefined && options.errorPattern !== "") {
		where.push("error LIKE ?");
		params.push(`%${options.errorPattern}%`);
	}

	return { where, params };
}

function countDeadRequeueMatches(db: ReadDb, table: "memory_jobs", options: JobFilterOptions): number {
	const built = buildDeadRequeueWhere(db, table, options);
	if (!built) return 0;
	const countStmt = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE ${built.where.join(" AND ")}`);
	const row = countStmt.get(...built.params) as { cnt: number } | undefined;
	return row?.cnt ?? 0;
}

function buildDeadRequeueSql(db: ReadDb, table: "memory_jobs", limit: number, options: JobFilterOptions): BuiltSql {
	// The match count is a property of the filter, not the selection budget:
	// a zero budget must still report how many rows matched so dry-run totals
	// never silently drop a backlog (issue #1052).
	const totalMatching = countDeadRequeueMatches(db, table, options);
	if (limit <= 0) {
		return { sql: "", params: [], ids: [], totalMatching };
	}
	const built = buildDeadRequeueWhere(db, table, options);
	if (!built) {
		return { sql: "", params: [], ids: [], totalMatching };
	}
	const baseWhere = `WHERE ${built.where.join(" AND ")}`;
	const stmt = db.prepare(`SELECT id FROM ${table} ${baseWhere} ORDER BY created_at ASC LIMIT ?`);
	const ids = stmt.all(...built.params, limit) as unknown as DeadMatchRow[];
	return { sql: "", params: [...built.params, limit], ids, totalMatching };
}

interface CancelPruneMatchRow {
	readonly id: string;
	readonly payload: Record<string, unknown>;
}

interface CancelPruneBuilt {
	readonly rows: readonly CancelPruneMatchRow[];
	readonly totalMatching: number;
}

/**
 * Build a parameterized SELECT for `cancelObsoleteJobs` and
 * `pruneTerminalJobs`. Captures the full row as JSON so the action can
 * copy it to the audit/archive table inside the same write tx. Unlike
 * requeue, terminal cleanup deliberately includes retired `extract` rows.
 */
function buildCancelPruneSql(
	db: ReadDb,
	table: "memory_jobs",
	statusList: readonly string[],
	options: JobFilterOptions & { retentionMsByStatus?: Record<string, number> },
): CancelPruneBuilt {
	if (!tableExists(db, table)) {
		return { rows: [], totalMatching: 0 };
	}
	if (statusList.length === 0) return { rows: [], totalMatching: 0 };

	const placeholders = statusList.map(() => "?").join(", ");
	const where: string[] = [`status IN (${placeholders})`];
	const params: unknown[] = [...statusList];

	if (options.ids && options.ids.length > 0) {
		const ph = options.ids.map(() => "?").join(", ");
		where.push(`id IN (${ph})`);
		params.push(...options.ids);
	}
	if (options.olderThanMs !== undefined && options.olderThanMs > 0) {
		const cutoff = new Date(Date.now() - options.olderThanMs).toISOString();
		where.push("created_at < ?");
		params.push(cutoff);
	}
	if (options.errorPattern !== undefined && options.errorPattern !== "") {
		where.push("error LIKE ?");
		params.push(`%${options.errorPattern}%`);
	}

	const baseWhere = `WHERE ${where.join(" AND ")}`;

	const countStmt = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table} ${baseWhere}`);
	const totalMatching = (countStmt.get(...params) as { cnt: number } | undefined)?.cnt ?? 0;

	const limit = Math.min(options.maxBatch ?? MAX_BATCH_HARD_CAP, MAX_BATCH_HARD_CAP);
	const stmt = db.prepare(`SELECT * FROM ${table} ${baseWhere} ORDER BY created_at ASC LIMIT ?`);
	const rawRows = stmt.all(...params, limit) as Array<Record<string, unknown>>;
	const rows: CancelPruneMatchRow[] = rawRows.map((r) => ({
		id: String(r.id ?? ""),
		payload: r,
	}));
	return { rows, totalMatching };
}

/** `cancelled` is the soft-cancel status #901 introduces; total prune is hard delete. */

interface CancelResultMeta {
	readonly affected: number;
	readonly preview: readonly string[];
	readonly totalMatching: number;
}

/**
 * Cancel obsolete jobs by copying them to `job_cancellations` and flipping
 * their source `status` to `cancelled`. Never hard-deletes the source
 * row. Default selection: rows where `status IN ('dead','completed')`
 * and `created_at < now - olderThanMs` (default 30 days).
 */
export function cancelObsoleteJobs(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	options: JobFilterOptions = {},
): RepairResult {
	const action = "cancelObsoleteJobs";
	const retired = rejectRetiredSummaryRepair(action, options);
	if (retired) return retired;

	const dryRun = options.dryRun === true;

	const gate = checkRepairGate(cfg, ctx, limiter, action, cfg.repair.requeueCooldownMs, cfg.repair.requeueHourlyBudget);
	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			message: gate.reason ?? "denied by policy gate",
		};
	}

	const olderThanMs = options.olderThanMs ?? 30 * 24 * 60 * 60 * 1000;
	const wantsMemory = !options.tables || options.tables.includes("memory");
	const result = accessor.withWriteTx<CancelResultMeta>((db) => {
		if (!tableExists(db, "job_cancellations")) {
			throw new Error("job_cancellations table missing; run migrations");
		}

		const selection = {
			...options,
			olderThanMs,
			maxBatch: options.maxBatch ?? MAX_BATCH_HARD_CAP,
		};
		const targets: Array<{
			readonly table: "memory_jobs";
			readonly rows: readonly CancelPruneMatchRow[];
			readonly totalMatching: number;
		}> = [];
		// `--max-batch` is an aggregate cap across ALL selected tables, not a
		// per-table cap. Select memory first, then hand only the remaining
		// budget to summary so a both-queue operation can never exceed the
		// requested blast radius (issue #1053).
		let remaining = Math.min(selection.maxBatch ?? MAX_BATCH_HARD_CAP, MAX_BATCH_HARD_CAP);
		if (wantsMemory) {
			const r = buildCancelPruneSql(db, "memory_jobs", ["dead", "completed"], {
				...selection,
				maxBatch: remaining,
			});
			targets.push({ table: "memory_jobs", rows: r.rows, totalMatching: r.totalMatching });
			remaining = Math.max(0, remaining - r.rows.length);
		}

		const totalMatching = targets.reduce((acc, t) => acc + t.totalMatching, 0);

		if (dryRun) {
			const previewIds: string[] = [];
			for (const t of targets) {
				for (const r of t.rows) previewIds.push(`${t.table}:${r.id}`);
				if (previewIds.length >= PREVIEW_CAP) break;
			}
			return {
				affected: 0,
				preview: previewIds.slice(0, PREVIEW_CAP),
				totalMatching,
			};
		}

		let affected = 0;
		const previewIds: string[] = [];
		for (const t of targets) {
			for (const row of t.rows) {
				const cancellationId = `cancel-${t.table}-${row.id}-${Date.now()}`;
				const now = new Date().toISOString();
				db.prepare(
					`INSERT INTO job_cancellations
					 (id, source_table, source_id, status_before, payload_json,
					  reason, actor, actor_type, request_id, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					cancellationId,
					t.table,
					row.id,
					String(row.payload.status ?? ""),
					JSON.stringify(row.payload),
					ctx.reason,
					ctx.actor,
					ctx.actorType,
					ctx.requestId ?? null,
					now,
				);

				db.prepare(`UPDATE ${t.table} SET status = 'cancelled' WHERE id = ?`).run(row.id);
				affected += 1;
				if (previewIds.length < PREVIEW_CAP) previewIds.push(`${t.table}:${row.id}`);
			}
		}
		writeRepairAudit(db, action, ctx, affected, `cancelled ${affected} obsolete job(s)`);
		return { affected, preview: previewIds, totalMatching };
	});

	if (!dryRun) limiter.record(action);
	logger.info("pipeline", "repair: cancelled obsolete jobs", {
		affected: result.affected,
		dryRun,
		previewCount: result.preview.length,
		totalMatching: result.totalMatching,
		actor: ctx.actor,
		reason: ctx.reason,
	});

	return {
		action,
		success: true,
		affected: dryRun ? 0 : result.affected,
		message: dryRun
			? `dry-run: ${result.totalMatching} job(s) match cancel filter; preview shows ${result.preview.length}`
			: `cancelled ${result.affected} obsolete job(s)`,
		preview: dryRun ? result.preview : undefined,
		totalMatching: dryRun ? result.totalMatching : undefined,
	};
}

interface PruneResultMeta {
	readonly affected: number;
	readonly preview: readonly string[];
	readonly totalMatching: number;
}

/**
 * Prune terminal jobs (cancelled / completed / dead) older than the
 * configured retention window. Before delete, copies the full row to
 * `job_archive` to preserve provenance. Hard cap is 1000 rows per call.
 */
export function pruneTerminalJobs(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	options: JobFilterOptions = {},
): RepairResult {
	const action = "pruneTerminalJobs";
	const retired = rejectRetiredSummaryRepair(action, options);
	if (retired) return retired;

	const dryRun = options.dryRun === true;

	const gate = checkRepairGate(cfg, ctx, limiter, action, cfg.repair.requeueCooldownMs, cfg.repair.requeueHourlyBudget);
	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			message: gate.reason ?? "denied by policy gate",
		};
	}

	const wantsMemory = !options.tables || options.tables.includes("memory");
	const result = accessor.withWriteTx<PruneResultMeta>((db) => {
		if (!tableExists(db, "job_archive")) {
			throw new Error("job_archive table missing; run migrations");
		}

		const targets: Array<{
			readonly table: "memory_jobs";
			readonly statusList: readonly string[];
			readonly cutoff: number;
		}> = [];
		if (wantsMemory) {
			targets.push({
				table: "memory_jobs",
				statusList: ["dead", "cancelled", "completed"],
				cutoff: options.retentionMs ?? 90 * 24 * 60 * 60 * 1000,
			});
		}

		const perTable: Array<{
			readonly rows: readonly CancelPruneMatchRow[];
			readonly totalMatching: number;
		}> = [];
		let totalMatching = 0;
		// `--max-batch` is an aggregate cap across ALL selected tables; the
		// remaining budget carries across tables so a both-queue prune can
		// never exceed the requested blast radius (issue #1053).
		let remaining = Math.min(options.maxBatch ?? MAX_BATCH_HARD_CAP, MAX_BATCH_HARD_CAP);
		for (const t of targets) {
			const selection: JobFilterOptions = {
				...options,
				olderThanMs: t.cutoff,
				maxBatch: remaining,
			};
			const r = buildCancelPruneSql(db, t.table, t.statusList, selection);
			perTable.push({ rows: r.rows, totalMatching: r.totalMatching });
			totalMatching += r.totalMatching;
			remaining = Math.max(0, remaining - r.rows.length);
		}

		if (dryRun) {
			const previewIds: string[] = [];
			for (let i = 0; i < perTable.length; i += 1) {
				const t = targets[i];
				if (!t) continue;
				const pt = perTable[i];
				if (!pt) continue;
				for (const row of pt.rows) previewIds.push(`${t.table}:${row.id}`);
				if (previewIds.length >= PREVIEW_CAP) break;
			}
			return {
				affected: 0,
				preview: previewIds.slice(0, PREVIEW_CAP),
				totalMatching,
			};
		}

		let affected = 0;
		const previewIds: string[] = [];
		for (let i = 0; i < perTable.length; i += 1) {
			const t = targets[i];
			if (!t) continue;
			const pt = perTable[i];
			if (!pt) continue;
			for (const row of pt.rows) {
				const archiveId = `archive-${t.table}-${row.id}-${Date.now()}`;
				const now = new Date().toISOString();
				db.prepare(
					`INSERT INTO job_archive
					 (id, source_table, source_id, status, payload_json,
					  archived_at, archived_by, reason, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					archiveId,
					t.table,
					row.id,
					String(row.payload.status ?? ""),
					JSON.stringify(row.payload),
					now,
					ctx.actor,
					ctx.reason,
					now,
				);
				db.prepare(`DELETE FROM ${t.table} WHERE id = ?`).run(row.id);
				affected += 1;
				if (previewIds.length < PREVIEW_CAP) previewIds.push(`${t.table}:${row.id}`);
			}
		}
		writeRepairAudit(db, action, ctx, affected, `pruned ${affected} terminal job(s)`);
		return { affected, preview: previewIds, totalMatching };
	});

	if (!dryRun) limiter.record(action);
	logger.info("pipeline", "repair: pruned terminal jobs", {
		affected: result.affected,
		dryRun,
		previewCount: result.preview.length,
		totalMatching: result.totalMatching,
		actor: ctx.actor,
		reason: ctx.reason,
	});

	return {
		action,
		success: true,
		affected: dryRun ? 0 : result.affected,
		message: dryRun
			? `dry-run: ${result.totalMatching} job(s) match prune filter; preview shows ${result.preview.length}`
			: `pruned ${result.affected} terminal job(s) (archived)`,
		preview: dryRun ? result.preview : undefined,
		totalMatching: dryRun ? result.totalMatching : undefined,
	};
}
