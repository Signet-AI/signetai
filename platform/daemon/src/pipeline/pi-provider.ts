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
	type Model,
	type OpenAICompletionsCompat,
	type Usage,
	completeSimple,
	streamSimple,
} from "@earendil-works/pi-ai";
import type { LlmGenerateResult, LlmProvider, LlmUsage } from "@signet/core";
import { logger } from "../logger";
import type {
	LlmProviderCallOptions,
	LlmProviderStreamEvent,
	LlmProviderStreamResult,
	StreamCapableLlmProvider,
} from "./provider";

/** Executors that route through pi-ai. `acpx` is handled separately. */
export type PiExecutorKind =
	| "anthropic"
	| "openrouter"
	| "ollama"
	| "llama-cpp"
	| "openai-compatible";

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
	readonly model: string;
	readonly baseUrl?: string;
	/** Resolved credential (API key). Omit for keyless local servers. */
	readonly apiKey?: string;
	readonly reasoning?: boolean;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly defaultTimeoutMs?: number;
	readonly name?: string;
}

interface ResolvedModel {
	readonly piModel: Model<Api>;
	readonly apiKey: string | undefined;
	readonly label: string;
}

function isLocalBaseUrl(url: string): boolean {
	return /^https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)/i.test(url);
}

function withVersionPath(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (trimmed.endsWith("/v1")) return trimmed;
	return `${trimmed}/v1`;
}

/** Map a routing executor + config to a pi-ai Model. */
export function resolvePiModel(config: PiModelProviderConfig): ResolvedModel {
	const timeoutMs = config.defaultTimeoutMs ?? 60_000;
	void timeoutMs;
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
				reasoning: config.reasoning ?? false,
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
				reasoning: config.reasoning ?? false,
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
			const baseUrl =
				config.executor === "openai-compatible" ? withVersionPath(rawBase) : withVersionPath(rawBase);
			// Keyless only when the server is local AND no explicit key was provided.
			// A local gateway/proxy that requires a bearer token keeps its real key.
			const keyless = !config.apiKey && isLocalBaseUrl(rawBase);
			const piModel: Model<"openai-completions"> = {
				id: config.model,
				name: config.model,
				api: "openai-completions",
				provider: config.executor,
				baseUrl,
				reasoning: config.reasoning ?? false,
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
	}
}

function mapUsage(usage: Usage): LlmUsage {
	return {
		inputTokens: usage.input ?? null,
		outputTokens: usage.output ?? null,
		cacheReadTokens: usage.cacheRead ?? null,
		cacheCreationTokens: usage.cacheWrite ?? null,
		totalCost: usage.cost?.total ?? null,
		totalDurationMs: null,
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
function callerAbort(opts: LlmProviderCallOptions | undefined, defaultTimeoutMs: number): {
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

export function createPiModelProvider(config: PiModelProviderConfig): StreamCapableLlmProvider {
	const { piModel, apiKey, label } = resolvePiModel(config);
	const name = config.name ?? label;
	const defaultTimeoutMs = config.defaultTimeoutMs ?? 60_000;

	function buildContext(prompt: string): Context {
		return {
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		};
	}

	function buildOptions(opts: LlmProviderCallOptions | undefined, abort: { signal: AbortSignal }): {
		apiKey: string | undefined;
		signal: AbortSignal;
		maxTokens?: number;
		temperature?: number;
	} {
		return {
			apiKey,
			signal: abort.signal,
			...(opts?.maxTokens ? { maxTokens: opts.maxTokens } : {}),
			...(typeof opts?.temperature === "number" ? { temperature: opts.temperature } : {}),
		};
	}

	async function callOnce(prompt: string, opts?: LlmProviderCallOptions): Promise<LlmGenerateResult> {
		const abort = callerAbort(opts, defaultTimeoutMs);
		const t0 = Date.now();
		try {
			const msg = await completeSimple(piModel, buildContext(prompt), buildOptions(opts, abort));
			const durationMs = Date.now() - t0;
			if (msg.stopReason === "error" || msg.stopReason === "aborted") {
				throw toError(name, msg);
			}
			const text = extractText(msg.content);
			return {
				text,
				usage: {
					...mapUsage(msg.usage),
					totalDurationMs: durationMs,
				},
			};
		} finally {
			abort.cleanup();
		}
	}

	const provider: LlmProvider = {
		name,
		async generate(prompt, opts) {
			const { text } = await callOnce(prompt, opts);
			return text;
		},
		async generateWithUsage(prompt, opts) {
			return callOnce(prompt, opts);
		},
		async available() {
			// Reachability check: ping the OpenAI-compatible /models endpoint (or
			// Anthropic /v1/models) so the router can skip unreachable targets before
			// attempting a real call. Mirrors the legacy providers' availability probe.
			const probeUrl = piModel.api === "anthropic-messages"
				? `${piModel.baseUrl.replace(/\/+$/, "")}/v1/models`
				: `${piModel.baseUrl.replace(/\/+$/, "")}/models`;
			try {
				const res = await fetch(probeUrl, {
					method: "GET",
					headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
					signal: AbortSignal.timeout(8_000),
				});
				return res.ok || res.status === 401;
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

			const piStream = streamSimple(piModel, buildContext(prompt), buildOptions(opts, abort));

			const stream = new ReadableStream<LlmProviderStreamEvent>({
				async start(controller) {
					try {
						for await (const ev of piStream) {
							if (ev.type === "text_delta") {
								fullText += ev.delta;
								controller.enqueue({ type: "text-delta", text: ev.delta });
							} else if (ev.type === "done") {
								finalUsage = { ...mapUsage(ev.message.usage), totalDurationMs: Date.now() - t0 };
								controller.enqueue({ type: "done", text: fullText, usage: finalUsage });
							} else if (ev.type === "error") {
								finalUsage = { ...mapUsage(ev.error.usage), totalDurationMs: Date.now() - t0 };
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

	return streamCapable;
}
