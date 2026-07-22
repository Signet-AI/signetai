<script lang="ts">
import type { Snippet } from "svelte";

// Shared settings row, matching the OpenCode settings-v2 rhythm:
// title + description on the left, control on the right. Used inside a
// SettingList for the bordered "list with divider rows" look. See
// docs/research/2026-07-22-dashboard-inference-settings-design.md.

interface Props {
	title: string;
	description?: string;
	children: Snippet;
}

let { title, description, children }: Props = $props();
</script>

<div class="setting-row" data-component="settings-row">
	<div class="row-copy">
		<div class="row-title">{title}</div>
		{#if description}
			<div class="row-description">{description}</div>
		{/if}
	</div>
	<div class="row-control">
		{@render children()}
	</div>
</div>

<style>
	.setting-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 16px;
		padding-block: 20px;
		border-bottom: 0.5px solid var(--sig-border);
	}
	.setting-row:last-child {
		border-bottom: none;
	}
	@media (min-width: 640px) {
		.setting-row {
			flex-wrap: nowrap;
		}
	}
	.row-copy {
		display: flex;
		min-width: 0;
		flex: 1;
		flex-direction: column;
		gap: 6px;
	}
	.row-title {
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 500;
		color: var(--sig-text-bright);
		line-height: 1.3;
	}
	.row-description {
		font-family: var(--font-body);
		font-size: 11px;
		line-height: 1.5;
		color: var(--sig-text-muted);
	}
	.row-control {
		display: flex;
		width: 100%;
		justify-content: flex-end;
	}
	@media (min-width: 640px) {
		.row-control {
			width: auto;
			flex-shrink: 0;
		}
	}
</style>
