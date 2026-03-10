<script lang="ts">
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import * as Popover from "$lib/components/ui/popover/index.js";
import * as Tooltip from "$lib/components/ui/tooltip/index.js";
import RefreshCw from "@lucide/svelte/icons/refresh-cw";
import Settings2 from "@lucide/svelte/icons/settings-2";
import Zap from "@lucide/svelte/icons/zap";

interface Props {
	healthStatus: string;
	alpha: number;
	winRate: number;
	sidecarAlive: boolean;
	training: boolean;
	loading: boolean;
	trainingPairs: number;
	trainEpochs: number;
	trainLimit: number;
	trainInterval: number;
	onTrain: () => void;
	onRefresh: () => void;
	onEpochsChange: (v: number) => void;
	onLimitChange: (v: number) => void;
}

const {
	healthStatus,
	alpha,
	winRate,
	sidecarAlive,
	training,
	loading,
	trainingPairs,
	trainEpochs,
	trainLimit,
	trainInterval,
	onTrain,
	onRefresh,
	onEpochsChange,
	onLimitChange,
}: Props = $props();

const healthBadgeVariant = $derived.by(() => {
	switch (healthStatus) {
		case "healthy":
			return "default" as const;
		case "degraded":
		case "cold_start":
			return "secondary" as const;
		case "unhealthy":
			return "destructive" as const;
		default:
			return "outline" as const;
	}
});

const configOpen = $state(false);
</script>

<div class="flex items-center gap-3 px-3 py-2 bg-card rounded-lg border border-border">
	<!-- Health badge -->
	<Badge variant={healthBadgeVariant} class="text-[9px] shrink-0">
		{healthStatus}
	</Badge>

	<!-- Alpha gauge -->
	<Tooltip.Root>
		<Tooltip.Trigger class="flex items-center gap-2 min-w-[120px]">
			<span class="sig-meta text-[var(--sig-text-muted)] shrink-0">alpha</span>
			<div class="flex gap-px h-2.5 flex-1 rounded overflow-hidden">
				<div
					class="bg-[var(--sig-text-muted)] transition-all duration-300"
					style="width: {alpha * 100}%"
				></div>
				<div
					class="bg-[var(--sig-accent)] transition-all duration-300"
					style="width: {(1 - alpha) * 100}%"
				></div>
			</div>
			<span class="sig-meta text-[var(--sig-text)] font-mono">{alpha.toFixed(2)}</span>
		</Tooltip.Trigger>
		<Tooltip.Content class="bg-[var(--sig-surface-raised)] border border-[var(--sig-border)] text-[var(--sig-text)] px-2 py-1 rounded text-xs max-w-[240px]">
			Baseline weight in scoring. Shifts toward predictor as it proves itself.
		</Tooltip.Content>
	</Tooltip.Root>

	<!-- Win rate -->
	<Tooltip.Root>
		<Tooltip.Trigger>
			<span class="sig-label text-[var(--sig-text)]">
				win rate: <span class="font-bold">{Math.round(winRate * 100)}%</span>
			</span>
		</Tooltip.Trigger>
		<Tooltip.Content class="bg-[var(--sig-surface-raised)] border border-[var(--sig-border)] text-[var(--sig-text)] px-2 py-1 rounded text-xs max-w-[240px]">
			Sessions where predictor ranked better than heuristic baseline.
		</Tooltip.Content>
	</Tooltip.Root>

	<!-- Spacer -->
	<div class="flex-1"></div>

	<!-- Training config popover -->
	<Popover.Root bind:open={configOpen}>
		<Popover.Trigger
			class="flex items-center gap-1 sig-label text-[var(--sig-text-muted)] hover:text-[var(--sig-text)] transition-colors p-1 rounded hover:bg-[var(--sig-surface-raised)]"
		>
			<Settings2 class="w-3.5 h-3.5" />
		</Popover.Trigger>
		<Popover.Content
			class="w-[260px] bg-[var(--sig-surface)] border border-[var(--sig-border)] rounded-lg shadow-lg p-3 space-y-3"
			side="bottom"
			align="end"
		>
				<div class="sig-eyebrow text-[var(--sig-text-muted)]">training config</div>

				<!-- Epochs -->
				<div class="space-y-1">
					<div class="flex justify-between items-center">
						<span class="sig-label text-[var(--sig-text-muted)]">epochs per run</span>
						<input
							type="number"
							min="1"
							max="20"
							value={trainEpochs}
							oninput={(e) => onEpochsChange(Number(e.currentTarget.value))}
							class="w-14 bg-[var(--sig-surface-raised)] border border-[var(--sig-border)] rounded px-1.5 py-0.5 text-center sig-label text-[var(--sig-text)] focus:outline-none focus:border-[var(--sig-accent)]"
						/>
					</div>
					<span class="sig-meta text-[var(--sig-text-muted)]">more epochs = longer but more thorough</span>
				</div>

				<!-- Sample limit -->
				<div class="space-y-1">
					<div class="flex justify-between items-center">
						<span class="sig-label text-[var(--sig-text-muted)]">max samples</span>
						<input
							type="number"
							min="100"
							max="50000"
							step="500"
							value={trainLimit}
							oninput={(e) => onLimitChange(Number(e.currentTarget.value))}
							class="w-20 bg-[var(--sig-surface-raised)] border border-[var(--sig-border)] rounded px-1.5 py-0.5 text-center sig-label text-[var(--sig-text)] focus:outline-none focus:border-[var(--sig-accent)]"
						/>
					</div>
					<span class="sig-meta text-[var(--sig-text-muted)]">training pairs to use per run</span>
				</div>

				<!-- Auto-train interval (read-only — configured in agent.yaml) -->
				<div class="space-y-1">
					<div class="flex justify-between items-center">
						<span class="sig-label text-[var(--sig-text-muted)]">auto-trains every</span>
						<span class="sig-label text-[var(--sig-text)]">{trainInterval} sessions</span>
					</div>
					<span class="sig-meta text-[var(--sig-text-muted)]">change in settings</span>
				</div>

				<div class="pt-1 border-t border-[var(--sig-border)]">
					<span class="sig-meta text-[var(--sig-text-muted)]">
						{trainingPairs.toLocaleString()} training pairs available
					</span>
				</div>
		</Popover.Content>
	</Popover.Root>

	<!-- Train button -->
	<Button
		variant="default"
		size="sm"
		class="sig-label gap-1.5"
		onclick={onTrain}
		disabled={training || !sidecarAlive}
	>
		<Zap class="w-3.5 h-3.5" />
		{#if training}
			training...
		{:else}
			train now
		{/if}
	</Button>

	<!-- Refresh -->
	<button
		class="flex items-center p-1 rounded text-[var(--sig-text-muted)] hover:text-[var(--sig-text)] hover:bg-[var(--sig-surface-raised)] transition-colors disabled:opacity-40"
		onclick={onRefresh}
		disabled={loading}
	>
		<RefreshCw class="w-3.5 h-3.5 {loading ? 'animate-spin' : ''}" />
	</button>
</div>
