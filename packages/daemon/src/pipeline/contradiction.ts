/**
 * Semantic contradiction detection via LLM.
 *
 * The fast path (syntactic detection in worker.ts) catches negation
 * and antonym conflicts. This slow path uses an LLM to catch semantic
 * contradictions like "uses PostgreSQL" vs "migrated to MongoDB".
 *
 * Only called for update proposals with lexical overlap >= 3 tokens
 * where syntactic detection returned false.
 */

import { logger } from "../logger";
import type { LlmProvider } from "./provider";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SemanticContradictionResult {
	readonly detected: boolean;
	readonly confidence: number;
	readonly reasoning: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(factContent: string, targetContent: string): string {
	return `Do these two statements contradict each other? Consider semantic contradictions (not just syntactic).

Statement A: ${factContent}
Statement B: ${targetContent}

Return ONLY a JSON object (no markdown fences, no other text):
{"contradicts": true/false, "confidence": 0.0-1.0, "reasoning": "brief explanation"}

Examples of contradictions:
- "Uses PostgreSQL for the auth service" vs "Migrated the auth service to MongoDB" → contradicts
- "Dark mode is enabled by default" vs "Light mode is the default theme" → contradicts
- "The API uses REST" vs "The API endpoint returns JSON" → does NOT contradict (complementary info)`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function detectSemanticContradiction(
	factContent: string,
	targetContent: string,
	provider: LlmProvider,
): Promise<SemanticContradictionResult> {
	const noContradiction: SemanticContradictionResult = {
		detected: false,
		confidence: 0,
		reasoning: "",
	};

	try {
		const prompt = buildPrompt(factContent, targetContent);
		const raw = await provider.generate(prompt, { timeoutMs: 15000 });

		let jsonStr = raw.trim();
		const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (fenceMatch) jsonStr = fenceMatch[1].trim();
		jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

		const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

		const detected = parsed.contradicts === true;
		const confidence =
			typeof parsed.confidence === "number"
				? Math.max(0, Math.min(1, parsed.confidence))
				: 0.5;
		const reasoning =
			typeof parsed.reasoning === "string" ? parsed.reasoning : "";

		return { detected, confidence, reasoning };
	} catch (e) {
		logger.warn("pipeline", "Semantic contradiction check failed", {
			error: (e as Error).message,
		});
		return noContradiction;
	}
}
