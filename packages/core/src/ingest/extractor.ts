/**
 * LLM-based knowledge extraction from document chunks.
 *
 * Uses Ollama (or compatible API) to extract structured knowledge:
 * facts, decisions, preferences, procedures, relationships.
 *
 * The extraction prompt is the most critical part of the ingestion engine.
 * It needs to produce genuinely useful, self-contained memories — not noise.
 */

import type { ChunkResult, ExtractionResult, ExtractedItem, ExtractedRelation } from "./types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ExtractorConfig {
	/** Ollama base URL */
	readonly ollamaUrl: string;
	/** Model to use for extraction */
	readonly model: string;
	/** Request timeout in ms */
	readonly timeoutMs: number;
	/** Minimum confidence to keep an extracted item */
	readonly minConfidence: number;
}

export const DEFAULT_EXTRACTOR_CONFIG: ExtractorConfig = {
	ollamaUrl: "http://localhost:11434",
	model: "llama3.2",
	timeoutMs: 120_000,
	minConfidence: 0.5,
};

// ---------------------------------------------------------------------------
// The Extraction Prompt
// ---------------------------------------------------------------------------

function buildExtractionPrompt(
	chunkText: string,
	sourceTitle: string | null,
	sourceSection: string | null,
): string {
	const context: string[] = [];
	if (sourceTitle) context.push(`Document: "${sourceTitle}"`);
	if (sourceSection) context.push(`Section: "${sourceSection}"`);
	const contextBlock = context.length > 0 ? `Context:\n${context.join("\n")}\n\n` : "";

	return `You are a precision knowledge extraction engine. Your job is to distill durable, reusable knowledge from document text into atomic memory items.

${contextBlock}TASK: Extract knowledge items from the text below. Each item must be:

1. SELF-CONTAINED — fully understandable without the original document
2. ATOMIC — one distinct piece of knowledge per item
3. DURABLE — information that stays useful over time (skip ephemeral/obvious content)
4. SPECIFIC — include concrete names, numbers, versions, dates, URLs when present

Return a JSON object with two arrays: "items" and "relations".

ITEM SCHEMA:
{"content": "<self-contained statement>", "type": "<type>", "confidence": <0.0-1.0>}

TYPES (use exactly these strings):
- "fact" — Objective information: specifications, data points, definitions
- "decision" — A choice that was made, with what was chosen
- "rationale" — WHY something was decided — reasoning, tradeoffs, alternatives considered
- "preference" — Expressed opinions, likes/dislikes, style preferences
- "procedural" — How-to knowledge: steps, workflows, commands, processes
- "semantic" — Conceptual explanations, definitions, mental models
- "system" — System/infrastructure config: ports, URLs, env vars, paths, versions

RELATION SCHEMA (for connections between entities):
{"source": "<entity>", "relationship": "<verb phrase>", "target": "<entity>", "confidence": <0.0-1.0>}

QUALITY RULES:
- MERGE related micro-facts into one richer item when possible
- SKIP: generic/obvious statements, greetings, boilerplate, TOC entries, page numbers
- SKIP: anything you'd need context to understand ("this" / "the above" / "as mentioned")
- For decisions, ALWAYS include what was chosen AND what was rejected if mentioned
- For procedures, include the actual commands/steps, not just "there is a process for X"
- Confidence 0.9+ = explicitly stated; 0.7-0.89 = strongly implied; 0.5-0.69 = inferred

EXAMPLES:

Input: "We chose Redis over Memcached because we need pub/sub for real-time notifications."
Output:
{"items": [
  {"content": "Redis was chosen over Memcached for caching because pub/sub is needed for real-time notifications. Memcached lacks native pub/sub.", "type": "decision", "confidence": 0.9}
], "relations": [
  {"source": "caching layer", "relationship": "uses", "target": "Redis", "confidence": 0.9}
]}

Input: "To deploy: run \`npm run build\`, then \`docker compose up -d\`. Check health at localhost:3000/health."
Output:
{"items": [
  {"content": "Deployment procedure: (1) npm run build, (2) docker compose up -d. Health check endpoint: localhost:3000/health", "type": "procedural", "confidence": 0.95}
], "relations": []}

Input: "The API uses port 8080 in development and 443 in production. Rate limit: 100 req/min per key."
Output:
{"items": [
  {"content": "API runs on port 8080 (dev) and port 443 (production)", "type": "system", "confidence": 0.95},
  {"content": "API rate limit is 100 requests per minute per API key", "type": "fact", "confidence": 0.95}
], "relations": []}

Return ONLY valid JSON. No markdown fences, no explanation, no preamble.
If there is nothing worth extracting, return: {"items": [], "relations": []}

TEXT TO EXTRACT FROM:
${chunkText}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract knowledge from a single chunk using an LLM.
 */
export async function extractFromChunk(
	chunk: ChunkResult,
	sourceTitle: string | null,
	config: ExtractorConfig = DEFAULT_EXTRACTOR_CONFIG,
): Promise<ExtractionResult> {
	const prompt = buildExtractionPrompt(
		chunk.text,
		sourceTitle,
		chunk.sourceSection,
	);

	try {
		const response = await callOllama(prompt, config);
		const parsed = parseExtractionResponse(response, config.minConfidence);

		return {
			chunkIndex: chunk.index,
			items: parsed.items,
			relations: parsed.relations,
			warnings: parsed.warnings,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			chunkIndex: chunk.index,
			items: [],
			relations: [],
			warnings: [`Extraction failed for chunk ${chunk.index}: ${msg}`],
		};
	}
}

/**
 * Extract knowledge from all chunks in a document.
 */
export async function extractFromChunks(
	chunks: readonly ChunkResult[],
	sourceTitle: string | null,
	config: ExtractorConfig = DEFAULT_EXTRACTOR_CONFIG,
	onChunkDone?: (chunkIndex: number, itemCount: number) => void,
): Promise<ExtractionResult[]> {
	const results: ExtractionResult[] = [];

	// Process sequentially to avoid overwhelming Ollama
	for (const chunk of chunks) {
		const result = await extractFromChunk(chunk, sourceTitle, config);
		results.push(result);
		if (onChunkDone) {
			onChunkDone(chunk.index, result.items.length);
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Ollama API call
// ---------------------------------------------------------------------------

async function callOllama(
	prompt: string,
	config: ExtractorConfig,
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

function parseExtractionResponse(
	raw: string,
	minConfidence: number,
): {
	items: ExtractedItem[];
	relations: ExtractedRelation[];
	warnings: string[];
} {
	const warnings: string[] = [];

	// Try to find JSON in the response — LLMs sometimes wrap in markdown fences
	let jsonStr = raw.trim();

	// Strip markdown code fences if present
	const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenceMatch) {
		jsonStr = fenceMatch[1].trim();
	}

	// Try to find the JSON object
	const jsonStart = jsonStr.indexOf("{");
	const jsonEnd = jsonStr.lastIndexOf("}");
	if (jsonStart >= 0 && jsonEnd > jsonStart) {
		jsonStr = jsonStr.slice(jsonStart, jsonEnd + 1);
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
			// Remove trailing commas
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

	// Validate and filter items
	const validTypes = new Set([
		"fact", "decision", "rationale", "preference",
		"procedural", "semantic", "system",
		// Allow these additional types gracefully
		"configuration", "architectural", "relationship",
		"episodic", "daily-log",
	]);

	// Map non-standard types to valid MemoryType values
	const typeMap: Record<string, string> = {
		configuration: "system",
		architectural: "decision",
		relationship: "fact",
		commitment: "decision",
	};

	const items: ExtractedItem[] = [];
	for (const item of rawItems) {
		if (typeof item !== "object" || item === null) continue;
		const obj = item as Record<string, unknown>;

		if (typeof obj.content !== "string" || obj.content.trim().length === 0) {
			warnings.push("Skipped item with missing/empty content");
			continue;
		}

		let type = typeof obj.type === "string" ? obj.type.toLowerCase() : "fact";
		if (typeMap[type]) type = typeMap[type];
		if (!validTypes.has(type)) type = "fact";

		const confidence = typeof obj.confidence === "number"
			? Math.max(0, Math.min(1, obj.confidence))
			: 0.7;

		if (confidence < minConfidence) continue;

		items.push({
			content: obj.content.trim(),
			type,
			confidence,
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

		if (confidence < minConfidence) continue;

		relations.push({
			source: obj.source.trim(),
			relationship: obj.relationship.trim(),
			target: obj.target.trim(),
			confidence,
		});
	}

	return { items, relations, warnings };
}
