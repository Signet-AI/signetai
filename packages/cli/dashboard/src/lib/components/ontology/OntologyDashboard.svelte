<script lang="ts">
	import { Input } from "$lib/components/ui/input/index.js";
	import Search from "@lucide/svelte/icons/search";
	import ScatterChart from "@lucide/svelte/icons/scatter-chart";
	import X from "@lucide/svelte/icons/x";
	import SchemaPanel from "./SchemaPanel.svelte";
	import ConstellationGraph from "./ConstellationGraph.svelte";
	import UmapPanel from "./UmapPanel.svelte";
	import InspectorPanel from "./InspectorPanel.svelte";
	import { ontology, searchGraph } from "./ontology-state.svelte";

	interface Props {
		agentId?: string;
	}
	const { agentId = "default" }: Props = $props();

	let umapOpen = $state(false);

	function handleSearch(e: Event): void {
		searchGraph((e.target as HTMLInputElement).value);
	}

	function clearSearch(): void {
		searchGraph("");
	}
</script>

<div class="ontology-dashboard">
	<!-- Search Bar -->
	<div class="filter-bar">
		<div class="filter-search">
			<Search class="search-icon" />
			<Input
				class="search-input"
				placeholder="Search entities..."
				bind:value={ontology.filterQuery}
				oninput={handleSearch}
			/>
			{#if ontology.searching}
				<span class="search-indicator">searching...</span>
			{:else if ontology.searchMatchIds !== null}
				<span class="search-indicator">{ontology.searchMatchIds.size} matches</span>
			{/if}
			{#if ontology.filterQuery}
				<button class="search-clear" type="button" onclick={clearSearch}>
					<X class="size-3" />
				</button>
			{/if}
		</div>
	</div>

	<!-- Main Grid -->
	<div class="ont-grid">
		<div class="zone-a"><SchemaPanel {agentId} /></div>
		<div class="zone-b">
			<ConstellationGraph {agentId} />
			{#if umapOpen}
				<div class="umap-float">
					<div class="umap-float-header">
						<span class="umap-float-title">EMBEDDING SPACE</span>
						<button class="umap-float-close" type="button" onclick={() => (umapOpen = false)}>
							<X class="umap-float-icon" />
						</button>
					</div>
					<div class="umap-float-body">
						<UmapPanel {agentId} />
					</div>
				</div>
			{:else}
				<button class="umap-toggle" type="button" onclick={() => (umapOpen = true)} title="Show embedding space">
					<ScatterChart class="umap-toggle-icon" />
				</button>
			{/if}
		</div>
		<div class="zone-d"><InspectorPanel {agentId} /></div>
	</div>
</div>

<style>
	.ontology-dashboard {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		overflow: hidden;
		background: var(--sig-bg);
	}

	/* Search Bar */
	.filter-bar {
		display: flex;
		align-items: center;
		padding: 6px 14px;
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
		background: var(--sig-surface);
	}

	.filter-search {
		flex: 1;
		position: relative;
		display: flex;
		align-items: center;
	}

	:global(.search-icon) {
		position: absolute;
		left: 9px;
		top: 50%;
		transform: translateY(-50%);
		width: 13px;
		height: 13px;
		color: var(--sig-text-muted);
		pointer-events: none;
		z-index: 1;
	}

	.search-indicator {
		position: absolute;
		right: 32px;
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		pointer-events: none;
	}

	.search-clear {
		position: absolute;
		right: 6px;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border: none;
		background: none;
		cursor: pointer;
		border-radius: 3px;
		color: var(--sig-text-muted);
	}

	.search-clear:hover {
		background: var(--sig-surface-raised);
		color: var(--sig-text-bright);
	}

	:global(.search-input) {
		font-family: var(--font-mono) !important;
		font-size: 11px !important;
		height: 30px !important;
		min-height: 30px !important;
		padding-left: 28px !important;
		border-color: var(--sig-border-strong) !important;
		background: var(--sig-bg) !important;
		color: var(--sig-text) !important;
	}

	:global(.search-input::placeholder) {
		font-size: 10px !important;
		color: var(--sig-text-muted) !important;
		opacity: 0.5 !important;
	}

	/* Main Grid */
	.ont-grid {
		display: grid;
		grid-template-columns: 210px 1fr 300px;
		grid-template-rows: 1fr;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.zone-a,
	.zone-d {
		min-height: 0;
		overflow: hidden;
	}

	.zone-b {
		position: relative;
		min-height: 0;
		overflow: hidden;
	}

	/* UMAP floating card */
	.umap-float {
		position: absolute;
		top: 10px;
		right: 10px;
		width: 260px;
		max-height: calc(100% - 20px);
		display: flex;
		flex-direction: column;
		background: var(--sig-surface);
		border: 1px solid var(--sig-border-strong);
		border-radius: 6px;
		box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
		z-index: 10;
		overflow: hidden;
	}

	.umap-float-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 10px;
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.umap-float-title {
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.umap-float-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		border: none;
		background: none;
		cursor: pointer;
		border-radius: 3px;
	}

	.umap-float-close:hover {
		background: var(--sig-surface-raised);
	}

	:global(.umap-float-icon) {
		width: 12px;
		height: 12px;
		color: var(--sig-text-muted);
	}

	.umap-float-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}

	/* UMAP toggle button */
	.umap-toggle {
		position: absolute;
		top: 10px;
		right: 10px;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border: 1px solid var(--sig-border-strong);
		border-radius: 5px;
		background: var(--sig-surface);
		cursor: pointer;
		z-index: 10;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
	}

	.umap-toggle:hover {
		background: var(--sig-surface-raised);
	}

	:global(.umap-toggle-icon) {
		width: 14px;
		height: 14px;
		color: var(--sig-text-muted);
	}
</style>
