<script lang="ts">
import type {
	ContinuityEntry,
	DaemonStatus,
	DiagnosticsReport,
	DocumentConnector,
	Harness,
	Identity,
	Memory,
	MemoryStats,
	PipelineStatus,
} from "$lib/api";
import {
	fetchChangelog,
	getConnectors,
	getContinuityLatest,
	getDiagnostics,
	getHomeGreeting,
	getPipelineStatus,
} from "$lib/api";
import AgentHeader from "$lib/components/home/AgentHeader.svelte";
import MiniChangelog from "$lib/components/home/MiniChangelog.svelte";
import PinnedEntityCluster from "$lib/components/home/PinnedEntityCluster.svelte";
import PredictorSplitBar from "$lib/components/home/PredictorSplitBar.svelte";
import SuggestedInsights from "$lib/components/home/SuggestedInsights.svelte";
import SystemInfoCard from "$lib/components/home/SystemInfoCard.svelte";
import PageBanner from "$lib/components/layout/PageBanner.svelte";
import { onMount } from "svelte";

interface Props {
	identity: Identity;
	memories: Memory[];
	memoryStats: MemoryStats | null;
	harnesses: Harness[];
	daemonStatus: DaemonStatus | null;
}

const { identity, memories, memoryStats, harnesses, daemonStatus }: Props = $props();

let diagnostics = $state<DiagnosticsReport | null>(null);
let greeting = $state<string>("welcome back");
let continuity = $state<ContinuityEntry[]>([]);
let pipelineStatus = $state<PipelineStatus | null>(null);
let connectors = $state<DocumentConnector[]>([]);
let changelogHtml = $state<string | null>(null);
let loaded = $state(false);

onMount(async () => {
	const results = await Promise.allSettled([
		getDiagnostics(),
		getHomeGreeting(),
		getContinuityLatest(),
		getPipelineStatus(),
		getConnectors(),
		fetchChangelog(),
	]);

	if (results[0].status === "fulfilled" && results[0].value) diagnostics = results[0].value;
	if (results[1].status === "fulfilled" && results[1].value) greeting = results[1].value.greeting;
	if (results[2].status === "fulfilled") continuity = results[2].value;
	if (results[3].status === "fulfilled") pipelineStatus = results[3].value;
	if (results[4].status === "fulfilled") connectors = results[4].value;
	if (results[5].status === "fulfilled" && results[5].value) changelogHtml = results[5].value.html;
	loaded = true;
});
</script>

<div class="flex flex-col flex-1 min-h-0 overflow-hidden">
<PageBanner title="Home" />
<div class="home-grid">
	<div class="area-banner">
		<AgentHeader
			{identity}
			{greeting}
			{daemonStatus}
			connectorCount={connectors.length}
			{continuity}
			memoryCount={memoryStats?.total ?? 0}
		/>
	</div>
	<div class="area-insights">
		<SuggestedInsights {memories} />
	</div>
	<div class="area-right-top">
		<PinnedEntityCluster />
		<PredictorSplitBar {daemonStatus} />
	</div>
	<div class="area-health">
		<SystemInfoCard
			{diagnostics}
			{pipelineStatus}
			{memoryStats}
		/>
	</div>
	<div class="area-changelog">
		<MiniChangelog html={changelogHtml} />
	</div>
</div>
</div>

<style>
	.home-grid {
		display: grid;
		grid-template-columns: 1.6fr 1fr;
		grid-template-rows: auto 1fr 1fr;
		grid-template-areas:
			"banner     banner"
			"insights   righttop"
			"health     changelog";
		gap: var(--space-sm);
		flex: 1;
		min-height: 0;
		padding: var(--space-sm);
		overflow: hidden;
	}

	.area-banner {
		grid-area: banner;
	}

	.area-insights {
		grid-area: insights;
		min-height: 0;
		overflow: hidden;
	}

	.area-right-top {
		grid-area: righttop;
		display: flex;
		gap: var(--space-sm);
		min-height: 0;
		overflow: hidden;
	}

	.area-right-top > :global(*) {
		flex: 1;
		min-width: 0;
	}

	.area-health {
		grid-area: health;
	}

	.area-changelog {
		grid-area: changelog;
		min-height: 0;
		overflow: hidden;
	}
</style>
