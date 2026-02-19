<script lang="ts">
	import type { Memory } from "$lib/api";
	import {
		mem,
		hasActiveFilters,
		queueMemorySearch,
		doSearch,
		findSimilar,
		clearAll,
	} from "$lib/stores/memory.svelte";

	interface Props {
		totalCount: number;
		memories: Memory[];
	}

	let { totalCount, memories }: Props = $props();

	let displayMemories = $derived(
		mem.similarSourceId
			? mem.similarResults
			: mem.searched || hasActiveFilters()
				? mem.results
				: memories,
	);

	function formatDate(dateStr: string): string {
		try {
			const date = new Date(dateStr);
			return date.toLocaleString("en-US", {
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
			});
		} catch {
			return dateStr;
		}
	}
</script>

<aside class="sidebar sidebar-right">
	<section class="section">
		<div class="section-header">
			<span class="section-title">Memories</span>
			<span class="badge">{totalCount}</span>
		</div>

		<div class="search-row">
			<input
				type="text"
				class="search-input"
				bind:value={mem.query}
				oninput={queueMemorySearch}
				onkeydown={(e) => e.key === 'Enter' && doSearch()}
				placeholder="Search embeddings..."
			/>
			<button
				class="btn-icon"
				class:filter-active={hasActiveFilters()}
				onclick={() => mem.filtersOpen = !mem.filtersOpen}
				title="Filters"
			>
				<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3">
					<path d="M1 2h10L7 6.5V10.5L5 9.5V6.5L1 2z"/>
				</svg>
			</button>
			{#if mem.searched || hasActiveFilters() || mem.similarSourceId}
				<button class="btn-text" onclick={clearAll}>Clear</button>
			{/if}
		</div>

		{#if mem.filtersOpen}
			<div class="filter-panel">
				<div class="filter-row">
					{#each ['fact','decision','preference','issue','learning'] as t}
						<button
							class="pill"
							class:pill-active={mem.filterType === t}
							onclick={() => mem.filterType = mem.filterType === t ? '' : t}
						>{t}</button>
					{/each}
				</div>
				<select class="filter-select" bind:value={mem.filterWho}>
					<option value="">any source</option>
					{#each mem.whoOptions as w}<option>{w}</option>{/each}
				</select>
				<input
					class="filter-input"
					placeholder="tags (comma-sep)..."
					bind:value={mem.filterTags}
				/>
				<div class="filter-row">
					<span class="filter-label">imp ≥</span>
					<input
						type="number" class="filter-num"
						min="0" max="1" step="0.1"
						bind:value={mem.filterImportanceMin}
					/>
					<span class="filter-label">since</span>
					<input type="date" class="filter-date" bind:value={mem.filterSince} />
				</div>
				<button
					class="pill"
					class:pill-active={mem.filterPinned}
					onclick={() => mem.filterPinned = !mem.filterPinned}
				>pinned only</button>
			</div>
		{/if}

		{#if mem.similarSourceId && mem.similarSource}
			<div class="similar-header">
				<span>∿ similar to: {(mem.similarSource.content ?? '').slice(0, 40)}{(mem.similarSource.content ?? '').length > 40 ? '…' : ''}</span>
				<button class="btn-text" onclick={() => { mem.similarSourceId = null; mem.similarSource = null; mem.similarResults = []; }}>✕</button>
			</div>
		{:else if mem.searched || hasActiveFilters()}
			<div class="search-results">
				{mem.searching ? 'Searching…' : `${mem.results.length} results`}
			</div>
		{/if}
	</section>

	<div class="memory-scroll">
		{#if mem.loadingSimilar}
			<div class="empty">Finding similar…</div>
		{:else}
		{#each displayMemories as memory}
			<div class="memory-item">
				<p class="memory-content">{memory.content}</p>
				<div class="memory-footer">
					<span class="memory-source">{memory.who}</span>
					{#if memory.type}
						<span class="memory-type">{memory.type}</span>
					{/if}
					{#if memory.importance && memory.importance >= 0.9}
						<span class="memory-critical">critical</span>
					{/if}
					{#if memory.pinned}
						<span class="memory-pinned">📌</span>
					{/if}
					<span class="memory-time">{formatDate(memory.created_at)}</span>
					<button
						class="btn-similar"
						onclick={() => findSimilar(memory.id, memory)}
						title="Find similar"
					>∿</button>
				</div>
			</div>
		{:else}
			<div class="empty">
				{mem.similarSourceId ? 'No similar memories' : mem.searched || hasActiveFilters() ? 'No results' : 'No memories'}
			</div>
		{/each}
		{/if}
	</div>
</aside>
