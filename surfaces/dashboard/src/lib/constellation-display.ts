import type { GraphSceneData } from "./graph-scene";

export const MAX_CONSTELLATION_ENTITY_LIMIT = 300;
export const MAX_VISIBLE_CONSTELLATION_NODES = 5_000;

export function graphEvidenceRefs(provenance: {
	readonly memoryId?: string | null;
	readonly sourceId: string | null;
	readonly sourceKind: string | null;
	readonly sourcePath: string | null;
}): string[] {
	return [
		...(provenance.memoryId ? [`memory:${provenance.memoryId}`] : []),
		...(provenance.sourceId
			? [`source:${provenance.sourceId}`, `${provenance.sourceKind}:${provenance.sourceId}`]
			: []),
		...(provenance.sourcePath ? [`artifact:${provenance.sourcePath}`] : []),
	];
}

export interface CappedGraphSceneData {
	readonly data: GraphSceneData;
	readonly capped: boolean;
}

export function capGraphSceneData(
	data: GraphSceneData,
	maxNodes = MAX_VISIBLE_CONSTELLATION_NODES,
): CappedGraphSceneData {
	if (!Number.isSafeInteger(maxNodes) || maxNodes < 0) {
		throw new RangeError("Graph node limit must be a non-negative safe integer");
	}

	const primaryNodes = data.nodes.filter((node) => node.kind === "entity" || node.kind === "source");
	const rank = (kind: string) =>
		kind === "aspect"
			? 1
			: kind === "group"
				? 2
				: kind === "claimSlot"
					? 3
					: kind === "origin" || kind === "memory"
						? 5
						: 4;
	const secondaryNodes = data.nodes
		.filter((node) => node.kind !== "entity" && node.kind !== "source")
		.sort((a, b) => rank(a.kind) - rank(b.kind));
	const nodes = primaryNodes.slice(0, maxNodes);
	if (nodes.length < maxNodes) nodes.push(...secondaryNodes.slice(0, maxNodes - nodes.length));
	const visibleIds = new Set(nodes.map((node) => node.id));
	const edges = data.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));

	return {
		data: { nodes, edges },
		capped: data.nodes.length > nodes.length,
	};
}

export function sourceDocumentTitle(name: string): string {
	const title = name.split(" — ")[0]?.trim();
	return title || name;
}
