/**
 * Daemon ingest runner (#913) — the in-process Dreaming executor.
 *
 * Wires the three shared phases into the daemon worker loop:
 *   lease/context (acquireIngestLease + buildIngestContext)
 *   -> plan (planIngest, one consolidated provider call over the #918 broker)
 *   -> validate/apply (applyIngestPlan, deterministic guards + writes + CAS complete)
 *
 * On each tick the runner drains eligible `ingest` jobs for its agent until none
 * remain, then sleeps. It is the daemon counterpart to the agentic runner (which
 * leases via /api/ingest/lease, reasons in its own harness turn, and posts the
 * plan to /api/ingest/apply-plan). Both consume the exact same primitives.
 *
 * Additive: started only when the operator opts in (enabled flag from config).
 * The legacy extraction worker still runs alongside on the branch; the cutover
 * PR (Phase 6) removes it so only one path ships to main.
 */

import type { DbAccessor } from "../../db-accessor";
import { logger } from "../../logger";
import type { LlmProvider } from "../provider";
import { applyIngestPlan, type IngestApplyConfig, type IngestEmbedder } from "./apply";
import { buildIngestContext } from "./context";
import { acquireIngestLease, failIngestJob } from "./lease";
import { planIngest } from "./planner";

export interface IngestWorkerOptions {
	readonly accessor: DbAccessor;
	readonly provider: LlmProvider;
	readonly embedder: IngestEmbedder;
	readonly agentsDir: string;
	readonly agentId: string;
	readonly enabled: boolean;
	/** Per-apply source attribution. sourceId is stamped per-job from the lease. */
	readonly applyConfig: Omit<IngestApplyConfig, "sourceId">;
	readonly leaseTimeoutMs: number;
	readonly model?: string;
	readonly contextWindow?: number;
	readonly contextBudgetPct?: number;
	readonly tickIntervalMs?: number;
	readonly maxAttempts?: number;
	/** Runtime abort (pause/cancel propagates to the provider call). */
	readonly signal?: AbortSignal;
}

export interface IngestWorkerStats {
	readonly ticks: number;
	readonly processed: number;
	readonly failed: number;
	readonly lastProgressAt: number | null;
}

export interface IngestWorkerHandle {
	readonly running: boolean;
	readonly stats: IngestWorkerStats;
	/** Force the next tick immediately. */
	nudge(): void;
	stop(): Promise<void>;
}

export function startIngestWorker(opts: IngestWorkerOptions): IngestWorkerHandle {
	const intervalMs = opts.tickIntervalMs ?? 5_000;
	const maxAttempts = opts.maxAttempts ?? 5;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let nudged = false;
	const stats = { ticks: 0, processed: 0, failed: 0, lastProgressAt: null as number | null };

	const scheduleNext = (): void => {
		if (stopped) return;
		const delay = nudged ? 0 : intervalMs;
		nudged = false;
		timer = setTimeout(() => void tick(), delay);
	};

	const tick = async (): Promise<void> => {
		if (stopped || opts.signal?.aborted) {
			scheduleNext();
			return;
		}
		stats.ticks++;
		try {
			let didWork = false;
			for (;;) {
				if (stopped || opts.signal?.aborted) break;
				const lease = opts.accessor.withWriteTx((db) =>
					acquireIngestLease(db, {
						agentId: opts.agentId,
						owner: `ingest-runner:${process.pid}`,
						leaseTimeoutMs: opts.leaseTimeoutMs,
						maxAttempts,
					}),
				);
				if (!lease.ok) break; // nothing eligible this tick
				didWork = true;
				const job = lease.job;

				const ctx = opts.accessor.withReadDb((db) =>
					buildIngestContext(db, {
						job,
						agentId: opts.agentId,
						agentsDir: opts.agentsDir,
						contextWindow: opts.contextWindow,
						contextBudgetPct: opts.contextBudgetPct,
					}),
				);

				// Oversize: the source alone exceeds the budget. Fail explicitly
				// (retry-safe: a deterministic oversize dead-letters after the
				// attempt ceiling rather than spinning). A future refinement splits
				// at a safe boundary instead of failing.
				if (ctx.oversize) {
					opts.accessor.withWriteTx((db) =>
						failIngestJob(db, job.id, lease.leaseToken, "source exceeds context budget", maxAttempts),
					);
					stats.failed++;
					continue;
				}

				const planned = await planIngest(ctx, {
					provider: opts.provider,
					model: opts.model,
					signal: opts.signal,
				});
				if (!planned.ok) {
					opts.accessor.withWriteTx((db) =>
						failIngestJob(db, job.id, lease.leaseToken, `planner ${planned.reason}: ${planned.message}`, maxAttempts),
					);
					stats.failed++;
					continue;
				}

				const applied = await applyIngestPlan(
					opts.accessor,
					planned.plan,
					lease.leaseToken,
					{ ...opts.applyConfig, sourceId: job.id },
					opts.embedder,
				);
				if (applied.completed) {
					stats.processed++;
				} else {
					// apply did not complete the lease (e.g. a re-apply that lost the
					// CAS, or a partial failure). Fail for retry.
					opts.accessor.withWriteTx((db) =>
						failIngestJob(db, job.id, lease.leaseToken, "apply did not complete the lease", maxAttempts),
					);
					stats.failed++;
				}
			}
			if (didWork) stats.lastProgressAt = Date.now();
		} catch (err) {
			logger.warn("pipeline", "ingest runner tick failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			scheduleNext();
		}
	};

	if (opts.enabled) {
		logger.info("pipeline", "Ingest worker starting (Dreaming, 24/7)", { agentId: opts.agentId });
		scheduleNext();
	} else {
		logger.info("pipeline", "Ingest worker disabled (agentic dreaming on cron instead)");
	}

	return {
		get running(): boolean {
			return !stopped && opts.enabled;
		},
		get stats(): IngestWorkerStats {
			return { ...stats };
		},
		nudge(): void {
			nudged = true;
			if (timer) clearTimeout(timer);
			scheduleNext();
		},
		async stop(): Promise<void> {
			stopped = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		},
	};
}
