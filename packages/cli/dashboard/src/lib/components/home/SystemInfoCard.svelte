<script lang="ts">
import type { DiagnosticsReport, MemoryStats, PipelineStatus } from "$lib/api";
import * as Card from "$lib/components/ui/card/index.js";
import Activity from "@lucide/svelte/icons/activity";

interface Props {
	diagnostics: DiagnosticsReport | null;
	pipelineStatus: PipelineStatus | null;
	memoryStats: MemoryStats | null;
}

let { diagnostics, pipelineStatus, memoryStats }: Props = $props();

const healthScore = $derived(diagnostics?.composite?.score ?? null);
const healthStatus = $derived(diagnostics?.composite?.status ?? "unknown");

function scoreColor(score: number): string {
	if (score >= 0.8) return "var(--sig-success)";
	if (score >= 0.5) return "var(--sig-warning, #d4a017)";
	return "var(--sig-danger)";
}

function healthHue(score: number | null): string {
	if (score === null) return "color-mix(in srgb, var(--sig-surface) 2%, transparent)";
	if (score >= 0.8) return "color-mix(in srgb, var(--sig-success) 8%, transparent)";
	if (score >= 0.6) return "color-mix(in srgb, var(--sig-warning, #d4a017) 8%, transparent)";
	if (score >= 0.4) return "color-mix(in srgb, var(--sig-warning, #d4a017) 10%, transparent)";
	return "color-mix(in srgb, var(--sig-danger) 10%, transparent)";
}

function healthBorder(score: number | null): string {
	if (score === null) return "var(--sig-border)";
	if (score >= 0.8) return "color-mix(in srgb, var(--sig-success) 25%, var(--sig-border))";
	if (score >= 0.6) return "color-mix(in srgb, var(--sig-warning, #d4a017) 25%, var(--sig-border))";
	if (score >= 0.4) return "color-mix(in srgb, var(--sig-warning, #d4a017) 25%, var(--sig-border))";
	return "color-mix(in srgb, var(--sig-danger) 25%, var(--sig-border))";
}

const pipelineMode = $derived.by(() => {
	if (!pipelineStatus) return "unknown";
	if (typeof pipelineStatus.mode === "string") return pipelineStatus.mode;
	return "active";
});

const embeddingCoverage = $derived.by(() => {
	if (diagnostics?.index?.embeddingCoverage !== undefined) {
		return Math.round(diagnostics.index.embeddingCoverage * 100);
	}
	if (!memoryStats || memoryStats.total === 0) return null;
	return Math.round((memoryStats.withEmbeddings / memoryStats.total) * 100);
});

const warningCount = $derived.by(() => {
	if (!diagnostics) return 0;
	let count = 0;
	const domains = ["queue", "storage", "index", "provider", "connector", "predictor"] as const;
	for (const d of domains) {
		const domain = diagnostics[d];
		if (domain && typeof domain === "object" && "status" in domain) {
			const status = (domain as { status: string }).status;
			if (status === "degraded" || status === "unhealthy") count++;
		}
	}
	return count;
});
</script>

<Card.Root class="h-full transition-colors duration-500" style="background: {healthHue(healthScore)}; border-color: {healthBorder(healthScore)};">
	<Card.Header class="py-2 px-3">
		<Card.Title>
			<span class="sig-heading">System Health</span>
		</Card.Title>
	</Card.Header>
	<Card.Content class="px-3 pb-3">
		<div class="health-row">
			{#if healthScore !== null}
				<div class="score-block">
					<span
						class="score-value"
						style="color: {scoreColor(healthScore)}"
					>
						{healthScore.toFixed(2)}
					</span>
					<div
						class="score-bar"
						style="--fill: {healthScore * 100}%; --bar-color: {scoreColor(healthScore)}"
					>
						<div class="score-bar-fill"></div>
					</div>
					<span class="sig-micro" style="color: {scoreColor(healthScore)}">
						{healthStatus}
					</span>
				</div>
			{:else}
				<div class="score-block">
					<span class="score-value muted">--</span>
				</div>
			{/if}

			<div class="mode-badge">
				<Activity class="mode-icon" />
				<span class="sig-micro">{pipelineMode}</span>
			</div>
		</div>

		<div class="metric-grid">
			<div class="metric">
				<span class="sig-label">{memoryStats?.total?.toLocaleString() ?? "--"}</span>
				<span class="sig-meta">memories</span>
			</div>
			<div class="metric">
				<span class="sig-label">
					{embeddingCoverage !== null ? `${embeddingCoverage}%` : "--"}
				</span>
				<span class="sig-meta">embedded</span>
			</div>
			<div class="metric">
				<span class="sig-label">
					{diagnostics?.storage?.totalMemories?.toLocaleString() ?? "--"}
				</span>
				<span class="sig-meta">stored</span>
			</div>
			<div class="metric">
				<span
					class="sig-label"
					style={warningCount > 0 ? "color: var(--sig-warning, #d4a017)" : ""}
				>
					{warningCount}
				</span>
				<span class="sig-meta">warnings</span>
			</div>
		</div>
	</Card.Content>
</Card.Root>

<style>
	.health-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: var(--space-sm);
	}

	.score-block {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.score-value {
		font-family: var(--font-display);
		font-size: 20px;
		font-weight: 700;
		letter-spacing: 0.02em;
		line-height: 1;
	}

	.score-value.muted {
		color: var(--sig-text-muted);
	}

	.score-bar {
		width: 48px;
		height: 4px;
		background: var(--sig-border);
		border-radius: 2px;
		overflow: hidden;
	}

	.score-bar-fill {
		height: 100%;
		width: var(--fill);
		background: var(--bar-color);
		border-radius: 2px;
		transition: width var(--dur) var(--ease);
	}

	.mode-badge {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border);
		border-radius: 1rem;
	}

	:global(.mode-icon) {
		width: 10px;
		height: 10px;
		color: var(--sig-text-muted);
	}

	.metric-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-xs) var(--space-md);
	}

	.metric {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
</style>
