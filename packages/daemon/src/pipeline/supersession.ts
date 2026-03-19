/**
 * Retroactive memory supersession.
 *
 * When a new entity attribute is classified into an aspect, check whether
 * it contradicts existing active attributes on the same aspect. If so,
 * mark the older attribute as superseded.
 *
 * Two paths invoke this:
 *  1. Inline pass — after structural_classify populates aspect_id
 *  2. Periodic sweep — maintenance worker scans all entities for stale siblings
 */

import type { DbAccessor } from "../db-accessor";
import type { PipelineV2Config } from "../memory-config";
import type { LlmProvider } from "./provider";
import type { EntityAttribute } from "@signet/core";
import {
	tokenize,
	hasNegation,
	overlapCount,
	hasAntonymConflict,
} from "./antonyms";
import { getAttributesForAspect } from "../knowledge-graph";
import { detectSemanticContradiction } from "./contradiction";
import { insertHistoryEvent } from "../transactions";
import { archiveToCold } from "./retention-worker";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContradictionResult {
	readonly detected: boolean;
	readonly confidence: number;
	readonly reasoning: string;
	readonly method: "heuristic" | "semantic";
}

export interface SupersessionCandidate {
	readonly oldAttribute: EntityAttribute;
	readonly newAttribute: EntityAttribute;
	readonly method: "heuristic" | "semantic";
	readonly confidence: number;
	readonly reasoning: string;
}

export interface SupersessionResult {
	readonly superseded: number;
	readonly skipped: number;
	readonly candidates: readonly SupersessionCandidate[];
}

// ---------------------------------------------------------------------------
// Temporal markers for supersession heuristic
// ---------------------------------------------------------------------------

const TEMPORAL_MARKERS = new Set([
	"now",
	"currently",
	"recently",
	"today",
	"used",
	"formerly",
	"previously",
	"was",
	"were",
	"moved",
	"changed",
	"switched",
	"updated",
	"no longer",
]);

// Verb patterns for value conflict detection
const VALUE_VERBS = new Set([
	"is",
	"are",
	"was",
	"were",
	"lives",
	"works",
	"uses",
	"prefers",
	"has",
	"have",
	"had",
	"runs",
	"moved",
	"located",
	"based",
]);

// ---------------------------------------------------------------------------
// Heuristic contradiction detection (no LLM)
// ---------------------------------------------------------------------------

/**
 * Four-signal heuristic adapted from MSAM's contradiction detection:
 * 1. Negation polarity (existing pattern from worker.ts)
 * 2. Antonym pair conflict (extended pairs from antonyms.ts)
 * 3. Value conflict (same verb, different object)
 * 4. Temporal supersession (creation gap + temporal markers)
 */
export function detectAttributeContradiction(
	newContent: string,
	oldContent: string,
	newCreatedAt?: string,
	oldCreatedAt?: string,
): ContradictionResult {
	const none: ContradictionResult = {
		detected: false,
		confidence: 0,
		reasoning: "",
		method: "heuristic",
	};

	const newTokens = tokenize(newContent);
	const oldTokens = tokenize(oldContent);
	if (newTokens.length === 0 || oldTokens.length === 0) return none;

	const overlap = overlapCount(newTokens, oldTokens);
	if (overlap < 2) return none;

	// Signal 1: Negation polarity
	const newNeg = hasNegation(newTokens);
	const oldNeg = hasNegation(oldTokens);
	if (newNeg !== oldNeg) {
		return {
			detected: true,
			confidence: 0.85,
			reasoning: "negation polarity conflict",
			method: "heuristic",
		};
	}

	// Signal 2: Antonym pair conflict
	if (hasAntonymConflict(new Set(newTokens), new Set(oldTokens))) {
		return {
			detected: true,
			confidence: 0.8,
			reasoning: "antonym pair conflict",
			method: "heuristic",
		};
	}

	// Signal 3: Value conflict — same verb token, different object tokens
	const newVerbs = newTokens.filter((t) => VALUE_VERBS.has(t));
	const oldVerbs = oldTokens.filter((t) => VALUE_VERBS.has(t));
	const sharedVerbs = newVerbs.filter((v) => oldVerbs.includes(v));

	if (sharedVerbs.length > 0) {
		// Extract non-verb, non-overlap tokens as "values"
		const shared = new Set([...sharedVerbs, ...newTokens.filter((t) => oldTokens.includes(t))]);
		const newValues = newTokens.filter((t) => !shared.has(t) && !VALUE_VERBS.has(t));
		const oldValues = oldTokens.filter((t) => !shared.has(t) && !VALUE_VERBS.has(t));

		if (newValues.length > 0 && oldValues.length > 0) {
			const valueOverlap = overlapCount(newValues, oldValues);
			if (valueOverlap === 0) {
				return {
					detected: true,
					confidence: 0.75,
					reasoning: `value conflict: shared verb "${sharedVerbs[0]}" with divergent values`,
					method: "heuristic",
				};
			}
		}
	}

	// Signal 4: Temporal supersession — creation gap + temporal markers
	if (newCreatedAt && oldCreatedAt) {
		const gap = new Date(newCreatedAt).getTime() - new Date(oldCreatedAt).getTime();
		const dayMs = 86_400_000;

		if (gap > dayMs) {
			const newHasTemporal = newTokens.some((t) => TEMPORAL_MARKERS.has(t));
			const oldHasTemporal = oldTokens.some((t) => TEMPORAL_MARKERS.has(t));

			if (newHasTemporal) {
				return {
					detected: true,
					confidence: 0.7,
					reasoning: `temporal supersession: ${Math.round(gap / dayMs)}d gap with temporal markers`,
					method: "heuristic",
				};
			}
		}
	}

	return none;
}

// ---------------------------------------------------------------------------
// Sibling discovery
// ---------------------------------------------------------------------------

/**
 * Find active siblings on the same aspect that may be contradicted by
 * the given attribute. Excludes constraints (never auto-superseded).
 */
export function findSupersedableSiblings(
	accessor: DbAccessor,
	attribute: EntityAttribute,
	agentId: string,
): readonly EntityAttribute[] {
	if (!attribute.aspectId) return [];

	const siblings = getAttributesForAspect(accessor, attribute.aspectId, agentId);
	return siblings.filter(
		(s) => s.id !== attribute.id && s.kind !== "constraint",
	);
}

// ---------------------------------------------------------------------------
// Supersession application
// ---------------------------------------------------------------------------

function now(): string {
	return new Date().toISOString();
}

/**
 * Apply supersession: mark old attribute, write audit, optionally archive.
 */
function applySupersession(
	accessor: DbAccessor,
	candidate: SupersessionCandidate,
	agentId: string,
	shadow: boolean,
): void {
	const event = shadow ? "supersession_proposal" : "attribute_superseded";
	const meta = JSON.stringify({
		old_attribute_id: candidate.oldAttribute.id,
		new_attribute_id: candidate.newAttribute.id,
		aspect_id: candidate.newAttribute.aspectId,
		method: candidate.method,
		confidence: candidate.confidence,
		reasoning: candidate.reasoning,
	});

	// Single transaction: status update + archive + audit record
	accessor.withWriteTx((db) => {
		if (!shadow) {
			const ts = now();
			db.prepare(
				`UPDATE entity_attributes
				 SET status = 'superseded', superseded_by = ?, updated_at = ?
				 WHERE id = ? AND agent_id = ?`,
			).run(candidate.newAttribute.id, ts, candidate.oldAttribute.id, agentId);

			if (candidate.oldAttribute.memoryId) {
				archiveToCold(db, [candidate.oldAttribute.memoryId], "superseded");
			}
		}

		insertHistoryEvent(db, {
			memoryId: candidate.oldAttribute.memoryId ?? candidate.oldAttribute.id,
			event,
			oldContent: candidate.oldAttribute.content,
			newContent: candidate.newAttribute.content,
			changedBy: "pipeline:supersession",
			reason: candidate.reasoning,
			metadata: meta,
			createdAt: now(),
		});
	});

	logger.info("supersession", shadow ? "Proposal recorded" : "Attribute superseded", {
		oldId: candidate.oldAttribute.id,
		newId: candidate.newAttribute.id,
		method: candidate.method,
		confidence: candidate.confidence,
	});
}

// ---------------------------------------------------------------------------
// Inline pass — called after structural_classify
// ---------------------------------------------------------------------------

/**
 * Check newly classified attributes for contradictions with existing
 * siblings on the same aspect. Apply supersession for confirmed conflicts.
 */
export async function checkAndSupersedeForAttributes(
	accessor: DbAccessor,
	attributeIds: readonly string[],
	agentId: string,
	cfg: PipelineV2Config,
	provider?: LlmProvider,
): Promise<SupersessionResult> {
	if (!cfg.structural.supersessionEnabled) {
		return { superseded: 0, skipped: 0, candidates: [] };
	}

	const candidates: SupersessionCandidate[] = [];
	let skipped = 0;

	for (const id of attributeIds) {
		// Fetch the freshly classified attribute
		const attr = accessor.withReadDb((db) => {
			const row = db
				.prepare(
					`SELECT * FROM entity_attributes WHERE id = ? AND agent_id = ?`,
				)
				.get(id, agentId) as Record<string, unknown> | undefined;
			if (!row) return null;
			return {
				id: row.id as string,
				aspectId: row.aspect_id as string,
				agentId: row.agent_id as string,
				memoryId: (row.memory_id as string) ?? null,
				kind: row.kind as "attribute" | "constraint",
				content: row.content as string,
				normalizedContent: row.normalized_content as string,
				confidence: row.confidence as number,
				importance: row.importance as number,
				status: row.status as "active" | "superseded" | "deleted",
				supersededBy: (row.superseded_by as string) ?? null,
				createdAt: row.created_at as string,
				updatedAt: row.updated_at as string,
			} satisfies EntityAttribute;
		});

		if (!attr || !attr.aspectId || attr.status !== "active" || attr.kind === "constraint") {
			skipped++;
			continue;
		}

		const siblings = findSupersedableSiblings(accessor, attr, agentId);

		for (const sibling of siblings) {
			// Fast path: heuristic
			const result = detectAttributeContradiction(
				attr.normalizedContent,
				sibling.normalizedContent,
				attr.createdAt,
				sibling.createdAt,
			);

			if (result.detected && result.confidence >= cfg.structural.supersessionMinConfidence) {
				candidates.push({
					oldAttribute: sibling,
					newAttribute: attr,
					method: result.method,
					confidence: result.confidence,
					reasoning: result.reasoning,
				});
				continue;
			}

			// Slow path: semantic fallback (optional)
			if (
				!result.detected &&
				cfg.structural.supersessionSemanticFallback &&
				cfg.semanticContradictionEnabled &&
				provider
			) {
				const tokens = tokenize(attr.normalizedContent);
				const sibTokens = tokenize(sibling.normalizedContent);
				const overlap = overlapCount(tokens, sibTokens);

				if (overlap >= 3) {
					const semantic = await detectSemanticContradiction(
						attr.content,
						sibling.content,
						provider,
						cfg.semanticContradictionTimeoutMs,
					);

					if (semantic.detected && semantic.confidence >= cfg.structural.supersessionMinConfidence) {
						candidates.push({
							oldAttribute: sibling,
							newAttribute: attr,
							method: "semantic",
							confidence: semantic.confidence,
							reasoning: semantic.reasoning,
						});
					}
				}
			}
		}
	}

	// Apply supersessions
	const shadow = cfg.shadowMode || cfg.mutationsFrozen;
	for (const candidate of candidates) {
		applySupersession(accessor, candidate, agentId, shadow);
	}

	return {
		superseded: shadow ? 0 : candidates.length,
		skipped,
		candidates,
	};
}

// ---------------------------------------------------------------------------
// Periodic sweep — called from maintenance worker
// ---------------------------------------------------------------------------

/**
 * Scan all aspects for active attributes that contradict each other.
 * For each contradicting pair, supersede the older one.
 */
export async function sweepRetroactiveSupersession(
	accessor: DbAccessor,
	agentId: string,
	cfg: PipelineV2Config,
	provider?: LlmProvider,
): Promise<SupersessionResult> {
	if (!cfg.structural.supersessionSweepEnabled) {
		return { superseded: 0, skipped: 0, candidates: [] };
	}

	// Find aspects with multiple active non-constraint attributes
	const aspects = accessor.withReadDb((db) =>
		(
			db
				.prepare(
					`SELECT aspect_id, COUNT(*) as cnt
					 FROM entity_attributes
					 WHERE agent_id = ? AND status = 'active' AND kind = 'attribute'
					   AND aspect_id IS NOT NULL
					 GROUP BY aspect_id
					 HAVING cnt > 1`,
				)
				.all(agentId) as Array<{ aspect_id: string; cnt: number }>
		),
	);

	const candidates: SupersessionCandidate[] = [];
	let skipped = 0;

	for (const { aspect_id: aspectId } of aspects) {
		const attrs = getAttributesForAspect(accessor, aspectId, agentId)
			.filter((a) => a.kind !== "constraint");

		// Compare each pair — newer supersedes older
		for (let i = 0; i < attrs.length; i++) {
			for (let j = i + 1; j < attrs.length; j++) {
				const newer = new Date(attrs[i].createdAt) >= new Date(attrs[j].createdAt) ? attrs[i] : attrs[j];
				const older = newer === attrs[i] ? attrs[j] : attrs[i];

				// Skip if already superseded (could happen within this loop)
				if (older.status !== "active") {
					skipped++;
					continue;
				}

				const result = detectAttributeContradiction(
					newer.normalizedContent,
					older.normalizedContent,
					newer.createdAt,
					older.createdAt,
				);

				if (result.detected && result.confidence >= cfg.structural.supersessionMinConfidence) {
					candidates.push({
						oldAttribute: older,
						newAttribute: newer,
						method: result.method,
						confidence: result.confidence,
						reasoning: result.reasoning,
					});
					continue;
				}

				// Semantic fallback
				if (
					!result.detected &&
					cfg.structural.supersessionSemanticFallback &&
					cfg.semanticContradictionEnabled &&
					provider
				) {
					const tokens = tokenize(newer.normalizedContent);
					const sibTokens = tokenize(older.normalizedContent);
					const overlap = overlapCount(tokens, sibTokens);

					if (overlap >= 3) {
						const semantic = await detectSemanticContradiction(
							newer.content,
							older.content,
							provider,
							cfg.semanticContradictionTimeoutMs,
						);

						if (semantic.detected && semantic.confidence >= cfg.structural.supersessionMinConfidence) {
							candidates.push({
								oldAttribute: older,
								newAttribute: newer,
								method: "semantic",
								confidence: semantic.confidence,
								reasoning: semantic.reasoning,
							});
						}
					}
				}
			}
		}
	}

	const shadow = cfg.shadowMode || cfg.mutationsFrozen;
	for (const candidate of candidates) {
		applySupersession(accessor, candidate, agentId, shadow);
	}

	return {
		superseded: shadow ? 0 : candidates.length,
		skipped,
		candidates,
	};
}
