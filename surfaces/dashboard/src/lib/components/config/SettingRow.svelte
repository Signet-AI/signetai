<script lang="ts">
import type { Snippet } from "svelte";
import { InfoIcon } from "$lib/icons";
import * as Tooltip from "$lib/components/ui/tooltip/index.js";

// Shared settings row. Default = OpenCode settings-v2 rhythm (title+desc left,
// control right). Pass `compact` for a dense vertical stack: label on top (with
// the description moved into an info-icon tooltip so it no longer eats a
// column), control directly below. Compact is opt-in so existing tabs are
// unaffected; the Inference section uses it to raise density and kill the
// far-left-label / far-right-control jump.

interface Props {
	title: string;
	description?: string;
	/** Dense vertical stack: label on top, control below; description → tooltip. */
	compact?: boolean;
	children: Snippet;
}

let { title, description, compact = false, children }: Props = $props();
</script>

{#if compact}
	<div class="setting-row compact" data-component="settings-row">
		<div class="row-head">
			<span class="row-title">{title}</span>
			{#if description}
				<Tooltip.Provider>
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<span {...props} class="info-icon" role="button" tabindex="0" aria-label={title}>
									<InfoIcon class="size-3" />
								</span>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content class="tooltip-content">
							<div class="tip-title">{title}</div>
							<div class="tip-body">{description}</div>
						</Tooltip.Content>
					</Tooltip.Root>
				</Tooltip.Provider>
			{/if}
		</div>
		<div class="row-control">
			{@render children()}
		</div>
	</div>
{:else}
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
{/if}

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
	/* Compact: vertical stack, tight padding, label above control. */
	.setting-row.compact {
		flex-direction: column;
		align-items: stretch;
		gap: 5px;
		padding-block: 8px;
	}
	.row-copy {
		display: flex;
		min-width: 0;
		flex: 1;
		flex-direction: column;
		gap: 6px;
	}
	.row-head {
		display: flex;
		align-items: center;
		gap: 4px;
		min-height: 16px;
	}
	.row-title {
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 500;
		color: var(--sig-text-bright);
		line-height: 1.3;
	}
	.setting-row.compact .row-title {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--sig-text-muted);
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
	.setting-row.compact .row-control {
		width: 100%;
		justify-content: flex-start;
	}
	.info-icon {
		display: inline-flex;
		align-items: center;
		color: var(--sig-text-muted);
		opacity: 0.6;
		cursor: help;
	}
	.info-icon:hover {
		opacity: 1;
		color: var(--sig-text);
	}
	:global(.tooltip-content) {
		max-width: 280px;
		padding: 8px 10px;
		font-family: var(--font-body);
		font-size: 11px;
		line-height: 1.5;
		color: var(--sig-text);
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		border-radius: 6px;
	}
	:global(.tooltip-content .tip-title) {
		font-weight: 600;
		margin-bottom: 2px;
	}
	:global(.tooltip-content .tip-body) {
		color: var(--sig-text-muted);
	}
</style>
