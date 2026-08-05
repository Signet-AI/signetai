/**
 * Dreaming worker — periodically checks token threshold and triggers
 * consolidation passes. Manages the dreaming lifecycle as a daemon
 * background task.
 */

import type { DreamingConfig } from "@signet/core";
import type { DbAccessor } from "../db-accessor";
import { getQueueHealth } from "../diagnostics";
import { getOrCreateInferenceRouter } from "../inference-router";
import { logger } from "../logger";
import { isSystemPressureHigh } from "../system-pressure";
import {
	type DreamingAgentExecutor,
	type DreamingMode,
	createDreamingPass,
	enqueueDreamingHygieneAttention,
	getDreamingEpisodicTokenBacklog,
	isDreamingHaltActive,
	recordDreamingFailure,
	runDreamingAgentPass,
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

export interface DreamingWorkerOptions {
	/** Test seam; production always uses the configured inference router. */
	readonly executorFactory?: (agentId: string) => DreamingAgentExecutor;
	/** Scoped connection details for ACPX's temporary MCP server. */
	readonly acpxMcp?: {
		readonly daemonUrl: string;
		readonly authorizationTokenForAgent?: (agentId: string) => string | undefined;
	};
}

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const AGENT_SCOPE_SNAPSHOT_REFRESH_MS = 30 * 60 * 1000; // 30 min

/** Dreaming is deferrable work. Yield an entire sweep while live queues are under pressure. */
export function shouldDeferDreamingSweep(accessor: DbAccessor): boolean {
	return accessor.withReadDb((db) => getQueueHealth(db).status !== "healthy");
}

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
				 SELECT DISTINCT agent_id AS id FROM memory_artifacts WHERE is_deleted = 0
				 UNION
				 SELECT DISTINCT agent_id AS id FROM session_transcripts
				 UNION
				 SELECT DISTINCT agent_id AS id FROM dreaming_attention WHERE resolved_at IS NULL
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

/**
 * Bounded agent-scope discovery: resolves the union query on a refresh
 * cadence and serves the snapshot between refreshes. Periodic dreaming is
 * deferrable, so a stale list only delays work for a brand-new scope by one
 * refresh window instead of re-running the 9-table union on every sweep
 * (#1059).
 */
export function createAgentScopeSnapshot(
	refreshMs: number,
	resolve: () => readonly string[],
	now: () => number = Date.now,
): () => readonly string[] {
	let snapshot: readonly string[] | null = null;
	let at = 0;
	return () => {
		const t = now();
		if (snapshot === null || t - at >= refreshMs) {
			snapshot = resolve();
			at = t;
		}
		return snapshot;
	};
}

export function startDreamingWorker(
	accessor: DbAccessor,
	cfg: DreamingConfig,
	agentsDir: string,
	defaultAgentId: string,
	options: DreamingWorkerOptions = {},
): DreamingWorkerHandle {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let active = false;
	let activeAgent: string | null = null;
	let stopped = false;
	let activePassPromise: Promise<unknown> | null = null;
	const getAgentScopes = createAgentScopeSnapshot(AGENT_SCOPE_SNAPSHOT_REFRESH_MS, () =>
		getDreamingWorkerAgentIds(accessor, defaultAgentId),
	);
	const executorForAgent = (agentId: string): DreamingAgentExecutor => {
		const factory = options.executorFactory;
		if (factory) return factory(agentId);
		// getOrCreateInferenceRouter is a singleton accessor; resolving here
		// (instead of a nullable eager handle) keeps the closure free of
		// non-null assertions.
		const router = getOrCreateInferenceRouter(agentsDir);
		return {
			async run(input) {
				const result = await router.runAgent(
					{
						agentId,
						operation: "memory_extraction",
						promptPreview: input.prompt.slice(0, 8000),
					},
					input.prompt,
					input.tools,
					{
						timeoutMs: input.timeoutMs,
						maxTokens: input.maxTokens,
						...(options.acpxMcp
							? {
									acpxMcp: {
										agentId,
										passId: input.passId,
										daemonUrl: options.acpxMcp.daemonUrl,
										authorizationToken: options.acpxMcp.authorizationTokenForAgent?.(agentId),
									},
								}
							: {}),
					},
				);
				if (!result.ok) {
					const attempts = Array.isArray(result.error.details?.attempts)
						? result.error.details.attempts
								.map((attempt) => {
									if (!attempt || typeof attempt !== "object") return "unknown target";
									const value = attempt as { targetRef?: unknown; error?: unknown };
									return `${typeof value.targetRef === "string" ? value.targetRef : "unknown"}: ${typeof value.error === "string" ? value.error : "failed"}`;
								})
								.join("; ")
						: "";
					throw new Error(attempts ? `${result.error.message} (${attempts})` : result.error.message);
				}
				return { summary: `Dreaming agent completed through ${result.value.decision.targetRef}` };
			},
		};
	};

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
		scopes?: readonly string[],
	): Promise<{ passId: string; applied: number; skipped: number; failed: number; summary: string }> {
		if (active) throw new AlreadyRunningError();
		active = true;
		activeAgent = runAgentId;
		// Periodic sweeps pass their snapshot through; explicit triggers and
		// CLI passes resolve fresh so operator intent is never stale.
		const passScopes = scopes ?? getDreamingWorkerAgentIds(accessor, defaultAgentId);
		const p = runDreamingAgentPass(
			accessor,
			executorForAgent(runAgentId),
			cfg,
			agentsDir,
			runAgentId,
			passScopes,
			mode,
			existingPassId,
		);
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
		if (isSystemPressureHigh()) return;
		if (shouldDeferDreamingSweep(accessor)) {
			logger.info("dreaming-worker", "Deferring dreaming sweep while queues are under pressure");
			return;
		}

		// One Dreaming universe: a single pass covers every agent scope. The
		// sweep runs one pass when any scope has attention or a backlog; the
		// pass itself addresses scopes via the per-call agentId on its tools.
		const scopes = getAgentScopes();
		let triggered = false;
		for (const scopeId of scopes) {
			if (stopped || active) return;
			// A halted scope must not burn the 6-query hygiene scan and the
			// episodic backlog read on every sweep: skip straight past it.
			if (isDreamingHaltActive(accessor, scopeId)) continue;
			try {
				enqueueDreamingHygieneAttention(accessor, scopeId);
				const episodicTokens = getDreamingEpisodicTokenBacklog(accessor, scopeId);
				if (!shouldTriggerDreaming(accessor, cfg, scopeId, Date.now(), episodicTokens)) continue;
				triggered = true;
				logger.info("dreaming-worker", "Episodic evidence threshold reached, starting dreaming pass", {
					scopeId,
					episodicTokens,
					threshold: cfg.tokenThreshold,
				});
				break;
			} catch (e) {
				if (e instanceof AlreadyRunningError) return;
				logger.error("dreaming-worker", "Dreaming scope check failed", undefined, {
					agentId: scopeId,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
		if (!triggered) return;
		await runPass(defaultAgentId, "incremental", undefined, scopes);
	}

	function schedule(): void {
		if (stopped) return;
		timer = setTimeout(async () => {
			await check();
			schedule();
		}, CHECK_INTERVAL_MS);
	}

	// Start the periodic check. Hygiene attention is enqueued during regular
	// check() ticks, NOT here — the hygiene scan does 6 SQL queries per agent
	// that can take minutes on large graphs (30k entities = 2s/query on cold
	// cache). Running it at startup blocks the event loop before the HTTP
	// server binds, making the daemon appear to fail to start.
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
			const passId = createDreamingPass(accessor, runAgentId, mode);
			active = true;
			activeAgent = runAgentId;
			const p = runDreamingAgentPass(
				accessor,
				executorForAgent(runAgentId),
				cfg,
				agentsDir,
				runAgentId,
				getDreamingWorkerAgentIds(accessor, defaultAgentId),
				mode,
				passId,
			);
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
