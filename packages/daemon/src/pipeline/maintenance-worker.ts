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
import type { PipelineV2Config } from "../memory-config";
import type { ProviderTracker, DiagnosticsReport } from "../diagnostics";
import { getDiagnostics } from "../diagnostics";
import {
	createRateLimiter,
	requeueDeadJobs,
	releaseStaleLeases,
	checkFtsConsistency,
	triggerRetentionSweep,
	type RateLimiter,
	type RepairContext,
	type RepairResult,
} from "../repair-actions";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MaintenanceHandle {
	stop(): void;
	readonly running: boolean;
	/** Run a single maintenance cycle (for testing) */
	tick(): MaintenanceCycleResult;
}

export interface MaintenanceCycleResult {
	readonly report: DiagnosticsReport;
	readonly recommendations: readonly RepairRecommendation[];
	readonly executed: readonly RepairResult[];
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
): RepairRecommendation[] {
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
			report.storage.totalMemories > 0
				? report.storage.deletedTombstones / report.storage.totalMemories
				: 0;
		if (ratio > 0.3) {
			recs.push({
				domain: "storage",
				action: "triggerRetentionSweep",
				trigger: `tombstone ratio ${(ratio * 100).toFixed(0)}% > 30%`,
			});
		}
	}

	return recs;
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

function executeRecommendation(
	rec: RepairRecommendation,
	deps: ExecutionDeps,
	ctx: RepairContext,
): RepairResult | null {
	switch (rec.action) {
		case "requeueDeadJobs":
			return requeueDeadJobs(deps.accessor, deps.cfg, ctx, deps.limiter);
		case "releaseStaleLeases":
			return releaseStaleLeases(deps.accessor, deps.cfg, ctx, deps.limiter);
		case "checkFtsConsistency":
			return checkFtsConsistency(
				deps.accessor,
				deps.cfg,
				ctx,
				deps.limiter,
				true,
			);
		case "triggerRetentionSweep":
			if (deps.retentionHandle) {
				return triggerRetentionSweep(
					deps.cfg,
					ctx,
					deps.limiter,
					deps.retentionHandle,
				);
			}
			return null;
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

	function doTick(): MaintenanceCycleResult {
		const report = accessor.withReadDb((db) =>
			getDiagnostics(db, tracker),
		);

		const recommendations = buildRecommendations(report);
		const executed: RepairResult[] = [];

		if (recommendations.length === 0) {
			haltTracker.reset();
			return { report, recommendations, executed };
		}

		if (cfg.maintenanceMode === "observe") {
			logger.info("maintenance", "Recommendations (observe-only)", {
				composite: report.composite.score.toFixed(2),
				recommendations: recommendations.map((r) => r.action),
			});
			return { report, recommendations, executed };
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

			const result = executeRecommendation(rec, deps, ctx);
			if (result) {
				executed.push(result);
			}
		}

		// Re-check health to evaluate improvement
		if (executed.length > 0) {
			const postReport = accessor.withReadDb((db) =>
				getDiagnostics(db, tracker),
			);
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

		return { report, recommendations, executed };
	}

	// Only start the interval if autonomous maintenance is allowed
	if (cfg.autonomousEnabled && !cfg.autonomousFrozen) {
		timer = setInterval(() => {
			if (!running) return;
			try {
				doTick();
			} catch (e) {
				logger.warn("maintenance", "Cycle error", {
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}, cfg.maintenanceIntervalMs);

		logger.info("maintenance", "Worker started", {
			mode: cfg.maintenanceMode,
			intervalMs: cfg.maintenanceIntervalMs,
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
