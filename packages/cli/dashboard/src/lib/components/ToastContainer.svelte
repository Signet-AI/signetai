<script lang="ts">
import { toasts, dismiss } from "$lib/stores/toast.svelte";

const levelBorder: Record<string, string> = {
	success: "border-l-[3px] border-l-[var(--sig-success)]",
	error: "border-l-[3px] border-l-[var(--sig-danger)]",
	warning: "border-l-[3px] border-l-[var(--sig-accent)]",
	info: "border-l-[3px] border-l-[var(--sig-border-strong)]",
};
</script>

{#if toasts.length > 0}
	<div
		class="fixed bottom-9 right-4 z-[9000] flex flex-col-reverse
			gap-1.5 pointer-events-none"
	>
		{#each toasts as item (item.id)}
			<div
				class="pointer-events-auto flex items-center gap-[10px]
					px-3.5 py-2 font-[family-name:var(--font-mono)] text-[12px]
					text-[var(--sig-text-bright)]
					bg-[var(--sig-surface-raised)]
					border border-[var(--sig-border-strong)]
					[animation:toast-in_0.2s_var(--ease)]
					{levelBorder[item.level] ?? ''}"
			>
				<span class="flex-1">{item.message}</span>
				<button
					class="bg-transparent border-none text-[var(--sig-text-muted)]
						cursor-pointer text-[16px] leading-none px-0.5 py-0
						hover:text-[var(--sig-text)]"
					onclick={() => dismiss(item.id)}
				>×</button>
			</div>
		{/each}
	</div>
{/if}

<style>
	@keyframes toast-in {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
