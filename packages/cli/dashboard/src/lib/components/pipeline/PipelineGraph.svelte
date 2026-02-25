<script lang="ts">
	import {
		PIPELINE_NODES,
		PIPELINE_EDGES,
		GROUP_BOXES,
		type NodeGroup,
	} from "./pipeline-types";
	import { pipeline } from "./pipeline-store.svelte";
	import PipelineNode from "./PipelineNode.svelte";
	import PipelineEdge from "./PipelineEdge.svelte";

	interface Props {
		onselectnode: (id: string) => void;
	}

	let { onselectnode }: Props = $props();

	const groups = Object.entries(GROUP_BOXES) as Array<[NodeGroup, typeof GROUP_BOXES[NodeGroup]]>;

	// Track which nodes had recent activity (within last 5s)
	function isNodeActive(id: string): boolean {
		const node = pipeline.nodes[id];
		if (!node?.lastActivity) return false;
		const age = Date.now() - new Date(node.lastActivity).getTime();
		return age < 5000;
	}
</script>

<svg
	viewBox="0 0 1160 650"
	preserveAspectRatio="xMidYMid meet"
	class="w-full h-full"
	xmlns="http://www.w3.org/2000/svg"
>
	<defs>
		<!-- Glow filter for active elements -->
		<filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
			<feGaussianBlur stdDeviation="3" result="blur" />
			<feMerge>
				<feMergeNode in="blur" />
				<feMergeNode in="SourceGraphic" />
			</feMerge>
		</filter>

		<!-- Arrowhead marker -->
		<marker
			id="arrow"
			viewBox="0 0 10 10"
			refX="10"
			refY="5"
			markerWidth="6"
			markerHeight="6"
			orient="auto-start-reverse"
		>
			<path d="M 0 0 L 10 5 L 0 10 z" fill="var(--sig-border-strong)" />
		</marker>
	</defs>

	<!-- Group background boxes -->
	{#each groups as [groupId, box]}
		<g>
			<rect
				x={box.x}
				y={box.y}
				width={box.w}
				height={box.h}
				rx="8"
				ry="8"
				fill={box.color}
				fill-opacity="0.06"
				stroke={box.color}
				stroke-opacity="0.25"
				stroke-width="1"
				stroke-dasharray="4 3"
			/>
			<text
				x={box.x + 8}
				y={box.y + 14}
				fill={box.color}
				font-size="9"
				font-family="var(--font-mono)"
				opacity="0.6"
				letter-spacing="0.08em"
			>
				{box.label.toUpperCase()}
			</text>
		</g>
	{/each}

	<!-- Edges (behind nodes) -->
	{#each PIPELINE_EDGES as edge (edge.from + "-" + edge.to)}
		<PipelineEdge {edge} active={isNodeActive(edge.from)} />
	{/each}

	<!-- Nodes -->
	{#each PIPELINE_NODES as def (def.id)}
		<PipelineNode
			{def}
			nodeState={pipeline.nodes[def.id]}
			selected={pipeline.selectedNodeId === def.id}
			{onselectnode}
		/>
	{/each}
</svg>
