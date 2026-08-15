/** Deterministic, local quality measurements for the semantic layer Dreaming creates. */
import { SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES } from "@signet/core";
import type { DbAccessor } from "../db-accessor";
import { classifyEntityQuality, normalizeEntityName } from "../entity-quality";
import { getOntologyClaimEvidence } from "../ontology-claim-evidence";

const GENERIC_ASPECT_NAMES = ["profile", "details", "general", "information"] as const;

interface ClaimPathRow {
	readonly entity: string;
	readonly aspect: string;
	readonly groupKey: string;
	readonly claimKey: string;
}

interface EntityRow {
	readonly id: string;
	readonly name: string;
	readonly canonicalName: string;
	readonly entityType: string;
}

export interface DreamingQualityIssue {
	readonly id: string;
	readonly name: string;
	readonly reason: string;
}

export interface DreamingQualityReport {
	readonly agentId: string;
	readonly citationCoverage: {
		readonly totalClaimValues: number;
		readonly valuesWithResolvedEpisodicQuote: number;
		/** Active values without a stable claim key cannot be resolved by path. */
		readonly unaddressableClaimValues: number;
		/** Paths that disappeared or no longer resolve during this read. */
		readonly unresolvedClaimPaths: number;
		readonly rate: number | null;
	};
	readonly graphGarbageRate: {
		readonly totalEntities: number;
		readonly garbageEntities: number;
		readonly rate: number | null;
		readonly examples: readonly DreamingQualityIssue[];
	};
	/** Model-sensitive ontology-shape signals, reported alongside correctness. */
	readonly structureQuality: {
		readonly totalEntities: number;
		readonly unknownEntityTypes: number;
		readonly unknownEntityTypeRate: number | null;
		readonly totalAspects: number;
		/** Exact `profile` buckets, retained for model-ablation comparisons. */
		readonly profileAspects: number;
		readonly profileAspectRate: number | null;
		/** Generic buckets (including `details`) that flatten semantic structure. */
		readonly genericAspects: number;
		readonly genericAspectRate: number | null;
	};
}

function isResolvedEpisodicQuote(item: {
	readonly found: boolean;
	readonly kind: string;
	readonly reference: unknown;
}): boolean {
	// A source pointer alone does not prove a verbatim citation. The quote must
	// remain in canonical proposal evidence and the referenced episodic source
	// must still resolve. `provided_quote` deliberately does not qualify because
	// it lacks an independently resolved source.
	if (!item.found || !["memory", "memory_artifact", "session_transcript"].includes(item.kind)) return false;
	if (!item.reference || typeof item.reference !== "object" || Array.isArray(item.reference)) return false;
	const quote = (item.reference as Record<string, unknown>).quote;
	return typeof quote === "string" && quote.trim().length > 0;
}

function qualityIssues(rows: readonly EntityRow[]): readonly DreamingQualityIssue[] {
	const canonicalNames = new Set(rows.map((row) => row.canonicalName));
	return rows.flatMap((row) => {
		const quality = classifyEntityQuality(row.name, row.entityType);
		if (!quality.ok) return [{ id: row.id, name: row.name, reason: quality.reason ?? "invalid_entity" }];
		const normalized = normalizeEntityName(row.name);
		const possessiveBase = normalized.endsWith("'s") ? normalized.slice(0, -2).trim() : null;
		return possessiveBase && canonicalNames.has(possessiveBase)
			? [{ id: row.id, name: row.name, reason: "possessive_duplicate" }]
			: [];
	});
}

/**
 * Measure citation coverage and entity garbage without creating a second
 * semantic reader. Claim evidence is resolved through the same API surface
 * users inspect, while source-native topology is excluded from quality counts.
 */
export function getDreamingQualityReport(accessor: DbAccessor, agentId: string): DreamingQualityReport {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	const { claimPaths, entities, totalClaimValues, unaddressableClaimValues, structureQuality } = accessor.withReadDb(
		(db: import("../db-accessor").ReadDb) => {
			const topologyPlaceholders = SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES.map(() => "?").join(", ");
			const semanticFilter = `NOT (e.entity_type IN (${topologyPlaceholders}) OR (e.entity_type = 'source' AND e.source_root IS NOT NULL))`;
			const claimPaths = db
				.prepare(
					`SELECT DISTINCT e.name AS entity, asp.canonical_name AS aspect,
				        COALESCE(ea.group_key, 'general') AS groupKey, ea.claim_key AS claimKey
				 FROM entity_attributes ea
				 JOIN entity_aspects asp ON asp.id = ea.aspect_id AND asp.agent_id = ea.agent_id
				 JOIN entities e ON e.id = asp.entity_id AND e.agent_id = ea.agent_id
				 WHERE ea.agent_id = ? AND ea.status = 'active'
				   AND TRIM(COALESCE(ea.claim_key, '')) <> ''
				   AND ${semanticFilter}`,
				)
				.all(agentId, ...SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES) as ClaimPathRow[];
			const claimCounts = db
				.prepare(
					`SELECT COUNT(*) AS totalClaimValues,
				        SUM(CASE WHEN TRIM(COALESCE(ea.claim_key, '')) = '' THEN 1 ELSE 0 END) AS unaddressableClaimValues
				 FROM entity_attributes ea
				 JOIN entity_aspects asp ON asp.id = ea.aspect_id AND asp.agent_id = ea.agent_id
				 JOIN entities e ON e.id = asp.entity_id AND e.agent_id = ea.agent_id
				 WHERE ea.agent_id = ? AND ea.status = 'active' AND ${semanticFilter}`,
				)
				.get(agentId, ...SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES) as {
				totalClaimValues: number;
				unaddressableClaimValues: number | null;
			};
			const entities = db
				.prepare(
					`SELECT id, name, canonical_name AS canonicalName, entity_type AS entityType
				 FROM entities e
				 WHERE e.agent_id = ? AND COALESCE(e.status, 'active') = 'active' AND ${semanticFilter}`,
				)
				.all(agentId, ...SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES) as EntityRow[];
			const structure = db
				.prepare(
					`SELECT COUNT(DISTINCT e.id) AS totalEntities,
				        COUNT(DISTINCT CASE WHEN LOWER(TRIM(e.entity_type)) IN ('', 'unknown') THEN e.id END) AS unknownEntityTypes,
				        COUNT(asp.id) AS totalAspects,
				        SUM(CASE WHEN LOWER(TRIM(asp.canonical_name)) = 'profile' THEN 1 ELSE 0 END) AS profileAspects,
				        SUM(CASE WHEN LOWER(TRIM(asp.canonical_name)) IN (${GENERIC_ASPECT_NAMES.map(() => "?").join(", ")}) THEN 1 ELSE 0 END) AS genericAspects
				 FROM entities e
				 LEFT JOIN entity_aspects asp
				   ON asp.entity_id = e.id
				  AND asp.agent_id = e.agent_id
				  AND COALESCE(asp.status, 'active') = 'active'
				 WHERE e.agent_id = ? AND COALESCE(e.status, 'active') = 'active' AND ${semanticFilter}`,
				)
				.get(...GENERIC_ASPECT_NAMES, agentId, ...SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES) as {
				totalEntities: number;
				unknownEntityTypes: number | null;
				totalAspects: number;
				profileAspects: number | null;
				genericAspects: number | null;
			};
			return {
				claimPaths,
				entities,
				totalClaimValues: Number(claimCounts.totalClaimValues),
				unaddressableClaimValues: Number(claimCounts.unaddressableClaimValues ?? 0),
				structureQuality: {
					totalEntities: Number(structure.totalEntities),
					unknownEntityTypes: Number(structure.unknownEntityTypes ?? 0),
					unknownEntityTypeRate:
						Number(structure.totalEntities) === 0
							? null
							: Number(structure.unknownEntityTypes ?? 0) / Number(structure.totalEntities),
					totalAspects: Number(structure.totalAspects),
					profileAspects: Number(structure.profileAspects ?? 0),
					profileAspectRate:
						Number(structure.totalAspects) === 0
							? null
							: Number(structure.profileAspects ?? 0) / Number(structure.totalAspects),
					genericAspects: Number(structure.genericAspects ?? 0),
					genericAspectRate:
						Number(structure.totalAspects) === 0
							? null
							: Number(structure.genericAspects ?? 0) / Number(structure.totalAspects),
				},
			};
		},
	);

	let valuesWithResolvedEpisodicQuote = 0;
	let unresolvedClaimPaths = 0;
	for (const path of claimPaths) {
		for (let offset = 0; ; offset += 200) {
			try {
				const claimEvidence = getOntologyClaimEvidence(accessor, {
					agentId,
					entity: path.entity,
					aspect: path.aspect,
					group: path.groupKey,
					claim: path.claimKey,
					status: "active",
					limit: 200,
					offset,
				});
				for (const item of claimEvidence.items) {
					if (item.evidence.some(isResolvedEpisodicQuote)) valuesWithResolvedEpisodicQuote++;
				}
				if (claimEvidence.items.length < 200) break;
			} catch {
				unresolvedClaimPaths++;
				break;
			}
		}
	}

	const garbage = qualityIssues(entities);
	return {
		agentId,
		citationCoverage: {
			totalClaimValues,
			valuesWithResolvedEpisodicQuote,
			unaddressableClaimValues,
			unresolvedClaimPaths,
			rate: totalClaimValues === 0 ? null : valuesWithResolvedEpisodicQuote / totalClaimValues,
		},
		graphGarbageRate: {
			totalEntities: entities.length,
			garbageEntities: garbage.length,
			rate: entities.length === 0 ? null : garbage.length / entities.length,
			examples: garbage.slice(0, 50),
		},
		structureQuality,
	};
}
