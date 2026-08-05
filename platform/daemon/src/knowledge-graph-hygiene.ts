import { createHash } from "node:crypto";
import { SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES } from "@signet/core";
import type { DbAccessor, ReadDb } from "./db-accessor";
import { classifyEntityQuality, normalizeEntityName } from "./entity-quality";

const GENERIC_ENTITY_NAMES = new Set([
	"a",
	"an",
	"and",
	"are",
	"be",
	"being",
	"but",
	"can",
	"did",
	"do",
	"does",
	"for",
	"from",
	"had",
	"has",
	"have",
	"he",
	"her",
	"him",
	"his",
	"i",
	"in",
	"is",
	"it",
	"its",
	"of",
	"on",
	"or",
	"she",
	"that",
	"the",
	"their",
	"them",
	"they",
	"this",
	"to",
	"was",
	"we",
	"were",
	"with",
	"you",
	"your",
]);

export interface SuspiciousEntity {
	readonly id: string;
	readonly name: string;
	readonly canonicalName: string;
	readonly entityType: string;
	readonly mentions: number;
	readonly reason: string;
}

export interface DuplicateEntityGroup {
	readonly canonicalName: string;
	readonly count: number;
	readonly ids: string[];
	readonly names: string[];
}

export interface AttributeHygieneSummary {
	readonly missingGroupKey: number;
	readonly missingClaimKey: number;
	readonly missingSourceMemory: number;
}

export interface SafeMentionCandidate {
	readonly memoryId: string;
	readonly entityId: string;
	readonly entityName: string;
	readonly mentionText: string;
	readonly snippet: string;
}

export interface KnowledgeHygieneReport {
	readonly agentId: string;
	readonly suspiciousEntities: SuspiciousEntity[];
	readonly duplicateEntities: DuplicateEntityGroup[];
	readonly attributeSummary: AttributeHygieneSummary;
	readonly safeMentionCandidates: SafeMentionCandidate[];
}

export interface DreamingHygieneCandidate {
	readonly subjectRef: string;
	readonly details: Readonly<Record<string, string>>;
	readonly priority: number;
}

const GENERIC_ASPECTS = ["general", "properties", "overview", "profile", "details", "information"] as const;

function normalize(value: string): string {
	return normalizeEntityName(value);
}

const TOPOLOGY_PLACEHOLDERS = SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES.map(() => "?").join(", ");

/** Predicate shared by every hygiene detector: real semantic entities only. */
const SEMANTIC_ENTITY_FRAGMENT = `COALESCE(e.pinned, 0) = 0
	AND NOT (e.entity_type IN (${TOPOLOGY_PLACEHOLDERS}) OR (e.entity_type = 'source' AND e.source_root IS NOT NULL))`;

/**
 * Entities with no active attribute on any active aspect ("husks").
 *
 * The subquery deliberately nests the attribute check INSIDE the aspect
 * lookup: the planner must drive from entity_aspects via (agent_id,
 * entity_id, status) and probe attributes per aspect. A flat
 * `entity_aspects JOIN entity_attributes` under NOT EXISTS lets the planner
 * root the scan in entity_attributes by agent_id alone, making the detector
 * O(entities × agent attributes) — on a large install that blocked the
 * dreaming worker's first check (~5 min after restart) for minutes,
 * wedging the daemon's event loop (Signet-AI/signetai#1094).
 */
export const ZERO_ACTIVE_ATTRIBUTE_ENTITIES_SQL = `
	SELECT e.id, e.name
	FROM entities e
	WHERE e.agent_id = ? AND COALESCE(e.status, 'active') = 'active' AND ${SEMANTIC_ENTITY_FRAGMENT}
	  AND NOT EXISTS (
	    SELECT 1
	    FROM entity_aspects asp
	    WHERE asp.entity_id = e.id AND asp.agent_id = e.agent_id
	      AND COALESCE(asp.status, 'active') = 'active'
	      AND EXISTS (
	        SELECT 1
	        FROM entity_attributes attr
	        WHERE attr.aspect_id = asp.id AND attr.agent_id = asp.agent_id
	          AND attr.status = 'active'
	      )
	  )
	ORDER BY e.updated_at ASC
	LIMIT ?`;

function reasonForEntity(name: string, canonicalName: string, mentions: number, entityType?: string): string | null {
	const quality = classifyEntityQuality(name || canonicalName, entityType);
	if (!quality.ok) return quality.reason ?? "invalid_entity";
	const canonical = normalize(canonicalName || name);
	if (GENERIC_ENTITY_NAMES.has(canonical)) return "generic_word";
	if (mentions === 0) return "zero_mentions";
	return null;
}

function snippet(content: string, match: string): string {
	const index = content.toLowerCase().indexOf(match.toLowerCase());
	if (index < 0) return content.slice(0, 160);
	const start = Math.max(0, index - 60);
	const end = Math.min(content.length, index + match.length + 60);
	const prefix = start > 0 ? "..." : "";
	const suffix = end < content.length ? "..." : "";
	return `${prefix}${content.slice(start, end)}${suffix}`.replace(/\s+/g, " ").trim();
}

function hasMention(content: string, name: string): boolean {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, "iu").test(content);
}

function membershipDigest(ids: readonly string[]): string {
	return createHash("sha256").update(ids.join("\u001f")).digest("hex").slice(0, 16);
}

/**
 * Deterministic, bounded cleanup work for Dreaming. The queue owner turns
 * these into scoped attention rows; this module owns the graph detectors so
 * MCP hygiene reporting and Dreaming do not grow competing classifiers.
 */
export function getDreamingHygieneCandidatesInDb(
	db: ReadDb,
	input: { readonly agentId: string; readonly limit?: number },
): readonly DreamingHygieneCandidate[] {
	const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 100);
	const candidates = new Map<string, DreamingHygieneCandidate>();
	const add = (candidate: DreamingHygieneCandidate): void => {
		const existing = candidates.get(candidate.subjectRef);
		if (!existing || candidate.priority > existing.priority) candidates.set(candidate.subjectRef, candidate);
	};

	const entities = db
		.prepare(
			`SELECT e.id, e.name, e.canonical_name, e.entity_type, e.mentions
			 FROM entities e
			 WHERE e.agent_id = ? AND COALESCE(e.status, 'active') = 'active' AND ${SEMANTIC_ENTITY_FRAGMENT}
			 ORDER BY e.updated_at ASC
			 LIMIT ?`,
		)
		.all(input.agentId, ...SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES, limit * 4) as Array<{
		id: string;
		name: string;
		canonical_name: string | null;
		entity_type: string;
		mentions: number | null;
	}>;
	for (const entity of entities) {
		const reason = reasonForEntity(
			entity.name,
			entity.canonical_name ?? entity.name,
			entity.mentions ?? 0,
			entity.entity_type,
		);
		if (!reason) continue;
		add({
			subjectRef: `entity:${entity.id}`,
			details: { entityId: entity.id, name: entity.name, reason },
			priority: reason === "zero_mentions" ? 70 : 100,
		});
	}

	const zeroAttributeEntities = db
		.prepare(ZERO_ACTIVE_ATTRIBUTE_ENTITIES_SQL)
		.all(input.agentId, ...SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES, limit) as Array<{ id: string; name: string }>;
	for (const entity of zeroAttributeEntities) {
		add({
			subjectRef: `entity:${entity.id}`,
			details: { entityId: entity.id, name: entity.name, reason: "zero_active_attributes" },
			priority: 90,
		});
	}

	const missingClaimKeys = db
		.prepare(
			`SELECT attr.id, attr.aspect_id, asp.entity_id
			 FROM entity_attributes attr
			 JOIN entity_aspects asp ON asp.id = attr.aspect_id AND asp.agent_id = attr.agent_id
			 JOIN entities e ON e.id = asp.entity_id AND e.agent_id = asp.agent_id
			 WHERE attr.agent_id = ? AND attr.status = 'active' AND ${SEMANTIC_ENTITY_FRAGMENT}
			   AND (attr.claim_key IS NULL OR TRIM(attr.claim_key) = '')
			 ORDER BY attr.updated_at ASC
			 LIMIT ?`,
		)
		.all(input.agentId, ...SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES, limit) as Array<{
		id: string;
		aspect_id: string;
		entity_id: string;
	}>;
	for (const attribute of missingClaimKeys) {
		add({
			subjectRef: `attribute:${attribute.id}`,
			details: {
				attributeId: attribute.id,
				aspectId: attribute.aspect_id,
				entityId: attribute.entity_id,
				reason: "missing_claim_key",
			},
			priority: 80,
		});
	}

	const genericAspects = db
		.prepare(
			`SELECT asp.id, asp.entity_id, asp.name
			 FROM entity_aspects asp
			 JOIN entities e ON e.id = asp.entity_id AND e.agent_id = asp.agent_id
			 WHERE asp.agent_id = ? AND COALESCE(asp.status, 'active') = 'active' AND ${SEMANTIC_ENTITY_FRAGMENT}
			   AND LOWER(TRIM(asp.canonical_name)) IN (${GENERIC_ASPECTS.map(() => "?").join(", ")})
			 ORDER BY asp.updated_at ASC
			 LIMIT ?`,
		)
		.all(input.agentId, ...SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES, ...GENERIC_ASPECTS, limit) as Array<{
		id: string;
		entity_id: string;
		name: string;
	}>;
	for (const aspect of genericAspects) {
		add({
			subjectRef: `aspect:${aspect.id}`,
			details: { aspectId: aspect.id, entityId: aspect.entity_id, name: aspect.name, reason: "generic_aspect" },
			priority: 65,
		});
	}

	const duplicateGroups = db
		.prepare(
			`SELECT e.canonical_name, COUNT(*) AS entity_count
			 FROM entities e
			 WHERE e.agent_id = ? AND COALESCE(e.status, 'active') = 'active' AND ${SEMANTIC_ENTITY_FRAGMENT}
			   AND e.canonical_name IS NOT NULL AND TRIM(e.canonical_name) != ''
			 GROUP BY e.canonical_name HAVING COUNT(*) > 1
			 ORDER BY COUNT(*) DESC, e.canonical_name ASC LIMIT ?`,
		)
		.all(input.agentId, ...SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES, limit) as Array<{
		canonical_name: string;
		entity_count: number;
	}>;
	for (const group of duplicateGroups) {
		const memberIds = db
			.prepare(
				`SELECT e.id FROM entities e
				 WHERE e.agent_id = ? AND COALESCE(e.status, 'active') = 'active' AND ${SEMANTIC_ENTITY_FRAGMENT}
				   AND e.canonical_name = ?
				 ORDER BY e.id ASC`,
			)
			.all(input.agentId, ...SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES, group.canonical_name) as Array<{ id: string }>;
		add({
			subjectRef: `duplicate:${group.canonical_name}`,
			details: {
				canonicalName: group.canonical_name,
				count: String(group.entity_count),
				membership: membershipDigest(memberIds.map((entity) => entity.id)),
				reason: "duplicate_canonical_name",
			},
			priority: 75,
		});
	}

	const genericLinks = db
		.prepare(
			`SELECT dep.id, dep.source_entity_id, dep.target_entity_id
			 FROM entity_dependencies dep
			 JOIN entities src ON src.id = dep.source_entity_id AND src.agent_id = dep.agent_id
			 JOIN entities dst ON dst.id = dep.target_entity_id AND dst.agent_id = dep.agent_id
			 WHERE dep.agent_id = ? AND dep.dependency_type = 'related_to'
			   AND COALESCE(dep.status, 'active') = 'active'
			   AND ${SEMANTIC_ENTITY_FRAGMENT.replaceAll("e.", "src.")}
			   AND ${SEMANTIC_ENTITY_FRAGMENT.replaceAll("e.", "dst.")}
			 ORDER BY dep.updated_at ASC LIMIT ?`,
		)
		.all(
			input.agentId,
			...SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES,
			...SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES,
			limit,
		) as Array<{ id: string; source_entity_id: string; target_entity_id: string }>;
	for (const link of genericLinks) {
		add({
			subjectRef: `link:${link.id}`,
			details: {
				linkId: link.id,
				sourceEntityId: link.source_entity_id,
				targetEntityId: link.target_entity_id,
				reason: "generic_related_to",
			},
			priority: 55,
		});
	}

	return [...candidates.values()]
		.sort((a, b) => b.priority - a.priority || a.subjectRef.localeCompare(b.subjectRef))
		.slice(0, limit);
}

export function getKnowledgeHygieneReport(
	accessor: DbAccessor,
	opts: { readonly agentId: string; readonly limit?: number; readonly memoryLimit?: number },
): KnowledgeHygieneReport {
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
	const memoryLimit = Math.min(Math.max(opts.memoryLimit ?? 200, 1), 1000);

	return accessor.withReadDb((db) => {
		const entities = db
			.prepare(
				`SELECT id, name, canonical_name, entity_type, mentions
				 FROM entities
				 WHERE agent_id = ?
				 ORDER BY updated_at DESC
				 LIMIT ?`,
			)
			.all(opts.agentId, Math.max(limit * 4, 100)) as Array<{
			id: string;
			name: string;
			canonical_name: string | null;
			entity_type: string;
			mentions: number | null;
		}>;

		const suspiciousEntities = entities
			.flatMap((entity): SuspiciousEntity[] => {
				const reason = reasonForEntity(
					entity.name,
					entity.canonical_name ?? entity.name,
					entity.mentions ?? 0,
					entity.entity_type,
				);
				return reason
					? [
							{
								id: entity.id,
								name: entity.name,
								canonicalName: entity.canonical_name ?? normalize(entity.name),
								entityType: entity.entity_type,
								mentions: entity.mentions ?? 0,
								reason,
							},
						]
					: [];
			})
			.slice(0, limit);

		const duplicateEntities = (
			db
				.prepare(
					`SELECT canonical_name, COUNT(*) AS count,
					        GROUP_CONCAT(id, char(31)) AS ids,
					        GROUP_CONCAT(name, char(31)) AS names
					 FROM entities
					 WHERE agent_id = ?
					   AND canonical_name IS NOT NULL
					   AND TRIM(canonical_name) != ''
					 GROUP BY canonical_name
					 HAVING COUNT(*) > 1
					 ORDER BY count DESC, canonical_name ASC
					 LIMIT ?`,
				)
				.all(opts.agentId, limit) as Array<{
				canonical_name: string;
				count: number;
				ids: string | null;
				names: string | null;
			}>
		).map((row) => ({
			canonicalName: row.canonical_name,
			count: row.count,
			ids: row.ids?.split("\u001f") ?? [],
			names: row.names?.split("\u001f") ?? [],
		}));

		const attributeSummary = db
			.prepare(
				`SELECT
				   SUM(CASE WHEN group_key IS NULL OR TRIM(group_key) = '' THEN 1 ELSE 0 END) AS missingGroupKey,
				   SUM(CASE WHEN claim_key IS NULL OR TRIM(claim_key) = '' THEN 1 ELSE 0 END) AS missingClaimKey,
				   SUM(CASE WHEN memory_id IS NULL
				             OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = entity_attributes.memory_id)
				            THEN 1 ELSE 0 END) AS missingSourceMemory
				 FROM entity_attributes
				 WHERE agent_id = ?
				   AND status = 'active'`,
			)
			.get(opts.agentId) as {
			missingGroupKey: number | null;
			missingClaimKey: number | null;
			missingSourceMemory: number | null;
		};

		const memories = db
			.prepare(
				`SELECT id, content
				 FROM memories
				 WHERE agent_id = ?
				   AND is_deleted = 0
				 ORDER BY created_at DESC
				 LIMIT ?`,
			)
			.all(opts.agentId, memoryLimit) as Array<{ id: string; content: string }>;

		const safeMentionCandidates: SafeMentionCandidate[] = [];
		const knownEntities = entities.filter(
			(entity) => !reasonForEntity(entity.name, entity.canonical_name ?? entity.name, 1, entity.entity_type),
		);
		for (const memory of memories) {
			if (safeMentionCandidates.length >= limit) break;
			for (const entity of knownEntities) {
				if (safeMentionCandidates.length >= limit) break;
				if (!hasMention(memory.content, entity.name)) continue;
				const existing = db
					.prepare(
						`SELECT 1 FROM memory_entity_mentions
						 WHERE memory_id = ? AND entity_id = ?
						 LIMIT 1`,
					)
					.get(memory.id, entity.id) as unknown | undefined;
				if (existing) continue;
				safeMentionCandidates.push({
					memoryId: memory.id,
					entityId: entity.id,
					entityName: entity.name,
					mentionText: entity.name,
					snippet: snippet(memory.content, entity.name),
				});
			}
		}

		return {
			agentId: opts.agentId,
			suspiciousEntities,
			duplicateEntities,
			attributeSummary: {
				missingGroupKey: attributeSummary.missingGroupKey ?? 0,
				missingClaimKey: attributeSummary.missingClaimKey ?? 0,
				missingSourceMemory: attributeSummary.missingSourceMemory ?? 0,
			},
			safeMentionCandidates,
		};
	});
}
