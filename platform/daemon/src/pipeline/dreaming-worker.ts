/**
 * Dreaming worker — periodically checks token threshold and triggers
 * consolidation passes. Manages the dreaming lifecycle as a daemon
 * background task.
 */

import type { DreamingConfig } from "@signetai/core";
import type { DbAccessor } from "../db-accessor";
import { getSynthesisProvider } from "../llm";
import { logger } from "../logger";
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
		agentId?: string,
	): Promise<{ passId: string; applied: number; skipped: number; failed: number; summary: string }>;
	/**
	 * Fire-and-forget trigger: creates the pass record synchronously
	 * (so the passId is returned immediately), then runs the pass in the
	 * background. Callers should poll GET /api/dream/status for completion.
	 * Throws AlreadyRunningError if a pass is already active.
	 */
	triggerAsync(mode: DreamingMode, agentId?: string): string;
	readonly running: boolean;
	readonly activeAgentId: string | null;
	/**
	 * Resolves when the in-flight pass completes (or is null when idle).
	 * Await this (with a timeout) during shutdown before closing the DB.
	 */
	readonly activePass: Promise<unknown> | null;
}

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min

function normalizeAgentId(agentId: string | undefined, fallback: string): string {
	const trimmed = agentId?.trim();
	return trimmed ? trimmed : fallback;
}

export function getDreamingWorkerAgentIds(accessor: DbAccessor, defaultAgentId: string): readonly string[] {
	return accessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT id FROM agents
				 UNION
				 SELECT DISTINCT agent_id AS id FROM dreaming_state
				 UNION
				 SELECT DISTINCT agent_id AS id FROM dreaming_passes
				 UNION
				 SELECT DISTINCT agent_id AS id FROM memories WHERE is_deleted = 0
				 UNION
				 SELECT DISTINCT agent_id AS id FROM session_summaries
				 UNION
				 SELECT DISTINCT agent_id AS id FROM entities`,
			)
			.all() as Array<{ id: string | null }>;
		const ids = new Set<string>([defaultAgentId]);
		for (const row of rows) {
			const id = normalizeAgentId(row.id ?? undefined, "");
			if (id) ids.add(id);
		}
		return [...ids].sort();
	});
}

export function startDreamingWorker(
	accessor: DbAccessor,
	cfg: DreamingConfig,
	agentsDir: string,
	defaultAgentId: string,
): DreamingWorkerHandle {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let active = false;
	let activeAgent: string | null = null;
	let stopped = false;
	let activePassPromise: Promise<unknown> | null = null;

	// Sweep orphaned passes from unclean shutdown: any 'running' record
	// was left by a crash or forced stop — mark it failed
	// so the status API doesn't show a forever-running ghost pass.
	accessor.withWriteTx((db) => {
		const orphaned = db
			.prepare(
				`UPDATE dreaming_passes
				 SET status = 'failed',
				     completed_at = datetime('now'),
				     error = 'Orphaned by daemon restart'
				 WHERE status = 'running'`,
			)
			.run();
		if (orphaned.changes > 0) {
			logger.warn("dreaming-worker", `Swept ${orphaned.changes} orphaned running pass(es) from prior shutdown`);
		}
	});

	async function runPass(
		runAgentId: string,
		mode: DreamingMode,
		existingPassId?: string,
	): Promise<{ passId: string; applied: number; skipped: number; failed: number; summary: string }> {
		if (active) throw new AlreadyRunningError();
		const synth = getSynthesisProvider();
		active = true;
		activeAgent = runAgentId;
		const p = runDreamingPass(accessor, synth.generate.bind(synth), cfg, agentsDir, runAgentId, mode, existingPassId);
		activePassPromise = p;
		try {
			return await p;
		} catch (e) {
			recordDreamingFailure(accessor, runAgentId);
			throw e;
		} finally {
			active = false;
			activeAgent = null;
			activePassPromise = null;
		}
	}

	async function check(): Promise<void> {
		if (stopped || active) return;

		for (const runAgentId of getDreamingWorkerAgentIds(accessor, defaultAgentId)) {
			if (stopped || active) return;
			try {
				const state = getDreamingState(accessor, runAgentId);
				const isFirst = state.lastPassAt === null && cfg.backfillOnFirstRun;
				const mode: DreamingMode = isFirst ? "compact" : "incremental";

				if (!shouldTriggerDreaming(accessor, cfg, runAgentId)) continue;

				logger.info("dreaming-worker", "Token threshold reached, starting dreaming pass", {
					agentId: runAgentId,
					tokens: state.tokensSinceLastPass,
					threshold: cfg.tokenThreshold,
					mode,
				});

				await runPass(runAgentId, mode);
			} catch (e) {
				if (e instanceof AlreadyRunningError) return;
				logger.error("dreaming-worker", "Dreaming check failed", undefined, {
					agentId: runAgentId,
					error: e instanceof Error ? e.message : String(e),
				});
			}
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

		trigger(mode: DreamingMode, agentId?: string) {
			return runPass(normalizeAgentId(agentId, defaultAgentId), mode);
		},

		triggerAsync(mode: DreamingMode, agentId?: string): string {
			if (active) throw new AlreadyRunningError();
			const runAgentId = normalizeAgentId(agentId, defaultAgentId);
			const synth = getSynthesisProvider();
			const passId = createDreamingPass(accessor, runAgentId, mode);
			active = true;
			activeAgent = runAgentId;
			const p = runDreamingPass(accessor, synth.generate.bind(synth), cfg, agentsDir, runAgentId, mode, passId);
			activePassPromise = p;
			p.catch((e) => {
				recordDreamingFailure(accessor, runAgentId);
				logger.error("dreaming-worker", "Async trigger failed", undefined, {
					agentId: runAgentId,
					passId,
					error: e instanceof Error ? e.message : String(e),
				});
			}).finally(() => {
				active = false;
				activeAgent = null;
				activePassPromise = null;
			});
			return passId;
		},

		get running() {
			return active;
		},

		get activeAgentId() {
			return activeAgent;
		},

		get activePass() {
			return activePassPromise;
		},
	};
}
