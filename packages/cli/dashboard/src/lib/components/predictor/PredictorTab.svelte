<script lang="ts">
import PageBanner from "$lib/components/layout/PageBanner.svelte";
import TabGroupBar from "$lib/components/layout/TabGroupBar.svelte";
import { ENGINE_TAB_ITEMS } from "$lib/components/layout/page-headers";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import * as Card from "$lib/components/ui/card/index.js";
import * as Collapsible from "$lib/components/ui/collapsible/index.js";
import { nav } from "$lib/stores/navigation.svelte";
import { focusEngineTab } from "$lib/stores/tab-group-focus.svelte";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import { onMount } from "svelte";
import ConvergenceChart from "./ConvergenceChart.svelte";
import PredictorColumn from "./PredictorColumn.svelte";
import PredictorStatusBar from "./PredictorStatusBar.svelte";

const isDev = import.meta.env.DEV;
const API_BASE = isDev ? "http://localhost:3850" : "";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PredictorStatus {
	enabled: boolean;
	alive?: boolean;
	crashCount?: number;
	crashDisabled?: boolean;
	status?: {
		trained: boolean;
		training_pairs: number;
		model_version: number;
		last_trained: string | null;
	} | null;
}

interface PredictorHealth {
	score: number;
	status: string;
	sidecarAlive: boolean;
	modelVersion: number;
	trainingSessions: number;
	successRate: number;
	alpha: number;
	coldStartExited: boolean;
	lastTrainedAt: string | null;
	crashCount: number;
	crashDisabled: boolean;
}

interface Comparison {
	sessionKey: string;
	predictorNdcg: number;
	baselineNdcg: number;
	predictorWon: boolean;
	margin: number;
	alpha: number;
	scorerConfidence: number;
	candidateCount: number;
	project: string | null;
	createdAt: string;
	predictorTopIds?: string[];
	baselineTopIds?: string[];
}

interface TrainingRun {
	id: string;
	modelVersion: number;
	loss: number;
	sampleCount: number;
	durationMs: number;
	canaryNdcg: number | null;
	createdAt: string;
}

interface TrainResult {
	loss: number;
	step: number;
	samples_used: number;
	samples_skipped: number;
	duration_ms: number;
}

interface TopPick {
	id: string;
	content: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let status = $state<PredictorStatus | null>(null);
let health = $state<PredictorHealth | null>(null);
let comparisons = $state<Comparison[]>([]);
let trainingRuns = $state<TrainingRun[]>([]);
let loading = $state(true);
let training = $state(false);
let trainResult = $state<TrainResult | null>(null);
let trainError = $state<string | null>(null);
let trainingPairs = $state(0);
let errors = $state<Array<{ code: string; message: string; timestamp: string }>>([]);
const detailsOpen = $state(false);

// Training config — persisted via localStorage
const TRAIN_CONFIG_KEY = "signet-predictor-train-config";

function loadTrainConfig(): { epochs: number; limit: number } {
	try {
		const raw = localStorage.getItem(TRAIN_CONFIG_KEY);
		if (raw) return JSON.parse(raw);
	} catch {
		/* fall through */
	}
	return { epochs: 3, limit: 5000 };
}

function saveTrainConfig(epochs: number, limit: number): void {
	localStorage.setItem(TRAIN_CONFIG_KEY, JSON.stringify({ epochs, limit }));
}

const savedConfig = loadTrainConfig();
const trainEpochs = $state(savedConfig.epochs);
const trainLimit = $state(savedConfig.limit);
const trainInterval = $state(10); // read-only — daemon's trainIntervalSessions default

// Memory content for top picks
let predictorPicks = $state<TopPick[]>([]);
let baselinePicks = $state<TopPick[]>([]);

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

const isDisabled = $derived(status !== null && !status.enabled);
const isColdStart = $derived(health !== null && !health.coldStartExited && health.sidecarAlive);
const isActive = $derived(health !== null && health.coldStartExited && health.sidecarAlive);
const isSidecarDead = $derived(health !== null && !health.sidecarAlive && status !== null && status.enabled);

const coldStartTarget = 10;
const coldStartProgress = $derived(Math.min(1, comparisons.length / coldStartTarget));

const winRate = $derived.by(() => {
	if (comparisons.length === 0) return 0;
	const wins = comparisons.filter((c) => c.predictorWon).length;
	return wins / comparisons.length;
});

const avgPredictorNdcg = $derived(
	comparisons.length === 0 ? 0 : comparisons.reduce((s, c) => s + c.predictorNdcg, 0) / comparisons.length,
);

const avgBaselineNdcg = $derived(
	comparisons.length === 0 ? 0 : comparisons.reduce((s, c) => s + c.baselineNdcg, 0) / comparisons.length,
);

const avgConfidence = $derived(
	comparisons.length === 0 ? 0 : comparisons.reduce((s, c) => s + c.scorerConfidence, 0) / comparisons.length,
);

// ---------------------------------------------------------------------------
// Column stats
// ---------------------------------------------------------------------------

const baselineStats = $derived<Array<{ label: string; value: string; tooltip?: string }>>([
	{
		label: "sessions evaluated",
		value: `${comparisons.length}`,
	},
	{
		label: "avg confidence",
		value: avgConfidence.toFixed(2),
	},
]);

const predictorStats = $derived<Array<{ label: string; value: string; tooltip?: string }>>([
	{
		label: "win rate",
		value: `${Math.round(winRate * 100)}%`,
		tooltip: "Sessions where predictor ranked better than heuristic baseline.",
	},
	{
		label: "training pairs",
		value: trainingPairs.toLocaleString(),
		tooltip: "Memory-relevance examples the model has learned from.",
	},
	{
		label: "model",
		value: health
			? `v${health.modelVersion} ${health.lastTrainedAt ? `\u00b7 ${relativeTime(health.lastTrainedAt)}` : ""}`
			: "-",
	},
]);

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

let fetching = $state(false);
let fetchError = $state(false);

async function fetchAll(): Promise<void> {
	if (fetching) return;
	fetching = true;
	loading = status === null; // only show spinner on initial load
	try {
		const [statusRes, healthRes, comparisonsRes, trainingRes, errorsRes, pairsRes] = await Promise.allSettled([
			fetch(`${API_BASE}/api/predictor/status`),
			fetch(`${API_BASE}/api/diagnostics/predictor`),
			fetch(`${API_BASE}/api/predictor/comparisons?limit=50`),
			fetch(`${API_BASE}/api/predictor/training?limit=10`),
			fetch(`${API_BASE}/api/analytics/errors`),
			fetch(`${API_BASE}/api/predictor/training-pairs-count`),
		]);

		if (statusRes.status === "fulfilled" && statusRes.value.ok) {
			status = await statusRes.value.json();
		}
		if (healthRes.status === "fulfilled" && healthRes.value.ok) {
			health = await healthRes.value.json();
		}
		if (comparisonsRes.status === "fulfilled" && comparisonsRes.value.ok) {
			const data = await comparisonsRes.value.json();
			comparisons = data.items ?? [];
		}
		if (trainingRes.status === "fulfilled" && trainingRes.value.ok) {
			const data = await trainingRes.value.json();
			trainingRuns = data.items ?? [];
		}
		if (errorsRes.status === "fulfilled" && errorsRes.value.ok) {
			const data = await errorsRes.value.json();
			const allErrors: Array<{ stage: string; code: string; message: string; timestamp: string }> = data.errors ?? [];
			errors = allErrors.filter((e) => e.stage === "predictor");
		}
		if (pairsRes.status === "fulfilled" && pairsRes.value.ok) {
			const data = await pairsRes.value.json();
			trainingPairs = data.count ?? 0;
		}
	} catch {
		// fail open
	}
	if (status === null) fetchError = true;
	loading = false;
	fetching = false;

	// Top picks are a non-blocking enhancement — fetch independently
	fetchTopPicks().catch(() => {});
}

async function fetchTopPicks(): Promise<void> {
	try {
		if (comparisons.length === 0) return;
		const latest = comparisons[0];
		const pIds: string[] = latest.predictorTopIds ?? [];
		const bIds: string[] = latest.baselineTopIds ?? [];

		const allIds = [...new Set([...pIds.slice(0, 5), ...bIds.slice(0, 5)])];
		if (allIds.length === 0) return;

		const results = await Promise.allSettled(
			allIds.map((id) => fetch(`${API_BASE}/api/memory/${id}`).then((r) => (r.ok ? r.json() : null))),
		);

		const memoryMap = new Map<string, string>();
		for (let i = 0; i < allIds.length; i++) {
			const r = results[i];
			if (r.status === "fulfilled" && r.value !== null) {
				memoryMap.set(allIds[i], r.value.content ?? "");
			}
		}

		predictorPicks = pIds
			.slice(0, 5)
			.filter((id) => memoryMap.has(id))
			.map((id) => ({ id, content: memoryMap.get(id) ?? "" }));

		baselinePicks = bIds
			.slice(0, 5)
			.filter((id) => memoryMap.has(id))
			.map((id) => ({ id, content: memoryMap.get(id) ?? "" }));
	} catch {
		// non-critical — top picks just won't show
		predictorPicks = [];
		baselinePicks = [];
	}
}

async function trainNow(): Promise<void> {
	training = true;
	trainResult = null;
	trainError = null;
	try {
		const res = await fetch(`${API_BASE}/api/predictor/train`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ epochs: trainEpochs, limit: trainLimit }),
		});
		const data = await res.json();
		if (!res.ok) {
			trainError = data.error ?? `HTTP ${res.status}`;
		} else {
			trainResult = data as TrainResult;
			await fetchAll();
		}
	} catch (err) {
		trainError = String(err);
	}
	training = false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function relativeTime(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime();
	if (Number.isNaN(ms)) return iso;
	const mins = Math.floor(ms / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	const days = Math.floor(hrs / 24);
	return `${days}d ago`;
}

onMount(() => {
	fetchAll();
	const interval = setInterval(fetchAll, 15_000);
	return () => clearInterval(interval);
});
</script>

<!-- Observatory layout: CSS grid, no page scroll -->
<div class="flex flex-col flex-1 min-h-0 overflow-hidden">
	<PageBanner title="Predictor">
		<TabGroupBar
			group="engine"
			tabs={ENGINE_TAB_ITEMS}
			activeTab={nav.activeTab}
			onselect={(_tab, index) => focusEngineTab(index)}
		/>
	</PageBanner>
	<div class="grid flex-1 min-h-0 overflow-y-auto gap-3 p-3" style="grid-template-rows: auto auto auto 1fr auto;">
	{#if loading && !status && !fetchError}
		<div class="flex items-center justify-center col-span-full row-span-full">
			<span class="sig-label text-[var(--sig-text-muted)]">loading predictor data...</span>
		</div>
	{:else if fetchError && !status}
		<div class="flex items-center justify-center col-span-full row-span-full">
			<span class="sig-label text-[var(--sig-text-muted)]">unable to reach predictor -- check daemon status</span>
		</div>
	{:else if isDisabled}
		<!-- Disabled: single centered card -->
		<div class="flex items-center justify-center col-span-full row-span-full">
			<Card.Root class="max-w-md">
				<Card.Header>
					<Card.Title class="flex items-center gap-2 text-sm">
						Predictor
						<Badge variant="outline">disabled</Badge>
					</Card.Title>
				</Card.Header>
				<Card.Content>
					<p class="sig-label text-[var(--sig-text-muted)]">
						The predictive memory scorer learns which memories matter most for each
						session. Enable it in your pipeline configuration to start training.
					</p>
				</Card.Content>
			</Card.Root>
		</div>
	{:else}
		<!-- Row 1: STATUS BAR -->
		<PredictorStatusBar
			healthStatus={health?.status ?? "unknown"}
			alpha={health?.alpha ?? 1}
			{winRate}
			sidecarAlive={health?.sidecarAlive ?? false}
			{training}
			{loading}
			{trainingPairs}
			{trainEpochs}
			{trainLimit}
			{trainInterval}
			onTrain={trainNow}
			onRefresh={fetchAll}
			onEpochsChange={(v) => { trainEpochs = v; saveTrainConfig(v, trainLimit); }}
			onLimitChange={(v) => { trainLimit = v; saveTrainConfig(trainEpochs, v); }}
		/>

		<!-- Row 2: TWO COLUMNS (content-sized) -->
		<div class="grid grid-cols-2 gap-3">
			{#if isColdStart}
				<PredictorColumn
					side="baseline"
					ndcg={avgBaselineNdcg}
					topPicks={baselinePicks}
					stats={baselineStats}
				/>

				<!-- Training placeholder -->
				<div class="flex flex-col items-center justify-center gap-2 p-3 bg-card rounded-lg border border-border border-dashed">
					<span class="sig-eyebrow tracking-wider text-[var(--sig-text-muted)]">predictor model</span>
					<span class="sig-label text-[var(--sig-text-muted)]">collecting training data</span>
					<div class="w-full max-w-[180px] space-y-1">
						<div class="flex justify-between sig-meta text-[var(--sig-text-muted)]">
							<span>{comparisons.length} / {coldStartTarget} sessions</span>
							<span>{Math.round(coldStartProgress * 100)}%</span>
						</div>
						<div class="w-full h-1.5 rounded-full bg-[var(--sig-surface-raised)] overflow-hidden">
							<div
								class="h-full rounded-full bg-[var(--sig-accent)] transition-all duration-300 animate-pulse"
								style="width: {coldStartProgress * 100}%"
							></div>
						</div>
					</div>
					<span class="sig-meta text-[var(--sig-text-muted)] max-w-[200px] text-center">
						needs more sessions before it can start ranking
					</span>
				</div>
			{:else}
				<PredictorColumn
					side="baseline"
					ndcg={avgBaselineNdcg}
					topPicks={baselinePicks}
					stats={baselineStats}
				/>

				<PredictorColumn
					side="predictor"
					ndcg={avgPredictorNdcg}
					topPicks={predictorPicks}
					stats={predictorStats}
					offline={isSidecarDead}
				/>
			{/if}
		</div>

		<!-- Row 3: CONVERGENCE CHART (fills remaining space) -->
		<div class="relative min-h-0">
			<ConvergenceChart {comparisons} />
		</div>

		<!-- Row 4: DETAILS + feedback -->
		<div class="space-y-1.5">
			<!-- Train result / error feedback -->
			{#if trainResult}
				<div class="sig-label text-[var(--sig-success)]">
					trained v{trainResult.step} -- {trainResult.samples_used} samples, loss {trainResult.loss.toFixed(4)}, {(trainResult.duration_ms / 1000).toFixed(1)}s
				</div>
			{:else if trainError}
				<div class="sig-label text-[var(--sig-danger)]">{trainError}</div>
			{/if}

			<Collapsible.Root bind:open={detailsOpen}>
				<Collapsible.Trigger class="flex items-center gap-1.5 sig-label text-[var(--sig-text-muted)] hover:text-[var(--sig-text)] transition-colors">
					<ChevronDown
						class="w-3 h-3 transition-transform duration-200"
						style="transform: rotate({detailsOpen ? '0deg' : '-90deg'})"
					/>
					details
					{#if errors.length > 0}
						<Badge variant="destructive" class="text-[8px] px-1 py-0 ml-1">{errors.length}</Badge>
					{/if}
				</Collapsible.Trigger>
				<Collapsible.Content>
					<div class="mt-2 max-h-[200px] overflow-y-auto space-y-3 pr-1">
						<!-- Comparisons table -->
						{#if comparisons.length > 0}
							<div>
								<span class="sig-eyebrow text-[var(--sig-text-muted)]">recent comparisons</span>
								<table class="w-full sig-label mt-1">
									<thead>
										<tr class="text-[var(--sig-text-muted)] border-b border-[var(--sig-border)]">
											<th class="text-left py-1 pr-3">session</th>
											<th class="text-right py-1 px-2">pred</th>
											<th class="text-right py-1 px-2">base</th>
											<th class="text-right py-1 px-2">margin</th>
											<th class="text-left py-1 px-2">project</th>
											<th class="text-left py-1 pl-2">time</th>
										</tr>
									</thead>
									<tbody>
										{#each comparisons.slice(0, 15) as c (c.sessionKey)}
											<tr class="border-b border-[var(--sig-border)] border-opacity-30">
												<td class="py-1 pr-3">
													<span
														class="w-2 h-2 inline-block rounded-full mr-1"
														class:bg-[var(--sig-success)]={c.predictorWon}
														class:bg-[var(--sig-danger)]={!c.predictorWon}
													></span>
													{c.sessionKey.slice(0, 8)}
												</td>
												<td class="text-right py-1 px-2">{c.predictorNdcg.toFixed(3)}</td>
												<td class="text-right py-1 px-2">{c.baselineNdcg.toFixed(3)}</td>
												<td
													class="text-right py-1 px-2"
													class:text-[var(--sig-success)]={c.margin > 0}
													class:text-[var(--sig-danger)]={c.margin < 0}
												>
													{c.margin > 0 ? "+" : ""}{c.margin.toFixed(3)}
												</td>
												<td class="py-1 px-2 max-w-[120px] truncate">{c.project ?? "-"}</td>
												<td class="py-1 pl-2 text-[var(--sig-text-muted)]">{formatDate(c.createdAt)}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{/if}

						<!-- Training history -->
						{#if trainingRuns.length > 0}
							<div>
								<span class="sig-eyebrow text-[var(--sig-text-muted)]">training history</span>
								<table class="w-full sig-label mt-1">
									<thead>
										<tr class="text-[var(--sig-text-muted)] border-b border-[var(--sig-border)]">
											<th class="text-left py-1 pr-3">version</th>
											<th class="text-right py-1 px-2">loss</th>
											<th class="text-right py-1 px-2">samples</th>
											<th class="text-right py-1 px-2">duration</th>
											<th class="text-right py-1 px-2">canary</th>
											<th class="text-left py-1 pl-2">time</th>
										</tr>
									</thead>
									<tbody>
										{#each trainingRuns as run (run.id)}
											<tr class="border-b border-[var(--sig-border)] border-opacity-30">
												<td class="py-1 pr-3">v{run.modelVersion}</td>
												<td class="text-right py-1 px-2">{run.loss.toFixed(4)}</td>
												<td class="text-right py-1 px-2">{run.sampleCount}</td>
												<td class="text-right py-1 px-2">{(run.durationMs / 1000).toFixed(1)}s</td>
												<td class="text-right py-1 px-2">{run.canaryNdcg !== null ? run.canaryNdcg.toFixed(3) : "-"}</td>
												<td class="py-1 pl-2 text-[var(--sig-text-muted)]">{formatDate(run.createdAt)}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{/if}

						<!-- Errors -->
						{#if errors.length > 0}
							<div>
								<span class="sig-eyebrow text-[var(--sig-text-muted)]">errors</span>
								<div class="space-y-1 mt-1">
									{#each errors.slice(0, 10) as err}
										<div class="flex items-start gap-2 sig-label">
											<span class="text-[var(--sig-text-muted)] shrink-0">{formatDate(err.timestamp)}</span>
											<span class="text-[var(--sig-danger)] font-mono">{err.code}</span>
											<span class="text-[var(--sig-text)] truncate">{err.message}</span>
										</div>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				</Collapsible.Content>
			</Collapsible.Root>
		</div>
	{/if}
	</div>
</div>
