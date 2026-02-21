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
