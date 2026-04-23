/**
 * Dreaming worker — periodically checks token threshold and triggers
 * consolidation passes. Manages the dreaming lifecycle as a daemon
 * background task.
 */

import type { DreamingConfig } from "@signet/core";
import type { DbAccessor } from "../db-accessor";
import { logger } from "../logger";
import { getSynthesisProvider } from "../llm";
import {
	type DreamingMode,
	createDreamingPass,
	getDreamingState,
	recordDreamingFailure,
	runDreamingPass,
	shouldTriggerDreaming,
} from "./dreaming";

/** Thrown when a trigger is attempted while a pass is already in-flight. */
export class AlreadyRunningError extends Error {
	constructor() {
		super("A dreaming pass is already running");
		this.name = "AlreadyRunningError";
	}
}

export interface DreamingWorkerHandle {
	stop(): void;
	/** Force-trigger a pass synchronously (CLI / testing). */
	trigger(
		mode: DreamingMode,
	): Promise<{ passId: string; applied: number; skipped: number; failed: number; summary: string }>;
	/**
	 * Fire-and-forget trigger: creates the pass record synchronously
	 * (so the passId is returned immediately), then runs the pass in the
	 * background. Callers should poll GET /api/dream/status for completion.
	 * Throws AlreadyRunningError if a pass is already active.
	 */
	triggerAsync(mode: DreamingMode): string;
	readonly running: boolean;
	/**
	 * Resolves when the in-flight pass completes (or is null when idle).
	 * Await this (with a timeout) during shutdown before closing the DB.
	 */
	readonly activePass: Promise<unknown> | null;
}

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min

export function startDreamingWorker(
	accessor: DbAccessor,
	cfg: DreamingConfig,
	agentsDir: string,
	agentId: string,
): DreamingWorkerHandle {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let active = false;
	let stopped = false;
	let activePassPromise: Promise<unknown> | null = null;

	// Sweep orphaned passes from unclean shutdown: any 'running' record
	// for this agent was left by a crash or forced stop — mark it failed
	// so the status API doesn't show a forever-running ghost pass.
	accessor.withWriteTx((db) => {
		const orphaned = db
			.prepare(
				`UPDATE dreaming_passes
				 SET status = 'failed',
				     completed_at = datetime('now'),
				     error = 'Orphaned by daemon restart'
				 WHERE agent_id = ? AND status = 'running'`,
			)
			.run(agentId);
		if (orphaned.changes > 0) {
			logger.warn("dreaming-worker", `Swept ${orphaned.changes} orphaned running pass(es) from prior shutdown`);
		}
	});

	async function check(): Promise<void> {
		if (stopped || active) return;

		try {
			const state = getDreamingState(accessor, agentId);
			const isFirst = state.lastPassAt === null && cfg.backfillOnFirstRun;
			const mode: DreamingMode = isFirst ? "compact" : "incremental";

			if (!shouldTriggerDreaming(accessor, cfg, agentId)) return;

			logger.info("dreaming-worker", "Token threshold reached, starting dreaming pass", {
				tokens: state.tokensSinceLastPass,
				threshold: cfg.tokenThreshold,
				mode,
			});

			active = true;
			const synth = getSynthesisProvider();
			const p = runDreamingPass(accessor, synth.generate.bind(synth), cfg, agentsDir, agentId, mode);
			activePassPromise = p;
			await p;
		} catch (e) {
			recordDreamingFailure(accessor, agentId);
			logger.error("dreaming-worker", "Dreaming check failed", undefined, {
				error: e instanceof Error ? e.message : String(e),
			});
		} finally {
			active = false;
			activePassPromise = null;
		}
	}

	function schedule(): void {
		if (stopped) return;
		timer = setTimeout(async () => {
			await check();
			schedule();
		}, CHECK_INTERVAL_MS);
	}

	// Start the periodic check
	schedule();

	logger.info("dreaming-worker", "Dreaming worker started", {
		threshold: cfg.tokenThreshold,
	});

	return {
		// Cancels the timer but does NOT await an in-flight pass.
		// An active pass will complete (or fail) asynchronously; the
		// `stopped` flag prevents new passes from being scheduled.
		stop() {
			stopped = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		},

		async trigger(mode: DreamingMode) {
			if (active) throw new AlreadyRunningError();
			active = true;
			const synth = getSynthesisProvider();
			const p = runDreamingPass(accessor, synth.generate.bind(synth), cfg, agentsDir, agentId, mode);
			activePassPromise = p;
			try {
				return await p;
			} catch (e) {
				recordDreamingFailure(accessor, agentId);
				throw e;
			} finally {
				active = false;
				activePassPromise = null;
			}
		},

		triggerAsync(mode: DreamingMode): string {
			if (active) throw new AlreadyRunningError();
			const passId = createDreamingPass(accessor, agentId, mode);
			active = true;
			const synth = getSynthesisProvider();
			const p = runDreamingPass(accessor, synth.generate.bind(synth), cfg, agentsDir, agentId, mode, passId);
			activePassPromise = p;
			p.catch((e) => {
				recordDreamingFailure(accessor, agentId);
			logger.error("dreaming-worker", "Async trigger failed", undefined, {
				passId,
				error: e instanceof Error ? e.message : String(e),
			});
			}).finally(() => {
				active = false;
				activePassPromise = null;
			});
			return passId;
		},

		get running() {
			return active;
		},

		get activePass() {
			return activePassPromise;
		},
	};
}
