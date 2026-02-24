<script lang="ts">
import * as Collapsible from "$lib/components/ui/collapsible/index.js";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import type { Snippet } from "svelte";

interface Props {
	title: string;
	description?: string;
	children: Snippet;
	defaultOpen?: boolean;
}

const { title, description, children, defaultOpen = true }: Props = $props();
let open = $state(defaultOpen);
</script>

<Collapsible.Root bind:open class="border-b border-[var(--sig-border)]">
	<Collapsible.Trigger
		class="flex w-full items-center justify-between px-[var(--space-md)] py-3
			bg-transparent border-none cursor-pointer
			text-[var(--sig-text-bright)] font-[family-name:var(--font-display)]
			text-[11px] font-semibold uppercase tracking-[0.1em]
			hover:bg-[var(--sig-surface-raised)]"
	>
		<span>{title}</span>
		<ChevronDown
			class="text-[var(--sig-text-muted)] transition-transform duration-200
				{open ? 'rotate-180' : ''}"
			size={14}
		/>
	</Collapsible.Trigger>
	<Collapsible.Content>
		<div class="flex flex-col gap-3.5 px-[var(--space-md)] pt-1 pb-[var(--space-md)]">
			{#if description}
				<p class="font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--sig-text-muted)] m-0">{description}</p>
			{/if}
			{@render children()}
		</div>
	</Collapsible.Content>
</Collapsible.Root>
