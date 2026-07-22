/**
 * LLM provider infrastructure for the daemon pipeline.
 *
 * After #947, the only inference backends are:
 *   - Pi (pi-ai) via createPiModelProvider (see pi-provider.ts), and
 *   - ACPX (createAcpxProvider below), a retained harness-subprocess backend.
 * The per-provider HTTP/subprocess factories (Anthropic, OpenAI-compatible,
 * Ollama, llama.cpp, OpenRouter, Claude Code, Codex, OpenCode, command-line)
 * have been removed; their capabilities are provided by pi-ai or ACPX.
 *
 * This module retains the cross-provider infrastructure those backends share:
 * the global LLM concurrency semaphore, per-provider rate limiting, usage
 * tracking, the streaming types, and the ACPX provider.
 *
 * The LlmProvider interface itself lives in @signet/core so that the
 * ingestion pipeline and other consumers can accept any provider.
 */
// On Windows, use node:child_process spawn with windowsHide to prevent
// console window flashing. Bun.spawn doesn't support windowsHide.
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import {
	DEFAULT_PROVIDER_RATE_LIMIT,
	type LlmGenerateResult,
	type LlmProvider,
	type LlmUsage,
	type PipelineExtractionConfig,
	type ProviderRateLimitConfig,
	resolveDefaultBasePath,
} from "@signet/core";
import { logger } from "../logger";
import { which } from "../which";

// ---------------------------------------------------------------------------
// Global concurrency semaphore for all LLM providers
// ---------------------------------------------------------------------------
// Prevents starvation when multiple pipeline workers (extraction,
// structural-classify, summary, etc.) all issue LLM calls simultaneously
// — whether via CLI subprocesses or HTTP providers.
// Without this, 10+ concurrent calls can cause memory bloat, API rate
// limiting, and timeout cascades.

const DEFAULT_MAX_LLM_CONCURRENCY = 2;

export class SemaphoreTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(ms: number, reason?: string) {
		super(reason ?? `semaphore acquisition timed out after ${ms}ms`);
		this.name = "SemaphoreTimeoutError";
		this.timeoutMs = ms;
	}
}

export class LlmConcurrencySemaphore {
	private max: number;
	private active = 0;
	private readonly queue: Array<{
		readonly start: () => void;
	}> = [];
	private timers = 0;

	constructor(max: number) {
		this.max = max;
	}

	setLimit(max: number): void {
		this.max = max;
		this.drain();
	}

	async acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			throw new Error("semaphore acquisition aborted");
		}
		if (this.active < this.max) {
			this.active++;
			return;
		}
		return new Promise<void>((resolve, reject) => {
			const onAbort = (): void => {
				const idx = this.queue.indexOf(entry);
				if (idx !== -1) this.queue.splice(idx, 1);
				reject(new Error("semaphore acquisition aborted"));
			};
			const entry = {
				start: (): void => {
					signal?.removeEventListener("abort", onAbort);
					this.active++;
					resolve();
				},
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.queue.push(entry);
		});
	}

	async acquireWithTimeout(ms: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			throw new Error("semaphore acquisition aborted");
		}
		if (ms <= 0) {
			throw new SemaphoreTimeoutError(ms, "timeout must be positive");
		}
		if (this.active < this.max) {
			this.active++;
			return;
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const settle = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.timers--;
				signal?.removeEventListener("abort", onAbort);
				const idx = this.queue.indexOf(entry);
				if (idx !== -1) this.queue.splice(idx, 1);
				fn();
			};
			const onAbort = (): void => settle(() => reject(new Error("semaphore acquisition aborted")));
			this.timers++;
			const timer = setTimeout(() => {
				settle(() => reject(new SemaphoreTimeoutError(ms)));
			}, ms);
			const entry = {
				start: (): void => {
					settle(() => {
						this.active++;
						resolve();
					});
				},
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.queue.push(entry);
		});
	}

	release(): void {
		if (this.active <= 0) {
			throw new Error("LlmConcurrencySemaphore.release(): no active acquisitions to release");
		}
		this.active--;
		this.drain();
	}

	get pending(): number {
		return this.queue.length;
	}

	get running(): number {
		return this.active;
	}

	get limit(): number {
		return this.max;
	}

	get activeTimers(): number {
		return this.timers;
	}

	private drain(): void {
		while (this.active < this.max) {
			const next = this.queue.shift();
			if (!next) return;
			next.start();
		}
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

export function configureLlmConcurrency(limit: number): void {
	const normalized = Number.isSafeInteger(limit) ? Math.min(16, Math.max(1, limit)) : DEFAULT_MAX_LLM_CONCURRENCY;
	llmSemaphore.setLimit(normalized);
}

export function getLlmConcurrencyStatus(): {
	readonly running: number;
	readonly pending: number;
	readonly limit: number;
} {
	return {
		running: llmSemaphore.running,
		pending: llmSemaphore.pending,
		limit: llmSemaphore.limit,
	};
}

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
	"acpx",
	"claude-code",
	"anthropic",
	"openrouter",
	"codex",
	"opencode",
	"openai-compatible",
]);

// Compile-time check: if a new remote provider is added to the RemoteProvider
// union but omitted from the _exhaustiveCheck Record above, this produces a
// type error. NOTE: this only enforces that the Record keys cover the union —
// keeping RATE_LIMIT_PROVIDERS in sync with the Record remains a human
// discipline step (the Set is untyped ReadonlySet<string>).
const _exhaustiveCheck: Record<RemoteProvider, true> = {
	acpx: true,
	"claude-code": true,
	anthropic: true,
	openrouter: true,
	codex: true,
	opencode: true,
	"openai-compatible": true,
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
				allowedProviders: Array.from(RATE_LIMIT_PROVIDERS),
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
 * Resolve the caller-supplied abort signal (preferring `signal` over the
 * legacy `abortSignal` alias).
 */
function generateSignal(opts?: { readonly signal?: AbortSignal; readonly abortSignal?: AbortSignal }):
	| AbortSignal
	| undefined {
	return opts?.signal ?? opts?.abortSignal;
}

async function withLlmConcurrency<T>(
	fn: () => Promise<T>,
	timeoutMs?: number,
	label?: string,
	signal?: AbortSignal,
): Promise<T> {
	const release = await acquireLlmConcurrencyPermit(timeoutMs, label, signal);
	try {
		return await fn();
	} finally {
		release();
	}
}

async function acquireLlmConcurrencyPermit(
	timeoutMs?: number,
	label?: string,
	signal?: AbortSignal,
): Promise<() => void> {
	const semaphore = llmSemaphore;
	try {
		if (timeoutMs !== undefined) {
			await semaphore.acquireWithTimeout(timeoutMs, signal);
		} else {
			await semaphore.acquire(signal);
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
	let released = false;
	return () => {
		if (released) return;
		released = true;
		semaphore.release();
	};
}

// ---------------------------------------------------------------------------
// Streaming-capable provider types
// ---------------------------------------------------------------------------

export type { LlmProvider, LlmGenerateResult } from "@signet/core";

export type LlmProviderCallOptions = {
	readonly timeoutMs?: number;
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly signal?: AbortSignal;
	readonly abortSignal?: AbortSignal;
	/**
	 * Per-call thinking-level override for pi-ai-backed providers.
	 * - `undefined`: use the provider's configured reasoning level.
	 * - a `ThinkingLevel` ("minimal"|"low"|"medium"|"high"|"xhigh"): override
	 *   the configured level for this call.
	 * - `false`: explicitly suppress thinking for this call, even if the
	 *   provider/target is configured for reasoning. Used by latency-sensitive
	 *   operations (e.g. aggregate_recall) that must never emit thinking tokens.
	 */
	readonly reasoning?: ThinkingLevel | false;
};

export type LlmProviderStreamEvent =
	| { readonly type: "text-delta"; readonly text: string }
	| { readonly type: "done"; readonly text: string; readonly usage: LlmUsage | null };

export interface LlmProviderStreamResult {
	readonly stream: ReadableStream<LlmProviderStreamEvent>;
	cancel(reason?: string): void;
}

export interface StreamCapableLlmProvider extends LlmProvider {
	streamWithUsage?(prompt: string, opts?: LlmProviderCallOptions): Promise<LlmProviderStreamResult>;
}

/**
 * Run a provider call, returning usage when the provider reports it.
 */
export async function generateWithTracking(
	provider: LlmProvider,
	prompt: string,
	opts?: LlmProviderCallOptions,
): Promise<LlmGenerateResult> {
	if (provider.generateWithUsage) {
		return provider.generateWithUsage(prompt, opts);
	}
	const text = await provider.generate(prompt, opts);
	return { text, usage: null };
}

// ---------------------------------------------------------------------------
// Subprocess deadline helper (shared by harness/command providers)
// ---------------------------------------------------------------------------
// Runs a result-extracting callback against a spawned subprocess, racing
// against a deadline. On timeout: SIGTERM -> grace period -> SIGKILL.
//
// INVARIANT: the returned promise settles only AFTER `proc.exited` resolves,
// so callers wrapped in `withLlmConcurrency` won't release the semaphore
// until the child process is actually dead.

interface SpawnResult {
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	readonly processGroupId?: number;
	kill(signal?: string): void;
}

const SUBPROCESS_KILL_GRACE_MS = 2000;
const SUBPROCESS_KILL_REAP_MS = 1000;

function unixProcessGroupExists(processGroupId: number): boolean {
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code !== undefined &&
			(error as NodeJS.ErrnoException).code !== "ESRCH"
		) {
			return true;
		}
		return false;
	}
}

async function waitForUnixProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<boolean> {
	const deadline = performance.now() + timeoutMs;
	while (unixProcessGroupExists(processGroupId)) {
		if (performance.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return true;
}

function signalSubprocess(proc: SpawnResult, signal: "SIGTERM" | "SIGKILL"): void {
	const processGroupId = proc.processGroupId;
	if (process.platform !== "win32" && typeof processGroupId === "number") {
		try {
			process.kill(-processGroupId, signal);
			return;
		} catch {
			// Fall back to the proc-specific kill hook below. The group may have
			// already drained, or the hook may know how to terminate this process.
		}
	}
	try {
		proc.kill(signal);
	} catch {
		// The process may already be gone.
	}
}

async function terminateSubprocessWithEscalation(proc: SpawnResult): Promise<void> {
	signalSubprocess(proc, "SIGTERM");
	const processGroupId = proc.processGroupId;
	if (process.platform !== "win32" && typeof processGroupId === "number") {
		const groupExited = await waitForUnixProcessGroupExit(processGroupId, SUBPROCESS_KILL_GRACE_MS);
		if (!groupExited) {
			signalSubprocess(proc, "SIGKILL");
			await waitForUnixProcessGroupExit(processGroupId, SUBPROCESS_KILL_REAP_MS);
		}
		await proc.exited.catch(() => {});
		return;
	}
	const graceTimer = setTimeout(() => signalSubprocess(proc, "SIGKILL"), SUBPROCESS_KILL_GRACE_MS);
	await proc.exited.catch(() => {});
	clearTimeout(graceTimer);
}

export async function awaitSubprocessWithDeadline<T>(
	proc: SpawnResult,
	remainingMs: number,
	label: string,
	originalTimeoutMs: number,
	resultFn: (p: SpawnResult) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) {
		await terminateSubprocessWithEscalation(proc);
		throw new Error(`${label} aborted`);
	}
	if (remainingMs <= 0) {
		await terminateSubprocessWithEscalation(proc);
		throw new SemaphoreTimeoutError(
			originalTimeoutMs,
			`${label} timeout after ${originalTimeoutMs}ms (deadline exceeded before subprocess work)`,
		);
	}

	const timeout = Symbol("timeout");
	const aborted = Symbol("aborted");
	let terminationPromise: Promise<void> | undefined;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;
	const terminate = (): void => {
		terminationPromise ??= terminateSubprocessWithEscalation(proc);
	};
	const timeoutPromise = new Promise<typeof timeout>((resolve) => {
		deadlineTimer = setTimeout(() => {
			terminate();
			resolve(timeout);
		}, remainingMs);
	});
	const abortPromise = new Promise<typeof aborted>((resolve) => {
		if (!signal) return;
		abortListener = () => {
			terminate();
			resolve(aborted);
		};
		signal.addEventListener("abort", abortListener, { once: true });
	});
	const resultPromise = resultFn(proc).then(
		(value) => ({ ok: true as const, value }),
		(error) => ({ ok: false as const, error }),
	);

	const result = await Promise.race([resultPromise, timeoutPromise, abortPromise]);
	if (result === timeout || result === aborted) {
		if (deadlineTimer) clearTimeout(deadlineTimer);
		await (terminationPromise ?? proc.exited.catch(() => {}));
		if (signal && abortListener) signal.removeEventListener("abort", abortListener);
		if (result === aborted) {
			throw new Error(`${label} aborted`);
		}
		throw new SemaphoreTimeoutError(originalTimeoutMs, `${label} timeout after ${originalTimeoutMs}ms`);
	}

	if (deadlineTimer) clearTimeout(deadlineTimer);
	if (signal && abortListener) signal.removeEventListener("abort", abortListener);
	if (result.ok) {
		return result.value;
	}
	throw result.error;
}

// ---------------------------------------------------------------------------
// ACPX harness-subprocess provider (retained backend, peer of Pi)
// ---------------------------------------------------------------------------

export type AcpxPermissionMode = "inherit" | "deny-all" | "approve-reads" | "approve-all";
export type AcpxHooksMode = "inherit" | "disabled" | "enabled";
export type AcpxTerminalMode = "inherit" | "disabled" | "enabled";
export type AcpxSessionMode = "exec" | "session";
export type AcpxOutputFormat = "quiet" | "json";

export type AcpxJsonEvent = Readonly<Record<string, unknown>>;

export interface AcpxProviderConfig {
	readonly agent: string;
	readonly model?: string;
	readonly version?: string;
	readonly bin?: string;
	readonly package?: string;
	readonly cwd?: string;
	readonly session?: string;
	readonly mode?: AcpxSessionMode;
	readonly permissions?: AcpxPermissionMode;
	readonly hooks?: AcpxHooksMode;
	readonly terminal?: AcpxTerminalMode;
	readonly allowedTools?: readonly string[];
	readonly format?: AcpxOutputFormat;
	readonly captureEvents?: boolean;
	readonly maxCapturedEvents?: number;
	readonly onEvent?: (event: AcpxJsonEvent) => void;
	readonly timeoutMs?: number;
	readonly extraArgs?: readonly string[];
}

const DEFAULT_ACPX_VERSION = "0.12.0";

function normalizeAcpxAgent(agent: string): string {
	return agent === "claude-code" ? "claude" : agent;
}

function acpxPermissionArgs(mode: AcpxPermissionMode | undefined): string[] {
	switch (mode) {
		case "deny-all":
			return ["--deny-all"];
		case "approve-reads":
			return ["--approve-reads"];
		case "approve-all":
			return ["--approve-all"];
		default:
			return [];
	}
}

function acpxEnv(hooks: AcpxHooksMode | undefined, runId?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (hooks === "disabled") {
		env.SIGNET_NO_HOOKS = "1";
		env.SIGNET_ENABLED = "false";
	} else if (hooks === "enabled") {
		env.SIGNET_NO_HOOKS = undefined;
	}
	if (runId) env.SIGNET_ACPX_RUN_ID = runId;
	return env;
}

function getAgentsDir(): string {
	return resolveDefaultBasePath();
}

function resolveAcpxCwd(cwd: string | undefined, hooks: AcpxHooksMode | undefined): string | undefined {
	if (cwd) return isAbsolute(cwd) ? cwd : resolvePath(cwd);
	if (hooks !== "disabled") return undefined;
	const isolatedCwd = join(getAgentsDir(), ".daemon", "acpx-background");
	mkdirSync(isolatedCwd, { recursive: true });
	return isolatedCwd;
}

function resolveAcpxAllowedTools(
	config: Pick<AcpxProviderConfig, "allowedTools" | "hooks">,
): readonly string[] | undefined {
	if (config.allowedTools !== undefined) return config.allowedTools;
	return config.hooks === "disabled" ? [] : undefined;
}

function resolveAcpxFormat(config: Pick<AcpxProviderConfig, "format" | "captureEvents">): AcpxOutputFormat {
	return config.format ?? (config.captureEvents ? "json" : "quiet");
}

function buildAcpxCommand(
	config: AcpxProviderConfig,
	timeoutMs: number,
): { bin: string; args: string[]; cwd?: string } {
	const bin = config.bin ?? "npx";
	const cwd = resolveAcpxCwd(config.cwd, config.hooks);
	const packageRef = config.package ?? (!config.bin ? `acpx@${config.version ?? DEFAULT_ACPX_VERSION}` : undefined);
	const allowedTools = resolveAcpxAllowedTools(config);
	const args: string[] = [];
	if (packageRef) {
		if (bin.endsWith("npx") || bin.endsWith("npx.cmd")) args.push("-y");
		args.push(packageRef);
	}
	args.push("--format", resolveAcpxFormat(config));
	args.push("--timeout", String(Math.max(1, Math.ceil(timeoutMs / 1000))));
	if (cwd) args.push("--cwd", cwd);
	if (config.model) args.push("--model", config.model);
	args.push(...acpxPermissionArgs(config.permissions));
	if (config.terminal === "disabled") args.push("--no-terminal");
	if (allowedTools) args.push("--allowed-tools", allowedTools.join(","));
	args.push(...(config.extraArgs ?? []));
	args.push(normalizeAcpxAgent(config.agent));
	if ((config.mode ?? "exec") === "session" && config.session) {
		args.push("-s", config.session);
	}
	args.push("exec", "--file", "-");
	return { bin, args, cwd };
}

function isJsonRecord(value: unknown): value is AcpxJsonEvent {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function acpxStringField(record: AcpxJsonEvent, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function extractAcpxTextCandidate(event: AcpxJsonEvent): string | undefined {
	for (const key of ["text", "final", "output", "content", "message"] as const) {
		const direct = acpxStringField(event, key);
		if (direct?.trim()) return direct;
	}
	for (const key of ["result", "response", "data"] as const) {
		const nested = event[key];
		if (typeof nested === "string" && nested.trim()) return nested;
		if (isJsonRecord(nested)) {
			const candidate = extractAcpxTextCandidate(nested);
			if (candidate?.trim()) return candidate;
		}
	}
	return undefined;
}

function isAcpxFinalEvent(event: AcpxJsonEvent): boolean {
	const type = acpxStringField(event, "type")?.toLowerCase();
	if (type !== undefined && ["result", "final", "complete", "completed", "done", "response"].includes(type))
		return true;
	const result = event.result;
	return isJsonRecord(result) && typeof result.stopReason === "string";
}

function extractAcpxMessageChunk(event: AcpxJsonEvent): string | undefined {
	if (acpxStringField(event, "method") !== "session/update") return undefined;
	const params = event.params;
	if (!isJsonRecord(params)) return undefined;
	const update = params.update;
	if (!isJsonRecord(update)) return undefined;
	const sessionUpdate = acpxStringField(update, "sessionUpdate")?.toLowerCase();
	if (sessionUpdate !== undefined && !sessionUpdate.includes("message")) return undefined;
	const content = update.content;
	if (typeof content === "string" && content.length > 0) return content;
	if (isJsonRecord(content)) {
		const text = acpxStringField(content, "text");
		if (text !== undefined) return text;
	}
	return undefined;
}

function terminateChildProcessTree(child: ReturnType<typeof nodeSpawn>, signal: NodeJS.Signals = "SIGTERM"): void {
	const pid = child.pid;
	if (pid && process.platform !== "win32") {
		try {
			process.kill(-pid, signal);
			return;
		} catch {
			// Fall back to killing the direct child below. This can happen if the
			// process exits before we signal the detached process group.
		}
	}
	child.kill(signal);
}

function terminateChildProcessTreeWithEscalation(child: ReturnType<typeof nodeSpawn>): void {
	terminateChildProcessTree(child, "SIGTERM");
	const escalation = setTimeout(() => terminateChildProcessTree(child, "SIGKILL"), 1000);
	escalation.unref?.();
	child.once("close", () => clearTimeout(escalation));
}

function acpxAgentProcessBasenames(agent: string): string[] {
	switch (normalizeAcpxAgent(agent).toLowerCase()) {
		case "codex":
			return ["codex-acp"];
		default:
			return [];
	}
}

function acpxProcRoot(): string {
	return process.env.SIGNET_ACPX_PROC_ROOT || "/proc";
}

function procEnvContainsRunId(procRoot: string, pid: string, runId: string): boolean {
	try {
		const environ = readFileSync(`${procRoot}/${pid}/environ`, "utf8");
		return environ.includes(`SIGNET_ACPX_RUN_ID=${runId}`);
	} catch {
		return false;
	}
}

function procCommandMatchesAgent(procRoot: string, pid: string, basenames: ReadonlySet<string>): boolean {
	try {
		const cmdline = readFileSync(`${procRoot}/${pid}/cmdline`, "utf8");
		return cmdline
			.split("\0")
			.filter(Boolean)
			.some((arg) => basenames.has(arg.split("/").pop() ?? ""));
	} catch {
		return false;
	}
}

function cleanupAcpxAgentProcesses(agent: string, runId: string): void {
	if (process.platform !== "linux") return;
	const basenames = new Set(acpxAgentProcessBasenames(agent));
	if (basenames.size === 0) return;
	const procRoot = acpxProcRoot();
	let procEntries: string[];
	try {
		procEntries = readdirSync(procRoot);
	} catch {
		return;
	}
	const pids = procEntries
		.filter((pid) => /^\d+$/.test(pid))
		.filter((pid) => procCommandMatchesAgent(procRoot, pid, basenames))
		.filter((pid) => procEnvContainsRunId(procRoot, pid, runId))
		.map((pid) => Number(pid))
		.filter((pid) => Number.isFinite(pid) && pid > 0);
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already gone or not ours to signal.
		}
		const escalation = setTimeout(() => {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already exited.
			}
		}, 1000);
		escalation.unref?.();
	}
}

function parseAcpxJsonOutput(
	stdout: string,
	config: Pick<AcpxProviderConfig, "agent" | "captureEvents" | "maxCapturedEvents" | "onEvent">,
): string {
	const maxCapturedEvents = Math.max(0, config.maxCapturedEvents ?? 200);
	let emittedEvents = 0;
	let finalText: string | undefined;
	let streamedText = "";
	const lines = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] as string;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw new Error(
				`${config.agent} via ACPX emitted invalid JSON on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!isJsonRecord(parsed)) {
			throw new Error(`${config.agent} via ACPX emitted non-object JSON event on line ${index + 1}`);
		}
		const chunk = extractAcpxMessageChunk(parsed);
		if (chunk !== undefined) streamedText += chunk;
		if (isAcpxFinalEvent(parsed)) {
			const candidate = extractAcpxTextCandidate(parsed);
			if (candidate?.trim()) {
				finalText = candidate;
			} else if (streamedText.trim()) {
				finalText = streamedText;
			}
		}
		if (config.captureEvents === true && emittedEvents < maxCapturedEvents) {
			emittedEvents += 1;
			config.onEvent?.(parsed);
		}
	}

	if (finalText?.trim()) return finalText.trim();
	throw new Error(`${config.agent} via ACPX JSON output did not include a final response`);
}

export function createAcpxProvider(config: AcpxProviderConfig): LlmProvider {
	return {
		name: `acpx:${config.agent}${config.model ? `:${config.model}` : ""}`,
		async generate(prompt, opts): Promise<string> {
			const timeoutMs = opts?.timeoutMs ?? config.timeoutMs ?? 60_000;
			const deadline = performance.now() + timeoutMs;
			const signal = generateSignal(opts);
			return withLlmConcurrency(
				async () => {
					const remainingMs = deadline - performance.now();
					if (remainingMs <= 0) {
						throw new Error(
							`${config.agent} via ACPX timeout after ${timeoutMs}ms (deadline exceeded waiting for semaphore)`,
						);
					}
					const { bin, args, cwd } = buildAcpxCommand(config, remainingMs);
					const outputFormat = resolveAcpxFormat(config);
					const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
					return new Promise<string>((resolve, reject) => {
						let stdout = "";
						let stderr = "";
						let settled = false;
						let aborted = false;
						const child = nodeSpawn(bin, args, {
							cwd,
							env: acpxEnv(config.hooks, runId),
							stdio: ["pipe", "pipe", "pipe"],
							detached: process.platform !== "win32",
							windowsHide: true,
						});
						const finish = (fn: () => void): void => {
							if (settled) return;
							settled = true;
							clearTimeout(timer);
							signal?.removeEventListener("abort", onAbort);
							cleanupAcpxAgentProcesses(config.agent, runId);
							fn();
						};
						const onAbort = (): void => {
							aborted = true;
							terminateChildProcessTreeWithEscalation(child);
						};
						if (signal?.aborted) {
							onAbort();
						} else {
							signal?.addEventListener("abort", onAbort, { once: true });
						}
						const timer = setTimeout(() => {
							terminateChildProcessTreeWithEscalation(child);
							finish(() => reject(new Error(`${config.agent} via ACPX timeout after ${timeoutMs}ms`)));
						}, remainingMs);
						child.stdout?.setEncoding("utf8");
						child.stderr?.setEncoding("utf8");
						child.stdout?.on("data", (chunk) => {
							stdout += String(chunk);
						});
						child.stderr?.on("data", (chunk) => {
							stderr += String(chunk);
						});
						child.on("error", (error) => finish(() => reject(error)));
						child.on("close", (code) =>
							finish(() => {
								if (aborted) {
									reject(new Error(`${config.agent} via ACPX aborted`));
									return;
								}
								if (code !== 0) {
									reject(new Error(`${config.agent} via ACPX exited ${code}: ${stderr.slice(0, 300)}`));
									return;
								}
								let text: string;
								try {
									text = outputFormat === "json" ? parseAcpxJsonOutput(stdout, config) : stdout.trim();
								} catch (error) {
									reject(error);
									return;
								}
								if (!text) {
									reject(new Error(`${config.agent} via ACPX returned empty response`));
									return;
								}
								resolve(text);
							}),
						);
						child.stdin?.end(prompt);
					});
				},
				timeoutMs,
				"acpx",
				signal,
			);
		},
		async available(): Promise<boolean> {
			const bin = config.bin ?? "npx";
			return which(bin) !== null;
		},
	};
}
