<script lang="ts">
import type { EmbeddingPoint, Memory } from "../../api";
import {
	type RelationKind,
	type EmbeddingRelation,
	embeddingLabel,
	embeddingSourceLabel,
} from "./embedding-graph";

interface Props {
	graphSelected: EmbeddingPoint | null;
	embeddings: EmbeddingPoint[];
	embeddingById: Map<string, EmbeddingPoint>;
	activeNeighbors: EmbeddingRelation[];
	relationMode: RelationKind;
	loadingGlobalSimilar: boolean;
	globalSimilar: Memory[];
	embeddingSearchMatches: EmbeddingPoint[];
	embeddingSearch: string;
	onselectembedding: (id: string) => void;
	onclearselection: () => void;
	onloadglobalsimilar: () => void;
	onopenglobalsimilar: (memory: Memory) => void;
	onsetrelationmode: (mode: RelationKind) => void;
	onfocusembedding: () => void;
	onpintoggle: () => void;
	pinBusy: boolean;
	pinError: string;
}

let {
	graphSelected,
	embeddings,
	embeddingById,
	activeNeighbors,
	relationMode,
	loadingGlobalSimilar,
	globalSimilar,
	embeddingSearchMatches,
	embeddingSearch,
	onselectembedding,
	onclearselection,
	onloadglobalsimilar,
	onopenglobalsimilar,
	onsetrelationmode,
	onfocusembedding,
	onpintoggle,
	pinBusy,
	pinError,
}: Props = $props();

function getEmbeddingById(id: string): EmbeddingPoint | null {
	return embeddingById.get(id) ?? null;
}
</script>

<aside class="w-[340px] min-w-[300px] border-l border-[var(--sig-border)] bg-[var(--sig-surface)] flex flex-col gap-3 p-3 overflow-y-auto max-lg:w-full max-lg:min-w-0 max-lg:max-h-[42%] max-lg:border-l-0 max-lg:border-t max-lg:border-t-[var(--sig-border)]">
	<div class="flex items-center justify-between gap-2">
		<span class="font-[family-name:var(--font-mono)] text-[11px] tracking-[0.06em] uppercase text-[var(--sig-text)]">Inspector</span>
		{#if graphSelected}
			<button
				class="text-[11px] text-[var(--sig-accent)] bg-transparent border-none cursor-pointer p-0 hover:underline"
				onclick={onclearselection}
			>Clear</button>
		{/if}
	</div>

	{#if graphSelected}
		<div class="flex flex-wrap gap-[6px]">
			<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text)] border border-[var(--sig-border-strong)] px-[7px] py-[2px] bg-[rgba(255,255,255,0.04)]">{graphSelected.who ?? 'unknown'}</span>
			{#if graphSelected.type}
				<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text)] border border-[var(--sig-border-strong)] px-[7px] py-[2px] bg-[rgba(255,255,255,0.04)]">{graphSelected.type}</span>
			{/if}
			<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text)] border border-[var(--sig-border-strong)] px-[7px] py-[2px] bg-[rgba(255,255,255,0.04)]">importance {Math.round((graphSelected.importance ?? 0) * 100)}%</span>
			{#if graphSelected.pinned}
				<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-bright)] border border-[var(--sig-text-bright)] px-[7px] py-[2px] bg-[rgba(255,255,255,0.08)]">pinned</span>
			{/if}
		</div>

		<div class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-accent)] border border-[var(--sig-border-strong)] px-[7px] py-[5px] bg-transparent break-all">
			{embeddingSourceLabel(graphSelected)}
		</div>

		<p class="m-0 text-[13px] leading-[1.55] text-[var(--sig-text-bright)] whitespace-pre-wrap break-words">
			{graphSelected.content ?? graphSelected.text ?? "(No content preview available)"}
		</p>

		{#if graphSelected.tags?.length}
			<div class="flex flex-wrap gap-[6px]">
				{#each graphSelected.tags.slice(0, 8) as tag}
					<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text)] border border-[var(--sig-border-strong)] px-[7px] py-[2px] bg-[rgba(255,255,255,0.04)]">#{tag}</span>
				{/each}
			</div>
		{/if}

		<div class="flex gap-2">
			<button
				class="px-3 py-1 font-[family-name:var(--font-mono)] text-[10px] font-medium tracking-[0.1em] uppercase bg-transparent border border-[var(--sig-text-bright)] text-[var(--sig-text-bright)] cursor-pointer enabled:hover:bg-[var(--sig-text-bright)] enabled:hover:text-[var(--sig-bg)] disabled:opacity-40 disabled:cursor-not-allowed"
				onclick={onfocusembedding}
			>
				Center
			</button>
			<button
				class="px-3 py-1 font-[family-name:var(--font-mono)] text-[10px] font-medium tracking-[0.1em] uppercase bg-transparent border border-[var(--sig-text-bright)] text-[var(--sig-text-bright)] cursor-pointer enabled:hover:bg-[var(--sig-text-bright)] enabled:hover:text-[var(--sig-bg)] disabled:opacity-40 disabled:cursor-not-allowed"
				onclick={onpintoggle}
				disabled={pinBusy}
			>
				{pinBusy ? 'Saving...' : graphSelected.pinned ? 'Unpin' : 'Pin'}
			</button>
			<button
				class="px-3 py-1 font-[family-name:var(--font-mono)] text-[10px] font-medium tracking-[0.1em] uppercase bg-transparent border border-[var(--sig-text-bright)] text-[var(--sig-text-bright)] cursor-pointer enabled:hover:bg-[var(--sig-text-bright)] enabled:hover:text-[var(--sig-bg)] disabled:opacity-40 disabled:cursor-not-allowed"
				onclick={onloadglobalsimilar}
				disabled={loadingGlobalSimilar}
			>
				{loadingGlobalSimilar ? 'Loading...' : 'Global similar'}
			</button>
		</div>

		{#if pinError}
			<div class="border border-dashed border-[var(--sig-danger)] p-2 text-[11px] text-[var(--sig-danger)] leading-[1.5]">
				{pinError}
			</div>
		{/if}

		<div class="self-start flex border border-[var(--sig-border-strong)] overflow-hidden">
			<button
				class="px-2 py-0.5 text-[10px] font-medium font-[family-name:var(--font-mono)] bg-transparent border-none cursor-pointer tracking-[0.04em] hover:text-[var(--sig-text)] hover:bg-[var(--sig-surface-raised)] {relationMode === 'similar' ? 'text-[var(--sig-text-bright)] bg-[var(--sig-surface-raised)]' : 'text-[var(--sig-text-muted)]'}"
				onclick={() => onsetrelationmode('similar')}
			>
				Similar
			</button>
			<button
				class="px-2 py-0.5 text-[10px] font-medium font-[family-name:var(--font-mono)] bg-transparent border-none cursor-pointer tracking-[0.04em] hover:text-[var(--sig-text)] hover:bg-[var(--sig-surface-raised)] {relationMode === 'dissimilar' ? 'text-[var(--sig-text-bright)] bg-[var(--sig-surface-raised)]' : 'text-[var(--sig-text-muted)]'}"
				onclick={() => onsetrelationmode('dissimilar')}
			>
				Dissimilar
			</button>
		</div>

		<div class="flex flex-col gap-2">
			{#if activeNeighbors.length === 0}
				<div class="border border-dashed border-[var(--sig-border-strong)] p-3 text-[12px] text-[var(--sig-text-muted)] leading-[1.5]">
					No related embeddings in this view.
				</div>
			{:else}
				{#each activeNeighbors as relation}
					{@const item = getEmbeddingById(relation.id)}
					{#if item}
						<button
							class="grid grid-cols-[auto_1fr] gap-2 items-start w-full text-left border border-[var(--sig-border-strong)] bg-[rgba(255,255,255,0.03)] text-[var(--sig-text)] px-2 py-[7px] cursor-pointer hover:border-[var(--sig-text-muted)] hover:bg-[var(--sig-surface-raised)]"
							onclick={() => onselectembedding(item.id)}
						>
							<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-accent)] whitespace-nowrap">
								{Math.round(relation.score * 1000) / 1000}
							</span>
							<span class="text-[12px] leading-[1.45] text-[var(--sig-text-bright)] line-clamp-2">
								{embeddingLabel(item)}
							</span>
						</button>
					{/if}
				{/each}
			{/if}
		</div>

		{#if loadingGlobalSimilar}
			<div class="border border-dashed border-[var(--sig-border-strong)] p-3 text-[12px] text-[var(--sig-text-muted)] leading-[1.5]">
				Finding globally similar embeddings...
			</div>
		{:else if globalSimilar.length > 0}
			<div class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] tracking-[0.04em] uppercase">Global similar</div>
			<div class="flex flex-col gap-2">
				{#each globalSimilar as item}
					<button
						class="grid grid-cols-[auto_1fr] gap-2 items-start w-full text-left border border-[var(--sig-border-strong)] bg-[rgba(255,255,255,0.03)] text-[var(--sig-text)] px-2 py-[7px] cursor-pointer hover:border-[var(--sig-text-muted)] hover:bg-[var(--sig-surface-raised)]"
						onclick={() => onopenglobalsimilar(item)}
					>
						<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-accent)] whitespace-nowrap">global</span>
						<span class="text-[12px] leading-[1.45] text-[var(--sig-text-bright)] line-clamp-2">{item.content}</span>
					</button>
				{/each}
			</div>
		{/if}
	{:else}
		<div class="border border-dashed border-[var(--sig-border-strong)] p-3 text-[12px] text-[var(--sig-text-muted)] leading-[1.5]">
			Select a node to inspect content, source metadata, and similar or dissimilar neighbors.
		</div>

		{#if embeddingSearch && embeddingSearchMatches.length > 0}
			<div class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] tracking-[0.04em] uppercase">Search matches</div>
			<div class="flex flex-col gap-2">
				{#each embeddingSearchMatches as item}
					<button
						class="grid grid-cols-[auto_1fr] gap-2 items-start w-full text-left border border-[var(--sig-border-strong)] bg-[rgba(255,255,255,0.03)] text-[var(--sig-text)] px-2 py-[7px] cursor-pointer hover:border-[var(--sig-text-muted)] hover:bg-[var(--sig-surface-raised)]"
						onclick={() => onselectembedding(item.id)}
					>
						<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-accent)] whitespace-nowrap">{item.who}</span>
						<span class="text-[12px] leading-[1.45] text-[var(--sig-text-bright)] line-clamp-2">{embeddingLabel(item)}</span>
					</button>
				{/each}
			</div>
		{/if}
	{/if}
</aside>
