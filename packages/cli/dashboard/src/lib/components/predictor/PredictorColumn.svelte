<script lang="ts">
import { Badge } from "$lib/components/ui/badge/index.js";
import * as Tooltip from "$lib/components/ui/tooltip/index.js";

interface TopPick {
	id: string;
	content: string;
}

interface Props {
	side: "baseline" | "predictor";
	ndcg: number;
	topPicks: TopPick[];
	/** Extra stats displayed as label/value pairs */
	stats: Array<{ label: string; value: string; tooltip?: string }>;
	/** Whether sidecar is offline (predictor column only) */
	offline?: boolean;
}

const { side, ndcg, topPicks, stats, offline = false }: Props = $props();

const qualityPct = $derived(Math.round(ndcg * 100));
const label = $derived(side === "baseline" ? "Heuristic Baseline" : "Predictor Model");
const ndcgTooltip = $derived(`How well this system ranks memories. NDCG@10 = ${ndcg.toFixed(3)}`);
</script>

<div class="flex flex-col gap-2 p-3 bg-card rounded-lg border border-border min-w-0">
	<!-- Header -->
	<div class="flex items-center gap-2">
		<span class="sig-eyebrow tracking-wider text-[var(--sig-text-muted)]">{label}</span>
		{#if offline}
			<Badge variant="destructive" class="text-[8px] px-1.5 py-0">OFFLINE</Badge>
		{/if}
	</div>

	<!-- Ranking Quality -->
	<Tooltip.Root>
		<Tooltip.Trigger class="text-left">
			<div class="flex items-baseline gap-2">
				<span class="text-2xl font-display font-bold text-foreground">{qualityPct}%</span>
				<span class="sig-label text-[var(--sig-text-muted)]">ranking quality</span>
			</div>
		</Tooltip.Trigger>
		<Tooltip.Content class="bg-[var(--sig-surface-raised)] border border-[var(--sig-border)] text-[var(--sig-text)] px-2 py-1 rounded text-xs">
			{ndcgTooltip}
		</Tooltip.Content>
	</Tooltip.Root>

	<!-- Top Picks -->
	<div class="space-y-1">
		<span class="sig-label text-[var(--sig-text-muted)]">recent top picks:</span>
		{#if topPicks.length > 0}
			{#each topPicks.slice(0, 3) as pick (pick.id)}
				<div class="sig-label text-[var(--sig-text)] truncate pl-2 border-l border-[var(--sig-border)]" title={pick.content}>
					{pick.content.slice(0, 60)}{pick.content.length > 60 ? "..." : ""}
				</div>
			{/each}
		{:else}
			<div class="sig-label text-[var(--sig-text-muted)] pl-2 italic">no ranking data yet</div>
		{/if}
	</div>

	<!-- Stats -->
	<div class="mt-auto space-y-1 pt-2 border-t border-[var(--sig-border)]">
		{#each stats as stat (stat.label)}
			{#if stat.tooltip}
				<Tooltip.Root>
					<Tooltip.Trigger class="w-full text-left">
						<div class="flex justify-between sig-label">
							<span class="text-[var(--sig-text-muted)]">{stat.label}</span>
							<span class="text-[var(--sig-text)]">{stat.value}</span>
						</div>
					</Tooltip.Trigger>
					<Tooltip.Content class="bg-[var(--sig-surface-raised)] border border-[var(--sig-border)] text-[var(--sig-text)] px-2 py-1 rounded text-xs">
						{stat.tooltip}
					</Tooltip.Content>
				</Tooltip.Root>
			{:else}
				<div class="flex justify-between sig-label">
					<span class="text-[var(--sig-text-muted)]">{stat.label}</span>
					<span class="text-[var(--sig-text)]">{stat.value}</span>
				</div>
			{/if}
		{/each}
	</div>
</div>
