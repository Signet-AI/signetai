<script lang="ts">
import type { Snippet } from "svelte";
import ChevronDown from "@lucide/svelte/icons/chevron-down";

interface Props {
	title: string;
	children: Snippet;
	defaultOpen?: boolean;
}

let { title, children, defaultOpen = true }: Props = $props();
let open = $state(defaultOpen);
</script>

<section class="form-section">
	<button
		class="form-section-header"
		onclick={() => (open = !open)}
		aria-expanded={open}
	>
		<span class="form-section-title">{title}</span>
		<ChevronDown
			class="form-section-chevron {open ? 'open' : ''}"
			size={14}
		/>
	</button>
	{#if open}
		<div class="form-section-body">
			{@render children()}
		</div>
	{/if}
</section>

<style>
	.form-section {
		border-bottom: 1px solid var(--sig-border);
	}

	.form-section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 12px var(--space-md);
		background: none;
		border: none;
		cursor: pointer;
		color: var(--sig-text-bright);
		font-family: var(--font-display);
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.1em;
	}

	.form-section-header:hover {
		background: var(--sig-surface-raised);
	}

	:global(.form-section-chevron) {
		color: var(--sig-text-muted);
		transition: transform var(--dur) var(--ease);
	}

	:global(.form-section-chevron.open) {
		transform: rotate(180deg);
	}

	.form-section-body {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 4px var(--space-md) var(--space-md);
	}
</style>
