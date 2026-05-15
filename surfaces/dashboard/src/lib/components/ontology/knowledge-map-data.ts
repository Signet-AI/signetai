import type { ConstellationAttribute, ConstellationEntity, ConstellationGraph } from "$lib/api";

export type KnowledgeMapNodeKind = "source" | "document" | "session" | "claim" | "memory" | "entity" | "proposal";
export type KnowledgeMapEdgeKind = "contains" | "derives" | "supports" | "updates" | "extends" | "mentions" | "about";

export interface KnowledgeMapNode {
	id: string;
	kind: KnowledgeMapNodeKind;
	label: string;
	searchText?: string;
	sublabel?: string;
	preview?: string;
	parentId?: string;
	entityType?: string;
	status?: "current" | "stale" | "conflict" | "review" | "forgotten";
	weight?: number;
	counts?: Record<string, number>;
	x: number;
	y: number;
	data: unknown;
}

export interface KnowledgeMapEdge {
	id: string;
	source: string;
	target: string;
	label: string;
	kind: KnowledgeMapEdgeKind;
	strength?: number;
	dashed?: boolean;
	visualOnly?: boolean;
}

export interface KnowledgeMapBuildOptions {
	focusLabel?: string;
	limit?: number;
}

const DEFAULT_LIMIT = 80;
const EVIDENCE_SOURCE_ID = "source:semantic-memory";
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const PRIMARY_ENTITY_TYPES = new Set(["person", "project", "topic", "system", "product", "organization", "org"]);
const NOISY_ENTITY_TYPES = new Set(["artifact", "benchmark", "run", "file", "chunk", "unknown"]);

export const KNOWLEDGE_NODE_COLORS: Record<KnowledgeMapNodeKind, string> = {
	source: "#38bdf8",
	document: "#60a5fa",
	session: "#818cf8",
	claim: "#a78bfa",
	memory: "#06b6d4",
	entity: "#3b82f6",
	proposal: "#f59e0b",
};

export const KNOWLEDGE_NODE_COLORS_DIM: Record<KnowledgeMapNodeKind, string> = {
	source: "rgba(56, 189, 248, 0.38)",
	document: "rgba(96, 165, 250, 0.34)",
	session: "rgba(129, 140, 248, 0.34)",
	claim: "rgba(167, 139, 250, 0.36)",
	memory: "rgba(6, 182, 212, 0.34)",
	entity: "rgba(59, 130, 246, 0.34)",
	proposal: "rgba(245, 158, 11, 0.34)",
};

export const KNOWLEDGE_RELATED_GLOW: Record<KnowledgeMapNodeKind, string> = {
	source: "rgba(56, 189, 248, 0.14)",
	document: "rgba(96, 165, 250, 0.14)",
	session: "rgba(129, 140, 248, 0.16)",
	claim: "rgba(167, 139, 250, 0.18)",
	memory: "rgba(6, 182, 212, 0.16)",
	entity: "rgba(59, 130, 246, 0.14)",
	proposal: "rgba(245, 158, 11, 0.16)",
};

export function buildKnowledgeMapFromConstellation(
	graph: ConstellationGraph,
	options: KnowledgeMapBuildOptions = {},
): { nodes: KnowledgeMapNode[]; edges: KnowledgeMapEdge[] } {
	const limit = clampLimit(options.limit ?? DEFAULT_LIMIT);
	const source = sourceNode();
	const entities = graph.entities
		.filter(includeEntity)
		.sort((a, b) => entityScore(b, options.focusLabel) - entityScore(a, options.focusLabel));

	const nodes: KnowledgeMapNode[] = [source];
	const edges: KnowledgeMapEdge[] = [];
	const includedEntityIds = new Set<string>();

	const entityNodes = new Map<string, KnowledgeMapNode>();
	let entityIndex = 0;
	for (const entity of entities) {
		if (nodes.length >= limit) break;
		const entityNode = toEntityNode(entity, entityIndex++);
		nodes.push(entityNode);
		entityNodes.set(entity.id, entityNode);
		includedEntityIds.add(entity.id);
		edges.push({
			id: `contains:${EVIDENCE_SOURCE_ID}:${entity.id}`,
			source: EVIDENCE_SOURCE_ID,
			target: entity.id,
			label: "contains",
			kind: "contains",
			strength: 0.35,
		});
	}

	for (const entity of entities) {
		const entityNode = entityNodes.get(entity.id);
		if (!entityNode) continue;
		const claims = claimCandidates(entity)
			.sort((a, b) => b.attribute.importance - a.attribute.importance)
			.slice(0, 4);
		for (const claim of claims) {
			if (nodes.length >= limit) break;
			const claimNode = toClaimNode(entityNode, claim.attribute, claim.aspectName, claim.index);
			nodes.push(claimNode);
			edges.push({
				id: `derives:${entity.id}:${claimNode.id}`,
				source: entity.id,
				target: claimNode.id,
				label: "derives claim",
				kind: "derives",
				strength: 0.6,
			});
			edges.push({
				id: `about:${claimNode.id}:${entity.id}`,
				source: claimNode.id,
				target: entity.id,
				label: "about",
				kind: "about",
				strength: 0.5,
				dashed: true,
				visualOnly: true,
			});

			if (!claim.attribute.memoryId || nodes.length >= limit) continue;
			const memoryNode = toMemoryNode(claimNode, claim.attribute, claim.index);
			nodes.push(memoryNode);
			edges.push({
				id: `supports:${memoryNode.id}:${claimNode.id}`,
				source: memoryNode.id,
				target: claimNode.id,
				label: "supports",
				kind: "supports",
				strength: 0.7,
			});
		}
		if (nodes.length >= limit) break;
	}

	for (const dep of graph.dependencies) {
		if (!includedEntityIds.has(dep.sourceEntityId) || !includedEntityIds.has(dep.targetEntityId)) continue;
		if (dep.strength < 0.35) continue;
		edges.push({
			id: `about:${dep.sourceEntityId}:${dep.targetEntityId}`,
			source: dep.sourceEntityId,
			target: dep.targetEntityId,
			label: dep.dependencyType,
			kind: "about",
			strength: dep.strength,
			dashed: true,
		});
	}

	return {
		nodes: nodes.slice(0, limit),
		edges: edges.filter((edge) => included(nodes, edge.source) && included(nodes, edge.target)),
	};
}

export function relatedIdsForKnowledgeNode(id: string, edges: readonly KnowledgeMapEdge[]): Set<string> {
	const related = new Set<string>();
	for (const edge of edges) {
		if (edge.source === id) related.add(edge.target);
		if (edge.target === id) related.add(edge.source);
	}
	return related;
}

function clampLimit(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(Math.floor(value), 160));
}

function sourceNode(): KnowledgeMapNode {
	return {
		id: EVIDENCE_SOURCE_ID,
		kind: "source",
		label: "Signet knowledge",
		sublabel: "semantic map",
		preview: "Curated evidence, claims, memories, and high-signal entities from the active agent workspace.",
		x: 0,
		y: 0,
		counts: {},
		data: { source: "constellation" },
	};
}

function includeEntity(entity: ConstellationEntity): boolean {
	const type = entity.entityType.toLowerCase();
	if (entity.pinned) return true;
	if (PRIMARY_ENTITY_TYPES.has(type)) return true;
	if (NOISY_ENTITY_TYPES.has(type)) return false;
	if (looksNoisy(entity.name)) return false;
	return (
		entity.mentions >= 3 || entity.aspects.some((aspect) => aspect.attributes.some((attr) => attr.importance >= 0.78))
	);
}

function looksNoisy(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		lower.includes("benchmark") ||
		lower.includes("artifact") ||
		lower.includes("fixture") ||
		lower.includes("chunk") ||
		/\b[0-9a-f]{8,}\b/.test(lower) ||
		/\d{6,}/.test(lower)
	);
}

function entityScore(entity: ConstellationEntity, focusLabel?: string): number {
	const focus = focusLabel?.trim().toLowerCase();
	const focusBoost = focus && entity.name.toLowerCase().includes(focus) ? 100 : 0;
	const typeBoost = PRIMARY_ENTITY_TYPES.has(entity.entityType.toLowerCase()) ? 25 : 0;
	const pinnedBoost = entity.pinned ? 40 : 0;
	const attrScore = entity.aspects.reduce(
		(sum, aspect) => sum + aspect.attributes.reduce((inner, attr) => inner + attr.importance, 0),
		0,
	);
	return focusBoost + pinnedBoost + typeBoost + entity.mentions * 1.8 + attrScore;
}

function toEntityNode(entity: ConstellationEntity, index: number): KnowledgeMapNode {
	const radius = 220 + Math.sqrt(index + 1) * 92;
	const angle = index * GOLDEN_ANGLE;
	return {
		id: entity.id,
		kind: "entity",
		label: entity.name,
		sublabel: entity.entityType,
		preview: `${entity.mentions} mentions • ${entity.aspects.length} aspects`,
		entityType: entity.entityType,
		weight: entityScore(entity),
		counts: { mentions: entity.mentions, aspects: entity.aspects.length },
		x: Math.cos(angle) * radius,
		y: Math.sin(angle) * radius,
		data: entity,
	};
}

function claimCandidates(entity: ConstellationEntity): Array<{
	aspectName: string;
	attribute: ConstellationAttribute;
	index: number;
}> {
	const result: Array<{ aspectName: string; attribute: ConstellationAttribute; index: number }> = [];
	for (const aspect of entity.aspects) {
		for (const attribute of aspect.attributes) {
			if (attribute.importance < 0.2) continue;
			result.push({ aspectName: aspect.name, attribute, index: result.length });
		}
	}
	return result;
}

function toClaimNode(
	parent: KnowledgeMapNode,
	attribute: ConstellationAttribute,
	aspectName: string,
	index: number,
): KnowledgeMapNode {
	const angle = index * GOLDEN_ANGLE + stableUnit(attribute.id, "claim") * 0.7;
	const radius = 122 + stableUnit(attribute.id, "claim-r") * 58;
	return {
		id: `claim:${attribute.id}`,
		kind: "claim",
		label: truncate(attribute.content, 58),
		searchText: attribute.content,
		sublabel: aspectName,
		preview: attribute.content,
		parentId: parent.id,
		status: "current",
		weight: attribute.importance,
		x: parent.x + Math.cos(angle) * radius,
		y: parent.y + Math.sin(angle) * radius,
		data: { attribute, aspectName },
	};
}

function toMemoryNode(parent: KnowledgeMapNode, attribute: ConstellationAttribute, index: number): KnowledgeMapNode {
	const angle = index * GOLDEN_ANGLE + stableUnit(attribute.id, "memory") * 0.9;
	const radius = 74 + stableUnit(attribute.id, "memory-r") * 34;
	return {
		id: `memory:${attribute.memoryId ?? attribute.id}`,
		kind: "memory",
		label: truncate(attribute.content, 42),
		searchText: attribute.content,
		sublabel: attribute.kind,
		preview: attribute.content,
		parentId: parent.id,
		weight: attribute.importance,
		x: parent.x + Math.cos(angle) * radius,
		y: parent.y + Math.sin(angle) * radius,
		data: attribute,
	};
}

function stableUnit(id: string, salt = ""): number {
	let hash = 0;
	const input = `${id}:${salt}`;
	for (let i = 0; i < input.length; i++) hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
	return ((hash >>> 0) % 10000) / 10000;
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function included(nodes: readonly KnowledgeMapNode[], id: string): boolean {
	return nodes.some((node) => node.id === id);
}
