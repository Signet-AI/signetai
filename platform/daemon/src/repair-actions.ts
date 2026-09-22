import {
	memoriesFtsNeedsTokenizerRepair,
	readMemoriesFtsIndexRowCount,
	readMemoriesFtsSql,
	recreateMemoriesFts,
} from "@signet/core";
import { normalizeAndHashContent } from "./content-normalization";
import type { IntegrityCheckStatus } from "./database-integrity";
import type { DbAccessor, ReadDb, SyncDbCallSiteToken, WriteDb } from "./db-accessor";
import { toFtsSchemaQueryDb } from "./db-accessor";
import {
	isDbOwnerMaintenanceClosing,
	type DbOwnerMaintenance,
	withRegisteredDbOwnerMaintenance,
} from "./db-owner-maintenance";
import {
	countChanges,
	readLiveVecDimensions,
	syncVecDeleteBySourceExceptHash,
	syncVecInsert,
	tableExists,
	vectorToBlob,
} from "./db-helpers";
import {
	type UnembeddedRow,
	countEmbeddingMigrationRows,
	listAllUnembeddedMemories,
	countUnembeddedMemories,
	listEmbeddingMigrationRows,
	listEmbeddingMigrationSources,
	listUnembeddedMemories,
} from "./embedding-coverage";
import { type EmbeddingMigrationCoverage, stagingCoverage } from "./embedding-index-migration";
import {
	isActiveEmbeddingConfig,
	readEmbeddingIndexState,
	resolveActiveEmbeddingConfig,
} from "./embedding-index-state";
import { embeddingProfileFingerprint } from "./embedding-profile";
import {
	acquireEmbeddingRepairLease,
	finishEmbeddingRepairLease,
	isEmbeddingRepairLeaseActive,
	loadEmbeddingRepairFailures,
	type EmbeddingRepairCheckpoint,
	type EmbeddingRepairKey,
	type EmbeddingRepairLease,
	type EmbeddingRepairState,
	ensureEmbeddingRepairCheckpoint,
	readEmbeddingRepairCheckpoint,
	readEmbeddingRepairState,
	updateEmbeddingRepairCheckpoint,
} from "./embedding-repair-state";
import { classifyEntityQuality } from "./entity-quality";
import { logger } from "./logger";
import type { EmbeddingConfig, PipelineV2Config } from "./memory-config";
import { recoverStaleLeases } from "./pipeline/stale-leases";
import { insertHistoryEvent } from "./transactions";
import { runVectorRepair, type VectorRepairOptions, type VectorRepairResult } from "./vector-repair";

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
	readonly preview?: readonly string[];
	readonly totalMatching?: number;
	readonly details?: Readonly<Record<string, unknown>>;
}
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
	if (ctx.actorType === "agent" && !cfg.autonomous.enabled) {
		return {
			allowed: false,
			reason: "autonomous.enabled is false; agents cannot trigger repairs",
		};
	}
	if (ctx.actorType === "operator" || ctx.actorType === "daemon") {
		return { allowed: true };
	}

	return limiter.check(action, cooldownMs, hourlyBudget);
}

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

const DEFAULT_REQUEUE_BATCH = 50;
const FTS_HOURLY_BUDGET = 5;

async function withRepairWriteTx<T>(
	accessor: DbAccessor,
	fn: (db: WriteDb) => T,
	operationId: SyncDbCallSiteToken,
): Promise<T> {
	if (accessor.withWriteTxAsync) {
		// DYNAMIC_SITE_TOKEN: each repair action supplies its stable semantic operation ID.
		return accessor.withWriteTxAsync(fn, { siteToken: operationId, operation: operationId });
	}
	throw new Error("async write API is unavailable");
}
let ftsMismatchPendingRebuild = false;
let ftsRebuildInFlight = false;
export function resetFtsRebuildConfirmation(): void {
	ftsMismatchPendingRebuild = false;
	ftsRebuildInFlight = false;
}
const PREVIEW_CAP = 100;
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
export async function requeueDeadJobs(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	maxBatchOrOptions: number | JobFilterOptions = DEFAULT_REQUEUE_BATCH,
): Promise<RepairResult> {
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

	const result = await withRepairWriteTx(
		accessor,
		(db) => {
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
				.prepare(
					`UPDATE memory_jobs SET status = 'pending', attempts = 0, updated_at = ? WHERE id IN (${placeholders})`,
				)
				.run(now, ...ids.map((row) => row.id));
			const affected = countChanges(changed);
			writeRepairAudit(db, action, ctx, affected, `requeued ${affected} dead memory job(s) to pending`);
			return { affected, preview: [] as readonly string[], totalMatching: selected.totalMatching };
		},
		"db:repair.requeue-dead.write",
	);

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

export async function releaseStaleLeases(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
): Promise<RepairResult> {
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

	const result = await withRepairWriteTx(
		accessor,
		(db) => {
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
		},
		"db:repair.release-leases.write",
	);

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
export async function checkFtsConsistency(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	repair = false,
	ownerMaintenance?: DbOwnerMaintenance | null,
): Promise<RepairResult> {
	const action = "checkFtsConsistency";
	if (ownerMaintenance === undefined) {
		const registeredResult = await withRegisteredDbOwnerMaintenance((maintenance) =>
			checkFtsConsistency(accessor, cfg, ctx, limiter, repair, maintenance),
		);
		if (registeredResult !== undefined) return registeredResult;
		if (isDbOwnerMaintenanceClosing()) {
			return {
				action,
				success: false,
				affected: 0,
				message: "DB owner maintenance is closing",
			};
		}
		return await checkFtsConsistency(accessor, cfg, ctx, limiter, repair, null);
	}
	const gate = checkRepairGate(cfg, ctx, limiter, action, cfg.repair.reembedCooldownMs, FTS_HOURLY_BUDGET);

	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			message: gate.reason ?? "denied by policy gate",
		};
	}

	const { memCount, ftsCount, ftsMissing, tokenizerDrift } = await accessor.withReadDbAsync(
		async (db) => {
			const memRow = db.prepare("SELECT COUNT(*) as n FROM memories").get() as { n: number };
			let ftsN: number | null = null;
			try {
				ftsN = readMemoriesFtsIndexRowCount(toFtsSchemaQueryDb(db));
			} catch {}
			const missing = ftsN === null;
			const ftsSql = missing ? null : readMemoriesFtsSql(toFtsSchemaQueryDb(db));
			return {
				memCount: memRow.n,
				ftsCount: ftsN ?? 0,
				ftsMissing: missing,
				tokenizerDrift: memoriesFtsNeedsTokenizerRepair(ftsSql),
			};
		},
		{ siteToken: "db:repair.fts-consistency.read" },
	);
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
			try {
				if (ownerMaintenance) {
					await ownerMaintenance.rebuildFts({
						checkpointKey: "fts.memories.repair",
						audit: {
							action,
							actor: ctx.actor,
							reason: ctx.reason,
							actorType: ctx.actorType,
							requestId: ctx.requestId,
							message: "FTS recreated with unicode61 tokenizer",
						},
					});
				} else {
					await withRepairWriteTx(
						accessor,
						(db) => {
							recreateMemoriesFts(db);
							writeRepairAudit(db, action, ctx, 1, "FTS recreated with unicode61 tokenizer");
						},
						"db:repair.fts.tokenizer-rebuild",
					);
				}
			} finally {
				ftsRebuildInFlight = false;
			}
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
	const mismatch = memCount !== ftsCount;

	let rebuilt = false;
	if (mismatch && repair) {
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
			try {
				if (ownerMaintenance) {
					await ownerMaintenance.rebuildFts({
						checkpointKey: "fts.memories.repair",
						audit: {
							action,
							actor: ctx.actor,
							reason: ctx.reason,
							actorType: ctx.actorType,
							requestId: ctx.requestId,
							message: `FTS rebuilt: ${memCount} canonical vs ${ftsCount} indexed rows`,
						},
					});
				} else {
					await withRepairWriteTx(
						accessor,
						(db) => {
							db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')").run();
							writeRepairAudit(db, action, ctx, 1, `FTS rebuilt: ${memCount} canonical vs ${ftsCount} indexed rows`);
						},
						"db:repair.fts.rebuild",
					);
				}
			} finally {
				ftsRebuildInFlight = false;
			}
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
export async function triggerRetentionSweep(
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	retentionHandle: { sweep(): Promise<unknown> },
): Promise<RepairResult> {
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

	await retentionHandle.sweep();
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

export interface EmbeddingGapStats {
	readonly unembedded: number;
	readonly total: number;
	readonly embedded: number;
	readonly complete: boolean;
	readonly coverage: string;
	readonly staging: EmbeddingMigrationCoverage | null;
	readonly repair: EmbeddingRepairState | null;
}

export interface EmbeddingRepairStats {
	readonly gap: EmbeddingGapStats;
	readonly migration: number;
	readonly orphaned: number;
}

function orphanedEmbeddingQuery(agentId?: string): { join: string; where: string; args: string[] } {
	const agentScope =
		agentId === undefined ? "" : " AND COALESCE(NULLIF(e.agent_id, ''), NULLIF(m.agent_id, ''), 'default') = ?";
	const hashPeerScope =
		agentId === undefined
			? ""
			: " AND COALESCE(NULLIF(m2.agent_id, ''), 'default') = COALESCE(NULLIF(e.agent_id, ''), NULLIF(m.agent_id, ''), 'default')";
	return {
		join: `LEFT JOIN memories m2
			   ON e.source_type = 'memory' AND e.content_hash = m2.content_hash AND m2.is_deleted = 0${hashPeerScope}`,
		where: `e.source_type = 'memory'
			AND (m.id IS NULL OR m.is_deleted = 1)
			AND m2.id IS NULL${agentScope}`,
		args: agentId === undefined ? [] : [agentId],
	};
}

function countOrphanedEmbeddings(db: ReadDb, agentId?: string): number {
	const query = orphanedEmbeddingQuery(agentId);
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n FROM embeddings e
			 LEFT JOIN memories m ON e.source_type = 'memory' AND e.source_id = m.id
			 ${query.join}
			 WHERE ${query.where}`,
		)
		.get(...query.args) as { n: number } | undefined;
	return row?.n ?? 0;
}

export async function getEmbeddingGapStats(accessor: DbAccessor, agentId: string): Promise<EmbeddingGapStats> {
	const repair = await readEmbeddingRepairState(accessor, agentId);
	return await accessor.withReadDbAsync(
		async (db) => {
			const totalRow = db
				.prepare(
					"SELECT COUNT(*) as n FROM memories WHERE is_deleted = 0 AND COALESCE(NULLIF(agent_id, ''), 'default') = ?",
				)
				.get(agentId) as { n: number };
			const total = totalRow.n;
			const unembedded = countUnembeddedMemories(db, agentId);
			const embedded = total - unembedded;
			const state = tableExists(db, "embedding_index_state") ? readEmbeddingIndexState(db) : null;
			const staging =
				state?.staging && tableExists(db, "embeddings_staging")
					? stagingCoverage(db, state.staging.dimensions, state.staging.fingerprint)
					: null;
			const complete = unembedded === 0 && (staging === null || staging.ready);
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
		},
		{ siteToken: "db:repair.embedding-gap.read" },
	);
}

export async function getEmbeddingRepairStats(
	accessor: DbAccessor,
	embeddingCfg: EmbeddingConfig,
	agentId: string,
): Promise<EmbeddingRepairStats> {
	const gap = await getEmbeddingGapStats(accessor, agentId);
	const migration = await accessor.withReadDbAsync(
		async (db) => countEmbeddingMigrationRows(db, embeddingCfg.model, embeddingCfg.dimensions, false, agentId),
		{ siteToken: "db:repair.embedding-migration.read" },
	);
	const orphaned = await accessor.withReadDbAsync(async (db) => countOrphanedEmbeddings(db, agentId), {
		siteToken: "db:repair.orphaned-embeddings.read",
	});
	return { gap, migration, orphaned };
}

const MAX_REEMBED_BATCH = 20;
const DEFAULT_REEMBED_BATCH = MAX_REEMBED_BATCH;
const DEFAULT_REEMBED_BYTES = 4 * 1024 * 1024;
const MAX_REEMBED_BYTES = 16 * 1024 * 1024;
const DEFAULT_REEMBED_RUN_BUDGET_MS = 30_000;
const MAX_REEMBED_RUN_BUDGET_MS = 120_000;

export interface ReembedOptions {
	readonly maxVectorBytes?: number;
	readonly runBudgetMs?: number;
	readonly signal?: AbortSignal;
}

interface ReembedEmbeddingOptions {
	readonly signal?: AbortSignal;
}

type ReembedEmbeddingFunction = (
	content: string,
	cfg: EmbeddingConfig,
	options?: ReembedEmbeddingOptions,
) => Promise<number[] | null>;

function normalizeBoundedRepairOption(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.min(maximum, Math.floor(value));
}

function normalizeRepairAgentId(agentId: string | null | undefined): string {
	const trimmed = agentId?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : "default";
}

interface ReembedBatchOutcome {
	readonly selected: number;
	readonly written: number;
	readonly failed: number;
	readonly stale: number;
	readonly crossAgentHashConflicts: number;
	readonly profileChanged: boolean;
	readonly leaseLost: boolean;
	readonly cancelled: boolean;
	readonly timedOut: boolean;
	readonly byteLimitReached: boolean;
	readonly successful: readonly EmbeddingRepairKey[];
	readonly failedKeys: readonly EmbeddingRepairKey[];
}

type MissingMemorySelector = (db: ReadDb, limit: number, model?: string, now?: string) => ReadonlyArray<UnembeddedRow>;

async function reembedMissingMemoriesBatch(
	accessor: DbAccessor,
	embeddingFn: ReembedEmbeddingFunction,
	embeddingCfg: EmbeddingConfig,
	batchSize: number,
	agentId: string,
	repairLease?: EmbeddingRepairLease,
	options?: ReembedOptions,
): Promise<ReembedBatchOutcome> {
	return reembedMissingMemoriesBatchWithSelector(
		accessor,
		embeddingFn,
		embeddingCfg,
		batchSize,
		(db, limit, model, now) => listUnembeddedMemories(db, limit, agentId, model, now),
		agentId,
		repairLease,
		options,
	);
}

async function reembedAllMissingMemoriesBatch(
	accessor: DbAccessor,
	embeddingFn: ReembedEmbeddingFunction,
	embeddingCfg: EmbeddingConfig,
	batchSize: number,
	options?: ReembedOptions,
): Promise<ReembedBatchOutcome> {
	return reembedMissingMemoriesBatchWithSelector(
		accessor,
		embeddingFn,
		embeddingCfg,
		batchSize,
		listAllUnembeddedMemories,
		undefined,
		undefined,
		options,
	);
}

async function reembedMissingMemoriesBatchWithSelector(
	accessor: DbAccessor,
	embeddingFn: ReembedEmbeddingFunction,
	embeddingCfg: EmbeddingConfig,
	batchSize: number,
	select: MissingMemorySelector,
	agentId?: string,
	repairLease?: EmbeddingRepairLease,
	options?: ReembedOptions,
): Promise<ReembedBatchOutcome> {
	const selectedAt = new Date().toISOString();
	const unembedded = await accessor.withReadDbAsync(
		async (db) => select(db, batchSize, embeddingCfg.model, selectedAt),
		{
			siteToken: "db:repair.missing-memory-selection.read",
		},
	);
	return reembedMissingMemoriesBatchForRows(
		accessor,
		embeddingFn,
		embeddingCfg,
		unembedded,
		agentId,
		repairLease,
		options,
	);
}

async function reembedMissingMemoriesBatchForRows(
	accessor: DbAccessor,
	embeddingFn: ReembedEmbeddingFunction,
	embeddingCfg: EmbeddingConfig,
	unembedded: ReadonlyArray<UnembeddedRow>,
	agentId?: string,
	repairLease?: EmbeddingRepairLease,
	options: ReembedOptions = {},
): Promise<ReembedBatchOutcome> {
	if (unembedded.length === 0) {
		return {
			selected: 0,
			written: 0,
			failed: 0,
			stale: 0,
			crossAgentHashConflicts: 0,
			profileChanged: false,
			leaseLost: false,
			cancelled: false,
			timedOut: false,
			byteLimitReached: false,
			successful: [],
			failedKeys: [],
		};
	}

	const failureKey = (memory: UnembeddedRow): EmbeddingRepairKey => ({
		id: memory.id,
		contentHash: memory.contentHash ?? normalizeAndHashContent(memory.content).contentHash,
	});
	const persistedFailures = await loadEmbeddingRepairFailures(accessor, unembedded.map(failureKey), embeddingCfg.model);
	const now = Date.now();
	const repairable = unembedded.filter((memory) => {
		if (memory.knownCrossAgentHashConflict === 1) return false;
		const key = failureKey(memory);
		const failure = persistedFailures.get(`${key.id}:${key.contentHash}:${embeddingCfg.model}`);
		return failure === undefined || failure.retryAt <= now;
	});
	const knownCrossAgentHashConflicts = unembedded.filter((memory) => memory.knownCrossAgentHashConflict === 1).length;
	const selectedEligible = repairable.length + knownCrossAgentHashConflicts;
	const failedKeys: EmbeddingRepairKey[] = [];
	const results: Array<{
		memory: UnembeddedRow;
		vector: readonly number[];
	}> = [];
	const maxBytes = normalizeBoundedRepairOption(options.maxVectorBytes, DEFAULT_REEMBED_BYTES, MAX_REEMBED_BYTES);
	const runBudgetMs = normalizeBoundedRepairOption(
		options.runBudgetMs,
		DEFAULT_REEMBED_RUN_BUDGET_MS,
		MAX_REEMBED_RUN_BUDGET_MS,
	);
	const startedAt = Date.now();
	let bytesUsed = 0;
	let cancelled = options.signal?.aborted === true;
	let timedOut = false;
	let byteLimitReached = false;

	for (const mem of repairable) {
		if (cancelled) break;
		if (Date.now() - startedAt >= runBudgetMs) {
			timedOut = true;
			break;
		}
		const contentBytes = new TextEncoder().encode(mem.content).byteLength;
		if (bytesUsed + contentBytes >= maxBytes) {
			byteLimitReached = true;
			break;
		}
		try {
			const vec = await embeddingFn(
				mem.content,
				embeddingCfg,
				options.signal === undefined ? undefined : { signal: options.signal },
			);
			if (options.signal?.aborted === true) {
				cancelled = true;
				break;
			}
			if (Date.now() - startedAt >= runBudgetMs) {
				timedOut = true;
				break;
			}
			if (vec) {
				const vectorBytes = vec.length * Float32Array.BYTES_PER_ELEMENT;
				if (bytesUsed + contentBytes + vectorBytes > maxBytes) {
					byteLimitReached = true;
					break;
				}
				bytesUsed += contentBytes + vectorBytes;
				results.push({ memory: mem, vector: vec });
			} else {
				failedKeys.push(failureKey(mem));
			}
		} catch (err) {
			if (options.signal?.aborted === true) {
				cancelled = true;
				break;
			}
			failedKeys.push(failureKey(mem));
			logger.warn("pipeline", "re-embed: embedding failed", {
				memoryId: mem.id,
				error: (err as Error).message,
			});
		}
	}

	if (cancelled || timedOut) {
		return {
			selected: selectedEligible,
			written: 0,
			failed: 0,
			stale: 0,
			crossAgentHashConflicts: knownCrossAgentHashConflicts,
			profileChanged: false,
			leaseLost: false,
			cancelled,
			timedOut,
			byteLimitReached: false,
			successful: [],
			failedKeys: [],
		};
	}

	if (results.length === 0) {
		return {
			selected: selectedEligible,
			written: 0,
			failed: failedKeys.length,
			stale: 0,
			crossAgentHashConflicts: knownCrossAgentHashConflicts,
			profileChanged: false,
			leaseLost: false,
			cancelled: false,
			timedOut: false,
			byteLimitReached,
			successful: [],
			failedKeys,
		};
	}

	const writeOutcome = await withRepairWriteTx(
		accessor,
		(db) => {
			if (repairLease !== undefined && !isEmbeddingRepairLeaseActive(db, repairLease)) {
				return {
					count: 0,
					stale: 0,
					crossAgentHashConflicts: 0,
					profileChanged: false,
					leaseLost: true,
					successful: [],
				};
			}
			if (!isActiveEmbeddingConfig(db, embeddingCfg)) {
				return {
					count: 0,
					stale: 0,
					crossAgentHashConflicts: 0,
					profileChanged: true,
					leaseLost: false,
					successful: [],
				};
			}
			const now = new Date().toISOString();
			let count = 0;
			let stale = 0;
			let crossAgentHashConflicts = 0;
			const successful: EmbeddingRepairKey[] = [];
			const readCurrentMemory = db.prepare(
				"SELECT content, content_hash, agent_id FROM memories WHERE id = ? AND is_deleted = 0",
			);
			const writeHash = db.prepare("UPDATE memories SET content_hash = ? WHERE id = ? AND content_hash IS NULL");
			const checkHash = db.prepare(
				"SELECT id FROM memories WHERE content_hash = ? AND is_deleted = 0 AND id <> ? LIMIT 1",
			);
			const readEmbeddingByHash = db.prepare("SELECT id, agent_id FROM embeddings WHERE content_hash = ? LIMIT 1");

			for (const { memory, vector } of results) {
				const current = readCurrentMemory.get(memory.id) as
					| { content: string; content_hash: string | null; agent_id: string | null }
					| null
					| undefined;
				if (current == null) {
					stale++;
					continue;
				}
				if (current.content !== memory.content || current.content_hash !== memory.contentHash) {
					stale++;
					continue;
				}
				if (normalizeRepairAgentId(current.agent_id) !== normalizeRepairAgentId(memory.agentId)) {
					stale++;
					continue;
				}

				const contentHash =
					typeof current.content_hash === "string" && current.content_hash.trim().length > 0
						? current.content_hash
						: normalizeAndHashContent(current.content).contentHash;
				const memoryAgentId = normalizeRepairAgentId(current.agent_id ?? agentId);
				if (current.content_hash == null) {
					const collision = checkHash.get(contentHash, memory.id) as { id: string } | undefined;
					if (!collision) writeHash.run(contentHash, memory.id);
				}
				const existing = readEmbeddingByHash.get(contentHash) as { id: string; agent_id: string | null } | undefined;
				if (existing) {
					const existingAgentId = normalizeRepairAgentId(existing.agent_id);
					if (existingAgentId !== memoryAgentId) {
						crossAgentHashConflicts++;
						continue;
					}
				}

				const embId = crypto.randomUUID();
				const blob = vectorToBlob(vector);
				syncVecDeleteBySourceExceptHash(db, "memory", memory.id, contentHash);
				db.prepare(
					`DELETE FROM embeddings
				 WHERE source_type = 'memory' AND source_id = ?
				   AND content_hash <> ?`,
				).run(memory.id, contentHash);
				db.prepare(
					`INSERT INTO embeddings
					 (id, content_hash, vector, dimensions, source_type,
					  source_id, chunk_text, created_at, agent_id)
					 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?, ?)
					 ON CONFLICT(content_hash) DO UPDATE SET
					   vector = excluded.vector,
					   dimensions = excluded.dimensions,
					   source_type = excluded.source_type,
					   chunk_text = excluded.chunk_text,
					   created_at = excluded.created_at`,
				).run(embId, contentHash, blob, vector.length, memory.id, memory.content, now, memoryAgentId);
				const actualRow = db.prepare("SELECT id FROM embeddings WHERE content_hash = ?").get(contentHash) as
					| { id: string }
					| undefined;
				if (actualRow) {
					syncVecInsert(db, actualRow.id, vector);
					count++;
					successful.push({ id: memory.id, contentHash });
				}
			}

			return { count, stale, crossAgentHashConflicts, profileChanged: false, leaseLost: false, successful };
		},
		"db:repair.reembed-missing.write",
	);

	return {
		selected: selectedEligible,
		written: writeOutcome.count,
		failed: failedKeys.length,
		stale: writeOutcome.stale,
		crossAgentHashConflicts: knownCrossAgentHashConflicts + writeOutcome.crossAgentHashConflicts,
		profileChanged: writeOutcome.profileChanged,
		leaseLost: writeOutcome.leaseLost,
		cancelled: false,
		timedOut: false,
		byteLimitReached,
		successful: writeOutcome.successful,
		failedKeys,
	};
}
export async function reembedMissingMemories(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	embeddingFn: ReembedEmbeddingFunction,
	embeddingCfg: EmbeddingConfig,
	agentId: string,
	batchSize: number = DEFAULT_REEMBED_BATCH,
	dryRun = false,
	runToCompletion = false,
	operationId?: string,
	existingLease?: EmbeddingRepairLease,
	options?: ReembedOptions,
): Promise<RepairResult> {
	const action = "reembedMissingMemories";
	const normalizedAgentId = normalizeRepairAgentId(agentId);
	if (!Number.isFinite(batchSize) || batchSize <= 0 || !Number.isInteger(batchSize)) {
		return {
			action,
			success: false,
			affected: 0,
			message: "batchSize must be a positive integer",
			details: { invalidInput: true },
		};
	}
	const effectiveCooldownMs = cfg.repair.reembedCooldownMs;
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
		Number.isFinite(batchSize) && batchSize > 0
			? Math.min(MAX_REEMBED_BATCH, Math.max(1, Math.floor(batchSize)))
			: DEFAULT_REEMBED_BATCH;
	const resolvedEmbeddingCfg = await accessor.withReadDbAsync(
		async (db) => resolveActiveEmbeddingConfig(db, embeddingCfg),
		{ siteToken: "db:repair.active-embedding-config.read" },
	);
	const resolvedProfileFingerprint = embeddingProfileFingerprint(resolvedEmbeddingCfg);

	if (dryRun) {
		const initialStats = await getEmbeddingGapStats(accessor, normalizedAgentId);
		return {
			action,
			success: true,
			affected: 0,
			message: `dry run: ${Math.min(normalizedBatchSize, initialStats.unembedded)} memories in this batch, ${initialStats.unembedded} total unembedded`,
		};
	}

	const checkpointId = runToCompletion ? (operationId ?? `embedding-repair-${crypto.randomUUID()}`) : undefined;
	let checkpoint: EmbeddingRepairCheckpoint | null = null;
	if (checkpointId !== undefined) {
		checkpoint =
			operationId === undefined
				? await ensureEmbeddingRepairCheckpoint(
						accessor,
						checkpointId,
						normalizedAgentId,
						resolvedEmbeddingCfg.model,
						resolvedProfileFingerprint,
					)
				: await readEmbeddingRepairCheckpoint(accessor, checkpointId);
		if (checkpoint === null) {
			return {
				action,
				success: false,
				affected: 0,
				message: `embedding repair operation ${checkpointId} was not found`,
			};
		}
		if (checkpoint.agentId !== normalizedAgentId || checkpoint.model !== resolvedEmbeddingCfg.model) {
			const mismatch = `embedding repair operation ${checkpointId} does not match the requested agent or model`;
			await updateEmbeddingRepairCheckpoint(accessor, checkpointId, {
				batches: 0,
				status: "failed",
				lastError: mismatch,
			});
			return {
				action,
				success: false,
				affected: 0,
				message: mismatch,
			};
		}
		if (checkpoint.profileFingerprint === null) {
			checkpoint = await updateEmbeddingRepairCheckpoint(accessor, checkpointId, {
				batches: 0,
				profileFingerprint: resolvedProfileFingerprint,
			});
		} else if (checkpoint.profileFingerprint !== resolvedProfileFingerprint) {
			const mismatch = `embedding repair operation ${checkpointId} does not match the active embedding profile`;
			await updateEmbeddingRepairCheckpoint(accessor, checkpointId, {
				batches: 0,
				status: "failed",
				lastError: mismatch,
			});
			return {
				action,
				success: false,
				affected: 0,
				message: mismatch,
			};
		}
		if (checkpoint.status === "complete") {
			return {
				action,
				success: true,
				affected: checkpoint.written,
				message: `embedding repair operation ${checkpointId} is already complete`,
				details: { operationId: checkpointId, status: checkpoint.status, remaining: 0, batches: checkpoint.batches },
			};
		}
		if (checkpoint.status === "failed") {
			return {
				action,
				success: false,
				affected: checkpoint.written,
				message: checkpoint.lastError ?? `embedding repair operation ${checkpointId} failed`,
				details: { operationId: checkpointId, status: checkpoint.status, batches: checkpoint.batches },
			};
		}
	}

	const initialStats = await getEmbeddingGapStats(accessor, normalizedAgentId);
	if (initialStats.unembedded === 0) {
		if (checkpointId !== undefined) {
			checkpoint = await updateEmbeddingRepairCheckpoint(accessor, checkpointId, { batches: 0, status: "complete" });
		}
		return {
			action,
			success: true,
			affected: 0,
			message: "no unembedded memories found",
			...(checkpointId === undefined
				? {}
				: {
						details: { operationId: checkpointId, status: "complete", remaining: 0, batches: checkpoint?.batches ?? 0 },
					}),
		};
	}

	const admission =
		existingLease === undefined
			? await acquireEmbeddingRepairLease(accessor, effectiveCooldownMs, cfg.repair.reembedHourlyBudget)
			: { allowed: true, lease: existingLease };
	if (!admission.allowed || admission.lease === undefined) {
		return {
			action,
			success: false,
			affected: 0,
			message: admission.reason ?? "embedding repair admission denied",
			...(checkpointId === undefined ? {} : { details: { operationId: checkpointId, status: "running" } }),
		};
	}

	const lease = admission.lease;
	let outcome: ReembedBatchOutcome | null = null;
	let thrown: unknown = null;
	try {
		outcome = await reembedMissingMemoriesBatch(
			accessor,
			embeddingFn,
			resolvedEmbeddingCfg,
			normalizedBatchSize,
			normalizedAgentId,
			lease,
			options,
		);
	} catch (error) {
		thrown = error;
	}

	let finishError: unknown = null;
	try {
		await finishEmbeddingRepairLease(accessor, lease, {
			successful: outcome?.successful ?? [],
			failed: outcome?.failedKeys ?? [],
			affected: outcome?.written ?? 0,
			agentId: normalizedAgentId,
			model: resolvedEmbeddingCfg.model,
			pollMs: cfg.embeddingTracker.pollMs,
			eligibility: outcome?.profileChanged === true ? false : (db) => isActiveEmbeddingConfig(db, resolvedEmbeddingCfg),
			...(thrown instanceof Error
				? { error: thrown.message }
				: outcome?.cancelled
					? { error: "embedding repair cancelled" }
					: outcome?.timedOut
						? { error: "embedding repair batch time budget exceeded" }
						: outcome?.byteLimitReached
							? { error: "embedding repair batch byte budget reached" }
							: {}),
		});
	} catch (error) {
		finishError = error;
	}

	if (thrown !== null || finishError !== null) {
		if (checkpointId !== undefined) {
			await updateEmbeddingRepairCheckpoint(accessor, checkpointId, {
				status: "failed",
				lastError:
					thrown instanceof Error
						? thrown.message
						: finishError instanceof Error
							? finishError.message
							: String(thrown ?? finishError),
			});
		}
		throw thrown ?? finishError;
	}

	if (outcome === null || outcome.selected === 0) {
		const remaining = (await getEmbeddingGapStats(accessor, normalizedAgentId)).unembedded;
		if (remaining > 0) {
			return {
				action,
				success: false,
				affected: 0,
				message: "no eligible unembedded memories; persisted retry backoff is still active",
				...(checkpointId === undefined ? {} : { details: { operationId: checkpointId, status: "running", remaining } }),
			};
		}
		if (checkpointId !== undefined) {
			checkpoint = await updateEmbeddingRepairCheckpoint(accessor, checkpointId, { batches: 0, status: "complete" });
		}
		return {
			action,
			success: true,
			affected: 0,
			message: "no unembedded memories found",
			...(checkpointId === undefined
				? {}
				: {
						details: { operationId: checkpointId, status: "complete", remaining: 0, batches: checkpoint?.batches ?? 0 },
					}),
		};
	}

	const attempted = outcome.selected;
	const written = outcome.written;
	const failed = outcome.failed;
	const stale = outcome.stale;
	const crossAgentHashConflicts = outcome.crossAgentHashConflicts;
	const remaining = (await getEmbeddingGapStats(accessor, normalizedAgentId)).unembedded;
	const noProgress = written === 0;
	const operationStatus: "running" | "complete" | "failed" =
		outcome.leaseLost || outcome.profileChanged || crossAgentHashConflicts > 0 || (noProgress && stale > 0)
			? "failed"
			: remaining === 0
				? "complete"
				: "running";
	const conflictMessage =
		crossAgentHashConflicts > 0
			? `${crossAgentHashConflicts} selected memory(s) could not be persisted because their content hash is owned by another agent under the current global uniqueness constraint`
			: "";
	const progressMessage = outcome.leaseLost
		? "embedding repair lease was lost before persistence"
		: outcome.profileChanged
			? "embedding profile changed during provider work; skipped stale vectors"
			: outcome.cancelled
				? "embedding repair was cancelled before persistence"
				: outcome.timedOut
					? `embedding repair batch time budget exceeded after ${written} persisted memories`
					: outcome.byteLimitReached
						? `embedding repair batch byte budget reached after ${written} persisted memories`
						: written === 0
							? crossAgentHashConflicts > 0
								? conflictMessage
								: stale > 0
									? `re-embedded 0 of ${attempted} memories because ${stale} changed during provider work`
									: `embedding provider returned no vectors for ${attempted} memories`
							: failed > 0
								? `re-embedded ${written} of ${attempted} memories in one bounded batch (${failed} failed, ${remaining} still missing)`
								: `re-embedded ${written} of ${attempted} memories in one bounded batch (${remaining} still missing)`;
	const resultMessage = conflictMessage.length > 0 ? `${progressMessage}; ${conflictMessage}` : progressMessage;

	if (checkpointId !== undefined) {
		checkpoint = await updateEmbeddingRepairCheckpoint(accessor, checkpointId, {
			status: operationStatus,
			selected: attempted,
			written,
			failed,
			stale,
			crossAgentHashConflicts,
			lastError:
				operationStatus === "failed" || failed > 0 || outcome.cancelled || outcome.timedOut || outcome.byteLimitReached
					? resultMessage
					: null,
		});
	}

	if (written > 0) {
		await withRepairWriteTx(
			accessor,
			(db) => {
				writeRepairAudit(db, action, ctx, written, resultMessage);
			},
			"db:repair.reembed-missing.audit",
		);
		limiter.record(action);
	}

	logger.info("pipeline", "repair: re-embedded missing memories", {
		affected: written,
		attempted,
		failed,
		remaining,
		batches: 1,
		runToCompletion,
		operationId: checkpointId,
		actor: ctx.actor,
		reason: ctx.reason,
	});

	return {
		action,
		success:
			operationStatus !== "failed" &&
			crossAgentHashConflicts === 0 &&
			failed === 0 &&
			!outcome.cancelled &&
			!outcome.timedOut &&
			!outcome.byteLimitReached,
		affected: written,
		message:
			checkpointId === undefined ? resultMessage : `${resultMessage}; operation ${checkpointId} is ${operationStatus}`,
		details: {
			selected: attempted,
			failed,
			stale,
			crossAgentHashConflicts,
			...(outcome.cancelled ? { cancelled: true } : {}),
			...(outcome.timedOut ? { timedOut: true } : {}),
			...(outcome.byteLimitReached ? { byteLimitReached: true } : {}),
			...(outcome.leaseLost ? { leaseLost: true } : {}),
			...(checkpointId === undefined
				? {}
				: { operationId: checkpointId, status: operationStatus, remaining, batches: checkpoint?.batches ?? 1 }),
		},
	};
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
	const { rows, totalMatching, sources, liveVecDimensions } = await accessor.withReadDbAsync(
		async (db) => ({
			rows: listEmbeddingMigrationRows(db, embeddingCfg.model, embeddingCfg.dimensions, all, size, agentId),
			totalMatching: countEmbeddingMigrationRows(db, embeddingCfg.model, embeddingCfg.dimensions, all, agentId),
			sources: listEmbeddingMigrationSources(db, embeddingCfg.model, embeddingCfg.dimensions, all, agentId),
			liveVecDimensions: readVecDimensions(db),
		}),
		{ siteToken: "db:repair.embedding-migration-selection.read" },
	);
	const vecDimensionMismatch = liveVecDimensions !== null && liveVecDimensions !== embeddingCfg.dimensions;
	const details = {
		selected: totalMatching,
		selectedThisBatch: rows.length,
		agentId,
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
	let contentChanged = 0;
	let ownershipChanged = 0;
	let crossAgentConflict = 0;
	let profileChanged = false;
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
			const writeOutcome = await withRepairWriteTx(
				accessor,
				(
					db,
				): {
					wrote: boolean;
					profileChanged: boolean;
					contentChanged: boolean;
					ownershipChanged: boolean;
					crossAgentConflict: boolean;
				} => {
					if (!isActiveEmbeddingConfig(db, embeddingCfg))
						return {
							wrote: false,
							profileChanged: true,
							contentChanged: false,
							ownershipChanged: false,
							crossAgentConflict: false,
						};
					const current = db
						.prepare("SELECT content, content_hash, agent_id FROM memories WHERE id = ? AND is_deleted = 0")
						.get(row.id) as { content: string; content_hash: string | null; agent_id: string | null } | null;
					if (!current)
						return {
							wrote: false,
							profileChanged: false,
							contentChanged: false,
							ownershipChanged: false,
							crossAgentConflict: false,
						};
					if (current.content_hash !== row.contentHash || current.content !== row.content) {
						return {
							wrote: false,
							profileChanged: false,
							contentChanged: true,
							ownershipChanged: false,
							crossAgentConflict: false,
						};
					}
					if (normalizeRepairAgentId(current.agent_id) !== normalizeRepairAgentId(row.agentId)) {
						return {
							wrote: false,
							profileChanged: false,
							contentChanged: false,
							ownershipChanged: true,
							crossAgentConflict: false,
						};
					}
					const memoryAgentId = normalizeRepairAgentId(current.agent_id ?? agentId);
					const id = crypto.randomUUID();
					const existing = db
						.prepare("SELECT agent_id FROM embeddings WHERE content_hash = ? LIMIT 1")
						.get(current.content_hash) as { agent_id: string | null } | null;
					if (existing != null && normalizeRepairAgentId(existing.agent_id) !== memoryAgentId)
						return {
							wrote: false,
							profileChanged: false,
							contentChanged: false,
							ownershipChanged: false,
							crossAgentConflict: true,
						};
					db.prepare(
						`INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id) VALUES (?, ?, ?, ?, 'memory', ?, ?, datetime('now'), ?) ON CONFLICT(content_hash) DO UPDATE SET vector=excluded.vector, dimensions=excluded.dimensions, source_id=excluded.source_id, chunk_text=excluded.chunk_text, created_at=excluded.created_at`,
					).run(id, current.content_hash, vectorToBlob(vector), vector.length, row.id, row.content, memoryAgentId);
					const embedding = db.prepare("SELECT id FROM embeddings WHERE content_hash = ?").get(current.content_hash) as
						| { id: string }
						| undefined;
					if (!embedding)
						return {
							wrote: false,
							profileChanged: false,
							contentChanged: false,
							ownershipChanged: false,
							crossAgentConflict: false,
						};
					syncVecInsert(db, embedding.id, vector);
					db.prepare("UPDATE memories SET embedding_model = ? WHERE id = ?").run(embeddingCfg.model, row.id);
					return {
						wrote: true,
						profileChanged: false,
						contentChanged: false,
						ownershipChanged: false,
						crossAgentConflict: false,
					};
				},
				"db:repair.reembed-migration.write",
			);
			if (writeOutcome.profileChanged) {
				profileChanged = true;
				break;
			}
			if (writeOutcome.contentChanged) {
				contentChanged++;
				continue;
			}
			if (writeOutcome.ownershipChanged) {
				ownershipChanged++;
				continue;
			}
			if (writeOutcome.crossAgentConflict) {
				crossAgentConflict++;
				continue;
			}
			if (writeOutcome.wrote) written++;
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
	}${contentChanged > 0 ? ` (${contentChanged} changed during provider work)` : ""}${
		ownershipChanged > 0 ? ` (${ownershipChanged} ownership change(s) during provider work)` : ""
	}${crossAgentConflict > 0 ? ` (${crossAgentConflict} cross-agent hash conflict(s) skipped)` : ""}`;
	if (profileChanged) {
		return {
			action,
			success: false,
			affected: written,
			message: "embedding profile changed during provider work; skipped stale migration vectors",
			totalMatching,
			details: { ...details, failed, contentChanged, ownershipChanged, crossAgentConflict },
		};
	}
	if (written > 0) {
		try {
			await withRepairWriteTx(
				accessor,
				(db) => writeRepairAudit(db, action, ctx, written, message),
				"db:repair.reembed-migration.audit",
			);
		} catch (error) {
			logger.warn("pipeline", "re-embed migration: audit write failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		limiter.record(action);
	}
	return {
		action,
		success: failed === 0 && contentChanged === 0 && ownershipChanged === 0 && crossAgentConflict === 0,
		affected: written,
		message,
		totalMatching,
		details: { ...details, failed, contentChanged, ownershipChanged, crossAgentConflict },
	};
}
export async function cleanOrphanedEmbeddings(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	maxBatch = Number.MAX_SAFE_INTEGER,
	agentId?: string,
	options?: Omit<VectorRepairOptions, "agentId" | "batchSize">,
): Promise<VectorRepairResult> {
	const action = "cleanOrphanedEmbeddings";
	const gate = checkRepairGate(cfg, ctx, limiter, action, cfg.repair.requeueCooldownMs, cfg.repair.requeueHourlyBudget);

	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			message: gate.reason ?? "denied by policy gate",
			operation: "clean-orphans",
			agentId: normalizeRepairAgentId(agentId),
			checkpointId: "not-created",
			phase: "orphan-embeddings",
			status: "failed",
			cursor: null,
			processed: 0,
			skipped: 0,
			failed: 0,
			remaining: 0,
			remainingStatus: "none",
			batches: 0,
		};
	}

	const result = await runVectorRepair(accessor, ctx, "clean-orphans", {
		agentId: normalizeRepairAgentId(agentId),
		batchSize: maxBatch,
		...options,
	});
	if (!result.success && result.failed > 0 && options?.throwOnFailure !== false) {
		throw new Error("failed to reconcile vec_embeddings before orphan cleanup");
	}
	if (result.success && result.status === "complete") limiter.record(action);
	logger.info("pipeline", "repair: cleaned orphaned embeddings", {
		affected: result.affected,
		processed: result.processed,
		remaining: result.remaining,
		checkpointId: result.checkpointId,
		agentId: result.agentId,
		actor: ctx.actor,
		reason: ctx.reason,
	});
	return result;
}
export async function resyncVectorIndex(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	agentId = "default",
	options?: Omit<VectorRepairOptions, "agentId">,
): Promise<VectorRepairResult> {
	const action = "resyncVectorIndex";
	const gate = checkRepairGate(cfg, ctx, limiter, action, cfg.repair.reembedCooldownMs, cfg.repair.reembedHourlyBudget);

	if (!gate.allowed) {
		return {
			action,
			success: false,
			affected: 0,
			message: gate.reason ?? "denied by policy gate",
			operation: "resync",
			agentId: normalizeRepairAgentId(agentId),
			checkpointId: "not-created",
			phase: "missing-vectors",
			status: "failed",
			cursor: null,
			processed: 0,
			skipped: 0,
			failed: 0,
			remaining: 0,
			remainingStatus: "none",
			batches: 0,
		};
	}

	const result = await runVectorRepair(accessor, ctx, "resync", {
		agentId: normalizeRepairAgentId(agentId),
		...options,
	});
	if (result.success && result.status === "complete") limiter.record(action);
	logger.info("pipeline", "repair: resynced vec index", {
		affected: result.affected,
		processed: result.processed,
		remaining: result.remaining,
		checkpointId: result.checkpointId,
		agentId: result.agentId,
		actor: ctx.actor,
		reason: ctx.reason,
	});
	return result;
}

export interface DedupStats {
	readonly exactClusters: number;
	readonly exactExcess: number;
	readonly totalActive: number;
}

export async function getDedupStats(accessor: DbAccessor): Promise<DedupStats> {
	return await accessor.withReadDbAsync(
		async (db) => {
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
		},
		{ siteToken: "db:repair.dedup-stats.read" },
	);
}

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
	const updatedMs = new Date(c.updated_at).getTime();
	s += updatedMs / 1e15;
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
	if (candidates.some((c) => c.pinned || c.manual_override)) {
		return null;
	}

	if (candidates.length < 2) return null;
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
	let mergedTags = keeper.tags;
	for (const loser of losers) {
		mergedTags = mergeTags(mergedTags, loser.tags);
	}

	if (mergedTags !== keeper.tags) {
		db.prepare("UPDATE memories SET tags = ?, updated_at = ? WHERE id = ?").run(mergedTags, now, keeper.id);
	}
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
	const hashClusters = await accessor.withReadDbAsync(
		async (db) => {
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
		},
		{ siteToken: "db:repair.exact-duplicate-candidates.read" },
	);

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
	for (const cluster of hashClusters) {
		const removed = await withRepairWriteTx(
			accessor,
			(db) => {
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
			},
			"db:repair.deduplicate.exact.write",
		);

		if (removed > 0) {
			totalRemoved += removed;
			totalClusters++;
		}
	}
	if (semanticEnabled && totalClusters < batchSize) {
		const semanticClusters = await findSemanticDuplicates(accessor, semanticThreshold, batchSize - totalClusters);

		for (const cluster of semanticClusters) {
			const removed = await withRepairWriteTx(
				accessor,
				(db) => {
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
				},
				"db:repair.deduplicate.semantic.write",
			);

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

	const candidates = await accessor.withReadDbAsync(
		async (db) => {
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
		},
		{ siteToken: "db:repair.semantic-duplicates.candidates.read" },
	);

	for (const candidate of candidates) {
		if (seen.has(candidate.id)) continue;
		if (clusters.length >= maxClusters) break;

		const neighbors = await accessor.withReadDbAsync(
			async (db) => {
				const vecRow = db.prepare("SELECT embedding FROM vec_embeddings WHERE id = ?").get(candidate.embedding_id) as
					| { embedding: ArrayBuffer }
					| undefined;

				if (!vecRow) return [];

				const queryVec = new Float32Array(vecRow.embedding);
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
				return rows
					.filter((r) => r.source_id !== candidate.id)
					.filter((r) => {
						const similarity = 1 - r.distance;
						return similarity >= threshold;
					})
					.map((r) => ({ id: r.source_id }));
			},
			{ siteToken: "db:repair.semantic-duplicates.neighbors.read" },
		);

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
export async function pruneChunkGroupEntities(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	options?: { batchSize?: number; dryRun?: boolean },
): Promise<RepairResult> {
	const action = "pruneChunkGroupEntities";
	const gate = checkRepairGate(cfg, ctx, limiter, action, 60_000, 5);
	if (!gate.allowed) {
		return { action, success: false, affected: 0, message: gate.reason ?? "denied" };
	}

	const batchSize = options?.batchSize ?? 500;

	const total = await accessor.withReadDbAsync(
		async (db) =>
			(db.prepare("SELECT COUNT(*) as n FROM entities WHERE entity_type = 'chunk_group'").get() as { n: number }).n,
		{ siteToken: "db:repair.chunk-group-count.read" },
	);

	if (options?.dryRun) {
		return {
			action,
			success: true,
			affected: total,
			message: `dry-run: would delete ${total} chunk_group entities`,
		};
	}

	const affected = await withRepairWriteTx(
		accessor,
		(db) => {
			const ids = db.prepare("SELECT id FROM entities WHERE entity_type = 'chunk_group' LIMIT ?").all(batchSize) as {
				id: string;
			}[];
			if (ids.length === 0) return 0;
			const placeholders = ids.map(() => "?").join(",");
			db.prepare(`DELETE FROM entities WHERE id IN (${placeholders})`).run(...ids.map((r) => r.id));
			writeRepairAudit(db, action, ctx, ids.length, `deleted ${ids.length} chunk_group entities`);
			return ids.length;
		},
		"db:repair.prune-chunk-groups.write",
	);

	limiter.record(action);
	logger.info("pipeline", "repair: pruned chunk_group entities", { affected, actor: ctx.actor });
	return { action, success: true, affected, message: `deleted ${affected} chunk_group entities` };
}
export async function pruneSingletonExtractedEntities(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	options?: { batchSize?: number; dryRun?: boolean; maxMentions?: number },
): Promise<RepairResult> {
	const action = "pruneSingletonExtractedEntities";
	const gate = checkRepairGate(cfg, ctx, limiter, action, 60_000, 10);
	if (!gate.allowed) {
		return { action, success: false, affected: 0, message: gate.reason ?? "denied" };
	}

	const batchSize = options?.batchSize ?? 200;
	const maxMentions = options?.maxMentions ?? 1;

	const candidates = await accessor.withReadDbAsync(
		async (db) =>
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
		{ siteToken: "db:repair.singleton-entity-candidates.read" },
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

	const affected = await withRepairWriteTx(
		accessor,
		(db) => {
			const ids = candidates.map((r) => r.id);
			const placeholders = ids.map(() => "?").join(",");
			db.prepare(`DELETE FROM memory_entity_mentions WHERE entity_id IN (${placeholders})`).run(...ids);
			db.prepare(
				`DELETE FROM relations WHERE source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders})`,
			).run(...ids, ...ids);
			db.prepare(`DELETE FROM entities WHERE id IN (${placeholders})`).run(...ids);
			writeRepairAudit(db, action, ctx, ids.length, `deleted ${ids.length} singleton extracted entities`);
			return ids.length;
		},
		"db:repair.prune-singleton-entities.write",
	);

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
export async function pruneGenericEntities(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	options?: { batchSize?: number; dryRun?: boolean; agentId?: string },
): Promise<RepairResult> {
	const action = "pruneGenericEntities";
	const gate = checkRepairGate(cfg, ctx, limiter, action, 60_000, 10);
	if (!gate.allowed) {
		return { action, success: false, affected: 0, message: gate.reason ?? "denied" };
	}

	const batchSize = Math.max(1, Math.min(Math.floor(options?.batchSize ?? 100), 500));
	const agentId = options?.agentId ?? "default";
	const candidates = await accessor.withReadDbAsync(
		async (db) => {
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
		},
		{ siteToken: "db:repair.generic-entity-candidates.read" },
	);

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

	const affected = await withRepairWriteTx(
		accessor,
		(db) => {
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
		},
		"db:repair.prune-generic-entities.write",
	);

	limiter.record(action);
	logger.info("pipeline", "repair: pruned generic/non-concrete entities", {
		affected,
		agentId,
		actor: ctx.actor,
	});
	return { action, success: true, affected, message: `deleted ${affected} generic/non-concrete entities` };
}

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
	readonly maxConfidence?: number;
	readonly maxAccessDays?: number;
	readonly limit?: number;
}
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
export async function forgetDeadMemories(accessor: DbAccessor, ids: readonly string[]): Promise<number> {
	if (ids.length === 0) return 0;
	const now = new Date().toISOString();
	return await withRepairWriteTx(
		accessor,
		(db) => {
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
		},
		"db:repair.forget-dead-memories.write",
	);
}

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
export async function integrityCheck(accessor: DbAccessor): Promise<IntegrityCheckResult> {
	return await accessor.withReadDbAsync(
		async (db) => {
			const quickCheck = readIntegrityCheck(db, "quick_check");
			const fullCheck = readIntegrityCheck(db, "integrity_check");
			return { ok: fullCheck.ok, messages: fullCheck.messages, quickCheck, fullCheck };
		},
		{ siteToken: "db:repair.integrity-check.read" },
	);
}

export interface RebuildIndexesResult {
	readonly integrity: { ok: boolean; messages: readonly string[] };
	readonly fts: { repaired: boolean; message: string };
	readonly embeddings: {
		readonly reembedded: number;
		readonly totalMissing: number;
		readonly crossAgentHashConflicts: number;
	};
	readonly summary: string;
}
export async function rebuildDerivedIndexes(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	embeddingFn: (content: string, cfg: EmbeddingConfig) => Promise<number[] | null>,
	embeddingCfg: EmbeddingConfig,
): Promise<RebuildIndexesResult> {
	const integrity = await integrityCheck(accessor);
	const ftsResult = await checkFtsConsistency(accessor, cfg, ctx, limiter, true);
	const reembedResult = await reembedAllMissingMemoriesBatch(accessor, embeddingFn, embeddingCfg, 200);

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
	parts.push(
		reembedResult.crossAgentHashConflicts > 0
			? `embeddings: re-embedded ${reembedResult.written} of ${reembedResult.selected} missing; ${reembedResult.crossAgentHashConflicts} selected memory(s) could not be persisted under the current global uniqueness constraint because their content hash is owned by another agent`
			: `embeddings: re-embedded ${reembedResult.written} of ${reembedResult.selected} missing`,
	);

	return {
		integrity,
		fts: { repaired: ftsResult.affected > 0, message: ftsResult.message },
		embeddings: {
			reembedded: reembedResult.written,
			totalMissing: reembedResult.selected - reembedResult.written,
			crossAgentHashConflicts: reembedResult.crossAgentHashConflicts,
		},
		summary: parts.join(" · "),
	};
}

interface DeadMatchRow {
	readonly id: string;
}

interface BuiltSql {
	readonly sql: string;
	readonly params: readonly unknown[];
	readonly ids: readonly DeadMatchRow[];
	readonly totalMatching: number;
}
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

interface CancelResultMeta {
	readonly affected: number;
	readonly preview: readonly string[];
	readonly totalMatching: number;
}
export async function cancelObsoleteJobs(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	options: JobFilterOptions = {},
): Promise<RepairResult> {
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
	const result = await withRepairWriteTx<CancelResultMeta>(
		accessor,
		(db) => {
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
			const remaining = Math.min(selection.maxBatch ?? MAX_BATCH_HARD_CAP, MAX_BATCH_HARD_CAP);
			if (wantsMemory) {
				const r = buildCancelPruneSql(db, "memory_jobs", ["dead", "completed"], {
					...selection,
					maxBatch: remaining,
				});
				targets.push({ table: "memory_jobs", rows: r.rows, totalMatching: r.totalMatching });
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
		},
		"db:repair.cancel-obsolete-jobs.write",
	);

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
export async function pruneTerminalJobs(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	options: JobFilterOptions = {},
): Promise<RepairResult> {
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
	const result = await withRepairWriteTx<PruneResultMeta>(
		accessor,
		(db) => {
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
		},
		"db:repair.prune-terminal-jobs.write",
	);

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
