/**
 * LLM provider interface and Ollama implementation.
 *
 * Phase B only ships OllamaProvider — the interface exists for future
 * providers but we keep it minimal to avoid over-engineering.
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
// Ollama via Bun.spawn (matches hooks.ts:783 pattern)
// ---------------------------------------------------------------------------

export interface OllamaProviderConfig {
	readonly model: string;
	readonly defaultTimeoutMs: number;
}

const DEFAULT_OLLAMA_CONFIG: OllamaProviderConfig = {
	model: "qwen3:4b",
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

			const proc = Bun.spawn(["ollama", "run", cfg.model, prompt], {
				stdout: "pipe",
				stderr: "pipe",
			});

			let timedOut = false;
			try {
				const output = await Promise.race([
					new Response(proc.stdout).text(),
					new Promise<string>((_, reject) =>
						setTimeout(() => {
							timedOut = true;
							reject(new Error(`Ollama timeout after ${timeoutMs}ms`));
						}, timeoutMs),
					),
				]);

				await proc.exited;

				if (proc.exitCode !== 0) {
					const stderr = await new Response(proc.stderr).text();
					throw new Error(
						`Ollama exited with code ${proc.exitCode}: ${stderr.slice(0, 200)}`,
					);
				}

				return output.trim();
			} catch (e) {
				if (timedOut) {
					try {
						proc.kill();
					} catch {
						// already dead
					}
				}
				throw e;
			}
		},

		async available(): Promise<boolean> {
			try {
				const proc = Bun.spawn(["ollama", "list"], {
					stdout: "pipe",
					stderr: "pipe",
				});
				await proc.exited;
				return proc.exitCode === 0;
			} catch {
				logger.debug("pipeline", "Ollama not available");
				return false;
			}
		},
	};
}
