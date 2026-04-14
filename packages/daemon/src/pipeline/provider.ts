/**
 * LLM provider implementations: Ollama (HTTP), Claude Code (CLI subprocess),
 * Anthropic (direct HTTP API), and OpenCode (headless HTTP server).
 *
 * The LlmProvider interface itself lives in @signet/core so that the
 * ingestion pipeline and other consumers can accept any provider.
 */
// On Windows, use node:child_process spawn with windowsHide to prevent
// console window flashing. Bun.spawn doesn't support windowsHide.
import { spawn as nodeSpawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
	DEFAULT_PROVIDER_RATE_LIMIT,
	type LlmGenerateResult,
	type LlmProvider,
	OPENCODE_PIPELINE_AGENT,
	OPENCODE_PIPELINE_SYSTEM_PROMPT,
	type PipelineExtractionConfig,
	type ProviderRateLimitConfig,
} from "@signet/core";
import { logger } from "../logger";
import { bypassSession } from "../session-tracker";
import { trimTrailingSlash } from "./url";

// ---------------------------------------------------------------------------
// Global concurrency semaphore for all LLM providers
// ---------------------------------------------------------------------------
// Prevents starvation when multiple pipeline workers (extraction,
// structural-classify, summary, etc.) all issue LLM calls simultaneously
// — whether via CLI subprocesses or HTTP providers like OpenCode.
// Without this, 10+ concurrent calls can cause memory bloat, API rate
// limiting, and timeout cascades.

const DEFAULT_MAX_LLM_CONCURRENCY = 4;

export class SemaphoreTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(ms: number, reason?: string) {
		super(reason ?? `semaphore acquisition timed out after ${ms}ms`);
		this.name = "SemaphoreTimeoutError";
		this.timeoutMs = ms;
	}
}

export class LlmConcurrencySemaphore {
	private readonly max: number;
	private active = 0;
	private readonly queue: Array<() => void> = [];
	private timers = 0;

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

	async acquireWithTimeout(ms: number): Promise<void> {
		if (ms <= 0) {
			throw new SemaphoreTimeoutError(ms, "timeout must be positive");
		}
		if (this.active < this.max) {
			this.active++;
			return;
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			this.timers++;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				this.timers--;
				const idx = this.queue.indexOf(entry);
				if (idx !== -1) this.queue.splice(idx, 1);
				reject(new SemaphoreTimeoutError(ms));
			}, ms);
			const entry = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.timers--;
				this.active++;
				resolve();
			};
			this.queue.push(entry);
		});
	}

	release(): void {
		if (this.active <= 0) {
			throw new Error("LlmConcurrencySemaphore.release(): no active acquisitions to release");
		}
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

	get activeTimers(): number {
		return this.timers;
	}
}

const llmSemaphore = new LlmConcurrencySemaphore(
	process.env.SIGNET_MAX_LLM_CONCURRENCY !== undefined
		? (() => {
			const parsed = Number(process.env.SIGNET_MAX_LLM_CONCURRENCY);
			if (!Number.isSafeInteger(parsed) || parsed < 1) {
				logger.warn("pipeline", "SIGNET_MAX_LLM_CONCURRENCY is not a valid positive integer, using default", {
					value: process.env.SIGNET_MAX_LLM_CONCURRENCY,
				});
				return DEFAULT_MAX_LLM_CONCURRENCY;
			}
			return parsed;
			})()
		: DEFAULT_MAX_LLM_CONCURRENCY,
);

// ---------------------------------------------------------------------------
// Token-bucket rate limiter for provider-level call throttling
// ---------------------------------------------------------------------------
// Prevents runaway subprocess spawning when a pipeline stall loop or
// aggressive scheduling causes excessive LLM calls. Independent of the
// concurrency semaphore (which limits parallelism, not throughput).

export class RateLimitExceededError extends Error {
	constructor(
		public readonly providerName: string,
		public readonly maxCallsPerHour: number,
	) {
		super(`Rate limit exceeded: ${maxCallsPerHour}/hr for ${providerName}`);
		this.name = "RateLimitExceededError";
	}
}

export class TokenBucketRateLimiter {
	private tokens: number;
	private lastRefillMs: number;
	private totalConsumed = 0;
	private totalThrottled = 0;

	constructor(
		private readonly maxCallsPerHour: number,
		private readonly burstSize: number,
	) {
		this.tokens = burstSize;
		this.lastRefillMs = Date.now();
	}

	private refill(): void {
		const now = Date.now();
		const elapsedMs = now - this.lastRefillMs;
		if (elapsedMs <= 0) return;
		const refillAmount = (this.maxCallsPerHour / 3_600_000) * elapsedMs;
		this.tokens = Math.min(this.burstSize, this.tokens + refillAmount);
		this.lastRefillMs = now;
	}

	async acquire(waitMs: number): Promise<boolean> {
		this.refill();
		if (this.tokens >= 1) {
			this.tokens -= 1;
			this.totalConsumed++;
			return true;
		}
		if (waitMs <= 0) {
			this.totalThrottled++;
			return false;
		}
		const deadline = Date.now() + waitMs;
		const pollIntervalMs = Math.max(1, Math.floor(Math.min(100, waitMs / 4)));
		while (Date.now() < deadline) {
			await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
			this.refill();
			if (this.tokens >= 1) {
				this.tokens -= 1;
				this.totalConsumed++;
				return true;
			}
		}
		this.totalThrottled++;
		return false;
	}

	currentStats(): { readonly remaining: number; readonly totalConsumed: number; readonly totalThrottled: number } {
		this.refill();
		return {
			remaining: Math.floor(this.tokens),
			totalConsumed: this.totalConsumed,
			totalThrottled: this.totalThrottled,
		};
	}
}

type RemoteProvider = Exclude<PipelineExtractionConfig["provider"], "none" | "llama-cpp" | "ollama" | "command">;

const RATE_LIMIT_PROVIDERS: ReadonlySet<string> = new Set([
	"claude-code",
	"anthropic",
	"openrouter",
	"codex",
	"opencode",
]);

// Compile-time check: if a new remote provider is added to the union but
// omitted from the set above, this produces a type error.
const _exhaustiveCheck: Record<RemoteProvider, true> = {
	"claude-code": true,
	anthropic: true,
	openrouter: true,
	codex: true,
	opencode: true,
};
void _exhaustiveCheck;

function shouldRateLimit(providerName: string): boolean {
	const base = providerName.split(":")[0];
	return RATE_LIMIT_PROVIDERS.has(base);
}

export function withRateLimit(provider: LlmProvider, config?: ProviderRateLimitConfig): LlmProvider {
	if (config === undefined) return provider;
	if (Object.keys(config).length === 0) return provider;
	const maxCallsPerHour = config.maxCallsPerHour ?? DEFAULT_PROVIDER_RATE_LIMIT.maxCallsPerHour;
	const burstSize = config.burstSize ?? DEFAULT_PROVIDER_RATE_LIMIT.burstSize;
	const waitTimeoutMs = config.waitTimeoutMs ?? DEFAULT_PROVIDER_RATE_LIMIT.waitTimeoutMs;
	if (maxCallsPerHour <= 0 || burstSize <= 0) return provider;

	if (!shouldRateLimit(provider.name)) {
		logger.warn(
			"pipeline",
			`rateLimit config ignored for provider "${provider.name}" — only remote/paid providers are throttled`,
			{
				provider: provider.name,
				allowedProviders: [...RATE_LIMIT_PROVIDERS],
			},
		);
		return provider;
	}

	const bucket = new TokenBucketRateLimiter(maxCallsPerHour, burstSize);
	let lastWarnMs = 0;
	const WARN_INTERVAL_MS = 300_000;

	function warnIfThrottled(): void {
		const now = Date.now();
		if (now - lastWarnMs > WARN_INTERVAL_MS) {
			lastWarnMs = now;
			const stats = bucket.currentStats();
			logger.warn("pipeline", `Rate limit throttled ${provider.name} (${stats.totalThrottled} total)`, stats);
		}
	}

	const genWithUsage = provider.generateWithUsage;
	return {
		name: provider.name,

		async generate(prompt, opts): Promise<string> {
			if (!(await bucket.acquire(waitTimeoutMs))) {
				warnIfThrottled();
				throw new RateLimitExceededError(provider.name, maxCallsPerHour);
			}
			const fn = provider.generate;
			return fn.call(provider, prompt, opts);
		},

		...(genWithUsage
			? {
					async generateWithUsage(prompt, opts): Promise<LlmGenerateResult> {
						if (!(await bucket.acquire(waitTimeoutMs))) {
							warnIfThrottled();
							throw new RateLimitExceededError(provider.name, maxCallsPerHour);
						}
						return genWithUsage.call(provider, prompt, opts);
					},
				}
			: {}),

		async available(): Promise<boolean> {
			return provider.available();
		},
	};
}

/**
 * Run an async function guarded by the global LLM concurrency semaphore.
 * Ensures no more than N concurrent LLM calls across all providers and workers.
 */
async function withLlmConcurrency<T>(
	fn: () => Promise<T>,
	timeoutMs?: number,
	label?: string,
): Promise<T> {
	try {
		if (timeoutMs !== undefined) {
			await llmSemaphore.acquireWithTimeout(timeoutMs);
		} else {
			await llmSemaphore.acquire();
		}
	} catch (err) {
		if (err instanceof SemaphoreTimeoutError && label) {
			throw new SemaphoreTimeoutError(
				err.timeoutMs,
				`${label} timeout after ${err.timeoutMs}ms (semaphore acquisition)`,
			);
		}
		throw err;
	}
	try {
		return await fn();
	} finally {
		llmSemaphore.release();
	}
}

// ---------------------------------------------------------------------------
// Shared HTTP provider helpers
// ---------------------------------------------------------------------------
// Generic retry loop, error-body parsing, and usage mapping shared by
// Anthropic and OpenRouter (and partially by Claude Code).

interface ApiErrorBody {
	readonly error?: {
		readonly type?: string;
		readonly message?: string;
		readonly code?: number | string;
	};
}

function parseApiErrorDetail(rawBody: string, includeType = false): string {
	const fallback = rawBody.slice(0, 300);
	try {
		const parsed = JSON.parse(rawBody) as ApiErrorBody;
		if (parsed.error?.message) {
			return includeType
				? `${parsed.error.type ?? "error"}: ${parsed.error.message}`
				: parsed.error.message;
		}
	} catch {
		// Use raw body
	}
	return fallback;
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

/** Minimal content-part shape shared by llama.cpp and OpenRouter responses. */
interface ContentTextPart {
	readonly type?: string;
	readonly text?: string;
}

/** Extract text from a chat-completion content field (string or parts array).
 *  Shared by llama.cpp and OpenRouter providers. */
function extractContentText(content: string | readonly ContentTextPart[] | undefined): string {
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

interface HttpRetryConfig {
	readonly label: string;
	readonly timeoutMs: number;
	readonly maxRetries: number;
}

interface HttpAttemptContext {
	readonly attempt: number;
	readonly maxRetries: number;
	readonly controller: AbortController;
	setLastError(e: Error): void;
}

type HttpAttemptResult<T> =
	| { readonly retry: true }
	| { readonly retry: false; readonly value: T };

async function httpProviderCall<T>(
	config: HttpRetryConfig,
	attemptFn: (ctx: HttpAttemptContext) => Promise<HttpAttemptResult<T>>,
): Promise<T> {
	// Mutable ref prevents TypeScript from narrowing away closure mutations
	const state: { lastError: Error | null } = { lastError: null };
	const { label, timeoutMs, maxRetries } = config;
	const deadline = performance.now() + timeoutMs;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (attempt > 0) {
			const remainingBudget = deadline - performance.now();
			if (remainingBudget <= 0) {
				const reason = state.lastError
					? `last error: ${state.lastError.message}`
					: "no successful attempt";
				throw new Error(
					`${label} timeout after ${timeoutMs}ms (deadline exceeded before retry backoff; ${reason})`,
				);
			}
			const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000, remainingBudget);
			await new Promise((r) => setTimeout(r, backoffMs));
			logger.debug("pipeline", `${label} API retry`, {
				attempt,
				maxRetries,
				backoffMs,
			});
		}

		if (deadline - performance.now() <= 0) {
			const reason = state.lastError
				? `last error: ${state.lastError.message}`
				: "no successful attempt";
			throw new Error(
				`${label} timeout after ${timeoutMs}ms (deadline exceeded before attempt ${attempt}; ${reason})`,
			);
		}

		const result = await withLlmConcurrency(
			async () => {
				const remainingMs = deadline - performance.now();
				if (remainingMs <= 0) {
					const reason = state.lastError
						? `last error: ${state.lastError.message}`
						: "no successful attempt";
					throw new Error(
						`${label} timeout after ${timeoutMs}ms (deadline exceeded waiting for semaphore; ${reason})`,
					);
				}
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), remainingMs);
				try {
					return await attemptFn({
						attempt,
						maxRetries,
						controller,
						setLastError(e: Error) {
							state.lastError = e;
						},
					});
				} catch (e) {
					if (e instanceof DOMException && e.name === "AbortError") {
						throw new NonRetryableError(`${label} timeout after ${timeoutMs}ms`);
					}
					if (e instanceof NonRetryableError) throw e;
					state.lastError = e instanceof Error ? e : new Error(String(e));
					if (attempt < maxRetries) {
						logger.warn("pipeline", `${label} API network error`, {
							attempt,
							error: state.lastError.message.slice(0, 100),
						});
						return { retry: true } as const;
					}
					throw state.lastError;
				} finally {
					clearTimeout(timer);
				}
			},
			Math.max(1, deadline - performance.now()),
			label.toLowerCase(),
		);

		if ("value" in result) return result.value;
	}

	throw state.lastError ?? new Error(`${label} call failed after retries`);
}

// ---------------------------------------------------------------------------
// Shared Anthropic-style usage mapping (Claude Code CLI + Anthropic HTTP)
// ---------------------------------------------------------------------------

interface AnthropicStyleUsage {
	readonly input_tokens?: number;
	readonly output_tokens?: number;
	readonly cache_creation_input_tokens?: number;
	readonly cache_read_input_tokens?: number;
}

function mapAnthropicUsage(
	usage: AnthropicStyleUsage | null | undefined,
	extra?: {
		readonly totalCost?: number | null;
		readonly totalDurationMs?: number | null;
	},
): LlmGenerateResult["usage"] {
	if (!usage) return null;
	return {
		inputTokens: usage.input_tokens ?? null,
		outputTokens: usage.output_tokens ?? null,
		cacheReadTokens: usage.cache_read_input_tokens ?? null,
		cacheCreationTokens: usage.cache_creation_input_tokens ?? null,
		totalCost: extra?.totalCost ?? null,
		totalDurationMs: extra?.totalDurationMs ?? null,
	};
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

// Module-level helper to avoid allocating a new closure per spawnHidden call.
const toWebStream = (nodeStream: import("node:stream").Readable): ReadableStream<Uint8Array> =>
	Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

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
		// .cmd wrappers (e.g. claude.cmd, codex.cmd from npm) are batch scripts,
		// not PE executables. Instead of shell: true (which exposes args to
		// cmd.exe metacharacter interpretation — injection risk), invoke cmd.exe
		// explicitly with properly quoted arguments.
		let child: import("node:child_process").ChildProcess;
		if (resolvedBin.endsWith(".cmd")) {
			const quote = (s: string) => `"${s.replace(/%/g, "%%").replace(/"/g, '""')}"`;
			const cmdLine = [quote(resolvedBin), ...args.map(quote)].join(" ");
			child = nodeSpawn(process.env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", `"${cmdLine}"`], {
				stdio: ["ignore", "pipe", "pipe"],
				env: options?.env ? sanitizedEnv : undefined,
				windowsHide: true,
			});
		} else {
			child = nodeSpawn(resolvedBin, args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: options?.env ? sanitizedEnv : undefined,
				windowsHide: true,
			});
		}

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

// ---------------------------------------------------------------------------
// Subprocess deadline helper
// ---------------------------------------------------------------------------
// Runs a result-extracting callback against a spawned subprocess, racing
// against a deadline. On timeout: SIGTERM → grace period → SIGKILL.
//
// INVARIANT: the returned promise settles only AFTER `proc.exited` resolves,
// so callers wrapped in `withLlmConcurrency` won't release the semaphore
// until the child process is actually dead.

const SUBPROCESS_KILL_GRACE_MS = 2000;

export async function awaitSubprocessWithDeadline<T>(
	proc: SpawnResult,
	remainingMs: number,
	label: string,
	originalTimeoutMs: number,
	resultFn: (p: SpawnResult) => Promise<T>,
): Promise<T> {
	if (remainingMs <= 0) {
		proc.kill("SIGTERM");
		await proc.exited.catch(() => {});
		throw new SemaphoreTimeoutError(
			originalTimeoutMs,
			`${label} timeout after ${originalTimeoutMs}ms (deadline exceeded before subprocess work)`,
		);
	}

	let timedOut = false;
	const deadlineTimer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGTERM");
	}, remainingMs);
	let graceTimer: ReturnType<typeof setTimeout> | undefined;

	try {
		const result = await resultFn(proc);
		clearTimeout(deadlineTimer);
		if (timedOut) {
			graceTimer = setTimeout(() => proc.kill("SIGKILL"), SUBPROCESS_KILL_GRACE_MS);
			await proc.exited.catch(() => {});
			clearTimeout(graceTimer);
			throw new SemaphoreTimeoutError(
				originalTimeoutMs,
				`${label} timeout after ${originalTimeoutMs}ms (result arrived after deadline)`,
			);
		}
		return result;
	} catch (err) {
		clearTimeout(deadlineTimer);
		if (!timedOut) throw err;
		// Timeout fired — SIGTERM sent. Wait for exit with SIGKILL backstop.
		graceTimer = setTimeout(() => proc.kill("SIGKILL"), SUBPROCESS_KILL_GRACE_MS);
		await proc.exited.catch(() => {});
		clearTimeout(graceTimer);
		throw new SemaphoreTimeoutError(
			originalTimeoutMs,
			`${label} timeout after ${originalTimeoutMs}ms`,
		);
	}
}

function createSterileCodexEnv(baseEnv: Record<string, string | undefined>): {
	readonly env: Record<string, string | undefined>;
	cleanup(): void;
} {
	const root = join(tmpdir(), "signet-codex-home");
	mkdirSync(root, { recursive: true });
	const home = mkdtempSync(join(root, "home-"));
	const codexHome = join(home, ".codex");
	mkdirSync(codexHome, { recursive: true });
	const liveHome = baseEnv.HOME ?? homedir();
	const liveCodexHome = baseEnv.CODEX_HOME ?? join(liveHome, ".codex");

	const auth = join(liveCodexHome, "auth.json");
	if (existsSync(auth)) {
		const authDst = join(codexHome, "auth.json");
		cpSync(auth, authDst);
		chmodSync(authDst, 0o400);
	}

	const version = join(liveCodexHome, "version.json");
	if (existsSync(version)) {
		cpSync(version, join(codexHome, "version.json"));
	}

	let cleaned = false;

	return {
		env: {
			...baseEnv,
			HOME: home,
			CODEX_HOME: codexHome,
			XDG_CONFIG_HOME: join(home, ".config"),
		},
		cleanup() {
			if (cleaned) return;
			cleaned = true;
			rmSync(home, { recursive: true, force: true });
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
	return process.env.SIGNET_OLLAMA_FALLBACK_MODEL?.trim() || DEFAULT_OLLAMA_FALLBACK_MODEL;
}

// Reads SIGNET_OLLAMA_FALLBACK_MAX_CTX (kept for backwards compatibility).
// Despite the FALLBACK label, this value applies to all Ollama summary paths —
// both the degraded-fallback case and an explicitly-configured
// synthesis.provider=ollama deployment.
export function resolveDefaultOllamaFallbackMaxContextTokens(): number {
	return (
		parseOptionalPositiveInt(process.env.SIGNET_OLLAMA_FALLBACK_MAX_CTX) ?? DEFAULT_OLLAMA_FALLBACK_MAX_CONTEXT_TOKENS
	);
}

interface OllamaGenerateResponse {
	readonly response?: string;
	readonly thinking?: string;
	readonly eval_count?: number;
	readonly prompt_eval_count?: number;
	readonly total_duration?: number;
	readonly eval_duration?: number;
}

interface OllamaRawOpts {
	readonly baseUrl: string;
	readonly model: string;
	readonly prompt: string;
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
	readonly options?: Record<string, number>;
	readonly extraBody?: Record<string, unknown>;
}

async function callOllamaRaw(raw: OllamaRawOpts): Promise<OllamaGenerateResponse> {
	const res = await fetch(`${raw.baseUrl}/api/generate`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: raw.model,
			prompt: raw.prompt,
			stream: false,
			...raw.extraBody,
			...(raw.options && Object.keys(raw.options).length > 0 ? { options: raw.options } : {}),
		}),
		signal: raw.signal,
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 200)}`);
	}

	const data = (await res.json()) as OllamaGenerateResponse;
	if (typeof data.response !== "string") {
		throw new Error("Ollama returned no response field");
	}
	return data;
}

export function createOllamaProvider(config?: Partial<OllamaProviderConfig>): LlmProvider {
	const rawModel = config?.model;
	const model =
		typeof rawModel === "string" && rawModel.trim().length > 0 ? rawModel.trim() : resolveDefaultOllamaFallbackModel();
	const cfg = {
		baseUrl: trimTrailingSlash(config?.baseUrl ?? DEFAULT_OLLAMA_CONFIG.baseUrl),
		defaultTimeoutMs: config?.defaultTimeoutMs ?? DEFAULT_OLLAMA_CONFIG.defaultTimeoutMs,
		maxContextTokens: normalizePositiveInt(config?.maxContextTokens),
		model,
	};

	async function callOllama(
		prompt: string,
		opts?: { timeoutMs?: number; maxTokens?: number },
	): Promise<OllamaGenerateResponse> {
		const timeoutMs = opts?.timeoutMs ?? cfg.defaultTimeoutMs;

		return withLlmConcurrency(async () => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);

			try {
				const options: Record<string, number> = {};
				if (opts?.maxTokens) options.num_predict = opts.maxTokens;
				if (cfg.maxContextTokens !== undefined) {
					options.num_ctx = cfg.maxContextTokens;
				}
				return await callOllamaRaw({
					baseUrl: cfg.baseUrl,
					model: cfg.model,
					prompt,
					timeoutMs,
					signal: controller.signal,
					options,
				});
			} catch (e) {
				if (e instanceof DOMException && e.name === "AbortError") {
					throw new Error(`Ollama timeout after ${timeoutMs}ms`);
				}
				throw e;
			} finally {
				clearTimeout(timer);
			}
		}, timeoutMs, "ollama");
	}

	return {
		name: `ollama:${cfg.model}`,

		async generate(prompt, opts): Promise<string> {
			const data = await callOllama(prompt, opts);
			// Thinking models (qwen3, deepseek) may put content in `thinking`
			// field and leave `response` empty when using /api/generate
			const text = (data.response ?? "").trim();
			if (text.length > 0) return text;
			return (data.thinking ?? "").trim();
		},

		async generateWithUsage(prompt, opts): Promise<LlmGenerateResult> {
			const data = await callOllama(prompt, opts);
			const nsToMs = (ns: number | undefined): number | null =>
				typeof ns === "number" ? Math.round(ns / 1_000_000) : null;
			const text = (data.response ?? "").trim();

			return {
				text: text.length > 0 ? text : (data.thinking ?? "").trim(),
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
// llama.cpp via OpenAI-compatible HTTP API
// ---------------------------------------------------------------------------

export interface LlamaCppProviderConfig {
	readonly model?: string;
	readonly baseUrl: string;
	readonly defaultTimeoutMs: number;
	readonly maxContextTokens?: number;
}

const DEFAULT_LLAMACPP_CONFIG = {
	baseUrl: "http://127.0.0.1:8080",
	defaultTimeoutMs: 90000,
};

interface LlamaCppMessage {
	readonly content?: string | readonly ContentTextPart[];
}

interface LlamaCppChoice {
	readonly message?: LlamaCppMessage;
}

interface LlamaCppUsage {
	readonly prompt_tokens?: number;
	readonly completion_tokens?: number;
}

interface LlamaCppResponse {
	readonly choices?: readonly LlamaCppChoice[];
	readonly usage?: LlamaCppUsage;
}

export function createLlamaCppProvider(config?: Partial<LlamaCppProviderConfig>): LlmProvider {
	const cfg = {
		baseUrl: trimTrailingSlash(config?.baseUrl ?? DEFAULT_LLAMACPP_CONFIG.baseUrl),
		defaultTimeoutMs: config?.defaultTimeoutMs ?? DEFAULT_LLAMACPP_CONFIG.defaultTimeoutMs,
		maxContextTokens: normalizePositiveInt(config?.maxContextTokens),
	};
	const model = typeof config?.model === "string" && config.model.trim().length > 0
		? config.model.trim()
		: "qwen3.5:4b";

	async function callLlamaCpp(
		prompt: string,
		opts?: { timeoutMs?: number; maxTokens?: number },
	): Promise<{ text: string; usage: LlamaCppUsage | null }> {
		const timeoutMs = opts?.timeoutMs ?? cfg.defaultTimeoutMs;
		const maxTokens = opts?.maxTokens ?? 4096;
		const url = `${cfg.baseUrl}/v1/chat/completions`;
		const bodyObj: Record<string, unknown> = {
			model,
			messages: [{ role: "user", content: prompt }],
			max_tokens: maxTokens,
			stream: false,
		};
		if (cfg.maxContextTokens !== undefined) {
			bodyObj.num_ctx = cfg.maxContextTokens;
		}
		const body = JSON.stringify(bodyObj);

		return withLlmConcurrency(async () => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);

			try {
				const options: Record<string, number> = {};
				if (cfg.maxContextTokens !== undefined) options.num_ctx = cfg.maxContextTokens;

				const res = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body,
					signal: controller.signal,
				});

				if (!res.ok) {
					const detail = await res.text().catch(() => "");
					throw new Error(`llama.cpp HTTP ${res.status}: ${detail.slice(0, 300)}`);
				}

				const data = (await res.json()) as LlamaCppResponse;
				const first = Array.isArray(data.choices) ? data.choices[0] : undefined;
				const text = extractContentText(first?.message?.content);
				if (text.length === 0) {
					throw new Error("llama.cpp returned empty response");
				}
				return { text, usage: data.usage ?? null };
			} catch (e) {
				if (e instanceof DOMException && e.name === "AbortError") {
					throw new Error(`llama.cpp timeout after ${timeoutMs}ms`);
				}
				throw e;
			} finally {
				clearTimeout(timer);
			}
		}, timeoutMs, "llama-cpp");
	}

	return {
		name: `llama-cpp:${model}`,

		async generate(prompt, opts): Promise<string> {
			const { text } = await callLlamaCpp(prompt, opts);
			return text;
		},

		async generateWithUsage(prompt, opts): Promise<LlmGenerateResult> {
			const { text, usage } = await callLlamaCpp(prompt, opts);
			return {
				text,
				usage: usage
					? {
							inputTokens: usage.prompt_tokens ?? null,
							outputTokens: usage.completion_tokens ?? null,
							cacheReadTokens: null,
							cacheCreationTokens: null,
							totalCost: null,
							totalDurationMs: null,
						}
					: null,
			};
		},

		async available(): Promise<boolean> {
			try {
				const res = await fetch(`${cfg.baseUrl}/v1/models`, {
					signal: AbortSignal.timeout(3000),
				});
				return res.ok;
			} catch {
				logger.debug("pipeline", "llama.cpp not available");
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

export function createClaudeCodeProvider(config?: Partial<ClaudeCodeProviderConfig>): LlmProvider {
	const cfg = { ...DEFAULT_CLAUDE_CODE_CONFIG, ...config };

	async function callClaude(
		prompt: string,
		outputFormat: "text" | "json",
		opts?: { timeoutMs?: number; maxTokens?: number },
	): Promise<string> {
		const timeoutMs = opts?.timeoutMs ?? cfg.defaultTimeoutMs;
		const deadline = performance.now() + timeoutMs;

		return withLlmConcurrency(async () => {
			const remainingMs = deadline - performance.now();
			if (remainingMs <= 0) {
				throw new Error(`claude-code timeout after ${timeoutMs}ms (deadline exceeded waiting for semaphore)`);
			}

			const args = ["-p", prompt, "--model", cfg.model, "--no-session-persistence", "--output-format", outputFormat];

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

			return awaitSubprocessWithDeadline(proc, remainingMs, "claude-code", timeoutMs, async (p) => {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(p.stdout).text().catch(() => ""),
					new Response(p.stderr).text().catch(() => ""),
					p.exited.catch(() => -1),
				]);

				if (exitCode !== 0) {
					throw new Error(`claude-code exit ${exitCode}: ${stderr.slice(0, 300)}`);
				}

				const result = stdout.trim();
				if (result.length === 0) {
					throw new Error("claude-code returned empty output");
				}

				return result;
			});
		}, timeoutMs, "claude-code");
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
			return {
				text,
				usage: mapAnthropicUsage(parsed.usage, {
					totalCost: parsed.cost_usd ?? null,
				}),
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


interface AnthropicResponse {
	readonly id?: string;
	readonly content?: readonly AnthropicContentBlock[];
	readonly usage?: AnthropicUsage;
	readonly stop_reason?: string;
}

export function createAnthropicProvider(config?: Partial<AnthropicProviderConfig>): LlmProvider {
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

		return httpProviderCall<{ text: string; usage: AnthropicUsage | null }>(
			{ label: "Anthropic", timeoutMs, maxRetries: cfg.maxRetries },
			async ({ attempt, maxRetries, controller, setLastError }) => {
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
					const detail = parseApiErrorDetail(rawBody, true);

					if (res.status === 401) {
						throw new NonRetryableError(
							`Anthropic auth failed (401): ${detail}. Check your ANTHROPIC_API_KEY.`,
						);
					}

					if (isRetryableStatus(res.status) && attempt < maxRetries) {
						setLastError(new Error(`Anthropic HTTP ${res.status}: ${detail}`));
						logger.warn("pipeline", "Anthropic API retryable error", {
							status: res.status,
							attempt,
							detail: detail.slice(0, 100),
						});
						return { retry: true } as const;
					}

					throw new NonRetryableError(`Anthropic HTTP ${res.status}: ${detail}`);
				}

				const data = (await res.json()) as AnthropicResponse;

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

				return {
					retry: false,
					value: { text, usage: data.usage ?? null },
				} as const;
			},
		);
	}

	return {
		name: `anthropic:${resolvedModel}`,

		async generate(prompt, opts): Promise<string> {
			const { text } = await callAnthropic(prompt, opts);
			return text;
		},

		async generateWithUsage(prompt, opts): Promise<LlmGenerateResult> {
			const { text, usage } = await callAnthropic(prompt, opts);
			return { text, usage: mapAnthropicUsage(usage) };
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

interface OpenRouterChoice {
	readonly message?: {
		readonly content?: string | readonly ContentTextPart[];
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


interface OpenRouterResponse {
	readonly choices?: readonly OpenRouterChoice[];
	readonly usage?: OpenRouterUsage;
}

export function createOpenRouterProvider(config?: Partial<OpenRouterProviderConfig>): LlmProvider {
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

		return httpProviderCall<{ text: string; usage: OpenRouterUsage | null }>(
			{ label: "OpenRouter", timeoutMs, maxRetries: cfg.maxRetries },
			async ({ attempt, maxRetries, controller, setLastError }) => {
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
					const detail = parseApiErrorDetail(rawBody);

					if (res.status === 401 || res.status === 403) {
						throw new NonRetryableError(
							`OpenRouter auth failed (${res.status}): ${detail}. Check your OPENROUTER_API_KEY.`,
						);
					}

					if (isRetryableStatus(res.status) && attempt < maxRetries) {
						setLastError(new Error(`OpenRouter HTTP ${res.status}: ${detail}`));
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
				const text = extractContentText(first?.message?.content);
				if (text.length === 0) {
					throw new NonRetryableError("OpenRouter returned empty response");
				}

				return {
					retry: false,
					value: { text, usage: data.usage ?? null },
				} as const;
			},
		);
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
	model: "gpt-5-codex-mini",
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
					inputTokens: typeof turnUsage.input_tokens === "number" ? turnUsage.input_tokens : null,
					outputTokens: typeof turnUsage.output_tokens === "number" ? turnUsage.output_tokens : null,
					cacheReadTokens: typeof turnUsage.cached_input_tokens === "number" ? turnUsage.cached_input_tokens : null,
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

export function createCodexProvider(config?: Partial<CodexProviderConfig>): LlmProvider {
	const cfg = { ...DEFAULT_CODEX_CONFIG, ...config };

	async function callCodex(
		prompt: string,
		opts?: { timeoutMs?: number; maxTokens?: number },
	): Promise<LlmGenerateResult> {
		const timeoutMs = opts?.timeoutMs ?? cfg.defaultTimeoutMs;
		const deadline = performance.now() + timeoutMs;

		return withLlmConcurrency(async () => {
			const remainingMs = deadline - performance.now();
			if (remainingMs <= 0) {
				throw new Error(`codex timeout after ${timeoutMs}ms (deadline exceeded waiting for semaphore)`);
			}
			const args = [
				"exec",
				"--skip-git-repo-check",
				"--json",
				"--ephemeral",
				"--sandbox",
				"read-only",
				"-c",
				"mcp_servers.signet.enabled=false",
				"-C",
				cfg.workingDirectory,
				"--model",
				cfg.model,
				prompt,
			];

			const { SIGNET_NO_HOOKS: _, SIGNET_CODEX_BYPASS_WRAPPER: __, ...cleanEnv } = process.env;
			const sterile = createSterileCodexEnv(cleanEnv);
			let proc: SpawnResult;
			try {
				proc = spawnHidden(["codex", ...args], {
					env: {
						...sterile.env,
						NO_COLOR: "1",
						SIGNET_NO_HOOKS: "1",
						SIGNET_CODEX_BYPASS_WRAPPER: "1",
					},
				});
			} catch (e) {
				sterile.cleanup();
				throw e;
			}
			proc.exited.finally(() => sterile.cleanup());

			return awaitSubprocessWithDeadline(proc, remainingMs, "codex", timeoutMs, async (p) => {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(p.stdout).text().catch(() => ""),
					new Response(p.stderr).text().catch(() => ""),
					p.exited.catch(() => -1),
				]);

				if (exitCode !== 0) {
					const detail = stderr.trim() || stdout.trim();
					throw new Error(`codex exit ${exitCode}: ${detail.slice(0, 500)}`);
				}
				return parseCodexJsonl(stdout);
			});
		}, timeoutMs, "codex");
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
	readonly agent?: string;
	readonly enableOllamaFallback: boolean;
	readonly ollamaFallbackModel?: string;
	readonly ollamaFallbackBaseUrl: string;
	readonly ollamaFallbackMaxContextTokens?: number;
	readonly enableStructuredOutput?: boolean;
}

const DEFAULT_OPENCODE_CONFIG: OpenCodeProviderConfig = {
	baseUrl: "http://127.0.0.1:4096",
	model: "anthropic/claude-haiku-4-5-20251001",
	defaultTimeoutMs: 60000,
	agent: OPENCODE_PIPELINE_AGENT,
	enableOllamaFallback: true,
	ollamaFallbackModel: undefined,
	ollamaFallbackBaseUrl: "http://127.0.0.1:11434",
	ollamaFallbackMaxContextTokens: undefined,
	enableStructuredOutput: true,
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
	const deadline = performance.now() + 8000;
	let healthy = false;
	while (performance.now() < deadline) {
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
	readonly structured?: unknown;
}

interface OpenCodeMessageResponse {
	readonly info: OpenCodeAssistantMessage;
	readonly parts: ReadonlyArray<{ readonly type: string } & Record<string, unknown>>;
}

const OPENCODE_EXTRACTION_FALLBACK = '{"facts":[],"entities":[]}';

/**
 * Permissive JSON schema for OpenCode's structured output.
 * Accepts any JSON object — the pipeline's own validation handles
 * schema enforcement. The value here is forcing the model to use
 * OpenCode's StructuredOutput tool rather than free-text responding.
 */
const OPENCODE_JSON_SCHEMA: Record<string, unknown> = {
	type: "object",
	additionalProperties: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Detect whether a 4xx error body indicates an unknown/unregistered
 * agent.  Checks Zod-style `issues[].path` first (structured), then
 * requires both `"unknown agent"` and the agent name in the body text.
 */
function isAgentRejection(body: string, agent: string | undefined): boolean {
	if (!agent) return false;
	try {
		const parsed: unknown = JSON.parse(body);
		if (isRecord(parsed)) {
			const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
			if (issues.some((i): boolean => isRecord(i) && Array.isArray(i.path) && i.path[0] === "agent")) {
				return true;
			}
		}
	} catch {
		// empty
	}
	const lower = body.toLowerCase();
	return lower.includes("unknown agent") && !!agent && lower.includes(agent.toLowerCase());
}

function parseOpenCodeTokens(value: unknown): OpenCodeTokens | undefined {
	if (!isRecord(value)) return undefined;

	const cacheValue = value.cache;
	const cache = isRecord(cacheValue)
		? {
				...(typeof cacheValue.read === "number" ? { read: cacheValue.read } : {}),
				...(typeof cacheValue.write === "number" ? { write: cacheValue.write } : {}),
			}
		: undefined;

	return {
		...(typeof value.input === "number" ? { input: value.input } : {}),
		...(typeof value.output === "number" ? { output: value.output } : {}),
		...(typeof value.reasoning === "number" ? { reasoning: value.reasoning } : {}),
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
		...(parseOpenCodeTokens(infoRecord.tokens) ? { tokens: parseOpenCodeTokens(infoRecord.tokens) } : {}),
		...(infoRecord.structured !== undefined ? { structured: infoRecord.structured } : {}),
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

function selectLatestAssistantMessage(messages: readonly OpenCodeMessageResponse[]): OpenCodeMessageResponse | null {
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
	if (data.info.structured !== undefined) return true;
	for (const part of data.parts) {
		if (part.type !== "text") continue;
		if (typeof part.text !== "string") continue;
		if (part.text.trim().length > 0) return true;
	}
	return false;
}

/**
 * Extract assistant text from an OpenCode message response.
 * Prefers `info.structured` (set when json_schema format is used),
 * falls back to concatenating `type === "text"` parts.
 */
function extractOpenCodeText(data: OpenCodeMessageResponse): string {
	if (data.info.structured !== undefined) {
		return typeof data.info.structured === "string" ? data.info.structured : JSON.stringify(data.info.structured);
	}
	const textParts: string[] = [];
	for (const part of data.parts) {
		if (part.type === "text" && typeof part.text === "string") {
			textParts.push(part.text);
		}
	}
	return textParts.join("\n").trim();
}

export function createOpenCodeProvider(config?: Partial<OpenCodeProviderConfig>): LlmProvider {
	const merged = { ...DEFAULT_OPENCODE_CONFIG, ...config };
	const rawFallbackModel = merged.ollamaFallbackModel;
	const ollamaFallbackModel =
		typeof rawFallbackModel === "string" && rawFallbackModel.trim().length > 0
			? rawFallbackModel.trim()
			: resolveDefaultOllamaFallbackModel();
	const ollamaFallbackMaxContextTokens =
		normalizePositiveInt(merged.ollamaFallbackMaxContextTokens) ?? resolveDefaultOllamaFallbackMaxContextTokens(); // Eagerly resolved even when fallback is disabled; tryOllamaFallback gates on enableOllamaFallback.
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

	// INVARIANT: only called from inside sendMessage()'s withLlmConcurrency block.
	// Must NOT acquire the semaphore again (nested acquire = self-deadlock under load).
	async function tryOllamaFallback(
		prompt: string,
		remainingMs: number,
		opts: { maxTokens?: number } | undefined,
		reason: string,
	): Promise<OpenCodeMessageResponse | null> {
		if (!cfg.enableOllamaFallback) return null;
		if (remainingMs <= 0) return null;

		const provider = getOllamaFallbackProvider();
		if (!(await provider.available())) {
			logger.warn("pipeline", "OpenCode fallback to Ollama skipped (unavailable)", {
				reason,
				model: cfg.ollamaFallbackModel,
			});
			return null;
		}

		try {
			const timeoutMs = Math.min(remainingMs, 20_000);
			const maxTokens = opts?.maxTokens ?? 512;

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			let resultText = "";
			let inputTokens: number | null = null;
			let outputTokens: number | null = null;
			try {
				const options: Record<string, number> = {
					num_predict: maxTokens,
				};
				if (cfg.ollamaFallbackMaxContextTokens !== undefined) {
					options.num_ctx = cfg.ollamaFallbackMaxContextTokens;
				}
				const data = await callOllamaRaw({
					baseUrl: cfg.ollamaFallbackBaseUrl,
					model: cfg.ollamaFallbackModel,
					prompt,
					timeoutMs,
					signal: controller.signal,
					options,
					extraBody: { format: "json", think: false },
				});
				resultText = typeof data.response === "string" ? data.response.trim() : "";
				inputTokens = typeof data.prompt_eval_count === "number" ? data.prompt_eval_count : null;
				outputTokens = typeof data.eval_count === "number" ? data.eval_count : null;
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
						...(inputTokens !== null ? { input: inputTokens } : {}),
						...(outputTokens !== null ? { output: outputTokens } : {}),
					},
				},
				parts: [{ type: "text", text: resultText }],
			} as OpenCodeMessageResponse;
		} catch (e) {
			logger.warn("pipeline", "OpenCode fallback to Ollama failed", {
				reason,
				model: cfg.ollamaFallbackModel,
				error: e instanceof Error ? e.message : String(e),
			});
			return null;
		}
	}

	async function createSession(remainingMs?: number): Promise<string> {
		const timeoutMs =
			remainingMs !== undefined
				? Math.max(1, Math.min(remainingMs, 10_000))
				: 10_000;
		const res = await fetch(`${cfg.baseUrl}/session`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "signet-extraction" }),
			signal: AbortSignal.timeout(timeoutMs),
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`OpenCode create session failed (${res.status}): ${body.slice(0, 200)}`);
		}

		const data = (await res.json()) as Record<string, unknown>;
		const id = data.id;
		if (typeof id !== "string") {
			throw new Error("OpenCode session response missing 'id' field");
		}
		// Bypass hooks for our own pipeline sessions so the OpenCode plugin
		// does not trigger memory recall back to the daemon (circular loop).
		bypassSession(id, { allowUnknown: true });
		logger.debug("pipeline", "OpenCode session created", { id, bypassed: true });
		return id;
	}

	async function getOrCreateSession(remainingMs?: number): Promise<string> {
		if (sessionId) return sessionId;
		sessionId = await createSession(remainingMs);
		return sessionId;
	}

	let structuredOutputSupported = cfg.enableStructuredOutput !== false;
	let agentSupported = !!cfg.agent;

	function buildMessageBody(prompt: string, structured?: boolean): string {
		const body: Record<string, unknown> = {
			parts: [{ type: "text", text: prompt }],
			model: { providerID, modelID },
		};
		if (agentSupported && cfg.agent) {
			body.agent = cfg.agent;
		}
		// Per-call system override does not re-inflate the signet-pipeline
		// agent's stripped context.  Measured: ~4,844 input tokens total
		// vs ~47k with the default agent (90% reduction).
		if (structured && structuredOutputSupported) {
			body.system = OPENCODE_PIPELINE_SYSTEM_PROMPT;
			body.format = {
				type: "json_schema",
				schema: OPENCODE_JSON_SCHEMA,
				retryCount: 1,
			};
		}
		return JSON.stringify(body);
	}

	async function sendMessage(
		prompt: string,
		opts?: { timeoutMs?: number; maxTokens?: number },
	): Promise<OpenCodeMessageResponse> {
		const timeoutMs = opts?.timeoutMs ?? cfg.defaultTimeoutMs;
		const deadline = performance.now() + timeoutMs;

		const sid = await getOrCreateSession(deadline - performance.now());
		// Refresh bypass TTL on reused sessions so bypass-only entries do not
		// expire while the provider is still actively sending messages.
		bypassSession(sid, { allowUnknown: true });

		return withLlmConcurrency(async () => {
			const remaining = deadline - performance.now();
			if (remaining <= 0) {
				throw new Error(`OpenCode timeout after ${timeoutMs}ms (deadline exceeded waiting for semaphore)`);
			}

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), remaining);

			try {
				const postMessage = async (sid: string): Promise<Response> =>
					fetch(`${cfg.baseUrl}/session/${sid}/message`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: buildMessageBody(prompt, true),
						signal: controller.signal,
					});

				const listMessages = async (sid: string): Promise<Response> =>
					fetch(`${cfg.baseUrl}/session/${sid}/message`, {
						method: "GET",
						signal: controller.signal,
					});

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

				// Use remaining time after semaphore acquisition for poll deadline
				const pollForAssistantMessage = async (forSessionId: string): Promise<OpenCodeMessageResponse | null> => {
					const pollRemaining = deadline - performance.now();
					const pollDeadline = performance.now() + Math.max(1000, Math.min(pollRemaining, 20000));
					while (performance.now() < pollDeadline) {
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

				const retryWithNewSession = async (): Promise<OpenCodeMessageResponse | null> => {
					sessionId = null;
					const retrySid = await getOrCreateSession(deadline - performance.now());
					const retryRes = await postMessage(retrySid);
					if (!retryRes.ok) {
						const retryBody = await retryRes.text().catch(() => "");
						throw new Error(`OpenCode HTTP ${retryRes.status}: ${retryBody.slice(0, 200)}`);
					}
					return parsePostResponse(retryRes, retrySid);
				};

				let res = await postMessage(sid);
				let consumedBody: string | null = null;

				if (!res.ok && res.status === 422) {
					consumedBody = await res.text().catch(() => "");
					const isFormatRejection = (() => {
						try {
							const parsed: unknown = JSON.parse(consumedBody);
							if (!isRecord(parsed)) return false;
							const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
							return issues.some((i): boolean => isRecord(i) && Array.isArray(i.path) && i.path[0] === "format");
						} catch {
							return false;
						}
					})();
					if (isFormatRejection) {
						if (structuredOutputSupported) {
							logger.info("pipeline", "OpenCode does not support structured output format, disabling", {
								status: res.status,
							});
							structuredOutputSupported = false;
						}
						consumedBody = null;
						const retrySid = await createSession(deadline - performance.now());
						sessionId = retrySid;
						res = await fetch(`${cfg.baseUrl}/session/${retrySid}/message`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: buildMessageBody(prompt, false),
							signal: controller.signal,
						});
					}
				}

				if (!res.ok) {
					const body = consumedBody ?? (await res.text().catch(() => ""));
					if (res.status === 404 || res.status === 410) {
						const retryParsed = await retryWithNewSession();
						if (retryParsed) return retryParsed;
						logger.warn("pipeline", "OpenCode response remained malformed after retry; using fallback", {
							sessionId,
						});
						const ollamaFallback = await tryOllamaFallback(prompt, deadline - performance.now(), opts, "post-response-malformed-after-http-retry");
						if (ollamaFallback) return ollamaFallback;
						return buildOpenCodeFallbackResponse();
					}
					if (agentSupported && isAgentRejection(body, cfg.agent)) {
						agentSupported = false;
						logger.warn("pipeline", "OpenCode rejected pipeline agent; retrying without agent", {
							status: res.status,
							agent: cfg.agent,
						});
						const retrySid = await createSession(deadline - performance.now());
						const retryRes = await fetch(`${cfg.baseUrl}/session/${retrySid}/message`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: buildMessageBody(prompt, true),
							signal: controller.signal,
						});
						if (retryRes.ok) {
							sessionId = retrySid;
							const retryParsed = await parsePostResponse(retryRes, retrySid);
							if (retryParsed) return retryParsed;
						}
						sessionId = null;
						const ollamaFallback = await tryOllamaFallback(prompt, deadline - performance.now(), opts, "agent-not-found-retry-failed");
						if (ollamaFallback) return ollamaFallback;
						return buildOpenCodeFallbackResponse();
					}
					if (!agentSupported && isAgentRejection(body, cfg.agent)) {
						logger.warn("pipeline", "OpenCode agent rejection on already-disabled agent; falling back", {
							status: res.status,
						});
						const ollamaFallback = await tryOllamaFallback(prompt, deadline - performance.now(), opts, "concurrent-agent-rejection");
						if (ollamaFallback) return ollamaFallback;
						return buildOpenCodeFallbackResponse();
					}
					throw new Error(`OpenCode HTTP ${res.status}: ${body.slice(0, 200)}`);
				}

				const parsed = await parsePostResponse(res, sid);
				if (parsed) return parsed;

				const retryParsed = await retryWithNewSession();
				if (retryParsed) return retryParsed;

				if (structuredOutputSupported) {
					logger.info("pipeline", "Consecutive malformed 200 responses; disabling structured output", {
						sessionId,
					});
					structuredOutputSupported = false;
					sessionId = null;
					const fallbackSid = await createSession(deadline - performance.now());
					sessionId = fallbackSid;
					const fallbackRes = await fetch(`${cfg.baseUrl}/session/${fallbackSid}/message`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: buildMessageBody(prompt, false),
						signal: controller.signal,
					});
					if (fallbackRes.ok) {
						const fallbackParsed = await parsePostResponse(fallbackRes, fallbackSid);
						if (fallbackParsed) return fallbackParsed;
					}
				}

				logger.warn("pipeline", "OpenCode response remained malformed after retry; using fallback", {
					sessionId,
				});
				const ollamaFallback = await tryOllamaFallback(prompt, deadline - performance.now(), opts, "post-response-malformed-after-session-reset");
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
		}, timeoutMs, "opencode");
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
