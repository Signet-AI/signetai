<script lang="ts">
	import type { Memory } from "$lib/api";
	import { setTab } from "$lib/stores/navigation.svelte";
	import { API_BASE } from "$lib/api";
	import Brain from "@lucide/svelte/icons/brain";
	import { onMount } from "svelte";

	interface Props {
		memories: Memory[];
	}

	const { memories }: Props = $props();

	interface SpotlightMemory {
		id: string;
		content: string;
		access_count: number;
		importance: number;
	}

	let items = $state<SpotlightMemory[]>([]);
	let loaded = $state(false);

	async function fetchMostUsed(): Promise<void> {
		try {
			const res = await fetch(`${API_BASE}/api/memories/most-used?limit=50`);
			if (res.ok) {
				const data = await res.json();
				const results = (data.memories ?? []) as SpotlightMemory[];
				const valid = results
					.filter((r) => typeof r.id === "string" && r.id.length > 0 && typeof r.content === "string")
					.map((r) => ({
						id: r.id,
						content: r.content ?? "",
						access_count: r.access_count ?? 0,
						importance: r.importance ?? 0.5,
					}));
				if (valid.length > 0) {
					items = valid;
					loaded = true;
					return;
				}
			}
		} catch {
			// endpoint may not exist yet
		}

		// Fallback: use prop memories sorted by importance
		items = memories
			.map((m) => ({
				id: m.id,
				content: m.content,
				access_count: 0,
				importance: m.importance ?? 0.5,
			}))
			.sort((a, b) => b.importance - a.importance)
			.slice(0, 50);
		loaded = true;
	}

	onMount(() => {
		fetchMostUsed();
	});

	function label(m: SpotlightMemory): string {
		const text = m.content.trim();
		const first = text.split("\n")[0] ?? text;
		return first.length > 60 ? `${first.slice(0, 57)}...` : first;
	}

	function importanceColor(imp: number): string {
		if (imp >= 0.8) return "var(--sig-danger)";
		if (imp >= 0.5) return "var(--sig-warning)";
		return "var(--sig-success)";
	}
</script>

<div class="panel sig-panel">
	<div class="panel-header sig-panel-header">
		<span class="panel-title">SPOTLIGHT</span>
		<span class="panel-count">{items.length} RECALLED</span>
	</div>

	<div class="panel-body">
		{#if !loaded}
			<div class="empty-state">LOADING</div>
		{:else if items.length === 0}
			<div class="empty-state">
				<Brain class="empty-icon" />
				<span>NO MEMORIES YET</span>
			</div>
		{:else}
			<div class="entity-list">
				{#each items as memory, idx (memory.id)}
					<div class="entity-row">
						<span class="entity-idx">{String(idx + 1).padStart(2, "0")}</span>
						<span
							class="entity-dot"
							style="background: {importanceColor(memory.importance)}"
						></span>
						<span class="entity-name">{label(memory)}</span>
						{#if memory.access_count > 0}
							<span class="entity-count" title="times recalled">{memory.access_count}</span>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<div class="panel-footer sig-panel-footer">
		<button class="panel-link" onclick={() => setTab("cortex-memory")}>
			VIEW IN MEMORY
		</button>
	</div>
</div>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--sig-surface);
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-sm) var(--space-md);
		flex-shrink: 0;
	}

	.panel-title {
		font-family: var(--font-display);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-bright);
	}

	.panel-count {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}

	.panel-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: var(--space-sm) 0;
	}

	.panel-footer {
		padding: var(--space-sm) var(--space-md);
		flex-shrink: 0;
	}

	.panel-link {
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.08em;
		color: var(--sig-accent);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		transition: color var(--dur) var(--ease);
	}

	.panel-link:hover {
		color: var(--sig-highlight-text);
	}

	/* Entity list */
	.entity-list {
		display: flex;
		flex-direction: column;
	}

	.entity-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px var(--space-md);
		font-family: var(--font-mono);
		font-size: 10px;
		transition: background var(--dur) var(--ease);
	}

	.entity-row:hover {
		background: var(--sig-surface-raised);
	}

	.entity-idx {
		width: 16px;
		flex-shrink: 0;
		color: var(--sig-highlight);
		opacity: 0.4;
		font-size: 9px;
		font-variant-numeric: tabular-nums;
	}

	.entity-dot {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.entity-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--sig-text);
	}

	.entity-count {
		flex-shrink: 0;
		font-size: 9px;
		color: var(--sig-text-muted);
		font-variant-numeric: tabular-nums;
	}

	/* Empty state */
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-sm);
		height: 100%;
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
		text-align: center;
		line-height: 1.6;
		padding: var(--space-md);
	}

	:global(.panel .empty-icon) {
		width: 16px;
		height: 16px;
		color: var(--sig-border-strong);
	}
</style>
