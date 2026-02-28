/**
 * LLM provider implementations: Ollama (HTTP), Claude Code (CLI subprocess),
 * and OpenCode (headless HTTP server).
 *
 * The LlmProvider interface itself lives in @signet/core so that the
 * ingestion pipeline and other consumers can accept any provider.
 */

import type { LlmProvider, LlmGenerateResult } from "@signet/core";
import { logger } from "../logger";

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
	readonly model: string;
	readonly baseUrl: string;
	readonly defaultTimeoutMs: number;
}

const DEFAULT_OLLAMA_CONFIG: OllamaProviderConfig = {
	model: "qwen3:4b",
	baseUrl: "http://localhost:11434",
	defaultTimeoutMs: 45000,
};

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
	const cfg = { ...DEFAULT_OLLAMA_CONFIG, ...config };

	async function callOllama(
		prompt: string,
		opts?: { timeoutMs?: number; maxTokens?: number },
	): Promise<OllamaGenerateResponse> {
		const timeoutMs = opts?.timeoutMs ?? cfg.defaultTimeoutMs;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const res = await fetch(`${cfg.baseUrl}/api/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: cfg.model,
					prompt,
					stream: false,
					...(opts?.maxTokens ? { options: { num_predict: opts.maxTokens } } : {}),
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
		const timeoutMs = opts?.timeoutMs ?? cfg.defaultTimeoutMs;

		const args = [
			"-p", prompt,
			"--model", cfg.model,
			"--no-session-persistence",
			"--output-format", outputFormat,
		];

		if (opts?.maxTokens) {
			args.push("--max-budget-usd", "0.05");
		}

		// Unset CLAUDECODE to avoid nested-session detection when the
		// daemon itself is launched from within a Claude Code session.
		// Also inject SIGNET_NO_HOOKS to prevent recursive hook loops.
		const { CLAUDECODE: _, SIGNET_NO_HOOKS: __, ...cleanEnv } = process.env;

		const proc = Bun.spawn(["claude", ...args], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...cleanEnv, NO_COLOR: "1", SIGNET_NO_HOOKS: "1" },
		});

		const timer = setTimeout(() => {
			proc.kill();
		}, timeoutMs);

		try {
			const stdout = await new Response(proc.stdout).text();
			const exitCode = await proc.exited;

			if (exitCode !== 0) {
				const stderr = await new Response(proc.stderr).text();
				throw new Error(
					`claude-code exit ${exitCode}: ${stderr.slice(0, 300)}`,
				);
			}

			const result = stdout.trim();
			if (result.length === 0) {
				throw new Error("claude-code returned empty output");
			}

			return result;
		} catch (e) {
			if (
				e instanceof Error &&
				e.message.includes("claude-code exit")
			) {
				throw e;
			}
			if (e instanceof Error && e.message.includes("SIGTERM")) {
				throw new Error(
					`claude-code timeout after ${timeoutMs}ms`,
				);
			}
			throw e;
		} finally {
			clearTimeout(timer);
		}
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
				const proc = Bun.spawn(["claude", "--version"], {
					stdout: "pipe",
					stderr: "pipe",
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
// OpenCode via headless HTTP server
// ---------------------------------------------------------------------------

export interface OpenCodeProviderConfig {
	readonly baseUrl: string;
	readonly model: string;
	readonly defaultTimeoutMs: number;
}

const DEFAULT_OPENCODE_CONFIG: OpenCodeProviderConfig = {
	baseUrl: "http://localhost:4096",
	model: "anthropic/claude-haiku-4-5-20251001",
	defaultTimeoutMs: 60000,
};

/**
 * Resolve the opencode binary path. Checks PATH first via `which`,
 * then falls back to the well-known install location.
 */
function resolveOpenCodeBin(): string | null {
	// Check PATH first
	try {
		const proc = Bun.spawnSync(["which", "opencode"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (proc.exitCode === 0) {
			const path = proc.stdout.toString().trim();
			if (path.length > 0) return path;
		}
	} catch {
		// which not available or failed
	}

	// Fall back to ~/.opencode/bin/opencode
	const { existsSync } = require("fs");
	const { homedir } = require("os");
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
	const healthUrl = `http://localhost:${port}/global/health`;

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
	readonly cost?: number;
	readonly tokens?: OpenCodeTokens;
}

interface OpenCodeMessageResponse {
	readonly info: OpenCodeAssistantMessage;
	readonly parts: ReadonlyArray<{ readonly type: string } & Record<string, unknown>>;
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
	const cfg = { ...DEFAULT_OPENCODE_CONFIG, ...config };

	// Parse "provider/model" format (e.g. "anthropic/claude-haiku-4-5-20251001")
	const slashIdx = cfg.model.indexOf("/");
	const providerID = slashIdx > 0 ? cfg.model.slice(0, slashIdx) : "anthropic";
	const modelID = slashIdx > 0 ? cfg.model.slice(slashIdx + 1) : cfg.model;

	let sessionId: string | null = null;

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
			const res = await fetch(
				`${cfg.baseUrl}/session/${sid}/message`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: buildMessageBody(prompt),
					signal: controller.signal,
				},
			);

			if (!res.ok) {
				const body = await res.text().catch(() => "");
				// Session expired/invalid — reset and retry once
				if (res.status === 404 || res.status === 410) {
					sessionId = null;
					const retrySid = await getOrCreateSession();
					const retryRes = await fetch(
						`${cfg.baseUrl}/session/${retrySid}/message`,
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: buildMessageBody(prompt),
							signal: controller.signal,
						},
					);
					if (!retryRes.ok) {
						const retryBody = await retryRes.text().catch(() => "");
						throw new Error(
							`OpenCode HTTP ${retryRes.status}: ${retryBody.slice(0, 200)}`,
						);
					}
					return (await retryRes.json()) as OpenCodeMessageResponse;
				}
				throw new Error(
					`OpenCode HTTP ${res.status}: ${body.slice(0, 200)}`,
				);
			}

			return (await res.json()) as OpenCodeMessageResponse;
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
