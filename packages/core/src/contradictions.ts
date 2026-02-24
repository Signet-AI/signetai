/**
 * Contradiction Detection Module
 *
 * LLM-based semantic contradiction detection between memories.
 * Distinguishes between:
 *   - "information changed" → keep_both (both valid in different time contexts)
 *   - "directly contradicts" → update (new supersedes old)
 *   - "unreliable new info" → ignore_new (old is more trustworthy)
 *
 * Uses Ollama HTTP API for LLM calls (same pattern as extractor.ts).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContradictionResolution = "update" | "keep_both" | "ignore_new";

export interface ContradictionRecord {
	id: string;
	newMemoryId: string;
	oldMemoryId: string;
	resolution: ContradictionResolution | null;
	reasoning: string;
	resolvedBy: "auto" | "manual";
	createdAt: string;
}

export interface ContradictionCandidate {
	id: string;
	content: string;
	score?: number;
}

export interface DetectionResult {
	contradictionFound: boolean;
	resolution: ContradictionResolution;
	reasoning: string;
	confidence: number;
}

export interface LlmConfig {
	ollamaUrl: string;
	model: string;
	timeoutMs: number;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
	ollamaUrl: "http://localhost:11434",
	model: "llama3.2",
	timeoutMs: 60_000,
};

// ---------------------------------------------------------------------------
// Minimal DB interface
// ---------------------------------------------------------------------------

interface Db {
	prepare(sql: string): {
		run(...args: unknown[]): void;
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function rowToContradiction(row: Record<string, unknown>): ContradictionRecord {
	return {
		id: row.id as string,
		newMemoryId: row.new_memory_id as string,
		oldMemoryId: row.old_memory_id as string,
		resolution: (row.resolution as ContradictionResolution | null) ?? null,
		reasoning: (row.reasoning as string) ?? "",
		resolvedBy: (row.resolved_by as "auto" | "manual") ?? "auto",
		createdAt: row.created_at as string,
	};
}

// ---------------------------------------------------------------------------
// Contradiction detection prompt
// ---------------------------------------------------------------------------

function buildContradictionPrompt(
	newContent: string,
	oldContent: string,
): string {
	return `You are a precise semantic contradiction detector. Compare two statements and determine if they contradict each other.

STATEMENT A (newer): "${newContent}"
STATEMENT B (older): "${oldContent}"

Analyze carefully and respond with ONLY a JSON object:

{
  "contradicts": true or false,
  "resolution": "update" | "keep_both" | "ignore_new",
  "reasoning": "brief explanation",
  "confidence": 0.0 to 1.0
}

RESOLUTION GUIDE:
- "update": Statement A directly contradicts Statement B with more recent/accurate information. B should be marked superseded. Example: "API is on port 3000" vs "API is on port 8080" (same context, different values)
- "keep_both": Both statements can be true in different contexts or time periods. This is NOT a contradiction — it's evolving information. Example: "We used Redis in v1" vs "We switched to PostgreSQL in v2"
- "ignore_new": Statement A appears less reliable or is a regression. Rare — use when B is from an authoritative source and A seems like noise or error.

IMPORTANT:
- Two statements about the SAME thing with DIFFERENT values = contradiction (resolution: update or keep_both)
- Two statements about DIFFERENT things = NOT a contradiction (contradicts: false)
- A statement that REFINES or ADDS DETAIL to another = NOT a contradiction
- A preference change = keep_both (preferences evolve)
- A factual correction = update

Return ONLY the JSON. No markdown fences, no explanation outside the JSON.`;
}

// ---------------------------------------------------------------------------
// Ollama API call
// ---------------------------------------------------------------------------

async function callOllama(
	prompt: string,
	config: LlmConfig,
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
					num_predict: 512,
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect whether new content semantically contradicts any of the candidate
 * memories. Returns per-candidate detection results.
 *
 * Calls the LLM once per candidate (sequentially to avoid overwhelming Ollama).
 */
export async function detectContradiction(
	newContent: string,
	candidates: ContradictionCandidate[],
	llmConfig: LlmConfig = DEFAULT_LLM_CONFIG,
): Promise<Array<{ candidate: ContradictionCandidate; result: DetectionResult }>> {
	const results: Array<{
		candidate: ContradictionCandidate;
		result: DetectionResult;
	}> = [];

	for (const candidate of candidates) {
		try {
			const prompt = buildContradictionPrompt(newContent, candidate.content);
			const raw = await callOllama(prompt, llmConfig);

			// Parse JSON from LLM response
			let jsonStr = raw.trim();

			// Strip markdown fences if present
			const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
			if (fenceMatch) {
				jsonStr = fenceMatch[1].trim();
			}

			// Strip <think> blocks if present
			jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

			// Find JSON object
			const jsonStart = jsonStr.indexOf("{");
			const jsonEnd = jsonStr.lastIndexOf("}");
			if (jsonStart >= 0 && jsonEnd > jsonStart) {
				jsonStr = jsonStr.slice(jsonStart, jsonEnd + 1);
			}

			const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

			const contradicts = parsed.contradicts === true;
			const resolution: ContradictionResolution =
				(["update", "keep_both", "ignore_new"].includes(
					parsed.resolution as string,
				)
					? (parsed.resolution as ContradictionResolution)
					: "keep_both");
			const reasoning =
				typeof parsed.reasoning === "string"
					? parsed.reasoning
					: "No reasoning provided";
			const confidence =
				typeof parsed.confidence === "number"
					? Math.max(0, Math.min(1, parsed.confidence))
					: 0.5;

			results.push({
				candidate,
				result: {
					contradictionFound: contradicts,
					resolution,
					reasoning,
					confidence,
				},
			});
		} catch (err) {
			// LLM call failed for this candidate — log and skip (non-fatal).
			// If Ollama is consistently unavailable, contradiction detection
			// silently degrades to "no contradictions detected".
			const errMsg = err instanceof Error ? err.message : String(err);
			console.warn(
				`[contradictions] Ollama call failed for candidate ${candidate.id}: ${errMsg}. ` +
				"Contradiction detection skipped for this pair.",
			);
			results.push({
				candidate,
				result: {
					contradictionFound: false,
					resolution: "keep_both",
					reasoning: `Detection failed — skipped (${errMsg})`,
					confidence: 0,
				},
			});
		}
	}

	return results;
}

/**
 * Resolve a contradiction by updating its resolution and resolved_by fields.
 */
export function resolveContradiction(
	db: Db,
	contradictionId: string,
	resolution: ContradictionResolution,
	reasoning?: string,
): void {
	if (reasoning) {
		db.prepare(`
			UPDATE contradictions
			SET resolution = ?, reasoning = ?, resolved_by = 'manual'
			WHERE id = ?
		`).run(resolution, reasoning, contradictionId);
	} else {
		db.prepare(`
			UPDATE contradictions
			SET resolution = ?, resolved_by = 'manual'
			WHERE id = ?
		`).run(resolution, contradictionId);
	}
}

/**
 * Get all unresolved contradictions (no resolution set).
 */
export function getPendingContradictions(
	db: Db,
	options: { limit?: number } = {},
): ContradictionRecord[] {
	const limit = options.limit ?? 50;

	const rows = db.prepare(`
		SELECT * FROM contradictions
		WHERE resolution IS NULL
		ORDER BY created_at DESC
		LIMIT ?
	`).all(limit) as Array<Record<string, unknown>>;

	return rows.map(rowToContradiction);
}

/**
 * Get all contradictions (resolved and unresolved).
 */
export function getAllContradictions(
	db: Db,
	options: { limit?: number; memoryId?: string } = {},
): ContradictionRecord[] {
	const limit = options.limit ?? 50;

	if (options.memoryId) {
		const rows = db.prepare(`
			SELECT * FROM contradictions
			WHERE new_memory_id = ? OR old_memory_id = ?
			ORDER BY created_at DESC
			LIMIT ?
		`).all(options.memoryId, options.memoryId, limit) as Array<
			Record<string, unknown>
		>;
		return rows.map(rowToContradiction);
	}

	const rows = db.prepare(`
		SELECT * FROM contradictions
		ORDER BY created_at DESC
		LIMIT ?
	`).all(limit) as Array<Record<string, unknown>>;

	return rows.map(rowToContradiction);
}

/**
 * Store a contradiction record in the database.
 * Returns the contradiction ID.
 */
export function storeContradiction(
	db: Db,
	record: {
		newMemoryId: string;
		oldMemoryId: string;
		resolution?: ContradictionResolution | null;
		reasoning?: string;
		resolvedBy?: "auto" | "manual";
	},
): string {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	db.prepare(`
		INSERT INTO contradictions
			(id, new_memory_id, old_memory_id, resolution, reasoning, resolved_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(
		id,
		record.newMemoryId,
		record.oldMemoryId,
		record.resolution ?? null,
		record.reasoning ?? null,
		record.resolvedBy ?? "auto",
		now,
	);

	return id;
}

/**
 * Check a new memory against similar candidates and store any contradictions found.
 * This is the high-level pipeline integration point.
 *
 * @param db - Database handle for storing contradictions
 * @param newMemoryId - ID of the newly stored memory
 * @param newContent - Content of the new memory
 * @param candidates - Similar existing memories to check against (e.g., top 10 by similarity)
 * @param llmConfig - Ollama configuration for LLM calls
 * @returns Array of stored contradiction IDs
 */
export async function checkAndStoreContradictions(
	db: Db,
	newMemoryId: string,
	newContent: string,
	candidates: ContradictionCandidate[],
	llmConfig: LlmConfig = DEFAULT_LLM_CONFIG,
): Promise<string[]> {
	if (candidates.length === 0) return [];

	const detections = await detectContradiction(
		newContent,
		candidates,
		llmConfig,
	);

	const storedIds: string[] = [];

	for (const { candidate, result } of detections) {
		if (result.contradictionFound && result.confidence >= 0.5) {
			const id = storeContradiction(db, {
				newMemoryId,
				oldMemoryId: candidate.id,
				resolution: result.resolution,
				reasoning: result.reasoning,
				resolvedBy: "auto",
			});
			storedIds.push(id);
		}
	}

	return storedIds;
}
