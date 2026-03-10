<script lang="ts">
import { Card, CardContent, CardHeader, CardTitle } from "$lib/components/ui/card/index.js";
import { setTab } from "$lib/stores/navigation.svelte";
import FileText from "@lucide/svelte/icons/file-text";

interface Props {
	html: string | null;
}

const { html }: Props = $props();

const items = $derived.by(() => {
	if (!html) return [];
	const listMatch = html.match(/<li[^>]*>([\s\S]*?)<\/li>/gi);
	if (!listMatch) return [];
	return listMatch.slice(0, 5).map((li) => {
		return li.replace(/<[^>]+>/g, "").trim();
	});
});

const versionLabel = $derived.by(() => {
	if (!html) return null;
	const match = html.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i);
	if (!match) return null;
	return match[1].replace(/<[^>]+>/g, "").trim();
});
</script>

<Card
	class="flex flex-col overflow-hidden rounded-none h-full
		border-[var(--sig-border)] py-0
		shadow-none"
	style="background: var(--sig-surface);"
>
	<CardHeader class="px-3 py-2.5">
		<div class="flex items-center gap-2">
			<FileText class="size-3.5 text-[var(--sig-text-muted)]" />
			<CardTitle
				class="font-display text-[11px] font-bold uppercase tracking-[0.1em]
					text-[var(--sig-text-bright)]"
			>
				Changelog
			</CardTitle>
			{#if versionLabel}
				<span class="sig-micro ml-auto text-[var(--sig-text-muted)]">
					{versionLabel}
				</span>
			{/if}
		</div>
	</CardHeader>

	<CardContent class="flex-1 flex flex-col px-3 pb-3 pt-0">
		{#if items.length === 0}
			<p
				class="font-[family-name:var(--font-mono)] text-[10px]
					leading-4 text-[var(--sig-text-muted)]"
			>
				No changelog available
			</p>
		{:else}
			<ul class="space-y-1">
				{#each items as item}
					<li class="flex gap-1.5">
						<span
							class="mt-[5px] size-1 shrink-0 rounded-full"
							style="background: var(--sig-text-muted)"
						></span>
						<span
							class="min-w-0 font-[family-name:var(--font-mono)] text-[10px]
								leading-[14px] text-[var(--sig-text-muted)]"
						>
							{item}
						</span>
					</li>
				{/each}
			</ul>
		{/if}

		<button
			class="mt-auto pt-2 sig-meta text-[var(--sig-accent)] transition-opacity hover:opacity-80"
			onclick={() => setTab("changelog")}
		>
			View all &rarr;
		</button>
	</CardContent>
</Card>
