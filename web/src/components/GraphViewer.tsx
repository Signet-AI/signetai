/**
 * Interactive knowledge graph viewer, inspired by Quartz.
 *
 * Uses D3 force simulation rendered to Canvas.
 * Two modes: local (sidebar, depth-1 neighbors) and global (modal, all nodes).
 */

import { drag as d3drag } from "d3-drag";
import {
	type Simulation,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
	forceCenter,
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
} from "d3-force";
import { select } from "d3-selection";
import { type ZoomBehavior, zoom as d3zoom } from "d3-zoom";
import { useCallback, useEffect, useRef, useState } from "react";

// ─── types ───────────────────────────────────────────────────────────

interface ContentNode {
	readonly title: string;
	readonly url: string;
	readonly tags: readonly string[];
	readonly links: readonly string[];
	readonly collection: "docs" | "blog";
}

type ContentIndex = Record<string, ContentNode>;

interface GraphNode extends SimulationNodeDatum {
	id: string;
	title: string;
	url: string;
	collection: "docs" | "blog";
	isCurrent: boolean;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
	source: GraphNode;
	target: GraphNode;
}

interface Props {
	currentSlug: string;
	collection: "docs" | "blog";
	mode?: "local" | "global";
}

// ─── component ───────────────────────────────────────────────────────

export default function GraphViewer({ currentSlug, collection, mode = "local" }: Props) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
	const [globalOpen, setGlobalOpen] = useState(false);
	const [data, setData] = useState<ContentIndex | null>(null);
	const [hovered, setHovered] = useState<string | null>(null);

	// Fetch content index
	useEffect(() => {
		fetch("/contentIndex.json")
			.then((r) => r.json())
			.then((d: ContentIndex) => setData(d))
			.catch(() => {});
	}, []);

	const activeMode = globalOpen ? "global" : mode;
	const fullSlug = `${collection}/${currentSlug}`;

	// Build graph data from content index
	const buildGraph = useCallback(
		(index: ContentIndex, graphMode: "local" | "global") => {
			const allNodes = new Map<string, GraphNode>();
			const allLinks: GraphLink[] = [];

			for (const [id, node] of Object.entries(index)) {
				allNodes.set(id, {
					id,
					title: node.title,
					url: node.url,
					collection: node.collection,
					isCurrent: id === fullSlug,
				});
			}

			for (const [id, node] of Object.entries(index)) {
				const source = allNodes.get(id);
				if (!source) continue;
				for (const targetId of node.links) {
					const target = allNodes.get(targetId);
					if (target) {
						allLinks.push({ source, target });
					}
				}
			}

			if (graphMode === "local") {
				const neighbors = new Set<string>();
				neighbors.add(fullSlug);
				for (const link of allLinks) {
					if (link.source.id === fullSlug) neighbors.add(link.target.id);
					if (link.target.id === fullSlug) neighbors.add(link.source.id);
				}

				const filteredNodes = [...allNodes.values()].filter((n) => neighbors.has(n.id));
				const nodeSet = new Set(filteredNodes.map((n) => n.id));
				const filteredLinks = allLinks.filter((l) => nodeSet.has(l.source.id) && nodeSet.has(l.target.id));

				return { nodes: filteredNodes, links: filteredLinks };
			}

			return { nodes: [...allNodes.values()], links: allLinks };
		},
		[fullSlug],
	);

	// Render the graph
	useEffect(() => {
		if (!data || !canvasRef.current || !containerRef.current) return;

		const canvas = canvasRef.current;
		const container = containerRef.current;
		const maybeCtx = canvas.getContext("2d");
		if (!maybeCtx) return;
		const ctx: CanvasRenderingContext2D = maybeCtx;

		const dpr = window.devicePixelRatio || 1;
		const rect = container.getBoundingClientRect();
		const width = rect.width;
		const height = activeMode === "global" ? Math.min(600, window.innerHeight * 0.7) : 280;
		const padding = 30;

		canvas.width = width * dpr;
		canvas.height = height * dpr;
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;
		ctx.scale(dpr, dpr);

		const { nodes, links } = buildGraph(data, activeMode);
		if (nodes.length === 0) return;

		// ─── Colors ──────────────────────────────────────────────
		const isLocal = activeMode === "local";

		// Node colors by role
		const COL_CURRENT = "#f0f0f2"; // bright white for current
		const COL_DOC = "#8b8b94"; // muted for docs
		const COL_BLOG = "#a0a0aa"; // slightly brighter for blog
		const COL_LINK = "rgba(255,255,255,0.08)"; // subtle links
		const COL_LINK_HIGHLIGHT = "rgba(255,255,255,0.25)"; // highlighted links
		const COL_LABEL = "#d4d4d8";
		const COL_LABEL_MUTED = "#6b6b73";
		const COL_GLOW = "rgba(255,255,255,0.06)"; // current node glow

		// Build adjacency for hover highlighting
		const adjacency = new Map<string, Set<string>>();
		for (const link of links) {
			const s = link.source.id;
			const t = link.target.id;
			if (!adjacency.has(s)) adjacency.set(s, new Set());
			if (!adjacency.has(t)) adjacency.set(t, new Set());
			adjacency.get(s)?.add(t);
			adjacency.get(t)?.add(s);
		}

		// ─── Simulation ──────────────────────────────────────────
		const sim = forceSimulation<GraphNode>(nodes)
			.force(
				"link",
				forceLink<GraphNode, GraphLink>(links)
					.id((d) => d.id)
					.distance(isLocal ? 70 : 80),
			)
			.force("charge", forceManyBody().strength(isLocal ? -180 : -120))
			.force("center", forceCenter(width / 2, height / 2))
			.force("collide", forceCollide(isLocal ? 28 : 20));

		simRef.current = sim;

		// Track hover and transform state
		let hoveredNode: string | null = null;
		let transform = { x: 0, y: 0, k: 1 };

		function nodeColor(node: GraphNode): string {
			if (node.isCurrent) return COL_CURRENT;
			if (node.collection === "blog") return COL_BLOG;
			return COL_DOC;
		}

		function isHighlighted(nodeId: string): boolean {
			if (!hoveredNode) return true;
			if (nodeId === hoveredNode) return true;
			return adjacency.get(hoveredNode)?.has(nodeId) ?? false;
		}

		function draw() {
			ctx.save();
			ctx.clearRect(0, 0, width, height);
			ctx.translate(transform.x, transform.y);
			ctx.scale(transform.k, transform.k);

			// ─── Draw links ──────────────────────────────────
			for (const link of links) {
				const s = link.source;
				const t = link.target;
				if (s.x == null || s.y == null || t.x == null || t.y == null) continue;

				const highlighted = !hoveredNode || (isHighlighted(s.id) && isHighlighted(t.id));

				ctx.strokeStyle = highlighted ? COL_LINK_HIGHLIGHT : COL_LINK;
				ctx.lineWidth = highlighted ? 1.2 : 0.5;
				ctx.beginPath();
				ctx.moveTo(s.x, s.y);
				ctx.lineTo(t.x, t.y);
				ctx.stroke();
			}

			// ─── Draw nodes ──────────────────────────────────
			const baseRadius = isLocal ? 6 : 4;

			for (const node of nodes) {
				if (node.x == null || node.y == null) continue;

				const highlighted = isHighlighted(node.id);
				const isHovered = node.id === hoveredNode;
				const color = nodeColor(node);

				let radius = baseRadius;
				if (node.isCurrent) radius = baseRadius + 3;
				else if (isHovered) radius = baseRadius + 1;

				// Glow behind current node
				if (node.isCurrent) {
					ctx.beginPath();
					ctx.arc(node.x, node.y, radius + 8, 0, Math.PI * 2);
					ctx.fillStyle = COL_GLOW;
					ctx.fill();

					ctx.beginPath();
					ctx.arc(node.x, node.y, radius + 4, 0, Math.PI * 2);
					ctx.fillStyle = COL_GLOW;
					ctx.fill();
				}

				// Node circle
				ctx.beginPath();
				ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
				ctx.fillStyle = highlighted ? color : `${color}33`;
				ctx.fill();

				// Ring on current node
				if (node.isCurrent) {
					ctx.strokeStyle = COL_CURRENT;
					ctx.lineWidth = 1.5;
					ctx.stroke();
				}

				// Ring on hovered node
				if (isHovered && !node.isCurrent) {
					ctx.strokeStyle = color;
					ctx.lineWidth = 1;
					ctx.stroke();
				}
			}

			// ─── Draw labels ─────────────────────────────────
			const fontSize = isLocal ? 10 : 9;
			ctx.font = `${fontSize}px "IBM Plex Mono", monospace`;
			ctx.textAlign = "center";
			ctx.textBaseline = "top";

			for (const node of nodes) {
				if (node.x == null || node.y == null) continue;

				// In local mode: show labels for current + hovered + hovered neighbors only
				const showLabel =
					node.isCurrent || node.id === hoveredNode || (hoveredNode && adjacency.get(hoveredNode)?.has(node.id));

				if (!showLabel && isLocal) continue;
				if (!isHighlighted(node.id) && !node.isCurrent && !isLocal) continue;

				const maxLen = isLocal ? 16 : 14;
				const label = node.title.length > maxLen ? `${node.title.slice(0, maxLen - 1)}..` : node.title;

				const r = node.isCurrent ? baseRadius + 3 : baseRadius;
				const y = node.y + r + 4;

				ctx.fillStyle = node.isCurrent ? COL_CURRENT : node.id === hoveredNode ? COL_LABEL : COL_LABEL_MUTED;
				ctx.globalAlpha = node.isCurrent ? 1 : node.id === hoveredNode ? 0.9 : 0.6;
				ctx.fillText(label, node.x, y);
				ctx.globalAlpha = 1;
			}

			ctx.restore();
		}

		sim.on("tick", draw);

		// ─── Mouse interaction ───────────────────────────────────
		function getNodeAtPoint(mx: number, my: number): GraphNode | undefined {
			const tx = (mx - transform.x) / transform.k;
			const ty = (my - transform.y) / transform.k;
			const r = isLocal ? 14 : 10;

			for (let i = nodes.length - 1; i >= 0; i--) {
				const n = nodes[i];
				if (n.x == null || n.y == null) continue;
				const dx = tx - n.x;
				const dy = ty - n.y;
				if (dx * dx + dy * dy < r * r) return n;
			}
			return undefined;
		}

		function handleMouseMove(e: MouseEvent) {
			const rect = canvas.getBoundingClientRect();
			const mx = e.clientX - rect.left;
			const my = e.clientY - rect.top;
			const node = getNodeAtPoint(mx, my);
			hoveredNode = node?.id ?? null;
			setHovered(hoveredNode);
			canvas.style.cursor = node ? "pointer" : "default";
			draw();
		}

		function handleClick(e: MouseEvent) {
			const rect = canvas.getBoundingClientRect();
			const mx = e.clientX - rect.left;
			const my = e.clientY - rect.top;
			const node = getNodeAtPoint(mx, my);
			if (node) {
				window.location.href = node.url;
			}
		}

		canvas.addEventListener("mousemove", handleMouseMove);
		canvas.addEventListener("click", handleClick);
		canvas.addEventListener("mouseleave", () => {
			hoveredNode = null;
			setHovered(null);
			canvas.style.cursor = "default";
			draw();
		});

		// Zoom for global mode
		let zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown> | null = null;
		if (activeMode === "global") {
			zoomBehavior = d3zoom<HTMLCanvasElement, unknown>()
				.scaleExtent([0.3, 3])
				.on("zoom", (event) => {
					transform = event.transform;
					draw();
				});

			select(canvas).call(zoomBehavior);
		}

		// Drag for nodes
		const dragBehavior = d3drag<HTMLCanvasElement, unknown>()
			.subject((event) => {
				const rect = canvas.getBoundingClientRect();
				const mx = event.x - rect.left;
				const my = event.y - rect.top;
				return getNodeAtPoint(mx, my) as unknown as Record<string, unknown>;
			})
			.on("start", (event) => {
				if (!event.active) sim.alphaTarget(0.3).restart();
				const d = event.subject as unknown as GraphNode;
				d.fx = d.x;
				d.fy = d.y;
			})
			.on("drag", (event) => {
				const d = event.subject as unknown as GraphNode;
				d.fx = (event.x - transform.x) / transform.k;
				d.fy = (event.y - transform.y) / transform.k;
			})
			.on("end", (event) => {
				if (!event.active) sim.alphaTarget(0);
				const d = event.subject as unknown as GraphNode;
				d.fx = null;
				d.fy = null;
			});

		select(canvas).call(dragBehavior as never);

		return () => {
			sim.stop();
			canvas.removeEventListener("mousemove", handleMouseMove);
			canvas.removeEventListener("click", handleClick);
		};
	}, [data, activeMode, buildGraph]);

	// Keyboard shortcut: Ctrl/Cmd+G toggles global
	useEffect(() => {
		function handleKeydown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key === "g") {
				e.preventDefault();
				setGlobalOpen((v) => !v);
			}
		}
		window.addEventListener("keydown", handleKeydown);
		return () => window.removeEventListener("keydown", handleKeydown);
	}, []);

	if (!data) return null;

	const nodeKey = `${collection}/${currentSlug}`;
	const currentNode = data[nodeKey];
	if (!currentNode && mode === "local") return null;

	// Count connections for this node
	let connectionCount = 0;
	if (currentNode) {
		const incoming = Object.values(data).filter((n) => n.links.includes(nodeKey));
		connectionCount = currentNode.links.length + incoming.length;
	}

	return (
		<>
			<div className="graph-viewer" ref={containerRef}>
				<div className="graph-header">
					<span className="graph-title">Graph</span>
					{connectionCount > 0 && <span className="graph-count">{connectionCount}</span>}
					<button
						type="button"
						className="graph-toggle"
						onClick={() => setGlobalOpen((v) => !v)}
						title="Toggle global graph (Ctrl+G)"
					>
						{globalOpen ? "Local" : "Explore"}
					</button>
				</div>
				<canvas ref={canvasRef} className="graph-canvas" />
				{hovered && data[hovered] && <div className="graph-tooltip">{data[hovered].title}</div>}
			</div>

			{globalOpen && (
				<div className="graph-modal-backdrop" onClick={() => setGlobalOpen(false)}>
					<div className="graph-modal" onClick={(e) => e.stopPropagation()}>
						<div className="graph-modal-header">
							<span className="graph-title">Knowledge Graph</span>
							<span className="graph-count">{Object.keys(data).length} pages</span>
							<button type="button" className="graph-toggle" onClick={() => setGlobalOpen(false)}>
								Close
							</button>
						</div>
						<GraphViewer currentSlug={currentSlug} collection={collection} mode="global" />
					</div>
				</div>
			)}
		</>
	);
}
