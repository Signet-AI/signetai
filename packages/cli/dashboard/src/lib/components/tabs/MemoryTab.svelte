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
	memories: Memory[];
}

let { memories }: Props = $props();

let display = $derived(
	mem.similarSourceId
		? mem.similarResults
		: mem.searched || hasActiveFilters()
			? mem.results
			: memories,
);

function parseMemoryTags(raw: Memory["tags"]): string[] {
	if (!raw) return [];
	if (Array.isArray(raw)) {
		return raw.filter(
			(tag) => typeof tag === "string" && tag.trim().length > 0,
		);
	}
	const trimmed = raw.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (Array.isArray(parsed)) {
				return parsed.filter(
					(tag): tag is string =>
						typeof tag === "string" && tag.trim().length > 0,
				);
			}
		} catch {
			// fallthrough
		}
	}
	return trimmed
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
}

function memoryScoreLabel(memory: Memory): string | null {
	if (typeof memory.score !== "number") return null;
	const score = Math.round(memory.score * 100);
	const source = memory.source ?? "semantic";
	return `${source} ${score}%`;
}

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

<section class="memory-library">
	<div class="memory-library-toolbar">
		<label class="memory-search-shell">
			<span class="memory-search-glyph">◇</span>
			<input
				type="text"
				class="memory-library-search"
				bind:value={mem.query}
				oninput={queueMemorySearch}
				onkeydown={(e) => e.key === 'Enter' && doSearch()}
				placeholder="Search across embeddings..."
			/>
		</label>

		{#if mem.searched || hasActiveFilters() || mem.similarSourceId}
			<button class="btn-text memory-toolbar-clear" onclick={clearAll}>Clear</button>
		{/if}
	</div>

	<div class="memory-library-filters">
		<select class="memory-filter-select" bind:value={mem.filterWho}>
			<option value="">Any source</option>
			{#each mem.whoOptions as w}
				<option>{w}</option>
			{/each}
		</select>
		<input
			class="memory-filter-input"
			placeholder="Tags (comma separated)"
			bind:value={mem.filterTags}
		/>
		<input
			type="number"
			class="memory-filter-number"
			min="0"
			max="1"
			step="0.1"
			bind:value={mem.filterImportanceMin}
			placeholder="imp"
		/>
		<input type="date" class="memory-filter-date" bind:value={mem.filterSince} />
		<button
			class="memory-filter-pill"
			class:memory-filter-pill-active={mem.filterPinned}
			onclick={() => mem.filterPinned = !mem.filterPinned}
		>
			pinned only
		</button>
	</div>

	<div class="memory-library-types">
		{#each ['fact', 'decision', 'preference', 'issue', 'learning'] as t}
			<button
				class="memory-type-chip"
				class:memory-type-chip-active={mem.filterType === t}
				onclick={() => mem.filterType = mem.filterType === t ? '' : t}
			>
				{t}
			</button>
		{/each}
	</div>

	{#if mem.similarSourceId && mem.similarSource}
		<div class="memory-similar-banner">
			<span>
				Similar to: {(mem.similarSource.content ?? '').slice(0, 100)}
				{(mem.similarSource.content ?? '').length > 100 ? '...' : ''}
			</span>
			<button
				class="btn-text"
				onclick={() => {
					mem.similarSourceId = null;
					mem.similarSource = null;
					mem.similarResults = [];
				}}
			>
				Back to list
			</button>
		</div>
	{/if}

	<div class="memory-doc-grid">
		{#if mem.loadingSimilar}
			<div class="empty memory-library-empty">Finding similar memories...</div>
		{:else}
			{#each display as memory}
				{@const tags = parseMemoryTags(memory.tags)}
				{@const scoreLabel = memoryScoreLabel(memory)}

				<article class="memory-doc">
					<header class="memory-doc-head">
						<div class="memory-doc-stamp">
							<span class="memory-doc-source">{memory.who || 'unknown'}</span>
							{#if memory.type}
								<span class="memory-doc-type">{memory.type}</span>
							{/if}
							{#if memory.pinned}
								<span class="memory-doc-pin">pinned</span>
							{/if}
						</div>
						<span class="memory-doc-date">{formatDate(memory.created_at)}</span>
					</header>

					<p class="memory-doc-content">{memory.content}</p>

					{#if tags.length > 0}
						<div class="memory-doc-tags">
							{#each tags.slice(0, 6) as tag}
								<span class="memory-doc-tag">#{tag}</span>
							{/each}
						</div>
					{/if}

					<footer class="memory-doc-foot">
						<span class="memory-doc-importance">
							importance {Math.round((memory.importance ?? 0) * 100)}%
						</span>

						{#if scoreLabel}
							<span class="memory-doc-match">{scoreLabel}</span>
						{/if}

						{#if memory.id}
							<button
								class="btn-similar btn-similar-visible"
								onclick={() => findSimilar(memory.id, memory)}
								title="Find similar"
							>
								similar
							</button>
						{/if}
					</footer>
				</article>
			{:else}
				<div class="empty memory-library-empty">
					{mem.similarSourceId
						? 'No similar memories found.'
						: mem.searched || hasActiveFilters()
							? 'No memories matched your search.'
							: 'No memories available yet.'}
				</div>
			{/each}
		{/if}
	</div>
</section>
