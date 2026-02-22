<script lang="ts">
import type { EmbeddingPoint } from "../../api";
import {
	type RelationKind,
	buildKnnEdges,
	nodeColor3D,
	embeddingLabel,
	GRAPH_K,
} from "./embedding-graph";

interface Props {
	embeddings: EmbeddingPoint[];
	projected3d: number[][];
	graphSelected: EmbeddingPoint | null;
	embeddingFilterIds: Set<string> | null;
	relationLookup: Map<string, RelationKind>;
	onselectnode: (embedding: EmbeddingPoint | null) => void;
	onhovernode: (embedding: EmbeddingPoint | null) => void;
	embeddingById: Map<string, EmbeddingPoint>;
}

let {
	embeddings,
	projected3d,
	graphSelected,
	embeddingFilterIds,
	relationLookup,
	onselectnode,
	onhovernode,
	embeddingById,
}: Props = $props();

let container = $state<HTMLDivElement | null>(null);
let graph3d: any = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function focusNode(id: string): void {
	if (!graph3d) return;
	const graphData = graph3d.graphData?.();
	if (!graphData?.nodes) return;
	const node = graphData.nodes.find(
		(entry: any) => String(entry.id) === id,
	);
	if (!node) return;
	const distance = 120;
	const len =
		Math.hypot(node.x ?? 0, node.y ?? 0, node.z ?? 0) || 1;
	const ratio = 1 + distance / len;
	graph3d.cameraPosition(
		{
			x: (node.x ?? 0) * ratio,
			y: (node.y ?? 0) * ratio,
			z: (node.z ?? 0) * ratio,
		},
		node,
		900,
	);
}

export function refreshAppearance(): void {
	if (!graph3d) return;
	graph3d.nodeColor((node: any) =>
		nodeColor3D(
			String(node.id),
			String(node.who ?? "unknown"),
			graphSelected?.id ?? null,
			embeddingFilterIds,
			relationLookup,
		),
	);
	graph3d.refresh?.();
}

export async function init(): Promise<void> {
	if (!container) return;
	destroy();

	const { default: ForceGraph3D } = await import("3d-force-graph");

	const nodeData = embeddings.map((embedding, index) => ({
		id: embedding.id,
		content: embedding.content,
		who: embedding.who,
		importance: embedding.importance ?? 0.5,
		x: projected3d[index][0] * 52,
		y: projected3d[index][1] * 52,
		z: projected3d[index][2] * 52,
		val: 1 + (embedding.importance ?? 0.5) * 2.6,
	}));

	const edgePairs = buildKnnEdges(projected3d, GRAPH_K);
	const linkData = edgePairs.map(([source, target]) => ({
		source: nodeData[source].id,
		target: nodeData[target].id,
	}));

	const rect = container.getBoundingClientRect();
	graph3d = new ForceGraph3D(container)
		.width(rect.width || container.offsetWidth)
		.height(rect.height || container.offsetHeight)
		.graphData({ nodes: nodeData, links: linkData })
		.nodeLabel((node: any) => {
			const item = embeddingById.get(String(node.id));
			if (!item) return "";
			return `${item.who ?? "unknown"} - ${embeddingLabel(item)}`;
		})
		.nodeColor((node: any) =>
			nodeColor3D(
				String(node.id),
				String(node.who ?? "unknown"),
				graphSelected?.id ?? null,
				embeddingFilterIds,
				relationLookup,
			),
		)
		.nodeVal(
			(node: any) => 0.6 + (node.importance ?? 0.5) * 1.4,
		)
		.linkColor(() => "rgba(160,160,160,0.5)")
		.linkWidth(0.45)
		.backgroundColor("#050505")
		.onNodeClick((node: any) => {
			const item = embeddingById.get(String(node.id));
			onselectnode(item ?? null);
		})
		.onNodeHover((node: any) => {
			onhovernode(
				node ? (embeddingById.get(String(node.id)) ?? null) : null,
			);
		});
}

export function destroy(): void {
	if (graph3d) {
		graph3d._destructor?.();
		graph3d = null;
	}
}

// Cleanup on unmount
$effect(() => {
	return () => {
		destroy();
	};
});
</script>

<div bind:this={container} class="graph3d-container"></div>

<style>
	.graph3d-container {
		position: absolute;
		inset: 0;
	}
</style>
