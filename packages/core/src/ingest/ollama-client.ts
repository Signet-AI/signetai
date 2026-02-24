/**
 * Shared Ollama LLM client for extraction pipeline.
 *
 * Consolidates the callOllama / parseExtractionResponse logic that was
 * previously duplicated across extractor.ts, chat-extractor.ts, and
 * entire-extractor.ts. Each extractor passes config-specific options
 * (validTypes, typeMap, defaultType) to the shared parser.
 */

import type { ExtractedItem, ExtractedRelation } from "./types";

// ---------------------------------------------------------------------------
// Configuration interface shared by all extractors
// ---------------------------------------------------------------------------

export interface OllamaClientConfig {
	/** Ollama base URL */
	readonly ollamaUrl: string;
	/** Model to use */
	readonly model: string;
	/** Request timeout in ms */
	readonly timeoutMs: number;
}

export interface ParseOptions {
	/** Minimum confidence to keep an extracted item */
	readonly minConfidence: number;
	/** Set of valid type strings */
	readonly validTypes: ReadonlySet<string>;
	/** Map of alternative type names → canonical type names */
	readonly typeMap: Readonly<Record<string, string>>;
	/** Default type when none matches */
	readonly defaultType: string;
	/** Minimum content length to keep an item (0 = no minimum) */
	readonly minContentLength?: number;
}

// ---------------------------------------------------------------------------
// Ollama API call
// ---------------------------------------------------------------------------

/**
 * Call the Ollama generate API with timeout and abort handling.
 */
export async function callOllama(
	prompt: string,
	config: OllamaClientConfig,
): Promise<string> {
	const url = `${config.ollamaUrl}/api/generate`;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: config.model,
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
			throw new Error(`Ollama returned ${res.status}: ${body.slice(0, 200)}`);
		}

		const data = (await res.json()) as { response: string };
		return data.response;
	} finally {
		clearTimeout(timeout);
	}
}

// ---------------------------------------------------------------------------
// Parse LLM response into structured extraction
// ---------------------------------------------------------------------------

/**
 * Parse an LLM response string into structured items and relations.
 *
 * Handles:
 * - Markdown code fences around JSON
 * - <think> reasoning blocks (some models emit these)
 * - Trailing comma repair
 * - Flexible key names ("items" / "facts", "relations" / "entities")
 * - Type normalization via validTypes + typeMap
 * - Confidence clamping and filtering
 */
export function parseExtractionResponse(
	raw: string,
	options: ParseOptions,
): {
	items: ExtractedItem[];
	relations: ExtractedRelation[];
	warnings: string[];
} {
	const warnings: string[] = [];

	let jsonStr = raw.trim();

	// Strip markdown code fences if present
	const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenceMatch) {
		jsonStr = fenceMatch[1].trim();
	}

	// Strip <think> blocks (some models include reasoning)
	jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>\s*/g, "");

	// Find the JSON object — scan for balanced braces
	jsonStr = extractJsonObject(jsonStr);

	if (!jsonStr) {
		warnings.push(`Failed to find JSON object in LLM response: ${raw.slice(0, 100)}...`);
		return { items: [], relations: [], warnings };
	}

	let parsed: {
		items?: unknown[];
		facts?: unknown[];
		relations?: unknown[];
		entities?: unknown[];
	};

	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		// Try to repair common JSON issues
		try {
			const cleaned = jsonStr
				.replace(/,\s*([}\]])/g, "$1")
				.replace(/\n/g, " ");
			parsed = JSON.parse(cleaned);
		} catch {
			warnings.push(`Failed to parse LLM response as JSON: ${raw.slice(0, 100)}...`);
			return { items: [], relations: [], warnings };
		}
	}

	// Normalize — handle both "items" and "facts" keys
	const rawItems = Array.isArray(parsed.items)
		? parsed.items
		: Array.isArray(parsed.facts)
			? parsed.facts
			: [];

	const rawRelations = Array.isArray(parsed.relations)
		? parsed.relations
		: Array.isArray(parsed.entities)
			? parsed.entities
			: [];

	const minContentLength = options.minContentLength ?? 0;

	// Validate and filter items
	const items: ExtractedItem[] = [];
	for (const item of rawItems) {
		if (typeof item !== "object" || item === null) continue;
		const obj = item as Record<string, unknown>;

		if (typeof obj.content !== "string" || obj.content.trim().length === 0) {
			warnings.push("Skipped item with missing/empty content");
			continue;
		}

		if (minContentLength > 0 && obj.content.trim().length < minContentLength) {
			continue; // Skip trivially short items
		}

		let type = typeof obj.type === "string" ? obj.type.toLowerCase() : options.defaultType;
		if (options.typeMap[type]) type = options.typeMap[type];
		if (!options.validTypes.has(type)) type = options.defaultType;

		const confidence = typeof obj.confidence === "number"
			? Math.max(0, Math.min(1, obj.confidence))
			: 0.7;

		if (confidence < options.minConfidence) continue;

		// Preserve speaker metadata if present (for chat extraction)
		const speaker = typeof obj.speaker === "string" && obj.speaker.trim()
			? obj.speaker.trim()
			: undefined;

		const metadata: Record<string, unknown> = {};
		if (speaker) metadata.speaker = speaker;

		items.push({
			content: obj.content.trim(),
			type,
			confidence,
			...(Object.keys(metadata).length > 0 ? { metadata } : {}),
		});
	}

	// Validate relations
	const relations: ExtractedRelation[] = [];
	for (const rel of rawRelations) {
		if (typeof rel !== "object" || rel === null) continue;
		const obj = rel as Record<string, unknown>;

		if (
			typeof obj.source !== "string" ||
			typeof obj.relationship !== "string" ||
			typeof obj.target !== "string"
		) {
			continue;
		}

		const confidence = typeof obj.confidence === "number"
			? Math.max(0, Math.min(1, obj.confidence))
			: 0.7;

		if (confidence < options.minConfidence) continue;

		relations.push({
			source: obj.source.trim(),
			relationship: obj.relationship.trim(),
			target: obj.target.trim(),
			confidence,
		});
	}

	return { items, relations, warnings };
}

// ---------------------------------------------------------------------------
// Robust JSON extraction — scans for balanced braces
// ---------------------------------------------------------------------------

/**
 * Extract the first valid JSON object from a string by scanning for
 * balanced braces. This handles cases where the LLM output contains
 * text before/after the JSON, or embedded brace characters in strings.
 */
function extractJsonObject(input: string): string | null {
	// Find all { positions and try parsing from each
	let idx = 0;
	while (idx < input.length) {
		const start = input.indexOf("{", idx);
		if (start < 0) break;

		// Try to find balanced end
		let depth = 0;
		let inString = false;
		let escape = false;

		for (let i = start; i < input.length; i++) {
			const ch = input[i];

			if (escape) {
				escape = false;
				continue;
			}

			if (ch === "\\") {
				escape = true;
				continue;
			}

			if (ch === '"') {
				inString = !inString;
				continue;
			}

			if (inString) continue;

			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					const candidate = input.slice(start, i + 1);
					// Quick sanity check: try parsing
					try {
						JSON.parse(candidate);
						return candidate;
					} catch {
						// Not valid — try next { position
						break;
					}
				}
			}
		}

		idx = start + 1;
	}

	// Fallback: original indexOf/lastIndexOf approach
	const jsonStart = input.indexOf("{");
	const jsonEnd = input.lastIndexOf("}");
	if (jsonStart >= 0 && jsonEnd > jsonStart) {
		return input.slice(jsonStart, jsonEnd + 1);
	}

	return null;
}
