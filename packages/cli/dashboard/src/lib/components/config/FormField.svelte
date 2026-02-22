<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
	label: string;
	description?: string;
	children: Snippet;
}

let { label, description, children }: Props = $props();
</script>

<div class="form-field">
	<label class="form-field-label">
		{label}
		{#if description}
			<span class="form-field-help">{description}</span>
		{/if}
	</label>
	<div class="form-field-control">
		{@render children()}
	</div>
</div>

<style>
	.form-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.form-field-label {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		color: var(--sig-text-bright);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.form-field-help {
		display: block;
		font-size: 10px;
		font-weight: 400;
		color: var(--sig-text-muted);
		text-transform: none;
		letter-spacing: 0.02em;
		margin-top: 1px;
	}

	.form-field-control {
		display: flex;
		flex-direction: column;
	}
</style>
