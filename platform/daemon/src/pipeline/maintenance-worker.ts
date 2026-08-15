/**
 * Autonomous maintenance worker.
 *
 * Periodically runs diagnostics and, when health degrades, invokes
 * the appropriate repair action. Starts in observe-only mode by
 * default; graduates to execute mode via config.
 *
 * The interval is single-flight: a slow cycle is allowed to finish before
 * another cycle starts.
 */

import type { DbAccessor } from "../db-accessor";
import { getFreePageRatio } from "../db-vacuum";
import type { DiagnosticsReport, ProviderTracker } from "../diagnostics";
import { getDiagnostics } from "../diagnostics";
import { isActiveEmbeddingConfig } from "../embedding-index-state";
import { acquireEmbeddingRepairLease, finishEmbeddingRepairLease } from "../embedding-repair-state";
import { propagateMemoryStatus } from "../knowledge-graph";
import { logger } from "../logger";
import type { EmbeddingConfig, PipelineV2Config } from "../memory-config";
import {
	DEAD_MEMORY_DEFAULT_ACCESS_DAYS,
	DEAD_MEMORY_DEFAULT_CONFIDENCE,
	type EmbeddingRepairStats,
	type RateLimiter,
	type RepairContext,
	type RepairResult,
	checkFtsConsistency,
	cleanOrphanedEmbeddings,
	createRateLimiter,
	deduplicateMemories,
	getEmbeddingRepairStats,
	reembedMissingMemories,
	reembedModelMigration,
	releaseStaleLeases,
	requeueDeadJobs,
	triggerRetentionSweep,
} from "../repair-actions";
import { isSystemPressureHigh } from "../system-pressure";
import { decayAspectWeights, recordFeedbackTelemetry } from "./aspect-feedback";
import { invalidateTraversalCache } from "./graph-traversal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MaintenanceHandle {
	stop(): void;
	readonly running: boolean;
	/** Run a single maintenance cycle (for testing) */
	tick(): Promise<MaintenanceCycleResult>;
}

export interface MaintenanceCycleResult {
	readonly report: DiagnosticsReport;
	readonly recommendations: readonly RepairRecommendation[];
	readonly executed: readonly RepairResult[];
	readonly feedbackDecayedAspects: number;
	readonly feedbackPropagatedAttributes: number;
}

export interface RepairRecommendation {
	readonly domain: string;
	readonly action: string;
	readonly trigger: string;
}

// ---------------------------------------------------------------------------
// Recommendation engine
// ---------------------------------------------------------------------------

function buildRecommendations(
	report: DiagnosticsReport,
	embedding: EmbeddingRepairStats | null,
): RepairRecommendation[] {
	const recs: RepairRecommendation[] = [];

	if (embedding && (embedding.orphaned > 0 || embedding.migration > 0 || embedding.gap.unembedded > 0)) {
		const priority =
			embedding.orphaned > 0 ? "orphan cleanup" : embedding.gap.unembedded > 0 ? "missing vectors" : "model migration";
		recs.push({
			domain: "embedding",
			action: "repairEmbeddingIndex",
			trigger: `${priority}: ${embedding.gap.unembedded} missing, ${embedding.migration} migration, ${embedding.orphaned} orphaned`,
		});
	}

	if (report.queue.deadRate > 0.01) {
		recs.push({
			domain: "queue",
			action: "requeueDeadJobs",
			trigger: `dead rate ${(report.queue.deadRate * 100).toFixed(1)}% > 1%`,
		});
	}
	if (report.queue.leaseAnomalies > 0) {
		recs.push({
			domain: "queue",
			action: "releaseStaleLeases",
			trigger: `${report.queue.leaseAnomalies} stale lease(s)`,
		});
	}
	if (report.index.ftsMismatch) {
		recs.push({
			domain: "index",
			action: "checkFtsConsistency",
			trigger: `FTS mismatch: ${report.index.ftsRowCount} indexed rows`,
		});
	}
	if (report.storage.deletedTombstones > 0) {
		const ratio =
			report.storage.totalMemories > 0 ? report.storage.deletedTombstones / report.storage.totalMemories : 0;
		if (ratio > 0.3) {
			recs.push({
				domain: "storage",
				action: "triggerRetentionSweep",
				trigger: `tombstone ratio ${(ratio * 100).toFixed(0)}% > 30%`,
			});
		}
	}
	if (report.duplicate.duplicateRatio > 0.05) {
		recs.push({
			domain: "duplicate",
			action: "deduplicateMemories",
			trigger: `duplicate ratio ${(report.duplicate.duplicateRatio * 100).toFixed(1)}% > 5%`,
		});
	}

	return recs;
}

async function getGraphAgentIds(accessor: DbAccessor): Promise<readonly string[]> {
	return await accessor.withReadDbAsync(async (db) => {
		const rows = db
			.prepare(
				`SELECT agent_id FROM entity_aspects
				 UNION
				 SELECT agent_id FROM entity_attributes
				 UNION
				 SELECT agent_id FROM entities`,
			)
			.all() as Array<Record<string, unknown>>;
		const ids = rows.flatMap((row) =>
			typeof row.agent_id === "string" && row.agent_id.length > 0 ? [row.agent_id] : [],
		);
		return ids.length > 0 ? ids : ["default"];
	});
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ExecutionDeps {
	accessor: DbAccessor;
	cfg: PipelineV2Config;
	limiter: RateLimiter;
	retentionHandle: { sweep(): Promise<unknown> } | null;
	embedding: EmbeddingRepairDeps | null;
}

export interface EmbeddingRepairDeps {
	readonly cfg: EmbeddingConfig;
	readonly fetchEmbedding: (text: string, cfg: EmbeddingConfig) => Promise<number[] | null>;
	readonly agentId: string;
	readonly batchSize: number;
}

const AUTONOMOUS_EMBEDDING_BATCH = 20;

async function executeRecommendation(
	rec: RepairRecommendation,
	deps: ExecutionDeps,
	ctx: RepairContext,
): Promise<RepairResult | null> {
	switch (rec.action) {
		case "requeueDeadJobs":
			return await requeueDeadJobs(deps.accessor, deps.cfg, ctx, deps.limiter);
		case "releaseStaleLeases":
			return await releaseStaleLeases(deps.accessor, deps.cfg, ctx, deps.limiter);
		case "checkFtsConsistency":
			return await checkFtsConsistency(deps.accessor, deps.cfg, ctx, deps.limiter, true);
		case "triggerRetentionSweep":
			if (deps.retentionHandle) {
				return await triggerRetentionSweep(deps.cfg, ctx, deps.limiter, deps.retentionHandle);
			}
			return null;
		case "deduplicateMemories":
			return await deduplicateMemories(deps.accessor, deps.cfg, ctx, deps.limiter);
		case "repairEmbeddingIndex": {
			if (deps.embedding === null) return null;
			const embedding = deps.embedding;
			const admission = acquireEmbeddingRepairLease(
				deps.accessor,
				deps.cfg.repair.reembedCooldownMs,
				deps.cfg.repair.reembedHourlyBudget,
			);
			if (!admission.allowed || admission.lease === undefined) {
				return {
					action: rec.action,
					success: false,
					affected: 0,
					message: admission.reason ?? "embedding repair admission denied",
				};
			}
			const lease = admission.lease;

			const finish = (affected: number, error?: string): void => {
				finishEmbeddingRepairLease(deps.accessor, lease, {
					successful: [],
					affected,
					failed: [],
					model: embedding.cfg.model,
					pollMs: deps.cfg.embeddingTracker.pollMs,
					eligibility: (db) => isActiveEmbeddingConfig(db, embedding.cfg),
					...(error ? { error } : {}),
				});
			};

			try {
				const stats = await getEmbeddingRepairStats(deps.accessor, embedding.cfg, embedding.agentId);
				const batchSize =
					Number.isFinite(embedding.batchSize) && embedding.batchSize > 0
						? Math.max(1, Math.min(AUTONOMOUS_EMBEDDING_BATCH, Math.floor(embedding.batchSize)))
						: 1;
				const result =
					stats.orphaned > 0
						? await cleanOrphanedEmbeddings(deps.accessor, deps.cfg, ctx, deps.limiter, batchSize, embedding.agentId)
						: stats.gap.unembedded > 0
							? await reembedMissingMemories(
									deps.accessor,
									deps.cfg,
									ctx,
									deps.limiter,
									embedding.fetchEmbedding,
									embedding.cfg,
									batchSize,
									false,
									false,
									undefined,
									embedding.agentId,
								)
							: await reembedModelMigration(
									deps.accessor,
									deps.cfg,
									ctx,
									deps.limiter,
									embedding.fetchEmbedding,
									embedding.cfg,
									embedding.agentId,
									batchSize,
								);
				finish(result.affected, result.success ? undefined : result.message);
				return {
					action: rec.action,
					success: result.success,
					affected: result.affected,
					message: `${result.action}: ${result.message}`,
					details: { delegatedAction: result.action, ...(result.details ?? {}) },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				finish(0, message);
				return { action: rec.action, success: false, affected: 0, message };
			}
		}
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Halt tracking — stop repeating ineffective repairs
// ---------------------------------------------------------------------------

const MAX_INEFFECTIVE_RUNS = 3;

function createHaltTracker(): {
	shouldHalt(action: string): boolean;
	recordResult(action: string, improved: boolean): void;
	reset(): void;
} {
	const consecutive = new Map<string, number>();

	return {
		shouldHalt(action: string): boolean {
			return (consecutive.get(action) ?? 0) >= MAX_INEFFECTIVE_RUNS;
		},
		recordResult(action: string, improved: boolean): void {
			if (improved) {
				consecutive.delete(action);
			} else {
				consecutive.set(action, (consecutive.get(action) ?? 0) + 1);
			}
		},
		reset(): void {
			consecutive.clear();
		},
	};
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export function startMaintenanceWorker(
	accessor: DbAccessor,
	cfg: PipelineV2Config,
	tracker: ProviderTracker,
	retentionHandle: { sweep(): Promise<unknown> } | null,
	embedding?: EmbeddingRepairDeps,
): MaintenanceHandle {
	let running = true;
	let timer: ReturnType<typeof setInterval> | null = null;
	let inFlight: Promise<MaintenanceCycleResult> | null = null;
	const limiter = createRateLimiter();
	const haltTracker = createHaltTracker();

	// cfg is captured by value — changes require a pipeline restart.
	// This is intentional: hot-reloading mid-cycle could violate the
	// rate limiter's assumptions about cooldown/budget windows.
	const deps: ExecutionDeps = {
		accessor,
		cfg,
		limiter,
		retentionHandle,
		embedding: embedding ?? null,
	};

	async function doTick(): Promise<MaintenanceCycleResult> {
		if (isSystemPressureHigh()) {
			const report = await accessor.withReadDbAsync(async (db) => getDiagnostics(db, tracker));
			return { report, recommendations: [], executed: [], feedbackDecayedAspects: 0, feedbackPropagatedAttributes: 0 };
		}
		const report = await accessor.withReadDbAsync(async (db) => getDiagnostics(db, tracker));

		const embeddingStats = deps.embedding
			? await getEmbeddingRepairStats(accessor, deps.embedding.cfg, deps.embedding.agentId)
			: null;
		const recommendations = buildRecommendations(report, embeddingStats);
		const executed: RepairResult[] = [];
		let feedbackDecayedAspects = 0;
		let feedbackPropagatedAttributes = 0;

		if (recommendations.length === 0) {
			haltTracker.reset();
			if (cfg.graph.enabled && cfg.feedback?.enabled) {
				for (const agentId of await getGraphAgentIds(accessor)) {
					if (cfg.feedback.decayEnabled) {
						feedbackDecayedAspects += await decayAspectWeights(accessor, agentId, {
							decayRate: cfg.feedback.decayRate,
							minWeight: cfg.feedback.minAspectWeight,
							staleDays: cfg.feedback.staleDays,
						});
					}
					feedbackPropagatedAttributes += await propagateMemoryStatus(accessor, agentId);
				}
				recordFeedbackTelemetry({
					feedbackDecayedAspects,
					feedbackPropagatedAttributes,
				});
			}
			return {
				report,
				recommendations,
				executed,
				feedbackDecayedAspects,
				feedbackPropagatedAttributes,
			};
		}

		if (cfg.autonomous.maintenanceMode === "observe") {
			logger.info("maintenance", "Recommendations (observe-only)", {
				composite: report.composite.score.toFixed(2),
				recommendations: recommendations.map((r) => r.action),
			});
			return {
				report,
				recommendations,
				executed,
				feedbackDecayedAspects,
				feedbackPropagatedAttributes,
			};
		}

		// Execute mode
		const ctx: RepairContext = {
			reason: "autonomous maintenance",
			actor: "maintenance-worker",
			actorType: "daemon",
		};

		const preScore = report.composite.score;

		for (const rec of recommendations) {
			if (haltTracker.shouldHalt(rec.action)) {
				logger.warn("maintenance", "Halted ineffective repair", {
					action: rec.action,
				});
				continue;
			}

			const result = await executeRecommendation(rec, deps, ctx);
			if (result) {
				executed.push(result);
			}
		}

		// Re-check health to evaluate improvement
		if (executed.length > 0) {
			const postReport = await accessor.withReadDbAsync(async (db) => getDiagnostics(db, tracker));
			const improved = postReport.composite.score > preScore;

			for (const exec of executed) {
				haltTracker.recordResult(exec.action, improved);
			}

			logger.info("maintenance", "Cycle complete", {
				priorScore: preScore.toFixed(2),
				postScore: postReport.composite.score.toFixed(2),
				improved,
				executed: executed.map((r) => r.action),
			});
		}

		if (cfg.graph.enabled && cfg.feedback?.enabled) {
			for (const agentId of await getGraphAgentIds(accessor)) {
				if (cfg.feedback.decayEnabled) {
					feedbackDecayedAspects += await decayAspectWeights(accessor, agentId, {
						decayRate: cfg.feedback.decayRate,
						minWeight: cfg.feedback.minAspectWeight,
						staleDays: cfg.feedback.staleDays,
					});
				}
				feedbackPropagatedAttributes += await propagateMemoryStatus(accessor, agentId);
			}
			recordFeedbackTelemetry({
				feedbackDecayedAspects,
				feedbackPropagatedAttributes,
			});
		}

		// Temporal manifest and MEMORY projection are owned by the direct
		// transcript-to-Dreaming path. No summary condensation worker runs here.

		if (feedbackDecayedAspects > 0 || feedbackPropagatedAttributes > 0) {
			invalidateTraversalCache();
		}

		// Dead memory hygiene: warn when stale/low-confidence memories accumulate.
		// No auto-deletion — use GET /api/repair/dead-memories to review and act.
		try {
			const count = await accessor.withReadDbAsync(
				async (db) =>
					(
						db
							.prepare(
								`SELECT COUNT(*) as n FROM memories
								 WHERE is_deleted = 0 AND importance <= 0.8
								 AND (confidence < ?
								   OR (last_accessed IS NULL AND julianday('now') - julianday(created_at) > ?)
								   OR (last_accessed IS NOT NULL AND julianday('now') - julianday(last_accessed) > ?))`,
							)
							.get(
								DEAD_MEMORY_DEFAULT_CONFIDENCE,
								DEAD_MEMORY_DEFAULT_ACCESS_DAYS,
								DEAD_MEMORY_DEFAULT_ACCESS_DAYS,
							) as { n: number }
					).n,
			);
			if (count > 100) {
				logger.warn("maintenance", "Dead memory count exceeds threshold", {
					count,
					hint: "Review with GET /api/repair/dead-memories and clean up with POST /api/repair/dead-memories/forget",
				});
			}
		} catch {
			// Non-fatal — dead memory scan should never interrupt the maintenance cycle
		}

		// Reclaim free pages from DROP/DELETE/promotion operations (#1139).
		// Only run when the free-page ratio is high and the system is not under pressure.
		try {
			const ratio = await accessor.withReadDbAsync(async (db) => getFreePageRatio(db));
			if (ratio >= 0.2) {
				await accessor.incrementalVacuumAsync?.();
			}
		} catch {
			// Non-fatal — vacuum should never interrupt the maintenance cycle
		}

		return {
			report,
			recommendations,
			executed,
			feedbackDecayedAspects,
			feedbackPropagatedAttributes,
		};
	}

	function tick(): Promise<MaintenanceCycleResult> {
		if (inFlight) {
			logger.info("maintenance", "Cycle skipped; previous cycle still running");
			return inFlight;
		}

		const cycle = doTick();
		inFlight = cycle;
		void cycle.then(
			() => {
				if (inFlight === cycle) inFlight = null;
			},
			() => {
				if (inFlight === cycle) inFlight = null;
			},
		);
		return cycle;
	}

	// Only start the interval if autonomous maintenance is allowed
	if (cfg.autonomous.enabled && !cfg.autonomous.frozen) {
		timer = setInterval(() => {
			if (!running) return;
			tick().catch((e) => {
				logger.warn("maintenance", "Cycle error", {
					error: e instanceof Error ? e.message : String(e),
				});
			});
		}, cfg.autonomous.maintenanceIntervalMs);

		logger.info("maintenance", "Worker started", {
			mode: cfg.autonomous.maintenanceMode,
			intervalMs: cfg.autonomous.maintenanceIntervalMs,
		});
	} else {
		logger.info("maintenance", "Worker skipped (disabled or frozen)");
	}

	return {
		get running() {
			return running;
		},
		stop() {
			running = false;
			if (timer) clearInterval(timer);
			logger.info("maintenance", "Worker stopped");
		},
		tick,
	};
}
