<script lang="ts">
	import type { Snippet } from "svelte";
	import { Label } from "$lib/components/ui/label/index.js";

	interface Props {
		label: string;
		description?: string;
		children: Snippet;
		layout?: "vertical" | "horizontal";
	}

	let { label, description, children, layout = "horizontal" }: Props = $props();
</script>

{#if layout === "vertical"}
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
{:else}
	<div class="form-field-horizontal">
		<div class="field-label">
			<span class="font-[family-name:var(--font-mono)] text-[11px] font-medium
				text-[var(--sig-text-bright)] uppercase tracking-[0.06em]">
				{label}
			</span>
			{#if description}
				<span class="field-desc">
					{description}
				</span>
			{/if}
		</div>
		<div class="field-input">
			{@render children()}
		</div>
	</div>
{/if}

<style>
	.form-field-horizontal {
		display: grid;
		grid-template-columns: minmax(140px, 1fr) minmax(0, 2fr);
		gap: var(--space-sm) var(--space-md);
		align-items: start;
	}

	.field-label {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding-top: 6px;
	}

	.field-desc {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: normal;
		color: var(--sig-text-muted);
		text-transform: none;
		letter-spacing: 0.02em;
		line-height: 1.4;
	}

	.field-input {
		min-width: 0;
	}

	@media (max-width: 640px) {
		.form-field-horizontal {
			grid-template-columns: 1fr;
		}

		.field-label {
			padding-top: 0;
		}
	}
</style>
