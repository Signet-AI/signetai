/**
 * LLM provider implementations: Ollama (HTTP), Claude Code (CLI subprocess),
 * Anthropic (direct HTTP API), and OpenCode (headless HTTP server).
 *
 * The LlmProvider interface itself lives in @signet/core so that the
 * ingestion pipeline and other consumers can accept any provider.
 */

import type { LlmProvider, LlmGenerateResult } from "@signet/core";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
// On Windows, use node:child_process spawn with windowsHide to prevent
// console window flashing. Bun.spawn doesn't support windowsHide.
import { spawn as nodeSpawn } from "node:child_process";
import { Readable } from "node:stream";
import { logger } from "../logger";
import { trimTrailingSlash } from "./url";

// ---------------------------------------------------------------------------
// Global concurrency semaphore for CLI subprocess providers
// ---------------------------------------------------------------------------
// Prevents starvation when multiple pipeline workers (extraction,
// structural-classify, summary, etc.) all spawn `claude -p` or `codex`
// subprocesses simultaneously. Without this, 10+ concurrent processes
// can cause API rate limiting and timeout cascades.

const DEFAULT_MAX_CONCURRENT_SUBPROCESSES = 4;

class SubprocessSemaphore {
	private readonly max: number;
	private active = 0;
	private readonly queue: Array<() => void> = [];

	constructor(max: number) {
		this.max = max;
	}

	async acquire(): Promise<void> {
		if (this.active < this.max) {
			this.active++;
			return;
		}
		return new Promise<void>((resolve) => {
			this.queue.push(() => {
				this.active++;
				resolve();
			});
		});
	}

	release(): void {
		this.active--;
		const next = this.queue.shift();
		if (next) next();
	}

	get pending(): number {
		return this.queue.length;
	}

	get running(): number {
		return this.active;
	}
}

const subprocessSemaphore = new SubprocessSemaphore(
	process.env.SIGNET_MAX_LLM_CONCURRENCY !== undefined
		? (() => {
				const parsed = Number(process.env.SIGNET_MAX_LLM_CONCURRENCY);
				if (!Number.isFinite(parsed)) {
					logger.warn("pipeline", "SIGNET_MAX_LLM_CONCURRENCY is not a valid number, using default", {
						value: process.env.SIGNET_MAX_LLM_CONCURRENCY,
					});
					return DEFAULT_MAX_CONCURRENT_SUBPROCESSES;
				}
				return Math.max(1, parsed);
			})()
		: DEFAULT_MAX_CONCURRENT_SUBPROCESSES,
);

/**
 * Run an async function guarded by the global subprocess semaphore.
 * Ensures no more than N concurrent CLI subprocess calls across all workers.
 */
async function withSemaphore<T>(fn: () => Promise<T>): Promise<T> {
	await subprocessSemaphore.acquire();
	try {
		return await fn();
	} finally {
		subprocessSemaphore.release();
	}
}

// ---------------------------------------------------------------------------
// Subprocess spawn helper
// ---------------------------------------------------------------------------
// Wraps subprocess spawning with a simplified interface for CLI calls.
// On Windows, uses node:child_process with windowsHide: true to prevent
// console window flashing. On other platforms, uses Bun.spawn directly.

interface SpawnResult {
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	kill(signal?: string): void;
}

function spawnHidden(cmd: string[], options?: { env?: Record<string, string | undefined> }): SpawnResult {
	// Resolve the binary via Bun.which() so that .cmd wrappers on Windows
	// are found correctly (mirrors scheduler/spawn.ts pattern).
	const [bin, ...args] = cmd;
	const resolvedBin = Bun.which(bin);
	if (resolvedBin === null) {
		throw new Error(`spawnHidden: binary "${bin}" not found on PATH`);
	}
	const sanitizedEnv: Record<string, string> = {};
	if (options?.env) {
		for (const [k, v] of Object.entries(options.env)) {
			if (v !== undefined) sanitizedEnv[k] = v;
		}
	}

	// On Windows, use node:child_process with windowsHide to prevent
	// console window flashing. Bun.spawn doesn't support windowsHide.
	if (process.platform === "win32") {
		const child = nodeSpawn(resolvedBin, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: options?.env ? sanitizedEnv : undefined,
			windowsHide: true,
		});

		// Convert Node.js Readable streams to Web ReadableStreams
		const toWebStream = (nodeStream: import("node:stream").Readable): ReadableStream<Uint8Array> =>
			Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

		const exitPromise = new Promise<number>((resolve, reject) => {
			child.on("exit", (code) => resolve(code ?? 1));
			child.on("error", (err) => reject(err));
		});

		if (!child.stdout || !child.stderr) {
			throw new Error("spawnHidden(win32): stdout/stderr unexpectedly null");
		}

		return {
			stdout: toWebStream(child.stdout),
			stderr: toWebStream(child.stderr),
			exited: exitPromise,
			kill(signal?: string) {
				if (signal === "SIGKILL") {
					child.kill();
				} else {
					child.kill("SIGTERM");
				}
			},
		};
	}

	// Non-Windows: use Bun.spawn directly for reliable I/O.
	const proc = Bun.spawn([resolvedBin, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: options?.env ? sanitizedEnv : undefined,
	});

	if (!proc.stdout || !proc.stderr) {
		throw new Error("spawnHidden: stdout/stderr unexpectedly null despite pipe mode");
	}

	return {
		stdout: proc.stdout,
		stderr: proc.stderr,
		exited: proc.exited,
		kill(signal?: string) {
			const sigMap: Record<string, number | undefined> = { SIGTERM: 15, SIGKILL: 9 };
			const sigNum = signal ? sigMap[signal] : 15;
			if (signal && sigNum === undefined) {
				logger.warn("pipeline", `Unknown signal "${signal}", defaulting to SIGTERM`);
			}
			proc.kill(sigNum ?? 15);
		},
	};
}

export type { LlmProvider, LlmGenerateResult } from "@signet/core";

// ---------------------------------------------------------------------------
// Helper: call generateWithUsage if available, fall back to generate
// ---------------------------------------------------------------------------

export async function generateWithTracking(
	provider: LlmProvider,
	prompt: string,
	opts?: { timeoutMs?: number; maxTokens?: number },
): Promise<LlmGenerateResult> {
	if (provider.generateWithUsage) {
		return provider.generateWithUsage(prompt, opts);
	}
	const text = await provider.generate(prompt, opts);
	return { text, usage: null };
}

// ---------------------------------------------------------------------------
// Ollama via HTTP API
// ---------------------------------------------------------------------------

export interface OllamaProviderConfig {
	readonly model?: string;
	readonly baseUrl: string;
	readonly defaultTimeoutMs: number;
	readonly maxContextTokens?: number;
}

export const DEFAULT_OLLAMA_FALLBACK_MODEL = "llama3.2:3b";
export const DEFAULT_OLLAMA_FALLBACK_MAX_CONTEXT_TOKENS = 8192;

const DEFAULT_OLLAMA_CONFIG = {
	baseUrl: "http://127.0.0.1:11434",
	defaultTimeoutMs: 90000,
};

function parseOptionalPositiveInt(raw: string | undefined): number | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!/^[1-9]\d*$/.test(trimmed)) return undefined;
	return normalizePositiveInt(Number(trimmed));
}

function normalizePositiveInt(value: number | undefined): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	const normalized = Math.floor(value);
	if (normalized <= 0 || !Number.isSafeInteger(normalized)) return undefined;
	return normalized;
}

export function resolveDefaultOllamaFallbackModel(): string {
	const raw = process.env.SIGNET_OLLAMA_FALLBACK_MODEL;
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed.length > 0) return trimmed;
	}
	return DEFAULT_OLLAMA_FALLBACK_MODEL;
}

export function resolveDefaultOllamaFallbackMaxContextTokens(): number {
	return (
		parseOptionalPositiveInt(process.env.SIGNET_OLLAMA_FALLBACK_MAX_CTX)
		?? DEFAULT_OLLAMA_FALLBACK_MAX_CONTEXT_TOKENS
	);
}

interface OllamaGenerateResponse {
	readonly response?: string;
	readonly eval_count?: number;
	readonly prompt_eval_count?: number;
	readonly total_duration?: number;
	readonly eval_duration?: number;
}

export function createOllamaProvider(
	config?: Partial<OllamaProviderConfig>,
): LlmProvider {
	const rawModel = config?.model;
	const model =
		typeof rawModel === "string" && rawModel.trim().length > 0
			? rawModel.trim()
			: resolveDefaultOllamaFallbackModel();
	const cfg = {
		baseUrl: trimTrailingSlash(config?.baseUrl ?? DEFAULT_OLLAMA_CONFIG.baseUrl),
		defaultTimeoutMs:
			config?.defaultTimeoutMs ?? DEFAULT_OLLAMA_CONFIG.defaultTimeoutMs,
		maxContextTokens: normalizePositiveInt(config?.maxContextTokens),
		model,
	};

	async function callOllama(
		prompt: string,
		opts?: { timeoutMs?: number; maxTokens?: number },
	): Promise<OllamaGenerateResponse> {
		const timeoutMs = opts?.timeoutMs ?? cfg.defaultTimeoutMs;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const options: Record<string, number> = {};
			if (opts?.maxTokens) options.num_predict = opts.maxTokens;
			if (cfg.maxContextTokens !== undefined) {
				options.num_ctx = cfg.maxContextTokens;
			}
			const res = await fetch(`${cfg.baseUrl}/api/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: cfg.model,
					prompt,
					stream: false,
					...(Object.keys(options).length > 0 ? { options } : {}),
				}),
				signal: controller.signal,
			});

			if (!res.ok) {
				const body = await res.text().catch(() => "");
				throw new Error(
					`Ollama HTTP ${res.status}: ${body.slice(0, 200)}`,
				);
			}

			const data = (await res.json()) as OllamaGenerateResponse;
			if (typeof data.response !== "string") {
				throw new Error("Ollama returned no response field");
			}

			return data;
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") {
				throw new Error(`Ollama timeout after ${timeoutMs}ms`);
			}
			throw e;
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		name: `ollama:${cfg.model}`,

		async generate(prompt, opts): Promise<string> {
			const data = await callOllama(prompt, opts);
			return (data.response ?? "").trim();
		},

		async generateWithUsage(prompt, opts): Promise<LlmGenerateResult> {
			const data = await callOllama(prompt, opts);
			const nsToMs = (ns: number | undefined): number | null =>
				typeof ns === "number" ? Math.round(ns / 1_000_000) : null;

			return {
				text: (data.response ?? "").trim(),
				usage: {
					inputTokens: data.prompt_eval_count ?? null,
					outputTokens: data.eval_count ?? null,
					cacheReadTokens: null,
					cacheCreationTokens: null,
					totalCost: null,
					totalDurationMs: nsToMs(data.total_duration),
				},
			};
		},

		async available(): Promise<boolean> {
			try {
				const res = await fetch(`${cfg.baseUrl}/api/tags`, {
					signal: AbortSignal.timeout(3000),
				});
				return res.ok;
			} catch {
				logger.debug("pipeline", "Ollama not available");
				return false;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Claude Code via headless CLI
// ---------------------------------------------------------------------------

export interface ClaudeCodeProviderConfig {
	readonly model: string;
	readonly defaultTimeoutMs: number;
}

const DEFAULT_CLAUDE_CODE_CONFIG: ClaudeCodeProviderConfig = {
	model: "haiku",
	defaultTimeoutMs: 60000,
};

interface ClaudeCodeJsonResponse {
	readonly result?: string;
	readonly usage?: {
		readonly input_tokens?: number;
		readonly output_tokens?: number;
		readonly cache_creation_input_tokens?: number;
		readonly cache_read_input_tokens?: number;
	};
	readonly cost_usd?: number;
}

export function createClaudeCodeProvider(
	config?: Partial<ClaudeCodeProviderConfig>,
): LlmProvider {
	const cfg = { ...DEFAULT_CLAUDE_CODE_CONFIG, ...config };

	async function callClaude(
		prompt: string,
		outputFormat: "text" | "json",
		opts?: { timeoutMs?: number; maxTokens?: number },
	): Promise<string> {
		return withSemaphore(async () => {
			const timeoutMs = opts?.timeoutMs ?? cfg.defaultTimeoutMs;

			const args = [
				"-p", prompt,
				"--model", cfg.model,
				"--no-session-persistence",
				"--output-format", outputFormat,
			];

			// Strip ALL Claude Code env vars to prevent nested-session
			// detection when the daemon is launched from a CC session.
			// Also inject SIGNET_NO_HOOKS to prevent recursive hook loops.
			const cleanEnv: Record<string, string> = {};
			for (const [k, v] of Object.entries(process.env)) {
				if (v === undefined) continue;
				if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "SIGNET_NO_HOOKS") continue;
				cleanEnv[k] = v;
			}

			logger.debug("pipeline", "Spawning claude-code subprocess", {
				model: cfg.model,
				outputFormat,
				promptLen: prompt.length,
				timeoutMs,
			});

			const proc = spawnHidden(["claude", ...args], {
				env: { ...cleanEnv, NO_COLOR: "1", SIGNET_NO_HOOKS: "1" },
			});

			// Race the subprocess against a timeout. On timeout we kill the
			// process and reject immediately instead of waiting for streams
			// to drain — a hanging subprocess may never close its stdio.
			const SIGKILL_GRACE_MS = 2000;

			const timeoutPromise = new Promise<never>((_resolve, reject) => {
				let killTimer: ReturnType<typeof setTimeout> | null = null;
				const timer = setTimeout(() => {
					// SIGTERM first, SIGKILL after grace period
					try { proc.kill("SIGTERM"); } catch { /* already exited */ }
					killTimer = setTimeout(() => {
						try { proc.kill("SIGKILL"); } catch { /* already dead */ }
					}, SIGKILL_GRACE_MS);
					reject(new Error(`claude-code timeout after ${timeoutMs}ms`));
				}, timeoutMs);
				// Clear both timers if the process exits on its own
				proc.exited
					.then(() => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); })
					.catch(() => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); });
			});

			const resultPromise = (async (): Promise<string> => {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text().catch(() => ""),
					new Response(proc.stderr).text().catch(() => ""),
					proc.exited.catch(() => -1),
				]);

				if (exitCode !== 0) {
					throw new Error(
						`claude-code exit ${exitCode}: ${stderr.slice(0, 300)}`,
					);
				}

				const result = stdout.trim();
				if (result.length === 0) {
					throw new Error("claude-code returned empty output");
				}

				return result;
			})();

			// Guard against unhandled rejection if resultPromise rejects
			// after the timeout wins the race (e.g. subprocess exit error
			// after SIGKILL). The no-op catch prevents crashing the process.
			resultPromise.catch(() => {});

			return Promise.race([resultPromise, timeoutPromise]);
		});
	}

	return {
		name: `claude-code:${cfg.model}`,

		async generate(prompt, opts): Promise<string> {
			return callClaude(prompt, "text", opts);
		},

		async generateWithUsage(prompt, opts): Promise<LlmGenerateResult> {
			const raw = await callClaude(prompt, "json", opts);
			let parsed: ClaudeCodeJsonResponse | undefined;
			try {
				parsed = JSON.parse(raw) as ClaudeCodeJsonResponse;
			} catch {
				// JSON parse failed — treat raw output as text, no usage
				return { text: raw, usage: null };
			}

			// Detect error responses (e.g. budget cap) that exit 0 but
			// carry no usable result — just an error blob with subtype.
			if (!parsed.result) {
				const blob = parsed as Record<string, unknown>;
				const subtype = typeof blob.subtype === "string" ? blob.subtype : "";
				if (subtype.startsWith("error")) {
					throw new Error(`claude-code error: ${subtype}`);
				}
			}

			const text = parsed.result ?? raw;
			const u = parsed.usage;
			return {
				text,
				usage: u ? {
					inputTokens: u.input_tokens ?? null,
					outputTokens: u.output_tokens ?? null,
					cacheReadTokens: u.cache_read_input_tokens ?? null,
					cacheCreationTokens: u.cache_creation_input_tokens ?? null,
					totalCost: parsed.cost_usd ?? null,
					totalDurationMs: null,
				} : null,
			};
		},

		async available(): Promise<boolean> {
			try {
				const proc = spawnHidden(["claude", "--version"], {
					env: { ...process.env, SIGNET_NO_HOOKS: "1" },
				});
				const exitCode = await proc.exited;
				return exitCode === 0;
			} catch {
				logger.debug("pipeline", "Claude Code CLI not available");
				return false;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Anthropic via direct HTTP API
// ---------------------------------------------------------------------------
// Bypasses the Claude Code CLI subprocess entirely by calling the
// Anthropic Messages API over HTTP. Eliminates subprocess hanging,
// auth-prompt deadlocks, and concurrency starvation.

export interface AnthropicProviderConfig {
	readonly model: string;
	readonly apiKey: string;
	readonly baseUrl: string;
	readonly defaultTimeoutMs: number;
	readonly maxRetries: number;
}

const DEFAULT_ANTHROPIC_CONFIG: AnthropicProviderConfig = {
	model: "claude-haiku-4-5-20251001",
	apiKey: "",
	baseUrl: "https://api.anthropic.com",
	defaultTimeoutMs: 60000,
	maxRetries: 2,
};

const ANTHROPIC_API_VERSION = "2023-06-01";

/** Map short model aliases to full Anthropic model IDs. */
function resolveAnthropicModel(model: string): string {
	const aliases: Record<string, string> = {
		haiku: "claude-haiku-4-5-20251001",
		sonnet: "claude-sonnet-4-5-20250514",
		opus: "claude-opus-4-5-20250514",
	};
	return aliases[model] ?? model;
}

interface AnthropicUsage {
	readonly input_tokens?: number;
	readonly output_tokens?: number;
	readonly cache_creation_input_tokens?: number;
	readonly cache_read_input_tokens?: number;
}

interface AnthropicContentBlock {
	readonly type: string;
	readonly text?: string;
}

interface AnthropicErrorBody {
	readonly type?: string;
	readonly error?: {
		readonly type?: string;
		readonly message?: string;
	};
}

interface AnthropicResponse {
	readonly id?: string;
	readonly content?: readonly AnthropicContentBlock[];
	readonly usage?: AnthropicUsage;
	readonly stop_reason?: string;
}

/** Sentinel error type for failures that should never be retried
 *  (auth errors, timeouts, empty responses, non-transient HTTP 4xx). */
class NonRetryableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NonRetryableError";
	}
}

function isRetryableStatus(status: number): boolean {
	// 429 = rate limited, 500 = internal error, 502/503/504 = transient gateway,
	// 529 = overloaded. Don't retry 501 (not implemented) or other 5xx.
	return status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
}

export function createAnthropicProvider(
	config?: Partial<AnthropicProviderConfig>,
): LlmProvider {
	const cfg = { ...DEFAULT_ANTHROPIC_CONFIG, ...config };
	const resolvedModel = resolveAnthropicModel(cfg.model);

	if (!cfg.apiKey) {
		throw new Error(
			"Anthropic provider requires an API key. Set ANTHROPIC_API_KEY env var or configure it in Signet secrets.",
		);
	}

	async function callAnthropic(
		prompt: string,
		opts?: { timeoutMs?: number; maxTokens?: number },
	): Promise<{ text: string; usage: AnthropicUsage | null }> {
		const timeoutMs = opts?.timeoutMs ?? cfg.defaultTimeoutMs;
		const maxTokens = opts?.maxTokens || 4096;
		const url = `${cfg.baseUrl}/v1/messages`;
		const body = JSON.stringify({
			model: resolvedModel,
			max_tokens: maxTokens,
			messages: [{ role: "user", content: prompt }],
		});

		let lastError: Error | null = null;
		// Use a single absolute deadline so retries cannot exceed the
		// configured timeout.
		const deadline = Date.now() + timeoutMs;

		for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
			if (attempt > 0) {
				// Exponential backoff happens OUTSIDE the semaphore so idle
				// sleep doesn't block other providers from using the slot.
				const backoffMs = Math.min(1000 * (2 ** (attempt - 1)), 8000);
				await new Promise((r) => setTimeout(r, backoffMs));

				logger.debug("pipeline", "Anthropic API retry", {
					attempt,
					maxRetries: cfg.maxRetries,
					backoffMs,
				});
			}

			// Pre-check deadline before waiting on semaphore
			if (deadline - Date.now() <= 0) {
				const reason = lastError ? `last error: ${lastError.message}` : "no successful attempt";
				throw new Error(`Anthropic timeout after ${timeoutMs}ms (deadline exceeded before attempt ${attempt}; ${reason})`);
			}

			// Acquire semaphore only for the actual API call, release
			// immediately after so backoff sleep doesn't hold a slot.
			const result = await withSemaphore(async () => {
				// Recompute remaining time AFTER semaphore acquisition so
				// contention delay is accounted for in the abort timer.
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) {
					const reason = lastError ? `last error: ${lastError.message}` : "no successful attempt";
					throw new Error(`Anthropic timeout after ${timeoutMs}ms (deadline exceeded waiting for semaphore; ${reason})`);
				}
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), remainingMs);

				try {
					const res = await fetch(url, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"x-api-key": cfg.apiKey,
							"anthropic-version": ANTHROPIC_API_VERSION,
						},
						body,
						signal: controller.signal,
					});

					if (!res.ok) {
						const rawBody = await res.text().catch(() => "");
						let errorDetail = rawBody.slice(0, 300);

						// Parse structured error if available
						try {
							const parsed = JSON.parse(rawBody) as AnthropicErrorBody;
							if (parsed.error?.message) {
								errorDetail = `${parsed.error.type ?? "error"}: ${parsed.error.message}`;
							}
						} catch {
							// Use raw body
						}

						if (res.status === 401) {
							throw new NonRetryableError(
								`Anthropic auth failed (401): ${errorDetail}. Check your ANTHROPIC_API_KEY.`,
							);
						}

						if (isRetryableStatus(res.status) && attempt < cfg.maxRetries) {
							lastError = new Error(
								`Anthropic HTTP ${res.status}: ${errorDetail}`,
							);
							logger.warn("pipeline", "Anthropic API retryable error", {
								status: res.status,
								attempt,
								detail: errorDetail.slice(0, 100),
							});
							return { retry: true } as const;
						}

						throw new NonRetryableError(
							`Anthropic HTTP ${res.status}: ${errorDetail}`,
						);
					}

					const data = (await res.json()) as AnthropicResponse;

					// Extract text from content blocks
					const textParts: string[] = [];
					if (Array.isArray(data.content)) {
						for (const block of data.content) {
							if (block.type === "text" && typeof block.text === "string") {
								textParts.push(block.text);
							}
						}
					}

					const text = textParts.join("\n").trim();
					if (text.length === 0) {
						throw new NonRetryableError(
							`Anthropic returned empty response (stop_reason: ${data.stop_reason ?? "unknown"})`,
						);
					}

					return { retry: false, text, usage: data.usage ?? null } as const;
				} catch (e) {
					if (e instanceof DOMException && e.name === "AbortError") {
						throw new NonRetryableError(`Anthropic timeout after ${timeoutMs}ms`);
					}

					// Non-retryable errors use the typed sentinel —
					// no substring matching needed.
					if (e instanceof NonRetryableError) {
						throw e;
					}

					lastError = e instanceof Error ? e : new Error(String(e));

					if (attempt < cfg.maxRetries) {
						logger.warn("pipeline", "Anthropic API network error", {
							attempt,
							error: lastError.message.slice(0, 100),
						});
						return { retry: true } as const;
					}

					throw lastError;
				} finally {
					clearTimeout(timer);
				}
			});

			if (!result.retry) {
				return { text: result.text, usage: result.usage };
			}
		}

		throw lastError ?? new Error("Anthropic call failed after retries");
	}

	return {
		name: `anthropic:${resolvedModel}`,

		async generate(prompt, opts): Promise<string> {
			const { text } = await callAnthropic(prompt, opts);
			return text;
		},

		async generateWithUsage(prompt, opts): Promise<LlmGenerateResult> {
			const { text, usage } = await callAnthropic(prompt, opts);
			return {
				text,
				usage: usage
					? {
							inputTokens: usage.input_tokens ?? null,
							outputTokens: usage.output_tokens ?? null,
							cacheReadTokens: usage.cache_read_input_tokens ?? null,
							cacheCreationTokens: usage.cache_creation_input_tokens ?? null,
							totalCost: null,
							totalDurationMs: null,
						}
					: null,
			};
		},

		async available(): Promise<boolean> {
			try {
				const res = await fetch(`${cfg.baseUrl}/v1/models`, {
					headers: {
						"x-api-key": cfg.apiKey,
						"anthropic-version": ANTHROPIC_API_VERSION,
					},
					signal: AbortSignal.timeout(10_000),
				});
				// 200 = works; 401 = bad key means provider is NOT usable
				if (res.status === 401) {
					logger.warn("pipeline", "Anthropic API key is invalid (401)");
					return false;
				}
				return res.ok;
			} catch {
				logger.debug("pipeline", "Anthropic API not reachable");
				return false;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// OpenRouter via direct HTTP API
// ---------------------------------------------------------------------------

export interface OpenRouterProviderConfig {
	readonly model: string;
	readonly apiKey: string;
	readonly baseUrl: string;
	readonly defaultTimeoutMs: number;
	readonly maxRetries: number;
	readonly referer?: string;
	readonly title?: string;
}

const DEFAULT_OPENROUTER_CONFIG: OpenRouterProviderConfig = {
	model: "openai/gpt-4o-mini",
	apiKey: "",
	baseUrl: "https://openrouter.ai/api/v1",
	defaultTimeoutMs: 60000,
	maxRetries: 2,
	referer: undefined,
	title: undefined,
};

interface OpenRouterContentPart {
	readonly type?: string;
	readonly text?: string;
}

interface OpenRouterChoice {
	readonly message?: {
		readonly content?: string | readonly OpenRouterContentPart[];
	};
}

interface OpenRouterUsage {
	readonly prompt_tokens?: number;
	readonly completion_tokens?: number;
	readonly cost?: number;
	readonly prompt_tokens_details?: {
		readonly cached_tokens?: number;
	};
}

interface OpenRouterErrorBody {
	readonly error?: {
		readonly message?: string;
		readonly code?: number | string;
	};
}

interface OpenRouterResponse {
	readonly choices?: readonly OpenRouterChoice[];
	readonly usage?: OpenRouterUsage;
}

function extractOpenRouterText(content: string | readonly OpenRouterContentPart[] | undefined): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part?.type !== "text") continue;
		if (typeof part.text !== "string") continue;
		const text = part.text.trim();
		if (text.length > 0) parts.push(text);
	}
	return parts.join("\n").trim();
}

export function createOpenRouterProvider(
	config?: Partial<OpenRouterProviderConfig>,
): LlmProvider {
	const cfg = {
		...DEFAULT_OPENROUTER_CONFIG,
		...config,
		baseUrl: trimTrailingSlash(config?.baseUrl ?? DEFAULT_OPENROUTER_CONFIG.baseUrl),
	};

	if (!cfg.apiKey) {
		throw new Error(
			"OpenRouter provider requires an API key. Set OPENROUTER_API_KEY env var or configure it in Signet secrets.",
		);
	}

	async function callOpenRouter(
		prompt: string,
		opts?: { timeoutMs?: number; maxTokens?: number },
	): Promise<{ text: string; usage: OpenRouterUsage | null }> {
		const timeoutMs = opts?.timeoutMs ?? cfg.defaultTimeoutMs;
		const maxTokens = opts?.maxTokens ?? 4096;
		const url = `${cfg.baseUrl}/chat/completions`;
		const body = JSON.stringify({
			model: cfg.model,
			messages: [{ role: "user", content: prompt }],
			max_tokens: maxTokens,
		});

		let lastError: Error | null = null;
		const deadline = Date.now() + timeoutMs;

		for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
			if (attempt > 0) {
				const backoffMs = Math.min(1000 * (2 ** (attempt - 1)), 8000);
				await new Promise((r) => setTimeout(r, backoffMs));
				logger.debug("pipeline", "OpenRouter API retry", {
					attempt,
					maxRetries: cfg.maxRetries,
					backoffMs,
				});
			}

			if (deadline - Date.now() <= 0) {
				const reason = lastError ? `last error: ${lastError.message}` : "no successful attempt";
				throw new Error(`OpenRouter timeout after ${timeoutMs}ms (deadline exceeded before attempt ${attempt}; ${reason})`);
			}

			const result = await withSemaphore(async () => {
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) {
					const reason = lastError ? `last error: ${lastError.message}` : "no successful attempt";
					throw new Error(`OpenRouter timeout after ${timeoutMs}ms (deadline exceeded waiting for semaphore; ${reason})`);
				}

				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), remainingMs);

				try {
					const headers: Record<string, string> = {
						"Content-Type": "application/json",
						Authorization: `Bearer ${cfg.apiKey}`,
					};
					if (cfg.referer) headers["HTTP-Referer"] = cfg.referer;
					if (cfg.title) {
						headers["X-OpenRouter-Title"] = cfg.title;
						headers["X-Title"] = cfg.title;
					}

					const res = await fetch(url, {
						method: "POST",
						headers,
						body,
						signal: controller.signal,
					});

					if (!res.ok) {
						const rawBody = await res.text().catch(() => "");
						let detail = rawBody.slice(0, 300);
						try {
							const parsed = JSON.parse(rawBody) as OpenRouterErrorBody;
							if (parsed.error?.message) {
								detail = parsed.error.message;
							}
						} catch {
							// Use raw body snippet
						}

						if (res.status === 401 || res.status === 403) {
							throw new NonRetryableError(
								`OpenRouter auth failed (${res.status}): ${detail}. Check your OPENROUTER_API_KEY.`,
							);
						}

						if (isRetryableStatus(res.status) && attempt < cfg.maxRetries) {
							lastError = new Error(`OpenRouter HTTP ${res.status}: ${detail}`);
							logger.warn("pipeline", "OpenRouter API retryable error", {
								status: res.status,
								attempt,
								detail: detail.slice(0, 100),
							});
							return { retry: true } as const;
						}

						throw new NonRetryableError(`OpenRouter HTTP ${res.status}: ${detail}`);
					}

					const data = (await res.json()) as OpenRouterResponse;
					const first = Array.isArray(data.choices) ? data.choices[0] : undefined;
					const text = extractOpenRouterText(first?.message?.content);
					if (text.length === 0) {
						throw new NonRetryableError("OpenRouter returned empty response");
					}

					return {
						retry: false,
						text,
						usage: data.usage ?? null,
					} as const;
				} catch (e) {
					if (e instanceof DOMException && e.name === "AbortError") {
						throw new NonRetryableError(`OpenRouter timeout after ${timeoutMs}ms`);
					}
					if (e instanceof NonRetryableError) {
						throw e;
					}

					lastError = e instanceof Error ? e : new Error(String(e));
					if (attempt < cfg.maxRetries) {
						logger.warn("pipeline", "OpenRouter API network error", {
							attempt,
							error: lastError.message.slice(0, 100),
						});
						return { retry: true } as const;
					}
					throw lastError;
				} finally {
					clearTimeout(timer);
				}
			});

			if (!result.retry) {
				return { text: result.text, usage: result.usage };
			}
		}

		throw lastError ?? new Error("OpenRouter call failed after retries");
	}

	return {
		name: `openrouter:${cfg.model}`,

		async generate(prompt, opts): Promise<string> {
			const { text } = await callOpenRouter(prompt, opts);
			return text;
		},

		async generateWithUsage(prompt, opts): Promise<LlmGenerateResult> {
			const { text, usage } = await callOpenRouter(prompt, opts);
			return {
				text,
				usage: usage
					? {
							inputTokens: usage.prompt_tokens ?? null,
							outputTokens: usage.completion_tokens ?? null,
							cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
							cacheCreationTokens: null,
							totalCost: usage.cost ?? null,
							totalDurationMs: null,
						}
					: null,
			};
		},

		async available(): Promise<boolean> {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${cfg.apiKey}`,
			};
			if (cfg.referer) headers["HTTP-Referer"] = cfg.referer;
			if (cfg.title) {
				headers["X-OpenRouter-Title"] = cfg.title;
				headers["X-Title"] = cfg.title;
			}

			try {
				const res = await fetch(`${cfg.baseUrl}/models`, {
					headers,
					signal: AbortSignal.timeout(10_000),
				});
				if (res.status === 401 || res.status === 403) {
					logger.warn("pipeline", `OpenRouter API key is invalid (${res.status})`);
					return false;
				}
				return res.ok;
			} catch {
				logger.debug("pipeline", "OpenRouter API not reachable");
				return false;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Codex via local CLI
// ---------------------------------------------------------------------------

export interface CodexProviderConfig {
	readonly model: string;
	readonly defaultTimeoutMs: number;
	readonly workingDirectory: string;
}

const DEFAULT_CODEX_CONFIG: CodexProviderConfig = {
	model: "gpt-5.3-codex",
	defaultTimeoutMs: 60000,
	workingDirectory: homedir(),
};

interface CodexTurnUsage {
	readonly input_tokens?: number;
	readonly cached_input_tokens?: number;
	readonly output_tokens?: number;
}

function parseCodexJsonl(raw: string): LlmGenerateResult {
	const messages: string[] = [];
	let usage: LlmGenerateResult["usage"] = null;

	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}

		if (typeof parsed !== "object" || parsed === null) continue;
		const event = parsed as Record<string, unknown>;

		if (event.type === "item.completed") {
			const item = event.item;
			if (typeof item === "object" && item !== null) {
				const record = item as Record<string, unknown>;
				if (record.type === "agent_message" && typeof record.text === "string") {
					messages.push(record.text.trim());
				}
			}
		}

		if (event.type === "turn.completed") {
			const rawUsage = event.usage;
			if (typeof rawUsage === "object" && rawUsage !== null) {
				const turnUsage = rawUsage as CodexTurnUsage;
				usage = {
					inputTokens:
						typeof turnUsage.input_tokens === "number"
							? turnUsage.input_tokens
							: null,
					outputTokens:
						typeof turnUsage.output_tokens === "number"
							? turnUsage.output_tokens
							: null,
					cacheReadTokens:
						typeof turnUsage.cached_input_tokens === "number"
							? turnUsage.cached_input_tokens
							: null,
					cacheCreationTokens: null,
					totalCost: null,
					totalDurationMs: null,
				};
			}
		}
	}

	const text = messages.join("\n").trim();
	if (text.length === 0) {
		throw new Error("codex returned empty output");
	}

	return { text, usage };
}

export function createCodexProvider(
	config?: Partial<CodexProviderConfig>,
): LlmProvider {
	const cfg = { ...DEFAULT_CODEX_CONFIG, ...config };

	async function callCodex(
		prompt: string,
		opts?: { timeoutMs?: number; maxTokens?: number },
	): Promise<LlmGenerateResult> {
		return withSemaphore(async () => {
			const timeoutMs = opts?.timeoutMs ?? cfg.defaultTimeoutMs;
			const args = [
				"exec",
				"--skip-git-repo-check",
				"--json",
				"--sandbox",
				"read-only",
				"-C",
				cfg.workingDirectory,
				"--model",
				cfg.model,
				prompt,
			];

			const { SIGNET_NO_HOOKS: _, SIGNET_CODEX_BYPASS_WRAPPER: __, ...cleanEnv } = process.env;
			const proc = spawnHidden(["codex", ...args], {
				env: {
					...cleanEnv,
					NO_COLOR: "1",
					SIGNET_NO_HOOKS: "1",
					SIGNET_CODEX_BYPASS_WRAPPER: "1",
				},
			});

			// Race the subprocess against a timeout. On timeout we kill the
			// process and reject immediately instead of waiting for streams
			// to drain — a hanging subprocess may never close its stdio.
			const SIGKILL_GRACE_MS = 2000;

			const timeoutPromise = new Promise<never>((_resolve, reject) => {
				let killTimer: ReturnType<typeof setTimeout> | null = null;
				const timer = setTimeout(() => {
					try { proc.kill("SIGTERM"); } catch { /* already exited */ }
					killTimer = setTimeout(() => {
						try { proc.kill("SIGKILL"); } catch { /* already dead */ }
					}, SIGKILL_GRACE_MS);
					reject(new Error(`codex timeout after ${timeoutMs}ms`));
				}, timeoutMs);
				proc.exited
					.then(() => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); })
					.catch(() => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); });
			});

			const resultPromise = (async (): Promise<LlmGenerateResult> => {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text().catch(() => ""),
					new Response(proc.stderr).text().catch(() => ""),
					proc.exited.catch(() => -1),
				]);

				if (exitCode !== 0) {
					const detail = stderr.trim() || stdout.trim();
					throw new Error(`codex exit ${exitCode}: ${detail.slice(0, 500)}`);
				}
				return parseCodexJsonl(stdout);
			})();

			// Guard against unhandled rejection if resultPromise rejects
			// after the timeout wins the race.
			resultPromise.catch(() => {});

			return Promise.race([resultPromise, timeoutPromise]);
		});
	}

	return {
		name: `codex:${cfg.model}`,

		async generate(prompt, opts): Promise<string> {
			const result = await callCodex(prompt, opts);
			return result.text;
		},

		async generateWithUsage(prompt, opts): Promise<LlmGenerateResult> {
			return callCodex(prompt, opts);
		},

		async available(): Promise<boolean> {
			try {
				const proc = spawnHidden(["codex", "--version"], {
					env: {
						...process.env,
						SIGNET_NO_HOOKS: "1",
						SIGNET_CODEX_BYPASS_WRAPPER: "1",
					},
				});
				const exitCode = await proc.exited;
				return exitCode === 0;
			} catch {
				logger.debug("pipeline", "Codex CLI not available");
				return false;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// OpenCode via headless HTTP server
// ---------------------------------------------------------------------------

export interface OpenCodeProviderConfig {
	readonly baseUrl: string;
	readonly model: string;
	readonly defaultTimeoutMs: number;
	readonly enableOllamaFallback: boolean;
	readonly ollamaFallbackModel?: string;
	readonly ollamaFallbackBaseUrl: string;
	readonly ollamaFallbackMaxContextTokens?: number;
}

const DEFAULT_OPENCODE_CONFIG: OpenCodeProviderConfig = {
	baseUrl: "http://127.0.0.1:4096",
	model: "anthropic/claude-haiku-4-5-20251001",
	defaultTimeoutMs: 60000,
	enableOllamaFallback: true,
	ollamaFallbackModel: undefined,
	ollamaFallbackBaseUrl: "http://127.0.0.1:11434",
	ollamaFallbackMaxContextTokens: undefined,
};

/**
 * Resolve the opencode binary path. Checks PATH first via `which`,
 * then falls back to the well-known install location.
 */
function resolveOpenCodeBin(): string | null {
	// Check PATH first (Bun.which works cross-platform)
	const found = Bun.which("opencode");
	if (found) return found;

	// Fall back to ~/.opencode/bin/opencode
	const fallback = `${homedir()}/.opencode/bin/opencode`;
	if (existsSync(fallback)) return fallback;

	return null;
}

/** Tracked child process so we can kill it on daemon shutdown. */
let openCodeChild: {
	readonly process: ReturnType<typeof Bun.spawn>;
	readonly port: number;
} | null = null;

/**
 * Attempt to start `opencode serve` if not already running on the
 * configured port. Tracks the child for explicit cleanup.
 */
export async function ensureOpenCodeServer(port: number): Promise<boolean> {
	const healthUrl = `http://127.0.0.1:${port}/global/health`;

	// Already managed by us?
	if (openCodeChild?.port === port) {
		try {
			const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
			if (res.ok) return true;
		} catch {
			openCodeChild = null;
		}
	}

	// Maybe externally running?
	try {
		const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
		if (res.ok) return true;
	} catch {
		// Not running — start it
	}

	const bin = resolveOpenCodeBin();
	if (!bin) {
		logger.warn("pipeline", "OpenCode binary not found in PATH or ~/.opencode/bin/");
		return false;
	}

	logger.info("pipeline", "Starting OpenCode server", { port, bin });
	const child = Bun.spawn([bin, "serve", "--port", String(port)], {
		stdout: "ignore",
		stderr: "pipe",
	});

	// Wait up to 8s for the server to become healthy
	const deadline = Date.now() + 8000;
	let healthy = false;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 500));
		try {
			const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
			if (res.ok) {
				healthy = true;
				break;
			}
		} catch {
			// keep waiting
		}
	}

	if (!healthy) {
		child.kill();
		const stderr = await new Response(child.stderr).text();
		logger.warn("pipeline", "OpenCode server failed to start", {
			stderr: stderr.slice(0, 300),
		});
		return false;
	}

	openCodeChild = { process: child, port };
	logger.info("pipeline", "OpenCode server started", { port, pid: child.pid });
	return true;
}

/** Kill the managed opencode child process. */
export function stopOpenCodeServer(): void {
	if (openCodeChild) {
		logger.info("pipeline", "Stopping OpenCode server", { pid: openCodeChild.process.pid });
		openCodeChild.process.kill();
		openCodeChild = null;
	}
}

// -- OpenCode response types --

interface OpenCodeTextPart {
	readonly type: "text";
	readonly text: string;
}

interface OpenCodeTokens {
	readonly input?: number;
	readonly output?: number;
	readonly reasoning?: number;
	readonly cache?: {
		readonly read?: number;
		readonly write?: number;
	};
}

interface OpenCodeAssistantMessage {
	readonly role?: string;
	readonly cost?: number;
	readonly tokens?: OpenCodeTokens;
}

interface OpenCodeMessageResponse {
	readonly info: OpenCodeAssistantMessage;
	readonly parts: ReadonlyArray<{ readonly type: string } & Record<string, unknown>>;
}

const OPENCODE_EXTRACTION_FALLBACK = '{"facts":[],"entities":[]}';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseOpenCodeTokens(value: unknown): OpenCodeTokens | undefined {
	if (!isRecord(value)) return undefined;

	const cacheValue = value.cache;
	const cache = isRecord(cacheValue)
		? {
				...(typeof cacheValue.read === "number"
					? { read: cacheValue.read }
					: {}),
				...(typeof cacheValue.write === "number"
					? { write: cacheValue.write }
					: {}),
			}
		: undefined;

	return {
		...(typeof value.input === "number" ? { input: value.input } : {}),
		...(typeof value.output === "number" ? { output: value.output } : {}),
		...(typeof value.reasoning === "number"
			? { reasoning: value.reasoning }
			: {}),
		...(cache ? { cache } : {}),
	};
}

function parseOpenCodeMessageResponse(value: unknown): OpenCodeMessageResponse | null {
	if (!isRecord(value)) return null;

	const rawParts = value.parts;
	if (!Array.isArray(rawParts)) return null;

	const parts = rawParts.filter(
		(part): part is { readonly type: string } & Record<string, unknown> =>
			isRecord(part) && typeof part.type === "string",
	);

	const rawInfo = value.info;
	const infoRecord = isRecord(rawInfo) ? rawInfo : {};

	const info: OpenCodeAssistantMessage = {
		...(typeof infoRecord.role === "string" ? { role: infoRecord.role } : {}),
		...(typeof infoRecord.cost === "number" ? { cost: infoRecord.cost } : {}),
		...(parseOpenCodeTokens(infoRecord.tokens)
			? { tokens: parseOpenCodeTokens(infoRecord.tokens) }
			: {}),
	};

	return { info, parts };
}

function parseOpenCodeMessageList(value: unknown): readonly OpenCodeMessageResponse[] {
	if (!Array.isArray(value)) return [];
	const messages: OpenCodeMessageResponse[] = [];
	for (const item of value) {
		const parsed = parseOpenCodeMessageResponse(item);
		if (parsed) messages.push(parsed);
	}
	return messages;
}

function selectLatestAssistantMessage(
	messages: readonly OpenCodeMessageResponse[],
): OpenCodeMessageResponse | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		const info = isRecord(message.info) ? message.info : null;
		if (!info || info.role !== "assistant") continue;
		if (!hasUsableOpenCodeText(message)) continue;
		return message;
	}
	return null;
}

function buildOpenCodeFallbackResponse(): OpenCodeMessageResponse {
	return {
		info: {
			cost: 0,
			tokens: {
				input: 0,
				output: 0,
				cache: { read: 0, write: 0 },
			},
		},
		parts: [{ type: "text", text: OPENCODE_EXTRACTION_FALLBACK }],
	};
}

function hasUsableOpenCodeText(data: OpenCodeMessageResponse): boolean {
	for (const part of data.parts) {
		if (part.type !== "text") continue;
		if (typeof part.text !== "string") continue;
		if (part.text.trim().length > 0) return true;
	}
	return false;
}

/**
 * Extract assistant text from an OpenCode message response.
 * Response shape: `{ info: AssistantMessage, parts: Part[] }`
 * Text lives in parts where `type === "text"`.
 */
function extractOpenCodeText(data: OpenCodeMessageResponse): string {
	const textParts: string[] = [];
	for (const part of data.parts) {
		if (part.type === "text" && typeof part.text === "string") {
			textParts.push(part.text);
		}
	}
	return textParts.join("\n").trim();
}

export function createOpenCodeProvider(
	config?: Partial<OpenCodeProviderConfig>,
): LlmProvider {
	const merged = { ...DEFAULT_OPENCODE_CONFIG, ...config };
	const rawFallbackModel = merged.ollamaFallbackModel;
	const ollamaFallbackModel =
		typeof rawFallbackModel === "string" &&
			rawFallbackModel.trim().length > 0
			? rawFallbackModel.trim()
			: resolveDefaultOllamaFallbackModel();
	const ollamaFallbackMaxContextTokens =
		normalizePositiveInt(merged.ollamaFallbackMaxContextTokens) ??
		resolveDefaultOllamaFallbackMaxContextTokens(); // Eagerly resolved even when fallback is disabled; tryOllamaFallback gates on enableOllamaFallback.
	const cfg = {
		...merged,
		baseUrl: trimTrailingSlash(merged.baseUrl),
		ollamaFallbackBaseUrl: trimTrailingSlash(merged.ollamaFallbackBaseUrl),
		ollamaFallbackModel,
		ollamaFallbackMaxContextTokens,
	};

	// Parse "provider/model" format (e.g. "anthropic/claude-haiku-4-5-20251001")
	const slashIdx = cfg.model.indexOf("/");
	const providerID = slashIdx > 0 ? cfg.model.slice(0, slashIdx) : "anthropic";
	const modelID = slashIdx > 0 ? cfg.model.slice(slashIdx + 1) : cfg.model;

	let sessionId: string | null = null;
	let ollamaFallbackProvider: LlmProvider | null = null;

	function getOllamaFallbackProvider(): LlmProvider {
		if (ollamaFallbackProvider) return ollamaFallbackProvider;
		ollamaFallbackProvider = createOllamaProvider({
			model: cfg.ollamaFallbackModel,
			baseUrl: cfg.ollamaFallbackBaseUrl,
			defaultTimeoutMs: cfg.defaultTimeoutMs,
			maxContextTokens: cfg.ollamaFallbackMaxContextTokens,
		});
		return ollamaFallbackProvider;
	}

	async function tryOllamaFallback(
		prompt: string,
		opts: { timeoutMs?: number; maxTokens?: number } | undefined,
		reason: string,
	): Promise<OpenCodeMessageResponse | null> {
		if (!cfg.enableOllamaFallback) return null;

		const provider = getOllamaFallbackProvider();
		if (!(await provider.available())) {
			logger.warn("pipeline", "OpenCode fallback to Ollama skipped (unavailable)", {
				reason,
				model: cfg.ollamaFallbackModel,
			});
			return null;
		}

		try {
			const fallbackOpts = {
				timeoutMs: Math.min(opts?.timeoutMs ?? cfg.defaultTimeoutMs, 20000),
				maxTokens: opts?.maxTokens ?? 512,
			};
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), fallbackOpts.timeoutMs);
			let resultText = "";
			let inputTokens: number | null = null;
			let outputTokens: number | null = null;
			try {
				const options: Record<string, number> = {
					num_predict: fallbackOpts.maxTokens,
				};
				if (cfg.ollamaFallbackMaxContextTokens !== undefined) {
					options.num_ctx = cfg.ollamaFallbackMaxContextTokens;
				}
				const res = await fetch(`${cfg.ollamaFallbackBaseUrl}/api/generate`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: cfg.ollamaFallbackModel,
						prompt,
						stream: false,
						format: "json",
						think: false,
						options,
					}),
					signal: controller.signal,
				});

				if (!res.ok) {
					const body = await res.text().catch(() => "");
					throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 200)}`);
				}

				const data = (await res.json()) as OllamaGenerateResponse;
				resultText = typeof data.response === "string" ? data.response.trim() : "";
				inputTokens =
					typeof data.prompt_eval_count === "number"
						? data.prompt_eval_count
						: null;
				outputTokens =
					typeof data.eval_count === "number" ? data.eval_count : null;
			} finally {
				clearTimeout(timer);
			}

			logger.warn("pipeline", "OpenCode fallback to Ollama used", {
				reason,
				model: cfg.ollamaFallbackModel,
			});

			return {
				info: {
					tokens: {
						...(inputTokens !== null
							? { input: inputTokens }
							: {}),
						...(outputTokens !== null
							? { output: outputTokens }
							: {}),
					},
				},
				parts: [{ type: "text", text: resultText }],
			};
		} catch (e) {
			logger.warn("pipeline", "OpenCode fallback to Ollama failed", {
				reason,
				model: cfg.ollamaFallbackModel,
				error: e instanceof Error ? e.message : String(e),
			});
			return null;
		}
	}

	async function getOrCreateSession(): Promise<string> {
		if (sessionId) return sessionId;

		const res = await fetch(`${cfg.baseUrl}/session`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "signet-extraction" }),
			signal: AbortSignal.timeout(10000),
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(
				`OpenCode create session failed (${res.status}): ${body.slice(0, 200)}`,
			);
		}

		const data = (await res.json()) as Record<string, unknown>;
		const id = data.id;
		if (typeof id !== "string") {
			throw new Error("OpenCode session response missing 'id' field");
		}
		sessionId = id;
		logger.debug("pipeline", "OpenCode session created", { id });
		return id;
	}

	function buildMessageBody(prompt: string): string {
		return JSON.stringify({
			parts: [{ type: "text", text: prompt }],
			model: { providerID, modelID },
		});
	}

	async function sendMessage(
		prompt: string,
		opts?: { timeoutMs?: number; maxTokens?: number },
	): Promise<OpenCodeMessageResponse> {
		const timeoutMs = opts?.timeoutMs ?? cfg.defaultTimeoutMs;
		const sid = await getOrCreateSession();

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const postMessage = async (sid: string): Promise<Response> =>
				fetch(
					`${cfg.baseUrl}/session/${sid}/message`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: buildMessageBody(prompt),
						signal: controller.signal,
					},
				);

			const listMessages = async (sid: string): Promise<Response> =>
				fetch(
					`${cfg.baseUrl}/session/${sid}/message`,
					{
						method: "GET",
						signal: controller.signal,
					},
				);

			const parseResponsePayload = async (res: Response): Promise<unknown> => {
				const text = await res.text().catch(() => "");
				if (text.trim().length === 0) return null;
				try {
					return JSON.parse(text);
				} catch {
					return null;
				}
			};

			const parseMessagePayload = (
				payload: unknown,
				forSessionId: string,
				source: "post" | "poll",
			): OpenCodeMessageResponse | null => {
				const single = parseOpenCodeMessageResponse(payload);
				if (single && hasUsableOpenCodeText(single)) {
					return single;
				}

				const list = parseOpenCodeMessageList(payload);
				if (list.length > 0) {
					const selected = selectLatestAssistantMessage(list);
					if (selected) return selected;
					if (source === "post") {
						logger.warn("pipeline", "OpenCode payload had no assistant text yet", {
							sessionId: forSessionId,
						});
					}
					return null;
				}

				if (single && source === "post") {
					logger.warn("pipeline", "OpenCode response contained no usable text parts", {
						sessionId: forSessionId,
					});
				} else if (source === "post") {
					logger.warn("pipeline", "OpenCode response missing expected fields", {
						sessionId: forSessionId,
					});
				}

				return null;
			};

			const pollForAssistantMessage = async (
				forSessionId: string,
			): Promise<OpenCodeMessageResponse | null> => {
				const deadline = Date.now() + Math.max(1000, Math.min(timeoutMs, 20000));
				while (Date.now() < deadline) {
					const res = await listMessages(forSessionId);
					if (res.ok) {
						const payload = await parseResponsePayload(res);
						const parsed = parseMessagePayload(payload, forSessionId, "poll");
						if (parsed) return parsed;
					}
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
				return null;
			};

			const parsePostResponse = async (
				res: Response,
				forSessionId: string,
			): Promise<OpenCodeMessageResponse | null> => {
				const payload = await parseResponsePayload(res);
				const parsed = parseMessagePayload(payload, forSessionId, "post");
				if (parsed) return parsed;
				return pollForAssistantMessage(forSessionId);
			};

			const res = await postMessage(sid);

			if (!res.ok) {
				const body = await res.text().catch(() => "");
				// Session expired/invalid — reset and retry once
				if (res.status === 404 || res.status === 410) {
					sessionId = null;
					const retrySid = await getOrCreateSession();
					const retryRes = await postMessage(retrySid);
					if (!retryRes.ok) {
						const retryBody = await retryRes.text().catch(() => "");
						throw new Error(
							`OpenCode HTTP ${retryRes.status}: ${retryBody.slice(0, 200)}`,
						);
					}
					const retryParsed = await parsePostResponse(retryRes, retrySid);
					if (retryParsed) return retryParsed;
					logger.warn("pipeline", "OpenCode response remained malformed after retry; using fallback", {
						sessionId: retrySid,
					});
					const ollamaFallback = await tryOllamaFallback(
						prompt,
						opts,
						"post-response-malformed-after-http-retry",
					);
					if (ollamaFallback) return ollamaFallback;
					return buildOpenCodeFallbackResponse();
				}
				throw new Error(
					`OpenCode HTTP ${res.status}: ${body.slice(0, 200)}`,
				);
			}

			const parsed = await parsePostResponse(res, sid);
			if (parsed) return parsed;

			// Malformed successful payload — reset session and retry once
			sessionId = null;
			const retrySid = await getOrCreateSession();
			const retryRes = await postMessage(retrySid);
			if (!retryRes.ok) {
				const retryBody = await retryRes.text().catch(() => "");
				throw new Error(
					`OpenCode HTTP ${retryRes.status}: ${retryBody.slice(0, 200)}`,
				);
			}
			const retryParsed = await parsePostResponse(retryRes, retrySid);
			if (retryParsed) return retryParsed;

			logger.warn("pipeline", "OpenCode response remained malformed after retry; using fallback", {
				sessionId: retrySid,
			});
			const ollamaFallback = await tryOllamaFallback(
				prompt,
				opts,
				"post-response-malformed-after-session-reset",
			);
			if (ollamaFallback) return ollamaFallback;
			return buildOpenCodeFallbackResponse();
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") {
				throw new Error(`OpenCode timeout after ${timeoutMs}ms`);
			}
			throw e;
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		name: `opencode:${cfg.model}`,

		async generate(prompt, opts): Promise<string> {
			const data = await sendMessage(prompt, opts);
			return extractOpenCodeText(data);
		},

		async generateWithUsage(prompt, opts): Promise<LlmGenerateResult> {
			const data = await sendMessage(prompt, opts);
			const text = extractOpenCodeText(data);
			const t = data.info.tokens;
			const cache = t?.cache;

			return {
				text,
				usage: t
					? {
							inputTokens: t.input ?? null,
							outputTokens: t.output ?? null,
							cacheReadTokens: cache?.read ?? null,
							cacheCreationTokens: cache?.write ?? null,
							totalCost: data.info.cost ?? null,
							totalDurationMs: null,
						}
					: null,
			};
		},

		async available(): Promise<boolean> {
			try {
				const res = await fetch(`${cfg.baseUrl}/global/health`, {
					signal: AbortSignal.timeout(3000),
				});
				return res.ok;
			} catch {
				logger.debug("pipeline", "OpenCode server not available");
				return false;
			}
		},
	};
}
