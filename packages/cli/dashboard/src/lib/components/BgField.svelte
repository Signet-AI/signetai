<script lang="ts">
	import { onMount } from "svelte";

	interface Props {
		version: string;
		memCount: number;
	}

	let { version, memCount }: Props = $props();

	let connSvg = $state<SVGSVGElement | null>(null);

	const BG_EDGES: [string, string][] = [
		["bg-ch-0", "bg-ch-1"], ["bg-ch-1", "bg-ch-2"], ["bg-ch-0", "bg-ch-3"],
		["bg-ch-4", "bg-ch-5"],
		["bg-ch-6", "bg-ch-7"], ["bg-ch-7", "bg-ch-8"],
		["bg-ch-9", "bg-ch-10"], ["bg-ch-10", "bg-ch-11"],
		["bg-ch-1", "bg-ch-7"], ["bg-ch-4", "bg-ch-10"],
	];

	function drawBgConnectors() {
		if (!connSvg) return;
		while (connSvg.firstChild) connSvg.removeChild(connSvg.firstChild);
		const ns = "http://www.w3.org/2000/svg";
		for (const [a, b] of BG_EDGES) {
			const ea = document.getElementById(a)?.getBoundingClientRect();
			const eb = document.getElementById(b)?.getBoundingClientRect();
			if (!ea || !eb) continue;
			const ax = ea.left + ea.width / 2, ay = ea.top + ea.height / 2;
			const bx = eb.left + eb.width / 2, by = eb.top + eb.height / 2;
			const dx = bx - ax, dy = by - ay;
			const mx = (ax + bx) / 2 + dy * 0.12;
			const my = (ay + by) / 2 - dx * 0.12;
			const path = document.createElementNS(ns, "path");
			path.setAttribute("d", `M ${ax},${ay} Q ${mx},${my} ${bx},${by}`);
			path.setAttribute("stroke", "var(--color-text-muted)");
			path.setAttribute("stroke-width", "0.75");
			path.setAttribute("fill", "none");
			path.setAttribute("opacity", "0.6");
			path.setAttribute("stroke-dasharray", "5 4");
			connSvg.appendChild(path);
		}
	}

	onMount(() => {
		drawBgConnectors();
		window.addEventListener("resize", drawBgConnectors);
		return () => window.removeEventListener("resize", drawBgConnectors);
	});
</script>

<div class="bg-field" aria-hidden="true">
	<div class="bleed-text">SIGNET</div>

	<div class="fp fp-1"></div>
	<div class="fp fp-2"></div>
	<div class="fp fp-3"></div>
	<div class="fp fp-4"></div>

	<span class="mf mf-1">v{version}</span>
	<span class="mf mf-2">PORT_3850</span>
	<span class="mf mf-3">MEM_{memCount}</span>
	<span class="mf mf-4">AGENT_NET</span>

	<svg class="conn-svg" bind:this={connSvg}></svg>

	{#each Array(12) as _, i}
		<div class="ch-node" id="bg-ch-{i}"></div>
	{/each}

	<div class="sc-hub sc-hub-1"></div>
	<div class="sc-hub sc-hub-2"></div>
	<div class="sc-hub sc-hub-3"></div>
</div>
