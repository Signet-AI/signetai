<script lang="ts">
import type { EmbeddingPoint } from "../../api";
import type { ForceGraph3DInstance, LinkObject, NodeObject } from "3d-force-graph";
import {
	GRAPH_K,
	type NodeColorMode,
	type RelationKind,
	buildKnnEdges,
	edgeColor3D,
	embeddingLabel,
	nodeColor3D,
} from "./embedding-graph";

interface Props {
	embeddings: EmbeddingPoint[];
	projected3d: number[][];
	graphSelected: EmbeddingPoint | null;
	embeddingFilterIds: Set<string> | null;
	relationLookup: Map<string, RelationKind>;
	pinnedIds: Set<string>;
	lensIds: Set<string>;
	clusterLensMode: boolean;
	colorMode: NodeColorMode;
	nowMs: number;
	showNewSinceLastSeen: boolean;
	lastSeenMs: number | null;
	sourceFocusSources: Set<string> | null;
	onselectnode: (embedding: EmbeddingPoint | null) => void;
	onhovernode: (embedding: EmbeddingPoint | null) => void;
	embeddingById: Map<string, EmbeddingPoint>;
}

interface GraphNode extends NodeObject {
	readonly id: string;
	readonly content: string;
	readonly who: string | null | undefined;
	readonly importance: number;
	readonly x?: number;
	readonly y?: number;
	readonly z?: number;
	readonly val: number;
}

interface GraphControls {
	readonly addEventListener?: (name: string, cb: () => void) => void;
	readonly removeEventListener?: (name: string, cb: () => void) => void;
}

type GraphApi = ForceGraph3DInstance;

let {
	embeddings,
	projected3d,
	graphSelected,
	embeddingFilterIds,
	relationLookup,
	pinnedIds,
	lensIds,
	clusterLensMode,
	colorMode,
	nowMs,
	showNewSinceLastSeen,
	lastSeenMs,
	sourceFocusSources,
	onselectnode,
	onhovernode,
	embeddingById,
}: Props = $props();

let container = $state<HTMLDivElement | null>(null);
let graph3d = $state<GraphApi | null>(null);
let graphResizeObserver: ResizeObserver | null = null;
let controlsCleanup: (() => void) | null = null;
let userAdjustedCamera = false;

function isGraphControls(value: unknown): value is GraphControls {
	return typeof value === "object" && value !== null;
}

function linkEndId(end: string | number | NodeObject | undefined): string {
	if (typeof end === "object" && end !== null && "id" in end) {
		return String(end.id);
	}
	return String(end ?? "");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function focusNode(id: string): void {
	if (!graph3d) return;
	const graphData = graph3d.graphData?.();
	if (!graphData?.nodes) return;
	const node = graphData.nodes.find((entry) => String(entry.id) === id);
	if (!node) return;
	userAdjustedCamera = true;
	const distance = 120;
	const len = Math.hypot(node.x ?? 0, node.y ?? 0, node.z ?? 0) || 1;
	const ratio = 1 + distance / len;
	graph3d.cameraPosition(
		{
			x: (node.x ?? 0) * ratio,
			y: (node.y ?? 0) * ratio,
			z: (node.z ?? 0) * ratio,
		},
		{ x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 },
		900,
	);
}

function sizeGraphToContainer(): void {
	if (!graph3d || !container) return;
	const rect = container.getBoundingClientRect();
	const width = Math.max(1, Math.round(rect.width || container.offsetWidth));
	const height = Math.max(1, Math.round(rect.height || container.offsetHeight));
	graph3d.width(width);
	graph3d.height(height);
}

function fitGraphCamera(durationMs = 0): void {
	if (!graph3d) return;
	const graphData = graph3d.graphData?.();
	if (!graphData?.nodes?.length) return;
	graph3d.zoomToFit?.(durationMs, 44);
}

function setupInteractionTracking(): void {
	if (!graph3d) return;
	const controls = graph3d.controls();
	if (!isGraphControls(controls)) return;
	if (!controls.addEventListener || !controls.removeEventListener) return;
	const add = controls.addEventListener;
	const remove = controls.removeEventListener;
	const onStart = () => {
		userAdjustedCamera = true;
	};
	add("start", onStart);
	controlsCleanup = () => {
		remove("start", onStart);
	};
}

function setupResizeHandling(): void {
	if (!container || !graph3d) return;
	graphResizeObserver?.disconnect();
	graphResizeObserver = new ResizeObserver(() => {
		if (!graph3d) return;
		sizeGraphToContainer();
		if (!userAdjustedCamera) {
			fitGraphCamera(0);
		}
		graph3d.refresh?.();
	});
	graphResizeObserver.observe(container);
}

export function refreshAppearance(): void {
	if (!graph3d) return;
	graph3d.nodeColor((node) =>
		nodeColor3D(
			String(node.id),
			embeddingById.get(String(node.id))?.who ?? "unknown",
			embeddingById.get(String(node.id))?.createdAt,
			graphSelected?.id ?? null,
			embeddingFilterIds,
			relationLookup,
			pinnedIds,
			lensIds,
			clusterLensMode,
			colorMode,
			nowMs,
			showNewSinceLastSeen,
			lastSeenMs,
			sourceFocusSources,
		),
	);
	graph3d.linkColor((link) => {
		const sourceId = linkEndId(link.source);
		const targetId = linkEndId(link.target);
		return edgeColor3D(sourceId, targetId, embeddingFilterIds, lensIds, clusterLensMode);
	});
	graph3d.refresh?.();
}

export async function init(): Promise<void> {
	if (!container) return;
	destroy();
	userAdjustedCamera = false;

	const mod: typeof import("3d-force-graph") = await import("3d-force-graph");
	const ForceGraph3D = mod.default;

	const nodeData: GraphNode[] = embeddings.map((embedding, index) => {
		const point = projected3d[index] ?? [0, 0, 0];
		return {
			id: embedding.id,
			content: embedding.content,
			who: embedding.who,
			importance: embedding.importance ?? 0.5,
			x: point[0] * 52,
			y: point[1] * 52,
			z: point[2] * 52,
			val: 1 + (embedding.importance ?? 0.5) * 2.6,
		};
	});

	const edgePairs = buildKnnEdges(projected3d, GRAPH_K);
	const linkData: LinkObject[] = edgePairs.map(([source, target]) => ({
		source: nodeData[source].id,
		target: nodeData[target].id,
	}));

	const rect = container.getBoundingClientRect();
	graph3d = new ForceGraph3D(container)
		.width(rect.width || container.offsetWidth)
		.height(rect.height || container.offsetHeight)
		.graphData({ nodes: nodeData, links: linkData })
		.nodeLabel((node) => {
			const item = embeddingById.get(String(node.id));
			if (!item) return "";
			return `${item.who ?? "unknown"} - ${embeddingLabel(item)}`;
		})
		.nodeColor((node) =>
			nodeColor3D(
				String(node.id),
				embeddingById.get(String(node.id))?.who ?? "unknown",
				embeddingById.get(String(node.id))?.createdAt,
				graphSelected?.id ?? null,
				embeddingFilterIds,
				relationLookup,
				pinnedIds,
				lensIds,
				clusterLensMode,
				colorMode,
				nowMs,
				showNewSinceLastSeen,
				lastSeenMs,
				sourceFocusSources,
			),
		)
		.nodeVal((node) => 0.6 + (embeddingById.get(String(node.id))?.importance ?? 0.5) * 1.4)
		.linkColor((link) => {
			const sourceId = linkEndId(link.source);
			const targetId = linkEndId(link.target);
			return edgeColor3D(sourceId, targetId, embeddingFilterIds, lensIds, clusterLensMode);
		})
		.linkWidth(0.45)
		.backgroundColor("#050505")
		.onNodeClick((node) => {
			const item = embeddingById.get(String(node.id));
			onselectnode(item ?? null);
		})
		.onNodeHover((node) => {
			onhovernode(node ? (embeddingById.get(String(node.id)) ?? null) : null);
		});

	sizeGraphToContainer();
	setupInteractionTracking();
	setupResizeHandling();

	requestAnimationFrame(() => {
		if (!userAdjustedCamera) {
			fitGraphCamera(0);
		}
	});
}

export function destroy(): void {
	graphResizeObserver?.disconnect();
	graphResizeObserver = null;
	controlsCleanup?.();
	controlsCleanup = null;
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
