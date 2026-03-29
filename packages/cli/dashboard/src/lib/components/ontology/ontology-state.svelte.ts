/**
 * Shared reactive state for the Ontology diagnostic dashboard.
 * Selection, hover, filter state, and live data from the daemon API.
 */

import type {
	ConstellationEntity,
	ConstellationGraph,
	KnowledgeEntityDetail,
	KnowledgeAspectWithCounts,
	KnowledgeAttribute,
	KnowledgeDependencyEdge,
	ProjectionResponse,
} from "$lib/api";
import {
	getConstellationOverlay,
	getKnowledgeEntity,
	getKnowledgeAspects,
	getKnowledgeAttributes,
	getKnowledgeDependencies,
	getKnowledgeStats,
	getMemories,
	getEmbeddings,
	getProjection,
	type KnowledgeStats,
} from "$lib/api";
import {
	buildGraphFromConstellation,
	relatedIdsForEntity,
	TABLE_NODE_FILTER,
	TABLE_EDGE_FILTER,
	DEFAULT_NODE_FILTER,
	DEFAULT_EDGE_FILTER,
	type OntologyNode,
	type OntologyEdge,
	type OntologyNodeKind,
	type OntologyEdgeKind,
} from "./ontology-data";

export interface SelectedNode {
	id: string;
	kind: OntologyNodeKind;
}

export const ontology = $state({
	/** Currently selected node */
	selected: null as SelectedNode | null,

	/** Currently hovered node */
	hovered: null as SelectedNode | null,

	/** Selected schema table name in Zone A */
	schemaTable: "entities" as string,

	/** Filter: search query (FTS) */
	filterQuery: "" as string,

	/** IDs matching the current search (null = no search active) */
	searchMatchIds: null as Set<string> | null,
	/** Increments on every searchMatchIds write so filter effects see distinct keys */
	searchEpoch: 0,
	searching: false,

	/** Visible edge/node kinds on graph (driven by schema table selection) */
	visibleEdgeKinds: new Set(["dependency"]) as Set<string>,
	visibleNodeKinds: new Set(["entity"]) as Set<OntologyNodeKind>,

	/** IDs related to current selection (aspects, attributes, dep neighbors) */
	relatedIds: new Set<string>() as Set<string>,

	// --- Live data ---

	/** Graph nodes/edges built from constellation API */
	graphNodes: [] as OntologyNode[],
	graphEdges: [] as OntologyEdge[],

	/** Raw constellation entities (for inspector lookups) */
	entities: [] as ConstellationEntity[],

	/** Graph loading state */
	loading: false,
	error: null as string | null,

	/** Inspector detail (loaded on entity selection) */
	detail: null as KnowledgeEntityDetail | null,
	detailAspects: [] as KnowledgeAspectWithCounts[],
	detailAttributes: new Map() as Map<string, KnowledgeAttribute[]>,
	detailDependencies: [] as KnowledgeDependencyEdge[],
	loadingDetail: false,

	/** Inspector: aspect attributes (loaded on aspect/attribute selection) */
	aspectAttrs: [] as KnowledgeAttribute[],
	loadingAspect: false,

	/** Projection data for UMAP panel */
	projection: null as ProjectionResponse | null,
	loadingProjection: false,

	/** Schema table stats (loaded on table click) */
	tableStats: null as { table: string; rows: number; extra?: Record<string, unknown> } | null,
	loadingTable: false,
});

// --- Graph data ---

let graphGeneration = 0;

export async function loadGraph(agentId = "default"): Promise<void> {
	const gen = ++graphGeneration;
	ontology.loading = true;
	ontology.error = null;
	// Clear immediately so the canvas doesn't show stale cross-agent data
	ontology.graphNodes = [];
	ontology.graphEdges = [];
	ontology.entities = [];
	ontology.selected = null;
	ontology.hovered = null;
	ontology.relatedIds = new Set();
	ontology.filterQuery = "";
	ontology.searchMatchIds = null;
	ontology.searching = false;
	// Cancel any pending debounced search and invalidate in-flight callbacks
	if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
	searchGeneration++;
	ontology.tableStats = null;
	try {
		const data = await getConstellationOverlay(agentId);
		if (gen !== graphGeneration) return;
		if (!data) {
			ontology.error = "Could not reach daemon";
			ontology.graphNodes = [];
			ontology.graphEdges = [];
			ontology.entities = [];
			return;
		}
		const { nodes, edges } = buildGraphFromConstellation(data);
		ontology.graphNodes = nodes;
		ontology.graphEdges = edges;
		ontology.entities = data.entities;
		// Reload table stats for the current schema table under the new agent
		loadTableStats(ontology.schemaTable, agentId);
	} catch (err) {
		if (gen !== graphGeneration) return;
		ontology.error = err instanceof Error ? err.message : "Unknown error";
		ontology.graphNodes = [];
		ontology.graphEdges = [];
		ontology.entities = [];
	} finally {
		if (gen === graphGeneration) ontology.loading = false;
	}
}

// --- FTS search (debounced) ---

let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchGeneration = 0;

export function searchGraph(query: string, delay = 250): void {
	ontology.filterQuery = query;

	if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }

	if (!query.trim()) {
		searchGeneration++;
		ontology.searchMatchIds = null;
		ontology.searchEpoch++;
		ontology.searching = false;
		return;
	}

	ontology.searching = true;

	searchTimer = setTimeout(() => {
		const gen = ++searchGeneration;
		const lower = query.toLowerCase();
		const nodes = ontology.graphNodes;
		const map = new Map(nodes.map((n) => [n.id, n]));

		// Phase 1: direct label/content matches
		const matched = new Set<string>();
		for (const n of nodes) {
			const text = (n.searchText ?? n.label).toLowerCase();
			if (text.includes(lower) || n.label.toLowerCase().includes(lower)) matched.add(n.id);
		}

		// Phase 2: expand — parents (walk up) + children (walk down twice for grandchildren)
		const result = new Set(matched);
		for (const id of matched) {
			let pid = map.get(id)?.parentId;
			while (pid) {
				result.add(pid);
				pid = map.get(pid)?.parentId;
			}
		}
		for (const n of nodes) {
			if (n.parentId && result.has(n.parentId)) result.add(n.id);
		}
		for (const n of nodes) {
			if (n.parentId && result.has(n.parentId)) result.add(n.id);
		}

		if (gen !== searchGeneration) return;
		ontology.searchMatchIds = result;
		ontology.searchEpoch++;
		ontology.searching = false;
	}, delay);
}

// --- Inspector detail ---

let detailGeneration = 0;

export async function loadEntityDetail(entityId: string, agentId = "default"): Promise<void> {
	const gen = ++detailGeneration;
	ontology.loadingDetail = true;
	ontology.detail = null;
	ontology.detailAspects = [];
	ontology.detailAttributes = new Map();
	ontology.detailDependencies = [];
	try {
		const [detail, aspects, deps] = await Promise.all([
			getKnowledgeEntity(entityId, agentId),
			getKnowledgeAspects(entityId, agentId),
			getKnowledgeDependencies(entityId, "both", agentId),
		]);
		if (gen !== detailGeneration) return;
		ontology.detail = detail;
		ontology.detailAspects = aspects;
		ontology.detailDependencies = deps;

		// Load attributes for each aspect in parallel
		const attrMap = new Map<string, KnowledgeAttribute[]>();
		if (aspects.length > 0) {
			const results = await Promise.all(
				aspects.map((a) =>
					getKnowledgeAttributes(entityId, a.aspect.id, { agentId }),
				),
			);
			if (gen !== detailGeneration) return;
			for (let i = 0; i < aspects.length; i++) {
				attrMap.set(aspects[i].aspect.id, results[i]);
			}
		}
		ontology.detailAttributes = attrMap;
	} finally {
		if (gen === detailGeneration) ontology.loadingDetail = false;
	}
}

// --- Aspect detail ---

let aspectGeneration = 0;

export async function loadAspectDetail(
	aspectId: string,
	triggeredBy = aspectId,
	agentId = "default",
): Promise<void> {
	const node = ontology.graphNodes.find((n) => n.id === aspectId && n.kind === "aspect");
	if (!node?.parentId) return;

	const gen = ++aspectGeneration;
	ontology.loadingAspect = true;
	ontology.aspectAttrs = [];
	try {
		const attrs = await getKnowledgeAttributes(node.parentId, aspectId, { agentId });
		if (gen !== aspectGeneration) return;
		ontology.aspectAttrs = attrs;
	} finally {
		if (gen === aspectGeneration) ontology.loadingAspect = false;
	}
}

// --- Projection data ---

let projectionGeneration = 0;

export async function loadProjection(agentId = "default"): Promise<void> {
	const gen = ++projectionGeneration;
	ontology.loadingProjection = true;
	ontology.projection = null;
	try {
		const result = await getProjection(2, { limit: 500, agentId });
		if (gen !== projectionGeneration) return;
		ontology.projection = result;
	} finally {
		if (gen === projectionGeneration) ontology.loadingProjection = false;
	}
}

// --- Table stats ---

let tableStatsGeneration = 0;

export async function loadTableStats(table: string, agentId = "default"): Promise<void> {
	const gen = ++tableStatsGeneration;
	ontology.loadingTable = true;
	ontology.tableStats = null;
	try {
		switch (table) {
			case "entities":
			case "entity_aspects":
			case "entity_attributes":
			case "entity_dependencies":
			case "entity_communities": {
				const stats = await getKnowledgeStats(agentId);
				if (gen !== tableStatsGeneration) break;
				if (!stats) break;
				const map: Record<string, number> = {
					entities: stats.entityCount,
					entity_aspects: stats.aspectCount,
					entity_attributes: stats.attributeCount + stats.constraintCount,
					entity_dependencies: stats.dependencyCount,
					entity_communities: 0,
				};
				ontology.tableStats = {
					table,
					rows: map[table] ?? 0,
					extra: stats as unknown as Record<string, unknown>,
				};
				break;
			}
			case "memories":
			case "memory_entity_mentions": {
				const { stats } = await getMemories(1, 0, agentId);
				if (gen !== tableStatsGeneration) break;
				// memory_entity_mentions count is not returned by the memories endpoint;
				// report -1 (unknown) rather than a false zero
				ontology.tableStats = {
					table,
					rows: table === "memories" ? stats.total : -1,
					extra: stats as unknown as Record<string, unknown>,
				};
				break;
			}
			case "embeddings": {
				const data = await getEmbeddings(false, { limit: 1, agentId });
				if (gen !== tableStatsGeneration) break;
				ontology.tableStats = { table, rows: data.total };
				break;
			}
			default:
				ontology.tableStats = { table, rows: -1 };
		}
	} finally {
		if (gen === tableStatsGeneration) ontology.loadingTable = false;
	}
}

// --- Selection helpers ---

export function selectNode(id: string, kind: OntologyNodeKind): void {
	ontology.selected = { id, kind };
	ontology.tableStats = null;

	if (kind === "entity") {
		ontology.relatedIds = relatedIdsForEntity(id, ontology.graphNodes, ontology.graphEdges);
		return;
	}

	if (kind === "aspect") {
		const related = new Set<string>();
		const node = ontology.graphNodes.find((n) => n.id === id && n.kind === "aspect");
		if (node?.parentId) related.add(node.parentId);
		for (const n of ontology.graphNodes) {
			if (n.kind === "attribute" && n.parentId === id) related.add(n.id);
		}
		ontology.relatedIds = related;
		return;
	}

	if (kind === "attribute") {
		const related = new Set<string>();
		const node = ontology.graphNodes.find((n) => n.id === id && n.kind === "attribute");
		if (node?.parentId) {
			related.add(node.parentId);
			const parent = ontology.graphNodes.find((n) => n.id === node.parentId);
			if (parent?.parentId) related.add(parent.parentId);
		}
		ontology.relatedIds = related;
		return;
	}

	ontology.relatedIds = new Set();
}

export function clearSelection(): void {
	ontology.selected = null;
	ontology.relatedIds = new Set();
}

export function hoverNode(id: string, kind: OntologyNodeKind): void {
	ontology.hovered = { id, kind };
}

export function clearHover(): void {
	ontology.hovered = null;
}

export function selectSchemaTable(name: string, agentId = "default"): void {
	ontology.schemaTable = name;
	ontology.selected = null;
	ontology.relatedIds = new Set();

	// Update graph visibility based on table
	ontology.visibleNodeKinds = new Set(
		TABLE_NODE_FILTER[name] ?? DEFAULT_NODE_FILTER,
	) as Set<OntologyNodeKind>;
	ontology.visibleEdgeKinds = new Set(
		TABLE_EDGE_FILTER[name] ?? DEFAULT_EDGE_FILTER,
	) as Set<string>;

	loadTableStats(name, agentId);
}

export function toggleEdgeKind(kind: string): void {
	if (ontology.visibleEdgeKinds.has(kind)) {
		ontology.visibleEdgeKinds.delete(kind);
	} else {
		ontology.visibleEdgeKinds.add(kind);
	}
	ontology.visibleEdgeKinds = new Set(ontology.visibleEdgeKinds);
}

export function toggleNodeKind(kind: OntologyNodeKind): void {
	if (ontology.visibleNodeKinds.has(kind)) {
		ontology.visibleNodeKinds.delete(kind);
	} else {
		ontology.visibleNodeKinds.add(kind);
	}
	ontology.visibleNodeKinds = new Set(ontology.visibleNodeKinds);
}
