import { getDbAccessor, hasDbAccessor } from "./db-accessor";
import { resolveActiveEmbeddingConfig } from "./embedding-index-state";
import { type EmbeddingRole, formatEmbeddingInput } from "./embedding-profile";
import { type EmbeddingUsageAttribution, recordEmbeddingUsage } from "./embedding-usage";
import { logger } from "./logger";
import type { EmbeddingConfig } from "./memory-config";
import {
	DEFAULT_LLAMACPP_BASE_URL,
	DEFAULT_LLAMACPP_MAX_INPUT_TOKENS,
	DEFAULT_OLLAMA_BASE_URL,
	DEFAULT_OPENAI_BASE_URL,
} from "./memory-config";
import { isPipelineTimeout, recordPipelineError } from "./pipeline-error";
import { type PipelineCauseFamily, normalizePipelineCause, pipelineCauseFromHttpFailure } from "./pipeline-operation";
import { countTokens, truncateToTokens } from "./pipeline/tokenizer";
import { getSecret } from "./secrets.js";

export function resolveOllamaUrl(): string {
	const raw = process.env.OLLAMA_HOST;
	if (!raw) return DEFAULT_OLLAMA_BASE_URL;
	try {
		new URL(raw);
		return raw;
	} catch {
		logger.warn("embedding", `OLLAMA_HOST is not a valid URL ("${raw}"), falling back to default`);
		return DEFAULT_OLLAMA_BASE_URL;
	}
}

export const LLAMACPP_FALLBACK_EMBEDDING_MODELS = ["nomic-embed-text", "all-minilm", "mxbai-embed-large"] as const;
export type LlamaCppEmbeddingModel = (typeof LLAMACPP_FALLBACK_EMBEDDING_MODELS)[number];

export async function findLlamaCppEmbeddingModel(
	baseUrl = DEFAULT_LLAMACPP_BASE_URL,
): Promise<LlamaCppEmbeddingModel | null> {
	try {
		const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
			method: "GET",
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) return null;
		const raw = (await res.json()) as { data?: Array<{ id?: string }> };
		const loaded = new Set((raw.data ?? []).map((m) => m.id?.trim()).filter(Boolean));
		for (const model of LLAMACPP_FALLBACK_EMBEDDING_MODELS) {
			if (loaded.has(model)) return model;
		}
	} catch {}
	return null;
}

let cachedNativeEmbed: ((text: string) => Promise<number[]>) | null = null;
type NativeFallbackProvider = "llama-cpp" | "ollama";
type NativeFallbackState = NativeFallbackProvider | "unavailable" | null;
type NativeFallbackProbeResult = {
	readonly provider: NativeFallbackProvider | "unavailable";
	readonly model: LlamaCppEmbeddingModel | null;
	readonly embedding: number[] | null;
	readonly tokenCount: number;
	readonly failureCause?: PipelineCauseFamily;
};
type NativeFallbackProbe = {
	readonly promise: Promise<NativeFallbackProbeResult>;
};

let nativeFallbackProvider: NativeFallbackState = null;
let nativeFallbackModel: LlamaCppEmbeddingModel | null = null;
let nativeFallbackProbe: NativeFallbackProbe | null = null;

export function setNativeFallbackProvider(provider: NativeFallbackState, model?: LlamaCppEmbeddingModel | null): void {
	nativeFallbackProvider = provider;
	nativeFallbackModel = model ?? null;
	nativeFallbackProbe = null;
}

export function setNativeEmbeddingProviderForTest(provider: ((text: string) => Promise<number[]>) | null): void {
	cachedNativeEmbed = provider;
}

export type EmbeddingFetchOptions = {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	/** Optional usage attribution recorded with the fetch (source_kind, agent). */
	readonly usage?: EmbeddingUsageAttribution;
	/** Internal operation accounting hook; never serialized into telemetry. */
	readonly onFailure?: (causeFamily: PipelineCauseFamily) => void;
};

function resolveEmbeddingTimeoutMs(opts: EmbeddingFetchOptions, fallback: number): number {
	return typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
		? opts.timeoutMs
		: fallback;
}

type EmbeddingFetchSignal = {
	readonly signal: AbortSignal;
	readonly timedOut: boolean;
	readonly cleanup: () => void;
};

function createEmbeddingFetchSignal(opts: EmbeddingFetchOptions, timeoutMs: number): EmbeddingFetchSignal {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	let abortCaller: (() => void) | null = null;
	if (opts.signal) {
		if (opts.signal.aborted) {
			controller.abort();
		} else {
			abortCaller = () => controller.abort();
			opts.signal.addEventListener("abort", abortCaller, { once: true });
		}
	}
	return {
		signal: controller.signal,
		get timedOut() {
			return timedOut;
		},
		cleanup: () => {
			clearTimeout(timer);
			if (abortCaller) opts.signal?.removeEventListener("abort", abortCaller);
		},
	};
}

async function fetchWithEmbeddingTimeout(
	input: Parameters<typeof fetch>[0],
	init: RequestInit,
	opts: EmbeddingFetchOptions,
	timeoutMs: number,
): Promise<Response> {
	const state = createEmbeddingFetchSignal(opts, timeoutMs);
	try {
		return await fetch(input, { ...init, signal: state.signal });
	} catch (error) {
		if (state.timedOut) throw new Error("Embedding request timed out");
		throw error;
	} finally {
		state.cleanup();
	}
}

async function readResponsePrefix(response: Response, maxBytes = 4096, timeoutMs = 5000): Promise<string> {
	const reader = response.clone().body?.getReader();
	if (!reader) return "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(async () => {
				const chunks: Uint8Array[] = [];
				let total = 0;
				while (total < maxBytes) {
					const next = await reader.read();
					if (next.done || !next.value) break;
					const remaining = maxBytes - total;
					const chunk = next.value.byteLength > remaining ? next.value.slice(0, remaining) : next.value;
					chunks.push(chunk);
					total += chunk.byteLength;
					if (chunk.byteLength < next.value.byteLength) break;
				}
				const bytes = new Uint8Array(total);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.byteLength;
				}
				return new TextDecoder().decode(bytes);
			})(),
			new Promise<string>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Embedding response body timed out")), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		await reader.cancel().catch(() => {});
	}
}

function isEmbeddingVector(value: unknown): value is number[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
	);
}

async function fetchOllamaEmbedding(
	text: string,
	baseUrl: string,
	model: string,
	opts: EmbeddingFetchOptions = {},
): Promise<{
	readonly embedding: number[] | null;
	readonly tokenCount: number;
	readonly failureCause?: PipelineCauseFamily;
}> {
	const res = await fetchWithEmbeddingTimeout(
		`${baseUrl.replace(/\/$/, "")}/api/embeddings`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model, prompt: text }),
		},
		opts,
		resolveEmbeddingTimeoutMs(opts, 30000),
	);
	if (!res.ok) {
		logger.warn("embedding", "Ollama embedding request failed", {
			status: res.status,
			model,
		});
		const responseText = await readResponsePrefix(res, 4096, resolveEmbeddingTimeoutMs(opts, 30000)).catch(() => "");
		return {
			embedding: null,
			tokenCount: countTokens(text),
			failureCause: pipelineCauseFromHttpFailure(res.status, responseText),
		};
	}
	const data = (await res.json()) as { embedding?: unknown };
	const embedding = isEmbeddingVector(data.embedding) ? data.embedding : null;
	return {
		embedding,
		tokenCount: countTokens(text),
		...(embedding === null ? { failureCause: "parse_failure" as const } : {}),
	};
}

function boundLlamaCppEmbeddingInput(text: string, maxInputTokens: number): { text: string; tokenCount: number } {
	const tokenCount = countTokens(text);
	if (tokenCount <= maxInputTokens) return { text, tokenCount };
	logger.warn("embedding", "Truncating llama.cpp embedding input to physical-batch safety limit", {
		inputTokens: tokenCount,
		maxInputTokens,
	});
	const bounded = truncateToTokens(text, maxInputTokens);
	return { text: bounded, tokenCount: countTokens(bounded) };
}

async function fetchLlamaCppEmbedding(
	text: string,
	baseUrl: string,
	model: string,
	opts: EmbeddingFetchOptions,
	timeoutMs: number,
	maxInputTokens = DEFAULT_LLAMACPP_MAX_INPUT_TOKENS,
): Promise<{
	readonly embedding: number[] | null;
	readonly tokenCount: number;
	readonly failureCause?: PipelineCauseFamily;
}> {
	const bounded = boundLlamaCppEmbeddingInput(text, maxInputTokens);
	const res = await fetchWithEmbeddingTimeout(
		`${baseUrl.replace(/\/$/, "")}/v1/embeddings`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: bounded.text, model }),
		},
		opts,
		resolveEmbeddingTimeoutMs(opts, timeoutMs),
	);
	if (!res.ok) {
		logger.warn("embedding", "llama.cpp embedding request failed", {
			status: res.status,
			model,
		});
		const responseText = await readResponsePrefix(res, 4096, resolveEmbeddingTimeoutMs(opts, timeoutMs)).catch(
			() => "",
		);
		return {
			embedding: null,
			tokenCount: bounded.tokenCount,
			failureCause: pipelineCauseFromHttpFailure(res.status, responseText),
		};
	}
	const data = (await res.json()) as { data?: Array<{ embedding?: unknown }> };
	const embedding = data.data?.[0]?.embedding;
	return {
		embedding: isEmbeddingVector(embedding) ? embedding : null,
		tokenCount: bounded.tokenCount,
		...(isEmbeddingVector(embedding) ? {} : { failureCause: "parse_failure" as const }),
	};
}

type EmbeddingServeResult = {
	readonly embedding: number[] | null;
	readonly provider: string | null;
	readonly tokenCount: number;
	readonly failureCause?: PipelineCauseFamily;
};

async function fetchNativeFallback(
	provider: NativeFallbackProvider,
	text: string,
	cfg: EmbeddingConfig,
	opts: EmbeddingFetchOptions,
	model: LlamaCppEmbeddingModel | null = nativeFallbackModel,
): Promise<EmbeddingServeResult> {
	if (provider === "ollama") {
		const r = await fetchOllamaEmbedding(text, resolveOllamaUrl(), "nomic-embed-text", opts);
		return { embedding: r.embedding, provider: "ollama", tokenCount: r.tokenCount, failureCause: r.failureCause };
	}
	const r = await fetchLlamaCppEmbedding(
		text,
		resolveLlamaCppFallbackBaseUrl(cfg),
		model ?? "nomic-embed-text",
		opts,
		5000,
		cfg.llamaCppMaxInputTokens,
	);
	return { embedding: r.embedding, provider: "llama-cpp", tokenCount: r.tokenCount, failureCause: r.failureCause };
}

async function probeNativeFallback(
	text: string,
	cfg: EmbeddingConfig,
	opts: EmbeddingFetchOptions,
): Promise<NativeFallbackProbeResult> {
	let observedCause: PipelineCauseFamily | undefined;
	const baseUrl = resolveLlamaCppFallbackBaseUrl(cfg);
	const discoveredModel = await findLlamaCppEmbeddingModel(baseUrl);
	if (discoveredModel) {
		const r = await fetchLlamaCppEmbedding(text, baseUrl, discoveredModel, opts, 5000, cfg.llamaCppMaxInputTokens);
		if (r.embedding) {
			return { provider: "llama-cpp", model: discoveredModel, embedding: r.embedding, tokenCount: r.tokenCount };
		}
		observedCause = preferFallbackCause(observedCause, r.failureCause);
	}

	try {
		const r = await fetchOllamaEmbedding(text, resolveOllamaUrl(), "nomic-embed-text", opts);
		if (r.embedding) {
			return { provider: "ollama", model: null, embedding: r.embedding, tokenCount: r.tokenCount };
		}
		observedCause = preferFallbackCause(observedCause, r.failureCause);
	} catch (error) {
		// The aggregate warning below is the single actionable diagnostic, while
		// retaining the most specific observed cause for operation telemetry.
		observedCause = preferFallbackCause(observedCause, normalizePipelineCause(error));
	}

	return {
		provider: "unavailable",
		model: null,
		embedding: null,
		tokenCount: 0,
		failureCause: observedCause ?? "provider_unavailable",
	};
}

function preferFallbackCause(
	current: PipelineCauseFamily | undefined,
	candidate: PipelineCauseFamily | undefined,
): PipelineCauseFamily | undefined {
	if (!candidate) return current;
	if (!current) return candidate;
	const priority: Record<PipelineCauseFamily, number> = {
		context_limit: 100,
		auth: 90,
		quota: 80,
		rate_limit: 70,
		timeout: 60,
		parse_failure: 50,
		invalid_input: 40,
		provider_unavailable: 30,
		cancellation: 20,
		internal_error: 10,
	};
	return priority[candidate] > priority[current] ? candidate : current;
}

async function resolveNativeFallback(
	text: string,
	cfg: EmbeddingConfig,
	opts: EmbeddingFetchOptions,
	nativeError: string,
): Promise<EmbeddingServeResult> {
	if (nativeFallbackProvider === "unavailable") {
		return { embedding: null, provider: null, tokenCount: 0, failureCause: "provider_unavailable" };
	}
	if (nativeFallbackProvider) return fetchNativeFallback(nativeFallbackProvider, text, cfg, opts);

	if (nativeFallbackProbe) {
		const result = await nativeFallbackProbe.promise;
		return result.provider !== "unavailable"
			? fetchNativeFallback(result.provider, text, cfg, opts, result.model)
			: { embedding: null, provider: null, tokenCount: 0, failureCause: result.failureCause };
	}

	logger.warn("embedding", `Native embedding failed, probing local fallbacks: ${nativeError}`);
	const probe: NativeFallbackProbe = {
		promise: probeNativeFallback(text, cfg, opts),
	};
	nativeFallbackProbe = probe;
	try {
		const result = await probe.promise;
		if (nativeFallbackProbe === probe) {
			nativeFallbackProvider = result.provider;
			nativeFallbackModel = result.model;
			if (result.provider === "llama-cpp") {
				logger.info(
					"embedding",
					`llama.cpp fallback succeeded (model: ${result.model}) — will use llama.cpp for remaining embeddings this session`,
				);
			} else if (result.provider === "ollama") {
				logger.info("embedding", "Ollama fallback succeeded — will use ollama for remaining embeddings this session");
			} else {
				logger.warn("embedding", "Native embedding disabled for this daemon session; no local fallback is ready", {
					error: nativeError,
				});
			}
		}
		return {
			embedding: result.embedding,
			provider: result.provider === "unavailable" ? null : result.provider,
			tokenCount: result.tokenCount,
			failureCause: result.failureCause,
		};
	} finally {
		if (nativeFallbackProbe === probe) nativeFallbackProbe = null;
	}
}

export function resolveEmbeddingBaseUrl(cfg: EmbeddingConfig): string {
	if (cfg.provider === "openai") {
		return cfg.base_url.trim() || DEFAULT_OPENAI_BASE_URL;
	}
	if (cfg.provider === "llama-cpp") {
		return cfg.base_url.trim() || DEFAULT_LLAMACPP_BASE_URL;
	}
	return cfg.base_url;
}

/**
 * The llama.cpp fallback target. Unlike {@link resolveEmbeddingBaseUrl}, this
 * is used when the configured provider is anything else (e.g. `native`): the
 * fallback still probes the user's configured llama.cpp base_url and only
 * falls back to the compiled default when it is empty (#1159).
 */
export function resolveLlamaCppFallbackBaseUrl(cfg: EmbeddingConfig): string {
	return cfg.base_url.trim() || DEFAULT_LLAMACPP_BASE_URL;
}

export function requiresOpenAiApiKey(baseUrl: string): boolean {
	try {
		const parsed = new URL(baseUrl.trim());
		return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname === "api.openai.com";
	} catch {
		return false;
	}
}

export async function resolveEmbeddingApiKey(rawApiKey: string | undefined): Promise<string> {
	const configured = rawApiKey?.trim() ?? "";
	if (configured.startsWith("$secret:")) {
		const secretName = configured.slice("$secret:".length).trim();
		return secretName ? getSecret(secretName) : "";
	}
	if (configured.startsWith("op://")) {
		return getSecret(configured);
	}
	return configured || process.env.OPENAI_API_KEY || "";
}

export function fetchEmbedding(
	text: string,
	cfg: EmbeddingConfig,
	role?: EmbeddingRole,
	opts?: EmbeddingFetchOptions,
): Promise<number[] | null>;
/** @deprecated Pass the role before options. Kept for callers using the former options position. */
export function fetchEmbedding(
	text: string,
	cfg: EmbeddingConfig,
	opts?: EmbeddingFetchOptions,
	role?: EmbeddingRole,
): Promise<number[] | null>;
export async function fetchEmbedding(
	text: string,
	cfg: EmbeddingConfig,
	roleOrOpts: EmbeddingRole | EmbeddingFetchOptions = "document",
	optsOrRole: EmbeddingFetchOptions | EmbeddingRole = {},
): Promise<number[] | null> {
	// Ordinary callers always resolve the generation at request time. This
	// prevents an in-flight writer that captured yesterday's active config from
	// inserting old-space vectors after an atomic promotion. Only the isolated
	// migration worker is allowed to address its staging generation directly.
	const effectiveCfg =
		cfg.indexGeneration === "staging" || !hasDbAccessor()
			? cfg
			: getDbAccessor().withReadDb((db) => resolveActiveEmbeddingConfig(db, cfg));
	if (effectiveCfg.provider === "none") return null;
	const role = typeof roleOrOpts === "string" ? roleOrOpts : typeof optsOrRole === "string" ? optsOrRole : "document";
	const opts = typeof roleOrOpts === "string" ? (typeof optsOrRole === "string" ? {} : optsOrRole) : roleOrOpts;
	const formattedText = formatEmbeddingInput(text, effectiveCfg, role);
	try {
		const serve = await serveEmbedding(formattedText, effectiveCfg, opts);
		if (serve.embedding === null) {
			const causeFamily = serve.failureCause ?? "provider_unavailable";
			if (serve.provider !== null) recordPipelineError("embedding", "EMBEDDING_PROVIDER_DOWN");
			opts.onFailure?.(causeFamily);
		}
		if (serve.embedding !== null && serve.provider !== null) {
			recordEmbeddingUsage({
				provider: serve.provider,
				tokens: serve.tokenCount,
				source: opts.usage?.source ?? "other",
				agentId: opts.usage?.agentId,
				sessionHash: opts.usage?.sessionHash,
				baseUrl: effectiveCfg.base_url,
				costRates: effectiveCfg.costRates,
			});
		}
		return serve.embedding;
	} catch (e) {
		const causeFamily = normalizePipelineCause(e);
		recordPipelineError("embedding", isPipelineTimeout(e) ? "EMBEDDING_TIMEOUT" : "EMBEDDING_PROVIDER_DOWN");
		opts.onFailure?.(causeFamily);
		logger.warn("embedding", "Embedding fetch error", {
			provider: effectiveCfg.provider,
			model: effectiveCfg.model,
			error: e instanceof Error ? e.message : String(e),
		});
		return null;
	}
}

/**
 * Dispatch a formatted embedding request to the effective provider and report
 * which provider actually served and how many tokens the sent text carried.
 * The fallback chain (native -> llama.cpp/ollama) resolves the serving
 * provider inside, so the boundary records the true provider rather than the
 * configured one.
 */
async function serveEmbedding(
	formattedText: string,
	effectiveCfg: EmbeddingConfig,
	opts: EmbeddingFetchOptions,
): Promise<EmbeddingServeResult> {
	if (effectiveCfg.provider === "native") {
		// Kill-switch (#1073): warmNative: false means native is never
		// warmed or routed to, even when the active embedding profile is
		// native. Fall through to the llama.cpp/ollama fallback chain.
		if (effectiveCfg.warmNative === false) {
			return resolveNativeFallback(
				formattedText,
				effectiveCfg,
				opts,
				"native embedding disabled (embedding.warmNative: false)",
			);
		}
		if (nativeFallbackProvider === "unavailable") {
			return { embedding: null, provider: null, tokenCount: 0, failureCause: "provider_unavailable" };
		}
		if (nativeFallbackProvider) return fetchNativeFallback(nativeFallbackProvider, formattedText, effectiveCfg, opts);
		try {
			if (!cachedNativeEmbed) {
				const mod = await import("./native-embedding");
				cachedNativeEmbed = mod.nativeEmbed;
			}
			const embedding = await cachedNativeEmbed(formattedText);
			return {
				embedding: isEmbeddingVector(embedding) ? embedding : null,
				provider: "native",
				tokenCount: countTokens(formattedText),
				...(isEmbeddingVector(embedding) ? {} : { failureCause: "parse_failure" as const }),
			};
		} catch (nativeErr) {
			const fallback = await resolveNativeFallback(
				formattedText,
				effectiveCfg,
				opts,
				nativeErr instanceof Error ? nativeErr.message : String(nativeErr),
			);
			return fallback.provider === null ? { ...fallback, provider: "native" } : fallback;
		}
	}
	if (effectiveCfg.provider === "ollama") {
		const r = await fetchOllamaEmbedding(formattedText, effectiveCfg.base_url, effectiveCfg.model, opts);
		return { embedding: r.embedding, provider: "ollama", tokenCount: r.tokenCount, failureCause: r.failureCause };
	}

	if (effectiveCfg.provider === "llama-cpp") {
		const baseUrl = effectiveCfg.base_url.trim() || DEFAULT_LLAMACPP_BASE_URL;
		const r = await fetchLlamaCppEmbedding(
			formattedText,
			baseUrl,
			effectiveCfg.model,
			opts,
			30000,
			effectiveCfg.llamaCppMaxInputTokens,
		);
		return { embedding: r.embedding, provider: "llama-cpp", tokenCount: r.tokenCount, failureCause: r.failureCause };
	}

	const apiKey = await resolveEmbeddingApiKey(effectiveCfg.api_key);
	const baseUrl = resolveEmbeddingBaseUrl(effectiveCfg);
	if (!apiKey && requiresOpenAiApiKey(baseUrl)) {
		logger.warn("embedding", "No API key configured for OpenAI embeddings, skipping request to api.openai.com");
		return { embedding: null, provider: null, tokenCount: countTokens(formattedText), failureCause: "auth" };
	}
	const res = await fetchWithEmbeddingTimeout(
		`${baseUrl.replace(/\/$/, "")}/embeddings`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({ model: effectiveCfg.model, input: formattedText }),
		},
		opts,
		resolveEmbeddingTimeoutMs(opts, 30000),
	);
	if (!res.ok) {
		logger.warn("embedding", "Embedding API request failed", {
			status: res.status,
			provider: effectiveCfg.provider,
			model: effectiveCfg.model,
		});
		const responseText = await readResponsePrefix(res, 4096, resolveEmbeddingTimeoutMs(opts, 30000)).catch(() => "");
		return {
			embedding: null,
			provider: effectiveCfg.provider,
			tokenCount: countTokens(formattedText),
			failureCause: pipelineCauseFromHttpFailure(res.status, responseText),
		};
	}
	const data = (await res.json()) as { data?: Array<{ embedding?: unknown }> };
	const embedding = data.data?.[0]?.embedding;
	return {
		embedding: isEmbeddingVector(embedding) ? embedding : null,
		provider: effectiveCfg.provider,
		tokenCount: countTokens(formattedText),
		...(isEmbeddingVector(embedding) ? {} : { failureCause: "parse_failure" as const }),
	};
}
