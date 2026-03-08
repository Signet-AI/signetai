/**
 * Skill frontmatter enrichment via LLM.
 *
 * When a skill is installed with thin frontmatter (short description,
 * no triggers), this module generates richer metadata so the skill
 * can be discovered through memory retrieval.
 *
 * Lives alongside the other extraction/decision prompts in pipeline/.
 */

import type { LlmProvider } from "./provider";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillEnrichmentInput {
	readonly name: string;
	readonly description: string;
	readonly body: string;
}

export interface SkillEnrichmentResult {
	readonly description: string;
	readonly triggers: readonly string[];
	readonly tags: readonly string[];
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildEnrichmentPrompt(input: SkillEnrichmentInput): string {
	const bodyPreview = input.body.length > 3000
		? `${input.body.slice(0, 3000)}\n[truncated]`
		: input.body;

	return `You are analyzing an AI agent skill to generate discovery metadata.

Skill name: ${input.name}
Current description: ${input.description || "(none)"}

Skill content:
${bodyPreview}

Generate:
1. "description": A rich 1-2 sentence description explaining what this skill does and when to use it. Focus on mechanism and use-case.
2. "triggers": A list of 3-8 short phrases a user might say when they need this skill. These are discovery keywords, not commands. Examples: "help me write tests", "optimize database queries", "create a new component".
3. "tags": A list of 2-5 domain tags for grouping. Use lowercase, single words or hyphenated compounds. Examples: "testing", "database", "ui", "code-review", "deployment".

Return ONLY a JSON object with these three keys. No other text.
{"description": "...", "triggers": ["...", "..."], "tags": ["...", "..."]}`;
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

const THINK_RE = /<think>[\s\S]*?<\/think>\s*/g;
const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/;

function parseEnrichmentOutput(raw: string): SkillEnrichmentResult | null {
	const stripped = raw.replace(THINK_RE, "").trim();
	const fenceMatch = stripped.match(FENCE_RE);
	const jsonStr = fenceMatch ? fenceMatch[1].trim() : stripped;

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null) return null;
	const obj = parsed as Record<string, unknown>;

	const description = typeof obj.description === "string"
		? obj.description.trim()
		: "";

	const triggers = Array.isArray(obj.triggers)
		? obj.triggers.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
		: [];

	const tags = Array.isArray(obj.tags)
		? obj.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
		: [];

	if (!description && triggers.length === 0) return null;

	return { description, triggers, tags };
}

// ---------------------------------------------------------------------------
// Main enrichment function
// ---------------------------------------------------------------------------

export async function enrichSkillFrontmatter(
	input: SkillEnrichmentInput,
	provider: LlmProvider,
): Promise<SkillEnrichmentResult | null> {
	const prompt = buildEnrichmentPrompt(input);

	try {
		const raw = await provider.generate(prompt, { maxTokens: 512 });
		const result = parseEnrichmentOutput(raw);

		if (!result) {
			logger.warn("pipeline", "Failed to parse skill enrichment output", {
				skill: input.name,
				preview: raw.slice(0, 200),
			});
			return null;
		}

		logger.debug("pipeline", "Skill enrichment complete", {
			skill: input.name,
			triggerCount: result.triggers.length,
			tagCount: result.tags.length,
		});

		return result;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		logger.warn("pipeline", "Skill enrichment LLM call failed", {
			skill: input.name,
			error: msg,
		});
		return null;
	}
}
