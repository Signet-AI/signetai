import type { DreamingPassLiveOptions } from "./dreaming";
import type { DreamingConfig } from "@signet/core";
import type { DbAccessor } from "../db-accessor";
import type { DbOwnerMaintenance } from "../db-owner-maintenance";
import { ownerQueryAll, ownerQueryOne } from "../db-owner-maintenance";
import { getDbOwnerForAccessor } from "../db-owner-runtime";
import { getQueueHealth } from "../diagnostics";
import { getOrCreateInferenceRouter } from "../inference-router";
import type { GraphHygieneCaps } from "../knowledge-graph-hygiene";
import { logger } from "../logger";
import { isSystemPressureHigh } from "../system-pressure";
import { getLlmConcurrencyLimit } from "./provider";
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
import type { PiAgentRetryPolicy } from "./pi-agent-protocol";
import { compactDreamingHistory, type DreamingHistoryCompleter, narrowDreamingPassScopeKey } from "./dreaming-history";

const DREAMING_PROVIDER_RETRY: PiAgentRetryPolicy = { maxRetries: 8, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 };
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
	triggerAsync(
		mode: DreamingMode,
		agentId?: string,
		userRequest?: DreamingPassLiveOptions["userRequest"],
	): Promise<string>;
	readonly running: boolean;
	readonly activeAgentId: string | null;
	readonly activePasses: readonly DreamingActivePass[];
	readonly activePass: Promise<unknown> | null;
	readonly scheduler: DreamingSchedulerStatus;
	inferenceReady(agentId?: string): Promise<boolean>;
}
export interface DreamingActivePass {
	readonly passId: string | null;
	readonly agentId: string;
	readonly mode: DreamingMode;
	readonly scopes: readonly string[];
}
interface RunningDreamingPass {
	passId: string | null;
	readonly agentId: string;
	readonly mode: DreamingMode;
	readonly scopes: readonly string[];
	readonly exclusive: boolean;
	readonly shared: boolean;
	readonly attentionScopes: readonly string[];
	readonly slots: number;
	readonly settled: Promise<void>;
}
interface StartedDreamingPass {
	readonly passId: Promise<string>;
	readonly result: Promise<DreamingPassResult>;
	readonly firstToolCall: Promise<boolean>;
}
type DreamingPassResult = { passId: string; applied: number; skipped: number; failed: number; summary: string };

export function partitionDreamingScopes(
	work: ReadonlyArray<{
		readonly scope: string;
		readonly tokens: number;
		readonly attention?: boolean;
		readonly oldestAttentionAt?: string | null;
		readonly passes?: number;
	}>,
	slots: number,
): string[][] {
	const backlogs = work.filter((item) => (item.passes ?? 1) > 0);
	const withBacklog = backlogs
		.filter((item) => item.tokens > 0)
		.sort((a, b) => b.tokens - a.tokens || a.scope.localeCompare(b.scope));
	const attentionOnly = backlogs
		.filter((item) => item.tokens <= 0 && item.attention === true)
		.sort(
			(a, b) => (a.oldestAttentionAt ?? "").localeCompare(b.oldestAttentionAt ?? "") || a.scope.localeCompare(b.scope),
		)
		.map((item) => item.scope);
	const free = Math.max(1, slots);
	const groups = Array.from({ length: Math.min(free, withBacklog.length) }, () => ({
		scopes: [] as string[],
		tokens: 0,
	}));
	for (const item of withBacklog) {
		const target = groups.reduce((smallest, group) => (group.tokens < smallest.tokens ? group : smallest));
		target.scopes.push(item.scope);
		target.tokens += item.tokens;
	}
	for (const scope of attentionOnly.slice(0, free - groups.length)) groups.push({ scopes: [scope], tokens: 0 });
	const extra = new Map(withBacklog.map((item) => [item.scope, Math.max(0, Math.floor(item.passes ?? 1) - 1)]));
	while (groups.length < free && [...extra.values()].some((count) => count > 0)) {
		for (const item of withBacklog) {
			const count = extra.get(item.scope) ?? 0;
			if (count <= 0 || groups.length >= free) continue;
			extra.set(item.scope, count - 1);
			groups.push({ scopes: [item.scope], tokens: item.tokens });
		}
	}
	return groups.map((group) => [...group.scopes].sort()).filter((scopes) => scopes.length > 0);
}
export interface DreamingSchedulerStatus {
	readonly status: "idle" | "deferred" | "blocked";
	readonly reason: "queue_pressure" | "system_pressure" | "inference_unavailable" | null;
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

function routedFailure(error: { readonly message: string; readonly details?: { readonly attempts?: unknown } }): Error {
	const attempts = Array.isArray(error.details?.attempts)
		? error.details.attempts
				.map((attempt) => {
					if (!attempt || typeof attempt !== "object") return "unknown target";
					const value = attempt as { targetRef?: unknown; error?: unknown };
					return `${typeof value.targetRef === "string" ? value.targetRef : "unknown"}: ${typeof value.error === "string" ? value.error : "failed"}`;
				})
				.join("; ")
		: "";
	return new Error(attempts ? `${error.message} (${attempts})` : error.message);
}

export interface DreamingWorkerOptions {
	readonly executorFactory?: (agentId: string) => DreamingAgentExecutor;
	readonly historyCompleterFactory?: (agentId: string) => DreamingHistoryCompleter;
	readonly checkIntervalMs?: number;
	readonly enabled?: () => boolean;
	readonly inferenceAvailable?: (agentId: string) => Promise<boolean>;
	readonly acpxMcp?: {
		readonly daemonUrl: string;
		readonly authorizationTokenForAgent?: (agentId: string) => string | undefined;
	};
	readonly evidenceRetry?: DreamingEvidenceRetryPolicy;
	readonly ownerMaintenance?: DbOwnerMaintenance;
}

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const INFERENCE_RECHECK_MS = 30 * 1000;
const AGENT_SCOPE_SNAPSHOT_REFRESH_MS = 30 * 60 * 1000;
export async function shouldDeferDreamingSweep(
	accessor: DbAccessor,
	ownerMaintenance?: DbOwnerMaintenance,
): Promise<boolean> {
	if (ownerMaintenance) return !(await ownerMaintenance.queueIsHealthy());
	return await accessor.withReadDbAsync((db) => getQueueHealth(db).status !== "healthy", {
		siteToken: "db:dreaming.worker.sweep-deferral.read",
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
		? await ownerQueryAll<{ id: string | null }>(
				ownerMaintenance.owner,
				"pipeline/dreaming-worker.agent-scopes",
				sql,
				[],
				{ waitForOwnerCompletionOnDeadline: true },
			)
		: await accessor.withReadDbAsync(
				(db) => {
					return db.prepare(sql).all() as Array<{ id: string | null }>;
				},
				{ siteToken: "db:dreaming.worker.agent-ids.read", operation: "dreaming.worker.agent-scopes" },
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
							siteToken: "db:dreaming.worker.check-mode.hygiene-attention.read",
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
								siteToken: "db:dreaming.worker.check-mode.content-attention.read",
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
	let stopped = false;
	let admission: Promise<void> | null = null;
	let activeWork: Promise<void> | null = null;
	let knownScopes: readonly string[] = [];
	const runningPasses = new Set<RunningDreamingPass>();
	const configuredConcurrentPasses = Math.max(1, Math.floor(cfg.maxConcurrentPasses ?? 1));
	const maxPasses = (): number => Math.max(1, Math.min(configuredConcurrentPasses, getLlmConcurrencyLimit()));
	const passesPerScope = Math.max(1, Math.floor(cfg.maxPassesPerScope ?? 1));
	const sharesScopes = passesPerScope > 1;
	const evidenceLeaseMs = 2 * cfg.timeout;
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
						retry: DREAMING_PROVIDER_RETRY,
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
					throw routedFailure(result.error);
				}
				return {
					summary: `Dreaming agent completed through ${result.value.decision.targetRef}`,
					attribution: result.value.attribution,
					usage: result.value.attempts.find((attempt) => attempt.ok)?.usage ?? null,
				};
			},
		};
	};

	const historyCompleterForAgent = (agentId: string): DreamingHistoryCompleter | null => {
		if (options.historyCompleterFactory) return options.historyCompleterFactory(agentId);
		if (options.executorFactory) return null;
		const router = getOrCreateInferenceRouter(agentsDir);
		return {
			async complete(input) {
				const result = await router.execute({ agentId, operation: "memory_extraction" }, input.prompt, {
					timeoutMs: input.timeoutMs,
				});
				if (!result.ok) throw routedFailure(result.error);
				return { text: result.value.text, usage: result.value.usage };
			},
		};
	};

	async function compactHistoryAfterPass(
		runAgentId: string,
		passId: string,
		scopes: readonly string[],
		live?: DreamingPassLiveOptions,
	): Promise<void> {
		try {
			const completer = historyCompleterForAgent(runAgentId);
			if (completer === null || stopped) return;
			const scopeKey = await narrowDreamingPassScopeKey(
				accessor,
				passId,
				live?.userRequest !== undefined ? [runAgentId] : scopes,
			);
			await compactDreamingHistory(accessor, completer, runAgentId, scopeKey, { isActive: () => !stopped });
		} catch (error) {
			logger.warn("dreaming-worker", "Dreaming history compaction was not started", {
				agentId: runAgentId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	function recordDreamingFailureOrLog(runAgentId: string): void {
		recordDreamingFailure(accessor, runAgentId).catch((error) => {
			logger.warn("dreaming-worker", "Dreaming failure was not recorded", {
				agentId: runAgentId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	const usedSlots = (): number => [...runningPasses].reduce((sum, pass) => sum + pass.slots, 0);
	const leasedScopes = (): ReadonlySet<string> => new Set([...runningPasses].flatMap((pass) => pass.scopes));
	const scopePassCounts = (): ReadonlyMap<string, number> => {
		const counts = new Map<string, number>();
		for (const scope of [...runningPasses].flatMap((pass) => pass.scopes))
			counts.set(scope, (counts.get(scope) ?? 0) + 1);
		return counts;
	};
	const closedScopes = (): ReadonlySet<string> => {
		if (!sharesScopes) return leasedScopes();
		const counts = scopePassCounts();
		const closed = new Set([...runningPasses].filter((pass) => !pass.shared).flatMap((pass) => pass.scopes));
		for (const [scope, count] of counts) if (count >= passesPerScope) closed.add(scope);
		return closed;
	};
	const exclusiveRunning = (): boolean => [...runningPasses].some((pass) => pass.exclusive);
	const listScopes = async (): Promise<readonly string[]> => {
		knownScopes = await getDreamingWorkerAgentIds(accessor, defaultAgentId, options.ownerMaintenance);
		return knownScopes;
	};
	const knownScopesLeased = (): boolean => {
		if (runningPasses.size === 0) return false;
		if (exclusiveRunning() || usedSlots() >= maxPasses()) return true;
		const closed = closedScopes();
		return knownScopes.length > 0 && knownScopes.every((scope) => closed.has(scope));
	};

	async function admit<T>(fn: () => Promise<T>): Promise<T> {
		if (admission !== null) throw new AlreadyRunningError();
		let release: () => void = () => undefined;
		admission = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			return await fn();
		} finally {
			admission = null;
			release();
		}
	}

	function reportToolCalls(executor: DreamingAgentExecutor, onToolCall: () => void): DreamingAgentExecutor {
		return {
			run: (input) =>
				executor.run({
					...input,
					tools: input.tools.map((tool) => ({
						...tool,
						execute: (...args: Parameters<typeof tool.execute>) => {
							onToolCall();
							return tool.execute(...args);
						},
					})),
				}),
		};
	}

	function startPass(
		runAgentId: string,
		mode: DreamingMode,
		scopes: readonly string[],
		exclusive: boolean,
		live?: DreamingPassLiveOptions,
	): StartedDreamingPass {
		let resolveToolCall: (ok: boolean) => void = () => undefined;
		const firstToolCall = new Promise<boolean>((resolve) => {
			resolveToolCall = resolve;
		});
		let release: () => void = () => undefined;
		const shared = sharesScopes && !exclusive && live?.userRequest === undefined;
		const attentionHeld = new Set([...runningPasses].flatMap((pass) => pass.attentionScopes));
		const attentionScopes = shared ? scopes.filter((scope) => !attentionHeld.has(scope)) : scopes;
		const passLive: DreamingPassLiveOptions | undefined = shared
			? { ...live, sharedScope: { evidenceLeaseMs, attentionScopes } }
			: live;
		const entry: RunningDreamingPass = {
			passId: null,
			agentId: runAgentId,
			mode,
			scopes,
			exclusive,
			shared,
			attentionScopes,
			slots: 1,
			settled: new Promise<void>((resolve) => {
				release = resolve;
			}),
		};
		runningPasses.add(entry);
		const passId = (async () => {
			const id = options.ownerMaintenance
				? await createDreamingPassThroughOwner(options.ownerMaintenance, runAgentId, mode)
				: await createDreamingPass(accessor, runAgentId, mode);
			entry.passId = id;
			return id;
		})();
		const result = passId.then((id) =>
			runDreamingAgentPass(
				accessor,
				reportToolCalls(executorForAgent(runAgentId), () => resolveToolCall(true)),
				cfg,
				agentsDir,
				runAgentId,
				scopes,
				mode,
				id,
				caps,
				passLive,
				options.ownerMaintenance,
			).catch((error: unknown) => {
				recordDreamingFailureOrLog(runAgentId);
				logger.error("dreaming-worker", "Dreaming pass failed", undefined, {
					agentId: runAgentId,
					passId: id,
					scopes,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}),
		);
		void result.then(
			() => resolveToolCall(true),
			() => resolveToolCall(false),
		);
		void result
			.catch(() => undefined)
			.then(async () => compactHistoryAfterPass(runAgentId, await passId, scopes, live))
			.catch(() => undefined)
			.finally(() => {
				runningPasses.delete(entry);
				release();
			});
		return { passId, result, firstToolCall };
	}

	async function measureScopeWork(scopes: readonly string[]): Promise<
		Array<{
			readonly scope: string;
			readonly tokens: number;
			readonly attention: boolean;
			readonly oldestAttentionAt: string | null;
			readonly passes: number;
		}>
	> {
		const running = scopePassCounts();
		const owner = await getDbOwnerForAccessor(accessor);
		const attention = new Map(
			(
				await ownerQueryAll<{ agentId: string; oldest: string }>(
					owner,
					"dreaming.worker.pending-attention-scopes",
					`SELECT agent_id AS agentId, MIN(created_at) AS oldest FROM dreaming_attention
					 WHERE resolved_at IS NULL AND agent_id IN (${scopes.map(() => "?").join(", ")})
					 GROUP BY agent_id`,
					[...scopes],
					{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
				)
			).map((row) => [row.agentId, row.oldest] as const),
		);
		return await Promise.all(
			scopes.map(async (scope) => {
				const probe = await probeDreamingEpisodicBacklog(accessor, scope, cfg.tokenThreshold, options.ownerMaintenance);
				const tokens =
					probe.hasBacklog === false ? 0 : Math.max(1, probe.kind === "exact" ? probe.tokens : probe.tokenLowerBound);
				const held = running.get(scope) ?? 0;
				const wanted = sharesScopes && tokens >= cfg.tokenThreshold ? passesPerScope : 1;
				return {
					scope,
					tokens,
					attention: attention.has(scope),
					oldestAttentionAt: attention.get(scope) ?? null,
					passes: Math.max(0, wanted - held),
				};
			}),
		);
	}

	async function startIncrementalPasses(runAgentId: string, scopes: readonly string[]): Promise<StartedDreamingPass> {
		const slots = maxPasses() - usedSlots();
		if (scopes.length === 0 || slots <= 0) throw new AlreadyRunningError();
		const measured =
			scopes.length === 1 && !sharesScopes
				? [[...scopes]]
				: partitionDreamingScopes(await measureScopeWork(scopes), slots);
		const held = leasedScopes();
		const idle = scopes.filter((scope) => !held.has(scope));
		if (measured.length === 0 && idle.length === 0) throw new AlreadyRunningError();
		const groups = measured.length > 0 ? measured : [idle];
		const [firstGroup, ...rest] = groups;
		const first = startPass(runAgentId, "incremental", firstGroup ?? [...scopes], false);
		if (rest.length === 0) return first;
		let releaseReservation: () => void = () => undefined;
		const reservation: RunningDreamingPass = {
			passId: null,
			agentId: runAgentId,
			mode: "incremental",
			scopes: rest.flat(),
			exclusive: false,
			shared: sharesScopes,
			attentionScopes: [],
			slots: rest.length,
			settled: new Promise<void>((resolve) => {
				releaseReservation = resolve;
			}),
		};
		runningPasses.add(reservation);
		void first.firstToolCall.then((ok) => {
			runningPasses.delete(reservation);
			releaseReservation();
			if (!ok || stopped) {
				logger.warn("dreaming-worker", "Skipped concurrent Dreaming passes after the first pass failed to start", {
					agentId: runAgentId,
					groups: rest.length,
				});
				return;
			}
			for (const group of rest) {
				startPass(runAgentId, "incremental", group, false).result.catch(() => undefined);
			}
		});
		return first;
	}

	async function inferenceReady(agentId = defaultAgentId): Promise<boolean> {
		if (agentId !== defaultAgentId) return !options.inferenceAvailable || (await options.inferenceAvailable(agentId));
		if (!options.inferenceAvailable || (await options.inferenceAvailable(agentId))) {
			if (scheduler.reason === "inference_unavailable") {
				logger.info("dreaming-worker", "Inference provider available; Dreaming resumes");
				scheduler = { status: "idle", reason: null, checkedAt: new Date().toISOString() };
			}
			return true;
		}
		const entering = scheduler.reason !== "inference_unavailable";
		if (entering) {
			logger.info("dreaming-worker", "No inference provider is available; Dreaming waits for one");
		}
		scheduler = { status: "blocked", reason: "inference_unavailable", checkedAt: new Date().toISOString() };
		if (entering && timer) {
			clearTimeout(timer);
			schedule();
		}
		return false;
	}

	async function check(): Promise<void> {
		if (
			stopped ||
			admission !== null ||
			exclusiveRunning() ||
			usedSlots() >= maxPasses() ||
			!(options.enabled ? options.enabled() : cfg.enabled)
		)
			return;
		if (!(await inferenceReady())) return;
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
		const closed = closedScopes();
		const scopes = (await getAgentScopes()).filter((scope) => !closed.has(scope));
		if (scopes.length === 0) return;
		const autoRequeued = await autoRequeueRepairedDreamingEvidence(accessor, evidenceRetry);
		if (autoRequeued > 0) {
			logger.info("dreaming-worker", "Automatically requeued repaired Dreaming evidence", {
				affected: autoRequeued,
				budget: evidenceRetry.hourlyBudget,
			});
		}
		let triggered = false;
		for (const scopeId of scopes) {
			if (stopped) return;
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
		if (mode !== "incremental" && runningPasses.size > 0) return;
		nextScheduledFocus = dreamingFocusOfMode(mode) ?? nextScheduledFocus;
		try {
			const started = await admit(async () =>
				mode === "incremental"
					? await startIncrementalPasses(defaultAgentId, scopes)
					: startPass(defaultAgentId, mode, scopes, true),
			);
			await started.passId;
		} catch (e) {
			if (e instanceof AlreadyRunningError) return;
			logger.error(
				"dreaming-worker",
				"Scheduled dreaming pass failed to start; check loop continues",
				e instanceof Error ? e : undefined,
				{ mode, error: e instanceof Error ? e.message : String(e) },
			);
		}
	}

	function schedule(): void {
		if (stopped) return;
		timer = setTimeout(async () => {
			timer = null;
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
		}, nextCheckDelay());
	}
	function nextCheckDelay(): number {
		const interval = options.checkIntervalMs ?? CHECK_INTERVAL_MS;
		return scheduler.reason === "inference_unavailable" ? Math.min(interval, INFERENCE_RECHECK_MS) : interval;
	}
	schedule();
	if (options.enabled ? options.enabled() : cfg.enabled) {
		void inferenceReady().catch((e: unknown) => {
			logger.warn("dreaming-worker", "Initial inference availability check failed", {
				error: e instanceof Error ? e.message : String(e),
			});
		});
	}

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

		async trigger(mode: DreamingMode, agentId?: string) {
			const started = await admit(async () => {
				if (runningPasses.size > 0) throw new AlreadyRunningError();
				return startPass(normalizeAgentId(agentId, defaultAgentId), mode, await listScopes(), true);
			});
			return await started.result;
		},

		async triggerAsync(
			mode: DreamingMode,
			agentId?: string,
			userRequest?: DreamingPassLiveOptions["userRequest"],
		): Promise<string> {
			const runAgentId = normalizeAgentId(agentId, defaultAgentId);
			if (!userRequest && knownScopesLeased()) throw new AlreadyRunningError();
			const started = await admit(async () => {
				if (exclusiveRunning()) throw new AlreadyRunningError();
				if (userRequest) {
					if (leasedScopes().has(runAgentId) || usedSlots() >= maxPasses()) throw new AlreadyRunningError();
					return startPass(runAgentId, mode, [runAgentId], mode !== "incremental", { userRequest });
				}
				const scopes = await listScopes();
				if (mode !== "incremental") {
					if (runningPasses.size > 0) throw new AlreadyRunningError();
					return startPass(runAgentId, mode, scopes, true);
				}
				const closed = closedScopes();
				return await startIncrementalPasses(
					runAgentId,
					scopes.filter((scope) => !closed.has(scope)),
				);
			});
			return await started.passId;
		},

		get running() {
			return runningPasses.size > 0 || admission !== null;
		},

		get activeAgentId() {
			return [...runningPasses][0]?.agentId ?? null;
		},

		get activePasses() {
			return [...runningPasses].map((pass) => ({
				passId: pass.passId,
				agentId: pass.agentId,
				mode: pass.mode,
				scopes: pass.scopes,
			}));
		},

		get activePass() {
			if (runningPasses.size === 0 && admission === null) return null;
			if (activeWork === null) {
				const work = (async () => {
					while (runningPasses.size > 0 || admission !== null) {
						const pending = [...runningPasses].map((pass) => pass.settled);
						if (admission !== null) pending.push(admission);
						await Promise.all(pending);
					}
				})().finally(() => {
					if (activeWork === work) activeWork = null;
				});
				activeWork = work;
			}
			return activeWork;
		},
		get scheduler() {
			return scheduler;
		},
		inferenceReady,
	};
}
