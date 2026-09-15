import { MEMORY_CONTENT_WITHHELD_NOTICE, scanMemoryContent } from "@signet/core";

import type { DbOwnerClient } from "./db-owner-client";
import { ownerReadAll, ownerReadOne } from "./db-owner-sql";
import type { TraversalConfig, TraversalResult } from "./pipeline/graph-traversal";

const HYDRATION_TIMEOUT_MS = 5_000;

interface EntityRow {
	readonly id: string;
	readonly name: string;
	readonly entity_type: string;
	readonly description: string | null;
}

interface AspectRow {
	readonly id: string;
	readonly canonical_name: string;
	readonly weight: number;
}

interface AttributeRow {
	readonly aspect_id: string;
	readonly content: string;
	readonly kind: string;
	readonly importance: number;
	readonly confidence: number;
	readonly memory_id: string | null;
	readonly safety_status?: string | null;
	readonly safety_context_eligible?: number | null;
}

interface DependencyRow {
	readonly target: string;
	readonly type: string;
	readonly strength: number;
}

interface MemoryRow {
	readonly id: string;
	readonly content: string;
	readonly agent_id: string | null;
	readonly safety_status?: string | null;
	readonly safety_context_eligible?: number | null;
}

export interface KnowledgeExpansionResponse {
	readonly entity: {
		readonly id: string;
		readonly name: string;
		readonly type: string;
		readonly description: string | null;
	} | null;
	readonly constraints: ReadonlyArray<{
		readonly entityName: string;
		readonly content: string;
		readonly importance: number;
	}>;
	readonly aspects: ReadonlyArray<{
		readonly name: string;
		readonly weight: number;
		readonly attributes: ReadonlyArray<{
			readonly content: string;
			readonly kind: string;
			readonly importance: number;
			readonly confidence: number;
		}>;
	}>;
	readonly dependencies: ReadonlyArray<DependencyRow>;
	readonly memoryCount: number;
	readonly memories: ReadonlyArray<{
		readonly id: string;
		readonly content: string;
	}>;
	readonly partial?: boolean;
	readonly degradation?: "graph_traversal_timeout" | "graph_traversal_failed";
	readonly graphError?: {
		readonly channel: "graph_traversal";
		readonly code: "graph_traversal_failed";
		readonly message: string;
	};
}

function readOptions(
	operation: string,
	deadlineAt: number,
	estimatedWorkUnits: number,
): {
	readonly operation: string;
	readonly lane: "read";
	readonly workloadClass: "foreground";
	readonly deadlineMs: number;
	readonly estimatedWorkUnits: number;
} {
	return {
		operation,
		lane: "read",
		workloadClass: "foreground",
		deadlineMs: Math.max(1, deadlineAt - Date.now()),
		estimatedWorkUnits: Math.max(1, Math.min(1_200, estimatedWorkUnits)),
	};
}

function isContextEligible(row: {
	readonly content: string;
	readonly safety_status?: string | null;
	readonly safety_context_eligible?: number | null;
}): boolean {
	if (!scanMemoryContent(row.content).contextEligible) return false;
	if (row.safety_status === undefined || row.safety_status === null) return true;
	return row.safety_status === "clean" && row.safety_context_eligible === 1;
}

function traversalMetadata(
	traversal: TraversalResult,
): Pick<KnowledgeExpansionResponse, "partial" | "degradation" | "graphError"> {
	const error = traversal.error;
	const timedOut = traversal.timedOut || error?.code === "DB_OWNER_DEADLINE" || error?.code === "DB_OWNER_CANCELLED";
	if (timedOut) {
		return { partial: true, degradation: "graph_traversal_timeout" };
	}
	if (error) {
		return {
			partial: true,
			degradation: "graph_traversal_failed",
			graphError: {
				channel: "graph_traversal",
				code: "graph_traversal_failed",
				message: "Knowledge graph traversal was unavailable.",
			},
		};
	}
	return {};
}

/**
 * Hydrate an expansion entirely from the DB owner after traversal has
 * collected its IDs. The route must not reopen the parent SQLite connection
 * between traversal stages or during content hydration.
 */
export async function expandKnowledgeGraphViaOwner(
	owner: DbOwnerClient,
	params: {
		readonly primaryEntityId: string;
		readonly agentId: string;
		readonly maxTokens: number;
		readonly aspectFilter?: string;
		readonly traversalConfig: TraversalConfig;
		readonly traversal: TraversalResult;
	},
): Promise<KnowledgeExpansionResponse> {
	const hydrationDeadlineAt = Date.now() + HYDRATION_TIMEOUT_MS;
	const option = (operation: string, estimatedWorkUnits: number) =>
		readOptions(operation, hydrationDeadlineAt, estimatedWorkUnits);

	const entityRow = await ownerReadOne<EntityRow>(
		owner,
		`SELECT id, name, entity_type, description
		 FROM entities
		 WHERE id = ? AND agent_id = ?
		   AND COALESCE(status, 'active') = 'active'`,
		[params.primaryEntityId, params.agentId],
		option("knowledge.expand.entity", 1),
	);

	const aspectConditions = ["entity_id = ?", "agent_id = ?"];
	const aspectParams: Array<string | number> = [params.primaryEntityId, params.agentId];
	if (params.aspectFilter) {
		aspectConditions.push("canonical_name LIKE ?");
		aspectParams.push(`%${params.aspectFilter}%`);
	}
	aspectParams.push(params.traversalConfig.maxAspectsPerEntity);
	const aspects = await ownerReadAll<AspectRow>(
		owner,
		`SELECT id, canonical_name, weight
		 FROM entity_aspects
		 WHERE ${aspectConditions.join(" AND ")}
		 ORDER BY weight DESC
		 LIMIT ?`,
		aspectParams,
		option("knowledge.expand.aspects", params.traversalConfig.maxAspectsPerEntity),
	);

	const safetyTable = await ownerReadOne<{ readonly name: string }>(
		owner,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_content_safety' LIMIT 1",
		[],
		option("knowledge.expand.safety-table", 1),
	);
	const hasSafetyTable = safetyTable !== null;
	const aspectIds = aspects.map((aspect) => aspect.id);
	const attributes =
		aspectIds.length === 0
			? []
			: await ownerReadAll<AttributeRow>(
					owner,
					`SELECT selected.aspect_id, selected.content, selected.kind,
					        selected.importance, selected.confidence, selected.memory_id
					        ${hasSafetyTable ? ", safety.status AS safety_status, safety.context_eligible AS safety_context_eligible" : ""}
					 FROM (
						 SELECT ea.aspect_id, ea.content, ea.kind, ea.importance,
						        ea.confidence, ea.memory_id,
						        ROW_NUMBER() OVER (
							        PARTITION BY ea.aspect_id
							        ORDER BY ea.importance DESC
						        ) AS attribute_rank
						 FROM entity_attributes ea
						 WHERE ea.aspect_id IN (${aspectIds.map(() => "?").join(", ")})
						   AND ea.agent_id = ?
						   AND ea.status = 'active'
					 ) selected
					 ${
							hasSafetyTable
								? "LEFT JOIN memory_content_safety safety ON safety.agent_id = ? AND safety.source_kind = 'memory' AND safety.source_id = selected.memory_id"
								: ""
}
					 WHERE selected.attribute_rank <= ?
					 ORDER BY selected.aspect_id, selected.importance DESC`,
					[
						...aspectIds,
						params.agentId,
						...(hasSafetyTable ? [params.agentId] : []),
						params.traversalConfig.maxAttributesPerAspect,
					],
					option("knowledge.expand.attributes", aspects.length * params.traversalConfig.maxAttributesPerAspect),
				);

	const attributesByAspect = new Map<
		string,
		Array<{
			content: string;
			kind: string;
			importance: number;
			confidence: number;
		}>
	>();
	for (const attribute of attributes) {
		if (!isContextEligible(attribute)) continue;
		const existing = attributesByAspect.get(attribute.aspect_id) ?? [];
		if (existing.length >= params.traversalConfig.maxAttributesPerAspect) continue;
		existing.push({
			content: attribute.content,
			kind: attribute.kind,
			importance: attribute.importance,
			confidence: attribute.confidence,
		});
		attributesByAspect.set(attribute.aspect_id, existing);
	}

	const dependencies = await ownerReadAll<DependencyRow>(
		owner,
		`SELECT e.name AS target, ed.dependency_type AS type, ed.strength
		 FROM entity_dependencies ed
		 JOIN entities e
		   ON e.id = ed.target_entity_id
		  AND e.agent_id = ed.agent_id
		  AND COALESCE(e.status, 'active') = 'active'
		 WHERE ed.source_entity_id = ?
		   AND ed.agent_id = ?
		   AND ed.strength >= ?
		 ORDER BY ed.strength DESC
		 LIMIT ?`,
		[
			params.primaryEntityId,
			params.agentId,
			params.traversalConfig.minDependencyStrength,
			params.traversalConfig.maxDependencyHops,
		],
		option("knowledge.expand.dependencies", params.traversalConfig.maxDependencyHops),
	);

	const memoryIds = [...params.traversal.memoryIds];
	const memoryRows =
		memoryIds.length === 0 || params.maxTokens <= 0
			? []
			: await ownerReadAll<MemoryRow>(
					owner,
					`SELECT m.id, m.content, m.agent_id
					        ${hasSafetyTable ? ", safety.status AS safety_status, safety.context_eligible AS safety_context_eligible" : ""}
					 FROM memories m
					 ${
							hasSafetyTable
								? "LEFT JOIN memory_content_safety safety ON safety.agent_id = COALESCE(NULLIF(TRIM(m.agent_id), ''), 'default') AND safety.source_kind = 'memory' AND safety.source_id = m.id"
								: ""
}
					 WHERE m.id IN (${memoryIds.map(() => "?").join(", ")})
					   AND m.is_deleted = 0
					   AND (m.agent_id = ? OR m.agent_id IS NULL OR TRIM(m.agent_id) = '')`,
					[...memoryIds, params.agentId],
					option("knowledge.expand.memories", memoryIds.length),
				);
	const memoryById = new Map(memoryRows.map((memory) => [memory.id, memory]));
	let tokenBudget = Math.max(0, params.maxTokens);
	const hydratedMemories: Array<{ readonly id: string; readonly content: string }> = [];
	for (const memoryId of memoryIds) {
		if (tokenBudget <= 0) break;
		const memory = memoryById.get(memoryId);
		if (!memory || !isContextEligible(memory)) continue;
		const approxTokens = Math.ceil(memory.content.length / 4);
		if (approxTokens > tokenBudget) continue;
		hydratedMemories.push({ id: memory.id, content: memory.content });
		tokenBudget -= approxTokens;
	}

	const entityDescription = entityRow?.description
		? scanMemoryContent(entityRow.description).contextEligible
			? entityRow.description
			: MEMORY_CONTENT_WITHHELD_NOTICE
		: null;
	return {
		entity: entityRow
			? {
					id: entityRow.id,
					name: entityRow.name,
					type: entityRow.entity_type,
					description: entityDescription,
				}
			: null,
		constraints: params.traversal.constraints.filter(
			(constraint) => scanMemoryContent(constraint.content).contextEligible,
		),
		aspects: aspects.map((aspect) => ({
			name: aspect.canonical_name,
			weight: aspect.weight,
			attributes: attributesByAspect.get(aspect.id) ?? [],
		})),
		dependencies,
		memoryCount: params.traversal.memoryIds.size,
		memories: hydratedMemories,
		...traversalMetadata(params.traversal),
	};
}
