/**
 * BaseRefiner — abstract base class for all perception refiners.
 *
 * Provides LLM calling via Ollama HTTP API, cooldown checking,
 * and the refine() orchestration method.
 */

import type {
	CaptureBundle,
	RefinerOutput,
	ExtractedMemory,
} from "../types";

export interface RefinerLLMConfig {
	ollamaUrl: string;
	model: string;
	timeoutMs: number;
}

export const DEFAULT_REFINER_LLM_CONFIG: RefinerLLMConfig = {
	ollamaUrl: "http://localhost:11434",
	model: "qwen2.5:7b",
	timeoutMs: 120_000,
};

export abstract class BaseRefiner {
	abstract readonly name: string;
	abstract readonly cooldownMinutes: number;
	abstract readonly systemPrompt: string;

	protected llmConfig: RefinerLLMConfig;

	constructor(llmConfig: Partial<RefinerLLMConfig> = {}) {
		this.llmConfig = { ...DEFAULT_REFINER_LLM_CONFIG, ...llmConfig };
	}

	/**
	 * Check if this refiner should run based on cooldown and data availability.
	 */
	shouldRun(bundle: CaptureBundle, lastRun?: Date): boolean {
		if (lastRun) {
			const elapsedMin = (Date.now() - lastRun.getTime()) / 60_000;
			if (elapsedMin < this.cooldownMinutes) return false;
		}
		return this.hasEnoughData(bundle);
	}

	/**
	 * Override to check if the bundle has enough data for this refiner.
	 */
	abstract hasEnoughData(bundle: CaptureBundle): boolean;

	/**
	 * Format the capture bundle into a prompt string for the LLM.
	 */
	abstract formatContext(bundle: CaptureBundle): string;

	/**
	 * Parse the raw LLM response into extracted memories.
	 */
	abstract parseResponse(response: string): ExtractedMemory[];

	/**
	 * Main refinement pipeline: format → LLM → parse.
	 */
	async refine(bundle: CaptureBundle): Promise<RefinerOutput> {
		const warnings: string[] = [];

		try {
			const context = this.formatContext(bundle);
			const response = await this.callLLM(this.systemPrompt, context);
			const memories = this.parseResponse(response);

			return {
				refinerName: this.name,
				memories,
				warnings,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			warnings.push(`${this.name} failed: ${msg}`);
			return {
				refinerName: this.name,
				memories: [],
				warnings,
			};
		}
	}

	/**
	 * Call Ollama HTTP API — same pattern as @signet/core extractor.ts.
	 */
	protected async callLLM(system: string, prompt: string): Promise<string> {
		const url = `${this.llmConfig.ollamaUrl}/api/generate`;

		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			this.llmConfig.timeoutMs,
		);

		try {
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: this.llmConfig.model,
					system,
					prompt,
					stream: false,
					options: {
						temperature: 0.1,
						num_predict: 4096,
					},
				}),
				signal: controller.signal,
			});

			if (!res.ok) {
				const body = await res.text().catch(() => "");
				throw new Error(
					`Ollama returned ${res.status}: ${body.slice(0, 200)}`,
				);
			}

			const data = (await res.json()) as { response: string };
			return data.response;
		} finally {
			clearTimeout(timeout);
		}
	}

	/**
	 * Helper: parse a JSON array from possibly-fenced LLM output.
	 */
	protected parseJsonArray(raw: string): unknown[] {
		let jsonStr = raw.trim();

		// Strip markdown fences
		const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (fenceMatch) {
			jsonStr = fenceMatch[1].trim();
		}

		// Find array boundaries
		const arrStart = jsonStr.indexOf("[");
		const arrEnd = jsonStr.lastIndexOf("]");
		if (arrStart >= 0 && arrEnd > arrStart) {
			jsonStr = jsonStr.slice(arrStart, arrEnd + 1);
		}

		try {
			const parsed = JSON.parse(jsonStr);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			// Try cleaning trailing commas
			try {
				const cleaned = jsonStr.replace(/,\s*([}\]])/g, "$1");
				const parsed = JSON.parse(cleaned);
				return Array.isArray(parsed) ? parsed : [];
			} catch {
				return [];
			}
		}
	}

	/**
	 * Helper: parse a JSON object from possibly-fenced LLM output.
	 */
	protected parseJsonObject(raw: string): Record<string, unknown> {
		let jsonStr = raw.trim();

		const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (fenceMatch) {
			jsonStr = fenceMatch[1].trim();
		}

		const objStart = jsonStr.indexOf("{");
		const objEnd = jsonStr.lastIndexOf("}");
		if (objStart >= 0 && objEnd > objStart) {
			jsonStr = jsonStr.slice(objStart, objEnd + 1);
		}

		try {
			return JSON.parse(jsonStr);
		} catch {
			try {
				const cleaned = jsonStr.replace(/,\s*([}\]])/g, "$1");
				return JSON.parse(cleaned);
			} catch {
				return {};
			}
		}
	}
}
