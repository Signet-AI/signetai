import type { DreamingConfig } from "@signet/core";
import type { DbAccessor } from "../db-accessor";
import type { DbOwnerMaintenance } from "../db-owner-maintenance";
import { ownerQueryAll, ownerQueryOne } from "../db-owner-maintenance";
import { getQueueHealth } from "../diagnostics";
import { getOrCreateInferenceRouter } from "../inference-router";
import type { GraphHygieneCaps } from "../knowledge-graph-hygiene";
import { logger } from "../logger";
import { isSystemPressureHigh } from "../system-pressure";
import {
	type DreamingAgentExecutor,
	type DreamingMode,
	type DreamingPassFocus,
	createDreamingPass,
	createDreamingPassThroughOwner,
	dreamingFocusOfMode,
	enqueueDreamingHygieneAttention,
	enqueueDreamingSurprisalAttention,
	evaluateDreamingTrigger,
	hasDreamingEpisodicBacklog,
	isDreamingHaltActive,
	probeDreamingEpisodicBacklog,
	recordDreamingFailure,
	runDreamingAgentPass,
	selectDreamingPassMode,
	type DreamingEpisodicBacklogProbe,
	type DreamingTriggerDecision,
} from "./dreaming";
import { DREAMING_CONTENT_ATTENTION_KINDS, hasDreamingAttentionKindInDb } from "./dreaming-attention";
import { type DreamingEvidenceRetryPolicy, autoRequeueRepairedDreamingEvidence } from "./dreaming-evidence-retry";
export class AlreadyRunningError extends Error {
	constructor() {
		super("A dreaming pass is already running");
		this.name = "AlreadyRunningError";
	}
}

export interface DreamingWorkerHandle {
	stop(): void;
	trigger(
		mode: DreamingMode,
		agentId?: string,
	): Promise<{ passId: string; applied: number; skipped: number; failed: number; summary: string }>;
	triggerAsync(mode: DreamingMode, agentId?: string): Promise<string>;
	readonly running: boolean;
	readonly activeAgentId: string | null;
	readonly activePass: Promise<unknown> | null;
	readonly scheduler: DreamingSchedulerStatus;
}
export interface DreamingSchedulerStatus {
	readonly status: "idle" | "deferred";
	readonly reason: "queue_pressure" | "system_pressure" | null;
	readonly checkedAt: string | null;
}

function scheduledTriggerLogData(
	scopeId: string,
	decision: Extract<DreamingTriggerDecision, { readonly trigger: true }>,
	probe: DreamingEpisodicBacklogProbe,
	threshold: number,
): Record<string, unknown> {
	const common = {
		scopeId,
		reason: decision.reason,
		threshold,
		hasBacklog: probe.hasBacklog,
		countComplete: probe.kind === "exact",
		sourcesScanned: probe.sourcesScanned,
	};
	return probe.kind === "exact"
		? { ...common, episodicTokens: probe.tokens }
		: { ...common, tokenLowerBound: probe.tokenLowerBound };
}

export function _testDreamingTriggerLogData(
	scopeId: string,
	decision: Extract<DreamingTriggerDecision, { readonly trigger: true }>,
	probe: DreamingEpisodicBacklogProbe,
	threshold: number,
): Record<string, unknown> {
	return scheduledTriggerLogData(scopeId, decision, probe, threshold);
}

export interface DreamingWorkerOptions {
	readonly executorFactory?: (agentId: string) => DreamingAgentExecutor;
	readonly checkIntervalMs?: number;
	readonly acpxMcp?: {
		readonly daemonUrl: string;
		readonly authorizationTokenForAgent?: (agentId: string) => string | undefined;
	};
	readonly evidenceRetry?: DreamingEvidenceRetryPolicy;
	readonly ownerMaintenance?: DbOwnerMaintenance;
}

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const AGENT_SCOPE_SNAPSHOT_REFRESH_MS = 30 * 60 * 1000;
export async function shouldDeferDreamingSweep(
	accessor: DbAccessor,
	ownerMaintenance?: DbOwnerMaintenance,
): Promise<boolean> {
	if (ownerMaintenance) return !(await ownerMaintenance.queueIsHealthy());
	return await accessor.withReadDbAsync((db) => getQueueHealth(db).status !== "healthy", {
		siteToken: "pipeline/dreaming-worker.ts:102",
		operation: "dreaming.worker.queue-health",
	});
}

export async function shouldDeferDreamingSweepAsync(
	accessor: DbAccessor,
	ownerMaintenance?: DbOwnerMaintenance,
): Promise<boolean> {
	return await shouldDeferDreamingSweep(accessor, ownerMaintenance);
}

function normalizeAgentId(agentId: string | undefined, fallback: string): string {
	const trimmed = agentId?.trim();
	return trimmed ? trimmed : fallback;
}

export async function getDreamingWorkerAgentIds(
	accessor: DbAccessor,
	defaultAgentId: string,
	ownerMaintenance?: DbOwnerMaintenance,
): Promise<readonly string[]> {
	const sql = `SELECT id AS id FROM agents
	 UNION ALL
	 SELECT DISTINCT agent_id AS id FROM dreaming_state
	 UNION ALL
	 SELECT DISTINCT agent_id AS id FROM dreaming_passes
	 UNION ALL
	 SELECT DISTINCT agent_id AS id FROM memories WHERE is_deleted = 0
	 UNION ALL
	 SELECT DISTINCT agent_id AS id FROM session_summaries
	 UNION ALL
	 SELECT DISTINCT agent_id AS id FROM memory_artifacts WHERE is_deleted = 0
	 UNION ALL
	 SELECT DISTINCT agent_id AS id FROM session_transcripts
	 UNION ALL
	 SELECT DISTINCT agent_id AS id FROM dreaming_attention WHERE resolved_at IS NULL
	 UNION ALL
	 SELECT DISTINCT agent_id AS id FROM dreaming_evidence_exclusions WHERE resolved_at IS NULL
	 UNION ALL
	 SELECT DISTINCT agent_id AS id FROM entities`;
	const rows = ownerMaintenance?.owner
		? await ownerQueryAll<{ id: string | null }>(ownerMaintenance.owner, "pipeline/dreaming-worker.agent-scopes", sql)
		: await accessor.withReadDbAsync(
				(db) => {
					return db.prepare(sql).all() as Array<{ id: string | null }>;
				},
				{ siteToken: "pipeline/dreaming-worker.ts:146", operation: "dreaming.worker.agent-scopes" },
			);
	const ids = new Set<string>([defaultAgentId]);
	for (const row of rows) {
		const id = normalizeAgentId(row.id ?? undefined, "");
		if (id) ids.add(id);
	}
	return [...ids].sort();
}
export function createAgentScopeSnapshot(
	refreshMs: number,
	resolve: () => readonly string[] | Promise<readonly string[]>,
	now: () => number = Date.now,
): () => Promise<readonly string[]> {
	let snapshot: readonly string[] | null = null;
	let at = 0;
	let refresh: Promise<readonly string[]> | null = null;
	return async () => {
		const t = now();
		if (snapshot !== null && t - at < refreshMs) return snapshot;
		if (refresh === null) {
			refresh = Promise.resolve()
				.then(resolve)
				.then((next) => {
					snapshot = next;
					at = now();
					return next;
				})
				.finally(() => {
					refresh = null;
				});
		}
		const pending = refresh;
		return await pending;
	};
}
export async function selectDreamingCheckMode(
	accessor: DbAccessor,
	scopes: readonly string[],
	lastScheduled: DreamingPassFocus | null,
	ownerMaintenance?: DbOwnerMaintenance,
): Promise<DreamingMode> {
	const hasPendingHygieneAttention = (
		await Promise.all(
			scopes.map((scope) =>
				ownerMaintenance?.owner
					? ownerQueryOne<{ present: number }>(
							ownerMaintenance.owner,
							"pipeline/dreaming-worker.hygiene-attention",
							`SELECT 1 AS present FROM dreaming_attention
							 WHERE agent_id = ? AND resolved_at IS NULL AND kind IN (?)
							 LIMIT 1`,
							[scope, "hygiene"],
						).then((row) => row != null)
					: accessor.withReadDbAsync((db) => hasDreamingAttentionKindInDb(db, scope, ["hygiene"]), {
							siteToken: "pipeline/dreaming-worker.ts:204",
							operation: "dreaming.worker.hygiene-attention",
						}),
			),
		)
	).some(Boolean);
	const hasPendingContentAttention = (
		await Promise.all(
			scopes.map((scope) =>
				ownerMaintenance?.owner
					? ownerQueryOne<{ present: number }>(
							ownerMaintenance.owner,
							"pipeline/dreaming-worker.content-attention",
							`SELECT 1 AS present FROM dreaming_attention
							 WHERE agent_id = ? AND resolved_at IS NULL
							 AND kind IN (${DREAMING_CONTENT_ATTENTION_KINDS.map(() => "?").join(", ")})
							 LIMIT 1`,
							[scope, ...DREAMING_CONTENT_ATTENTION_KINDS],
						).then((row) => row != null)
					: accessor.withReadDbAsync(
							(db) => hasDreamingAttentionKindInDb(db, scope, DREAMING_CONTENT_ATTENTION_KINDS),
							{
								siteToken: "pipeline/dreaming-worker.ts:224",
								operation: "dreaming.worker.content-attention",
							},
						),
			),
		)
	).some(Boolean);
	const backlogs = await Promise.all(
		scopes.map((scope) => hasDreamingEpisodicBacklog(accessor, scope, ownerMaintenance)),
	);
	const hasBacklog = backlogs.some(Boolean);
	return selectDreamingPassMode(lastScheduled, hasPendingHygieneAttention, hasBacklog, hasPendingContentAttention);
}

export function startDreamingWorker(
	accessor: DbAccessor,
	cfg: DreamingConfig,
	agentsDir: string,
	defaultAgentId: string,
	options: DreamingWorkerOptions = {},
	caps?: GraphHygieneCaps,
): DreamingWorkerHandle {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let active = false;
	let activeAgent: string | null = null;
	let stopped = false;
	let activePassPromise: Promise<unknown> | null = null;
	let scheduler: DreamingSchedulerStatus = { status: "idle", reason: null, checkedAt: null };
	let nextScheduledFocus: DreamingPassFocus | null = null;
	const getAgentScopes = createAgentScopeSnapshot(AGENT_SCOPE_SNAPSHOT_REFRESH_MS, () =>
		getDreamingWorkerAgentIds(accessor, defaultAgentId, options.ownerMaintenance),
	);
	const evidenceRetry: DreamingEvidenceRetryPolicy = options.evidenceRetry ?? {
		cooldownMs: 60_000,
		hourlyBudget: 50,
		maxAttempts: 3,
	};
	const executorForAgent = (agentId: string): DreamingAgentExecutor => {
		const factory = options.executorFactory;
		if (factory) return factory(agentId);
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
						onEvent: input.onEvent,
						onSessionInfo: input.onSessionInfo,
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
				return {
					summary: `Dreaming agent completed through ${result.value.decision.targetRef}`,
					attribution: result.value.attribution,
					usage: result.value.attempts.find((attempt) => attempt.ok)?.usage ?? null,
				};
			},
		};
	};

	async function runPass(
		runAgentId: string,
		mode: DreamingMode,
		existingPassId?: string,
		scopes?: readonly string[],
	): Promise<{ passId: string; applied: number; skipped: number; failed: number; summary: string }> {
		if (active) throw new AlreadyRunningError();
		active = true;
		activeAgent = runAgentId;
		try {
			const passScopes =
				scopes ?? (await getDreamingWorkerAgentIds(accessor, defaultAgentId, options.ownerMaintenance));
			const p = runDreamingAgentPass(
				accessor,
				executorForAgent(runAgentId),
				cfg,
				agentsDir,
				runAgentId,
				passScopes,
				mode,
				existingPassId,
				caps,
				undefined,
				options.ownerMaintenance,
			);
			activePassPromise = p;
			try {
				return await p;
			} catch (e) {
				recordDreamingFailure(accessor, runAgentId);
				throw e;
			}
		} finally {
			active = false;
			activeAgent = null;
			activePassPromise = null;
		}
	}

	async function check(): Promise<void> {
		if (stopped || active) return;
		const checkedAt = new Date().toISOString();
		if (isSystemPressureHigh()) {
			scheduler = { status: "deferred", reason: "system_pressure", checkedAt };
			return;
		}
		if (await shouldDeferDreamingSweepAsync(accessor, options.ownerMaintenance)) {
			scheduler = { status: "deferred", reason: "queue_pressure", checkedAt };
			logger.info("dreaming-worker", "Deferring dreaming sweep while queues are under pressure");
			return;
		}
		scheduler = { status: "idle", reason: null, checkedAt };
		const scopes = await getAgentScopes();
		const autoRequeued = await autoRequeueRepairedDreamingEvidence(accessor, evidenceRetry);
		if (autoRequeued > 0) {
			logger.info("dreaming-worker", "Automatically requeued repaired Dreaming evidence", {
				affected: autoRequeued,
				budget: evidenceRetry.hourlyBudget,
			});
		}
		let triggered = false;
		for (const scopeId of scopes) {
			if (stopped || active) return;
			if (await isDreamingHaltActive(accessor, scopeId)) continue;
			try {
				await enqueueDreamingHygieneAttention(accessor, scopeId, undefined, caps, options.ownerMaintenance);
				await enqueueDreamingSurprisalAttention(accessor, scopeId, cfg, options.ownerMaintenance);
				const probe = await probeDreamingEpisodicBacklog(
					accessor,
					scopeId,
					cfg.tokenThreshold,
					options.ownerMaintenance,
				);
				const decision = await evaluateDreamingTrigger(accessor, cfg, scopeId, probe, Date.now());
				if (!decision.trigger) continue;
				triggered = true;
				logger.info(
					"dreaming-worker",
					"Starting scheduled dreaming pass",
					scheduledTriggerLogData(scopeId, decision, probe, cfg.tokenThreshold),
				);
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
		const mode = await selectDreamingCheckMode(accessor, scopes, nextScheduledFocus, options.ownerMaintenance);
		nextScheduledFocus = dreamingFocusOfMode(mode) ?? nextScheduledFocus;
		try {
			await runPass(defaultAgentId, mode, undefined, scopes);
		} catch (e) {
			logger.error(
				"dreaming-worker",
				"Scheduled dreaming pass failed; check loop continues",
				e instanceof Error ? e : undefined,
				{ mode, error: e instanceof Error ? e.message : String(e) },
			);
		}
	}

	function schedule(): void {
		if (stopped) return;
		timer = setTimeout(async () => {
			try {
				await check();
			} catch (e) {
				logger.error(
					"dreaming-worker",
					"Dreaming check failed; scheduling next check",
					e instanceof Error ? e : undefined,
					{ error: e instanceof Error ? e.message : String(e) },
				);
			}
			schedule();
		}, options.checkIntervalMs ?? CHECK_INTERVAL_MS);
	}
	schedule();

	logger.info("dreaming-worker", "Dreaming worker started", {
		threshold: cfg.tokenThreshold,
	});

	return {
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

		async triggerAsync(mode: DreamingMode, agentId?: string): Promise<string> {
			if (active) throw new AlreadyRunningError();
			const runAgentId = normalizeAgentId(agentId, defaultAgentId);
			active = true;
			activeAgent = runAgentId;
			let passId: string;
			try {
				passId = options.ownerMaintenance
					? await createDreamingPassThroughOwner(options.ownerMaintenance, runAgentId, mode)
					: await createDreamingPass(accessor, runAgentId, mode);
			} catch (error) {
				active = false;
				activeAgent = null;
				throw error;
			}
			const p = runDreamingAgentPass(
				accessor,
				executorForAgent(runAgentId),
				cfg,
				agentsDir,
				runAgentId,
				await getDreamingWorkerAgentIds(accessor, defaultAgentId, options.ownerMaintenance),
				mode,
				passId,
				caps,
				undefined,
				options.ownerMaintenance,
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
		get scheduler() {
			return scheduler;
		},
	};
}
