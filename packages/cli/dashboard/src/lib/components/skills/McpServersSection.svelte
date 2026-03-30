<script lang="ts">
import { onMount } from "svelte";
import { mcp, fetchInstalled, type McpView } from "$lib/stores/mcp-servers.svelte";
import McpServerCard from "./McpServerCard.svelte";
import McpDiscoverSection from "./McpDiscoverSection.svelte";

onMount(() => {
	void fetchInstalled();
});
</script>

<div class="mcp-section h-full flex flex-col overflow-hidden">
	<!-- Sub-tab bar -->
	<div class="sub-tabs shrink-0 border-b border-[var(--sig-border)] flex items-center">
		<button
			type="button"
			class="filter-chip"
			class:active={mcp.view === "installed"}
			onclick={() => { mcp.view = "installed"; }}
		>
			Installed ({mcp.installed.length})
		</button>
		<button
			type="button"
			class="filter-chip"
			class:active={mcp.view === "discover"}
			onclick={() => { mcp.view = "discover"; }}
		>
			Discover
		</button>
	</div>

	<!-- Content -->
	<div class="flex-1 overflow-y-auto">
		{#if mcp.view === "installed"}
			{#if mcp.loading}
				<div class="state-msg">Loading…</div>
			{:else if mcp.installed.length === 0}
				<div class="state-msg empty">
					No MCP servers installed yet.
					<br />
					<span class="hint">
						Use the Discover tab to find servers from your existing harness
						configurations, or add one manually via the API.
					</span>
				</div>
			{:else}
				<div class="server-list">
					{#each mcp.installed as server (server.id)}
						<McpServerCard {server} />
					{/each}
				</div>
			{/if}
		{:else}
			<McpDiscoverSection />
		{/if}
	</div>
</div>

<style>
	.state-msg {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-muted);
		padding: var(--space-md);
		text-align: center;
		line-height: 1.7;
	}
	.state-msg.empty {
		padding-top: calc(var(--space-md) * 2);
	}
	.hint {
		font-size: 10px;
		opacity: 0.7;
	}

	.server-list {
		display: flex;
		flex-direction: column;
		gap: 0;
		padding: var(--space-md);
		gap: 6px;
	}

	.sub-tabs {
		padding: 0 var(--space-md);
	}

	.filter-chip {
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
		background: transparent;
		border: 1px solid var(--sig-border);
		padding: 4px 12px;
		cursor: pointer;
		transition: all 0.1s;
	}
	.filter-chip:not(:first-child) {
		border-left: none;
	}
	.filter-chip:hover {
		color: var(--sig-text);
		background: var(--sig-surface-raised);
	}
	.filter-chip.active {
		color: var(--sig-text-bright);
		background: var(--sig-surface-raised);
		border-color: var(--sig-accent);
	}
	.filter-chip.active + .filter-chip {
		border-left-color: var(--sig-accent);
	}
</style>
