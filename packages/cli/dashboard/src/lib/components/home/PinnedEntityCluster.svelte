<script lang="ts">
import { Card, CardContent, CardHeader, CardTitle } from "$lib/components/ui/card/index.js";
import { setTab } from "$lib/stores/navigation.svelte";
import Network from "@lucide/svelte/icons/network";
import { onMount } from "svelte";

const isDev = import.meta.env.DEV;
const API_BASE = isDev ? "http://localhost:3850" : "";

interface PinnedEntity {
	id: string;
	name: string;
	type?: string;
	mentionCount?: number;
}

let entities = $state<PinnedEntity[]>([]);
let loaded = $state(false);

async function fetchPinned(): Promise<void> {
	try {
		const res = await fetch(`${API_BASE}/api/knowledge/entities?pinned=true&limit=6`);
		if (res.ok) {
			const data = await res.json();
			entities = data.entities ?? data.items ?? [];
		}
	} catch {
		// endpoint may not exist yet — show empty state
	}
	loaded = true;
}

onMount(() => {
	fetchPinned();
});
</script>

<Card
	class="flex flex-1 flex-col overflow-hidden rounded-none
		border-[var(--sig-border)] py-0
		shadow-none"
	style="background: var(--sig-surface);"
>
	<CardHeader class="px-3 py-2.5">
		<div class="flex items-center gap-2">
			<Network class="size-3.5 text-[var(--sig-text-muted)]" />
			<CardTitle
				class="font-display text-[11px] font-bold uppercase tracking-[0.1em]
					text-[var(--sig-text-bright)]"
			>
				Spotlight
			</CardTitle>
		</div>
	</CardHeader>

	<CardContent class="flex flex-1 flex-col px-3 pb-3 pt-0">
		{#if !loaded}
			<div class="flex-1"></div>
		{:else if entities.length === 0}
			<!-- Empty state -->
			<div class="flex flex-1 flex-col items-center justify-center gap-2 py-4">
				<div
					class="flex items-center justify-center rounded-md size-10"
					style="background: var(--sig-surface-raised); border: 1px solid var(--sig-border)"
				>
					<Network class="size-5 text-[var(--sig-text-muted)]" />
				</div>
				<p
					class="max-w-[180px] text-center font-[family-name:var(--font-mono)]
						text-[10px] leading-4 text-[var(--sig-text-muted)]"
				>
					Pin an entity in Knowledge to set it as your spotlight
				</p>
			</div>
		{:else}
			<!-- Pinned entity list -->
			<div class="flex flex-1 flex-col gap-1.5">
				{#each entities as entity, idx (entity.id ?? `entity-${idx}`)}
					<div
						class="flex items-center gap-2 rounded-sm px-2 py-1.5"
						style="background: var(--sig-surface-raised); border: 1px solid var(--sig-border)"
					>
						<div
							class="size-2 shrink-0 rounded-full"
							style="background: var(--sig-accent)"
						></div>
						<span
							class="min-w-0 truncate font-[family-name:var(--font-mono)]
								text-[11px] text-[var(--sig-text)]"
						>
							{entity.name}
						</span>
						{#if entity.mentionCount !== undefined}
							<span class="sig-micro ml-auto shrink-0 text-[var(--sig-text-muted)]">
								{entity.mentionCount}
							</span>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		<button
			class="mt-2 sig-meta text-[var(--sig-accent)] transition-opacity hover:opacity-80"
			onclick={() => setTab("knowledge")}
		>
			View in Knowledge &rarr;
		</button>
	</CardContent>
</Card>
