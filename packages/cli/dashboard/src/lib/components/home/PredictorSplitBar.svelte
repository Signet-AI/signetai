<script lang="ts">
import type { DaemonStatus } from "$lib/api";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Card, CardContent, CardHeader, CardTitle } from "$lib/components/ui/card/index.js";
import { setTab } from "$lib/stores/navigation.svelte";
import Gauge from "@lucide/svelte/icons/gauge";

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

interface DiagnosticsPredictor {
	score: number;
	status: string;
}

interface DiagnosticsIndex {
	embeddingCoverage: number;
}

interface DiagnosticsStorage {
	totalMemories: number;
}

interface DiagnosticsComposite {
	score: number;
}

interface DiagnosticsData {
	predictor?: DiagnosticsPredictor;
	index?: DiagnosticsIndex;
	storage?: DiagnosticsStorage;
	composite?: DiagnosticsComposite;
}

interface Props {
	daemonStatus: DaemonStatus | null;
}

const { daemonStatus }: Props = $props();

let health = $state<PredictorHealth | null>(null);
let diagnostics = $state<DiagnosticsData | null>(null);
let loaded = $state(false);

const predictorAvailable = $derived(health !== null && health.sidecarAlive);

const alpha = $derived(health?.alpha ?? 0.6);
const successRate = $derived(health?.successRate ?? 0);
const healthStatus = $derived(health?.status ?? "unknown");

const embeddingCoverage = $derived(diagnostics?.index?.embeddingCoverage ?? 0);
const totalMemories = $derived(diagnostics?.storage?.totalMemories ?? 0);
const compositeScore = $derived(diagnostics?.composite?.score ?? 0);

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
	}
});
</script>

<Card
	class="flex flex-col overflow-hidden rounded-none
		border-[var(--sig-border)] py-0
		shadow-none"
	style="background: var(--sig-surface);"
>
	<CardHeader class="px-3 py-2.5">
		<div class="flex items-center gap-2">
			<Gauge class="size-3.5 text-[var(--sig-text-muted)]" />
			<CardTitle
				class="font-display text-[11px] font-bold uppercase tracking-[0.1em]
					text-[var(--sig-text-bright)]"
			>
				Memory Scoring
			</CardTitle>
		</div>
	</CardHeader>

	<CardContent class="px-3 pb-3 pt-0">
		{#if !loaded}
			<div class="h-12"></div>
		{:else if predictorAvailable}
			<!-- Split bar: baseline vs predictor -->
			<div class="space-y-1.5">
				<div class="flex gap-px h-2 w-full overflow-hidden rounded-sm">
					<div
						class="transition-all duration-300"
						style="width: {alpha * 100}%; background: var(--sig-text-muted)"
					></div>
					<div
						class="transition-all duration-300"
						style="width: {(1 - alpha) * 100}%; background: var(--sig-accent)"
					></div>
				</div>
				<div class="flex justify-between">
					<span class="sig-micro text-[var(--sig-text-muted)]">baseline</span>
					<span class="sig-micro text-[var(--sig-accent)]">predictor</span>
				</div>

				<div class="flex items-center gap-2 pt-1">
					<span class="sig-meta text-[var(--sig-text-muted)]">
						success {Math.round(successRate * 100)}%
					</span>
					<Badge variant={healthBadgeVariant} class="text-[8px] px-1.5 py-0">
						{healthStatus}
					</Badge>
				</div>
			</div>
		{:else}
			<!-- Baseline-only stats -->
			<div class="space-y-2">
				<div class="flex justify-between items-center">
					<span class="sig-meta text-[var(--sig-text-muted)]">embedding coverage</span>
					<span class="sig-meta text-[var(--sig-text)]">
						{Math.round(embeddingCoverage * 100)}%
					</span>
				</div>
				<div class="flex justify-between items-center">
					<span class="sig-meta text-[var(--sig-text-muted)]">total memories</span>
					<span class="sig-meta text-[var(--sig-text)]">
						{totalMemories.toLocaleString()}
					</span>
				</div>
				<div class="flex justify-between items-center">
					<span class="sig-meta text-[var(--sig-text-muted)]">health score</span>
					<span class="sig-meta text-[var(--sig-text)]">
						{Math.round(compositeScore * 100)}%
					</span>
				</div>
			</div>
		{/if}

		<button
			class="mt-2 sig-meta text-[var(--sig-accent)] transition-opacity hover:opacity-80"
			onclick={() => setTab("predictor")}
		>
			View predictor &rarr;
		</button>
	</CardContent>
</Card>
