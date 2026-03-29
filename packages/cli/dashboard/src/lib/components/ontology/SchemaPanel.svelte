<script lang="ts">
	import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
	import Filter from "@lucide/svelte/icons/filter";
	import ChevronRight from "@lucide/svelte/icons/chevron-right";
	import {
		NODE_COLORS,
		TABLE_NODE_FILTER,
		TABLE_EDGE_FILTER,
		SCHEMA_GROUPS,
		GROUP_LABELS,
		allVisibleTables,
		type OntologyNodeKind,
		type OntologyEdgeKind,
		type SchemaGroup,
	} from "./ontology-data";
	import {
		ontology,
		selectSchemaTable,
		toggleNodeKind,
		toggleEdgeKind,
	} from "./ontology-state.svelte";

	interface Props {
		agentId?: string;
	}
	const { agentId = "default" }: Props = $props();

	// --- Node / edge kind definitions ---

	const NODE_KINDS: { kind: OntologyNodeKind; label: string }[] = [
		{ kind: "entity", label: "Entities" },
		{ kind: "aspect", label: "Aspects" },
		{ kind: "attribute", label: "Attributes" },
	];

	const EDGE_COLORS: Record<OntologyEdgeKind, string> = {
		dependency: "#d4a017",
		has_aspect: "#8b5cf6",
		has_attribute: "#06b6d4",
	};

	const EDGE_KINDS: { kind: OntologyEdgeKind; label: string }[] = [
		{ kind: "dependency", label: "Dependencies" },
		{ kind: "has_aspect", label: "Aspect links" },
		{ kind: "has_attribute", label: "Attr links" },
	];

	// --- Presets (quick view combos) ---

	const PRESETS = [
		{ id: "entities", label: "Entities", table: "entities" },
		{ id: "aspects", label: "With Aspects", table: "entity_aspects" },
		{ id: "full", label: "Full Graph", table: "entity_attributes" },
	] as const;

	// --- Derived counts ---

	const nodeCounts = $derived(
		Object.fromEntries(
			NODE_KINDS.map(({ kind }) => [
				kind,
				ontology.graphNodes.filter((n) => n.kind === kind).length,
			]),
		) as Record<OntologyNodeKind, number>,
	);

	const edgeCounts = $derived(
		Object.fromEntries(
			EDGE_KINDS.map(({ kind }) => [
				kind,
				ontology.graphEdges.filter((e) => e.kind === kind).length,
			]),
		) as Record<OntologyEdgeKind, number>,
	);

	const visibleCount = $derived(
		ontology.graphNodes.filter((n) => {
			if (!ontology.visibleNodeKinds.has(n.kind)) return false;
			if (ontology.searchMatchIds !== null && !ontology.searchMatchIds.has(n.id)) return false;
			return true;
		}).length,
	);

	const totalCount = $derived(ontology.graphNodes.length);

	// Detect which preset matches current toggle state (if any)
	const activePreset = $derived.by(() => {
		for (const p of PRESETS) {
			const pNodes = TABLE_NODE_FILTER[p.table];
			const pEdges = TABLE_EDGE_FILTER[p.table];
			if (!pNodes || !pEdges) continue;
			const nodesMatch =
				ontology.visibleNodeKinds.size === pNodes.size &&
				[...pNodes].every((k) => ontology.visibleNodeKinds.has(k));
			const edgesMatch =
				ontology.visibleEdgeKinds.size === pEdges.size &&
				[...pEdges].every((k) => ontology.visibleEdgeKinds.has(k));
			if (nodesMatch && edgesMatch) return p.id;
		}
		return null;
	});

	// --- Schema tables collapsed state ---

	let schemaOpen = $state(false);
	const collapsed = $state<Record<string, boolean>>({
		core: false,
		provenance: true,
		runtime: true,
		internal: true,
	});

	function selectPreset(table: string): void {
		selectSchemaTable(table, agentId);
	}
</script>

<div class="filter-panel">
	<div class="panel-header">
		<div class="panel-header-left">
			<Filter class="size-3 text-[var(--sig-text-muted)]" />
			<span class="panel-title">GRAPH FILTERS</span>
		</div>
	</div>

	<ScrollArea class="flex-1 min-h-0">
		<div class="filter-body">
			<!-- Summary -->
			{#if totalCount > 0}
				<div class="filter-summary">
					<span class="summary-count">{visibleCount}</span>
					<span class="summary-sep">/</span>
					<span class="summary-total">{totalCount}</span>
					<span class="summary-label">nodes</span>
				</div>
			{/if}

			<!-- Node Types -->
			<div class="filter-section">
				<div class="section-label">NODES</div>
				{#each NODE_KINDS as { kind, label } (kind)}
					{@const active = ontology.visibleNodeKinds.has(kind)}
					{@const count = nodeCounts[kind]}
					<button
						class="filter-chip"
						class:filter-chip-active={active}
						onclick={() => toggleNodeKind(kind)}
						type="button"
					>
						<span
							class="chip-dot"
							style="background: {active ? NODE_COLORS[kind] : 'var(--sig-border-strong)'}"
						></span>
						<span class="chip-label">{label}</span>
						<span class="chip-count">{count}</span>
					</button>
				{/each}
			</div>

			<!-- Edge Types -->
			<div class="filter-section">
				<div class="section-label">EDGES</div>
				{#each EDGE_KINDS as { kind, label } (kind)}
					{@const active = ontology.visibleEdgeKinds.has(kind)}
					{@const count = edgeCounts[kind]}
					<button
						class="filter-chip"
						class:filter-chip-active={active}
						onclick={() => toggleEdgeKind(kind)}
						type="button"
					>
						<span
							class="chip-line"
							class:chip-line-dashed={kind === "dependency"}
							style="border-color: {active ? EDGE_COLORS[kind] : 'var(--sig-border-strong)'}"
						></span>
						<span class="chip-label">{label}</span>
						<span class="chip-count">{count}</span>
					</button>
				{/each}
			</div>

			<!-- Quick Views -->
			<div class="filter-section">
				<div class="section-label">QUICK VIEWS</div>
				{#each PRESETS as preset (preset.id)}
					{@const isActive = activePreset === preset.id}
					<button
						class="preset-row"
						class:preset-active={isActive}
						onclick={() => selectPreset(preset.table)}
						type="button"
					>
						<span class="preset-radio" class:preset-radio-on={isActive}></span>
						<span class="preset-label">{preset.label}</span>
					</button>
				{/each}
			</div>

			<!-- All Tables (collapsed reference) -->
			<div class="filter-section">
				<button
					class="section-label section-toggle"
					onclick={() => (schemaOpen = !schemaOpen)}
					type="button"
				>
					<ChevronRight
						class="size-3 text-[var(--sig-text-muted)] transition-transform duration-150 {schemaOpen ? 'rotate-90' : ''}"
					/>
					<span>ALL TABLES</span>
					<span class="section-count">{allVisibleTables().length}</span>
				</button>
				{#if schemaOpen}
					<div class="schema-tables">
						{#each [...SCHEMA_GROUPS.entries()] as [group, groupTables] (group)}
							{@const isCollapsed = collapsed[group] ?? false}
							<button
								class="schema-group-btn"
								onclick={() => (collapsed[group] = !collapsed[group])}
								type="button"
							>
								<ChevronRight
									class="size-2.5 text-[var(--sig-text-muted)] transition-transform duration-150 {isCollapsed ? '' : 'rotate-90'}"
								/>
								<span class="schema-group-label"
									>{GROUP_LABELS[group as SchemaGroup]}</span
								>
								<span class="schema-group-count">{groupTables.length}</span>
							</button>
							{#if !isCollapsed}
								{#each groupTables as table (table.name)}
									<button
										class="schema-table-row"
										class:schema-table-active={ontology.schemaTable ===
											table.name}
										onclick={() => selectSchemaTable(table.name, agentId)}
										type="button"
									>
										{table.name}
									</button>
								{/each}
							{/if}
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</ScrollArea>
</div>

<style>
	.filter-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--sig-surface);
		border-right: 1px solid var(--sig-border);
	}

	.panel-header {
		display: flex;
		align-items: center;
		padding: 10px 12px;
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.panel-header-left {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.panel-title {
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.filter-body {
		padding: 6px 0;
	}

	/* Summary */
	.filter-summary {
		padding: 2px 12px 8px;
		display: flex;
		align-items: baseline;
		gap: 2px;
	}

	.summary-count {
		font-family: var(--font-mono);
		font-size: 16px;
		font-weight: 700;
		color: var(--sig-text-bright);
	}

	.summary-sep {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		margin: 0 1px;
	}

	.summary-total {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-muted);
	}

	.summary-label {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		margin-left: 4px;
	}

	/* Sections */
	.filter-section {
		padding: 2px 0;
	}

	.section-label {
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
		padding: 6px 12px 3px;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.section-count {
		font-weight: 400;
		opacity: 0.5;
	}

	/* Filter chips (node/edge toggles) */
	.filter-chip {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 4px 12px;
		border: none;
		background: none;
		cursor: pointer;
		transition: background 80ms, opacity 120ms;
		opacity: 0.35;
	}

	.filter-chip-active {
		opacity: 1;
	}

	.filter-chip:hover {
		background: var(--sig-surface-raised);
		opacity: 0.85;
	}

	.filter-chip-active:hover {
		opacity: 1;
	}

	.chip-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
		transition: background 150ms;
	}

	.chip-line {
		width: 14px;
		height: 0;
		border-bottom: 2px solid;
		flex-shrink: 0;
		transition: border-color 150ms;
	}

	.chip-line-dashed {
		border-bottom-style: dashed;
	}

	.chip-label {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text);
		flex: 1;
		text-align: left;
	}

	.filter-chip-active .chip-label {
		color: var(--sig-text-bright);
	}

	.chip-count {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		min-width: 24px;
		text-align: right;
	}

	/* Quick view presets */
	.preset-row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 4px 12px;
		border: none;
		background: none;
		cursor: pointer;
		transition: background 80ms;
	}

	.preset-row:hover {
		background: var(--sig-surface-raised);
	}

	.preset-radio {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		border: 1.5px solid var(--sig-border-strong);
		flex-shrink: 0;
		transition: border-color 150ms, background 150ms, box-shadow 150ms;
	}

	.preset-radio-on {
		border-color: var(--sig-electric);
		background: var(--sig-electric);
		box-shadow: 0 0 6px var(--sig-electric-dim);
	}

	.preset-label {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text);
	}

	.preset-active .preset-label {
		color: var(--sig-text-bright);
		font-weight: 600;
	}

	/* Schema tables (collapsed reference) */
	.section-toggle {
		cursor: pointer;
		border: none;
		background: none;
		width: 100%;
		border-top: 1px solid var(--sig-border);
		margin-top: 4px;
		padding-top: 8px;
	}

	.section-toggle:hover {
		background: var(--sig-surface-raised);
	}

	.schema-tables {
		padding: 2px 0 0 4px;
	}

	.schema-group-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		width: 100%;
		padding: 3px 10px;
		border: none;
		background: none;
		cursor: pointer;
	}

	.schema-group-btn:hover {
		background: var(--sig-surface-raised);
	}

	.schema-group-label {
		font-family: var(--font-mono);
		font-size: 8px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
		flex: 1;
		text-align: left;
	}

	.schema-group-count {
		font-family: var(--font-mono);
		font-size: 8px;
		color: var(--sig-text-muted);
		opacity: 0.5;
	}

	.schema-table-row {
		display: block;
		width: 100%;
		padding: 2px 10px 2px 22px;
		border: none;
		background: none;
		cursor: pointer;
		text-align: left;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		transition: background 60ms, color 60ms;
	}

	.schema-table-row:hover {
		background: var(--sig-surface-raised);
		color: var(--sig-text);
	}

	.schema-table-active {
		color: var(--sig-text-bright);
		background: var(--sig-electric-dim);
	}
</style>
