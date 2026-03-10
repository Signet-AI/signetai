/**
 * Three-level extraction escalation for the LCM foundation.
 *
 * Level 1: Accept extraction as-is (within thresholds).
 * Level 2: Re-extract with a stricter prompt that focuses on
 *          decisions, constraints, and persistent facts only.
 * Level 3: Deterministic filter — keep only genuinely new items
 *          (no existing content_hash match) and constraint-bearing
 *          content. Discard the rest.
 */

import type {
	ExtractedEntity,
	ExtractedFact,
	ExtractionResult,
	LlmProvider,
	PipelineEscalationConfig,
} from "@signet/core";
import { normalizeAndHashContent } from "../content-normalization";
import type { DbAccessor } from "../db-accessor";
import { logger } from "../logger";
import { parseRawExtractionOutput } from "./extraction";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Level returned by checkEscalationNeeded (1 or 2). Level 3 is
 *  applied by the orchestrator when Level 2 output still exceeds. */
export type EscalationLevel = 1 | 2 | 3;

export interface EscalatedExtraction {
	readonly result: ExtractionResult;
	readonly level: EscalationLevel;
	readonly originalEntityCount: number;
	readonly originalFactCount: number;
}

// ---------------------------------------------------------------------------
// Level 1: threshold check
// ---------------------------------------------------------------------------

export function checkEscalationNeeded(
	extraction: ExtractionResult,
	thresholds: PipelineEscalationConfig,
): EscalationLevel {
	if (extraction.entities.length > thresholds.maxNewEntitiesPerChunk) {
		return 2;
	}

	// Count facts that mention each entity name to detect overly
	// chatty extraction for a single entity.
	const entityNames = new Set<string>();
	for (const entity of extraction.entities) {
		entityNames.add(entity.source.toLowerCase());
		entityNames.add(entity.target.toLowerCase());
	}
	if (entityNames.size > 0) {
		const factsPerEntity = new Map<string, number>();
		for (const fact of extraction.facts) {
			const lower = fact.content.toLowerCase();
			for (const name of entityNames) {
				if (lower.includes(name)) {
					factsPerEntity.set(name, (factsPerEntity.get(name) ?? 0) + 1);
				}
			}
		}
		for (const count of factsPerEntity.values()) {
			if (count > thresholds.maxNewAttributesPerEntity) {
				return 2;
			}
		}
	}

	return 1;
}

// ---------------------------------------------------------------------------
// Level 2: stricter re-extraction prompt
// ---------------------------------------------------------------------------

const MAX_INPUT_CHARS = 12000;

export function buildLevel2Prompt(content: string, maxEntities = 5): string {
	const truncated = content.length > MAX_INPUT_CHARS ? `${content.slice(0, MAX_INPUT_CHARS)}\n[truncated]` : content;

	return `Extract only decisions, constraints, and persistent facts from this text.
Ignore transient states, error messages, and conversational scaffolding.
Maximum ${maxEntities} new entities per chunk.

Return JSON with two arrays: "facts" and "entities".

Each fact: {"content": "...", "type": "fact|preference|decision|rationale|procedural|semantic", "confidence": 0.0-1.0}
Each entity: {"source": "...", "source_type": "person|project|system|tool|concept|skill|task|unknown", "relationship": "...", "target": "...", "target_type": "person|project|system|tool|concept|skill|task|unknown", "confidence": 0.0-1.0}

IMPORTANT — Atomic facts:
Each fact must be fully understandable WITHOUT the original conversation. Include the specific subject and enough context that a reader seeing only this fact knows exactly what it refers to.

Only extract durable, reusable knowledge. Skip ephemeral details.
Return ONLY the JSON object, no other text.

Text:
${truncated}`;
}

async function runLevel2Extraction(
	content: string,
	provider: LlmProvider,
	maxEntities: number,
): Promise<ExtractionResult> {
	const prompt = buildLevel2Prompt(content, maxEntities);
	let rawOutput: string;
	try {
		rawOutput = await provider.generate(prompt);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		logger.warn("pipeline", "Level 2 extraction LLM call failed", {
			error: msg,
		});
		throw new Error(`Level 2 LLM extraction failed: ${msg}`);
	}
	return parseRawExtractionOutput(rawOutput);
}

// ---------------------------------------------------------------------------
// Level 3: deterministic filter against existing content hashes
// ---------------------------------------------------------------------------

/** Keywords that signal constraint-bearing content worth keeping. */
const CONSTRAINT_KEYWORDS = ["constraint", "must", "never", "always"] as const;

function isConstraintContent(fact: ExtractedFact): boolean {
	if (fact.type === "decision") return true;
	const lower = fact.content.toLowerCase();
	return CONSTRAINT_KEYWORDS.some((kw) => lower.includes(kw));
}

export function applyLevel3Filter(
	extraction: ExtractionResult,
	accessor: DbAccessor,
	agentId: string,
): ExtractionResult {
	if (extraction.facts.length === 0 && extraction.entities.length === 0) {
		return extraction;
	}

	// Hash all fact content and check which already exist in the db
	const hashes: string[] = [];
	for (let i = 0; i < extraction.facts.length; i++) {
		const normalized = normalizeAndHashContent(extraction.facts[i].content);
		hashes.push(normalized.contentHash);
	}

	// Query existing content hashes in batches
	const existingHashes = new Set<string>();
	if (hashes.length > 0) {
		accessor.withReadDb((db) => {
			// SQLite has a limit on the number of host parameters; batch
			// in groups of 500 to stay well under the 32766 limit.
			const BATCH = 500;
			for (let start = 0; start < hashes.length; start += BATCH) {
				const batch = hashes.slice(start, start + BATCH);
				const placeholders = batch.map(() => "?").join(",");
				const rows = db
					.prepare(`SELECT content_hash FROM memories WHERE content_hash IN (${placeholders}) AND agent_id = ?`)
					.all(...batch, agentId) as ReadonlyArray<{ content_hash: string }>;
				for (const row of rows) {
					existingHashes.add(row.content_hash);
				}
			}
		});
	}

	// Keep facts that are genuinely new OR are constraint-bearing.
	// Also deduplicate within this pass so Level 2 duplicate emissions
	// don't both survive when their hash is new to the DB.
	const keptFacts: ExtractedFact[] = [];
	const keptFactIndices = new Set<number>();
	const seenHashes = new Set<string>();
	for (let i = 0; i < extraction.facts.length; i++) {
		const fact = extraction.facts[i];
		const hash = hashes[i];
		const isNew = !existingHashes.has(hash) && !seenHashes.has(hash);
		if (isNew || isConstraintContent(fact)) {
			keptFacts.push(fact);
			keptFactIndices.add(i);
			seenHashes.add(hash);
		}
	}

	// Keep entities whose source or target appears in a kept fact
	const keptFactContentLower = new Set(keptFacts.map((f) => f.content.toLowerCase()));
	const keptEntities: ExtractedEntity[] = [];
	for (const entity of extraction.entities) {
		// Keep entity if any kept fact mentions its source or target
		const sourceLower = entity.source.toLowerCase();
		const targetLower = entity.target.toLowerCase();
		let relevant = false;
		for (const fc of keptFactContentLower) {
			if (fc.includes(sourceLower) || fc.includes(targetLower)) {
				relevant = true;
				break;
			}
		}
		if (relevant) {
			keptEntities.push(entity);
		}
	}

	const discardedFacts = extraction.facts.length - keptFacts.length;
	const discardedEntities = extraction.entities.length - keptEntities.length;
	const warnings = [...extraction.warnings];
	if (discardedFacts > 0 || discardedEntities > 0) {
		warnings.push(`Level 3 filter discarded ${discardedFacts} facts and ${discardedEntities} entities`);
	}

	return { facts: keptFacts, entities: keptEntities, warnings };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function escalate(
	content: string,
	extraction: ExtractionResult,
	provider: LlmProvider,
	accessor: DbAccessor,
	agentId: string,
	thresholds: PipelineEscalationConfig,
): Promise<EscalatedExtraction> {
	const originalEntityCount = extraction.entities.length;
	const originalFactCount = extraction.facts.length;

	// Level 1: check if extraction is within bounds
	const needed = checkEscalationNeeded(extraction, thresholds);
	if (needed === 1) {
		return { result: extraction, level: 1, originalEntityCount, originalFactCount };
	}

	// Level 2: re-extract with stricter prompt
	logger.info("pipeline", "Escalating to Level 2 extraction", {
		originalEntities: originalEntityCount,
		originalFacts: originalFactCount,
		threshold: thresholds.maxNewEntitiesPerChunk,
	});

	const level2 = await runLevel2Extraction(content, provider, thresholds.level2MaxEntities);
	const level2Needed = checkEscalationNeeded(level2, thresholds);
	if (level2Needed === 1) {
		return { result: level2, level: 2, originalEntityCount, originalFactCount };
	}

	// Level 3: deterministic filter
	logger.info("pipeline", "Escalating to Level 3 filter", {
		level2Entities: level2.entities.length,
		level2Facts: level2.facts.length,
	});

	const level3 = applyLevel3Filter(level2, accessor, agentId);
	return { result: level3, level: 3, originalEntityCount, originalFactCount };
}
