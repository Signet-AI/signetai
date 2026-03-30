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

// Bar color: success = highlight green, fail = danger red
function barColor(rate: number): string {
	if (rate >= 90) return "var(--sig-highlight)";
	if (rate < 50) return "var(--sig-danger)";
	return "var(--sig-highlight)"; // no orange — keep green for >= 50
}

function barBg(rate: number): string {
	if (rate >= 90) return "var(--sig-highlight-dim, rgba(200, 255, 0, 0.06))";
	if (rate < 50) return "rgba(220, 38, 38, 0.08)";
	return "var(--sig-highlight-dim, rgba(200, 255, 0, 0.06))";
}

// Sorted tools: most used first, tools with 0 calls at the bottom
const sortedTools = $derived.by(() => {
	if (!data) return [];
	return [...data.topTools].sort((a, b) => b.count - a.count).slice(0, 6);
});

// Constellation: sorted by count desc, no-data tools at bottom
const constellationPoints = $derived.by(() => {
	if (sortedTools.length === 0) return [];
	const maxCount = Math.max(...sortedTools.map((t) => t.count), 1);
	return sortedTools.map((tool, i) => {
		const hasActivity = tool.count > 0;
		const angle = (i / sortedTools.length) * Math.PI * 2 - Math.PI / 2;
		const spread = hasActivity ? 0.32 : 0.42;
		const cx = 0.5 + Math.cos(angle) * spread;
		const cy = 0.5 + Math.sin(angle) * spread;
		const size = hasActivity ? 3 + (tool.count / maxCount) * 5 : 2;
		const rate = tool.count > 0 ? (tool.successCount / tool.count) * 100 : 100;
		return { x: cx, y: cy, size, tool, rate, hasActivity };
	});
});

const graphW = 240;
const graphH = 160;
</script>

{#if mcpAnalytics.loading && !data}
	<div class="panel-empty">Loading usage data...</div>
{:else if mcpAnalytics.error || !hasData}
	<div class="panel-empty text-[var(--sig-text-muted)]">Building analytics while you work... check back shortly.</div>
{:else if data}
	<div class="usage-panel">
		<!-- Two panes side by side -->
		<div class="panel-row">
			<!-- Left pane: calls + constellation -->
			<div class="pane constellation-pane">
				<div class="pane-inner">
					<div class="total-readout">
						<div class="total-value">{data.totalCalls.toLocaleString()}</div>
						<div class="total-label">CALLS</div>
					</div>

					<svg class="constellation-svg" viewBox="0 0 {graphW} {graphH}" preserveAspectRatio="xMidYMid meet">
						<!-- Grid -->
						{#each [0.25, 0.5, 0.75] as gy}
							<line x1="0" y1={gy * graphH} x2={graphW} y2={gy * graphH} stroke="var(--sig-grid-line)" stroke-width="0.5" />
						{/each}
						{#each [0.25, 0.5, 0.75] as gx}
							<line x1={gx * graphW} y1="0" x2={gx * graphW} y2={graphH} stroke="var(--sig-grid-line)" stroke-width="0.5" />
						{/each}

						<!-- Connection lines -->
						{#each constellationPoints as point, i}
							{#if i > 0}
								{@const prev = constellationPoints[i - 1]}
								<line
									x1={prev.x * graphW} y1={prev.y * graphH}
									x2={point.x * graphW} y2={point.y * graphH}
									stroke="var(--sig-highlight)" stroke-width="0.5" opacity={point.hasActivity ? 0.12 : 0.04}
								/>
							{/if}
							<line
								x1={0.5 * graphW} y1={0.5 * graphH}
								x2={point.x * graphW} y2={point.y * graphH}
								stroke="var(--sig-electric)" stroke-width="0.3" opacity={point.hasActivity ? 0.08 : 0.03}
							/>
						{/each}

						<!-- Faint crosshair at center (no dot) -->
						<line x1={0.5 * graphW - 8} y1={0.5 * graphH} x2={0.5 * graphW + 8} y2={0.5 * graphH} stroke="var(--sig-grid-line)" stroke-width="0.5" />
						<line x1={0.5 * graphW} y1={0.5 * graphH - 8} x2={0.5 * graphW} y2={0.5 * graphH + 8} stroke="var(--sig-grid-line)" stroke-width="0.5" />

						<!-- Nodes -->
						{#each constellationPoints as point}
							{@const px = point.x * graphW}
							{@const py = point.y * graphH}
							{@const nodeColor = barColor(point.rate)}
							{@const onLeft = point.x < 0.5}
							{@const labelX = onLeft ? px - point.size - 5 : px + point.size + 5}
							{@const anchor = onLeft ? "end" : "start"}
							<!-- Glow -->
							<circle cx={px} cy={py} r={point.size + 4} fill={nodeColor} opacity={point.hasActivity ? 0.06 : 0.02} />
							<!-- Outer -->
							<circle cx={px} cy={py} r={point.size} fill={nodeColor} opacity={point.hasActivity ? 0.55 : 0.15} />
							<!-- Core -->
							<circle cx={px} cy={py} r={Math.max(1.5, point.size * 0.4)} fill={nodeColor} opacity={point.hasActivity ? 0.9 : 0.3} />
							<!-- Label beside node -->
							<text
								x={labelX} y={py + 3}
								text-anchor={anchor}
								fill="var(--sig-text-muted)"
								font-family="var(--font-mono)"
								font-size="7"
								letter-spacing="0.04em"
							>
								{point.tool.toolName.length > 15 ? `${point.tool.toolName.slice(0, 14)}...` : point.tool.toolName}
							</text>
						{/each}
					</svg>
				</div>
			</div>

			<!-- Right pane: stats + tool bars -->
			<div class="pane stats-pane">
				<div class="stats-grid">
					<div class="stat">
						<span class="stat-value sig-highlight-text">{(data.successRate * 100).toFixed(1)}%</span>
						<span class="stat-label">SUCCESS</span>
					</div>
					<div class="stat">
						<span class="stat-value">{data.latency.p50}<span class="stat-unit">ms</span></span>
						<span class="stat-label">P50</span>
					</div>
					<div class="stat">
						<span class="stat-value">{data.latency.p95}<span class="stat-unit">ms</span></span>
						<span class="stat-label">P95</span>
					</div>
				</div>

				{#if sortedTools.length > 0}
					<div class="tool-list">
						{#each sortedTools as tool}
							{@const rate = tool.count > 0 ? (tool.successCount / tool.count) * 100 : 0}
							{@const barWidth = data.totalCalls > 0 ? (tool.count / data.totalCalls) * 100 : 0}
							<div class="tool-row">
								<div class="tool-bar-bg">
									<div class="tool-bar-fill" style="width: {barWidth}%; background: {barBg(rate)};"></div>
								</div>
								<span class="tool-name">{tool.toolName}</span>
								<span class="tool-count">{tool.count}</span>
								<span class="tool-latency">{tool.avgLatencyMs}ms</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.usage-panel {
		border: 1px solid var(--sig-border);
		border-radius: var(--radius);
		background: var(--sig-surface);
		padding: var(--space-md);
		position: relative;
		overflow: hidden;
	}
	.usage-panel::after {
		content: "";
		position: absolute;
		inset: 0;
		pointer-events: none;
		background: repeating-linear-gradient(
			transparent 0px, transparent 2px,
			rgba(255, 255, 255, var(--sig-scanline-opacity, 0.015)) 2px,
			rgba(255, 255, 255, var(--sig-scanline-opacity, 0.015)) 4px
		);
	}

	.panel-row {
		display: flex;
		gap: var(--space-sm);
	}

	.pane {
		border: 1px solid var(--sig-border);
		border-radius: var(--radius);
		background: var(--sig-surface-raised);
		padding: var(--space-sm) var(--space-md);
	}

	.constellation-pane {
		flex: 1;
		min-width: 0;
	}
	.pane-inner {
		display: flex;
		align-items: center;
		gap: var(--space-md);
	}

	.total-readout {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		flex-shrink: 0;
	}
	.total-value {
		font-family: var(--font-mono);
		font-size: 32px;
		font-weight: 700;
		color: var(--sig-highlight-text, var(--sig-text-bright));
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}
	.total-label {
		font-family: var(--font-mono);
		font-size: 8px;
		text-transform: uppercase;
		letter-spacing: 0.15em;
		color: var(--sig-text-muted);
	}

	.constellation-svg {
		flex: 1;
		min-width: 0;
		height: 160px;
	}

	.stats-pane {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	.stats-grid {
		display: flex;
		justify-content: space-around;
		padding-bottom: var(--space-xs);
		border-bottom: 1px solid var(--sig-border);
	}
	.stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1px;
	}
	.stat-value {
		font-family: var(--font-mono);
		font-size: 14px;
		font-weight: 600;
		color: var(--sig-text-bright);
		font-variant-numeric: tabular-nums;
	}
	.stat-unit {
		font-size: 9px;
		color: var(--sig-text-muted);
		font-weight: 400;
	}
	.stat-label {
		font-family: var(--font-mono);
		font-size: 8px;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--sig-text-muted);
	}

	.tool-list {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.tool-row {
		display: grid;
		grid-template-columns: 1fr auto auto;
		gap: var(--space-sm);
		align-items: center;
		font-family: var(--font-mono);
		font-size: 10px;
		position: relative;
		padding: 3px 4px;
	}
	.tool-bar-bg {
		position: absolute;
		inset: 0;
		border-radius: 2px;
		overflow: hidden;
		pointer-events: none;
	}
	.tool-bar-fill {
		height: 100%;
		border-radius: 2px;
		transition: width 0.3s ease;
	}
	.tool-name {
		color: var(--sig-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		position: relative;
		z-index: 1;
	}
	.tool-count {
		color: var(--sig-highlight-text, var(--sig-text-bright));
		text-align: right;
		min-width: 30px;
		position: relative;
		z-index: 1;
	}
	.tool-latency {
		color: var(--sig-text-muted);
		text-align: right;
		min-width: 45px;
		position: relative;
		z-index: 1;
	}

	.panel-empty {
		padding: var(--space-md);
		text-align: center;
		font-family: var(--font-mono);
		font-size: 11px;
	}
</style>
