import { z } from "zod";
import { dbOwnerQuery, DB_OWNER_READ_DEADLINE_MS } from "./db-owner-runtime";
import type { DbOwnerParameter } from "./db-owner-protocol";
import { readScopeSql, type ReadScope } from "./read-scope";
import { createHash } from "node:crypto";
import { attempt, redactCredentials, SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES } from "@signet/core";
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
export interface GraphHygieneCaps {
	readonly maxAspectsPerEntity: number;
	readonly maxAttributesPerAspect: number;
}

const GENERIC_ASPECTS = ["general", "properties", "overview", "profile", "details", "information"] as const;

function normalize(value: string): string {
	return normalizeEntityName(value);
}

const TOPOLOGY_PLACEHOLDERS = SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES.map(() => "?").join(", ");
const SEMANTIC_ENTITY_FRAGMENT = `COALESCE(e.pinned, 0) = 0
	AND NOT (e.entity_type IN (${TOPOLOGY_PLACEHOLDERS}) OR (e.entity_type = 'source' AND e.source_root IS NOT NULL))`;
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
export function getDreamingHygieneCandidatesInDb(
	db: ReadDb,
	input: { readonly agentId: string; readonly limit?: number; readonly caps?: GraphHygieneCaps },
): readonly DreamingHygieneCandidate[] {
	const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 100);
	const caps = input.caps;
	const candidates = new Map<string, DreamingHygieneCandidate>();
	const add = (candidate: DreamingHygieneCandidate): void => {
		const existing = candidates.get(candidate.subjectRef);
		if (!existing || candidate.priority > existing.priority) candidates.set(candidate.subjectRef, candidate);
	};
	if (caps !== undefined) {
		const overCapAspects = db
			.prepare(
				`SELECT asp.id, asp.entity_id, asp.name, COUNT(attr.id) AS attribute_count
				 FROM entity_aspects asp
				 JOIN entities e ON e.id = asp.entity_id AND e.agent_id = asp.agent_id
				 LEFT JOIN entity_attributes attr ON attr.aspect_id = asp.id AND attr.agent_id = asp.agent_id AND attr.status = 'active'
				 WHERE asp.agent_id = ? AND COALESCE(asp.status, 'active') = 'active' AND ${SEMANTIC_ENTITY_FRAGMENT}
				 GROUP BY asp.id, asp.entity_id, asp.name
				 HAVING attribute_count > ?
				 ORDER BY attribute_count DESC
				 LIMIT ?`,
			)
			.all(input.agentId, ...SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES, caps.maxAttributesPerAspect, limit) as Array<{
			id: string;
			entity_id: string;
			name: string;
			attribute_count: number;
		}>;
		for (const aspect of overCapAspects) {
			add({
				subjectRef: `aspect:${aspect.id}`,
				details: {
					aspectId: aspect.id,
					entityId: aspect.entity_id,
					name: aspect.name,
					reason: "attribute_over_cap",
					attributeCount: String(aspect.attribute_count),
					maxAttributesPerAspect: String(caps.maxAttributesPerAspect),
				},
				priority: 100,
			});
		}

		const overCapEntities = db
			.prepare(
				`SELECT e.id, e.name, COUNT(asp.id) AS aspect_count
				 FROM entities e
				 LEFT JOIN entity_aspects asp ON asp.entity_id = e.id AND asp.agent_id = e.agent_id AND COALESCE(asp.status, 'active') = 'active'
				 WHERE e.agent_id = ? AND COALESCE(e.status, 'active') = 'active' AND ${SEMANTIC_ENTITY_FRAGMENT}
				 GROUP BY e.id, e.name
				 HAVING aspect_count > ?
				 ORDER BY aspect_count DESC
				 LIMIT ?`,
			)
			.all(input.agentId, ...SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES, caps.maxAspectsPerEntity, limit) as Array<{
			id: string;
			name: string;
			aspect_count: number;
		}>;
		for (const entity of overCapEntities) {
			add({
				subjectRef: `entity:${entity.id}`,
				details: {
					entityId: entity.id,
					name: entity.name,
					reason: "aspect_over_cap",
					aspectCount: String(entity.aspect_count),
					maxAspectsPerEntity: String(caps.maxAspectsPerEntity),
				},
				priority: 95,
			});
		}
	}

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

export async function getKnowledgeHygieneReport(
	_accessor: DbAccessor,
	opts: { readonly agentId: string; readonly limit?: number; readonly memoryLimit?: number },
	readScope?: ReadScope,
): Promise<KnowledgeHygieneReport> {
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
	const memoryLimit = Math.min(Math.max(opts.memoryLimit ?? 200, 1), 1000);

	return (async (db: KnowledgeReadDb) => {
		const entities = (await db
			.prepare(
				`SELECT id, name, canonical_name, entity_type, mentions
				 FROM entities
				 WHERE agent_id = ?
				 ORDER BY updated_at DESC
				 LIMIT ?`,
			)
			.all(opts.agentId, Math.max(limit * 4, 100))) as Array<{
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
			(await db
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
				.all(opts.agentId, limit)) as Array<{
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

		const attributeSummary = (await db
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
			.get(opts.agentId)) as {
			missingGroupKey: number | null;
			missingClaimKey: number | null;
			missingSourceMemory: number | null;
		};

		const memories = (await db
			.prepare(
				`SELECT id, content
				 FROM memories
				 WHERE agent_id = ?
				   AND is_deleted = 0
				 ORDER BY created_at DESC
				 LIMIT ?`,
			)
			.all(opts.agentId, memoryLimit)) as Array<{ id: string; content: string }>;

		const safeMentionCandidates: SafeMentionCandidate[] = [];
		const knownEntities = entities.filter(
			(entity) => !reasonForEntity(entity.name, entity.canonical_name ?? entity.name, 1, entity.entity_type),
		);
		for (const memory of memories) {
			if (safeMentionCandidates.length >= limit) break;
			for (const entity of knownEntities) {
				if (safeMentionCandidates.length >= limit) break;
				if (!hasMention(memory.content, entity.name)) continue;
				const existing = (await db
					.prepare(
						`SELECT 1 FROM memory_entity_mentions
						 WHERE memory_id = ? AND entity_id = ?
						 LIMIT 1`,
					)
					.get(memory.id, entity.id)) as unknown | undefined;
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
	})(knowledgeReadDb(readScope));
}

export interface KnowledgeReadDb {
	readonly readScope: ReadScope | undefined;
	prepare(sql: string): {
		all(...params: readonly unknown[]): Promise<unknown>;
		get(...params: readonly unknown[]): Promise<unknown>;
	};
}

const KNOWLEDGE_CONTENT_TABLES = [
	"entities",
	"entity_aspects",
	"entity_attributes",
	"entity_dependencies",
	"epistemic_assertions",
	"ontology_proposals",
	"ontology_contradictions",
	"memories",
	"memory_artifacts",
	"session_transcripts",
	"session_summaries",
	"entity_communities",
	"dreaming_passes",
] as const;

function knowledgeScopeForTable(scope: ReadScope, table: string): ReadScope {
	const memory = table === "memories";
	return {
		...scope,
		reach: !memory && scope.reach.kind === "shared" ? { kind: "own", agentId: scope.reach.agentId } : scope.reach,
		projects: ["memories", "memory_artifacts", "session_transcripts", "session_summaries"].includes(table)
			? scope.projects
			: scope.projects === null
				? null
				: [],
	};
}

const KNOWLEDGE_READ_COLUMNS: Readonly<Record<string, readonly string[]>> = {
	entities: [
		"id",
		"name",
		"entity_type",
		"description",
		"created_at",
		"updated_at",
		"canonical_name",
		"mentions",
		"embedding",
		"agent_id",
		"pinned",
		"pinned_at",
		"last_synthesized_at",
		"community_id",
		"source_id",
		"source_kind",
		"source_path",
		"source_root",
		"status",
		"archived_at",
		"archived_by",
		"archive_reason",
		"proposal_id",
		"proposal_evidence",
		"person_user_id",
		"compartment_id",
	],
	entity_aspects: [
		"id",
		"entity_id",
		"agent_id",
		"name",
		"canonical_name",
		"weight",
		"created_at",
		"updated_at",
		"status",
		"archived_at",
		"archived_by",
		"archive_reason",
		"proposal_id",
		"proposal_evidence",
		"compartment_id",
	],
	entity_attributes: [
		"id",
		"aspect_id",
		"agent_id",
		"memory_id",
		"kind",
		"content",
		"normalized_content",
		"confidence",
		"importance",
		"status",
		"superseded_by",
		"created_at",
		"updated_at",
		"claim_key",
		"group_key",
		"source_id",
		"source_kind",
		"source_path",
		"source_root",
		"proposal_id",
		"proposal_evidence",
		"version",
		"version_root_id",
		"previous_attribute_id",
		"archived_at",
		"archived_by",
		"archive_reason",
		"occurred_start",
		"occurred_end",
		"valid_from",
		"valid_until",
		"time_precision",
		"compartment_id",
	],
	entity_dependencies: [
		"id",
		"source_entity_id",
		"target_entity_id",
		"agent_id",
		"aspect_id",
		"dependency_type",
		"strength",
		"created_at",
		"updated_at",
		"reason",
		"confidence",
		"source_id",
		"source_kind",
		"source_path",
		"source_root",
		"proposal_id",
		"proposal_evidence",
		"status",
		"archived_at",
		"archived_by",
		"archive_reason",
		"compartment_id",
	],
	entity_communities: [
		"id",
		"agent_id",
		"name",
		"cohesion",
		"member_count",
		"created_at",
		"updated_at",
		"source_id",
		"source_kind",
		"source_path",
		"source_root",
		"compartment_id",
	],
	epistemic_assertions: [
		"id",
		"agent_id",
		"subject_entity_id",
		"claim_attribute_id",
		"predicate",
		"content",
		"normalized_content",
		"speaker",
		"asserted_at",
		"confidence",
		"evidence",
		"source_kind",
		"source_id",
		"source_path",
		"source_root",
		"status",
		"supersedes_assertion_id",
		"archived_at",
		"archived_by",
		"archive_reason",
		"created_by",
		"created_at",
		"updated_at",
		"compartment_id",
	],
	ontology_proposals: [
		"id",
		"agent_id",
		"operation",
		"status",
		"payload",
		"confidence",
		"rationale",
		"evidence",
		"risk",
		"source_kind",
		"source_id",
		"source_path",
		"source_root",
		"created_by",
		"applied_by",
		"rejected_by",
		"result",
		"created_at",
		"updated_at",
		"applied_at",
		"rejected_at",
		"author_user_id",
		"compartment_id",
	],
	ontology_contradictions: [
		"id",
		"agent_id",
		"entity_id",
		"entity_name",
		"aspect_id",
		"aspect_name",
		"group_key",
		"claim_key",
		"left_attribute_id",
		"right_attribute_id",
		"left_content",
		"right_content",
		"left_confidence",
		"right_confidence",
		"left_scope",
		"right_scope",
		"left_visibility",
		"right_visibility",
		"left_source_kind",
		"left_source_id",
		"left_source_path",
		"left_source_root",
		"right_source_kind",
		"right_source_id",
		"right_source_path",
		"right_source_root",
		"left_evidence",
		"right_evidence",
		"detector",
		"reason",
		"confidence",
		"status",
		"detected_at",
		"resolved_at",
		"resolution_reason",
		"created_at",
		"updated_at",
		"compartment_id",
	],
	daily_reflections: [
		"id",
		"agent_id",
		"date",
		"summary",
		"patterns",
		"question",
		"answer",
		"answer_memory_id",
		"content_key",
		"memory_ids",
		"summary_ids",
		"model",
		"created_at",
		"answered_at",
		"compartment_id",
	],
	dreaming_passes: [
		"id",
		"agent_id",
		"mode",
		"status",
		"started_at",
		"completed_at",
		"tokens_consumed",
		"mutations_applied",
		"mutations_skipped",
		"mutations_failed",
		"summary",
		"error",
		"created_at",
		"evidence_window_json",
		"runbook_json",
		"tokens_input",
		"tokens_output",
		"tokens_cache_read",
		"tokens_cache_write",
		"tokens_cost",
		"head_revision",
		"head_hash",
		"head_added",
		"head_updated",
		"head_removed",
		"head_deferred",
		"head_no_op",
		"head_base_revision",
		"scope_key",
		"tokens_peak_context",
		"policy_hash",
		"policy_source",
		"compartment_id",
	],
	dreaming_tool_calls: [
		"id",
		"agent_id",
		"pass_id",
		"sequence",
		"tool_call_id",
		"tool_name",
		"input_json",
		"output_json",
		"success",
		"latency_ms",
		"created_at",
		"compartment_id",
	],
	dreaming_history_nodes: [
		"agent_id",
		"scope_key",
		"level",
		"idx",
		"pass_id",
		"text",
		"tokens_input",
		"tokens_output",
		"tokens_cache_read",
		"created_at",
		"compartment_id",
	],
	dreaming_evidence_exclusions: [
		"agent_id",
		"source_kind",
		"source_id",
		"reason",
		"pass_id",
		"excluded_at",
		"requeue_requested_at",
		"resolved_at",
		"failure_class",
		"source_fingerprint",
		"retry_count",
		"last_requeued_at",
	],
	dreaming_evidence_reviews: [
		"agent_id",
		"source_kind",
		"source_id",
		"source_captured_at",
		"source_entry_id",
		"source_revision",
		"reason",
		"pass_id",
		"reviewed_at",
	],
	memories: [
		"id",
		"type",
		"category",
		"content",
		"confidence",
		"importance",
		"source_id",
		"source_type",
		"tags",
		"who",
		"why",
		"project",
		"created_at",
		"updated_at",
		"updated_by",
		"last_accessed",
		"access_count",
		"vector_clock",
		"version",
		"manual_override",
		"pinned",
		"content_hash",
		"normalized_content",
		"is_deleted",
		"deleted_at",
		"extraction_status",
		"embedding_model",
		"extraction_model",
		"update_count",
		"idempotency_key",
		"runtime_path",
		"source_path",
		"source_section",
		"scope",
		"agent_id",
		"visibility",
		"superseded_by",
		"superseded_at",
		"superseded_reason",
		"memory_kind",
		"evidence_meta",
		"stale_at",
		"review_after",
		"author_user_id",
		"compartment_id",
	],
	session_transcripts: [
		"session_key",
		"content",
		"harness",
		"project",
		"agent_id",
		"created_at",
		"updated_at",
		"completed_at",
		"content_hash",
		"source_id",
		"source_record_id",
		"source_meta_json",
		"speaker_user_id",
		"compartment_id",
	],
	session_summaries: [
		"id",
		"project",
		"depth",
		"kind",
		"content",
		"token_count",
		"earliest_at",
		"latest_at",
		"session_key",
		"harness",
		"agent_id",
		"created_at",
		"source_type",
		"source_ref",
		"meta_json",
		"author_user_id",
		"compartment_id",
	],
	memory_artifacts: [
		"agent_id",
		"source_path",
		"source_sha256",
		"source_kind",
		"session_id",
		"session_key",
		"session_token",
		"project",
		"harness",
		"captured_at",
		"started_at",
		"ended_at",
		"manifest_path",
		"source_node_id",
		"memory_sentence",
		"memory_sentence_quality",
		"content",
		"updated_at",
		"source_mtime_ms",
		"is_deleted",
		"deleted_at",
		"source_id",
		"source_root",
		"source_external_id",
		"source_parent_path",
		"source_meta_json",
		"author_user_id",
		"compartment_id",
	],
};
function knowledgeTargetSql(table: string, alias: string, scope: ReadScope): { sql: string; args: unknown[] } {
	const columns = KNOWLEDGE_READ_COLUMNS[table] ?? [];
	const own = readScopeSql(alias, knowledgeScopeForTable(scope, table), {
		visibility: table === "memories" ? "visibility" : null,
		memory: table === "memories" ? "id" : null,
		session: columns.includes("session_key") ? "session_key" : null,
		source: columns.includes("source_id") ? "source_id" : null,
	});
	const parent =
		table === "entity_attributes"
			? { table: "entity_aspects", key: "aspect_id" }
			: table === "entity_aspects"
				? { table: "entities", key: "entity_id" }
				: null;
	if (!parent) return own;
	const parentAlias = alias + "_parent";
	const readable = knowledgeTargetSql(parent.table, parentAlias, scope);
	return {
		sql: `${own.sql} AND EXISTS(SELECT 1 FROM main.${parent.table} ${parentAlias} WHERE ${parentAlias}.id=${alias}.${parent.key}${readable.sql})`,
		args: [...own.args, ...readable.args],
	};
}
function knowledgeJsonProjection(column: string, scope: ReadScope): { sql: string; args: unknown[] } {
	const targets = [
		{ table: "memories", key: "id", prefix: "memory:" },
		{ table: "entities", key: "id", prefix: "entity:" },
		{ table: "entity_attributes", key: "id", prefix: "attribute:" },
		{ table: "ontology_proposals", key: "id", prefix: "proposal:" },
		{ table: "session_transcripts", key: "session_key", prefix: "transcript:" },
		{ table: "session_summaries", key: "id", prefix: "summary:" },
		{ table: "memory_artifacts", key: "source_path", prefix: "artifact:" },
	];
	const args: unknown[] = [];
	const checks = targets.map((target) => {
		const allowed = knowledgeTargetSql(target.table, "json_target", scope);
		args.push(...allowed.args);
		return `EXISTS(SELECT 1 FROM main.${target.table} json_target WHERE (json_target.${target.key}=field.value OR '${target.prefix}'||json_target.${target.key}=field.value)${allowed.sql})`;
	});
	const fields = `SELECT ROW_NUMBER() OVER(ORDER BY node.fullkey) AS n,node.fullkey AS path,node.value FROM json_tree(CASE WHEN json_valid(r.${column}) THEN r.${column} ELSE 'null' END) node WHERE node.type IN ('text','integer') AND (node.key IN ('id','reference','sourceRef','source_ref','parent','child','sourcePath','source_path','sessionKey','session_key') OR node.key GLOB '*_id' OR node.key GLOB '*Id' OR node.value GLOB 'memory:*' OR node.value GLOB 'attribute:*' OR node.value GLOB 'entity:*' OR node.value GLOB 'proposal:*' OR node.value GLOB 'transcript:*' OR node.value GLOB 'summary:*' OR node.value GLOB 'artifact:*')`;
	return {
		sql: `CASE WHEN NOT json_valid(r.${column}) THEN r.${column} WHEN length(CAST(r.${column} AS BLOB))>65536 THEN 'null' ELSE (WITH RECURSIVE fields AS (${fields}),safe(n,value) AS (SELECT 0,r.${column} WHERE (SELECT COUNT(*) FROM fields)<=128 UNION ALL SELECT safe.n+1,CASE WHEN ${checks.join(" OR ")} THEN safe.value ELSE json_set(safe.value,field.path,NULL) END FROM safe JOIN fields field ON field.n=safe.n+1) SELECT value FROM safe ORDER BY n DESC LIMIT 1) END AS ${column}`,
		args,
	};
}

function knowledgeReadableProjection(table: string, scope: ReadScope): { sql: string; args: unknown[] } {
	const columns = KNOWLEDGE_READ_COLUMNS[table];
	if (!columns) return { sql: "r.*", args: [] };
	const args: unknown[] = [];
	const pointer = (column: string, target: string, key = "id") => {
		const allowed = knowledgeTargetSql(target, "pointer_target", scope);
		args.push(...allowed.args);
		return `CASE WHEN EXISTS(SELECT 1 FROM main.${target} pointer_target WHERE pointer_target.${key}=r.${column}${allowed.sql}) THEN r.${column} ELSE NULL END AS ${column}`;
	};
	const members = (select: string, tail = "") => {
		const allowed = knowledgeTargetSql("entities", "member", scope);
		args.push(...allowed.args);
		return `(SELECT ${select} FROM main.entities member WHERE member.community_id=r.id${allowed.sql} AND COALESCE(member.status,'active')='active'${tail})`;
	};
	const targets: Readonly<Record<string, Readonly<Record<string, string>>>> = {
		entities: { proposal_id: "ontology_proposals" },
		entity_aspects: { proposal_id: "ontology_proposals" },
		entity_attributes: {
			memory_id: "memories",
			superseded_by: "entity_attributes",
			version_root_id: "entity_attributes",
			previous_attribute_id: "entity_attributes",
			proposal_id: "ontology_proposals",
		},
		entity_dependencies: { aspect_id: "entity_aspects", proposal_id: "ontology_proposals" },
		epistemic_assertions: { supersedes_assertion_id: "epistemic_assertions" },
		memories: { superseded_by: "memories" },
		session_summaries: { session_key: "session_transcripts" },
	};
	const projection = columns.map((column) => {
		if (["proposal_evidence", "evidence", "payload", "result"].includes(column)) {
			const json = knowledgeJsonProjection(column, scope);
			args.push(...json.args);
			return json.sql;
		}
		if (table === "entities" && column === "mentions")
			return "(SELECT COUNT(DISTINCT mention.memory_id) FROM main.memory_entity_mentions mention JOIN memories memory ON memory.id=mention.memory_id WHERE mention.entity_id=r.id AND COALESCE(memory.is_deleted,0)=0) AS mentions";
		if (table === "entities" && column === "community_id") {
			const community = knowledgeTargetSql("entity_communities", "community_target", scope),
				member = knowledgeTargetSql("entities", "community_member", scope);
			args.push(...community.args, ...member.args);
			return `CASE WHEN EXISTS(SELECT 1 FROM main.entity_communities community_target WHERE community_target.id=r.community_id${community.sql}) THEN (SELECT 'community:'||MIN(community_member.id) FROM main.entities community_member WHERE community_member.community_id=r.community_id${member.sql}) ELSE NULL END AS community_id`;
		}
		if (table === "entity_communities") {
			if (column === "id") return `${members("'community:'||MIN(member.id)")} AS id`;
			if (column === "name")
				return `${members("member.name", " ORDER BY (SELECT COUNT(*) FROM main.memory_entity_mentions mention JOIN memories memory ON memory.id=mention.memory_id WHERE mention.entity_id=member.id) DESC,member.id LIMIT 1")} AS name`;
			if (column === "member_count") return `${members("COUNT(*)")} AS member_count`;
			if (column === "created_at") return `${members("MIN(member.created_at)")} AS created_at`;
			if (column === "updated_at") return `${members("MAX(member.updated_at)")} AS updated_at`;
			if (column === "cohesion") {
				const one = members("COUNT(*)"),
					two = members("COUNT(*)"),
					three = members("COUNT(*)");
				return `CASE WHEN ${one}<2 THEN 0.0 ELSE (SELECT COUNT(DISTINCT json_array(min(edge.source_entity_id,edge.target_entity_id),max(edge.source_entity_id,edge.target_entity_id))) FROM entity_dependencies edge JOIN main.entities source ON source.id=edge.source_entity_id JOIN main.entities target ON target.id=edge.target_entity_id WHERE edge.agent_id=r.agent_id AND source.community_id=r.id AND target.community_id=r.id AND source.id!=target.id AND COALESCE(edge.status,'active')='active')*2.0/(${two}*(${three}-1)) END AS cohesion`;
			}
		}
		if (table === "entity_attributes" && column === "status") {
			const allowed = knowledgeTargetSql("entity_attributes", "replacement", scope);
			args.push(...allowed.args);
			return `CASE WHEN r.status='superseded' AND r.superseded_by IS NOT NULL AND NOT EXISTS(SELECT 1 FROM main.entity_attributes replacement WHERE replacement.id=r.superseded_by${allowed.sql}) THEN 'active' ELSE r.status END AS status`;
		}
		if (table === "entity_attributes" && column === "version") {
			const allowed = knowledgeTargetSql("entity_attributes", "version", scope);
			args.push(...allowed.args);
			return `(SELECT COUNT(*) FROM main.entity_attributes version WHERE COALESCE(version.version_root_id,version.id)=COALESCE(r.version_root_id,r.id) AND version.version<=r.version${allowed.sql}) AS version`;
		}
		if (column === "source_id" && columns.includes("source_kind")) {
			const kinds = [
				{ kind: "memory", table: "memories", key: "id" },
				{ kind: "transcript", table: "session_transcripts", key: "session_key" },
				{ kind: "summary", table: "session_summaries", key: "id" },
				{ kind: "artifact", table: "memory_artifacts", key: "source_path" },
			];
			const cases = kinds.map((kind) => {
				const allowed = knowledgeTargetSql(kind.table, "source_target", scope);
				args.push(...allowed.args);
				return `WHEN r.source_kind='${kind.kind}' AND EXISTS(SELECT 1 FROM main.${kind.table} source_target WHERE source_target.${kind.key}=r.source_id${allowed.sql}) THEN r.source_id`;
			});
			return `CASE ${cases.join(" ")} ELSE NULL END AS source_id`;
		}
		const target = targets[table]?.[column];
		if (target) return pointer(column, target, column === "session_key" ? "session_key" : "id");
		return `r.${column}`;
	});
	return { sql: projection.join(", "), args };
}

export function scopedKnowledgeStatement<T extends { readonly sql: string; readonly params?: readonly unknown[] }>(
	statement: T,
	readScope: ReadScope | undefined,
): T & { readonly params: readonly unknown[] } {
	if (!readScope) return { ...statement, params: statement.params ?? [] };
	const tables = new Set<string>();
	for (const match of statement.sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z_0-9]*)\b/gi)) {
		if (match[1]) tables.add(match[1]);
	}
	const parents: Readonly<Record<string, readonly string[]>> = {
		entity_aspects: ["entities"],
		entity_communities: ["entities", "entity_dependencies"],
		entity_attributes: ["entity_aspects"],
		entity_dependencies: ["entities"],
		epistemic_assertions: ["entities", "entity_attributes"],
		entity_aliases: ["entities"],
		task_meta: ["entities"],
		memory_entity_mentions: ["entities", "memories"],
		session_summary_memories: ["session_summaries", "memories"],
		ontology_contradictions: ["entity_attributes"],
		ontology_proposals: ["entity_attributes"],
		predictor_comparisons: ["entities"],
	};
	const addParents = (table: string): void => {
		for (const parent of parents[table] ?? []) {
			if (tables.has(parent)) continue;
			tables.add(parent);
			addParents(parent);
		}
	};
	for (const table of tables) addParents(table);
	const derivedKinds: Readonly<Record<string, string>> = {
		entities: "entity",
		entity_aspects: "aspect",
		entity_attributes: "attribute",
		entity_dependencies: "dependency",
		epistemic_assertions: "assertion",
		ontology_proposals: "proposal",
		ontology_contradictions: "contradiction",
	};
	if ([...tables].some((table) => derivedKinds[table]))
		for (const table of ["memories", "session_transcripts", "memory_artifacts", "session_summaries"]) tables.add(table);
	const ctes: string[] = [];
	const args: unknown[] = [];
	const relations: Readonly<Record<string, string>> = {
		entity_aspects: "EXISTS (SELECT 1 FROM entities p WHERE p.id=r.entity_id AND p.agent_id=r.agent_id)",
		entity_communities:
			"EXISTS (SELECT 1 FROM entities visible_member JOIN main.entities stored_member ON stored_member.id=visible_member.id WHERE stored_member.community_id=r.id)",
		entity_attributes: "EXISTS (SELECT 1 FROM entity_aspects p WHERE p.id=r.aspect_id AND p.agent_id=r.agent_id)",
		entity_dependencies:
			"EXISTS (SELECT 1 FROM entities p WHERE p.id=r.source_entity_id AND p.agent_id=r.agent_id) AND EXISTS (SELECT 1 FROM entities p WHERE p.id=r.target_entity_id AND p.agent_id=r.agent_id)",
		epistemic_assertions:
			"EXISTS (SELECT 1 FROM entities p WHERE p.id=r.subject_entity_id AND p.agent_id=r.agent_id) AND (r.claim_attribute_id IS NULL OR EXISTS (SELECT 1 FROM entity_attributes p WHERE p.id=r.claim_attribute_id AND p.agent_id=r.agent_id))",
		entity_aliases: "EXISTS (SELECT 1 FROM entities p WHERE p.id=r.entity_id AND p.agent_id=r.agent_id)",
		task_meta: "EXISTS (SELECT 1 FROM entities p WHERE p.id=r.entity_id AND p.agent_id=r.agent_id)",
		memory_entity_mentions:
			"EXISTS (SELECT 1 FROM entities p WHERE p.id=r.entity_id) AND EXISTS (SELECT 1 FROM memories p WHERE p.id=r.memory_id)",
		session_summary_memories:
			"EXISTS (SELECT 1 FROM session_summaries p WHERE p.id=r.summary_id) AND EXISTS (SELECT 1 FROM memories p WHERE p.id=r.memory_id)",
		ontology_contradictions:
			"EXISTS (SELECT 1 FROM entity_attributes p WHERE p.id=r.left_attribute_id AND p.agent_id=r.agent_id) AND EXISTS (SELECT 1 FROM entity_attributes p WHERE p.id=r.right_attribute_id AND p.agent_id=r.agent_id)",
		predictor_comparisons: "0",
	};
	for (const table of KNOWLEDGE_CONTENT_TABLES) {
		if (!tables.has(table)) continue;
		const memory = table === "memories";
		const source = [
			"entities",
			"entity_attributes",
			"entity_dependencies",
			"entity_communities",
			"epistemic_assertions",
			"ontology_proposals",
			"memories",
			"memory_artifacts",
			"session_transcripts",
		].includes(table);
		const scope = readScopeSql("r", knowledgeScopeForTable(readScope, table), {
			visibility: memory ? "visibility" : null,
			memory: memory ? "id" : null,
			session: table === "session_transcripts" || table === "session_summaries" ? "session_key" : null,
			source: source ? "source_id" : null,
		});

		const derivedKind = derivedKinds[table];
		const copyCitation = ["ontology_proposals", "ontology_contradictions"].includes(table)
			? " OR (citation.evidence_kind='attribute' AND NOT EXISTS (SELECT 1 FROM entity_attributes evidence WHERE evidence.id=citation.evidence_id AND evidence.agent_id=r.agent_id))"
			: "";
		const citations = derivedKind
			? ` AND NOT EXISTS (SELECT 1 FROM evidence_citations citation WHERE citation.agent_id=r.agent_id AND citation.derived_kind='${derivedKind}' AND citation.derived_id=r.id AND ((citation.evidence_kind='memory' AND NOT EXISTS (SELECT 1 FROM memories evidence WHERE evidence.id=citation.evidence_id AND evidence.agent_id=r.agent_id)) OR (citation.evidence_kind='transcript' AND NOT EXISTS (SELECT 1 FROM session_transcripts evidence WHERE evidence.session_key=citation.evidence_id AND evidence.agent_id=r.agent_id)) OR (citation.evidence_kind='artifact' AND NOT EXISTS (SELECT 1 FROM memory_artifacts evidence WHERE evidence.source_path=citation.evidence_id AND evidence.agent_id=r.agent_id)) OR (citation.evidence_kind='summary' AND NOT EXISTS (SELECT 1 FROM session_summaries evidence WHERE evidence.id=citation.evidence_id AND evidence.agent_id=r.agent_id))${copyCitation} ))`
			: "";
		const projection = knowledgeReadableProjection(table, readScope);
		ctes.push(
			`${table} AS NOT MATERIALIZED (SELECT r.rowid AS rowid, ${projection.sql} FROM main.${table} r WHERE 1${scope.sql}${relations[table] ? ` AND ${relations[table]}` : ""}${citations})`,
		);

		args.push(...projection.args, ...scope.args);
	}
	for (const table of [
		"entity_aliases",
		"task_meta",
		"memory_entity_mentions",
		"session_summary_memories",
		"predictor_comparisons",
	]) {
		if (tables.has(table))
			ctes.push(`${table} AS NOT MATERIALIZED (SELECT r.* FROM main.${table} r WHERE ${relations[table]})`);
	}
	let sql = statement.sql.replace(/\bINDEXED\s+BY\s+[a-z_][a-z_0-9]*\b/gi, "");
	const aliases = new Map<string, string>();
	for (const match of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z_0-9]*)(?:\s+(?:AS\s+)?([a-z_][a-z_0-9]*))?/gi)) {
		const table = match[1];
		if (!table || !KNOWLEDGE_READ_COLUMNS[table]) continue;
		const alias =
			match[2] &&
			!new Set(["WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "ON", "ORDER", "GROUP", "LIMIT", "UNION"]).has(
				match[2].toUpperCase(),
			)
				? match[2]
				: table;
		aliases.set(alias, table);
	}
	for (const [alias, table] of aliases) {
		const columns = KNOWLEDGE_READ_COLUMNS[table];
		if (!columns) continue;
		sql = sql.replace(new RegExp(`\\b${alias}\\.\\*`, "g"), columns.map((column) => `${alias}.${column}`).join(","));
	}
	sql = sql.replace(
		/SELECT\s+\*(?=\s+FROM\s+([a-z_][a-z_0-9]*)(?:\s+(?:AS\s+)?([a-z_][a-z_0-9]*))?)/gi,
		(original: string, table: string, candidate: string | undefined) => {
			const columns = KNOWLEDGE_READ_COLUMNS[table];
			const alias =
				candidate &&
				!new Set(["WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "ON", "ORDER", "GROUP", "LIMIT", "UNION"]).has(
					candidate.toUpperCase(),
				)
					? candidate
					: table;
			return columns ? `SELECT ${columns.map((column) => `${alias}.${column}`).join(",")}` : original;
		},
	);
	if (readScope.reach.kind === "all")
		sql = sql.replace(/\b(?:[a-z_][a-z_0-9]*\.)?agent_id\s*=\s*\?/gi, "? IS NOT NULL");
	if (ctes.length)
		sql = /^\s*WITH\s/i.test(sql)
			? sql.replace(/^(\s*WITH\s+)(RECURSIVE\s+)?/i, `$1$2${ctes.join(", ")}, `)
			: `WITH ${ctes.join(", ")} ${sql}`;
	return { ...statement, sql, params: [...args, ...(statement.params ?? [])] };
}

export function knowledgeReadDb(readScope?: ReadScope): KnowledgeReadDb {
	const parameter = (value: unknown): DbOwnerParameter => {
		if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
			return value;
		throw new Error("Invalid knowledge read parameter");
	};
	return {
		readScope,
		prepare(sql) {
			const query = (result: "all" | "get", params: readonly unknown[]) => {
				const statement = scopedKnowledgeStatement({ sql, params, result }, readScope);
				return dbOwnerQuery(
					{ ...statement, params: statement.params.map(parameter) },
					{
						operation: "db:knowledge.scoped-read",
						deadlineMs: DB_OWNER_READ_DEADLINE_MS,
					},
				);
			};
			return {
				all: (...params) => query("all", params),
				get: async (...params) => (await query("get", params)) ?? undefined,
			};
		},
	};
}

export async function knowledgeTableExists(db: KnowledgeReadDb, table: string): Promise<boolean> {
	return Boolean(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

export async function knowledgeReadQuery<Row>(
	statement: import("./db-owner-protocol").DbOwnerStatement,
	options: import("./db-owner-sql").DbOwnerSqlOptions,
	readScope?: ReadScope,
): Promise<Row> {
	const scoped = scopedKnowledgeStatement(statement, readScope);
	const params = scoped.params.map((value): DbOwnerParameter => {
		if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
			return value;
		throw new Error("Invalid knowledge read parameter");
	});
	return dbOwnerQuery<Row>({ ...scoped, params }, options);
}

export async function knowledgeReadOwner(
	owner: import("./db-owner-client").DbOwnerClient,
	readScope: ReadScope,
): Promise<import("./db-owner-client").DbOwnerClient> {
	const shards = await import("./db-owner-sql").then(({ ownerReadAll }) =>
		ownerReadAll(
			owner,
			"SELECT name FROM sqlite_master WHERE type='table' AND (name='entities_fts' OR name GLOB 'entities_fts__c[0-9]*') ORDER BY name",
			[],
			{ operation: "knowledge.fts-shards", deadlineMs: DB_OWNER_READ_DEADLINE_MS },
		),
	);
	const readableShards = z
		.array(z.object({ name: z.string() }))
		.parse(shards)
		.flatMap(({ name }) => {
			if (name === "entities_fts") return [name];
			if (!/^entities_fts__c[1-9][0-9]*$/.test(name)) return [];
			const compartment = Number(name.slice("entities_fts__c".length));
			return Number.isSafeInteger(compartment) &&
				(readScope.compartments === "all" || readScope.compartments.includes(compartment))
				? [name]
				: [];
		});
	const restrictedRanking =
		readScope.reach.kind !== "all" || readScope.compartments !== "all" || readScope.projects !== null;
	const submit = <Result>(
		request: import("./db-owner-protocol").DbOwnerRequest,
		options: import("./db-owner-client").DbOwnerSubmitOptions,
	): import("./db-owner-client").DbOwnerJobHandle<Result> => {
		if (request.kind !== "query") throw new Error("Knowledge reads require a query");
		const statement = request.statement;
		if (statement.result === "run") throw new Error("Knowledge read cannot mutate state");
		const branches = /\bFROM entities_fts\b/i.test(statement.sql)
			? readableShards.map((shard) =>
					scopedKnowledgeStatement(
						{
							...statement,
							sql: statement.sql
								.replace(/\bentities_fts\b/g, shard)
								.replace(
									/SELECT e\.id\b/i,
									`SELECT e.id, ${restrictedRanking ? "length(e.name)" : "rank"} AS knowledge_rank`,
								)
								.replace(/ORDER BY rank\b/i, restrictedRanking ? "ORDER BY length(e.name), e.id" : "ORDER BY rank"),
						},
						readScope,
					),
				)
			: [scopedKnowledgeStatement(statement, readScope)];
		const sql =
			/\bFROM entities_fts\b/i.test(statement.sql) && branches.length > 0 && (restrictedRanking || branches.length > 1)
				? `SELECT id FROM (${branches.map((branch) => `SELECT * FROM (${branch.sql})`).join(" UNION ALL ")}) ORDER BY knowledge_rank, id LIMIT 20`
				: (branches[0]?.sql ?? "SELECT NULL AS id WHERE 0");
		const params = branches
			.flatMap((branch) => branch.params)
			.map((value): DbOwnerParameter => {
				if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
					return value;
				throw new Error("Invalid knowledge read parameter");
			});
		return owner.submit<Result>({ ...request, statement: { ...statement, sql, params } }, options);
	};
	return new Proxy(owner, {
		get(target, key) {
			if (key === "submit") return submit;
			const value: unknown = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export async function readKnowledgeTraceSource(
	db: KnowledgeReadDb,
	params: {
		readonly kind: "artifact" | "transcript" | "summary";
		readonly agentId: string;
		readonly id: string;
		readonly candidates: readonly string[];
	},
): Promise<{
	readonly id: string;
	readonly content: string;
	readonly sourcePath: string | null;
	readonly project: string | null;
	readonly completed: boolean;
} | null> {
	const ph = params.candidates.map(() => "?").join(",");
	const queries = {
		artifact: {
			sql: `SELECT source_path AS id, content, source_path, project, 1 AS completed FROM memory_artifacts WHERE agent_id=? AND COALESCE(is_deleted,0)=0 AND (source_path=? OR source_node_id IN (${ph}) OR session_id IN (${ph}) OR session_key IN (${ph}) OR session_token IN (${ph})) ORDER BY captured_at DESC LIMIT 1`,
			args: [
				params.agentId,
				params.id,
				...params.candidates,
				...params.candidates,
				...params.candidates,
				...params.candidates,
			],
		},
		transcript: {
			sql: `SELECT session_key AS id, content, source_meta_json, project, completed_at IS NOT NULL AS completed FROM session_transcripts WHERE agent_id=? AND session_key IN (${ph}) ORDER BY COALESCE(completed_at,updated_at,created_at) DESC,created_at DESC LIMIT 1`,
			args: [params.agentId, ...params.candidates],
		},
		summary: {
			sql: `SELECT id, content, project, 1 AS completed FROM session_summaries WHERE agent_id=? AND depth=0 AND COALESCE(source_type,'summary') IN ('summary','compaction','checkpoint') AND (id IN (${ph}) OR source_ref IN (${ph})) ORDER BY latest_at DESC LIMIT 1`,
			args: [params.agentId, ...params.candidates, ...params.candidates],
		},
	};
	const query = queries[params.kind];
	const row = await db.prepare(query.sql).get(...query.args);
	if (
		typeof row !== "object" ||
		row === null ||
		!("id" in row) ||
		typeof row.id !== "string" ||
		!("content" in row) ||
		typeof row.content !== "string"
	)
		return null;
	let sourcePath = "source_path" in row && typeof row.source_path === "string" ? row.source_path : null;
	if ("source_meta_json" in row && typeof row.source_meta_json === "string") {
		const meta = row.source_meta_json;
		const parsed: unknown = attempt(() => JSON.parse(meta));
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"managedPath" in parsed &&
			typeof parsed.managedPath === "string"
		)
			sourcePath = parsed.managedPath.trim() || null;
	}
	return {
		id: row.id,
		content: row.content,
		sourcePath,
		project: "project" in row && typeof row.project === "string" ? row.project : null,
		completed: "completed" in row && row.completed === 1,
	};
}

export async function getKnowledgeCommunities(agentId: string, readScope: ReadScope) {
	const db = knowledgeReadDb(readScope);

	return z
		.array(
			z.object({
				id: z.string(),
				name: z.string().nullable(),
				cohesion: z.number(),
				member_count: z.number(),
				created_at: z.string().nullable(),
				updated_at: z.string().nullable(),
			}),
		)
		.parse(
			await db
				.prepare(
					`SELECT id, name, cohesion, member_count, created_at, updated_at
					 FROM entity_communities
					 WHERE agent_id = ?
					 ORDER BY member_count DESC`,
				)
				.all(agentId),
		);
}

export async function expandKnowledgeSessions(
	params: {
		readonly agentId: string;
		readonly entity: { readonly id: string; readonly name: string; readonly canonicalName: string };
		readonly project?: string;
		readonly sessionId?: string;
		readonly timeRange?: string;
		readonly maxResults: number;
	},
	readScope: ReadScope,
) {
	const { agentId, entity, project, sessionId, timeRange, maxResults } = params;
	const db = knowledgeReadDb(readScope);
	if (!(await knowledgeTableExists(db, "session_summaries")))
		return { entityName: entity.name, summaries: [], total: 0 };

	const conditions = ["ss.agent_id = ?", "ss.kind = 'session'", "COALESCE(ss.source_type, 'summary') = 'summary'"];
	const args: Array<string | number> = [agentId];

	if (project) {
		conditions.push("ss.project = ?");
		args.push(project);
	}

	if (sessionId) {
		conditions.push("ss.session_key = ?");
		args.push(sessionId);
	}

	if (timeRange === "last_week") {
		conditions.push("ss.latest_at >= datetime('now', '-7 days')");
	} else if (timeRange === "last_month") {
		conditions.push("ss.latest_at >= datetime('now', '-30 days')");
	} else if (timeRange && timeRange.length > 0) {
		conditions.push("ss.latest_at >= ?");
		args.push(timeRange);
	}

	const cn = entity.canonicalName.toLowerCase().replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
	const useTextFallback = cn.length >= 4;
	const normalizedContent =
		`LOWER(' ' || REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(` +
		"REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(ss.content," +
		`',', ' '), '.', ' '), '!', ' '), '?', ' '), ';', ' '), '"', ' '),` +
		`char(39), ' '), char(40), ' '), char(41), ' '),` +
		`char(10), ' '), char(9), ' '), ':', ' '), '-', ' ') || ' ')`;
	const fallbackClause = useTextFallback ? `OR ${normalizedContent} LIKE ? ESCAPE '\\'` : "";
	const fallbackArgs = useTextFallback ? [`% ${cn} %`] : [];
	const rows = z
		.array(
			z.object({
				id: z.string(),
				content: z.string(),
				session_key: z.string().nullable(),
				harness: z.string().nullable(),
				earliest_at: z.string(),
				latest_at: z.string(),
			}),
		)
		.parse(
			await db
				.prepare(
					`SELECT DISTINCT ss.id, ss.content, ss.session_key,
					        ss.harness, ss.earliest_at, ss.latest_at
					 FROM session_summaries ss
					 WHERE ${conditions.join(" AND ")}
					   AND (
							EXISTS (
								SELECT 1
								FROM session_summary_memories ssm
								JOIN memory_entity_mentions mem
								  ON mem.memory_id = ssm.memory_id
								WHERE ssm.summary_id = ss.id
								  AND mem.entity_id = ?
							)
							${fallbackClause}
					   )
					 ORDER BY ss.latest_at DESC
					 LIMIT ?`,
				)
				.all(...args, entity.id, ...fallbackArgs, maxResults),
		);
	return {
		entityName: entity.name,
		summaries: rows.map((row) => ({
			id: row.id,
			sessionKey: row.session_key,
			harness: row.harness,
			earliestAt: row.earliest_at,
			latestAt: row.latest_at,
			content: redactCredentials(row.content),
		})),
		total: rows.length,
	};
}
