<script lang="ts">
	import { NODE_MAP, GROUP_COLORS, type PipelineEdgeDef } from "./pipeline-types";

	interface Props {
		edge: PipelineEdgeDef;
		active: boolean;
	}

	let { edge, active }: Props = $props();

	let fromNode = $derived(NODE_MAP.get(edge.from));
	let toNode = $derived(NODE_MAP.get(edge.to));
	let edgeColor = $derived(fromNode ? GROUP_COLORS[fromNode.group] : "#6b6b76");

	// Compute path between node edge points (not centers)
	let pathData = $derived.by(() => {
		if (!fromNode || !toNode) return "";

		const x1 = fromNode.x + fromNode.w / 2;
		const y1 = fromNode.y + fromNode.h / 2;
		const x2 = toNode.x + toNode.w / 2;
		const y2 = toNode.y + toNode.h / 2;

		const mx = (x1 + x2) / 2;
		const my = (y1 + y2) / 2;
		const dx = Math.abs(x2 - x1);
		const dy = Math.abs(y2 - y1);

		if (dx > dy) {
			return `M ${x1} ${y1} Q ${mx} ${y1}, ${mx} ${my} Q ${mx} ${y2}, ${x2} ${y2}`;
		}
		return `M ${x1} ${y1} Q ${x1} ${my}, ${mx} ${my} Q ${x2} ${my}, ${x2} ${y2}`;
	});

	let labelPos = $derived.by(() => {
		if (!fromNode || !toNode) return { x: 0, y: 0 };
		return {
			x: (fromNode.x + fromNode.w / 2 + toNode.x + toNode.w / 2) / 2,
			y: (fromNode.y + fromNode.h / 2 + toNode.y + toNode.h / 2) / 2 - 8,
		};
	});

	let animDuration = $derived(active ? "1s" : "3s");
</script>

<g class="pipeline-edge">
	<!-- Edge path — colored by source group -->
	<path
		d={pathData}
		fill="none"
		stroke={active ? edgeColor : "var(--sig-border)"}
		stroke-width={active ? 1.5 : 0.8}
		stroke-dasharray={edge.dashed ? "6 4" : "none"}
		opacity={active ? 0.8 : 0.25}
		class:edge-active={active}
	/>

	<!-- Active glow path (wider, blurred duplicate) -->
	{#if active && !edge.dashed}
		<path
			d={pathData}
			fill="none"
			stroke={edgeColor}
			stroke-width="4"
			opacity="0.15"
			class="edge-glow"
		/>
	{/if}

	<!-- Animated particle — bigger and more colorful -->
	{#if !edge.dashed}
		<circle
			r={active ? 3.5 : 2}
			fill={active ? edgeColor : "var(--sig-border)"}
			opacity={active ? 1 : 0.3}
		>
			<animateMotion
				dur={animDuration}
				repeatCount="indefinite"
				path={pathData}
			/>
		</circle>

		<!-- Second particle for active edges (staggered) -->
		{#if active}
			<circle
				r="2"
				fill={edgeColor}
				opacity="0.6"
			>
				<animateMotion
					dur={animDuration}
					repeatCount="indefinite"
					path={pathData}
					begin="0.5s"
				/>
			</circle>
		{/if}
	{/if}

	<!-- Edge label -->
	{#if edge.label}
		<text
			x={labelPos.x}
			y={labelPos.y}
			text-anchor="middle"
			fill={active ? edgeColor : "var(--sig-text-muted)"}
			font-size="9"
			font-family="var(--font-mono)"
			opacity={active ? 0.9 : 0.45}
		>
			{edge.label}
		</text>
	{/if}
</g>

<style>
	.edge-active {
		transition: stroke 0.3s ease, opacity 0.3s ease;
	}
	.edge-glow {
		animation: glow-pulse 2s ease-in-out infinite;
	}
	@keyframes glow-pulse {
		0%, 100% { opacity: 0.1; }
		50% { opacity: 0.25; }
	}
</style>
