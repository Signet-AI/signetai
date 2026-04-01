/**
 * Fact and entity extraction from memory content.
 *
 * Contract-first with strict validation — rejects malformed output
 * gracefully, returning partial results with warnings.
 */

import {
	type ExtractedEntity,
	type ExtractedFact,
	type ExtractionResult,
	MEMORY_TYPES,
	type MemoryType,
} from "@signet/core";
import { logger } from "../logger";
import type { LlmProvider } from "./provider";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_FACTS = 20;
const MAX_ENTITIES = 15;
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

Each fact: {"content": "...", "type": "fact|preference|decision|rationale|procedural|semantic", "confidence": 0.0-1.0}
Each entity: {"source": "...", "source_type": "person|project|system|tool|concept|skill|task|unknown", "relationship": "...", "target": "...", "target_type": "person|project|system|tool|concept|skill|task|unknown", "confidence": 0.0-1.0}

IMPORTANT — Atomic facts:
Each fact must be fully understandable WITHOUT the original conversation. Include the specific subject (package name, file path, component, tool) and enough context that a reader seeing only this fact knows exactly what it refers to.

BAD: "install() writes bundled plugin"
GOOD: "The @signet/connector-opencode install() function writes pre-bundled signet.mjs to ~/.config/opencode/plugins/"

BAD: "Uses PostgreSQL instead of MongoDB"
GOOD: "The auth service uses PostgreSQL instead of MongoDB for better relational query support"

Types: fact (objective info), preference (user likes/dislikes), decision (choices made), rationale (WHY a decision was made — reasoning, alternatives considered, tradeoffs), procedural (how-to knowledge), semantic (concepts/definitions).

When you see a decision with reasoning, extract BOTH a decision fact AND a rationale fact. The rationale should capture the WHY, including alternatives considered and tradeoffs.

Examples:

Input: "User prefers dark mode and uses vim keybindings in VS Code"
Output:
{"facts": [
  {"content": "User prefers dark mode for all editor and terminal interfaces", "type": "preference", "confidence": 0.9},
  {"content": "User uses vim keybindings in VS Code as their primary editing mode", "type": "preference", "confidence": 0.9}
], "entities": [
  {"source": "User", "source_type": "person", "relationship": "prefers", "target": "dark mode", "target_type": "concept", "confidence": 0.9},
  {"source": "User", "source_type": "person", "relationship": "uses", "target": "vim keybindings", "target_type": "tool", "confidence": 0.9}
]}

Input: "Decided to use PostgreSQL instead of MongoDB for the auth service because relational queries suit the access-control schema better and we need ACID transactions"
Output:
{"facts": [
  {"content": "The auth service uses PostgreSQL instead of MongoDB for its database", "type": "decision", "confidence": 0.85},
  {"content": "PostgreSQL was chosen over MongoDB for the auth service because: (1) relational queries suit the access-control schema, (2) ACID transactions needed for auth state changes. MongoDB was rejected due to lack of native join support.", "type": "rationale", "confidence": 0.85}
], "entities": [
  {"source": "auth service", "source_type": "system", "relationship": "uses", "target": "PostgreSQL", "target_type": "tool", "confidence": 0.85},
  {"source": "auth service", "source_type": "system", "relationship": "rejected", "target": "MongoDB", "target_type": "tool", "confidence": 0.8}
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
const TRAILING_COMMA_RE = /,\s*([}\]])/g;

export function stripFences(raw: string): string {
	// Strip <think> blocks from models that use chain-of-thought (qwen3, etc.)
	const stripped = raw.replace(THINK_RE, "");
	const match = stripped.match(FENCE_RE);
	if (match) return match[1].trim();

	// Fallback: extract balanced JSON array from verbose output
	// (handles "explanation then JSON" pattern common with qwen3)
	const arr = extractBalancedJsonArray(stripped);
	if (arr) return arr;

	// Strip leading non-JSON text before the first '{'.
	// Handles models (Copilot, GPT) that prefix JSON with explanatory prose.
	const trimmed = stripped.trim();
	const brace = trimmed.indexOf("{");
	if (brace > 0) {
		return trimmed.slice(brace);
	}

	return trimmed;
}

export function tryParseJson(candidate: string): unknown | null {
	const trimmed = candidate.trim();
	if (!trimmed) return null;

	const attempts = [trimmed, trimmed.replace(TRAILING_COMMA_RE, "$1")];
	for (const attempt of attempts) {
		try {
			const parsed = JSON.parse(attempt);
			if (typeof parsed === "string") {
				try {
					return JSON.parse(parsed);
				} catch {
					return parsed;
				}
			}
			return parsed;
		} catch {
			// try next candidate
		}
	}

	return null;
}

export function extractBalancedJsonObjects(raw: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let inString = false;
	let escaping = false;
	let start = -1;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];

		if (inString) {
			if (escaping) {
				escaping = false;
				continue;
			}
			if (ch === "\\") {
				escaping = true;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}

		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		}
		if (ch === "}") {
			depth--;
			if (depth === 0 && start >= 0) {
				out.push(raw.slice(start, i + 1));
				start = -1;
			}
		}
	}

	return out;
}

export function extractBalancedJsonObject(raw: string): string | null {
	const list = extractBalancedJsonObjects(raw);
	return list.length > 0 ? list[0] : null;
}

/**
 * Find the last top-level JSON array in a string. Scans forward with
 * string-awareness, recording every depth-0 '[' position, then extracts
 * the balanced array starting from the last one. This handles both:
 * - brackets in explanation text before JSON: "options: [a,b] ... [{...}]"
 * - brackets inside JSON strings: [{"reason":"uses [auth]"}]
 */
export function extractBalancedJsonArray(raw: string): string | null {
	// Pass 1: find the last top-level '[' (not inside a quoted string)
	let last = -1;
	let depth = 0;
	let inString = false;
	let escaping = false;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];

		if (inString) {
			if (escaping) {
				escaping = false;
				continue;
			}
			if (ch === "\\") {
				escaping = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "[") {
			if (depth === 0) last = i;
			depth++;
		}
		if (ch === "]") depth--;
	}

	if (last < 0) return null;

	// Pass 2: extract balanced array from the last top-level '['
	depth = 0;
	inString = false;
	escaping = false;

	for (let i = last; i < raw.length; i++) {
		const ch = raw[i];

		if (inString) {
			if (escaping) {
				escaping = false;
				continue;
			}
			if (ch === "\\") {
				escaping = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "[") depth++;
		if (ch === "]") {
			depth--;
			if (depth === 0) return raw.slice(last, i + 1);
		}
	}

	return null;
}

function parseExtractionOutput(rawOutput: string): unknown | null {
	const stripped = stripFences(rawOutput);

	// Try the most complete candidate first: a balanced JSON object
	// extracted from the raw output. This handles bare JSON without
	// code fences, where stripFences may incorrectly extract a nested
	// array (e.g. entities:[]) instead of the full object.
	const rawObject = extractBalancedJsonObject(rawOutput);
	if (rawObject) {
		const parsed = tryParseJson(rawObject);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed;
		}
	}

	// Fall back to stripped output (handles code-fenced responses)
	const candidates: string[] = [stripped];

	const strippedObject = extractBalancedJsonObject(stripped);
	if (strippedObject && strippedObject !== stripped) {
		candidates.push(strippedObject);
	}

	for (const candidate of candidates) {
		const parsed = tryParseJson(candidate);
		if (parsed !== null) return parsed;
	}

	return null;
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
	const type: MemoryType = VALID_TYPES.has(typeStr) ? (typeStr as MemoryType) : "fact";
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

function validateEntity(raw: unknown, warnings: string[]): ExtractedEntity | null {
	if (typeof raw !== "object" || raw === null) {
		warnings.push("Entity is not an object");
		return null;
	}

	const obj = raw as Record<string, unknown>;

	const source = typeof obj.source === "string" ? obj.source.trim() : "";
	const relationship = typeof obj.relationship === "string" ? obj.relationship.trim() : "";
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

	const sourceType = typeof obj.source_type === "string" ? obj.source_type.trim() : undefined;
	const targetType = typeof obj.target_type === "string" ? obj.target_type.trim() : undefined;

	return {
		source,
		sourceType: sourceType || undefined,
		relationship,
		target,
		targetType: targetType || undefined,
		confidence,
	};
}

// ---------------------------------------------------------------------------
// Shared output parser — used by extractFactsAndEntities and escalation
// ---------------------------------------------------------------------------

/**
 * Parse raw LLM output into a validated ExtractionResult.
 * Re-uses the same JSON recovery and validation logic as the main
 * extraction path so Level 2 escalation produces identical structure.
 */
export function parseRawExtractionOutput(rawOutput: string): ExtractionResult {
	const warnings: string[] = [];

	const parsed = parseExtractionOutput(rawOutput);
	if (parsed === null) {
		const jsonStr = stripFences(rawOutput);
		logger.warn("pipeline", "Failed to parse extraction JSON", {
			preview: jsonStr.slice(0, 500),
			length: rawOutput.length,
		});
		return { facts: [], entities: [], warnings: ["Failed to parse LLM output as JSON"] };
	}

	if (typeof parsed !== "object" || parsed === null) {
		return { facts: [], entities: [], warnings: ["LLM output is not an object"] };
	}

	const obj = parsed as Record<string, unknown>;

	const rawFacts = Array.isArray(obj.facts) ? obj.facts : [];
	const facts: ExtractedFact[] = [];
	for (const raw of rawFacts.slice(0, MAX_FACTS)) {
		const fact = validateFact(raw, warnings);
		if (fact) facts.push(fact);
	}
	if (rawFacts.length > MAX_FACTS) {
		warnings.push(`Truncated facts from ${rawFacts.length} to ${MAX_FACTS}`);
	}

	const rawEntities = Array.isArray(obj.entities) ? obj.entities : [];
	const entities: ExtractedEntity[] = [];
	for (const raw of rawEntities.slice(0, MAX_ENTITIES)) {
		const entity = validateEntity(raw, warnings);
		if (entity) entities.push(entity);
	}
	if (rawEntities.length > MAX_ENTITIES) {
		warnings.push(`Truncated entities from ${rawEntities.length} to ${MAX_ENTITIES}`);
	}

	return { facts, entities, warnings };
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

export async function extractFactsAndEntities(
	input: string,
	provider: LlmProvider,
	opts?: { timeoutMs?: number; maxTokens?: number },
): Promise<ExtractionResult> {
	const trimmed = input.trim().replace(/\s+/g, " ");
	if (trimmed.length < 20) {
		return {
			facts: [],
			entities: [],
			warnings: ["Input too short (< 20 chars)"],
		};
	}

	const truncated = trimmed.length > MAX_INPUT_CHARS ? `${trimmed.slice(0, MAX_INPUT_CHARS)}\n[truncated]` : trimmed;

	const prompt = buildExtractionPrompt(truncated);

	let rawOutput: string;
	try {
		rawOutput = await provider.generate(prompt, {
			timeoutMs: opts?.timeoutMs,
			maxTokens: opts?.maxTokens,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		logger.warn("pipeline", "Extraction LLM call failed", { error: msg });
		throw new Error(`LLM extraction failed: ${msg}`);
	}

	const result = parseRawExtractionOutput(rawOutput);

	logger.debug("pipeline", "Extraction complete", {
		factCount: result.facts.length,
		entityCount: result.entities.length,
		warningCount: result.warnings.length,
	});

	return result;
}
