import type {
	ConstellationAspect,
	ConstellationAttribute,
	ConstellationEntity,
	ConstellationGraph,
	ConstellationProposal,
} from "$lib/api";
import { summarizeOntologyText } from "../../issue-848-format";

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

const DEFAULT_LIMIT = 600;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const PRIMARY_ENTITY_TYPES = new Set([
	"person",
	"project",
	"topic",
	"system",
	"product",
	"organization",
	"org",
	"source",
	"artifact",
	"agent",
	"policy",
	"action",
	"workflow",
	"event",
	"object_type",
	"interface",
	"observation",
	"claim_slot",
	"claim_value",
]);
const NOISY_ENTITY_TYPES = new Set(["benchmark", "run", "file", "chunk", "unknown"]);

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
		.slice(0, Math.max(1, limit));

	const nodes: KnowledgeMapNode[] = [];
	const edges: KnowledgeMapEdge[] = [];
	const includedEntityIds = new Set<string>();
	const entityNodes = new Map<string, KnowledgeMapNode>();
	const aspectNodesByEntityPath = new Map<string, KnowledgeMapNode>();
	const aspectRecords: Array<{
		readonly aspect: ConstellationAspect;
		readonly node: KnowledgeMapNode;
	}> = [];
	const attributeRecords: Array<{
		readonly attribute: ConstellationAttribute;
		readonly node: KnowledgeMapNode;
	}> = [];

	let entityIndex = 0;
	for (const entity of entities) {
		if (nodes.length >= limit) break;
		const entityNode = toEntityNode(entity, entityIndex++, entities.length);
		nodes.push(entityNode);
		entityNodes.set(entity.id, entityNode);
		includedEntityIds.add(entity.id);
	}
	normalizeEntityScales(nodes);

	const maxAspectCount = entities.reduce((max, entity) => Math.max(max, entity.aspects.length), 0);
	for (let aspectIndex = 0; aspectIndex < maxAspectCount; aspectIndex++) {
		for (const entity of entities) {
			if (nodes.length >= limit) break;
			const entityNode = entityNodes.get(entity.id);
			if (!entityNode) continue;
			const aspects = entity.aspects.toSorted((a, b) => aspectScore(b) - aspectScore(a));
			const aspect = aspects[aspectIndex];
			if (!aspect) continue;
			const aspectNode = toAspectNode(entityNode, aspect, aspectIndex, aspects.length);
			nodes.push(aspectNode);
			aspectRecords.push({ aspect, node: aspectNode });
			aspectNodesByEntityPath.set(`${entity.id}:${canonical(aspect.name)}`, aspectNode);
			edges.push({
				id: `has_aspect:${entity.id}:${aspectNode.id}`,
				source: entity.id,
				target: aspectNode.id,
				label: "aspect",
				kind: "has_aspect",
				strength: 0.58,
			});
		}
	}

	const maxAttributeCount = aspectRecords.reduce(
		(max, record) => Math.max(max, sortedAttributes(record.aspect).length),
		0,
	);
	for (let attributeIndex = 0; attributeIndex < maxAttributeCount; attributeIndex++) {
		for (const record of aspectRecords) {
			if (nodes.length >= limit) break;
			const attributes = sortedAttributes(record.aspect);
			const attribute = attributes[attributeIndex];
			if (!attribute) continue;
			const attributeNode = toAttributeNode(record.node, attribute, attributeIndex, attributes.length);
			nodes.push(attributeNode);
			attributeRecords.push({ attribute, node: attributeNode });
			edges.push({
				id: `has_attribute:${record.node.id}:${attributeNode.id}`,
				source: record.node.id,
				target: attributeNode.id,
				label: attribute.kind,
				kind: "has_attribute",
				strength: 0.66,
			});
		}
	}

	for (const record of attributeRecords) {
		if (!record.attribute.memoryId || nodes.length >= limit) continue;
		const memoryNode = toMemoryNode(record.node, record.attribute);
		nodes.push(memoryNode);
		edges.push({
			id: `supports:${memoryNode.id}:${record.node.id}`,
			source: memoryNode.id,
			target: record.node.id,
			label: "evidence",
			kind: "supports",
			strength: 0.64,
		});
	}

	for (const proposal of sortedProposals(graph.proposals ?? [])) {
		if (nodes.length >= limit) break;
		const target = proposalTarget(proposal, entityNodes, aspectNodesByEntityPath);
		if (!target && nodes.length >= Math.floor(limit * 0.95)) continue;
		const proposalNode = toProposalNode(proposal, target, nodes.length);
		nodes.push(proposalNode);
		if (target) {
			edges.push({
				id: `updates:${proposal.id}:${target.id}`,
				source: proposalNode.id,
				target: target.id,
				label: proposal.operation,
				kind: "updates",
				strength: Math.max(0.35, proposal.confidence),
			});
		}
	}

	const dreaming = graph.metadata?.dreaming;
	if (
		dreaming &&
		nodes.length < limit &&
		(dreaming.latestPass || dreaming.lastPassId || dreaming.tokensSinceLastPass > 0)
	) {
		const target = entityNodes.values().next().value ?? null;
		const dreamingNode = toDreamingNode(dreaming, target);
		nodes.push(dreamingNode);
		if (target) {
			edges.push({
				id: `updates:${dreamingNode.id}:${target.id}`,
				source: dreamingNode.id,
				target: target.id,
				label: "dreaming",
				kind: "updates",
				strength: 0.42,
				visualOnly: true,
			});
		}
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
			visualOnly: true,
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
	return Math.max(1, Math.min(Math.floor(value), 2200));
}

function includeEntity(entity: ConstellationEntity): boolean {
	const type = entity.entityType.toLowerCase();
	if (entity.aspects.length === 0) return false;
	if (entity.pinned) return true;
	if (looksNoisy(entity.name)) return false;
	if (PRIMARY_ENTITY_TYPES.has(type)) return true;
	if (NOISY_ENTITY_TYPES.has(type)) return false;
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

function sortedAttributes(aspect: ConstellationAspect): ConstellationAttribute[] {
	return aspect.attributes
		.filter((item) => item.content.trim().length > 0)
		.toSorted((a, b) => b.importance - a.importance);
}

function toEntityNode(entity: ConstellationEntity, index: number, total: number): KnowledgeMapNode {
	const radius = 320 + Math.sqrt(index + 1) * 88;
	const angle = index * GOLDEN_ANGLE + (total > 1 ? 0 : 0.35);
	const attributeCount = entity.aspects.reduce((sum, aspect) => sum + aspect.attributes.length, 0);
	const influence = entityInfluence(entity, attributeCount);
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
		status: entity.proposalId ? "review" : "current",
		weight: entityScore(entity),
		counts: {
			mentions: entity.mentions,
			aspects: entity.aspects.length,
			attributes: attributeCount,
			influence,
			scale: 0,
		},
		details: [
			{ label: "Type", value: entity.entityType },
			{ label: "Mentions", value: String(entity.mentions) },
			{ label: "Aspects", value: String(entity.aspects.length) },
			...(entity.proposalId ? [{ label: "Proposal", value: entity.proposalId }] : []),
			{ label: "Strongest", value: topAspects || "None indexed" },
		],
		x: Math.cos(angle) * radius,
		y: Math.sin(angle) * radius,
		data: entity,
	};
}

function entityInfluence(entity: ConstellationEntity, attributeCount: number): number {
	return Math.log2(entity.mentions + 1) * 1.85 + entity.aspects.length * 1.45 + Math.sqrt(attributeCount) * 1.7;
}

function normalizeEntityScales(nodes: KnowledgeMapNode[]): void {
	const entities = nodes.filter((node) => node.kind === "entity");
	if (entities.length === 0) return;
	const scores = entities.map((node) => node.counts?.influence ?? 0).toSorted((a, b) => a - b);
	const low = percentile(scores, 0.58);
	const high = Math.max(percentile(scores, 0.96), low + 1);
	for (const node of entities) {
		const normalized = clamp01(((node.counts?.influence ?? 0) - low) / (high - low));
		const scale = normalized ** 2.15;
		node.counts = { ...node.counts, scale };
	}
}

function percentile(sorted: readonly number[], position: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * position)));
	return sorted[index] ?? 0;
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(value, 1));
}

function toAspectNode(
	parent: KnowledgeMapNode,
	aspect: ConstellationAspect,
	index: number,
	total: number,
): KnowledgeMapNode {
	const parentScale = Math.max(0, Math.min(parent.counts?.scale ?? 0, 1));
	const point = orbitPoint({
		index,
		total,
		baseRadius: 250 + parentScale * 170,
		ringStep: 128,
		minArc: 176,
		offset: -Math.PI / 2 + stableUnit(parent.id, "aspect-offset") * 0.28,
	});
	const angle = point.angle;
	const radius = point.radius;
	const topAttributes = aspect.attributes
		.toSorted((a, b) => b.importance - a.importance)
		.slice(0, 3)
		.map((attribute) => summarizeOntologyText(attribute.content, 96))
		.join(" / ");
	return {
		id: `aspect:${aspect.id}`,
		kind: "aspect",
		label: aspect.name,
		searchText: `${aspect.name} ${topAttributes}`,
		sublabel: "aspect",
		preview: topAttributes || "No attributes indexed for this aspect yet.",
		parentId: parent.id,
		status: aspect.proposalId ? "review" : "current",
		weight: aspect.weight,
		counts: { attributes: aspect.attributes.length, laneAngle: angle, laneIndex: index, laneRing: point.ring },
		details: [
			{ label: "Entity", value: parent.label },
			{ label: "Aspect", value: aspect.name },
			{ label: "Weight", value: aspect.weight.toFixed(2) },
			{ label: "Attributes", value: String(aspect.attributes.length) },
			...(aspect.proposalId ? [{ label: "Proposal", value: aspect.proposalId }] : []),
			{ label: "Strongest", value: topAttributes || "None indexed" },
		],
		x: parent.x + Math.cos(angle) * radius,
		y: parent.y + Math.sin(angle) * radius,
		data: aspect,
	};
}

function toAttributeNode(
	parent: KnowledgeMapNode,
	attribute: ConstellationAttribute,
	index: number,
	total: number,
): KnowledgeMapNode {
	const point = orbitPoint({
		index,
		total,
		baseRadius: 154,
		ringStep: 94,
		minArc: 142,
		offset: stableUnit(parent.id, "attribute-offset") * Math.PI * 2,
	});
	const angle = numericCount(parent, "laneAngle") ?? point.angle;
	const columns = total > 36 ? 6 : total > 18 ? 5 : total > 8 ? 4 : 3;
	const row = Math.floor(index / columns);
	const column = index % columns;
	const finalColumns = Math.min(columns, total - row * columns);
	const center = (finalColumns - 1) / 2;
	const tangentOffset = (column - center) * 86;
	const radius = 150 + row * 98;
	const tangent = angle + Math.PI / 2;
	return {
		id: `attribute:${attribute.id}`,
		kind: "attribute",
		label: truncate(summarizeOntologyText(attribute.content, 96), 58),
		searchText: attribute.content,
		sublabel: attribute.kind,
		preview: summarizeOntologyText(attribute.content),
		parentId: parent.id,
		status: attribute.proposalId ? "review" : attribute.status === "deleted" ? "forgotten" : "current",
		weight: attribute.importance,
		counts: {
			importance: Math.round(attribute.importance * 100),
			version: attribute.version ?? 1,
			proposalEvidence: attribute.proposalEvidenceCount ?? 0,
			laneAngle: angle,
			laneRow: row,
			laneColumn: column,
		},
		details: [
			{ label: "Aspect", value: parent.label },
			{ label: "Kind", value: attribute.kind },
			{ label: "Importance", value: `${Math.round(attribute.importance * 100)}%` },
			{ label: "Version", value: `v${attribute.version ?? 1}` },
			...(attribute.groupKey ? [{ label: "Group", value: attribute.groupKey }] : []),
			...(attribute.claimKey ? [{ label: "Claim", value: attribute.claimKey }] : []),
			...(attribute.sourceKind ? [{ label: "Source", value: attribute.sourcePath ?? attribute.sourceKind }] : []),
			...(attribute.proposalId ? [{ label: "Proposal", value: attribute.proposalId }] : []),
			{ label: "Evidence", value: attribute.memoryId ?? "No memory id" },
		],
		x: parent.x + Math.cos(angle) * radius + Math.cos(tangent) * tangentOffset,
		y: parent.y + Math.sin(angle) * radius + Math.sin(tangent) * tangentOffset,
		data: attribute,
	};
}

function sortedProposals(proposals: readonly ConstellationProposal[]): ConstellationProposal[] {
	return [...proposals]
		.filter((proposal) => proposal.id.trim().length > 0)
		.toSorted((a, b) => b.confidence - a.confidence || b.evidenceCount - a.evidenceCount);
}

function proposalTarget(
	proposal: ConstellationProposal,
	entities: ReadonlyMap<string, KnowledgeMapNode>,
	aspects: ReadonlyMap<string, KnowledgeMapNode>,
): KnowledgeMapNode | null {
	if (!proposal.targetEntityId) return null;
	const aspectName = proposal.targetAspectName?.trim();
	if (aspectName) {
		const aspect = aspects.get(`${proposal.targetEntityId}:${canonical(aspectName)}`);
		if (aspect) return aspect;
	}
	return entities.get(proposal.targetEntityId) ?? null;
}

function toProposalNode(
	proposal: ConstellationProposal,
	target: KnowledgeMapNode | null,
	index: number,
): KnowledgeMapNode {
	const angle = stableUnit(proposal.id, "proposal") * Math.PI * 2;
	const targetRadius = target ? 136 + stableUnit(proposal.id, "proposal-r") * 46 : 620 + index * 14;
	const x = target ? target.x + Math.cos(angle) * targetRadius : Math.cos(angle) * targetRadius;
	const y = target ? target.y + Math.sin(angle) * targetRadius : Math.sin(angle) * targetRadius;
	const preview = proposal.preview ?? proposal.rationale;
	return {
		id: `proposal:${proposal.id}`,
		kind: "proposal",
		label: operationLabel(proposal.operation),
		searchText: `${proposal.operation} ${proposal.targetEntityName ?? ""} ${proposal.targetAspectName ?? ""} ${preview}`,
		sublabel: proposal.targetEntityName ?? "pending",
		preview: preview || "Pending ontology operation",
		parentId: target?.id,
		status: "review",
		weight: proposal.confidence,
		counts: {
			confidence: Math.round(proposal.confidence * 100),
			evidence: proposal.evidenceCount,
		},
		details: [
			{ label: "Operation", value: operationLabel(proposal.operation) },
			{ label: "Confidence", value: `${Math.round(proposal.confidence * 100)}%` },
			{ label: "Evidence", value: String(proposal.evidenceCount) },
			...(proposal.targetEntityName ? [{ label: "Target", value: proposal.targetEntityName }] : []),
			...(proposal.targetAspectName ? [{ label: "Aspect", value: proposal.targetAspectName }] : []),
			...(proposal.sourceKind ? [{ label: "Source", value: proposal.sourcePath ?? proposal.sourceKind }] : []),
		],
		x,
		y,
		data: proposal,
	};
}

function operationLabel(operation: string): string {
	return operation
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

function toDreamingNode(
	dreaming: NonNullable<ConstellationGraph["metadata"]>["dreaming"],
	target: KnowledgeMapNode | null,
): KnowledgeMapNode {
	const latest = dreaming.latestPass;
	const id = `dreaming:${latest?.id ?? dreaming.lastPassId ?? "queued"}`;
	const applied = latest?.mutationsApplied ?? 0;
	const skipped = latest?.mutationsSkipped ?? 0;
	const failed = latest?.mutationsFailed ?? 0;
	const status = latest
		? `${latest.status} ${latest.mode}`
		: `${formatCount(dreaming.tokensSinceLastPass)} tokens queued`;
	const x = target ? target.x - 260 : -260;
	const y = target ? target.y - 220 : -220;
	return {
		id,
		kind: "session",
		label: "Dreaming",
		searchText: `dreaming ${status} ${dreaming.lastPassMode ?? ""}`,
		sublabel: status,
		preview: latest
			? `${applied} applied / ${skipped} skipped / ${failed} failed`
			: `${formatCount(dreaming.tokensSinceLastPass)} summary tokens queued for consolidation`,
		status: failed > 0 || dreaming.consecutiveFailures > 0 ? "conflict" : "current",
		weight: latest ? Math.min(1, Math.max(0.2, (applied + skipped + failed) / 12)) : 0.35,
		counts: {
			applied,
			skipped,
			failed,
			tokens: dreaming.tokensSinceLastPass,
		},
		details: [
			{ label: "Status", value: status },
			{ label: "Tokens", value: formatCount(dreaming.tokensSinceLastPass) },
			...(dreaming.lastPassAt ? [{ label: "Last pass", value: dreaming.lastPassAt }] : []),
			...(latest ? [{ label: "Mutations", value: `${applied} / ${skipped} / ${failed}` }] : []),
		],
		x,
		y,
		data: dreaming,
	};
}

function formatCount(value: number): string {
	return Intl.NumberFormat(undefined, { notation: value >= 10000 ? "compact" : "standard" }).format(value);
}

function canonical(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function numericCount(node: KnowledgeMapNode, key: string): number | null {
	const value = node.counts?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function orbitPoint(opts: {
	index: number;
	total: number;
	baseRadius: number;
	ringStep: number;
	minArc: number;
	offset: number;
}): { radius: number; angle: number; ring: number } {
	let consumed = 0;
	let ring = 0;
	while (true) {
		const radius = opts.baseRadius + ring * opts.ringStep;
		const capacity = Math.max(5, Math.floor((Math.PI * 2 * radius) / opts.minArc));
		const ringIndex = opts.index - consumed;
		if (ringIndex < capacity) {
			const count = Math.min(capacity, opts.total - consumed);
			return {
				radius,
				angle: opts.offset + (Math.PI * 2 * ringIndex) / Math.max(count, 1),
				ring,
			};
		}
		consumed += capacity;
		ring += 1;
	}
}

function toMemoryNode(parent: KnowledgeMapNode, attribute: ConstellationAttribute): KnowledgeMapNode {
	const angle = numericCount(parent, "laneAngle") ?? stableUnit(attribute.id, "memory") * Math.PI * 2;
	const row = numericCount(parent, "laneRow") ?? 0;
	const column = numericCount(parent, "laneColumn") ?? 0;
	const tangent = angle + Math.PI / 2;
	const side = column % 2 === 0 ? 1 : -1;
	const radius = 70 + (row % 2) * 12;
	const tangentOffset = side * 28;
	return {
		id: `memory:${attribute.memoryId ?? attribute.id}:${attribute.id}`,
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
		x: parent.x + Math.cos(angle) * radius + Math.cos(tangent) * tangentOffset,
		y: parent.y + Math.sin(angle) * radius + Math.sin(tangent) * tangentOffset,
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
