import type { ConstellationAspect, ConstellationAttribute, ConstellationEntity, ConstellationGraph } from "$lib/api";

export type KnowledgeMapNodeKind =
	| "source"
	| "document"
	| "session"
	| "entity"
	| "aspect"
	| "attribute"
	| "memory"
	| "proposal";
export type KnowledgeMapEdgeKind =
	| "contains"
	| "has_aspect"
	| "has_attribute"
	| "supports"
	| "updates"
	| "extends"
	| "mentions"
	| "about";

export interface KnowledgeMapDetailRow {
	label: string;
	value: string;
}

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
	details?: KnowledgeMapDetailRow[];
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
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const PRIMARY_ENTITY_TYPES = new Set(["person", "project", "topic", "system", "product", "organization", "org"]);
const NOISY_ENTITY_TYPES = new Set(["artifact", "benchmark", "run", "file", "chunk", "unknown"]);
const MAX_ENTITY_ANCHORS = 32;
const MAX_ASPECTS_PER_ENTITY = 5;
const MAX_ATTRIBUTES_PER_ASPECT = 4;

export const KNOWLEDGE_NODE_COLORS: Record<KnowledgeMapNodeKind, string> = {
	source: "#38bdf8",
	document: "#60a5fa",
	session: "#818cf8",
	entity: "#7dd3fc",
	aspect: "#60a5fa",
	attribute: "#a78bfa",
	memory: "#22d3ee",
	proposal: "#f59e0b",
};

export const KNOWLEDGE_NODE_COLORS_DIM: Record<KnowledgeMapNodeKind, string> = {
	source: "rgba(56, 189, 248, 0.38)",
	document: "rgba(96, 165, 250, 0.34)",
	session: "rgba(129, 140, 248, 0.34)",
	entity: "rgba(125, 211, 252, 0.38)",
	aspect: "rgba(96, 165, 250, 0.34)",
	attribute: "rgba(167, 139, 250, 0.34)",
	memory: "rgba(34, 211, 238, 0.32)",
	proposal: "rgba(245, 158, 11, 0.34)",
};

export const KNOWLEDGE_RELATED_GLOW: Record<KnowledgeMapNodeKind, string> = {
	source: "rgba(56, 189, 248, 0.14)",
	document: "rgba(96, 165, 250, 0.14)",
	session: "rgba(129, 140, 248, 0.16)",
	entity: "rgba(125, 211, 252, 0.16)",
	aspect: "rgba(96, 165, 250, 0.15)",
	attribute: "rgba(167, 139, 250, 0.17)",
	memory: "rgba(34, 211, 238, 0.16)",
	proposal: "rgba(245, 158, 11, 0.16)",
};

export function buildKnowledgeMapFromConstellation(
	graph: ConstellationGraph,
	options: KnowledgeMapBuildOptions = {},
): { nodes: KnowledgeMapNode[]; edges: KnowledgeMapEdge[] } {
	const limit = clampLimit(options.limit ?? DEFAULT_LIMIT);
	const entities = graph.entities
		.filter(includeEntity)
		.sort((a, b) => entityScore(b, options.focusLabel) - entityScore(a, options.focusLabel))
		.slice(0, Math.min(MAX_ENTITY_ANCHORS, Math.max(1, limit)));

	const nodes: KnowledgeMapNode[] = [];
	const edges: KnowledgeMapEdge[] = [];
	const includedEntityIds = new Set<string>();
	const entityNodes = new Map<string, KnowledgeMapNode>();

	let entityIndex = 0;
	for (const entity of entities) {
		if (nodes.length >= limit) break;
		const entityNode = toEntityNode(entity, entityIndex++, entities.length);
		nodes.push(entityNode);
		entityNodes.set(entity.id, entityNode);
		includedEntityIds.add(entity.id);
	}

	for (const entity of entities) {
		const entityNode = entityNodes.get(entity.id);
		if (!entityNode) continue;
		const aspects = entity.aspects.toSorted((a, b) => aspectScore(b) - aspectScore(a)).slice(0, MAX_ASPECTS_PER_ENTITY);

		for (let aspectIndex = 0; aspectIndex < aspects.length; aspectIndex++) {
			if (nodes.length >= limit) break;
			const aspect = aspects[aspectIndex];
			const aspectNode = toAspectNode(entityNode, aspect, aspectIndex);
			nodes.push(aspectNode);
			edges.push({
				id: `has_aspect:${entity.id}:${aspectNode.id}`,
				source: entity.id,
				target: aspectNode.id,
				label: "aspect",
				kind: "has_aspect",
				strength: 0.58,
			});

			const attributes = aspect.attributes
				.filter((attribute) => attribute.importance >= 0.18)
				.toSorted((a, b) => b.importance - a.importance)
				.slice(0, MAX_ATTRIBUTES_PER_ASPECT);
			for (let attributeIndex = 0; attributeIndex < attributes.length; attributeIndex++) {
				if (nodes.length >= limit) break;
				const attribute = attributes[attributeIndex];
				const attributeNode = toAttributeNode(aspectNode, attribute, attributeIndex);
				nodes.push(attributeNode);
				edges.push({
					id: `has_attribute:${aspectNode.id}:${attributeNode.id}`,
					source: aspectNode.id,
					target: attributeNode.id,
					label: attribute.kind,
					kind: "has_attribute",
					strength: 0.66,
				});

				if (!attribute.memoryId || nodes.length >= limit) continue;
				const memoryNode = toMemoryNode(attributeNode, attribute, attributeIndex);
				nodes.push(memoryNode);
				edges.push({
					id: `supports:${memoryNode.id}:${attributeNode.id}`,
					source: memoryNode.id,
					target: attributeNode.id,
					label: "evidence",
					kind: "supports",
					strength: 0.64,
				});
			}
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

function aspectScore(aspect: ConstellationAspect): number {
	return aspect.weight * 4 + aspect.attributes.reduce((sum, attr) => sum + attr.importance, 0);
}

function toEntityNode(entity: ConstellationEntity, index: number, total: number): KnowledgeMapNode {
	const radius = 320 + Math.sqrt(index + 1) * 88;
	const angle = index * GOLDEN_ANGLE + (total > 1 ? 0 : 0.35);
	const topAspects = entity.aspects
		.toSorted((a, b) => aspectScore(b) - aspectScore(a))
		.slice(0, 4)
		.map((aspect) => aspect.name)
		.join(", ");
	return {
		id: entity.id,
		kind: "entity",
		label: entity.name,
		sublabel: entity.entityType,
		preview: `${entity.mentions} mentions • ${entity.aspects.length} aspects`,
		entityType: entity.entityType,
		weight: entityScore(entity),
		counts: { mentions: entity.mentions, aspects: entity.aspects.length },
		details: [
			{ label: "Type", value: entity.entityType },
			{ label: "Mentions", value: String(entity.mentions) },
			{ label: "Aspects", value: String(entity.aspects.length) },
			{ label: "Strongest", value: topAspects || "None indexed" },
		],
		x: Math.cos(angle) * radius,
		y: Math.sin(angle) * radius,
		data: entity,
	};
}

function toAspectNode(parent: KnowledgeMapNode, aspect: ConstellationAspect, index: number): KnowledgeMapNode {
	const angle = index * GOLDEN_ANGLE + stableUnit(aspect.id, "aspect") * 0.5;
	const radius = 150 + stableUnit(aspect.id, "aspect-r") * 52;
	const topAttributes = aspect.attributes
		.toSorted((a, b) => b.importance - a.importance)
		.slice(0, 3)
		.map((attribute) => attribute.content)
		.join(" / ");
	return {
		id: `aspect:${aspect.id}`,
		kind: "aspect",
		label: aspect.name,
		searchText: `${aspect.name} ${topAttributes}`,
		sublabel: "aspect",
		preview: topAttributes || "No attributes indexed for this aspect yet.",
		parentId: parent.id,
		status: "current",
		weight: aspect.weight,
		counts: { attributes: aspect.attributes.length },
		details: [
			{ label: "Entity", value: parent.label },
			{ label: "Aspect", value: aspect.name },
			{ label: "Weight", value: aspect.weight.toFixed(2) },
			{ label: "Attributes", value: String(aspect.attributes.length) },
			{ label: "Strongest", value: topAttributes || "None indexed" },
		],
		x: parent.x + Math.cos(angle) * radius,
		y: parent.y + Math.sin(angle) * radius,
		data: aspect,
	};
}

function toAttributeNode(parent: KnowledgeMapNode, attribute: ConstellationAttribute, index: number): KnowledgeMapNode {
	const angle = index * GOLDEN_ANGLE + stableUnit(attribute.id, "attribute") * 0.65;
	const radius = 96 + stableUnit(attribute.id, "attribute-r") * 34;
	return {
		id: `attribute:${attribute.id}`,
		kind: "attribute",
		label: truncate(attribute.content, 58),
		searchText: attribute.content,
		sublabel: attribute.kind,
		preview: attribute.content,
		parentId: parent.id,
		status: "current",
		weight: attribute.importance,
		counts: { importance: Math.round(attribute.importance * 100) },
		details: [
			{ label: "Aspect", value: parent.label },
			{ label: "Kind", value: attribute.kind },
			{ label: "Importance", value: `${Math.round(attribute.importance * 100)}%` },
			{ label: "Evidence", value: attribute.memoryId ?? "No memory id" },
		],
		x: parent.x + Math.cos(angle) * radius,
		y: parent.y + Math.sin(angle) * radius,
		data: attribute,
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
		counts: { importance: Math.round(attribute.importance * 100) },
		details: [
			{ label: "Supports", value: parent.label },
			{ label: "Kind", value: attribute.kind },
			{ label: "Memory", value: attribute.memoryId ?? "unknown" },
			{ label: "Claim", value: attribute.content },
		],
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
