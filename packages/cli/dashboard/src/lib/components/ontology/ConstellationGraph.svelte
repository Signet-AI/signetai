<script lang="ts">
	import {
		forceLink,
		forceManyBody,
		forceSimulation,
		forceX,
		forceY,
		forceCollide,
	} from "d3-force";
	import { onMount } from "svelte";
	import type { ConstellationEntity } from "$lib/api";
	import {
		NODE_COLORS,
		NODE_COLORS_DIM,
		RELATED_GLOW,
		type OntologyNode,
		type OntologyEdge,
		type OntologyNodeKind,
		type OntologyEdgeKind,
	} from "./ontology-data";
	import {
		ontology,
		loadGraph,
		selectNode,
		clearSelection,
		hoverNode,
		clearHover,
	} from "./ontology-state.svelte";

	interface Props {
		agentId?: string;
	}
	const { agentId = "default" }: Props = $props();

	// Force-layout node (mutable positions added by d3)
	interface SimNode extends OntologyNode {
		x: number;
		y: number;
		vx: number;
		vy: number;
		fx: number | null;
		fy: number | null;
		radius: number;
	}

	interface SimEdge {
		source: SimNode | string;
		target: SimNode | string;
		label: string;
		kind: string;
		strength?: number;
		dashed?: boolean;
	}

	const BASE_RADII: Record<OntologyNodeKind, number> = {
		entity: 4,
		aspect: 4,
		attribute: 2.5,
	};

	const ENTITY_MIN_R = 4;
	const ENTITY_MAX_R = 18;

	function nodeRadius(node: OntologyNode): number {
		if (node.kind === "entity") {
			const e = node.data as ConstellationEntity;
			const aspectCount = e.aspects?.length ?? 0;
			let attrCount = 0;
			for (const a of e.aspects ?? []) attrCount += a.attributes?.length ?? 0;
			const weight = aspectCount + attrCount * 0.5 + (e.mentions ?? 0) * 0.05;
			const scaled = Math.log2(1 + weight);
			const t = Math.min(scaled / 5.5, 1);
			return ENTITY_MIN_R + t * (ENTITY_MAX_R - ENTITY_MIN_R);
		}
		return BASE_RADII[node.kind];
	}

	const EDGE_COLORS: Record<OntologyEdgeKind, { color: string; alpha: number }> = {
		dependency: { color: "245, 158, 11", alpha: 0.18 },
		has_aspect: { color: "139, 92, 246", alpha: 0.2 },
		has_attribute: { color: "6, 182, 212", alpha: 0.12 },
	};

	const LEGEND_ITEMS: { kind: OntologyNodeKind; label: string }[] = [
		{ kind: "entity", label: "Entities" },
		{ kind: "aspect", label: "Aspects" },
		{ kind: "attribute", label: "Attributes" },
	];

	let canvas = $state<HTMLCanvasElement | null>(null);
	let width = $state(800);
	let height = $state(600);

	// Camera state
	let camX = 0;
	let camY = 0;
	let camZoom = 1;

	// Interaction state
	let isPanning = false;
	let isDragging = false;
	let didDrag = false;
	let dragNode: SimNode | null = null;
	let panStartX = 0;
	let panStartY = 0;
	let panCamStartX = 0;
	let panCamStartY = 0;

	// Sim data
	let simNodes = $state<SimNode[]>([]);
	let simEdges: SimEdge[] = [];
	let sim: ReturnType<typeof forceSimulation<SimNode>> | null = null;
	let raf = 0;

	// Track current filter to detect changes
	let lastFilter = "";

	function buildSim(nodes: OntologyNode[], edges: OntologyEdge[]): void {
		const visNodes = ontology.visibleNodeKinds;
		const visEdges = ontology.visibleEdgeKinds;
		const search = ontology.searchMatchIds;

		simNodes = nodes
			.filter((n) => visNodes.has(n.kind) && (search === null || search.has(n.id)))
			.map((n) => ({
				...n,
				x: (Math.random() - 0.5) * 400,
				y: (Math.random() - 0.5) * 300,
				vx: 0,
				vy: 0,
				fx: null,
				fy: null,
				radius: nodeRadius(n),
			}));

		const nodeIds = new Set(simNodes.map((n) => n.id));

		simEdges = edges
			.filter((e) => visEdges.has(e.kind) && nodeIds.has(e.source) && nodeIds.has(e.target))
			.map((e) => ({ ...e }));

		sim?.stop();

		// Adjust forces based on node count
		const charge = simNodes.length > 500 ? -80 : simNodes.length > 200 ? -120 : -180;
		const linkDist = simNodes.length > 500 ? 40 : 80;

		sim = forceSimulation<SimNode>(simNodes)
			.force(
				"link",
				forceLink<SimNode, SimEdge>(simEdges)
					.id((d) => d.id)
					.distance(linkDist)
					.strength(0.15),
			)
			.force("charge", forceManyBody<SimNode>().strength(charge))
			.force("x", forceX<SimNode>(0).strength(0.06))
			.force("y", forceY<SimNode>(0).strength(0.06))
			.force("collide", forceCollide<SimNode>((d) => d.radius + 2))
			.alphaDecay(0.02)
			.on("tick", () => {});

		startRenderLoop();
	}

	// Watch for filter changes and rebuild sim
	$effect(() => {
		const key = [...ontology.visibleNodeKinds].sort().join(",")
			+ "|" + [...ontology.visibleEdgeKinds].sort().join(",")
			+ "|" + ontology.searchEpoch;
		if (key !== lastFilter && ontology.graphNodes.length > 0) {
			lastFilter = key;
			buildSim(ontology.graphNodes, ontology.graphEdges);
		}
	});

	// Wake the render loop when selection/hover changes so highlights repaint
	$effect(() => {
		void ontology.selected;
		void ontology.hovered;
		wakeRenderLoop();
	});

	// --- Rendering ---

	function startRenderLoop(): void {
		cancelAnimationFrame(raf);
		const loop = () => {
			draw();
			// Keep looping while the sim is active or the user is interacting
			if (sim && (sim.alpha() > 0.01 || isDragging || isPanning)) {
				raf = requestAnimationFrame(loop);
			} else {
				// Sim settled — do one final draw and stop
				draw();
				raf = 0;
			}
		};
		raf = requestAnimationFrame(loop);
	}

	function wakeRenderLoop(): void {
		if (!raf) startRenderLoop();
	}

	function worldToScreen(wx: number, wy: number): [number, number] {
		return [(wx - camX) * camZoom + width / 2, (wy - camY) * camZoom + height / 2];
	}

	function screenToWorld(sx: number, sy: number): [number, number] {
		return [(sx - width / 2) / camZoom + camX, (sy - height / 2) / camZoom + camY];
	}

	function draw(): void {
		const el = canvas;
		if (!el) return;
		const ctx = el.getContext("2d");
		if (!ctx) return;

		const dpr = window.devicePixelRatio || 1;
		const cw = el.clientWidth;
		const ch = el.clientHeight;
		if (el.width !== cw * dpr || el.height !== ch * dpr) {
			el.width = cw * dpr;
			el.height = ch * dpr;
			width = cw;
			height = ch;
		}

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, cw, ch);

		const selectedId = ontology.selected?.id;
		const hoveredId = ontology.hovered?.id;
		const related = ontology.relatedIds;
		const hasSelection = selectedId != null;

		// Draw edges
		for (const edge of simEdges) {
			const s = edge.source as SimNode;
			const t = edge.target as SimNode;
			if (s.x == null || t.x == null) continue;

			const [sx, sy] = worldToScreen(s.x, s.y);
			const [tx, ty] = worldToScreen(t.x, t.y);

			// Dim edges not connected to selection
			const connected = !hasSelection
				|| s.id === selectedId || t.id === selectedId
				|| related.has(s.id) || related.has(t.id);

			ctx.beginPath();
			ctx.setLineDash(edge.dashed ? [4, 4] : []);

			const ec = EDGE_COLORS[edge.kind as OntologyEdgeKind] ?? EDGE_COLORS.dependency;
			const alpha = connected ? ec.alpha : ec.alpha * 0.15;
			ctx.strokeStyle = `rgba(${ec.color}, ${alpha})`;
			ctx.lineWidth = edge.kind === "dependency" ? 1.5 : 1;
			ctx.moveTo(sx, sy);
			ctx.lineTo(tx, ty);
			ctx.stroke();
			ctx.setLineDash([]);
		}

		// Draw nodes
		for (const node of simNodes) {
			const [nx, ny] = worldToScreen(node.x, node.y);
			const r = node.radius * camZoom;
			if (r < 0.5) continue;

			const isSelected = node.id === selectedId;
			const isHovered = node.id === hoveredId;
			const isRelated = related.has(node.id);

			// Dim unrelated nodes when something is selected
			const dimmed = hasSelection && !isSelected && !isRelated;

			// Glow ring for selected/hovered/related
			if (isSelected || isHovered || isRelated) {
				ctx.beginPath();
				ctx.arc(nx, ny, r + (isSelected ? 5 : 3), 0, Math.PI * 2);
				ctx.fillStyle = isSelected
					? "rgba(200, 255, 0, 0.15)"
					: isRelated
						? RELATED_GLOW[node.kind]
						: "rgba(255, 255, 255, 0.08)";
				ctx.fill();
			}

			// Node circle
			ctx.beginPath();
			ctx.arc(nx, ny, r, 0, Math.PI * 2);
			if (isSelected) {
				ctx.fillStyle = "#c8ff00";
			} else if (dimmed) {
				ctx.fillStyle = NODE_COLORS_DIM[node.kind];
			} else {
				ctx.fillStyle = NODE_COLORS[node.kind];
			}
			ctx.fill();

			// Border for selected
			if (isSelected) {
				ctx.strokeStyle = "#c8ff00";
				ctx.lineWidth = 2;
				ctx.stroke();
			} else if (isRelated) {
				ctx.strokeStyle = NODE_COLORS[node.kind];
				ctx.lineWidth = 1;
				ctx.stroke();
			}

			// Label
			if (camZoom > 0.6 && r > 2.5) {
				const label = node.label.length > 25
					? `${node.label.slice(0, 25)}...`
					: node.label;
				const fontSize = node.kind === "attribute"
					? Math.max(7, 8 * camZoom)
					: Math.max(9, 10 * camZoom);
				ctx.font = `${fontSize}px var(--font-mono), monospace`;
				ctx.textAlign = "center";
				ctx.textBaseline = "top";

				const ly = ny + r + 3;

				// Text shadow for readability
				if (!dimmed) {
					ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
					ctx.fillText(label, nx + 1, ly + 1);
				}

				ctx.fillStyle = isSelected
					? "#c8ff00"
					: isRelated
						? NODE_COLORS[node.kind]
						: isHovered
							? "rgba(240, 240, 242, 0.95)"
							: dimmed
								? "rgba(200, 200, 208, 0.15)"
								: "rgba(220, 220, 228, 0.8)";
				ctx.fillText(label, nx, ly);
			}
		}

		// Empty state
		if (simNodes.length === 0 && !ontology.loading) {
			ctx.font = "11px var(--font-mono), monospace";
			ctx.fillStyle = "rgba(200, 200, 208, 0.5)";
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			const msg = ontology.error ?? "No entities in knowledge graph";
			ctx.fillText(msg, cw / 2, ch / 2);
		}
	}

	// --- Interaction ---

	function findNodeAt(sx: number, sy: number): SimNode | null {
		const [wx, wy] = screenToWorld(sx, sy);
		let closest: SimNode | null = null;
		let minDist = Infinity;
		for (const node of simNodes) {
			const dx = node.x - wx;
			const dy = node.y - wy;
			const dist = Math.sqrt(dx * dx + dy * dy);
			const hitRadius = node.radius + 4 / camZoom;
			if (dist < hitRadius && dist < minDist) {
				closest = node;
				minDist = dist;
			}
		}
		return closest;
	}

	function getCanvasPos(e: MouseEvent): { x: number; y: number } {
		const rect = canvas?.getBoundingClientRect();
		if (!rect) return { x: 0, y: 0 };
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	function onPointerDown(e: MouseEvent): void {
		const pos = getCanvasPos(e);
		const hit = findNodeAt(pos.x, pos.y);
		didDrag = false;

		if (hit) {
			isDragging = true;
			dragNode = hit;
			hit.fx = hit.x;
			hit.fy = hit.y;
			sim?.alphaTarget(0.3).restart();
		} else {
			isPanning = true;
			panStartX = pos.x;
			panStartY = pos.y;
			panCamStartX = camX;
			panCamStartY = camY;
		}
	}

	function onPointerMove(e: MouseEvent): void {
		const pos = getCanvasPos(e);

		if (isDragging && dragNode) {
			const [wx, wy] = screenToWorld(pos.x, pos.y);
			dragNode.fx = wx;
			dragNode.fy = wy;
			didDrag = true;
			wakeRenderLoop();
			return;
		}

		if (isPanning) {
			const dx = (pos.x - panStartX) / camZoom;
			const dy = (pos.y - panStartY) / camZoom;
			camX = panCamStartX - dx;
			camY = panCamStartY - dy;
			didDrag = true;
			wakeRenderLoop();
			return;
		}

		// Hover detection
		const hit = findNodeAt(pos.x, pos.y);
		if (hit) {
			hoverNode(hit.id, hit.kind);
			if (canvas) canvas.style.cursor = "pointer";
		} else {
			clearHover();
			if (canvas) canvas.style.cursor = "default";
		}
	}

	function onPointerUp(_e: MouseEvent): void {
		if (isDragging && dragNode) {
			if (!didDrag) {
				selectNode(dragNode.id, dragNode.kind);
			}
			dragNode.fx = null;
			dragNode.fy = null;
			sim?.alphaTarget(0);
		} else if (isPanning && !didDrag) {
			clearSelection();
		}

		isDragging = false;
		isPanning = false;
		dragNode = null;
	}

	function onWheel(e: WheelEvent): void {
		e.preventDefault();
		const factor = e.deltaY < 0 ? 1.1 : 0.9;
		const pos = getCanvasPos(e);
		const [wx, wy] = screenToWorld(pos.x, pos.y);

		camZoom = Math.max(0.15, Math.min(5, camZoom * factor));

		camX = wx - (pos.x - width / 2) / camZoom;
		camY = wy - (pos.y - height / 2) / camZoom;
		wakeRenderLoop();
	}

	// Reload graph whenever agentId changes (not just on mount)
	$effect(() => {
		const id = agentId;
		loadGraph(id).then(() => {
			lastFilter = [...ontology.visibleNodeKinds].sort().join(",")
				+ "|" + [...ontology.visibleEdgeKinds].sort().join(",")
				+ "|all";
			buildSim(ontology.graphNodes, ontology.graphEdges);
		});
	});

	onMount(() => {
		return () => {
			cancelAnimationFrame(raf);
			sim?.stop();
		};
	});
</script>

<div class="constellation-zone">
	<div class="panel-header">
		<span class="panel-title">CONSTELLATION GRAPH</span>
		{#if ontology.loading}
			<span class="panel-status">Loading...</span>
		{:else if simNodes.length > 0}
			<span class="panel-status">{simNodes.length} nodes</span>
		{/if}
	</div>

	<div class="graph-container">
		<canvas
			bind:this={canvas}
			class="graph-canvas"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointerleave={onPointerUp}
			onwheel={onWheel}
		></canvas>

		<!-- Legend -->
		<div class="graph-legend">
			{#each LEGEND_ITEMS as item (item.kind)}
				{#if ontology.visibleNodeKinds.has(item.kind)}
					<div class="legend-item">
						<span
							class="legend-dot"
							style="background: {NODE_COLORS[item.kind]}"
						></span>
						<span class="legend-label">{item.label}</span>
					</div>
				{/if}
			{/each}
		</div>
	</div>
</div>

<style>
	.constellation-zone {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--sig-bg);
		border-right: 1px solid var(--sig-border);
	}

	.panel-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.panel-title {
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.panel-status {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		letter-spacing: 0.05em;
	}

	.graph-container {
		position: relative;
		flex: 1;
		min-height: 0;
	}

	.graph-canvas {
		display: block;
		width: 100%;
		height: 100%;
	}

	.graph-legend {
		position: absolute;
		top: 10px;
		left: 10px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 10px;
		background: rgba(6, 6, 8, 0.85);
		border: 1px solid var(--sig-border);
		border-radius: 4px;
	}

	.legend-item {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0;
	}

	.legend-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.legend-label {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
</style>
