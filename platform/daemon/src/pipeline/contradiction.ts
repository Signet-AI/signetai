import { logger } from "../logger";
import { extractBalancedJsonObjects, stripFences, tryParseJson } from "./extraction";
import type { LlmProvider } from "./provider";

export interface SemanticContradictionResult {
	readonly detected: boolean;
	readonly confidence: number;
	readonly reasoning: string;
}

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

export async function detectSemanticContradiction(
	factContent: string,
	targetContent: string,
	provider: LlmProvider,
	timeoutMs = 120000,
): Promise<SemanticContradictionResult> {
	const noContradiction: SemanticContradictionResult = {
		detected: false,
		confidence: 0,
		reasoning: "",
	};

	try {
		const prompt = buildPrompt(factContent, targetContent);
		const raw = await provider.generate(prompt, { timeoutMs });
		const parsed = parseSemanticContradiction(raw);
		if (parsed === null) {
			throw new Error("Invalid contradiction response payload");
		}

		const detected = parsed.contradicts === true;
		const confidence = normalizeConfidence(parsed.confidence);
		const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";

		return { detected, confidence, reasoning };
	} catch (e) {
		logger.warn("pipeline", "Semantic contradiction check failed", {
			error: e instanceof Error ? e.message : String(e),
		});
		return noContradiction;
	}
}

function parseSemanticContradiction(raw: string): Record<string, unknown> | null {
	const stripped = stripFences(raw);
	const candidates: string[] = [raw.trim(), stripped];
	const rawObjs = extractBalancedJsonObjects(raw);
	for (let i = rawObjs.length - 1; i >= 0; i--) {
		candidates.push(rawObjs[i]);
	}
	const strippedObjs = extractBalancedJsonObjects(stripped);
	for (let i = strippedObjs.length - 1; i >= 0; i--) {
		candidates.push(strippedObjs[i]);
	}

	const seen = new Set<string>();
	for (const candidate of candidates) {
		const text = candidate.trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		const parsed = tryParseJson(candidate);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			continue;
		}
		if ("contradicts" in parsed) return parsed as Record<string, unknown>;
	}

	return null;
}

function normalizeConfidence(value: unknown): number {
	if (typeof value !== "number") return 0.5;
	if (Number.isNaN(value)) return 0.5;
	return Math.max(0, Math.min(1, value));
}
