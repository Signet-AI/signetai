/**
 * Autonomous maintenance worker.
 *
 * Periodically runs diagnostics and, when health degrades, invokes
 * the appropriate repair action. Starts in observe-only mode by
 * default; graduates to execute mode via config.
 *
 * Same interval/stop pattern as the retention worker.
 */

import type { DbAccessor } from "../db-accessor";
import type { DiagnosticsReport, ProviderTracker } from "../diagnostics";
import { getDiagnostics } from "../diagnostics";
import { propagateMemoryStatus } from "../knowledge-graph";
import { getLlmProvider } from "../llm";
import { logger } from "../logger";
import type { PipelineV2Config } from "../memory-config";
import {
	type RateLimiter,
	DEAD_MEMORY_DEFAULT_ACCESS_DAYS,
	DEAD_MEMORY_DEFAULT_CONFIDENCE,
	type RepairContext,
	type RepairResult,
	checkFtsConsistency,
	createRateLimiter,
	deduplicateMemories,
	releaseStaleLeases,
	requeueDeadJobs,
	triggerRetentionSweep,
} from "../repair-actions";
import { decayAspectWeights, recordFeedbackTelemetry } from "./aspect-feedback";
import { invalidateTraversalCache } from "./graph-traversal";
import { checkAndCondense } from "./summary-condensation";

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

function buildRecommendations(report: DiagnosticsReport): RepairRecommendation[] {
	const recs: RepairRecommendation[] = [];

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
			trigger: `FTS mismatch: ${report.index.memoriesRowCount} active vs ${report.index.ftsRowCount} FTS`,
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

function getGraphAgentIds(accessor: DbAccessor): readonly string[] {
	return accessor.withReadDb((db) => {
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
	retentionHandle: { sweep(): unknown } | null;
}

async function executeRecommendation(
	rec: RepairRecommendation,
	deps: ExecutionDeps,
	ctx: RepairContext,
): Promise<RepairResult | null> {
	switch (rec.action) {
		case "requeueDeadJobs":
			return requeueDeadJobs(deps.accessor, deps.cfg, ctx, deps.limiter);
		case "releaseStaleLeases":
			return releaseStaleLeases(deps.accessor, deps.cfg, ctx, deps.limiter);
		case "checkFtsConsistency":
			return checkFtsConsistency(deps.accessor, deps.cfg, ctx, deps.limiter, true);
		case "triggerRetentionSweep":
			if (deps.retentionHandle) {
				return triggerRetentionSweep(deps.cfg, ctx, deps.limiter, deps.retentionHandle);
			}
			return null;
		case "deduplicateMemories":
			return deduplicateMemories(deps.accessor, deps.cfg, ctx, deps.limiter);
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
	retentionHandle: { sweep(): unknown } | null,
): MaintenanceHandle {
	let running = true;
	let timer: ReturnType<typeof setInterval> | null = null;
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
	};

	async function doTick(): Promise<MaintenanceCycleResult> {
		const report = accessor.withReadDb((db) => getDiagnostics(db, tracker));

		const recommendations = buildRecommendations(report);
		const executed: RepairResult[] = [];
		let feedbackDecayedAspects = 0;
		let feedbackPropagatedAttributes = 0;

		if (recommendations.length === 0) {
			haltTracker.reset();
			if (cfg.graph.enabled && cfg.feedback?.enabled) {
				for (const agentId of getGraphAgentIds(accessor)) {
					if (cfg.feedback.decayEnabled) {
						feedbackDecayedAspects += decayAspectWeights(accessor, agentId, {
							decayRate: cfg.feedback.decayRate,
							minWeight: cfg.feedback.minAspectWeight,
							staleDays: cfg.feedback.staleDays,
						});
					}
					feedbackPropagatedAttributes += propagateMemoryStatus(accessor, agentId);

					// Retroactive supersession sweep — runs regardless of maintenance health
					if (cfg.structural.supersessionSweepEnabled) {
						const { sweepRetroactiveSupersession } = await import("./supersession");
						const sweep = await sweepRetroactiveSupersession(accessor, agentId, cfg, getLlmProvider());
						if (sweep.candidates.length > 0) {
							logger.info("maintenance", "Supersession sweep", {
								agentId,
								superseded: sweep.superseded,
								proposals: sweep.candidates.length,
							});
						}
					}
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
			const postReport = accessor.withReadDb((db) => getDiagnostics(db, tracker));
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
			for (const agentId of getGraphAgentIds(accessor)) {
				if (cfg.feedback.decayEnabled) {
					feedbackDecayedAspects += decayAspectWeights(accessor, agentId, {
						decayRate: cfg.feedback.decayRate,
						minWeight: cfg.feedback.minAspectWeight,
						staleDays: cfg.feedback.staleDays,
					});
				}
				feedbackPropagatedAttributes += propagateMemoryStatus(accessor, agentId);

				// Retroactive supersession sweep
				if (cfg.structural.supersessionSweepEnabled) {
					const { sweepRetroactiveSupersession } = await import("./supersession");
					const provider = getLlmProvider();
					const sweep = await sweepRetroactiveSupersession(accessor, agentId, cfg, provider);
					if (sweep.candidates.length > 0) {
						logger.info("maintenance", "Supersession sweep", {
							agentId,
							superseded: sweep.superseded,
							proposals: sweep.candidates.length,
						});
					}
				}
			}
			recordFeedbackTelemetry({
				feedbackDecayedAspects,
				feedbackPropagatedAttributes,
			});
		}

		// Check for summary condensation opportunities (session -> arc -> epoch)
		try {
			const tableRow = accessor.withReadDb((db) =>
				db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'`).get(),
			);

			if (tableRow) {
				const projects = accessor.withReadDb(
					(db) =>
						db
							.prepare(
								`SELECT DISTINCT project FROM session_summaries
							 WHERE kind = 'session' AND project IS NOT NULL`,
							)
							.all() as Array<{ project: string }>,
				);

				// Limit to 1 condensation per maintenance tick to avoid
				// blocking the maintenance loop with O(n) LLM calls.
				const provider = getLlmProvider();
				for (const { project } of projects.slice(0, 1)) {
					await checkAndCondense(accessor, provider, project, "default");
				}
			}
		} catch (e) {
			logger.warn("maintenance", "Summary condensation check failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		}

		if (feedbackDecayedAspects > 0 || feedbackPropagatedAttributes > 0) {
			invalidateTraversalCache();
		}

		// Dead memory hygiene: warn when stale/low-confidence memories accumulate.
		// No auto-deletion — use GET /api/repair/dead-memories to review and act.
		try {
			const count = accessor.withReadDb(
				(db) =>
					(
						db
							.prepare(
								`SELECT COUNT(*) as n FROM memories
								 WHERE is_deleted = 0 AND importance <= 0.8
								 AND (confidence < ?
								   OR (last_accessed IS NULL AND julianday('now') - julianday(created_at) > ?)
								   OR (last_accessed IS NOT NULL AND julianday('now') - julianday(last_accessed) > ?))`,
							)
							.get(DEAD_MEMORY_DEFAULT_CONFIDENCE, DEAD_MEMORY_DEFAULT_ACCESS_DAYS, DEAD_MEMORY_DEFAULT_ACCESS_DAYS) as { n: number }
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

		return {
			report,
			recommendations,
			executed,
			feedbackDecayedAspects,
			feedbackPropagatedAttributes,
		};
	}

	// Only start the interval if autonomous maintenance is allowed
	if (cfg.autonomous.enabled && !cfg.autonomous.frozen) {
		timer = setInterval(() => {
			if (!running) return;
			doTick().catch((e) => {
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
		tick: doTick,
	};
}
