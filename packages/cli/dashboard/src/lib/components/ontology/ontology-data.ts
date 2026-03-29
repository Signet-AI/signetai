/**
 * Schema registry and graph types for the Ontology diagnostic dashboard.
 *
 * Row types follow exact SQLite column names from the migrations in
 * packages/core/src/migrations/. Graph data is fetched from the daemon API.
 */

import type {
	ConstellationGraph,
	ConstellationEntity,
} from "$lib/api";

// ---------------------------------------------------------------------------
// Schema table registry (grouped by conceptual layer)
// ---------------------------------------------------------------------------

export type SchemaGroup = "core" | "provenance" | "runtime" | "internal";

export interface SchemaTable {
	name: string;
	group: SchemaGroup;
	rowHint?: number;
}

const CORE_TABLES: readonly SchemaTable[] = [
	{ name: "entities", group: "core" },
	{ name: "memories", group: "core" },
	{ name: "memory_entity_mentions", group: "core" },
	{ name: "relations", group: "core" },
	{ name: "entity_aspects", group: "core" },
	{ name: "entity_attributes", group: "core" },
	{ name: "entity_dependencies", group: "core" },
	{ name: "entity_communities", group: "core" },
];

const PROVENANCE_TABLES: readonly SchemaTable[] = [
	{ name: "documents", group: "provenance" },
	{ name: "document_memories", group: "provenance" },
	{ name: "conversations", group: "provenance" },
	{ name: "session_transcripts", group: "provenance" },
	{ name: "session_summaries", group: "provenance" },
	{ name: "session_summary_memories", group: "provenance" },
];

const RUNTIME_TABLES: readonly SchemaTable[] = [
	{ name: "embeddings", group: "runtime" },
	{ name: "vec_embeddings", group: "runtime" },
	{ name: "memory_hints", group: "runtime" },
	{ name: "session_memories", group: "runtime" },
	{ name: "session_scores", group: "runtime" },
	{ name: "umap_cache", group: "runtime" },
	{ name: "predictor_training_runs", group: "runtime" },
	{ name: "path_feedback_events", group: "runtime" },
	{ name: "path_feedback_stats", group: "runtime" },
	{ name: "session_checkpoints", group: "runtime" },
	{ name: "memories_cold", group: "runtime" },
];

const INTERNAL_TABLES: readonly SchemaTable[] = [
	{ name: "entities_fts", group: "internal" },
	{ name: "memories_fts", group: "internal" },
	{ name: "memory_hints_fts", group: "internal" },
];

export const SCHEMA_GROUPS: ReadonlyMap<SchemaGroup, readonly SchemaTable[]> = new Map([
	["core", CORE_TABLES],
	["provenance", PROVENANCE_TABLES],
	["runtime", RUNTIME_TABLES],
	["internal", INTERNAL_TABLES],
]);

export const GROUP_LABELS: Record<SchemaGroup, string> = {
	core: "Ontology Core",
	provenance: "Provenance",
	runtime: "Retrieval / Runtime",
	internal: "Internal / FTS",
};

export function allVisibleTables(): SchemaTable[] {
	return [...CORE_TABLES, ...PROVENANCE_TABLES, ...RUNTIME_TABLES, ...INTERNAL_TABLES];
}

// ---------------------------------------------------------------------------
// Graph node/edge types for the constellation view
// ---------------------------------------------------------------------------

export type OntologyNodeKind = "entity" | "aspect" | "attribute";

export type OntologyEdgeKind = "dependency" | "has_aspect" | "has_attribute";

export interface OntologyNode {
	id: string;
	kind: OntologyNodeKind;
	label: string;
	/** Untruncated content for search matching (may differ from label) */
	searchText?: string;
	sublabel?: string;
	parentId?: string;
	data: unknown;
}

export interface OntologyEdge {
	source: string;
	target: string;
	label: string;
	kind: OntologyEdgeKind;
	strength?: number;
	dashed?: boolean;
}

// ---------------------------------------------------------------------------
// Schema table → graph visibility mapping
// ---------------------------------------------------------------------------

export const TABLE_NODE_FILTER: Record<string, ReadonlySet<OntologyNodeKind>> = {
	entities: new Set(["entity"]),
	entity_aspects: new Set(["entity", "aspect"]),
	entity_attributes: new Set(["entity", "aspect", "attribute"]),
	entity_dependencies: new Set(["entity"]),
	entity_communities: new Set(["entity"]),
};

export const TABLE_EDGE_FILTER: Record<string, ReadonlySet<OntologyEdgeKind>> = {
	entities: new Set(["dependency"]),
	entity_aspects: new Set(["dependency", "has_aspect"]),
	entity_attributes: new Set(["dependency", "has_aspect", "has_attribute"]),
	entity_dependencies: new Set(["dependency"]),
	entity_communities: new Set(["dependency"]),
};

/** Default filters for tables not in the core ontology group */
export const DEFAULT_NODE_FILTER: ReadonlySet<OntologyNodeKind> = new Set(["entity"]);
export const DEFAULT_EDGE_FILTER: ReadonlySet<OntologyEdgeKind> = new Set(["dependency"]);

// ---------------------------------------------------------------------------
// Node colors (theme-consistent)
// ---------------------------------------------------------------------------

export const NODE_COLORS: Record<OntologyNodeKind, string> = {
	entity: "#3b82f6",    // blue
	aspect: "#8b5cf6",    // violet
	attribute: "#06b6d4", // cyan
};

export const NODE_COLORS_DIM: Record<OntologyNodeKind, string> = {
	entity: "rgba(59, 130, 246, 0.4)",
	aspect: "rgba(139, 92, 246, 0.4)",
	attribute: "rgba(6, 182, 212, 0.4)",
};

export const RELATED_GLOW: Record<OntologyNodeKind, string> = {
	entity: "rgba(59, 130, 246, 0.15)",
	aspect: "rgba(139, 92, 246, 0.2)",
	attribute: "rgba(6, 182, 212, 0.2)",
};

// ---------------------------------------------------------------------------
// Build graph from live constellation API data
// ---------------------------------------------------------------------------

export function buildGraphFromConstellation(
	data: ConstellationGraph,
): { nodes: OntologyNode[]; edges: OntologyEdge[] } {
	const nodes: OntologyNode[] = [];
	const edges: OntologyEdge[] = [];

	for (const e of data.entities) {
		nodes.push({
			id: e.id,
			kind: "entity",
			label: e.name,
			sublabel: e.entityType,
			data: e,
		});

		for (const asp of e.aspects ?? []) {
			nodes.push({
				id: asp.id,
				kind: "aspect",
				label: asp.name,
				sublabel: `w:${asp.weight.toFixed(2)}`,
				parentId: e.id,
				data: asp,
			});

			edges.push({
				source: e.id,
				target: asp.id,
				label: "has_aspect",
				kind: "has_aspect",
			});

			for (const attr of asp.attributes ?? []) {
				const short = attr.content.length > 30
					? `${attr.content.slice(0, 30)}...`
					: attr.content;
				nodes.push({
					id: attr.id,
					kind: "attribute",
					label: short,
					searchText: attr.content,
					sublabel: attr.kind,
					parentId: asp.id,
					data: attr,
				});

				edges.push({
					source: asp.id,
					target: attr.id,
					label: "has_attribute",
					kind: "has_attribute",
				});
			}
		}
	}

	for (const d of data.dependencies) {
		edges.push({
			source: d.sourceEntityId,
			target: d.targetEntityId,
			label: `${d.dependencyType} ${d.strength.toFixed(2)}`,
			kind: "dependency",
			strength: d.strength,
			dashed: true,
		});
	}

	return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Derive related IDs for selection highlighting
// ---------------------------------------------------------------------------

export function relatedIdsForEntity(
	entityId: string,
	nodes: OntologyNode[],
	edges: OntologyEdge[],
): Set<string> {
	const related = new Set<string>();

	// Aspects of this entity
	for (const n of nodes) {
		if (n.kind === "aspect" && n.parentId === entityId) {
			related.add(n.id);
			// Attributes of this aspect
			for (const a of nodes) {
				if (a.kind === "attribute" && a.parentId === n.id) {
					related.add(a.id);
				}
			}
		}
	}

	// Dependencies connected to this entity
	for (const e of edges) {
		if (e.kind === "dependency") {
			if (e.source === entityId) related.add(e.target);
			if (e.target === entityId) related.add(e.source);
		}
	}

	return related;
}

/** Lookup entity name from constellation data */
export function entityNameFromGraph(
	entities: ConstellationEntity[],
	id: string,
): string {
	return entities.find((e) => e.id === id)?.name ?? id;
}
