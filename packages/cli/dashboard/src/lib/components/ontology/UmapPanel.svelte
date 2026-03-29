<script lang="ts">
	import ChevronDown from "@lucide/svelte/icons/chevron-down";
	import { ontology, loadProjection } from "./ontology-state.svelte";
	import type { ProjectionNode } from "$lib/api";

	interface Props {
		agentId?: string;
	}
	const { agentId = "default" }: Props = $props();

	const CLUSTER_COLORS = [
		"#3b82f6", // blue
		"#f59e0b", // amber
		"#22c55e", // green
		"#a78bfa", // violet
		"#ef4444", // red
		"#06b6d4", // cyan
		"#ec4899", // pink
	];

	const DEFAULT_COLOR = "#6b7280";

	let collapsed = $state(false);

	const nodes = $derived(ontology.projection?.nodes ?? []);
	const status = $derived(ontology.projection?.status ?? "computing");
	const cachedAt = $derived(ontology.projection?.cachedAt);

	// Simple cluster assignment via spatial binning (no cluster field in API)
	function colorFor(node: ProjectionNode, _i: number): string {
		if (node.type === "fact") return CLUSTER_COLORS[0];
		if (node.type === "decision") return CLUSTER_COLORS[1];
		if (node.type === "observation") return CLUSTER_COLORS[2];
		if (node.type === "preference") return CLUSTER_COLORS[3];
		if (node.type === "procedure") return CLUSTER_COLORS[4];
		if (node.type === "conversation_summary") return CLUSTER_COLORS[5];
		return DEFAULT_COLOR;
	}

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	}

	// Normalize x/y to 0-1 range for SVG positioning
	const bounds = $derived.by(() => {
		if (nodes.length === 0) return { minX: 0, maxX: 1, minY: 0, maxY: 1 };
		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
		for (const n of nodes) {
			if (n.x < minX) minX = n.x;
			if (n.x > maxX) maxX = n.x;
			if (n.y < minY) minY = n.y;
			if (n.y > maxY) maxY = n.y;
		}
		const dx = maxX - minX || 1;
		const dy = maxY - minY || 1;
		return { minX, maxX: minX + dx, minY, maxY: minY + dy };
	});

	const SVG_W = 260;
	const SVG_H = 260;
	const PAD = 12;

	function scaleX(x: number): number {
		return PAD + ((x - bounds.minX) / (bounds.maxX - bounds.minX)) * (SVG_W - PAD * 2);
	}

	function scaleY(y: number): number {
		return PAD + (1 - (y - bounds.minY) / (bounds.maxY - bounds.minY)) * (SVG_H - PAD * 2);
	}

	// Reload whenever agentId changes (not just on mount)
	$effect(() => {
		loadProjection(agentId);
	});
</script>

<div class="umap-zone">
	<button class="umap-header" type="button" onclick={() => (collapsed = !collapsed)}>
		<span class="umap-title">EMBEDDING PROJECTION</span>
		<ChevronDown class="umap-chevron {collapsed ? 'umap-chevron-collapsed' : ''}" />
	</button>

	{#if !collapsed}
		<div class="umap-chart">
			{#if status === "computing" || ontology.loadingProjection}
				<div class="umap-status">Computing projection...</div>
			{:else if status === "error"}
				<div class="umap-status">Projection unavailable</div>
			{:else if nodes.length === 0}
				<div class="umap-status">No embeddings</div>
			{:else}
				<svg
					viewBox="0 0 {SVG_W} {SVG_H}"
					preserveAspectRatio="xMidYMid meet"
					class="umap-svg"
				>
					{#each nodes as node, i (`proj-${i}`)}
						<circle
							cx={scaleX(node.x)}
							cy={scaleY(node.y)}
							r="3"
							fill={colorFor(node, i)}
							opacity="0.75"
						>
							<title>{node.content.slice(0, 80)}</title>
						</circle>
					{/each}
				</svg>
			{/if}
		</div>

		<div class="umap-meta">
			<span class="meta-item">pts: {nodes.length}</span>
			{#if ontology.projection?.total}
				<span class="meta-sep"></span>
				<span class="meta-item">total: {ontology.projection.total}</span>
			{/if}
			{#if cachedAt}
				<span class="meta-sep"></span>
				<span class="meta-item">cached: {formatDate(cachedAt)}</span>
			{/if}
		</div>
	{/if}
</div>

<style>
	.umap-zone {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.umap-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 10px;
		flex-shrink: 0;
		border: none;
		background: none;
		width: 100%;
		cursor: pointer;
		border-bottom: 1px solid var(--sig-border);
	}

	.umap-header:hover {
		background: var(--sig-surface-raised);
	}

	.umap-title {
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	:global(.umap-chevron) {
		width: 12px;
		height: 12px;
		color: var(--sig-text-muted);
		transition: transform 150ms ease;
	}

	:global(.umap-chevron-collapsed) {
		transform: rotate(-90deg);
	}

	.umap-chart {
		flex: 1;
		min-height: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 4px 6px;
	}

	.umap-svg {
		width: 100%;
		height: 100%;
		max-height: 100%;
	}

	.umap-status {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.umap-meta {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px 6px;
		flex-shrink: 0;
	}

	.meta-item {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		letter-spacing: 0.03em;
	}

	.meta-sep {
		width: 1px;
		height: 8px;
		background: var(--sig-border-strong);
	}
</style>
