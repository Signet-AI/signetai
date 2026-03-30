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
import { getConnectors, getContinuityLatest, getDiagnostics, getPipelineStatus } from "$lib/api";
import AgentHeader from "$lib/components/home/AgentHeader.svelte";
import MarketplaceSpotlights from "$lib/components/home/MarketplaceSpotlights.svelte";
import PinnedEntityCluster from "$lib/components/home/PinnedEntityCluster.svelte";
import PredictorSplitBar from "$lib/components/home/PredictorSplitBar.svelte";
import SuggestedInsights from "$lib/components/home/SuggestedInsights.svelte";
import { onMount } from "svelte";

interface Props {
	identity: Identity;
	memories: Memory[];
	memoryStats: MemoryStats | null;
	harnesses: Harness[];
	daemonStatus: DaemonStatus | null;
}

let { identity, memories, memoryStats, harnesses, daemonStatus }: Props = $props();

let diagnostics = $state<DiagnosticsReport | null>(null);
let continuity = $state<ContinuityEntry[]>([]);
let pipelineStatus = $state<PipelineStatus | null>(null);
let connectors = $state<DocumentConnector[]>([]);
let loaded = $state(false);

onMount(async () => {
	const results = await Promise.allSettled([
		getDiagnostics(),
		getContinuityLatest(),
		getPipelineStatus(),
		getConnectors(),
	]);

	if (results[0].status === "fulfilled" && results[0].value) diagnostics = results[0].value;
	if (results[1].status === "fulfilled") continuity = results[1].value;
	if (results[2].status === "fulfilled") pipelineStatus = results[2].value;
	if (results[3].status === "fulfilled") connectors = results[3].value;
	loaded = true;
});
</script>

<div class="flex flex-col flex-1 min-h-0 overflow-hidden">
<div class="home-grid">
	<div class="area-banner">
		<AgentHeader
			{identity}
			{daemonStatus}
			connectorCount={connectors.length}
			{continuity}
			memoryCount={memoryStats?.total ?? 0}
			{diagnostics}
			{pipelineStatus}
			{memoryStats}
		/>
	</div>
	<div class="area-spotlights">
		<MarketplaceSpotlights />
	</div>
	<div class="area-insights">
		<SuggestedInsights {memories} />
	</div>
	<div class="area-sidebar">
		<PinnedEntityCluster {memories} />
		<PredictorSplitBar {daemonStatus} />
	</div>
</div>
</div>

<style>
	.home-grid {
		display: grid;
		grid-template-columns: 1.6fr 1fr;
		grid-template-rows: auto minmax(auto, max-content) 1fr;
		grid-template-areas:
			"banner     banner"
			"spotlights sidebar"
			"insights   sidebar";
		gap: var(--space-sm);
		flex: 1;
		min-height: 0;
		padding: var(--space-sm);
		overflow: hidden;
	}

	.area-banner {
		grid-area: banner;
	}

	.area-spotlights {
		grid-area: spotlights;
		min-height: 0;
		overflow: hidden;
	}

	.area-insights {
		grid-area: insights;
		min-height: 0;
		overflow: hidden;
	}

	.area-sidebar {
		grid-area: sidebar;
		grid-row: 2 / 4;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		min-height: 0;
		overflow: hidden;
	}

	.area-sidebar > :global(*) {
		flex: 1;
		min-width: 0;
		min-height: 0;
	}
</style>
