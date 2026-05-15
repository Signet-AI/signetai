<script lang="ts">
import ConstellationGraph from "./ConstellationGraph.svelte";

interface Props {
	agentId?: string;
}
const { agentId = "default" }: Props = $props();
</script>

<div class="ontology-dashboard">
	<ConstellationGraph {agentId} />
</div>

<style>
	.ontology-dashboard {
		height: 100%;
		min-height: 0;
		overflow: hidden;
		background: #02040a;
	}
</style>
