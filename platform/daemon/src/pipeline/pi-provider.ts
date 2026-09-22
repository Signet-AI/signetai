import {
	type Api,
	type Context,
	InMemoryCredentialStore,
	type Model,
	type OpenAICompletionsCompat,
	type ProviderHeaders,
	type ThinkingLevel,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	type AgentSessionEvent,
	type SessionStats,
	SettingsManager,
	type ToolDefinition,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type {
	AccountingProvenance,
	LlmCacheRequestAccounting,
	LlmGenerateResult,
	LlmProvider,
	LlmUsage,
} from "@signet/core";
import { logger } from "../logger";
import {
	type LlmProviderCallOptions,
	type LlmProviderStreamEvent,
	type StreamCapableLlmProvider,
	acquireLlmConcurrencyPermit,
} from "./provider";
export type PiExecutorKind = "anthropic" | "openrouter" | "ollama" | "llama-cpp" | "openai-compatible" | (string & {});

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_LLAMA_CPP_BASE_URL = "http://127.0.0.1:8080/v1";
const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = "http://127.0.0.1:1234/v1";
const KEYLESS_API_KEY = "signet-keyless";

const LOCAL_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: true,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
};

export interface PiModelProviderConfig {
	readonly executor: PiExecutorKind;
	readonly providerFamily?: string;
	readonly model: string;
	readonly piModel?: Model<Api>;
	readonly skipAvailabilityProbe?: boolean;
	readonly baseUrl?: string;
	readonly apiKey?: string;
	readonly reasoning?: ThinkingLevel;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly defaultTimeoutMs?: number;
	readonly name?: string;
}
export class PiProviderDeadlineError extends Error {
	readonly timeoutMs: number;

	constructor(name: string, timeoutMs: number) {
		super(`Pi provider ${name} timed out after ${timeoutMs}ms`);
		this.name = "PiProviderDeadlineError";
		this.timeoutMs = timeoutMs;
	}
}
export interface PiAgentSession {
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
	subscribe?(listener: (event: AgentSessionEvent) => void): () => void;
	getSystemPrompt?(): string;
	getSessionId?(): string;
	getModelName?(): string | undefined;
	getActiveToolNames(): readonly string[];
	getFailureMessage(): string | undefined;
	getStats(): SessionStats | undefined;
	getRequestUsages(): readonly Usage[] | undefined;
}

export interface PiAgentSessionProvider {
	readonly isPiAgentSessionProvider: true;
	readonly agentSessionTimeoutMs: number;
	createAgentSession(
		tools: readonly ToolDefinition[],
		options?: { readonly maxTokens?: number; readonly signal?: AbortSignal },
	): Promise<PiAgentSession>;
}

function abortError(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	return new DOMException("The operation was aborted", "AbortError");
}

export async function awaitWithAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	onLateValue?: (value: T) => void,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		void promise
			.then(
				(value) => onLateValue?.(value),
				() => {},
			)
			.catch(() => {});
		throw abortError(signal);
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const onAbort = (): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			reject(abortError(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void promise
			.then(
				(value) => {
					if (settled) {
						onLateValue?.(value);
						return;
					}
					settled = true;
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(error: unknown) => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			)
			.catch(() => {});
	});
}

export function isPiAgentSessionProvider(
	provider: unknown,
): provider is StreamCapableLlmProvider & PiAgentSessionProvider {
	return (
		typeof provider === "object" &&
		provider !== null &&
		"isPiAgentSessionProvider" in provider &&
		provider.isPiAgentSessionProvider === true &&
		"createAgentSession" in provider &&
		typeof provider.createAgentSession === "function"
	);
}

interface ResolvedModel {
	readonly piModel: Model<Api>;
	readonly apiKey: string | undefined;
	readonly label: string;
}

function isLocalBaseUrl(url: string): boolean {
	return /^https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)/i.test(url);
}

function isOpenCodeModel(config: PiModelProviderConfig, model: Model<Api>): boolean {
	if (config.providerFamily === "opencode" || config.providerFamily === "opencode-go") return true;
	if (model.provider === "opencode" || model.provider === "opencode-go") return true;
	try {
		return new URL(model.baseUrl).hostname === "opencode.ai";
	} catch {
		return false;
	}
}

function hasHeader(model: Model<Api>, name: string): boolean {
	return Object.keys(model.headers ?? {}).some((key) => key.toLowerCase() === name);
}

function openCodeHeaders(
	config: PiModelProviderConfig,
	model: Model<Api>,
	sessionId: string | undefined,
): ProviderHeaders | undefined {
	if (!sessionId || !isOpenCodeModel(config, model)) return undefined;
	const headers: Record<string, string> = {
		...(hasHeader(model, "x-opencode-session") ? {} : { "x-opencode-session": sessionId }),
		...(hasHeader(model, "x-opencode-client") ? {} : { "x-opencode-client": "pi" }),
	};
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function localAccountingForConfig(config: PiModelProviderConfig): AccountingProvenance | undefined {
	if (config.executor === "ollama" || config.executor === "llama-cpp") return "local_zero_cost";
	if (config.executor !== "openai-compatible") return undefined;
	return isLocalBaseUrl(config.baseUrl ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL) ? "local_zero_cost" : undefined;
}

function accountingProvenanceForConfig(config: PiModelProviderConfig, piModel: Model<Api>): AccountingProvenance {
	const local = localAccountingForConfig(config);
	if (local) return local;
	const hasModelRates = Object.values(piModel.cost).some((rate) => Number.isFinite(rate) && rate > 0);
	return hasModelRates ? "locally_estimated" : "unavailable";
}

function withVersionPath(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (trimmed.endsWith("/v1/chat/completions")) return trimmed.slice(0, -"/chat/completions".length);
	if (trimmed.endsWith("/v1/responses")) return trimmed.slice(0, -"/responses".length);
	if (trimmed.endsWith("/v1")) return trimmed;
	return `${trimmed}/v1`;
}
export function resolvePiModel(config: PiModelProviderConfig): ResolvedModel {
	const timeoutMs = config.defaultTimeoutMs ?? 60_000;
	void timeoutMs;
	if (config.piModel) {
		const baseUrl =
			config.baseUrl && config.piModel.api === "openai-completions" ? withVersionPath(config.baseUrl) : config.baseUrl;
		const piModel: Model<Api> = {
			...config.piModel,
			...(baseUrl ? { baseUrl } : {}),
			...(config.contextWindow ? { contextWindow: config.contextWindow } : {}),
			...(config.maxTokens ? { maxTokens: config.maxTokens } : {}),
		};
		return {
			piModel,
			apiKey: config.apiKey,
			label: `${config.providerFamily ?? config.executor}:${config.model}`,
		};
	}
	switch (config.executor) {
		case "anthropic": {
			const baseUrl = config.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL;
			const apiKey = config.apiKey;
			if (!apiKey) {
				throw new Error(
					"Anthropic provider requires an API key. Set ANTHROPIC_API_KEY env var or configure it in Signet secrets.",
				);
			}
			const piModel: Model<"anthropic-messages"> = {
				id: config.model,
				name: config.model,
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl,
				reasoning: config.reasoning !== undefined,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: config.contextWindow ?? 200_000,
				maxTokens: config.maxTokens ?? 4096,
				headers: {},
			};
			return { piModel, apiKey, label: `anthropic:${config.model}` };
		}
		case "openrouter": {
			const baseUrl = config.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL;
			const apiKey = config.apiKey;
			if (!apiKey) {
				throw new Error("OpenRouter provider requires an API key. Configure it in Signet secrets.");
			}
			const piModel: Model<"openai-completions"> = {
				id: config.model,
				name: config.model,
				api: "openai-completions",
				provider: "openrouter",
				baseUrl,
				reasoning: config.reasoning !== undefined,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: config.contextWindow ?? 128_000,
				maxTokens: config.maxTokens ?? 4096,
				headers: {},
				compat: { ...LOCAL_COMPAT, thinkingFormat: "openrouter" },
			};
			return { piModel, apiKey, label: `openrouter:${config.model}` };
		}
		case "ollama":
		case "llama-cpp":
		case "openai-compatible": {
			const defaultBase =
				config.executor === "ollama"
					? DEFAULT_OLLAMA_BASE_URL
					: config.executor === "llama-cpp"
						? DEFAULT_LLAMA_CPP_BASE_URL
						: DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
			const rawBase = config.baseUrl ?? defaultBase;
			const baseUrl = config.executor === "openai-compatible" ? withVersionPath(rawBase) : withVersionPath(rawBase);
			const keyless = !config.apiKey && isLocalBaseUrl(rawBase);
			const piModel: Model<"openai-completions"> = {
				id: config.model,
				name: config.model,
				api: "openai-completions",
				provider: config.executor,
				baseUrl,
				reasoning: config.reasoning !== undefined,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: config.contextWindow ?? 128_000,
				maxTokens: config.maxTokens ?? 4096,
				headers: {},
				compat: LOCAL_COMPAT,
			};
			return {
				piModel,
				apiKey: keyless ? KEYLESS_API_KEY : config.apiKey,
				label: `${config.executor}:${config.model}`,
			};
		}
		default:
			throw new Error(`Provider ${config.providerFamily ?? config.executor} requires a model from the pi-ai catalog`);
	}
}

function hasUsageValues(values: readonly (number | null | undefined)[]): boolean {
	return values.some((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
}

function usageHasAccounting(usage: Usage): boolean {
	return hasUsageValues([
		usage.input,
		usage.output,
		usage.cacheRead,
		usage.cacheWrite,
		usage.totalTokens,
		usage.cost?.total,
	]);
}

function nonNegativeFinite(value: number | null | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function hasCacheRequestAccounting(usage: Usage): boolean {
	return [usage.cacheRead, usage.cacheWrite].some((value) => typeof value === "number" && Number.isFinite(value));
}

export function summarizeCacheRequests(usages: readonly Usage[]): LlmCacheRequestAccounting | null {
	if (!usages.some(hasCacheRequestAccounting)) return null;

	let hits = 0;
	let misses = 0;
	let unknown = 0;
	let writes = 0;
	for (const usage of usages) {
		const cacheRead = nonNegativeFinite(usage.cacheRead);
		const cacheWrite = nonNegativeFinite(usage.cacheWrite);
		if (cacheRead > 0) hits += 1;
		else if (cacheWrite > 0) misses += 1;
		else unknown += 1;
		if (cacheWrite > 0) writes += 1;
	}
	return { requests: usages.length, hits, misses, unknown, writes };
}

function effectiveAccountingProvenance(
	hasUsage: boolean,
	accountingProvenance: AccountingProvenance,
): AccountingProvenance {
	return hasUsage || accountingProvenance === "local_zero_cost" ? accountingProvenance : "unavailable";
}

export function mapUsage(usage: Usage, accountingProvenance: AccountingProvenance): LlmUsage {
	const effectiveProvenance = effectiveAccountingProvenance(usageHasAccounting(usage), accountingProvenance);
	return {
		inputTokens: usage.input ?? null,
		outputTokens: usage.output ?? null,
		cacheReadTokens: usage.cacheRead ?? null,
		cacheCreationTokens: usage.cacheWrite ?? null,
		totalTokens: usage.totalTokens ?? null,
		totalCost: effectiveProvenance === "unavailable" ? null : (usage.cost?.total ?? null),
		totalDurationMs: null,
		accountingProvenance: effectiveProvenance,
		cacheRequests: summarizeCacheRequests([usage]),
	};
}
export function mapSessionStatsToUsage(
	stats: SessionStats | undefined,
	totalDurationMs: number,
	accountingProvenance: AccountingProvenance = "unavailable",
	requestUsages?: readonly Usage[],
): LlmUsage {
	if (stats === undefined) {
		return {
			inputTokens: null,
			outputTokens: null,
			cacheReadTokens: null,
			cacheCreationTokens: null,
			totalTokens: null,
			totalCost: null,
			totalDurationMs,
			accountingProvenance,
			cacheRequests: requestUsages === undefined ? null : summarizeCacheRequests(requestUsages),
		};
	}
	const effectiveProvenance = effectiveAccountingProvenance(
		hasUsageValues([
			stats.tokens.input,
			stats.tokens.output,
			stats.tokens.cacheRead,
			stats.tokens.cacheWrite,
			stats.tokens.total,
			stats.cost,
		]),
		accountingProvenance,
	);
	return {
		inputTokens: stats.tokens.input,
		outputTokens: stats.tokens.output,
		cacheReadTokens: stats.tokens.cacheRead,
		cacheCreationTokens: stats.tokens.cacheWrite,
		totalTokens: stats.tokens.total,
		totalCost: effectiveProvenance === "unavailable" ? null : stats.cost,
		totalDurationMs,
		accountingProvenance: effectiveProvenance,
		cacheRequests: requestUsages === undefined ? null : summarizeCacheRequests(requestUsages),
	};
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(p): p is { type: "text"; text: string } =>
				typeof p === "object" && p !== null && "type" in p && (p as { type: string }).type === "text",
		)
		.map((p) => p.text)
		.join("");
}

interface PiError extends Error {
	stopReason?: string;
}

function toError(label: string, message: { stopReason: string; errorMessage?: string }): PiError {
	const reason = message.stopReason;
	const detail = message.errorMessage ?? reason;
	const err = new Error(`Pi provider ${label} failed (${reason}): ${detail}`) as PiError;
	err.stopReason = reason;
	return err;
}
function callerAbort(
	opts: LlmProviderCallOptions | undefined,
	defaultTimeoutMs: number,
): {
	signal: AbortSignal;
	abort: () => void;
	timedOut: () => boolean;
	cleanup: () => void;
} {
	const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs;
	const controller = new AbortController();
	const signals: AbortSignal[] = [];
	if (opts?.signal) signals.push(opts.signal);
	if (opts?.abortSignal) signals.push(opts.abortSignal);
	for (const s of signals) {
		if (s.aborted) controller.abort();
		else s.addEventListener("abort", () => controller.abort(), { once: true });
	}
	let timeout: ReturnType<typeof setTimeout> | null = null;
	let timedOut = false;
	if (timeoutMs > 0) {
		timeout = setTimeout(() => {
			timedOut = true;
			controller.abort(new Error(`timeout after ${timeoutMs}ms`));
		}, timeoutMs);
	}
	return {
		signal: controller.signal,
		abort: () => controller.abort(),
		timedOut: () => timedOut,
		cleanup: () => {
			if (timeout) clearTimeout(timeout);
		},
	};
}

export function createPiModelProvider(
	config: PiModelProviderConfig,
): StreamCapableLlmProvider & PiAgentSessionProvider {
	const { piModel, apiKey, label } = resolvePiModel(config);
	const name = config.name ?? label;
	const accountingProvenance = accountingProvenanceForConfig(config, piModel);
	const defaultTimeoutMs = config.defaultTimeoutMs ?? 60_000;
	const reasoning = config.reasoning;
	const modelRuntime = ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
	}).then((runtime) => {
		runtime.registerProvider(piModel.provider, {
			name: piModel.provider,
			baseUrl: piModel.baseUrl,
			api: piModel.api,
			apiKey: apiKey ?? KEYLESS_API_KEY,
			models: [{ ...piModel }],
		});
		return runtime;
	});

	function buildContext(prompt: string): Context {
		return {
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		};
	}

	function buildOptions(
		opts: LlmProviderCallOptions | undefined,
		abort: { signal: AbortSignal },
	): {
		apiKey: string | undefined;
		signal: AbortSignal;
		sessionId?: string;
		transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders;
		maxTokens?: number;
		temperature?: number;
		reasoning?: ThinkingLevel;
	} {
		const effectiveReasoning: ThinkingLevel | undefined =
			opts?.reasoning === false ? undefined : (opts?.reasoning ?? reasoning);
		const headers = openCodeHeaders(config, piModel, opts?.sessionId);
		const transformHeaders = headers
			? (requestHeaders: ProviderHeaders): ProviderHeaders => ({ ...headers, ...requestHeaders })
			: undefined;
		return {
			apiKey,
			signal: abort.signal,
			...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
			...(transformHeaders ? { transformHeaders } : {}),
			...(opts?.maxTokens ? { maxTokens: opts.maxTokens } : {}),
			...(typeof opts?.temperature === "number" ? { temperature: opts.temperature } : {}),
			...(effectiveReasoning !== undefined ? { reasoning: effectiveReasoning } : {}),
		};
	}

	async function callOnce(prompt: string, opts?: LlmProviderCallOptions): Promise<LlmGenerateResult> {
		const abort = callerAbort(opts, defaultTimeoutMs);
		const t0 = Date.now();
		try {
			const release = await acquireLlmConcurrencyPermit(opts?.timeoutMs ?? defaultTimeoutMs, name, abort.signal);
			try {
				const msg = await (await modelRuntime).completeSimple(piModel, buildContext(prompt), buildOptions(opts, abort));
				const durationMs = Date.now() - t0;
				if (msg.stopReason === "error" || msg.stopReason === "aborted") {
					throw toError(name, msg);
				}
				const text = extractText(msg.content);
				return {
					text,
					usage: {
						...mapUsage(msg.usage, accountingProvenance ?? "provider_reported"),
						totalDurationMs: durationMs,
					},
				};
			} finally {
				release();
			}
		} catch (error) {
			if (abort.timedOut()) {
				throw new PiProviderDeadlineError(name, opts?.timeoutMs ?? defaultTimeoutMs);
			}
			throw error;
		} finally {
			abort.cleanup();
		}
	}

	const provider: LlmProvider = {
		name,
		accountingProvenance,
		async generate(prompt, opts) {
			const { text } = await callOnce(prompt, opts);
			return text;
		},
		async generateWithUsage(prompt, opts) {
			return callOnce(prompt, opts);
		},
		async available() {
			if (config.skipAvailabilityProbe) return true;
			const probeUrl =
				piModel.api === "anthropic-messages"
					? `${piModel.baseUrl.replace(/\/+$/, "")}/v1/models`
					: `${piModel.baseUrl.replace(/\/+$/, "")}/models`;
			try {
				const res = await fetch(probeUrl, {
					method: "GET",
					headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
					signal: AbortSignal.timeout(8_000),
				});
				return res.ok || res.status === 401 || res.status === 404;
			} catch {
				return false;
			}
		},
	};

	const streamCapable: StreamCapableLlmProvider = {
		...provider,
		async streamWithUsage(prompt, opts) {
			const abort = callerAbort(opts, defaultTimeoutMs);
			const t0 = Date.now();
			let fullText = "";
			let finalUsage: LlmUsage | null = null;

			const release = await acquireLlmConcurrencyPermit(opts?.timeoutMs ?? defaultTimeoutMs, name, abort.signal);
			let released = false;
			const releaseWhenSettled = (): void => {
				if (released) return;
				released = true;
				abort.cleanup();
				release();
			};
			const piStream = await (async () => {
				try {
					return (await modelRuntime).streamSimple(piModel, buildContext(prompt), buildOptions(opts, abort));
				} catch (error) {
					releaseWhenSettled();
					throw error;
				}
			})();

			const stream = new ReadableStream<LlmProviderStreamEvent>({
				async start(controller) {
					try {
						for await (const ev of piStream) {
							if (ev.type === "text_delta") {
								fullText += ev.delta;
								controller.enqueue({ type: "text-delta", text: ev.delta });
							} else if (ev.type === "done") {
								finalUsage = {
									...mapUsage(ev.message.usage, accountingProvenance ?? "provider_reported"),
									totalDurationMs: Date.now() - t0,
								};
								controller.enqueue({ type: "done", text: fullText, usage: finalUsage });
							} else if (ev.type === "error") {
								finalUsage = {
									...mapUsage(ev.error.usage, accountingProvenance ?? "provider_reported"),
									totalDurationMs: Date.now() - t0,
								};
								controller.error(toError(name, { stopReason: ev.reason, errorMessage: ev.error.errorMessage }));
								return;
							}
						}
						controller.close();
					} catch (err) {
						logger.debug("pipeline", "pi provider stream error", {
							name,
							error: err instanceof Error ? err.message : String(err),
						});
						controller.error(err instanceof Error ? err : new Error(String(err)));
					} finally {
						releaseWhenSettled();
					}
				},
				cancel() {
					abort.abort();
				},
			});

			return {
				stream,
				cancel: () => {
					abort.abort();
				},
			};
		},
	};

	return {
		...streamCapable,
		...(accountingProvenance ? { accountingProvenance } : {}),
		isPiAgentSessionProvider: true,
		agentSessionTimeoutMs: defaultTimeoutMs,
		async createAgentSession(
			tools: readonly ToolDefinition[],
			options: { readonly maxTokens?: number; readonly signal?: AbortSignal } = {},
		) {
			const isolatedRuntime = await awaitWithAbort(modelRuntime, options.signal);
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd: process.cwd(),
				agentDir: process.cwd(),
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt: "You are a bounded Signet maintenance agent. You may use only the supplied daemon tools.",
			});
			await awaitWithAbort(resourceLoader.reload(), options.signal);
			const { session } = await awaitWithAbort(
				createAgentSession({
					model: options.maxTokens ? { ...piModel, maxTokens: options.maxTokens } : piModel,
					modelRuntime: isolatedRuntime,
					sessionManager: SessionManager.inMemory(),
					settingsManager,
					resourceLoader,
					tools: tools.map((tool) => tool.name),
					customTools: [...tools],
				}),
				options.signal,
				(result) => result.session.dispose(),
			);
			return {
				prompt: (text) => session.prompt(text),
				abort: () => session.abort(),
				dispose: () => session.dispose(),
				subscribe: (listener) => session.subscribe(listener),
				getSystemPrompt: () => session.systemPrompt,
				getSessionId: () => session.sessionId,
				getModelName: () => session.model?.id,
				getActiveToolNames: () => session.getActiveToolNames(),
				getStats: () => session.getSessionStats(),
				getRequestUsages: () =>
					session.messages.flatMap((message) => (message.role === "assistant" ? [message.usage] : [])),
				getFailureMessage: () => {
					for (const message of [...session.messages].reverse()) {
						if (
							message.role === "assistant" &&
							(message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length")
						) {
							return message.errorMessage ?? `Pi agent ${message.stopReason}`;
						}
					}
					return undefined;
				},
			};
		},
	};
}
