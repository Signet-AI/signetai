import { readFile as readFileAsync, stat as statAsync } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
	AcpxModelSelection,
	LlmGenerateResult,
	LlmProvider,
	LlmUsage,
	RouteDecision,
	RouteRequest,
	RouterResult,
	RoutingAccountConfig,
	RoutingConfig,
	RoutingOperationKind,
	RoutingRuntimeSnapshot,
	RoutingRuntimeState,
	RoutingValidationIssue,
} from "@signet/core";
import {
	allTargetRefs,
	isLocalInferenceEndpoint,
	parseRoutingConfig,
	parseRoutingTargetRef,
	parseYamlDocument,
	resolveAcpxModelSelection,
	resolveRoutingDecision,
	routingTelemetryAttribution,
	validateRoutingReferences,
} from "@signet/core";
import { isOAuthProvider, resolveOAuthCredential } from "./inference-oauth";
import { type ResolvedInferenceCredential, createRoutingProvider } from "./inference-provider-factory";
import { logger } from "./logger";
import { loadMemoryConfig } from "./memory-config";
import { createDreamingAcpxMcpConfig } from "./pipeline/acpx-dreaming-mcp";
import {
	type PiAgentSession,
	PiProviderDeadlineError,
	isPiAgentSessionProvider,
	mapSessionStatsToUsage,
} from "./pipeline/pi-provider";
import {
	type AcpxHooksMode,
	type LlmProviderStreamEvent,
	type LlmProviderStreamResult,
	type StreamCapableLlmProvider,
	acquireLlmConcurrencyPermit,
	generateWithTracking,
} from "./pipeline/provider";
import { getSecret } from "./secrets";

const SNAPSHOT_TTL_MS = 15_000;
const OBSERVED_RATE_LIMIT_TTL_MS = 60_000;
const OBSERVED_AUTH_TTL_MS = 5 * 60_000;
const OBSERVED_MISSING_TTL_MS = 60_000;
const REDACTED_UPSTREAM_DETAIL = "[redacted upstream detail]";
const BACKGROUND_OPERATIONS = new Set<RoutingOperationKind>(["memory_extraction", "session_synthesis", "repair"]);

function normalizeAttributionValue(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

export interface BackgroundInferenceQuiescence {
	readonly activeAtStart: number;
	readonly aborted: number;
	readonly remaining: number;
	readonly timedOut: boolean;
}

export interface BackgroundWorkloadDiagnostics {
	readonly active: number;
	readonly agentSessions: number;
	readonly oldestAgeMs: number | null;
	readonly oldestAgentSessionAgeMs: number | null;
	readonly byOperation: Readonly<Partial<Record<RoutingOperationKind, number>>>;
}

export interface InferenceExecutionAttempt {
	readonly targetRef: string;
	readonly ok: boolean;
	readonly durationMs: number;
	readonly error?: string;
	readonly usage?: LlmUsage | null;
}

export interface InferenceExecutionResult {
	readonly text: string;
	readonly usage: LlmUsage | null;
	readonly decision: RouteDecision;
	readonly attempts: readonly InferenceExecutionAttempt[];
}

/** Successful bounded-agent run using one router-selected target. */
export interface InferenceAgentExecutionResult {
	readonly decision: RouteDecision;
	readonly attempts: readonly InferenceExecutionAttempt[];
	/** Privacy-safe metadata for the target that actually completed the run. */
	readonly attribution: InferenceExecutionAttribution | null;
}

export interface InferenceExecutionAttribution {
	readonly executor: string;
	readonly provider: string;
	readonly model: string;
	readonly locality: "local" | "remote" | "unknown";
}

export type InferenceStreamEvent =
	| {
			readonly type: "delta";
			readonly text: string;
	  }
	| {
			readonly type: "done";
			readonly text: string;
			readonly usage: LlmUsage | null;
			readonly decision: RouteDecision;
			readonly attempts: readonly InferenceExecutionAttempt[];
	  }
	| {
			readonly type: "error";
			readonly error: string;
			readonly partialText: string;
			readonly decision: RouteDecision;
			readonly attempts: readonly InferenceExecutionAttempt[];
	  }
	| {
			readonly type: "cancelled";
			readonly partialText: string;
			readonly decision: RouteDecision;
			readonly attempts: readonly InferenceExecutionAttempt[];
	  };

export interface InferenceStreamResult {
	readonly decision: RouteDecision;
	readonly stream: ReadableStream<InferenceStreamEvent>;
	cancel(reason?: string): void;
}

export class PiAgentSessionTimeoutError extends Error {
	readonly cleanup: Promise<void>;

	constructor(deadlineMs: number, cleanup: Promise<void>) {
		super(`Agent session exceeded the ${deadlineMs}ms deadline`);
		this.name = "PiAgentSessionTimeoutError";
		this.cleanup = cleanup;
	}
}

/**
 * Race a Pi agent prompt against its deadline. A timeout returns immediately,
 * but carries the cancellation-settlement promise so the caller can retain its
 * concurrency permit until the upstream work has actually stopped.
 */
export async function promptPiAgentSession(
	session: PiAgentSession,
	prompt: string,
	deadlineMs: number | undefined,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let aborting: Promise<void> | undefined;
	const abort = (): Promise<void> => {
		aborting ??= Promise.resolve().then(() => session.abort());
		return aborting;
	};
	const promptResult = session.prompt(prompt);
	const cleanup = (): Promise<void> =>
		Promise.all([
			promptResult.then(
				() => undefined,
				() => undefined,
			),
			abort().catch(() => {}),
		]).then(() => undefined);
	try {
		if (deadlineMs === undefined) {
			await promptResult;
			return;
		}
		if (deadlineMs <= 0) {
			throw new PiAgentSessionTimeoutError(deadlineMs, cleanup());
		}
		const timedOut = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new PiAgentSessionTimeoutError(deadlineMs, cleanup())), deadlineMs);
		});
		await Promise.race([promptResult, timedOut]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export interface InferenceAccountSummary {
	readonly kind: string;
	readonly providerFamily: string;
	readonly label?: string;
}

export interface InferenceTargetSummary {
	readonly kind: string;
	readonly executor: string;
	readonly account?: string;
	readonly privacy?: string;
	readonly models: Readonly<Record<string, { readonly model: string; readonly label?: string }>>;
	readonly acpx?: {
		readonly agent: string;
		readonly modelSelection: AcpxModelSelection;
	};
}

export interface InferenceStatusSummary {
	readonly enabled: boolean;
	readonly source: RoutingConfig["source"] | "disabled";
	readonly defaultPolicy?: string;
	readonly defaultAgentId: string;
	readonly policies: readonly string[];
	readonly taskClasses: readonly string[];
	readonly targetRefs: readonly string[];
	readonly workloadBindings: {
		readonly default?: string;
		readonly interactive?: string;
		readonly memoryExtraction?: string;
		readonly aggregateRecall?: string;
		readonly widgetGeneration?: string;
		readonly repair?: string;
	};
	readonly accounts: Readonly<Record<string, InferenceAccountSummary>>;
	readonly targets: Readonly<Record<string, InferenceTargetSummary>>;
	readonly agents: readonly string[];
	readonly configIssues: readonly RoutingValidationIssue[];
	readonly runtimeSnapshot: RoutingRuntimeSnapshot;
}

interface LoadedRoutingConfig {
	readonly config: RoutingConfig;
	readonly signature: string;
	readonly path: string | null;
	readonly configIssues: readonly RoutingValidationIssue[];
}

function attributionForTarget(
	loaded: LoadedRoutingConfig,
	targetId: string,
	modelId: string,
): InferenceExecutionAttribution | null {
	const target = loaded.config.targets[targetId];
	const model = target?.models[modelId];
	if (!target || !model) return null;
	const account = target.account ? loaded.config.accounts[target.account] : undefined;
	const attribution = routingTelemetryAttribution(target, model, account);
	const provider = normalizeAttributionValue(attribution.provider);
	const configuredModel = normalizeAttributionValue(attribution.model);
	if (!provider || !configuredModel) return null;
	return {
		executor: attribution.executor,
		provider,
		model: configuredModel,
		locality: attribution.locality,
	};
}

interface SnapshotCacheEntry {
	readonly signature: string;
	readonly expiresAt: number;
	readonly snapshot: RoutingRuntimeSnapshot;
}

interface ObservedRuntimeOverride {
	readonly state: RoutingRuntimeState;
	readonly expiresAt: number;
}

function normalizePromptPreview(prompt: string): string {
	return prompt.slice(0, 8000);
}

function inferenceConfigPaths(agentsDir: string): readonly string[] {
	return [join(agentsDir, "agent.yaml"), join(agentsDir, "AGENT.yaml")];
}

function resolveForComparison(path: string): string {
	return normalize(isAbsolute(path) ? path : resolve(path));
}

/** True only for the root config files read by this router. */
export function isInferenceRouterConfigPath(agentsDir: string, path: string): boolean {
	const changedPath = resolveForComparison(path);
	return inferenceConfigPaths(agentsDir).some((candidate) => resolveForComparison(candidate) === changedPath);
}

function defaultAgentIdForConfig(config: RoutingConfig): string {
	if (config.agents.default) return "default";
	const ids = Object.keys(config.agents);
	if (ids.length === 1) return ids[0];
	return "default";
}

function formatExecutionError(error: unknown): string {
	return sanitizeErrorText(error instanceof Error ? error.message : String(error));
}

function sanitizeErrorText(value: string): string {
	let next = value.trim();
	const httpDetail = next.match(/^(.*\bHTTP \d{3}:\s*)([\s\S]+)$/);
	if (httpDetail) {
		const prefix = httpDetail[1] ?? "";
		const detail = httpDetail[2] ?? "";
		next = `${prefix}${sanitizeUpstreamDetail(detail)}`;
	}
	return sanitizeInlineSecrets(next);
}

function sanitizeInlineSecrets(value: string): string {
	let next = value;
	next = next.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+\b/gi, "Bearer [redacted]");
	next = next.replace(/([?&](?:api[_-]?key|access[_-]?token|token|session(?:[_-]?ref)?)=)[^&\s]+/gi, "$1[redacted]");
	next = next.replace(
		/((?:api[_-]?key|access[_-]?token|token|session(?:[_-]?ref)?|authorization)\s*["'=:\s]+\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi,
		"$1[redacted]",
	);
	next = next.replace(/"prompt"\s*:\s*"[^"]*"/gi, '"prompt":"[redacted]"');
	next = next.replace(/"content"\s*:\s*"[^"]*"/gi, '"content":"[redacted]"');
	next = next.replace(/"session(?:[_-]?ref)"\s*:\s*"[^"]*"/gi, '"sessionRef":"[redacted]"');
	next = next.replace(/"authorization"\s*:\s*"[^"]*"/gi, '"authorization":"[redacted]"');
	return next;
}

function sanitizeUpstreamDetail(detail: string): string {
	const trimmed = detail.trim();
	if (trimmed.length === 0) return "";
	if (
		/[{[]/.test(trimmed) &&
		/"prompt"|"content"|"messages"|"api[_-]?key"|"session(?:[_-]?ref)"|Bearer\s+/i.test(trimmed)
	) {
		return REDACTED_UPSTREAM_DETAIL;
	}
	return sanitizeInlineSecrets(trimmed);
}

function isAbortLikeError(error: unknown): boolean {
	return (
		error instanceof PiProviderDeadlineError ||
		error instanceof DOMException ||
		(error instanceof Error &&
			(error.name === "AbortError" ||
				error.message.toLowerCase().includes("aborted") ||
				error.message.toLowerCase().includes("cancelled")))
	);
}

function cloneAttempts(attempts: readonly InferenceExecutionAttempt[]): readonly InferenceExecutionAttempt[] {
	return attempts.map((attempt) => ({ ...attempt }));
}

function isRuntimeBlocked(state: RoutingRuntimeState): boolean {
	return (
		!state.available ||
		state.circuitOpen ||
		state.health === "blocked" ||
		state.accountState === "missing" ||
		state.accountState === "expired" ||
		state.accountState === "rate_limited"
	);
}

function isOAuthBackedAccount(account: RoutingAccountConfig | undefined): account is RoutingAccountConfig {
	return (
		account !== undefined &&
		isOAuthProvider(account.providerFamily) &&
		(account.kind === "subscription_session" || !account.credentialRef)
	);
}

function buildPromptFromMessages(messages: ReadonlyArray<{ readonly role: string; readonly content: string }>): string {
	return messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
}

export class InferenceRouter {
	private configCache: RouterResult<LoadedRoutingConfig> | null = null;
	private configLoad: Promise<RouterResult<LoadedRoutingConfig>> | null = null;
	// Coalesce explicit refreshes without letting one join a non-refresh load.
	private configLoadForced = false;
	private configGeneration = 0;
	private snapshotCache: SnapshotCacheEntry | null = null;
	private readonly snapshotFlights = new Map<string, Promise<RoutingRuntimeSnapshot>>();
	private runtimeCacheGeneration = 0;
	private readonly providerCache = new Map<string, Promise<StreamCapableLlmProvider>>();
	private readonly observedTargetState = new Map<string, ObservedRuntimeOverride>();
	private readonly observedAccountState = new Map<string, ObservedRuntimeOverride>();
	private providerCacheSignature: string | null = null;
	private lastValidationSignature: string | null = null;
	private backgroundAdmissionsOpen = true;
	private readonly activeBackgroundExecutions = new Map<
		number,
		{
			readonly controller: AbortController;
			readonly operation: RoutingOperationKind;
			readonly agentId: string;
			readonly kind: "inference" | "agent";
			readonly startedAt: number;
		}
	>();
	private readonly backgroundSettledWaiters = new Set<() => void>();
	private nextBackgroundExecutionId = 1;

	constructor(private readonly agentsDir: string) {}

	/**
	 * Eagerly load + validate the routing config once at daemon boot so broken
	 * references are surfaced in the log before any route is attempted (#1005).
	 * Never throws: a missing/invalid config is reported via the structured log.
	 */
	async validateConfigReferences(): Promise<void> {
		try {
			const loaded = await this.loadConfig();
			if (!loaded.ok) return; // loadConfig already logged the structured error.
		} catch (error) {
			logger.error("inference", "Routing config boot validation failed", error as Error);
		}
	}

	resumeBackgroundInference(): void {
		this.backgroundAdmissionsOpen = true;
	}

	async quiesceBackgroundInference(timeoutMs = 5_000): Promise<BackgroundInferenceQuiescence> {
		this.backgroundAdmissionsOpen = false;
		const activeAtStart = this.activeBackgroundExecutions.size;
		for (const execution of this.activeBackgroundExecutions.values()) execution.controller.abort();
		if (this.activeBackgroundExecutions.size === 0) {
			return { activeAtStart, aborted: activeAtStart, remaining: 0, timedOut: false };
		}

		let timeout: ReturnType<typeof setTimeout> | null = null;
		let timedOut = false;
		let settledWaiter: (() => void) | null = null;
		await Promise.race([
			new Promise<void>((resolve) => {
				settledWaiter = resolve;
				this.backgroundSettledWaiters.add(resolve);
			}),
			new Promise<void>((resolve) => {
				timeout = setTimeout(() => {
					timedOut = true;
					resolve();
				}, timeoutMs);
			}),
		]);
		if (timeout) clearTimeout(timeout);
		if (settledWaiter) this.backgroundSettledWaiters.delete(settledWaiter);
		return { activeAtStart, aborted: activeAtStart, remaining: this.activeBackgroundExecutions.size, timedOut };
	}

	private beginBackgroundExecution(
		operation: RoutingOperationKind,
		agentId: string | undefined,
		kind: "inference" | "agent",
	): { readonly id: number; readonly signal: AbortSignal } | null | undefined {
		if (!BACKGROUND_OPERATIONS.has(operation)) return undefined;
		if (!this.backgroundAdmissionsOpen) return null;
		const id = this.nextBackgroundExecutionId++;
		const controller = new AbortController();
		this.activeBackgroundExecutions.set(id, {
			controller,
			operation,
			agentId: agentId?.trim() || "default",
			kind,
			startedAt: Date.now(),
		});
		return { id, signal: controller.signal };
	}

	getBackgroundWorkloadDiagnostics(agentId = "default"): BackgroundWorkloadDiagnostics {
		const byOperation: Partial<Record<RoutingOperationKind, number>> = {};
		const scopedAgentId = agentId.trim() || "default";
		let active = 0;
		let agentSessions = 0;
		let oldestAgeMs: number | null = null;
		let oldestAgentSessionAgeMs: number | null = null;
		const now = Date.now();
		for (const execution of this.activeBackgroundExecutions.values()) {
			if (execution.agentId !== scopedAgentId) continue;
			active += 1;
			byOperation[execution.operation] = (byOperation[execution.operation] ?? 0) + 1;
			const ageMs = Math.max(0, now - execution.startedAt);
			oldestAgeMs = oldestAgeMs === null ? ageMs : Math.max(oldestAgeMs, ageMs);
			if (execution.kind === "agent") {
				agentSessions += 1;
				oldestAgentSessionAgeMs = oldestAgentSessionAgeMs === null ? ageMs : Math.max(oldestAgentSessionAgeMs, ageMs);
			}
		}
		return { active, agentSessions, oldestAgeMs, oldestAgentSessionAgeMs, byOperation };
	}

	private finishBackgroundExecution(id: number | undefined): void {
		if (id === undefined) return;
		this.activeBackgroundExecutions.delete(id);
		if (this.activeBackgroundExecutions.size !== 0) return;
		for (const resolve of this.backgroundSettledWaiters) resolve();
		this.backgroundSettledWaiters.clear();
	}

	/**
	 * Drop the cached routing config after the daemon watcher observes a config
	 * change. Concurrent callers that already started loading may finish with
	 * the old snapshot, but the next caller starts a fresh load.
	 */
	invalidateConfig(): void {
		this.configGeneration += 1;
		this.configCache = null;
		this.configLoad = null;
		this.configLoadForced = false;
		this.providerCacheSignature = null;
		this.lastValidationSignature = null;
		this.providerCache.clear();
		this.observedTargetState.clear();
		this.observedAccountState.clear();
		this.resetRuntimeCaches();
	}

	private async loadConfig(forceReload = false): Promise<RouterResult<LoadedRoutingConfig>> {
		if (forceReload && this.configLoad && this.configLoadForced) return this.configLoad;
		if (forceReload) this.invalidateConfig();
		if (this.configCache) return this.configCache;
		if (this.configLoad) return this.configLoad;

		const generation = this.configGeneration;
		const load = this.loadConfigFromDisk();
		const pending = load.then((result) => {
			if (generation === this.configGeneration) this.configCache = result;
			return result;
		});
		const tracked = pending.finally(() => {
			if (this.configLoad !== tracked) return;
			this.configLoad = null;
			this.configLoadForced = false;
		});
		this.configLoad = tracked;
		this.configLoadForced = forceReload;
		return tracked;
	}

	private async loadConfigFromDisk(): Promise<RouterResult<LoadedRoutingConfig>> {
		let raw: unknown = {};
		let path: string | null = null;
		let signature = "no-config";
		for (const candidate of inferenceConfigPaths(this.agentsDir)) {
			let stat: Awaited<ReturnType<typeof statAsync>>;
			try {
				stat = await statAsync(candidate);
			} catch {
				continue;
			}
			path = candidate;
			signature = `${candidate}:${stat.mtimeMs}:${stat.size}`;
			try {
				raw = parseYamlDocument(await readFileAsync(candidate, "utf-8"));
			} catch (error) {
				return {
					ok: false,
					error: {
						code: "invalid-config",
						message: `Failed to parse inference config: ${formatExecutionError(error)}`,
					},
				};
			}
			break;
		}

		const parsed = parseRoutingConfig(raw);
		if (!parsed.ok) {
			this.logConfigError(parsed.error, signature);
			return parsed;
		}

		const configIssues = validateRoutingReferences(parsed.value);
		if (signature !== this.lastValidationSignature) {
			this.logConfigIssues(configIssues, signature);
		}

		if (this.providerCacheSignature !== signature) {
			this.providerCache.clear();
			this.observedTargetState.clear();
			this.observedAccountState.clear();
			this.providerCacheSignature = signature;
			this.resetRuntimeCaches();
		}

		return {
			ok: true,
			value: {
				config: parsed.value,
				signature,
				path,
				configIssues,
			},
		};
	}

	private logConfigIssues(issues: readonly RoutingValidationIssue[], signature: string): void {
		this.lastValidationSignature = signature;
		if (issues.length === 0) return;
		for (const issue of issues) {
			const data = { field: issue.field, ref: issue.ref };
			if (issue.severity === "error") {
				logger.error("inference", `Routing config error: ${issue.message}`, undefined, data);
			} else {
				logger.warn("inference", `Routing config warning: ${issue.message}`, data);
			}
		}
	}

	private logConfigError(
		error: { readonly message: string; readonly details?: Readonly<Record<string, unknown>> },
		signature: string,
	): void {
		if (signature === this.lastValidationSignature) return;
		this.lastValidationSignature = signature;
		logger.error(
			"inference",
			`Routing config failed to load: ${error.message}`,
			undefined,
			error.details as Record<string, unknown> | undefined,
		);
	}

	private resetRuntimeCaches(): void {
		this.runtimeCacheGeneration += 1;
		this.snapshotCache = null;
		this.snapshotFlights.clear();
	}

	private pruneObservedState(now = Date.now()): void {
		for (const [targetRef, entry] of this.observedTargetState.entries()) {
			if (entry.expiresAt <= now) this.observedTargetState.delete(targetRef);
		}
		for (const [accountId, entry] of this.observedAccountState.entries()) {
			if (entry.expiresAt <= now) this.observedAccountState.delete(accountId);
		}
	}

	private observedRuntimeStateForTarget(
		loaded: LoadedRoutingConfig,
		targetRef: string,
	): RoutingRuntimeState | undefined {
		this.pruneObservedState();
		const direct = this.observedTargetState.get(targetRef);
		if (direct) return direct.state;
		const parsed = parseRoutingTargetRef(targetRef);
		if (!parsed.ok) return undefined;
		const target = loaded.config.targets[parsed.value.targetId];
		if (!target?.account) return undefined;
		return this.observedAccountState.get(target.account)?.state;
	}

	private clearObservedRuntimeState(loaded: LoadedRoutingConfig, targetRef: string): void {
		let changed = this.observedTargetState.delete(targetRef);
		const parsed = parseRoutingTargetRef(targetRef);
		if (!parsed.ok) {
			if (changed) this.resetRuntimeCaches();
			return;
		}
		const target = loaded.config.targets[parsed.value.targetId];
		if (target?.account) {
			changed = this.observedAccountState.delete(target.account) || changed;
		}
		if (changed) this.resetRuntimeCaches();
	}

	private classifyObservedFailure(
		message: string,
		hasAccount: boolean,
	): { readonly state: RoutingRuntimeState; readonly ttlMs: number; readonly scope: "target" | "account" } | null {
		const lower = message.toLowerCase();
		if (
			lower.includes("http 429") ||
			lower.includes("rate limit") ||
			lower.includes("rate-limit") ||
			lower.includes("too many requests") ||
			lower.includes("quota") ||
			lower.includes("usage limit") ||
			lower.includes("http 402") ||
			lower.includes("payment required") ||
			lower.includes("insufficient credit") ||
			lower.includes("insufficient credits") ||
			lower.includes("credit balance") ||
			lower.includes("billing") ||
			lower.includes("balance")
		) {
			return {
				state: {
					available: false,
					health: "degraded",
					circuitOpen: false,
					accountState: "rate_limited",
					unavailableReason: message,
				},
				ttlMs: OBSERVED_RATE_LIMIT_TTL_MS,
				scope: hasAccount ? "account" : "target",
			};
		}
		if (
			lower.includes("http 401") ||
			lower.includes("http 403") ||
			lower.includes("unauthorized") ||
			lower.includes("forbidden") ||
			lower.includes("invalid api key") ||
			lower.includes("invalid key") ||
			lower.includes("expired session") ||
			lower.includes("authentication") ||
			lower.includes("auth failed")
		) {
			return {
				state: {
					available: false,
					health: "blocked",
					circuitOpen: false,
					accountState: "expired",
					unavailableReason: message,
				},
				ttlMs: OBSERVED_AUTH_TTL_MS,
				scope: hasAccount ? "account" : "target",
			};
		}
		if (lower.includes("missing credential") || lower.includes("api key") || lower.includes("credential")) {
			return {
				state: {
					available: false,
					health: "blocked",
					circuitOpen: false,
					accountState: "missing",
					unavailableReason: message,
				},
				ttlMs: OBSERVED_MISSING_TTL_MS,
				scope: hasAccount ? "account" : "target",
			};
		}
		return null;
	}

	private observeExecutionFailure(loaded: LoadedRoutingConfig, targetRef: string, error: string): void {
		const parsed = parseRoutingTargetRef(targetRef);
		if (!parsed.ok) return;
		const target = loaded.config.targets[parsed.value.targetId];
		if (!target) return;
		const classified = this.classifyObservedFailure(error, Boolean(target.account));
		if (!classified) return;
		const expiresAt = Date.now() + classified.ttlMs;
		if (classified.scope === "account" && target.account) {
			this.observedAccountState.set(target.account, { state: classified.state, expiresAt });
		} else {
			this.observedTargetState.set(targetRef, { state: classified.state, expiresAt });
		}
		this.resetRuntimeCaches();
	}

	async hasExplicitRouting(): Promise<boolean> {
		const loaded = await this.loadConfig();
		return loaded.ok && loaded.value.config.source === "explicit" && loaded.value.config.enabled;
	}

	async hasWorkload(operation: RoutingOperationKind): Promise<boolean> {
		const loaded = await this.loadConfig();
		if (!loaded.ok || !loaded.value.config.enabled) return false;
		const config = loaded.value.config;
		switch (operation) {
			case "memory_extraction":
				return Boolean(config.workloads?.memoryExtraction ?? config.workloads?.default ?? config.defaultPolicy);
			case "session_synthesis":
				return Boolean(config.workloads?.memoryExtraction ?? config.workloads?.default ?? config.defaultPolicy);
			case "widget_generation":
				return Boolean(
					config.workloads?.widgetGeneration ??
						config.workloads?.memoryExtraction ??
						config.workloads?.default ??
						config.defaultPolicy,
				);
			case "repair":
				return Boolean(
					config.workloads?.repair ??
						config.workloads?.memoryExtraction ??
						config.workloads?.default ??
						config.defaultPolicy,
				);
			case "default":
				return Boolean(config.workloads?.default ?? config.defaultPolicy);
			default:
				return Boolean(config.workloads?.interactive ?? config.workloads?.default ?? config.defaultPolicy);
		}
	}

	private async resolveCredential(
		account: RoutingAccountConfig | undefined,
	): Promise<ResolvedInferenceCredential | undefined> {
		if (isOAuthBackedAccount(account)) {
			const oauth = await resolveOAuthCredential(account.providerFamily);
			if (oauth) return { apiKey: oauth.apiKey, oauthCredentials: oauth.credentials };
		}
		const credentialRef = account?.credentialRef;
		if (!credentialRef) return undefined;
		const envValue = process.env[credentialRef];
		if (typeof envValue === "string" && envValue.trim().length > 0) {
			return { apiKey: envValue.trim() };
		}
		try {
			return { apiKey: await getSecret(credentialRef) };
		} catch {
			return undefined;
		}
	}

	private async createProvider(
		loaded: LoadedRoutingConfig,
		targetId: string,
		modelId: string,
		acpxHooks?: AcpxHooksMode,
		acpxExtraArgs?: readonly string[],
	): Promise<StreamCapableLlmProvider> {
		const cacheKey = `${loaded.signature}:${targetId}/${modelId}:${acpxHooks ?? "configured-hooks"}`;
		const target = loaded.config.targets[targetId];
		const account = target?.account ? loaded.config.accounts[target.account] : undefined;
		const oauthBacked = isOAuthBackedAccount(account);
		if (!oauthBacked && !acpxExtraArgs) {
			const cached = this.providerCache.get(cacheKey);
			if (cached) return cached;
		}

		const build = (async (): Promise<StreamCapableLlmProvider> => {
			return createRoutingProvider({
				config: loaded.config,
				targetId,
				modelId,
				acpxHooks,
				acpxExtraArgs,
				claudeCode: loadMemoryConfig(this.agentsDir).pipelineV2.claudeCode,
				resolveCredential: (candidateAccount) => this.resolveCredential(candidateAccount),
			});
		})();

		if (!oauthBacked && !acpxExtraArgs) this.providerCache.set(cacheKey, build);
		return build;
	}

	private async runtimeStateForTarget(loaded: LoadedRoutingConfig, targetRef: string): Promise<RoutingRuntimeState> {
		const observed = this.observedRuntimeStateForTarget(loaded, targetRef);
		if (observed) return observed;
		const parsed = parseRoutingTargetRef(targetRef);
		if (!parsed.ok) {
			return {
				available: false,
				health: "blocked",
				circuitOpen: false,
				accountState: "missing",
				unavailableReason: parsed.error.message,
			};
		}
		const target = loaded.config.targets[parsed.value.targetId];
		const model = target?.models[parsed.value.modelId];
		if (!target || !model) {
			return {
				available: false,
				health: "blocked",
				circuitOpen: false,
				accountState: "missing",
				unavailableReason: "target not found",
			};
		}
		const account = target.account ? loaded.config.accounts[target.account] : undefined;
		const oauthCredentialAccount = isOAuthBackedAccount(account);
		const needsCredential =
			oauthCredentialAccount ||
			target.executor === "anthropic" ||
			target.executor === "openrouter" ||
			(target.executor === "openai-compatible" && !isLocalInferenceEndpoint(target.endpoint));
		if (target.account && !account) {
			return {
				available: false,
				health: "blocked",
				circuitOpen: false,
				accountState: "missing",
				unavailableReason: `account ${target.account} not found`,
			};
		}
		if (needsCredential) {
			const credential = await this.resolveCredential(account);
			if (!credential) {
				return {
					available: false,
					health: "blocked",
					circuitOpen: false,
					accountState: target.kind === "subscription_session" ? "expired" : "missing",
					unavailableReason: `missing credential${target.account ? ` for ${target.account}` : ""}`,
				};
			}
		}

		try {
			const provider = await this.createProvider(loaded, parsed.value.targetId, parsed.value.modelId);
			const available = await provider.available();
			return {
				available,
				health: available ? "healthy" : "blocked",
				circuitOpen: false,
				accountState: available ? "ready" : target.kind === "subscription_session" ? "expired" : "unknown",
				...(available ? {} : { unavailableReason: "executor unavailable" }),
			};
		} catch (error) {
			return {
				available: false,
				health: "blocked",
				circuitOpen: false,
				accountState: target.kind === "subscription_session" ? "expired" : needsCredential ? "missing" : "unknown",
				unavailableReason: formatExecutionError(error),
			};
		}
	}

	invalidateCredentialState(): void {
		this.providerCache.clear();
		this.observedTargetState.clear();
		this.observedAccountState.clear();
		this.resetRuntimeCaches();
	}

	private async runtimeSnapshot(loaded: LoadedRoutingConfig, refresh = false): Promise<RoutingRuntimeSnapshot> {
		if (
			!refresh &&
			this.snapshotCache &&
			this.snapshotCache.signature === loaded.signature &&
			this.snapshotCache.expiresAt > Date.now()
		) {
			return this.snapshotCache.snapshot;
		}

		const existingFlight = this.snapshotFlights.get(loaded.signature);
		if (existingFlight) return existingFlight;

		const generation = this.runtimeCacheGeneration;
		const build = (async (): Promise<RoutingRuntimeSnapshot> => {
			const entries = await Promise.all(
				allTargetRefs(loaded.config).map(async (targetRef) => {
					const state = await this.runtimeStateForTarget(loaded, targetRef);
					return [targetRef, state] as const;
				}),
			);
			const snapshot: RoutingRuntimeSnapshot = {
				targets: Object.fromEntries(entries),
			};
			if (generation === this.runtimeCacheGeneration) {
				this.snapshotCache = {
					signature: loaded.signature,
					expiresAt: Date.now() + SNAPSHOT_TTL_MS,
					snapshot,
				};
			}
			return snapshot;
		})();
		this.snapshotFlights.set(loaded.signature, build);
		const clearFlight = (): void => {
			if (this.snapshotFlights.get(loaded.signature) === build) {
				this.snapshotFlights.delete(loaded.signature);
			}
		};
		void build.then(clearFlight, clearFlight);
		return build;
	}

	async explain(request: RouteRequest, refresh = false): Promise<RouterResult<RouteDecision>> {
		const loaded = await this.loadConfig(refresh);
		if (!loaded.ok) return loaded;
		const snapshot = await this.runtimeSnapshot(loaded.value, refresh);
		return resolveRoutingDecision(
			loaded.value.config,
			{
				...request,
				agentId: request.agentId ?? defaultAgentIdForConfig(loaded.value.config),
			},
			snapshot,
		);
	}

	async execute(
		request: RouteRequest,
		prompt: string,
		opts?: {
			readonly timeoutMs?: number;
			readonly maxTokens?: number;
			readonly refresh?: boolean;
			readonly acpxHooks?: AcpxHooksMode;
			readonly signal?: AbortSignal;
			readonly abortSignal?: AbortSignal;
		},
	): Promise<RouterResult<InferenceExecutionResult>> {
		const background = this.beginBackgroundExecution(request.operation, request.agentId, "inference");
		if (background === null) {
			return {
				ok: false,
				error: { code: "execution-failed", message: "Background inference is paused." },
			};
		}
		const callerSignal = opts?.signal ?? opts?.abortSignal;
		const signal = background
			? callerSignal
				? AbortSignal.any([background.signal, callerSignal])
				: background.signal
			: callerSignal;
		try {
			return await this.executeRouted(request, prompt, { ...opts, signal });
		} finally {
			this.finishBackgroundExecution(background?.id);
		}
	}

	/**
	 * Run a daemon-owned bounded tool session through the same routing policy as
	 * ordinary inference. Only Pi-backed targets can execute in-process tools;
	 * ACPX gets its equivalent MCP binding rather than a fake text fallback.
	 */
	async runAgent(
		request: RouteRequest,
		prompt: string,
		tools: readonly ToolDefinition[],
		opts?: {
			readonly timeoutMs?: number;
			readonly maxTokens?: number;
			readonly refresh?: boolean;
			readonly acpxMcp?: {
				readonly agentId: string;
				readonly passId: string;
				readonly daemonUrl: string;
				readonly authorizationToken?: string;
			};
		},
	): Promise<RouterResult<InferenceAgentExecutionResult>> {
		const background = this.beginBackgroundExecution(request.operation, request.agentId, "agent");
		if (background === null) {
			return { ok: false, error: { code: "execution-failed", message: "Background inference is paused." } };
		}
		const backgroundExecutionId = background?.id;
		try {
			const loaded = await this.loadConfig(opts?.refresh ?? false);
			if (!loaded.ok) return loaded;
			const decision = await this.explain(request, false);
			if (!decision.ok) return decision;
			const attempts: InferenceExecutionAttempt[] = [];
			for (const targetRef of [decision.value.targetRef, ...decision.value.fallbackTargetRefs]) {
				const parsed = parseRoutingTargetRef(targetRef);
				if (!parsed.ok) {
					attempts.push({ targetRef, ok: false, durationMs: 0, error: parsed.error.message });
					continue;
				}
				const startedAt = Date.now();
				let mcpConfig: ReturnType<typeof createDreamingAcpxMcpConfig> | undefined;
				try {
					const target = loaded.value.config.targets[parsed.value.targetId];
					if (target?.executor === "acpx") {
						if (!opts?.acpxMcp) {
							throw new Error("ACPX agent target requires the scoped Signet MCP binding");
						}
						mcpConfig = createDreamingAcpxMcpConfig(opts.acpxMcp);
					}
					const provider = await this.createProvider(
						loaded.value,
						parsed.value.targetId,
						parsed.value.modelId,
						undefined,
						mcpConfig ? ["--mcp-config", mcpConfig.path] : undefined,
					);
					if (!isPiAgentSessionProvider(provider)) {
						const generated = await provider.generate(prompt, {
							timeoutMs: opts?.timeoutMs,
							maxTokens: opts?.maxTokens,
						});
						if (!generated.trim()) throw new Error("ACPX agent returned no completion");
						this.clearObservedRuntimeState(loaded.value, targetRef);
						attempts.push({ targetRef, ok: true, durationMs: Date.now() - startedAt, usage: null });
						return {
							ok: true,
							value: {
								decision: decision.value,
								attempts,
								attribution: attributionForTarget(loaded.value, parsed.value.targetId, parsed.value.modelId),
							},
						};
					}
					const deadlineMs = opts?.timeoutMs ?? provider.agentSessionTimeoutMs;
					const deadline = deadlineMs > 0 ? performance.now() + deadlineMs : undefined;
					let sessionUsage: LlmUsage | null = null;
					const release = await acquireLlmConcurrencyPermit(deadlineMs > 0 ? deadlineMs : undefined, "pi-agent");
					let session: PiAgentSession | undefined;
					let releaseDeferred = false;
					try {
						session = await provider.createAgentSession(tools, { maxTokens: opts?.maxTokens });
						// AgentSession owns an internal model loop, so acquire the
						// process-wide permit before initialization and hold it until
						// the whole session is disposed. This prevents tool-driven
						// Pi turns from multiplying concurrency outside the canonical
						// provider boundary, including cancellation cleanup.
						const remainingMs = deadline === undefined ? undefined : deadline - performance.now();
						if (remainingMs !== undefined && remainingMs <= 0) {
							throw new Error(`Agent session exceeded the ${deadlineMs}ms deadline`);
						}
						try {
							await promptPiAgentSession(session, prompt, remainingMs);
						} catch (error) {
							if (error instanceof PiAgentSessionTimeoutError) {
								releaseDeferred = true;
								void error.cleanup.finally(() => {
									try {
										session?.dispose();
									} finally {
										release();
									}
								});
							}
							throw error;
						}
						const failure = session.getFailureMessage();
						if (failure) throw new Error(failure);
						// Read the session aggregate before dispose() tears the
						// in-memory entries down. getStats is the only way to
						// capture provider-reported tokens for the agentic loop.
						sessionUsage = mapSessionStatsToUsage(
							session.getStats(),
							Date.now() - startedAt,
							provider.accountingProvenance ?? "unavailable",
						);
					} finally {
						if (!releaseDeferred) {
							try {
								session?.dispose();
							} finally {
								release();
							}
						}
					}
					this.clearObservedRuntimeState(loaded.value, targetRef);
					attempts.push({ targetRef, ok: true, durationMs: Date.now() - startedAt, usage: sessionUsage });
					return {
						ok: true,
						value: {
							decision: decision.value,
							attempts,
							attribution: attributionForTarget(loaded.value, parsed.value.targetId, parsed.value.modelId),
						},
					};
				} catch (error) {
					const message = formatExecutionError(error);
					this.observeExecutionFailure(loaded.value, targetRef, message);
					attempts.push({ targetRef, ok: false, durationMs: Date.now() - startedAt, error: message });
				} finally {
					mcpConfig?.dispose();
				}
			}
			return {
				ok: false,
				error: { code: "execution-failed", message: "All routed agent targets failed.", details: { attempts } },
			};
		} finally {
			this.finishBackgroundExecution(backgroundExecutionId);
		}
	}

	private async executeRouted(
		request: RouteRequest,
		prompt: string,
		opts?: {
			readonly timeoutMs?: number;
			readonly maxTokens?: number;
			readonly refresh?: boolean;
			readonly acpxHooks?: AcpxHooksMode;
			readonly signal?: AbortSignal;
		},
	): Promise<RouterResult<InferenceExecutionResult>> {
		const loaded = await this.loadConfig(opts?.refresh ?? false);
		if (!loaded.ok) return loaded;
		const decision = await this.explain(request, false);
		if (!decision.ok) return decision;
		const attempts: InferenceExecutionAttempt[] = [];
		for (const targetRef of [decision.value.targetRef, ...decision.value.fallbackTargetRefs]) {
			if (opts?.signal?.aborted) break;
			const parsed = parseRoutingTargetRef(targetRef);
			if (!parsed.ok) {
				attempts.push({
					targetRef,
					ok: false,
					durationMs: 0,
					error: parsed.error.message,
				});
				continue;
			}
			const startedAt = Date.now();
			const observed = this.observedRuntimeStateForTarget(loaded.value, targetRef);
			if (observed && isRuntimeBlocked(observed)) {
				attempts.push({
					targetRef,
					ok: false,
					durationMs: 0,
					error: observed.unavailableReason ?? `account state ${observed.accountState}`,
				});
				continue;
			}
			try {
				const provider = await this.createProvider(
					loaded.value,
					parsed.value.targetId,
					parsed.value.modelId,
					opts?.acpxHooks,
				);
				const result = await generateWithTracking(provider, prompt, {
					timeoutMs: opts?.timeoutMs,
					maxTokens: opts?.maxTokens,
					signal: opts?.signal,
					// aggregate_recall is latency-sensitive (the routing engine already
					// excludes ACPX subprocesses for it). Suppress thinking for the same
					// reason: thinking tokens would dominate the synthesis budget.
					reasoning: request.operation === "aggregate_recall" ? false : undefined,
				});
				this.clearObservedRuntimeState(loaded.value, targetRef);
				attempts.push({
					targetRef,
					ok: true,
					durationMs: Date.now() - startedAt,
					usage: result.usage,
				});
				return {
					ok: true,
					value: {
						text: result.text,
						usage: result.usage,
						decision: decision.value,
						attempts,
					},
				};
			} catch (error) {
				const message = formatExecutionError(error);
				logger.warn("inference", `Inference target ${targetRef} failed`, {
					targetRef,
					error: message.slice(0, 200),
				});
				this.observeExecutionFailure(loaded.value, targetRef, message);
				attempts.push({
					targetRef,
					ok: false,
					durationMs: Date.now() - startedAt,
					error: message,
				});
				if (opts?.signal?.aborted || error instanceof PiProviderDeadlineError) break;
			}
		}
		return {
			ok: false,
			error: {
				code: "execution-failed",
				message: "All routed targets failed.",
				details: { attempts },
			},
		};
	}

	async stream(
		request: RouteRequest,
		prompt: string,
		opts?: {
			readonly timeoutMs?: number;
			readonly maxTokens?: number;
			readonly refresh?: boolean;
			readonly abortSignal?: AbortSignal;
		},
	): Promise<RouterResult<InferenceStreamResult>> {
		const loaded = await this.loadConfig(opts?.refresh ?? false);
		if (!loaded.ok) return loaded;
		const decision = await this.explain(
			{
				...request,
				requireStreaming: true,
			},
			false,
		);
		if (!decision.ok) return decision;

		const attempts: InferenceExecutionAttempt[] = [];
		for (const targetRef of [decision.value.targetRef, ...decision.value.fallbackTargetRefs]) {
			const parsed = parseRoutingTargetRef(targetRef);
			if (!parsed.ok) {
				attempts.push({
					targetRef,
					ok: false,
					durationMs: 0,
					error: parsed.error.message,
				});
				continue;
			}

			const startedAt = Date.now();
			const observed = this.observedRuntimeStateForTarget(loaded.value, targetRef);
			if (observed && isRuntimeBlocked(observed)) {
				attempts.push({
					targetRef,
					ok: false,
					durationMs: 0,
					error: observed.unavailableReason ?? `account state ${observed.accountState}`,
				});
				continue;
			}
			try {
				const provider = await this.createProvider(loaded.value, parsed.value.targetId, parsed.value.modelId);
				if (!provider.streamWithUsage) {
					attempts.push({
						targetRef,
						ok: false,
						durationMs: Date.now() - startedAt,
						error: "target does not support streaming execution",
					});
					continue;
				}

				const upstream = await provider.streamWithUsage(prompt, {
					timeoutMs: opts?.timeoutMs,
					maxTokens: opts?.maxTokens,
					abortSignal: opts?.abortSignal,
					// aggregate_recall is latency-sensitive: suppress thinking tokens
					// (mirrors the execute path and the routing engine's ACPX exclusion).
					reasoning: request.operation === "aggregate_recall" ? false : undefined,
				});

				const router = this;
				const stream = new ReadableStream<InferenceStreamEvent>({
					start(controller) {
						let partialText = "";
						let finished = false;
						const reader = upstream.stream.getReader();

						const closeWith = (event: InferenceStreamEvent): void => {
							if (finished) return;
							finished = true;
							controller.enqueue(event);
							controller.close();
						};

						const failAttempt = (error: string): void => {
							attempts.push({
								targetRef,
								ok: false,
								durationMs: Date.now() - startedAt,
								error,
							});
						};

						const pump = async (): Promise<void> => {
							try {
								while (true) {
									const next = await reader.read();
									if (next.done) {
										router.clearObservedRuntimeState(loaded.value, targetRef);
										attempts.push({
											targetRef,
											ok: true,
											durationMs: Date.now() - startedAt,
											usage: null,
										});
										closeWith({
											type: "done",
											text: partialText,
											usage: null,
											decision: decision.value,
											attempts: cloneAttempts(attempts),
										});
										return;
									}

									const event = next.value as LlmProviderStreamEvent;
									if (event.type === "text-delta") {
										partialText += event.text;
										controller.enqueue({ type: "delta", text: event.text });
										continue;
									}

									router.clearObservedRuntimeState(loaded.value, targetRef);
									attempts.push({
										targetRef,
										ok: true,
										durationMs: Date.now() - startedAt,
										usage: event.usage,
									});
									closeWith({
										type: "done",
										text: event.text,
										usage: event.usage,
										decision: decision.value,
										attempts: cloneAttempts(attempts),
									});
									return;
								}
							} catch (error) {
								const message = formatExecutionError(error);
								if (isAbortLikeError(error) || opts?.abortSignal?.aborted) {
									failAttempt(message || "stream cancelled");
									closeWith({
										type: "cancelled",
										partialText,
										decision: decision.value,
										attempts: cloneAttempts(attempts),
									});
									return;
								}

								logger.warn("inference", `Inference target ${targetRef} stream failed`, {
									targetRef,
									error: message.slice(0, 200),
								});
								router.observeExecutionFailure(loaded.value, targetRef, message);
								failAttempt(message);
								closeWith({
									type: "error",
									error: message,
									partialText,
									decision: decision.value,
									attempts: cloneAttempts(attempts),
								});
							} finally {
								reader.releaseLock();
							}
						};

						void pump();
					},
					cancel(reason) {
						upstream.cancel(typeof reason === "string" ? reason : "client disconnected");
					},
				});

				return {
					ok: true,
					value: {
						decision: decision.value,
						stream,
						cancel(reason?: string) {
							upstream.cancel(reason);
						},
					},
				};
			} catch (error) {
				const message = formatExecutionError(error);
				logger.warn("inference", `Inference target ${targetRef} failed to start stream`, {
					targetRef,
					error: message.slice(0, 200),
				});
				this.observeExecutionFailure(loaded.value, targetRef, message);
				attempts.push({
					targetRef,
					ok: false,
					durationMs: Date.now() - startedAt,
					error: message,
				});
			}
		}

		return {
			ok: false,
			error: {
				code: "execution-failed",
				message: "All routed streaming targets failed.",
				details: { attempts },
			},
		};
	}

	createWorkloadProvider(operation: RoutingOperationKind, defaultAgentId?: string): LlmProvider {
		const router = this;
		return {
			name: `routing:${operation}`,
			async generate(prompt, opts): Promise<string> {
				const result = await router.execute(
					{
						agentId: defaultAgentId,
						operation,
						promptPreview: normalizePromptPreview(prompt),
					},
					prompt,
					opts,
				);
				if (!result.ok) {
					throw new Error(result.error.message);
				}
				return result.value.text;
			},
			async generateWithUsage(prompt, opts): Promise<LlmGenerateResult> {
				const result = await router.execute(
					{
						agentId: defaultAgentId,
						operation,
						promptPreview: normalizePromptPreview(prompt),
					},
					prompt,
					opts,
				);
				if (!result.ok) {
					throw new Error(result.error.message);
				}
				return { text: result.value.text, usage: result.value.usage };
			},
			async available(): Promise<boolean> {
				return router.hasWorkload(operation);
			},
		};
	}

	async status(refresh = false): Promise<RouterResult<InferenceStatusSummary>> {
		const loaded = await this.loadConfig(refresh);
		if (!loaded.ok) return loaded;
		const snapshot = await this.runtimeSnapshot(loaded.value, refresh);
		const accounts = Object.fromEntries(
			Object.entries(loaded.value.config.accounts).map(([accountId, account]) => [
				accountId,
				{
					kind: account.kind,
					providerFamily: account.providerFamily,
					...(account.label ? { label: account.label } : {}),
				},
			]),
		) as Record<string, InferenceAccountSummary>;
		const targets = Object.fromEntries(
			Object.entries(loaded.value.config.targets).map(([targetId, target]) => [
				targetId,
				{
					kind: target.kind,
					executor: target.executor,
					...(target.acpx
						? {
								acpx: {
									agent: target.acpx.agent,
									modelSelection: resolveAcpxModelSelection(target.acpx.agent, target.acpx.modelSelection),
								},
							}
						: {}),
					...(target.account ? { account: target.account } : {}),
					...(target.privacy ? { privacy: target.privacy } : {}),
					models: Object.fromEntries(
						Object.entries(target.models).map(([modelId, model]) => [
							modelId,
							{ model: model.model, ...(model.label ? { label: model.label } : {}) },
						]),
					),
				},
			]),
		) as Record<string, InferenceTargetSummary>;
		return {
			ok: true,
			value: {
				enabled: loaded.value.config.enabled,
				source: loaded.value.config.enabled ? loaded.value.config.source : "disabled",
				...(loaded.value.config.defaultPolicy ? { defaultPolicy: loaded.value.config.defaultPolicy } : {}),
				defaultAgentId: defaultAgentIdForConfig(loaded.value.config),
				policies: Object.keys(loaded.value.config.policies),
				taskClasses: Object.keys(loaded.value.config.taskClasses),
				targetRefs: allTargetRefs(loaded.value.config),
				workloadBindings: {
					default: loaded.value.config.workloads?.default?.policy ?? loaded.value.config.workloads?.default?.target,
					interactive:
						loaded.value.config.workloads?.interactive?.policy ?? loaded.value.config.workloads?.interactive?.target,
					memoryExtraction:
						loaded.value.config.workloads?.memoryExtraction?.policy ??
						loaded.value.config.workloads?.memoryExtraction?.target,
					aggregateRecall:
						loaded.value.config.workloads?.aggregateRecall?.policy ??
						loaded.value.config.workloads?.aggregateRecall?.target,
					widgetGeneration:
						loaded.value.config.workloads?.widgetGeneration?.policy ??
						loaded.value.config.workloads?.widgetGeneration?.target,
					repair: loaded.value.config.workloads?.repair?.policy ?? loaded.value.config.workloads?.repair?.target,
				},
				accounts,
				targets,
				agents: Object.keys(loaded.value.config.agents),
				configIssues: loaded.value.configIssues,
				runtimeSnapshot: snapshot,
			},
		};
	}

	async gatewayModels(refresh = false): Promise<RouterResult<readonly string[]>> {
		const status = await this.status(refresh);
		if (!status.ok) return status;
		return {
			ok: true,
			value: [
				"signet:auto",
				...status.value.policies.map((policyId) => `policy:${policyId}`),
				...status.value.targetRefs,
			],
		};
	}

	parseGatewayModel(model: string | undefined): Pick<RouteRequest, "explicitPolicy" | "explicitTargets"> {
		const trimmed = model?.trim();
		if (!trimmed || trimmed === "signet:auto" || trimmed === "auto") return {};
		if (trimmed.startsWith("policy:")) {
			return { explicitPolicy: trimmed.slice("policy:".length) };
		}
		if (trimmed.includes("/")) {
			return { explicitTargets: [trimmed] };
		}
		return {};
	}

	buildGatewayPrompt(messages: ReadonlyArray<{ readonly role: string; readonly content: string }>): string {
		return buildPromptFromMessages(messages);
	}
}

let inferenceRouter: InferenceRouter | null = null;
let inferenceRouterAgentsDir: string | null = null;

export function getOrCreateInferenceRouter(agentsDir: string): InferenceRouter {
	if (!inferenceRouter || inferenceRouterAgentsDir !== agentsDir) {
		inferenceRouter = new InferenceRouter(agentsDir);
		inferenceRouterAgentsDir = agentsDir;
	}
	return inferenceRouter;
}

export function getInferenceRouterOrNull(): InferenceRouter | null {
	return inferenceRouter;
}

export function resetInferenceRouterForTests(): void {
	inferenceRouter = null;
	inferenceRouterAgentsDir = null;
}
