/**
 * LLM provider interface with Ollama and Claude Code implementations.
 *
 * Ollama: HTTP API to local Ollama server.
 * Claude Code: headless CLI subprocess (`claude -p`), uses existing auth.
 */

import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface LlmProvider {
	readonly name: string;
	generate(
		prompt: string,
		opts?: { timeoutMs?: number; maxTokens?: number },
	): Promise<string>;
	available(): Promise<boolean>;
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

export function createOllamaProvider(
	config?: Partial<OllamaProviderConfig>,
): LlmProvider {
	const cfg = { ...DEFAULT_OLLAMA_CONFIG, ...config };

	return {
		name: `ollama:${cfg.model}`,

		async generate(prompt, opts): Promise<string> {
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

				const data = (await res.json()) as { response?: string };
				if (typeof data.response !== "string") {
					throw new Error("Ollama returned no response field");
				}

				return data.response.trim();
			} catch (e) {
				if (e instanceof DOMException && e.name === "AbortError") {
					throw new Error(`Ollama timeout after ${timeoutMs}ms`);
				}
				throw e;
			} finally {
				clearTimeout(timer);
			}
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

export function createClaudeCodeProvider(
	config?: Partial<ClaudeCodeProviderConfig>,
): LlmProvider {
	const cfg = { ...DEFAULT_CLAUDE_CODE_CONFIG, ...config };

	return {
		name: `claude-code:${cfg.model}`,

		async generate(prompt, opts): Promise<string> {
			const timeoutMs = opts?.timeoutMs ?? cfg.defaultTimeoutMs;

			const args = [
				"-p", prompt,
				"--model", cfg.model,
				"--no-session-persistence",
				"--output-format", "text",
			];

			if (opts?.maxTokens) {
				args.push("--max-budget-usd", "0.05");
			}

			// Unset CLAUDECODE to avoid nested-session detection when the
			// daemon itself is launched from within a Claude Code session.
			const { CLAUDECODE: _, ...cleanEnv } = process.env;

			const proc = Bun.spawn(["claude", ...args], {
				stdout: "pipe",
				stderr: "pipe",
				env: { ...cleanEnv, NO_COLOR: "1" },
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
				// Process was killed by timeout
				if (e instanceof Error && e.message.includes("SIGTERM")) {
					throw new Error(
						`claude-code timeout after ${timeoutMs}ms`,
					);
				}
				throw e;
			} finally {
				clearTimeout(timer);
			}
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
