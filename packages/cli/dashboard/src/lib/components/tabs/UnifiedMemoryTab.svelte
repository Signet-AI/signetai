<script lang="ts">
	import type { Memory } from "$lib/api";
	import EmbeddingsTab from "$lib/components/tabs/EmbeddingsTab.svelte";
	import MemoryTab from "$lib/components/tabs/MemoryTab.svelte";
	import { Button } from "$lib/components/ui/button/index.js";

	interface Props {
		memories: Memory[];
		agentId: string;
		onopenglobalsimilar: (memory: Memory) => void;
	}

	const { memories, agentId, onopenglobalsimilar }: Props = $props();
	type Section = "cortex" | "constellation";
	const SECTION_SET = new Set<string>(["cortex", "constellation"]);

	function readSection(): Section {
		if (typeof window === "undefined") return "cortex";
		const hash = window.location.hash.replace("#", "");
		const parts = hash.split("/");
		if (parts[0] !== "cortex-memory" && parts[0] !== "ontology") return "cortex";
		if (parts[1] && SECTION_SET.has(parts[1])) return parts[1] as Section;
		return "cortex";
	}

	let section = $state<Section>(readSection());

	$effect(() => {
		if (typeof window === "undefined") return;
		const next = section === "cortex" ? "cortex-memory" : "cortex-memory/constellation";
		if (window.location.hash !== `#${next}`) {
			window.history.replaceState(null, "", `#${next}`);
		}
	});

	$effect(() => {
		if (typeof window === "undefined") return;
		const onHash = () => {
			const next = readSection();
			if (next === section) return;
			section = next;
		};
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	});
</script>

<div class="unified-memory">
	<div class="tab-header">
		<div class="tab-header-left">
			<span class="tab-header-title">ONTOLOGY</span>
			<span class="tab-header-sep" aria-hidden="true"></span>
			<span class="tab-header-count">CORTEX INDEX + CONSTELLATION</span>
		</div>
		<div class="unified-actions">
			<Button
				variant="outline"
				size="sm"
				class={`tab-switch ${section === "cortex" ? "tab-switch-active" : ""}`}
				onclick={() => (section = "cortex")}
			>
				CORTEX
			</Button>
			<Button
				variant="outline"
				size="sm"
				class={`tab-switch ${section === "constellation" ? "tab-switch-active" : ""}`}
				onclick={() => (section = "constellation")}
			>
				CONSTELLATION
			</Button>
		</div>
	</div>
	<div class="unified-body">
		{#if section === "cortex"}
			<div class="unified-main">
				<MemoryTab {memories} {agentId} embedded={true} />
			</div>
		{:else}
			<div class="unified-main">
				<div class="extra-body">
					<EmbeddingsTab {onopenglobalsimilar} {agentId} embedded={true} />
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	.unified-memory {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		background: var(--sig-surface);
	}

	.tab-header {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 8px;
		padding: var(--space-sm) var(--space-md);
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.tab-header-left {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.tab-header-title {
		font-family: var(--font-display);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-bright);
	}

	.tab-header-count {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
		text-transform: uppercase;
	}

	.tab-header-sep {
		width: 1px;
		height: 10px;
		background: var(--sig-border);
	}

	.unified-actions {
		display: inline-flex;
		gap: 6px;
	}

	:global(.tab-switch) {
		height: auto;
		padding: 4px 10px;
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		border-color: var(--sig-border-strong);
		color: var(--sig-text-muted);
	}

	:global(.tab-switch-active) {
		color: var(--sig-text-bright);
		border-color: var(--sig-text-muted);
		background: var(--sig-surface-raised);
	}

	.unified-body {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		padding: var(--space-sm);
	}

	.unified-main {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		border: 1px solid var(--sig-border);
		background: var(--sig-bg);
	}

	.extra-body {
		height: 100%;
		min-height: 0;
		overflow: hidden;
	}

	.unified-memory :global(.banner) {
		display: none;
	}

	.unified-memory :global(.tab-header) {
		border-top: none;
	}

	.unified-memory :global(.shortcut-bar) {
		border-bottom: none;
	}
 </style>
