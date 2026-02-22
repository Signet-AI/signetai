<script lang="ts">
import type { Snippet } from "svelte";
import { Label } from "$lib/components/ui/label/index.js";

interface Props {
	label: string;
	description?: string;
	children: Snippet;
}

let { label, description, children }: Props = $props();
</script>

<div class="flex flex-col gap-1">
	<Label class="font-[family-name:var(--font-mono)] text-[11px] font-medium
		text-[var(--sig-text-bright)] uppercase tracking-[0.06em]">
		{label}
		{#if description}
			<span class="block text-[10px] font-normal text-[var(--sig-text-muted)]
				normal-case tracking-[0.02em] mt-px">
				{description}
			</span>
		{/if}
	</Label>
	<div class="flex flex-col">
		{@render children()}
	</div>
</div>
