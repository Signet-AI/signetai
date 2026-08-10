/**
 * Pi-backed inference provider (#947).
 *
 * Single LlmProvider implementation backed by @earendil-works/pi-ai. Replaces
 * the per-provider HTTP/subprocess factories that previously lived in
 * provider.ts. Every routing executor except `acpx` (which stays a Signet-native
 * harness backend) resolves to a pi-ai `Model<TApi>` constructed here.
 *
 * Verified against live local servers (LM Studio, Ollama) and pi's own
 * llama.cpp extension pattern: see docs/research/2026-07-21-pi-inference-spike.md.
 */
import {
	type Api,
	type Context,
	InMemoryCredentialStore,
	type Model,
	type OpenAICompletionsCompat,
	type ThinkingLevel,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	type SessionStats,
	SettingsManager,
	type ToolDefinition,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AccountingProvenance, LlmGenerateResult, LlmProvider, LlmUsage } from "@signet/core";
import { logger } from "../logger";
import type {
	LlmProviderCallOptions,
	LlmProviderStreamEvent,
	LlmProviderStreamResult,
	StreamCapableLlmProvider,
} from "./provider";

/** Executors that route through pi-ai. `acpx` is handled separately. */
export type PiExecutorKind = "anthropic" | "openrouter" | "ollama" | "llama-cpp" | "openai-compatible" | (string & {});

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_LLAMA_CPP_BASE_URL = "http://127.0.0.1:8080/v1";
const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = "http://127.0.0.1:1234/v1";

/** Keyless local/gateway servers get a dummy key so pi-ai's resolver short-circuits. */
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
	/** Model metadata supplied by pi-ai for native providers. */
	readonly piModel?: Model<Api>;
	/** Native pi-ai providers do not share a portable unauthenticated health endpoint. */
	readonly skipAvailabilityProbe?: boolean;
	readonly baseUrl?: string;
	/** Resolved credential (API key). Omit for keyless local servers. */
	readonly apiKey?: string;
	/**
	 * Per-call thinking level forwarded to pi-ai as `options.reasoning`.
	 * Pi-ai has TWO reasoning fields: `Model.reasoning` (a boolean CAPABILITY
	 * flag) and `options.reasoning` (a ThinkingLevel that actually turns
	 * thinking on for the call). Setting the capability flag alone has no
	 * observable effect — the per-call level must be forwarded too.
	 * `RoutingReasoningDepth` ("low"|"medium"|"high") is a subset of
	 * ThinkingLevel ("minimal"|"low"|"medium"|"high"|"xhigh").
	 */
	readonly reasoning?: ThinkingLevel;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly defaultTimeoutMs?: number;
	readonly name?: string;
}

/**
 * A deliberately isolated Pi AgentSession for daemon-owned agentic work.
 *
 * The daemon supplies every tool, including the single audited write seam.
 * No project context, extensions, skills, or persisted Pi session is exposed
 * to this background process.
 */
export interface PiAgentSession {
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
	getActiveToolNames(): readonly string[];
	getFailureMessage(): string | undefined;
	/**
	 * Provider-reported token usage for the whole session, aggregated by
	 * pi-coding-agent across every assistant turn and tool call. Undefined
	 * for providers that never reported usage.
	 */
	getStats(): SessionStats | undefined;
}

export interface PiAgentSessionProvider {
	readonly isPiAgentSessionProvider: true;
	readonly agentSessionTimeoutMs: number;
	createAgentSession(
		tools: readonly ToolDefinition[],
		options?: { readonly maxTokens?: number },
	): Promise<PiAgentSession>;
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

function localAccountingForConfig(config: PiModelProviderConfig): AccountingProvenance | undefined {
	if (config.executor === "ollama" || config.executor === "llama-cpp") return "local_zero_cost";
	if (config.executor !== "openai-compatible") return undefined;
	return isLocalBaseUrl(config.baseUrl ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL) ? "local_zero_cost" : undefined;
}

function withVersionPath(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	// Routing targets conventionally store an OpenAI *base* URL, while users
	// commonly paste the concrete chat-completions endpoint. Pi appends the
	// operation path itself, so normalize that concrete form instead of issuing
	// `/chat/completions/chat/completions`.
	if (trimmed.endsWith("/v1/chat/completions")) return trimmed.slice(0, -"/chat/completions".length);
	if (trimmed.endsWith("/v1/responses")) return trimmed.slice(0, -"/responses".length);
	if (trimmed.endsWith("/v1")) return trimmed;
	return `${trimmed}/v1`;
}

/** Map a routing executor + config to a pi-ai Model. */
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
			// ollama/llama-cpp always get /v1; openai-compatible respects a provided path.
			const baseUrl = config.executor === "openai-compatible" ? withVersionPath(rawBase) : withVersionPath(rawBase);
			// Keyless only when the server is local AND no explicit key was provided.
			// A local gateway/proxy that requires a bearer token keeps its real key.
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

function mapUsage(usage: Usage, accountingProvenance: AccountingProvenance): LlmUsage {
	return {
		inputTokens: usage.input ?? null,
		outputTokens: usage.output ?? null,
		cacheReadTokens: usage.cacheRead ?? null,
		cacheCreationTokens: usage.cacheWrite ?? null,
		totalTokens: usage.totalTokens ?? null,
		totalCost: usage.cost?.total ?? null,
		totalDurationMs: null,
		accountingProvenance,
	};
}

/**
 * Map a pi-coding-agent SessionStats aggregate to the shared LlmUsage shape.
 * The stats object aggregates provider-reported usage across every assistant
 * turn and tool result in the session; a session that reported nothing
 * yields an all-null usage so callers can distinguish "no usage reported"
 * from a real zero-token pass.
 */
export function mapSessionStatsToUsage(
	stats: SessionStats | undefined,
	totalDurationMs: number,
	accountingProvenance: AccountingProvenance = "unavailable",
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
		};
	}
	return {
		inputTokens: stats.tokens.input,
		outputTokens: stats.tokens.output,
		cacheReadTokens: stats.tokens.cacheRead,
		cacheCreationTokens: stats.tokens.cacheWrite,
		totalTokens: stats.tokens.total,
		totalCost: stats.cost,
		totalDurationMs,
		accountingProvenance,
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

/** Create an AbortController that fires on caller signal OR timeout. */
function callerAbort(
	opts: LlmProviderCallOptions | undefined,
	defaultTimeoutMs: number,
): {
	signal: AbortSignal;
	abort: () => void;
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
	if (timeoutMs > 0) {
		timeout = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
	}
	return {
		signal: controller.signal,
		abort: () => controller.abort(),
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
	const accountingProvenance = localAccountingForConfig(config);
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
		maxTokens?: number;
		temperature?: number;
		reasoning?: ThinkingLevel;
	} {
		// Per-call reasoning override semantics:
		//   opts.reasoning === false  -> suppress thinking entirely (latency-sensitive ops)
		//   opts.reasoning is a level -> override the configured level for this call
		//   opts.reasoning undefined   -> use the provider's configured level
		const effectiveReasoning: ThinkingLevel | undefined =
			opts?.reasoning === false ? undefined : (opts?.reasoning ?? reasoning);
		return {
			apiKey,
			signal: abort.signal,
			...(opts?.maxTokens ? { maxTokens: opts.maxTokens } : {}),
			...(typeof opts?.temperature === "number" ? { temperature: opts.temperature } : {}),
			...(effectiveReasoning !== undefined ? { reasoning: effectiveReasoning } : {}),
		};
	}

	async function callOnce(prompt: string, opts?: LlmProviderCallOptions): Promise<LlmGenerateResult> {
		const abort = callerAbort(opts, defaultTimeoutMs);
		const t0 = Date.now();
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
			abort.cleanup();
		}
	}

	const provider: LlmProvider = {
		name,
		...(accountingProvenance ? { accountingProvenance } : {}),
		async generate(prompt, opts) {
			const { text } = await callOnce(prompt, opts);
			return text;
		},
		async generateWithUsage(prompt, opts) {
			return callOnce(prompt, opts);
		},
		async available() {
			if (config.skipAvailabilityProbe) return true;
			// Reachability check: ping the OpenAI-compatible /models endpoint (or
			// Anthropic /v1/models) so the router can skip unreachable targets before
			// attempting a real call. Mirrors the legacy providers' availability probe.
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
				// OpenAI-compatible gateways commonly omit /models even though their
				// chat-completions API is healthy. A 404 proves this host is reachable;
				// let the routed call report any real completion-path failure.
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

			const piStream = (await modelRuntime).streamSimple(piModel, buildContext(prompt), buildOptions(opts, abort));

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
						abort.cleanup();
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
					abort.cleanup();
				},
			};
		},
	};

	return {
		...streamCapable,
		...(accountingProvenance ? { accountingProvenance } : {}),
		isPiAgentSessionProvider: true,
		agentSessionTimeoutMs: defaultTimeoutMs,
		async createAgentSession(tools: readonly ToolDefinition[], options: { readonly maxTokens?: number } = {}) {
			// Isolated from the user's Pi credentials and models.json. The same
			// daemon-owned runtime services ordinary calls and this AgentSession.
			const isolatedRuntime = await modelRuntime;
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
			await resourceLoader.reload();
			const { session } = await createAgentSession({
				model: options.maxTokens ? { ...piModel, maxTokens: options.maxTokens } : piModel,
				modelRuntime: isolatedRuntime,
				sessionManager: SessionManager.inMemory(),
				settingsManager,
				resourceLoader,
				tools: tools.map((tool) => tool.name),
				customTools: [...tools],
			});
			return {
				prompt: (text) => session.prompt(text),
				abort: () => session.abort(),
				dispose: () => session.dispose(),
				getActiveToolNames: () => session.getActiveToolNames(),
				getStats: () => session.getSessionStats(),
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
