<script lang="ts">
	import { GROUP_COLORS, type PipelineNodeDef, type PipelineNodeState, type HealthStatus } from "./pipeline-types";

	interface Props {
		def: PipelineNodeDef;
		nodeState: PipelineNodeState;
		selected: boolean;
		onselectnode: (id: string) => void;
	}

	let { def, nodeState, selected, onselectnode }: Props = $props();

	let groupColor = $derived(GROUP_COLORS[def.group]);

	const HEALTH_COLORS: Record<HealthStatus, string> = {
		healthy: "#4ade80",
		degraded: "#fbbf24",
		unhealthy: "#f87171",
		unknown: "#6b6b76",
	};

	let healthColor = $derived(HEALTH_COLORS[nodeState.health]);

	// Use group color as the primary visual, health as secondary
	let strokeColor = $derived(
		nodeState.health === "unknown" ? groupColor + "88" : healthColor,
	);

	// Pulse animation — increments trigger re-animation
	let lastPulse = $state(0);
	let pulsing = $state(false);

	// Track "recently active" for sustained glow (fades after 3s)
	let active = $state(false);
	let activeTimeout: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		if (nodeState.pulseCount > lastPulse) {
			lastPulse = nodeState.pulseCount;

			// Fire pulse
			pulsing = true;
			const pulseTimer = setTimeout(() => { pulsing = false; }, 1200);

			// Sustain active glow
			active = true;
			if (activeTimeout) clearTimeout(activeTimeout);
			activeTimeout = setTimeout(() => { active = false; }, 3000);

			return () => {
				clearTimeout(pulseTimer);
				if (activeTimeout) clearTimeout(activeTimeout);
			};
		}
	});

	function handleClick() {
		onselectnode(def.id);
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<g
	class="pipeline-node"
	class:pipeline-node--selected={selected}
	class:pipeline-node--active={active}
	transform="translate({def.x}, {def.y})"
	onclick={handleClick}
	style="cursor: pointer"
>
	<!-- Glow filter (applied when active) -->
	{#if active}
		<rect
			class="glow-bg"
			x="-6"
			y="-6"
			width={def.w + 12}
			height={def.h + 12}
			rx="10"
			ry="10"
			fill={groupColor}
			opacity="0.12"
		/>
	{/if}

	<!-- Pulse ring (animated on activity) — uses group color, not health -->
	{#if pulsing}
		<rect
			class="pulse-ring"
			x="-4"
			y="-4"
			width={def.w + 8}
			height={def.h + 8}
			rx="10"
			ry="10"
			fill="none"
			stroke={groupColor}
		/>
	{/if}

	<!-- Main rect -->
	<rect
		class="node-rect"
		width={def.w}
		height={def.h}
		rx="6"
		ry="6"
		fill={active ? groupColor + "18" : "var(--sig-surface-raised)"}
		stroke={active ? groupColor : strokeColor}
		stroke-width={selected ? 2.5 : active ? 1.5 : 1}
	/>

	<!-- Active flash overlay -->
	{#if pulsing}
		<rect
			class="flash-overlay"
			width={def.w}
			height={def.h}
			rx="6"
			ry="6"
			fill={groupColor}
		/>
	{/if}

	<!-- Health dot — brighter colors -->
	<circle
		cx="10"
		cy={def.h / 2}
		r={active ? 4 : 3}
		fill={active ? groupColor : healthColor}
		opacity={active ? 1 : 0.7}
	>
		{#if active}
			<animate
				attributeName="opacity"
				values="1;0.4;1"
				dur="1.5s"
				repeatCount="indefinite"
			/>
		{/if}
	</circle>

	<!-- Label -->
	<text
		x={def.w / 2}
		y={def.h / 2 + 1}
		text-anchor="middle"
		dominant-baseline="middle"
		fill={active ? groupColor : "var(--sig-text-bright)"}
		font-size="11"
		font-family="var(--font-mono)"
		font-weight={active ? "600" : "400"}
	>
		{def.label}
	</text>

	<!-- Queue depth badge -->
	{#if nodeState.queueDepth > 0}
		<g transform="translate({def.w - 8}, -6)">
			<rect
				x="-12"
				y="-7"
				width="24"
				height="14"
				rx="7"
				fill={groupColor}
				opacity="0.95"
			/>
			<text
				x="0"
				y="1"
				text-anchor="middle"
				dominant-baseline="middle"
				fill="#fff"
				font-size="9"
				font-weight="600"
				font-family="var(--font-mono)"
			>
				{nodeState.queueDepth}
			</text>
		</g>
	{/if}

	<!-- Error badge -->
	{#if nodeState.errorCount > 0}
		<g transform="translate(8, -6)">
			<rect
				x="-12"
				y="-7"
				width="24"
				height="14"
				rx="7"
				fill="#ef4444"
				opacity="0.95"
			/>
			<text
				x="0"
				y="1"
				text-anchor="middle"
				dominant-baseline="middle"
				fill="#fff"
				font-size="9"
				font-weight="600"
				font-family="var(--font-mono)"
			>
				{nodeState.errorCount}
			</text>
		</g>
	{/if}
</g>

<style>
	.pipeline-node {
		transition: filter 0.3s ease;
	}
	.pipeline-node:hover .node-rect {
		filter: brightness(1.2);
	}
	.pipeline-node--selected .node-rect {
		filter: brightness(1.3);
	}
	.pipeline-node--active {
		filter: drop-shadow(0 0 8px var(--glow, rgba(255,255,255,0.15)));
	}

	.glow-bg {
		animation: glow-fade 3s ease-out forwards;
	}
	@keyframes glow-fade {
		0% { opacity: 0.18; }
		100% { opacity: 0.04; }
	}

	.pulse-ring {
		animation: node-pulse 1.2s ease-out forwards;
	}
	@keyframes node-pulse {
		0% {
			stroke-opacity: 0.9;
			stroke-width: 2.5;
		}
		100% {
			stroke-opacity: 0;
			stroke-width: 16;
		}
	}

	.flash-overlay {
		animation: flash 0.6s ease-out forwards;
		pointer-events: none;
	}
	@keyframes flash {
		0% { opacity: 0.3; }
		100% { opacity: 0; }
	}
</style>
