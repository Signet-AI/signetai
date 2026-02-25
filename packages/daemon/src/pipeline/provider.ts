/**
 * LLM provider implementations: Ollama (HTTP) and Claude Code (CLI subprocess).
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
