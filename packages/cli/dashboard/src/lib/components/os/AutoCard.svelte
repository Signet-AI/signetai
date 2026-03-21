<script lang="ts">
	import type { AutoCardManifest } from "$lib/stores/os.svelte";
	import Wrench from "@lucide/svelte/icons/wrench";
	import Box from "@lucide/svelte/icons/box";

	interface Props {
		autoCard: AutoCardManifest;
		name: string;
		icon?: string;
	}

	const { autoCard, name, icon }: Props = $props();
</script>

<div class="auto-card">
	<div class="auto-card-header">
		{#if icon}
			<img src={icon} alt={name} class="auto-card-icon" referrerpolicy="no-referrer" />
		{:else}
			<div class="auto-card-icon-placeholder">
				<Box class="size-4" />
			</div>
		{/if}
		<span class="auto-card-name">{name}</span>
		<span class="sig-meta ml-auto">{autoCard.tools.length} tools</span>
	</div>

	{#if autoCard.tools.length > 0}
		<div class="auto-card-tools">
			{#each autoCard.tools as tool (tool.name)}
				<button
					class="auto-card-tool-btn sig-switch"
					title={tool.description || tool.name}
					disabled
				>
					<Wrench class="size-3 shrink-0 opacity-50" />
					<span class="truncate">{tool.name}</span>
				</button>
			{/each}
		</div>
	{:else}
		<div class="auto-card-empty">
			<span class="sig-label">No tools exposed</span>
		</div>
	{/if}
</div>

<style>
	.auto-card {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}

	.auto-card-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
	}

	.auto-card-icon {
		width: 20px;
		height: 20px;
		border-radius: 4px;
		object-fit: cover;
	}

	.auto-card-icon-placeholder {
		width: 20px;
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		background: var(--sig-surface-raised);
		color: var(--sig-text-muted);
	}

	.auto-card-name {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		color: var(--sig-text-bright);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.auto-card-tools {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 8px 12px;
		overflow-y: auto;
		flex: 1;
	}

	.auto-card-tool-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 3px 8px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text);
		cursor: pointer;
		max-width: 100%;
	}

	.auto-card-tool-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
		pointer-events: none;
	}

	.auto-card-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		flex: 1;
		padding: 24px 16px;
		gap: 6px;
		background: var(--sig-bg);
		color: var(--sig-text-muted);
	}
</style>
