import type { GraphSceneData } from "./graph-scene";

export const MAX_CONSTELLATION_ENTITY_LIMIT = 300;
export const MAX_VISIBLE_CONSTELLATION_NODES = 5_000;

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
	const secondaryNodes = data.nodes.filter((node) => node.kind !== "entity" && node.kind !== "source");
	const nodes = primaryNodes.slice(0, maxNodes);
	if (nodes.length < maxNodes) nodes.push(...secondaryNodes.slice(0, maxNodes - nodes.length));
	const visibleIds = new Set(nodes.map((node) => node.id));
	const edges = data.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));

	return {
		data: { nodes, edges },
		capped: data.nodes.length > nodes.length,
	};
}
