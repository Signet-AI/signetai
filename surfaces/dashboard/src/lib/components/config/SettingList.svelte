<script lang="ts">
import type { Snippet } from "svelte";

// Bordered container holding SettingRows. Matches OpenCode's settings-v2-list:
// rounded, subtle inset border, 20px horizontal padding. The rows inside
// provide the divider separators.

interface Props {
	title?: string;
	children: Snippet;
}

let { title, children }: Props = $props();
</script>

<div class="setting-list-wrap">
	{#if title}
		<h3 class="setting-list-title">{title}</h3>
	{/if}
	<div class="setting-list" data-component="settings-list">
		{@render children()}
	</div>
</div>

<style>
	.setting-list-wrap {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.setting-list-title {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
		margin: 0;
	}
	.setting-list {
		border-radius: 8px;
		background: color-mix(in srgb, var(--sig-bg) 60%, var(--sig-surface));
		padding-inline: 20px;
		box-shadow: inset 0 0 0 0.5px var(--sig-border);
	}
</style>
