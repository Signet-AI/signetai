<script lang="ts">
import type { DaemonStatus } from "$lib/api";
import { setTab } from "$lib/stores/navigation.svelte";

const isDev = import.meta.env.DEV;
const API_BASE = isDev ? "http://localhost:3850" : "";

interface PredictorHealth {
	score: number;
	status: string;
	sidecarAlive: boolean;
	successRate: number;
	alpha: number;
	coldStartExited: boolean;
	modelVersion: number;
	trainingSessions: number;
}

interface DiagnosticsData {
	predictor?: { score: number; status: string };
	index?: { embeddingCoverage: number };
	storage?: { totalMemories: number };
	composite?: { score: number };
}

interface Props {
	daemonStatus: DaemonStatus | null;
}

let { daemonStatus }: Props = $props();

let health = $state<PredictorHealth | null>(null);
let diagnostics = $state<DiagnosticsData | null>(null);
let loaded = $state(false);

const predictorAvailable = $derived(health?.sidecarAlive);

const alpha = $derived(health?.alpha ?? 0.6);
const successRate = $derived(health?.successRate ?? 0);
const healthStatus = $derived.by(() => {
	// Use composite diagnostic score for overall status
	// instead of predictor-specific status (predictor is optional)
	if (diagnostics?.composite) {
		const score = diagnostics.composite.score;
		if (score >= 0.7) return "healthy";
		if (score >= 0.4) return "degraded";
		return "unhealthy";
	}
	// Fall back to predictor status only if diagnostics unavailable
	return health?.status ?? "unknown";
});

const embeddingCoverage = $derived(diagnostics?.index?.embeddingCoverage ?? 0);
const totalMemories = $derived(diagnostics?.storage?.totalMemories ?? 0);
const compositeScore = $derived(diagnostics?.composite?.score ?? 0);

function statusColor(status: string): string {
	if (status === "healthy") return "var(--sig-success)";
	if (status === "degraded" || status === "cold_start") return "var(--sig-warning)";
	if (status === "unhealthy") return "var(--sig-danger)";
	return "var(--sig-text-muted)";
}

async function fetchData(): Promise<void> {
	try {
		const [healthRes, diagRes] = await Promise.allSettled([
			fetch(`${API_BASE}/api/diagnostics/predictor`),
			fetch(`${API_BASE}/api/diagnostics`),
		]);

		if (healthRes.status === "fulfilled" && healthRes.value.ok) {
			health = await healthRes.value.json();
		}
		if (diagRes.status === "fulfilled" && diagRes.value.ok) {
			diagnostics = await diagRes.value.json();
		}
	} catch {
		// fail open
	}
	loaded = true;
}

$effect(() => {
	if (daemonStatus) {
		fetchData();
	} else {
		loaded = true;
	}
});
</script>

<div class="panel sig-panel">
	<div class="panel-header sig-panel-header">
		<span class="panel-title">MEMORY SCORING</span>
		{#if loaded}
			<span
				class="status-indicator"
				style="color: {statusColor(healthStatus)}"
			>{healthStatus.toUpperCase()}</span>
		{/if}
	</div>

	<div class="panel-body">
		{#if !loaded}
			<div class="empty-state">LOADING</div>
		{:else if predictorAvailable}
			<!-- Predictor active: split bar + stats -->
			<div class="scoring-data">
				<div class="split-bar-container">
					<div class="split-bar sig-track">
						<div
							class="split-segment baseline"
							style="width: {alpha * 100}%"
						></div>
						<div
							class="split-segment predictor"
							style="width: {(1 - alpha) * 100}%"
						></div>
					</div>
					<div class="split-labels">
						<span class="split-label">BASELINE {Math.round(alpha * 100)}%</span>
						<span class="split-label accent">PREDICTOR {Math.round((1 - alpha) * 100)}%</span>
					</div>
				</div>

				<div class="stat-rows">
					<div class="stat-row">
						<span class="stat-label">SUCCESS RATE</span>
						<span class="stat-fill"></span>
						<span class="stat-value">{Math.round(successRate * 100)}%</span>
					</div>
					<div class="stat-row">
						<span class="stat-label">MODEL VERSION</span>
						<span class="stat-fill"></span>
						<span class="stat-value">v{health?.modelVersion ?? "--"}</span>
					</div>
					<div class="stat-row">
						<span class="stat-label">TRAINING SESSIONS</span>
						<span class="stat-fill"></span>
						<span class="stat-value">{health?.trainingSessions ?? "--"}</span>
					</div>
				</div>
			</div>
		{:else}
			<!-- Baseline only -->
			<div class="stat-rows">
				<div class="stat-row">
					<span class="stat-label">EMBEDDING COVERAGE</span>
					<span class="stat-fill"></span>
					<span class="stat-value">{Math.round(embeddingCoverage * 100)}%</span>
				</div>
				<div class="stat-row">
					<span class="stat-label">TOTAL MEMORIES</span>
					<span class="stat-fill"></span>
					<span class="stat-value">{totalMemories.toLocaleString()}</span>
				</div>
				<div class="stat-row">
					<span class="stat-label">HEALTH SCORE</span>
					<span class="stat-fill"></span>
					<span class="stat-value">{Math.round(compositeScore * 100)}%</span>
				</div>
			</div>
		{/if}
	</div>

	<div class="panel-footer sig-panel-footer">
		<button class="panel-link" onclick={() => setTab("predictor")}>
			VIEW PREDICTOR
		</button>
	</div>
</div>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--sig-surface);
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-sm) var(--space-md);
		flex-shrink: 0;
	}

	.panel-title {
		font-family: var(--font-display);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-bright);
	}

	.status-indicator {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.1em;
		font-weight: 600;
	}

	.panel-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: var(--space-sm) var(--space-md);
	}

	.panel-footer {
		padding: var(--space-sm) var(--space-md);
		flex-shrink: 0;
	}

	.panel-link {
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.08em;
		color: var(--sig-accent);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		transition: color var(--dur) var(--ease);
	}

	.panel-link:hover {
		color: var(--sig-highlight-text);
	}

	/* Split bar */
	.scoring-data {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	.split-bar-container {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.split-bar {
		display: flex;
		gap: 1px;
		height: 6px;
		width: 100%;
		overflow: hidden;
	}

	.split-segment {
		transition: width 0.3s var(--ease);
	}

	.split-segment.baseline {
		background: var(--sig-text-muted);
	}

	.split-segment.predictor {
		background: var(--sig-highlight);
	}

	.split-labels {
		display: flex;
		justify-content: space-between;
	}

	.split-label {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
	}

	.split-label.accent {
		color: var(--sig-highlight-text);
	}

	/* Stat rows — matching readout language */
	.stat-rows {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.stat-row {
		display: flex;
		align-items: baseline;
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 2;
		letter-spacing: 0.04em;
	}

	.stat-label {
		color: var(--sig-text-muted);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.stat-fill {
		flex: 1;
		min-width: 12px;
		border-bottom: 1px dotted var(--sig-border-strong);
		margin: 0 6px;
		position: relative;
		top: -3px;
	}

	.stat-value {
		color: var(--sig-text-bright);
		font-weight: 600;
		white-space: nowrap;
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
	}

	/* Empty state */
	.empty-state {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}
</style>
