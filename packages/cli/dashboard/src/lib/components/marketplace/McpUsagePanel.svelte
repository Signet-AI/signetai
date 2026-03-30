<script lang="ts">
import { fetchMcpAnalytics, mcpAnalytics } from "$lib/stores/mcp-analytics.svelte";
import { onMount } from "svelte";

onMount(() => {
	void fetchMcpAnalytics();
	const interval = setInterval(() => void fetchMcpAnalytics(), 30_000);
	return () => clearInterval(interval);
});

const data = $derived(mcpAnalytics.data);
const hasData = $derived(data !== null && data.totalCalls > 0);
</script>

{#if mcpAnalytics.loading && !data}
	<div class="panel-empty">Loading usage data...</div>
{:else if mcpAnalytics.error || !hasData}
	<div class="panel-empty text-[var(--sig-text-muted)]">Building analytics while you work... check back shortly.</div>
{:else if data}
	<div class="usage-panel">
		<div class="usage-header">
			<span class="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] text-[var(--sig-text-muted)]">
				Usage Analytics
			</span>
		</div>

		<!-- Summary cards -->
		<div class="usage-cards">
			<div class="usage-card">
				<div class="usage-card-value">{data.totalCalls.toLocaleString()}</div>
				<div class="usage-card-label">Total Calls</div>
			</div>
			<div class="usage-card">
				<div class="usage-card-value">{(data.successRate * 100).toFixed(1)}%</div>
				<div class="usage-card-label">Success Rate</div>
			</div>
			<div class="usage-card">
				<div class="usage-card-value">{data.latency.p50}ms</div>
				<div class="usage-card-label">p50 Latency</div>
			</div>
			<div class="usage-card">
				<div class="usage-card-value">{data.latency.p95}ms</div>
				<div class="usage-card-label">p95 Latency</div>
			</div>
		</div>

		<!-- Top tools table -->
		{#if data.topTools.length > 0}
			<div class="usage-section">
				<div class="usage-section-title">Top Tools</div>
				<div class="usage-table">
					{#each data.topTools.slice(0, 8) as tool}
						{@const rate = tool.count > 0 ? (tool.successCount / tool.count) * 100 : 0}
						<div class="usage-row">
							<span class="usage-tool-name">{tool.toolName}</span>
							<span class="usage-count">{tool.count}</span>
							<span class="usage-rate" class:text-[var(--sig-success)]={rate >= 90} class:text-[var(--sig-danger)]={rate < 50}>
								{rate.toFixed(0)}%
							</span>
							<span class="usage-latency">{tool.avgLatencyMs}ms</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Top servers -->
		{#if data.topServers.length > 1}
			<div class="usage-section">
				<div class="usage-section-title">By Server</div>
				<div class="usage-table">
					{#each data.topServers.slice(0, 5) as server}
						<div class="usage-row">
							<span class="usage-tool-name">{server.serverId.slice(0, 20)}</span>
							<span class="usage-count">{server.count}</span>
							<span class="usage-latency">{server.avgLatencyMs}ms</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	.usage-panel {
		border: 1px solid var(--sig-border);
		border-radius: var(--radius);
		background: var(--sig-surface);
		padding: var(--space-sm);
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}
	.usage-header {
		padding-bottom: var(--space-xs);
		border-bottom: 1px solid var(--sig-border);
	}
	.usage-cards {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: var(--space-xs);
	}
	.usage-card {
		text-align: center;
		padding: var(--space-xs);
	}
	.usage-card-value {
		font-family: var(--font-mono);
		font-size: 16px;
		font-weight: 600;
		color: var(--sig-text-bright);
	}
	.usage-card-label {
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
	}
	.usage-section {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.usage-section-title {
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
		padding-top: var(--space-xs);
	}
	.usage-table {
		display: flex;
		flex-direction: column;
	}
	.usage-row {
		display: grid;
		grid-template-columns: 1fr auto auto auto;
		gap: var(--space-sm);
		align-items: center;
		padding: 2px 0;
		font-family: var(--font-mono);
		font-size: 11px;
	}
	.usage-tool-name {
		color: var(--sig-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.usage-count {
		color: var(--sig-text-bright);
		text-align: right;
		min-width: 40px;
	}
	.usage-rate {
		text-align: right;
		min-width: 35px;
	}
	.usage-latency {
		color: var(--sig-text-muted);
		text-align: right;
		min-width: 50px;
	}
	.panel-empty {
		padding: var(--space-md);
		text-align: center;
		font-family: var(--font-mono);
		font-size: 11px;
	}
</style>
