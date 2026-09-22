import { UndirectedGraph } from "graphology";
import louvain from "graphology-communities-louvain";
import type { ReadDb, WriteDb } from "../db-accessor";

export interface ClusterResult {
	readonly communities: number;
	readonly modularity: number;
	readonly quality: "fragmented" | "moderate" | "strong";
	readonly members: ReadonlyArray<{
		readonly id: string;
		readonly name: string | null;
		readonly count: number;
		readonly cohesion: number;
	}>;
}

interface EntityRow {
	readonly id: string;
	readonly name: string;
	readonly mentions: number | null;
}

interface DepRow {
	readonly source_entity_id: string;
	readonly target_entity_id: string;
	readonly strength: number;
	readonly confidence: number | null;
}

export function buildEntityGraph(db: ReadDb, agentId: string): UndirectedGraph {
	const graph = new UndirectedGraph();

	const entities = db
		.prepare("SELECT id, name, mentions FROM entities WHERE agent_id = ?")
		.all(agentId) as ReadonlyArray<EntityRow>;

	for (const e of entities) {
		graph.addNode(e.id, { name: e.name, mentions: e.mentions ?? 0 });
	}

	const deps = db
		.prepare(
			`SELECT source_entity_id, target_entity_id, strength,
					COALESCE(confidence, 0.7) AS confidence
			 FROM entity_dependencies
			 WHERE agent_id = ?`,
		)
		.all(agentId) as ReadonlyArray<DepRow>;

	for (const d of deps) {
		if (!graph.hasNode(d.source_entity_id)) continue;
		if (!graph.hasNode(d.target_entity_id)) continue;
		if (d.source_entity_id === d.target_entity_id) continue;

		const weight = d.strength * (d.confidence ?? 0.7);
		const edgeKey = graph.hasEdge(d.source_entity_id, d.target_entity_id)
			? graph.edge(d.source_entity_id, d.target_entity_id)
			: undefined;
		if (edgeKey) {
			const existing = Number(graph.getEdgeAttribute(edgeKey, "weight"));
			if (weight > existing) {
				graph.setEdgeAttribute(edgeKey, "weight", weight);
			}
		} else {
			graph.addEdge(d.source_entity_id, d.target_entity_id, { weight });
		}
	}

	return graph;
}
export function detectCommunities(
	graph: UndirectedGraph,
	resolution = 1.0,
): { mapping: Map<string, number>; modularity: number } {
	if (graph.order === 0) return { mapping: new Map(), modularity: 0 };

	const result = louvain.detailed(graph, {
		resolution,
		getEdgeWeight: "weight",
	});

	return {
		mapping: new Map(Object.entries(result.communities)),
		modularity: result.modularity,
	};
}

function qualityLabel(modularity: number): "fragmented" | "moderate" | "strong" {
	if (modularity > 0.6) return "strong";
	if (modularity >= 0.3) return "moderate";
	return "fragmented";
}

export function persistCommunities(
	db: WriteDb,
	agentId: string,
	communities: Map<string, number>,
	graph: UndirectedGraph,
): ReadonlyArray<{
	readonly id: string;
	readonly name: string | null;
	readonly count: number;
	readonly cohesion: number;
}> {
	const groups = new Map<number, string[]>();
	for (const [nodeId, community] of communities) {
		const existing = groups.get(community);
		if (existing) {
			existing.push(nodeId);
		} else {
			groups.set(community, [nodeId]);
		}
	}
	db.prepare("DELETE FROM entity_communities WHERE agent_id = ?").run(agentId);
	db.prepare("UPDATE entities SET community_id = NULL WHERE agent_id = ?").run(agentId);

	const insertCommunity = db.prepare(
		`INSERT INTO entity_communities (id, agent_id, name, cohesion, member_count, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
	);

	const updateEntity = db.prepare("UPDATE entities SET community_id = ? WHERE id = ? AND agent_id = ?");

	const result: Array<{
		readonly id: string;
		readonly name: string | null;
		readonly count: number;
		readonly cohesion: number;
	}> = [];

	for (const [communityNum, nodeIds] of groups) {
		const communityId = `community_${agentId}_${communityNum}`;
		let bestName: string | null = null;
		let bestMentions = -1;
		for (const nodeId of nodeIds) {
			if (!graph.hasNode(nodeId)) continue;
			const mentions = Number(graph.getNodeAttribute(nodeId, "mentions") ?? 0);
			if (mentions > bestMentions) {
				bestMentions = mentions;
				bestName = String(graph.getNodeAttribute(nodeId, "name") ?? "");
			}
		}
		const cohesion = computeCohesion(graph, nodeIds);

		insertCommunity.run(communityId, agentId, bestName, cohesion, nodeIds.length);

		for (const nodeId of nodeIds) {
			updateEntity.run(communityId, nodeId, agentId);
		}

		result.push({
			id: communityId,
			name: bestName,
			count: nodeIds.length,
			cohesion,
		});
	}

	return result;
}
function computeCohesion(graph: UndirectedGraph, nodeIds: ReadonlyArray<string>): number {
	const n = nodeIds.length;
	if (n < 2) return 0;

	const nodeSet = new Set(nodeIds);
	let internal = 0;
	for (const nodeId of nodeIds) {
		if (!graph.hasNode(nodeId)) continue;
		graph.forEachNeighbor(nodeId, (neighbor) => {
			if (nodeSet.has(neighbor)) internal++;
		});
	}
	internal = internal / 2;

	const maxEdges = (n * (n - 1)) / 2;
	return maxEdges > 0 ? internal / maxEdges : 0;
}
export function clusterEntities(db: WriteDb, agentId: string, resolution = 1.0): ClusterResult {
	const graph = buildEntityGraph(db, agentId);

	if (graph.order === 0) {
		return {
			communities: 0,
			modularity: 0,
			quality: "fragmented",
			members: [],
		};
	}

	const { mapping, modularity } = detectCommunities(graph, resolution);
	const members = persistCommunities(db, agentId, mapping, graph);

	return {
		communities: members.length,
		modularity,
		quality: qualityLabel(modularity),
		members,
	};
}
