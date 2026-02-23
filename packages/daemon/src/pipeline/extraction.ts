/**
 * Fact and entity extraction from memory content.
 *
 * Contract-first with strict validation — rejects malformed output
 * gracefully, returning partial results with warnings.
 */

import {
	MEMORY_TYPES,
	type ExtractionResult,
	type ExtractedFact,
	type ExtractedEntity,
	type MemoryType,
} from "@signet/core";
import type { LlmProvider } from "./provider";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_FACTS = 20;
const MAX_ENTITIES = 50;
const MAX_FACT_LENGTH = 2000;
const MIN_FACT_LENGTH = 20;
const MAX_INPUT_CHARS = 12000;

const VALID_TYPES = new Set<string>(MEMORY_TYPES);

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildExtractionPrompt(content: string): string {
	return `Extract key facts and entity relationships from this text.

Return JSON with two arrays: "facts" and "entities".

Each fact: {"content": "...", "type": "fact|preference|decision|procedural|semantic", "confidence": 0.0-1.0}
Each entity: {"source": "...", "relationship": "...", "target": "...", "confidence": 0.0-1.0}

IMPORTANT — Atomic facts:
Each fact must be fully understandable WITHOUT the original conversation. Include the specific subject (package name, file path, component, tool) and enough context that a reader seeing only this fact knows exactly what it refers to.

BAD: "install() writes bundled plugin"
GOOD: "The @signet/connector-opencode install() function writes pre-bundled signet.mjs to ~/.config/opencode/plugins/"

BAD: "Uses PostgreSQL instead of MongoDB"
GOOD: "The auth service uses PostgreSQL instead of MongoDB for better relational query support"

Types: fact (objective info), preference (user likes/dislikes), decision (choices made), procedural (how-to knowledge), semantic (concepts/definitions).

Examples:

Input: "User prefers dark mode and uses vim keybindings in VS Code"
Output:
{"facts": [
  {"content": "User prefers dark mode for all editor and terminal interfaces", "type": "preference", "confidence": 0.9},
  {"content": "User uses vim keybindings in VS Code as their primary editing mode", "type": "preference", "confidence": 0.9}
], "entities": [
  {"source": "User", "relationship": "prefers", "target": "dark mode", "confidence": 0.9},
  {"source": "User", "relationship": "uses", "target": "vim keybindings", "confidence": 0.9}
]}

Input: "Decided to use PostgreSQL instead of MongoDB for the auth service"
Output:
{"facts": [
  {"content": "The auth service uses PostgreSQL instead of MongoDB because relational queries suit the access-control schema better", "type": "decision", "confidence": 0.85}
], "entities": [
  {"source": "auth service", "relationship": "uses", "target": "PostgreSQL", "confidence": 0.85},
  {"source": "auth service", "relationship": "rejected", "target": "MongoDB", "confidence": 0.8}
]}

Only extract durable, reusable knowledge. Skip ephemeral details.
Return ONLY the JSON object, no other text.

Text:
${content}`;
}

// ---------------------------------------------------------------------------
// JSON parsing helpers
// ---------------------------------------------------------------------------

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/;
const THINK_RE = /<think>[\s\S]*?<\/think>\s*/g;

function stripFences(raw: string): string {
	// Strip <think> blocks from models that use chain-of-thought (qwen3, etc.)
	const stripped = raw.replace(THINK_RE, "");
	const match = stripped.match(FENCE_RE);
	return match ? match[1].trim() : stripped.trim();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateFact(raw: unknown, warnings: string[]): ExtractedFact | null {
	if (typeof raw !== "object" || raw === null) {
		warnings.push("Fact is not an object");
		return null;
	}

	const obj = raw as Record<string, unknown>;

	if (typeof obj.content !== "string") {
		warnings.push("Fact missing content string");
		return null;
	}

	const content = obj.content.trim();
	if (content.length < MIN_FACT_LENGTH) {
		warnings.push(`Fact too short (${content.length} chars): "${content}"`);
		return null;
	}
	if (content.length > MAX_FACT_LENGTH) {
		warnings.push(`Fact truncated from ${content.length} chars`);
	}

	const typeStr = typeof obj.type === "string" ? obj.type : "fact";
	const type: MemoryType = VALID_TYPES.has(typeStr)
		? (typeStr as MemoryType)
		: "fact";
	if (!VALID_TYPES.has(typeStr)) {
		warnings.push(`Invalid type "${typeStr}", defaulting to "fact"`);
	}

	const rawConf = typeof obj.confidence === "number" ? obj.confidence : 0.5;
	const confidence = Math.max(0, Math.min(1, rawConf));

	return {
		content: content.slice(0, MAX_FACT_LENGTH),
		type,
		confidence,
	};
}

function validateEntity(
	raw: unknown,
	warnings: string[],
): ExtractedEntity | null {
	if (typeof raw !== "object" || raw === null) {
		warnings.push("Entity is not an object");
		return null;
	}

	const obj = raw as Record<string, unknown>;

	const source = typeof obj.source === "string" ? obj.source.trim() : "";
	const relationship =
		typeof obj.relationship === "string" ? obj.relationship.trim() : "";
	const target = typeof obj.target === "string" ? obj.target.trim() : "";

	if (!source || !target) {
		warnings.push("Entity missing source or target");
		return null;
	}
	if (!relationship) {
		warnings.push("Entity missing relationship");
		return null;
	}

	const rawConf = typeof obj.confidence === "number" ? obj.confidence : 0.5;
	const confidence = Math.max(0, Math.min(1, rawConf));

	return { source, relationship, target, confidence };
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

export async function extractFactsAndEntities(
	input: string,
	provider: LlmProvider,
): Promise<ExtractionResult> {
	const warnings: string[] = [];

	const trimmed = input.trim().replace(/\s+/g, " ");
	if (trimmed.length < 20) {
		return {
			facts: [],
			entities: [],
			warnings: ["Input too short (< 20 chars)"],
		};
	}

	const truncated =
		trimmed.length > MAX_INPUT_CHARS
			? `${trimmed.slice(0, MAX_INPUT_CHARS)}\n[truncated]`
			: trimmed;

	const prompt = buildExtractionPrompt(truncated);

	let rawOutput: string;
	try {
		rawOutput = await provider.generate(prompt);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		logger.warn("pipeline", "Extraction LLM call failed", { error: msg });
		return { facts: [], entities: [], warnings: [`LLM error: ${msg}`] };
	}

	const jsonStr = stripFences(rawOutput);

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		logger.warn("pipeline", "Failed to parse extraction JSON", {
			preview: jsonStr.slice(0, 200),
		});
		return {
			facts: [],
			entities: [],
			warnings: ["Failed to parse LLM output as JSON"],
		};
	}

	if (typeof parsed !== "object" || parsed === null) {
		return {
			facts: [],
			entities: [],
			warnings: ["LLM output is not an object"],
		};
	}

	const obj = parsed as Record<string, unknown>;

	// Validate facts
	const rawFacts = Array.isArray(obj.facts) ? obj.facts : [];
	const facts: ExtractedFact[] = [];
	for (const raw of rawFacts.slice(0, MAX_FACTS)) {
		const fact = validateFact(raw, warnings);
		if (fact) facts.push(fact);
	}
	if (rawFacts.length > MAX_FACTS) {
		warnings.push(`Truncated facts from ${rawFacts.length} to ${MAX_FACTS}`);
	}

	// Validate entities
	const rawEntities = Array.isArray(obj.entities) ? obj.entities : [];
	const entities: ExtractedEntity[] = [];
	for (const raw of rawEntities.slice(0, MAX_ENTITIES)) {
		const entity = validateEntity(raw, warnings);
		if (entity) entities.push(entity);
	}
	if (rawEntities.length > MAX_ENTITIES) {
		warnings.push(
			`Truncated entities from ${rawEntities.length} to ${MAX_ENTITIES}`,
		);
	}

	logger.debug("pipeline", "Extraction complete", {
		factCount: facts.length,
		entityCount: entities.length,
		warningCount: warnings.length,
	});

	return { facts, entities, warnings };
}
