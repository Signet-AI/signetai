<script lang="ts">
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import type { Snippet } from "svelte";

interface Props {
	title?: string;
	children: Snippet;
}

// biome-ignore lint/style/useConst: Svelte keeps prop bindings reactive.
let { title = "Advanced", children }: Props = $props();
// biome-ignore lint/style/useConst: Mutated from template callback.
let open = $state(false);
</script>

<div class="advanced-section">
	<button type="button" class="advanced-toggle" onclick={() => open = !open}>
		<ChevronRight class="toggle-icon {open ? 'rotated' : ''}" size={12} />
		<span>{title}</span>
	</button>
	{#if open}
		<div class="advanced-content">
			{@render children()}
		</div>
	{/if}
</div>

<style>
	.advanced-section {
		border-top: 1px solid var(--sig-border);
		margin-top: var(--space-sm);
		padding-top: var(--space-sm);
	}

	.advanced-toggle {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 0;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
		background: none;
		border: none;
		cursor: pointer;
		transition: color 0.15s ease;
	}

	.advanced-toggle:hover {
		color: var(--sig-text-bright);
	}

	:global(.toggle-icon) {
		transition: transform 0.15s ease;
		flex-shrink: 0;
	}

	:global(.toggle-icon.rotated) {
		transform: rotate(90deg);
	}

	.advanced-content {
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
		padding-top: var(--space-md);
	}
</style>
