<script lang="ts">
	import { Badge } from "$lib/components/ui/badge/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import * as Card from "$lib/components/ui/card/index.js";
	import { onMount } from "svelte";

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

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------

	let status = $state<PredictorStatus | null>(null);
	let health = $state<PredictorHealth | null>(null);
	let comparisons = $state<Comparison[]>([]);
	let trainingRuns = $state<TrainingRun[]>([]);
	let loading = $state(true);
	let errors = $state<Array<{ code: string; message: string; timestamp: string }>>([]);

	// ---------------------------------------------------------------------------
	// Derived
	// ---------------------------------------------------------------------------

	const isColdStart = $derived(
		health !== null && !health.coldStartExited && health.sidecarAlive,
	);
	const isActive = $derived(
		health !== null && health.coldStartExited && health.sidecarAlive,
	);
	const isDisabled = $derived(
		status !== null && !status.enabled,
	);

	const healthBadgeVariant = $derived.by(() => {
		if (!health) return "outline" as const;
		switch (health.status) {
			case "healthy": return "default" as const;
			case "degraded": return "secondary" as const;
			case "cold_start": return "secondary" as const;
			case "unhealthy": return "destructive" as const;
			case "disabled": return "outline" as const;
			default: return "outline" as const;
		}
	});

	// Win/loss dots — most recent 20 comparisons
	const recentDots = $derived(
		comparisons.slice(0, 20).reverse(),
	);

	// Overall win rate
	const winRate = $derived.by(() => {
		if (comparisons.length === 0) return 0;
		const wins = comparisons.filter((c) => c.predictorWon).length;
		return wins / comparisons.length;
	});

	// Cold start progress: training pairs needed
	const coldStartTarget = 15; // default trainIntervalSessions
	const coldStartProgress = $derived(
		Math.min(1, comparisons.length / coldStartTarget),
	);

	// ---------------------------------------------------------------------------
	// Fetchers
	// ---------------------------------------------------------------------------

	async function fetchAll(): Promise<void> {
		loading = true;
		try {
			const [statusRes, healthRes, comparisonsRes, trainingRes, errorsRes] =
				await Promise.allSettled([
					fetch(`${API_BASE}/api/predictor/status`),
					fetch(`${API_BASE}/api/diagnostics/predictor`),
					fetch(`${API_BASE}/api/predictor/comparisons?limit=50`),
					fetch(`${API_BASE}/api/predictor/training?limit=10`),
					fetch(`${API_BASE}/api/analytics/errors`),
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
				const allErrors: Array<{ stage: string; code: string; message: string; timestamp: string }> =
					data.errors ?? [];
				errors = allErrors.filter((e) => e.stage === "predictor");
			}
		} catch {
			// fail open
		}
		loading = false;
	}

	function formatDate(iso: string): string {
		try {
			return new Date(iso).toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
		} catch {
			return iso;
		}
	}

	function formatPct(n: number): string {
		return `${(n * 100).toFixed(1)}%`;
	}

	onMount(() => {
		fetchAll();
		const interval = setInterval(fetchAll, 15_000);
		return () => clearInterval(interval);
	});
</script>

<div class="flex flex-col gap-4 p-4 overflow-y-auto">
	{#if loading && !status}
		<p class="sig-label text-[var(--sig-text-muted)]">Loading predictor data...</p>
	{:else if isDisabled}
		<!-- Disabled state -->
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2 text-sm">
					Predictor
					<Badge variant="outline">disabled</Badge>
				</Card.Title>
			</Card.Header>
			<Card.Content>
				<p class="sig-label text-[var(--sig-text-muted)]">
					The predictive memory scorer is not enabled. Enable it in your
					pipeline configuration to start learning which memories matter most.
				</p>
			</Card.Content>
		</Card.Root>
	{:else}
		<!-- Health + Status Row -->
		<div class="grid grid-cols-1 md:grid-cols-3 gap-3">
			<!-- Health Card -->
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title class="flex items-center gap-2 text-sm">
						Health
						{#if health}
							<Badge variant={healthBadgeVariant}>
								{health.status}
							</Badge>
						{/if}
					</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-1.5">
					{#if health}
						<div class="flex justify-between sig-label">
							<span class="text-[var(--sig-text-muted)]">Score</span>
							<span>{formatPct(health.score)}</span>
						</div>
						<div class="flex justify-between sig-label">
							<span class="text-[var(--sig-text-muted)]">Sidecar</span>
							<span class={health.sidecarAlive
								? "text-[var(--sig-success)]"
								: "text-[var(--sig-danger)]"}>
								{health.sidecarAlive ? "alive" : "dead"}
							</span>
						</div>
						<div class="flex justify-between sig-label">
							<span class="text-[var(--sig-text-muted)]">Crashes</span>
							<span class={health.crashCount > 0
								? "text-[var(--sig-warning)]" : ""}>
								{health.crashCount}
								{#if health.crashDisabled}
									<span class="text-[var(--sig-danger)]"> (disabled)</span>
								{/if}
							</span>
						</div>
					{/if}
				</Card.Content>
			</Card.Root>

			<!-- Model Card -->
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title class="text-sm">Model</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-1.5">
					{#if health}
						<div class="flex justify-between sig-label">
							<span class="text-[var(--sig-text-muted)]">Version</span>
							<span>{health.modelVersion}</span>
						</div>
						<div class="flex justify-between sig-label">
							<span class="text-[var(--sig-text-muted)]">Training runs</span>
							<span>{health.trainingSessions}</span>
						</div>
						<div class="flex justify-between sig-label">
							<span class="text-[var(--sig-text-muted)]">Last trained</span>
							<span>{health.lastTrainedAt
								? formatDate(health.lastTrainedAt)
								: "never"}</span>
						</div>
					{/if}
				</Card.Content>
			</Card.Root>

			<!-- Scoring Card -->
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title class="text-sm">Scoring</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-1.5">
					{#if health}
						<div class="flex justify-between sig-label">
							<span class="text-[var(--sig-text-muted)]">Success rate</span>
							<span>{formatPct(health.successRate)}</span>
						</div>
						<div class="flex justify-between sig-label">
							<span class="text-[var(--sig-text-muted)]">Alpha</span>
							<span>{health.alpha.toFixed(2)}</span>
						</div>
						<div class="flex justify-between sig-label">
							<span class="text-[var(--sig-text-muted)]">Cold start</span>
							<span>{health.coldStartExited ? "exited" : "collecting"}</span>
						</div>
					{/if}
				</Card.Content>
			</Card.Root>
		</div>

		{#if isColdStart}
			<!-- Cold Start Progress -->
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title class="text-sm">Cold Start Progress</Card.Title>
				</Card.Header>
				<Card.Content>
					<div class="space-y-2">
						<div class="flex justify-between sig-label text-[var(--sig-text-muted)]">
							<span>Collecting training data</span>
							<span>{comparisons.length} / {coldStartTarget} sessions</span>
						</div>
						<div class="w-full h-2 rounded-full bg-[var(--sig-surface-raised)] overflow-hidden">
							<div
								class="h-full rounded-full bg-[var(--sig-accent)] transition-all duration-300"
								style="width: {coldStartProgress * 100}%"
							></div>
						</div>
						{#if comparisons.length > 0}
							<p class="sig-label text-[var(--sig-text-muted)]">
								Baseline-only NDCG avg: {(comparisons.reduce(
									(sum, c) => sum + c.baselineNdcg, 0
								) / comparisons.length).toFixed(3)}
							</p>
						{/if}
					</div>
				</Card.Content>
			</Card.Root>
		{/if}

		{#if isActive}
			<!-- Alpha Gauge -->
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title class="text-sm">Alpha (baseline vs predictor weight)</Card.Title>
				</Card.Header>
				<Card.Content>
					<div class="space-y-2">
						<div class="flex gap-1 h-5">
							<div
								class="rounded-l bg-[var(--sig-text-muted)] transition-all duration-300 flex items-center justify-center"
								style="width: {(health?.alpha ?? 1) * 100}%"
							>
								{#if (health?.alpha ?? 1) > 0.15}
									<span class="text-[9px] text-[var(--sig-bg)] font-bold">
										BASELINE {formatPct(health?.alpha ?? 1)}
									</span>
								{/if}
							</div>
							<div
								class="rounded-r bg-[var(--sig-accent)] transition-all duration-300 flex items-center justify-center"
								style="width: {(1 - (health?.alpha ?? 1)) * 100}%"
							>
								{#if (1 - (health?.alpha ?? 1)) > 0.15}
									<span class="text-[9px] text-[var(--sig-bg)] font-bold">
										PREDICTOR {formatPct(1 - (health?.alpha ?? 1))}
									</span>
								{/if}
							</div>
						</div>
					</div>
				</Card.Content>
			</Card.Root>

			<!-- Win/Loss Timeline -->
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title class="flex items-center gap-2 text-sm">
						Session Results
						<span class="sig-label text-[var(--sig-text-muted)]">
							win rate: {formatPct(winRate)} ({comparisons.length} sessions)
						</span>
					</Card.Title>
				</Card.Header>
				<Card.Content>
					<div class="flex items-center gap-1 flex-wrap">
						{#each recentDots as dot (dot.sessionKey)}
							<div
								class="w-3 h-3 rounded-full border transition-colors"
								class:bg-[var(--sig-success)]={dot.predictorWon}
								class:border-[var(--sig-success)]={dot.predictorWon}
								class:bg-[var(--sig-danger)]={!dot.predictorWon && dot.scorerConfidence >= 0.6}
								class:border-[var(--sig-danger)]={!dot.predictorWon && dot.scorerConfidence >= 0.6}
								class:bg-[var(--sig-text-muted)]={!dot.predictorWon && dot.scorerConfidence < 0.6}
								class:border-[var(--sig-text-muted)]={!dot.predictorWon && dot.scorerConfidence < 0.6}
								class:opacity-40={dot.scorerConfidence < 0.6}
								title="{dot.predictorWon ? 'Won' : 'Lost'} | NDCG: {dot.predictorNdcg.toFixed(3)} vs {dot.baselineNdcg.toFixed(3)} | {formatDate(dot.createdAt)}"
							></div>
						{/each}
						{#if recentDots.length === 0}
							<span class="sig-label text-[var(--sig-text-muted)]">
								No comparisons yet
							</span>
						{/if}
					</div>
					<div class="flex gap-4 mt-2 sig-label text-[var(--sig-text-muted)]">
						<span class="flex items-center gap-1">
							<span class="w-2 h-2 rounded-full bg-[var(--sig-success)]"></span>
							Predictor won
						</span>
						<span class="flex items-center gap-1">
							<span class="w-2 h-2 rounded-full bg-[var(--sig-danger)]"></span>
							Baseline won
						</span>
						<span class="flex items-center gap-1">
							<span class="w-2 h-2 rounded-full bg-[var(--sig-text-muted)] opacity-40"></span>
							Low confidence
						</span>
					</div>
				</Card.Content>
			</Card.Root>
		{/if}

		<!-- Recent Comparisons Table -->
		{#if comparisons.length > 0}
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title class="text-sm">Recent Comparisons</Card.Title>
				</Card.Header>
				<Card.Content>
					<div class="overflow-x-auto">
						<table class="w-full sig-label">
							<thead>
								<tr class="text-[var(--sig-text-muted)] border-b border-[var(--sig-border)]">
									<th class="text-left py-1 pr-3">Session</th>
									<th class="text-right py-1 px-2">Predictor</th>
									<th class="text-right py-1 px-2">Baseline</th>
									<th class="text-right py-1 px-2">Margin</th>
									<th class="text-right py-1 px-2">Alpha</th>
									<th class="text-left py-1 px-2">Project</th>
									<th class="text-left py-1 pl-2">Time</th>
								</tr>
							</thead>
							<tbody>
								{#each comparisons.slice(0, 15) as c (c.sessionKey)}
									<tr class="border-b border-[var(--sig-border)] border-opacity-30">
										<td class="py-1 pr-3">
											<span class="w-2 h-2 inline-block rounded-full mr-1"
												class:bg-[var(--sig-success)]={c.predictorWon}
												class:bg-[var(--sig-danger)]={!c.predictorWon}
											></span>
											{c.sessionKey.slice(0, 8)}
										</td>
										<td class="text-right py-1 px-2">
											{c.predictorNdcg.toFixed(3)}
										</td>
										<td class="text-right py-1 px-2">
											{c.baselineNdcg.toFixed(3)}
										</td>
										<td class="text-right py-1 px-2"
											class:text-[var(--sig-success)]={c.margin > 0}
											class:text-[var(--sig-danger)]={c.margin < 0}>
											{c.margin > 0 ? "+" : ""}{c.margin.toFixed(3)}
										</td>
										<td class="text-right py-1 px-2">
											{c.alpha.toFixed(2)}
										</td>
										<td class="py-1 px-2 max-w-[120px] truncate">
											{c.project ?? "-"}
										</td>
										<td class="py-1 pl-2 text-[var(--sig-text-muted)]">
											{formatDate(c.createdAt)}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</Card.Content>
			</Card.Root>
		{/if}

		<!-- Training Runs -->
		{#if trainingRuns.length > 0}
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title class="text-sm">Training History</Card.Title>
				</Card.Header>
				<Card.Content>
					<div class="overflow-x-auto">
						<table class="w-full sig-label">
							<thead>
								<tr class="text-[var(--sig-text-muted)] border-b border-[var(--sig-border)]">
									<th class="text-left py-1 pr-3">Version</th>
									<th class="text-right py-1 px-2">Loss</th>
									<th class="text-right py-1 px-2">Samples</th>
									<th class="text-right py-1 px-2">Duration</th>
									<th class="text-right py-1 px-2">Canary NDCG</th>
									<th class="text-left py-1 pl-2">Time</th>
								</tr>
							</thead>
							<tbody>
								{#each trainingRuns as run (run.id)}
									<tr class="border-b border-[var(--sig-border)] border-opacity-30">
										<td class="py-1 pr-3">v{run.modelVersion}</td>
										<td class="text-right py-1 px-2">{run.loss.toFixed(4)}</td>
										<td class="text-right py-1 px-2">{run.sampleCount}</td>
										<td class="text-right py-1 px-2">{(run.durationMs / 1000).toFixed(1)}s</td>
										<td class="text-right py-1 px-2">
											{run.canaryNdcg !== null ? run.canaryNdcg.toFixed(3) : "-"}
										</td>
										<td class="py-1 pl-2 text-[var(--sig-text-muted)]">
											{formatDate(run.createdAt)}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</Card.Content>
			</Card.Root>
		{/if}

		<!-- Errors -->
		{#if errors.length > 0}
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title class="flex items-center gap-2 text-sm">
						Recent Errors
						<Badge variant="destructive">{errors.length}</Badge>
					</Card.Title>
				</Card.Header>
				<Card.Content>
					<div class="space-y-1">
						{#each errors.slice(0, 10) as err}
							<div class="flex items-start gap-2 sig-label">
								<span class="text-[var(--sig-text-muted)] shrink-0">
									{formatDate(err.timestamp)}
								</span>
								<span class="text-[var(--sig-danger)] font-mono">
									{err.code}
								</span>
								<span class="text-[var(--sig-text)] truncate">
									{err.message}
								</span>
							</div>
						{/each}
					</div>
				</Card.Content>
			</Card.Root>
		{/if}

		<!-- Refresh -->
		<div class="flex justify-end">
			<Button
				variant="ghost"
				size="sm"
				class="sig-label"
				onclick={() => fetchAll()}
				disabled={loading}
			>
				{loading ? "Refreshing..." : "Refresh"}
			</Button>
		</div>
	{/if}
</div>
