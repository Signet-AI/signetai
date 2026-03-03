<script lang="ts">
	import type { Snippet } from "svelte";

	interface Props {
		description?: string;
		children: Snippet;
	}

	const { description, children }: Props = $props();
</script>

<div class="form-section">
	{#if description}
		<p class="section-description">{description}</p>
	{/if}
	<div class="fields-container">
		{@render children()}
	</div>
</div>

<style>
	.form-section {
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
		padding: var(--space-lg);
		min-height: 100%;
	}

	.section-description {
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.6;
		color: var(--sig-text-muted);
		margin: 0;
		padding-bottom: var(--space-md);
		border-bottom: 1px solid var(--sig-border);
	}

	.fields-container {
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
	}
</style>
