<script lang="ts">
import type { ContinuityEntry, DaemonStatus, DiagnosticsReport, Identity, MemoryStats, PipelineStatus } from "$lib/api";

interface Props {
	identity: Identity;
	daemonStatus: DaemonStatus | null;
	connectorCount: number;
	continuity: ContinuityEntry[];
	memoryCount: number;
	diagnostics?: DiagnosticsReport | null;
	pipelineStatus?: PipelineStatus | null;
	memoryStats?: MemoryStats | null;
}

let {
	identity,
	daemonStatus,
	connectorCount,
	continuity,
	memoryCount,
	diagnostics = null,
	pipelineStatus = null,
	memoryStats = null,
}: Props = $props();

const ageDays = $derived.by(() => {
	const created = daemonStatus?.agentCreatedAt;
	if (!created) return null;
	const ts = new Date(created).getTime();
	if (Number.isNaN(ts)) return null;
	return Math.max(0, Math.floor((Date.now() - ts) / 86_400_000));
});

const ageLabel = $derived.by(() => {
	if (ageDays === null) return "--";
	if (ageDays === 0) return "TODAY";
	if (ageDays === 1) return "1 DAY";
	return `${ageDays} DAYS`;
});

const activeSessions = $derived(daemonStatus?.activeSessions ?? 0);
const version = $derived(daemonStatus?.version ?? "--");

const latestProject = $derived.by(() => {
	if (continuity.length === 0) return null;
	const sorted = [...continuity].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
	return sorted[0];
});

function formatRecency(dateStr: string): string {
	const diff = Date.now() - new Date(dateStr).getTime();
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return "JUST NOW";
	if (mins < 60) return `${mins}M AGO`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}H AGO`;
	const days = Math.floor(hours / 24);
	return `${days}D AGO`;
}

const projectName = $derived(latestProject?.project?.replace(/\/$/, "").split("/").pop() ?? "--");

const recency = $derived(latestProject ? formatRecency(latestProject.created_at) : "--");

/* use name from identity; daemon /api/identity sometimes returns empty
	   strings even when agent.yaml has a name configured — fall back gracefully */
const agentName = $derived(identity.name?.trim() || "SIGNET AGENT");

/* health metrics from diagnostics */
const healthScore = $derived(diagnostics?.composite?.score ?? null);
const healthStatus = $derived(diagnostics?.composite?.status ?? "UNKNOWN");

const embeddingPct = $derived.by(() => {
	if (diagnostics?.index?.embeddingCoverage !== undefined) {
		return Math.round(diagnostics.index.embeddingCoverage * 100);
	}
	if (!memoryStats || memoryStats.total === 0) return null;
	return Math.round((memoryStats.withEmbeddings / memoryStats.total) * 100);
});

const pipelineMode = $derived.by(() => {
	if (!pipelineStatus) return "UNKNOWN";
	if (typeof pipelineStatus.mode === "string") {
		return pipelineStatus.mode.toUpperCase();
	}
	return "ACTIVE";
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

function scoreColor(score: number | null): string {
	if (score === null) return "var(--sig-text-muted)";
	if (score >= 0.8) return "var(--sig-success)";
	if (score >= 0.5) return "var(--sig-warning)";
	return "var(--sig-danger)";
}

type Row = { idx: string; label: string; value: string; color?: string };

const leftRows: Row[] = $derived([
	{ idx: "01", label: "UPTIME", value: ageLabel },
	{ idx: "02", label: "PROJECT", value: projectName },
	{ idx: "03", label: "LAST SEEN", value: recency },
	{ idx: "04", label: "CONNECTORS", value: String(connectorCount) },
	{ idx: "05", label: "SESSIONS", value: String(activeSessions) },
]);

const rightRows: Row[] = $derived([
	{
		idx: "06",
		label: "HEALTH",
		value: healthScore !== null ? `${healthScore.toFixed(2)} ${healthStatus.toUpperCase()}` : "--",
		color: scoreColor(healthScore),
	},
	{
		idx: "07",
		label: "EMBEDDED",
		value: embeddingPct !== null ? `${embeddingPct}%` : "--",
	},
	{
		idx: "08",
		label: "PIPELINE",
		value: pipelineMode,
	},
	{
		idx: "09",
		label: "WARNINGS",
		value: String(warningCount),
		color: warningCount > 0 ? "var(--sig-danger)" : undefined,
	},
]);
</script>

<div class="readout sig-panel">
	<!-- Scanline texture layer -->
	<div class="readout-texture" aria-hidden="true"></div>

	<div class="readout-content">
		<!-- Eyebrow -->
		<div class="readout-eyebrow">
			<span class="eyebrow-left">SIGNET AGENT READOUT</span>
			<span class="eyebrow-right">v{version}</span>
		</div>

		<!-- Hero: agent name + memory count -->
		<div class="readout-hero">
			<h1 class="agent-name">{agentName}</h1>
			<div class="hero-stat">
				<span class="hero-number">{memoryCount.toLocaleString()}</span>
				<span class="hero-unit">MEMORIES<br/>STORED</span>
			</div>
		</div>

		<!-- Divider -->
		<div class="readout-divider sig-groove" aria-hidden="true"></div>

		<!-- Two-column data grid -->
		<div class="readout-grid">
			<div class="readout-col">
				{#each leftRows as row}
					<div class="data-row">
						<span class="data-idx">{row.idx}</span>
						<span class="data-label">{row.label}</span>
						<span class="data-fill"></span>
						<span
							class="data-value"
							style={row.color ? `color: ${row.color}` : ""}
						>{row.value}</span>
					</div>
				{/each}
			</div>
			<div class="readout-col">
				{#each rightRows as row}
					<div class="data-row">
						<span class="data-idx">{row.idx}</span>
						<span class="data-label">{row.label}</span>
						<span class="data-fill"></span>
						<span
							class="data-value"
							style={row.color ? `color: ${row.color}` : ""}
						>{row.value}</span>
					</div>
				{/each}
			</div>
		</div>
	</div>
</div>

<style>
	.readout {
		position: relative;
		overflow: hidden;
		background: var(--sig-bg);
	}

	.readout-texture {
		position: absolute;
		inset: 0;
		pointer-events: none;
		background:
			repeating-linear-gradient(
				0deg,
				transparent 0px,
				transparent 3px,
				var(--sig-grid-line) 3px,
				var(--sig-grid-line) 4px
			);
		z-index: 1;
	}

	.readout-content {
		position: relative;
		z-index: 2;
		padding: var(--space-md) var(--space-lg);
	}

	/* --- Eyebrow --- */
	.readout-eyebrow {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: var(--space-md);
	}

	.eyebrow-left {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.14em;
		color: var(--sig-text-muted);
	}

	.eyebrow-right {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.1em;
		color: var(--sig-accent);
	}

	/* --- Hero --- */
	.readout-hero {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--space-lg);
		margin-bottom: var(--space-md);
	}

	.agent-name {
		font-family: var(--font-display);
		font-size: 42px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sig-highlight);
		margin: 0;
		line-height: 0.9;
	}

	/* Neon glow only in dark mode */
	:global(:root:not([data-theme="light"])) .agent-name {
		text-shadow:
			0 0 30px var(--sig-highlight-dim),
			0 0 60px var(--sig-highlight-dim);
	}

	.hero-stat {
		display: flex;
		align-items: flex-end;
		gap: var(--space-sm);
		flex-shrink: 0;
	}

	.hero-number {
		font-family: var(--font-mono);
		font-size: 36px;
		font-weight: 700;
		line-height: 0.9;
		color: var(--sig-text-bright);
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.02em;
	}

	.hero-unit {
		font-family: var(--font-mono);
		font-size: 8px;
		line-height: 1.4;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
		padding-bottom: 4px;
	}

	/* --- Divider — etched groove --- */
	.readout-divider {
		margin-bottom: var(--space-sm);
	}

	/* --- Data grid --- */
	.readout-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0 var(--space-xl);
	}

	.readout-col {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.data-row {
		display: flex;
		align-items: baseline;
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 2;
		letter-spacing: 0.04em;
	}

	.data-idx {
		width: 20px;
		flex-shrink: 0;
		color: var(--sig-highlight);
		opacity: 0.4;
		font-size: 9px;
		font-variant-numeric: tabular-nums;
	}

	.data-label {
		color: var(--sig-text-muted);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.data-fill {
		flex: 1;
		min-width: 16px;
		border-bottom: 1px dotted var(--sig-border-strong);
		margin: 0 8px;
		position: relative;
		top: -3px;
	}

	.data-value {
		color: var(--sig-text-bright);
		font-weight: 600;
		white-space: nowrap;
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
</style>
