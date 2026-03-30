<script lang="ts">
interface Comparison {
	sessionKey: string;
	predictorNdcg: number;
	baselineNdcg: number;
	predictorWon: boolean;
	margin: number;
	project: string | null;
	createdAt: string;
}

interface Props {
	comparisons: Comparison[];
}

let { comparisons }: Props = $props();

// Wide viewBox so SVG text at font-size 11 renders at ~11px real
const PAD = { top: 12, right: 12, bottom: 20, left: 32 };
const W = 1200;
const H = 200;
const plotW = W - PAD.left - PAD.right;
const plotH = H - PAD.top - PAD.bottom;

// Chronological order (oldest first)
const sorted = $derived([...comparisons].reverse());

function x(i: number): number {
	if (sorted.length <= 1) return PAD.left + plotW / 2;
	return PAD.left + (i / (sorted.length - 1)) * plotW;
}

function y(ndcg: number): number {
	return PAD.top + (1 - ndcg) * plotH;
}

function buildPoints(accessor: (c: Comparison) => number): string {
	return sorted.map((c, i) => `${x(i).toFixed(1)},${y(accessor(c)).toFixed(1)}`).join(" ");
}

const baselinePoints = $derived(buildPoints((c) => c.baselineNdcg));
const predictorPoints = $derived(buildPoints((c) => c.predictorNdcg));

const gridLines = [0.25, 0.5, 0.75];

let hoveredIdx = $state<number | null>(null);

function formatDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}
</script>

{#if sorted.length === 0}
	<div class="flex items-center justify-center h-full">
		<span class="sig-label text-[var(--sig-text-muted)]">no comparison data yet</span>
	</div>
{:else}
	<svg
		width="100%"
		height="100%"
		viewBox="0 0 {W} {H}"
		preserveAspectRatio="xMidYMid meet"
		class="select-none"
	>
		<!-- Grid lines -->
		{#each gridLines as val}
			<line
				x1={PAD.left}
				y1={y(val)}
				x2={W - PAD.right}
				y2={y(val)}
				stroke="var(--sig-border)"
				stroke-width="0.5"
				stroke-dasharray="4,4"
			/>
			<text
				x={PAD.left - 6}
				y={y(val) + 4}
				text-anchor="end"
				fill="var(--sig-text-muted)"
				font-size="11"
				font-family="var(--font-mono)"
			>
				{val.toFixed(2)}
			</text>
		{/each}

		<!-- Axis bounds -->
		<text x={PAD.left - 6} y={y(1) + 4} text-anchor="end" fill="var(--sig-text-muted)" font-size="11" font-family="var(--font-mono)">1.00</text>
		<text x={PAD.left - 6} y={y(0) + 4} text-anchor="end" fill="var(--sig-text-muted)" font-size="11" font-family="var(--font-mono)">0.00</text>

		<!-- Baseline line -->
		<polyline
			points={baselinePoints}
			fill="none"
			stroke="var(--sig-text-muted)"
			stroke-width="1.5"
			stroke-linejoin="round"
			stroke-linecap="round"
			opacity="0.5"
		/>

		<!-- Predictor line -->
		<polyline
			points={predictorPoints}
			fill="none"
			stroke="var(--sig-success)"
			stroke-width="2"
			stroke-linejoin="round"
			stroke-linecap="round"
		/>

		<!-- Win/loss dots along bottom -->
		{#each sorted as c, i}
			<circle
				cx={x(i)}
				cy={H - 6}
				r="3"
				fill={c.predictorWon ? "var(--sig-success)" : "var(--sig-danger)"}
				opacity={c.predictorWon ? 0.8 : 0.5}
			/>
		{/each}

		<!-- Hover hit areas -->
		{#each sorted as c, i}
			<rect
				x={x(i) - Math.max(plotW / sorted.length, 16) / 2}
				y={0}
				width={Math.max(plotW / sorted.length, 16)}
				height={H}
				fill="transparent"
				onmouseenter={() => (hoveredIdx = i)}
				onmouseleave={() => (hoveredIdx = null)}
			/>

			{#if hoveredIdx === i}
				<!-- Vertical guide -->
				<line
					x1={x(i)}
					y1={PAD.top}
					x2={x(i)}
					y2={H - PAD.bottom}
					stroke="var(--sig-border)"
					stroke-width="0.5"
					stroke-dasharray="3,3"
				/>
				<circle cx={x(i)} cy={y(c.baselineNdcg)} r="4" fill="var(--sig-text-muted)" stroke="var(--sig-bg)" stroke-width="1.5" />
				<circle cx={x(i)} cy={y(c.predictorNdcg)} r="4" fill="var(--sig-success)" stroke="var(--sig-bg)" stroke-width="1.5" />
			{/if}
		{/each}

		<!-- Legend (top-right) -->
		<line x1={W - PAD.right - 160} y1={10} x2={W - PAD.right - 146} y2={10} stroke="var(--sig-text-muted)" stroke-width="1.5" opacity="0.5" />
		<text x={W - PAD.right - 142} y={14} fill="var(--sig-text-muted)" font-size="11" font-family="var(--font-mono)">baseline</text>
		<line x1={W - PAD.right - 80} y1={10} x2={W - PAD.right - 66} y2={10} stroke="var(--sig-success)" stroke-width="2" />
		<text x={W - PAD.right - 62} y={14} fill="var(--sig-success)" font-size="11" font-family="var(--font-mono)">predictor</text>
	</svg>

	<!-- HTML tooltip overlay -->
	{#if hoveredIdx !== null && sorted[hoveredIdx]}
		{@const c = sorted[hoveredIdx]}
		<div
			class="absolute z-10 bg-[var(--sig-surface-raised)] border border-[var(--sig-border)] rounded px-2 py-1.5 shadow-md pointer-events-none"
			style="top: 4px; right: 8px;"
		>
			<div class="sig-label text-[var(--sig-text-muted)]">{formatDate(c.createdAt)}</div>
			<div class="flex gap-3 mt-0.5">
				<span class="sig-label">
					<span class="text-[var(--sig-text-muted)]">base</span>
					<span class="text-[var(--sig-text)] ml-1">{c.baselineNdcg.toFixed(3)}</span>
				</span>
				<span class="sig-label">
					<span class="text-[var(--sig-success)]">pred</span>
					<span class="text-[var(--sig-text)] ml-1">{c.predictorNdcg.toFixed(3)}</span>
				</span>
				<span class="sig-label" class:text-[var(--sig-success)]={c.margin > 0} class:text-[var(--sig-danger)]={c.margin < 0}>
					{c.margin > 0 ? "+" : ""}{c.margin.toFixed(3)}
				</span>
			</div>
			{#if c.project}
				<div class="sig-meta text-[var(--sig-text-muted)] mt-0.5">{c.project}</div>
			{/if}
		</div>
	{/if}
{/if}
