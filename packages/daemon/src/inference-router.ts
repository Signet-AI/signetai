import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
	LlmGenerateResult,
	LlmProvider,
	LlmUsage,
	RouteDecision,
	RouteRequest,
	RouterResult,
	RoutingConfig,
	RoutingOperationKind,
	RoutingRuntimeSnapshot,
	RoutingRuntimeState,
} from "@signet/core";
import {
	allTargetRefs,
	compileLegacyRoutingConfig,
	parseRoutingConfig,
	parseRoutingTargetRef,
	parseYamlDocument,
	resolveRoutingDecision,
} from "@signet/core";
import { logger } from "./logger";
import { loadMemoryConfig } from "./memory-config";
import {
	type LlmProviderStreamEvent,
	type LlmProviderStreamResult,
	type StreamCapableLlmProvider,
	createAnthropicProvider,
	createClaudeCodeProvider,
	createCodexProvider,
	createCommandLineProvider,
	createOllamaProvider,
	createOpenAiCompatibleProvider,
	createOpenCodeProvider,
	createOpenRouterProvider,
	generateWithTracking,
} from "./pipeline/provider";
import { resolveDefaultOllamaFallbackMaxContextTokens } from "./pipeline/provider";
import { getSecret } from "./secrets";

const SNAPSHOT_TTL_MS = 15_000;
const DEFAULT_OPENCODE_BASE_URL = "http://127.0.0.1:4096";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_LLAMA_CPP_BASE_URL = "http://127.0.0.1:8080";
const OBSERVED_RATE_LIMIT_TTL_MS = 60_000;
const OBSERVED_AUTH_TTL_MS = 5 * 60_000;
const OBSERVED_MISSING_TTL_MS = 60_000;
const REDACTED_UPSTREAM_DETAIL = "[redacted upstream detail]";

function withOpenAiVersionPath(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (trimmed.endsWith("/v1")) return trimmed;
	return `${trimmed}/v1`;
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
		readonly sessionSynthesis?: string;
		readonly widgetGeneration?: string;
		readonly repair?: string;
	};
	readonly accounts: Readonly<Record<string, InferenceAccountSummary>>;
	readonly targets: Readonly<Record<string, InferenceTargetSummary>>;
	readonly agents: readonly string[];
	readonly runtimeSnapshot: RoutingRuntimeSnapshot;
}

interface LoadedRoutingConfig {
	readonly config: RoutingConfig;
	readonly signature: string;
	readonly path: string | null;
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

function isLocalBaseUrl(value: string | undefined): boolean {
	if (!value) return true;
	try {
		const url = new URL(value);
		return ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
	} catch {
		return false;
	}
}

function normalizePromptPreview(prompt: string): string {
	return prompt.slice(0, 8000);
}

function readInferencePath(agentsDir: string): string | null {
	for (const name of ["agent.yaml", "AGENT.yaml"]) {
		const path = join(agentsDir, name);
		if (existsSync(path)) return path;
	}
	return null;
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

function buildPromptFromMessages(messages: ReadonlyArray<{ readonly role: string; readonly content: string }>): string {
	return messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
}

export class InferenceRouter {
	private snapshotCache: SnapshotCacheEntry | null = null;
	private readonly providerCache = new Map<string, Promise<StreamCapableLlmProvider>>();
	private readonly observedTargetState = new Map<string, ObservedRuntimeOverride>();
	private readonly observedAccountState = new Map<string, ObservedRuntimeOverride>();
	private providerCacheSignature: string | null = null;

	constructor(private readonly agentsDir: string) {}

	private async loadConfig(): Promise<RouterResult<LoadedRoutingConfig>> {
		let raw: unknown = {};
		const path = readInferencePath(this.agentsDir);
		let signature = "no-config";
		if (path) {
			try {
				const stat = statSync(path);
				signature = `${path}:${stat.mtimeMs}:${stat.size}`;
				raw = parseYamlDocument(readFileSync(path, "utf-8"));
			} catch (error) {
				return {
					ok: false,
					error: {
						code: "invalid-config",
						message: `Failed to parse inference config: ${formatExecutionError(error)}`,
					},
				};
			}
		}

		let legacy: RoutingConfig;
		try {
			const memoryCfg = loadMemoryConfig(this.agentsDir);
			legacy = compileLegacyRoutingConfig({
				extraction: memoryCfg.pipelineV2.extraction,
				synthesis: memoryCfg.pipelineV2.synthesis,
			});
		} catch (error) {
			return {
				ok: false,
				error: {
					code: "invalid-config",
					message: `Failed to resolve legacy inference config: ${formatExecutionError(error)}`,
				},
			};
		}

		const parsed = parseRoutingConfig(raw, legacy);
		if (!parsed.ok) return parsed;

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
			},
		};
	}

	private resetRuntimeCaches(): void {
		this.snapshotCache = null;
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
			lower.includes("usage limit")
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
				return Boolean(config.workloads?.sessionSynthesis ?? config.workloads?.default ?? config.defaultPolicy);
			case "widget_generation":
				return Boolean(
					config.workloads?.widgetGeneration ??
						config.workloads?.sessionSynthesis ??
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

	private async resolveCredential(credentialRef: string | undefined): Promise<string | undefined> {
		if (!credentialRef) return undefined;
		const envValue = process.env[credentialRef];
		if (typeof envValue === "string" && envValue.trim().length > 0) {
			return envValue.trim();
		}
		try {
			return await getSecret(credentialRef);
		} catch {
			return undefined;
		}
	}

	private async createProvider(
		loaded: LoadedRoutingConfig,
		targetId: string,
		modelId: string,
	): Promise<StreamCapableLlmProvider> {
		const cacheKey = `${loaded.signature}:${targetId}/${modelId}`;
		const cached = this.providerCache.get(cacheKey);
		if (cached) return cached;

		const build = (async (): Promise<StreamCapableLlmProvider> => {
			const target = loaded.config.targets[targetId];
			const model = target?.models[modelId];
			if (!target || !model) {
				throw new Error(`Unknown routing target ${targetId}/${modelId}`);
			}
			const account = target.account ? loaded.config.accounts[target.account] : undefined;
			const credential = await this.resolveCredential(account?.credentialRef);
			switch (target.executor) {
				case "anthropic":
					if (!credential) throw new Error(`Missing credential for account ${target.account ?? "anthropic"}`);
					return createAnthropicProvider({
						model: model.model,
						apiKey: credential,
						baseUrl: target.endpoint ?? "https://api.anthropic.com",
					});
				case "openrouter":
					if (!credential) throw new Error(`Missing credential for account ${target.account ?? "openrouter"}`);
					return createOpenRouterProvider({
						model: model.model,
						apiKey: credential,
						baseUrl: target.endpoint ?? "https://openrouter.ai/api/v1",
						referer: process.env.OPENROUTER_HTTP_REFERER,
						title: process.env.OPENROUTER_TITLE,
					});
				case "ollama":
					return createOllamaProvider({
						model: model.model,
						baseUrl: target.endpoint ?? DEFAULT_OLLAMA_BASE_URL,
					});
				case "claude-code":
					return createClaudeCodeProvider({ model: model.model });
				case "codex":
					return createCodexProvider({ model: model.model });
				case "opencode":
					return createOpenCodeProvider({
						model: model.model,
						baseUrl: target.endpoint ?? DEFAULT_OPENCODE_BASE_URL,
						ollamaFallbackBaseUrl: DEFAULT_OLLAMA_BASE_URL,
						ollamaFallbackMaxContextTokens: resolveDefaultOllamaFallbackMaxContextTokens(),
					});
				case "openai-compatible":
					return createOpenAiCompatibleProvider({
						name: `openai-compatible:${model.model}`,
						model: model.model,
						baseUrl: target.endpoint ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
						apiKey: credential,
						defaultTimeoutMs: 60_000,
					});
				case "llama-cpp":
					return createOpenAiCompatibleProvider({
						name: `llama-cpp:${model.model}`,
						model: model.model,
						baseUrl: withOpenAiVersionPath(target.endpoint ?? DEFAULT_LLAMA_CPP_BASE_URL),
						apiKey: credential,
						defaultTimeoutMs: 60_000,
					});
				case "command": {
					if (!target.command) throw new Error(`Missing command config for target ${targetId}`);
					return createCommandLineProvider({
						name: `command:${targetId}`,
						bin: target.command.bin,
						args: target.command.args,
						cwd: target.command.cwd,
						env: target.command.env,
						defaultTimeoutMs: 60_000,
					});
				}
			}
		})();

		this.providerCache.set(cacheKey, build);
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
		const needsCredential =
			target.executor === "anthropic" ||
			target.executor === "openrouter" ||
			(target.executor === "openai-compatible" && !isLocalBaseUrl(target.endpoint));
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
			const credential = await this.resolveCredential(account?.credentialRef);
			if (!credential) {
				return {
					available: false,
					health: "blocked",
					circuitOpen: false,
					accountState: "missing",
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

	private async runtimeSnapshot(loaded: LoadedRoutingConfig, refresh = false): Promise<RoutingRuntimeSnapshot> {
		if (
			!refresh &&
			this.snapshotCache &&
			this.snapshotCache.signature === loaded.signature &&
			this.snapshotCache.expiresAt > Date.now()
		) {
			return this.snapshotCache.snapshot;
		}
		const entries = await Promise.all(
			allTargetRefs(loaded.config).map(async (targetRef) => {
				const state = await this.runtimeStateForTarget(loaded, targetRef);
				return [targetRef, state] as const;
			}),
		);
		const snapshot: RoutingRuntimeSnapshot = {
			targets: Object.fromEntries(entries),
		};
		this.snapshotCache = {
			signature: loaded.signature,
			expiresAt: Date.now() + SNAPSHOT_TTL_MS,
			snapshot,
		};
		return snapshot;
	}

	async explain(request: RouteRequest, refresh = false): Promise<RouterResult<RouteDecision>> {
		const loaded = await this.loadConfig();
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
		opts?: { readonly timeoutMs?: number; readonly maxTokens?: number; readonly refresh?: boolean },
	): Promise<RouterResult<InferenceExecutionResult>> {
		const loaded = await this.loadConfig();
		if (!loaded.ok) return loaded;
		const decision = await this.explain(request, opts?.refresh ?? false);
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
				const result = await generateWithTracking(provider, prompt, {
					timeoutMs: opts?.timeoutMs,
					maxTokens: opts?.maxTokens,
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
		const loaded = await this.loadConfig();
		if (!loaded.ok) return loaded;
		const decision = await this.explain(
			{
				...request,
				requireStreaming: true,
			},
			opts?.refresh ?? false,
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
		const loaded = await this.loadConfig();
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
					sessionSynthesis:
						loaded.value.config.workloads?.sessionSynthesis?.policy ??
						loaded.value.config.workloads?.sessionSynthesis?.target,
					widgetGeneration:
						loaded.value.config.workloads?.widgetGeneration?.policy ??
						loaded.value.config.workloads?.widgetGeneration?.target,
					repair: loaded.value.config.workloads?.repair?.policy ?? loaded.value.config.workloads?.repair?.target,
				},
				accounts,
				targets,
				agents: Object.keys(loaded.value.config.agents),
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
