<script lang="ts">
import type {
	ConstellationAspect,
	ConstellationAttribute,
	ConstellationEntity,
	ConstellationGraph,
	EmbeddingPoint,
	Memory,
} from "../../api";
import {
	type RelationKind,
	type EmbeddingRelation,
	type GraphNode,
	type NodeType,
	embeddingLabel,
	embeddingSourceLabel,
	entityFillStyle,
	entityTypeColor,
} from "./embedding-graph";

interface Props {
	containerClass?: string;
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
	selectedNodeType?: NodeType;
	selectedEntityData?: ConstellationEntity | null;
	selectedAspectData?: ConstellationAspect | null;
	selectedAttributeData?: ConstellationAttribute | null;
	parentEntityId?: string | null;
	parentAspectId?: string | null;
	constellationOverlay?: ConstellationGraph | null;
}

let {
	containerClass = "",
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
	selectedNodeType = undefined,
	selectedEntityData = null,
	selectedAspectData = null,
	selectedAttributeData = null,
	parentEntityId = null,
	parentAspectId = null,
	constellationOverlay = null,
}: Props = $props();

const isEntitySelected = $derived(selectedNodeType === "entity" && selectedEntityData !== null);
const isAspectSelected = $derived(selectedNodeType === "aspect" && selectedAspectData !== null);
const isAttributeSelected = $derived(selectedNodeType === "attribute" && selectedAttributeData !== null);

const entityDependencies = $derived.by(() => {
	if (!selectedEntityData || !constellationOverlay) return [];
	const id = selectedEntityData.id;
	return constellationOverlay.dependencies.filter(
		(d) => d.sourceEntityId === id || d.targetEntityId === id,
	);
});

const parentEntity = $derived.by(() => {
	if (!parentEntityId || !constellationOverlay) return null;
	return constellationOverlay.entities.find((e) => e.id === parentEntityId) ?? null;
});

const parentAspect = $derived.by(() => {
	if (!parentAspectId || !parentEntity) return null;
	return parentEntity.aspects.find((a) => a.id === parentAspectId) ?? null;
});

function entityNameById(entityId: string): string {
	if (!constellationOverlay) return entityId;
	const entity = constellationOverlay.entities.find((e) => e.id === entityId);
	return entity?.name ?? entityId;
}

function getEmbeddingById(id: string): EmbeddingPoint | null {
	return embeddingById.get(id) ?? null;
}
</script>

<aside class={`flex flex-col gap-3 p-3 overflow-y-auto ${containerClass}`}>
	<div class="flex items-center justify-between gap-2">
		<span class="font-[family-name:var(--font-mono)] text-[11px] tracking-[0.06em] uppercase text-[var(--sig-text)]">Inspector</span>
		{#if graphSelected}
			<button
				class="text-[11px] text-[var(--sig-accent)] bg-transparent border-none cursor-pointer p-0 hover:underline"
				onclick={onclearselection}
			>Clear</button>
		{/if}
	</div>

	{#if isEntitySelected && selectedEntityData}
		<!-- Entity inspection mode -->
		<div class="flex flex-wrap gap-[6px]">
			<span
				class="font-[family-name:var(--font-mono)] text-[10px] border px-[7px] py-[2px]"
				style={`color: ${entityTypeColor(selectedEntityData.entityType)}; border-color: ${entityTypeColor(selectedEntityData.entityType)}; background: rgba(255,255,255,0.04);`}
			>
				{selectedEntityData.entityType}
			</span>
			{#if selectedEntityData.pinned}
				<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-bright)] border border-[var(--sig-text-bright)] px-[7px] py-[2px] bg-[rgba(255,255,255,0.08)]">pinned</span>
			{/if}
		</div>

		<div class="font-[family-name:var(--font-mono)] text-[14px] text-[var(--sig-text-bright)] font-bold">
			{selectedEntityData.name}
		</div>

		<div class="grid grid-cols-3 gap-1 text-[10px] font-[family-name:var(--font-mono)] text-[var(--sig-text-muted)]">
			<div class="border border-[var(--sig-border-strong)] px-2 py-1 text-center">
				<div class="text-[var(--sig-text-bright)]">{selectedEntityData.aspects.length}</div>
				<div>aspects</div>
			</div>
			<div class="border border-[var(--sig-border-strong)] px-2 py-1 text-center">
				<div class="text-[var(--sig-text-bright)]">{selectedEntityData.aspects.reduce((s, a) => s + a.attributes.length, 0)}</div>
				<div>attributes</div>
			</div>
			<div class="border border-[var(--sig-border-strong)] px-2 py-1 text-center">
				<div class="text-[var(--sig-text-bright)]">{entityDependencies.length}</div>
				<div>deps</div>
			</div>
		</div>

		<div class="flex gap-2">
			<button
				class="px-3 py-1 font-[family-name:var(--font-mono)] text-[10px] font-medium tracking-[0.1em] uppercase bg-transparent border border-[var(--sig-text-bright)] text-[var(--sig-text-bright)] cursor-pointer enabled:hover:bg-[var(--sig-text-bright)] enabled:hover:text-[var(--sig-bg)]"
				onclick={onfocusembedding}
			>
				Center
			</button>
		</div>

		{#if selectedEntityData.aspects.length > 0}
			<div class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] tracking-[0.04em] uppercase">Aspects ({selectedEntityData.aspects.length})</div>
			<div class="flex flex-col gap-2">
				{#each selectedEntityData.aspects as aspect}
					<button
						class="grid grid-cols-[auto_1fr] gap-2 items-start w-full text-left border border-[var(--sig-border-strong)] bg-[rgba(255,255,255,0.03)] text-[var(--sig-text)] px-2 py-[7px] cursor-pointer hover:border-[var(--sig-text-muted)] hover:bg-[var(--sig-surface-raised)]"
						onclick={() => onselectembedding(`aspect:${aspect.id}`)}
					>
						<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-accent)] whitespace-nowrap">w{Math.round(aspect.weight * 100)}%</span>
						<span class="text-[12px] leading-[1.45] text-[var(--sig-text-bright)] line-clamp-2">{aspect.name}</span>
					</button>
				{/each}
			</div>
		{/if}

		{#if entityDependencies.length > 0}
			<div class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] tracking-[0.04em] uppercase">Dependencies</div>
			<div class="flex flex-col gap-2">
				{#each entityDependencies as dep}
					{@const isOutgoing = dep.sourceEntityId === selectedEntityData.id}
					{@const otherEntityId = isOutgoing ? dep.targetEntityId : dep.sourceEntityId}
					<button
						class="grid grid-cols-[auto_1fr] gap-2 items-start w-full text-left border border-[var(--sig-border-strong)] bg-[rgba(255,255,255,0.03)] text-[var(--sig-text)] px-2 py-[7px] cursor-pointer hover:border-[var(--sig-text-muted)] hover:bg-[var(--sig-surface-raised)]"
						onclick={() => onselectembedding(`entity:${otherEntityId}`)}
					>
						<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-accent)] whitespace-nowrap">{isOutgoing ? '->' : '<-'} {dep.dependencyType}</span>
						<span class="text-[12px] leading-[1.45] text-[var(--sig-text-bright)] line-clamp-2">{entityNameById(otherEntityId)}</span>
					</button>
				{/each}
			</div>
		{/if}

	{:else if isAspectSelected && selectedAspectData}
		<!-- Aspect inspection mode -->
		<div class="flex flex-wrap gap-[6px]">
			<span class="font-[family-name:var(--font-mono)] text-[10px] border border-[var(--sig-border-strong)] px-[7px] py-[2px] bg-[rgba(255,255,255,0.04)] text-[var(--sig-text)]">aspect</span>
			<span class="font-[family-name:var(--font-mono)] text-[10px] border border-[var(--sig-border-strong)] px-[7px] py-[2px] bg-[rgba(255,255,255,0.04)] text-[var(--sig-text)]">weight {Math.round(selectedAspectData.weight * 100)}%</span>
		</div>

		<div class="font-[family-name:var(--font-mono)] text-[14px] text-[var(--sig-text-bright)] font-bold">
			{selectedAspectData.name}
		</div>

		{#if parentEntity}
			<button
				class="w-full text-left border border-[var(--sig-border-strong)] bg-[rgba(255,255,255,0.03)] text-[var(--sig-text)] px-2 py-[7px] cursor-pointer hover:border-[var(--sig-text-muted)] hover:bg-[var(--sig-surface-raised)]"
				onclick={() => parentEntity && onselectembedding(`entity:${parentEntity.id}`)}
			>
				<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] uppercase">Parent entity</span>
				<div class="text-[12px] text-[var(--sig-text-bright)]">{parentEntity.name}</div>
			</button>
		{/if}

		<div class="flex gap-2">
			<button
				class="px-3 py-1 font-[family-name:var(--font-mono)] text-[10px] font-medium tracking-[0.1em] uppercase bg-transparent border border-[var(--sig-text-bright)] text-[var(--sig-text-bright)] cursor-pointer enabled:hover:bg-[var(--sig-text-bright)] enabled:hover:text-[var(--sig-bg)]"
				onclick={onfocusembedding}
			>
				Center
			</button>
		</div>

		{#if selectedAspectData.attributes.length > 0}
			<div class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] tracking-[0.04em] uppercase">Attributes ({selectedAspectData.attributes.length})</div>
			<div class="flex flex-col gap-2">
				{#each selectedAspectData.attributes as attr}
					<button
						class="grid grid-cols-[auto_1fr] gap-2 items-start w-full text-left border border-[var(--sig-border-strong)] bg-[rgba(255,255,255,0.03)] text-[var(--sig-text)] px-2 py-[7px] cursor-pointer hover:border-[var(--sig-text-muted)] hover:bg-[var(--sig-surface-raised)]"
						onclick={() => onselectembedding(`attr:${attr.id}`)}
					>
						<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-accent)] whitespace-nowrap">{attr.kind}</span>
						<span class="text-[12px] leading-[1.45] text-[var(--sig-text-bright)] line-clamp-2">{attr.content}</span>
					</button>
				{/each}
			</div>
		{/if}

	{:else if isAttributeSelected && selectedAttributeData}
		<!-- Attribute inspection mode -->
		<div class="flex flex-wrap gap-[6px]">
			<span class="font-[family-name:var(--font-mono)] text-[10px] border border-[var(--sig-border-strong)] px-[7px] py-[2px] bg-[rgba(255,255,255,0.04)] text-[var(--sig-text)]">{selectedAttributeData.kind}</span>
			<span class="font-[family-name:var(--font-mono)] text-[10px] border border-[var(--sig-border-strong)] px-[7px] py-[2px] bg-[rgba(255,255,255,0.04)] text-[var(--sig-text)]">importance {Math.round(selectedAttributeData.importance * 100)}%</span>
		</div>

		<p class="m-0 text-[13px] leading-[1.55] text-[var(--sig-text-bright)] whitespace-pre-wrap break-words">
			{selectedAttributeData.content}
		</p>

		{#if parentEntity}
			<button
				class="w-full text-left border border-[var(--sig-border-strong)] bg-[rgba(255,255,255,0.03)] text-[var(--sig-text)] px-2 py-[7px] cursor-pointer hover:border-[var(--sig-text-muted)] hover:bg-[var(--sig-surface-raised)]"
				onclick={() => parentEntity && onselectembedding(`entity:${parentEntity.id}`)}
			>
				<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] uppercase">Parent entity</span>
				<div class="text-[12px] text-[var(--sig-text-bright)]">{parentEntity.name}</div>
			</button>
		{/if}

		{#if parentAspect}
			<button
				class="w-full text-left border border-[var(--sig-border-strong)] bg-[rgba(255,255,255,0.03)] text-[var(--sig-text)] px-2 py-[7px] cursor-pointer hover:border-[var(--sig-text-muted)] hover:bg-[var(--sig-surface-raised)]"
				onclick={() => parentAspect && onselectembedding(`aspect:${parentAspect.id}`)}
			>
				<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] uppercase">Parent aspect</span>
				<div class="text-[12px] text-[var(--sig-text-bright)]">{parentAspect.name}</div>
			</button>
		{/if}

		<div class="flex gap-2">
			<button
				class="px-3 py-1 font-[family-name:var(--font-mono)] text-[10px] font-medium tracking-[0.1em] uppercase bg-transparent border border-[var(--sig-text-bright)] text-[var(--sig-text-bright)] cursor-pointer enabled:hover:bg-[var(--sig-text-bright)] enabled:hover:text-[var(--sig-bg)]"
				onclick={onfocusembedding}
			>
				Center
			</button>
		</div>

		{#if selectedAttributeData.memoryId}
			{@const linkedMem = embeddingById.get(selectedAttributeData.memoryId)}
			{#if linkedMem}
				<div class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-text-muted)] tracking-[0.04em] uppercase">Linked memory</div>
				<button
					class="grid grid-cols-[auto_1fr] gap-2 items-start w-full text-left border border-[var(--sig-border-strong)] bg-[rgba(255,255,255,0.03)] text-[var(--sig-text)] px-2 py-[7px] cursor-pointer hover:border-[var(--sig-text-muted)] hover:bg-[var(--sig-surface-raised)]"
					onclick={() => linkedMem && onselectembedding(linkedMem.id)}
				>
					<span class="font-[family-name:var(--font-mono)] text-[10px] text-[var(--sig-accent)] whitespace-nowrap">{linkedMem.who ?? 'memory'}</span>
					<span class="text-[12px] leading-[1.45] text-[var(--sig-text-bright)] line-clamp-2">{embeddingLabel(linkedMem)}</span>
				</button>
			{/if}
		{/if}

	{:else if graphSelected}
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
					No related memories in this view.
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
				Finding similar memories...
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
