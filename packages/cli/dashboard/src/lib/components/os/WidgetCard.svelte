<script lang="ts">
	import type { AppTrayEntry } from "$lib/stores/os.svelte";
	import AutoCard from "./AutoCard.svelte";
	import GripVertical from "@lucide/svelte/icons/grip-vertical";
	import X from "@lucide/svelte/icons/x";
	import Minimize2 from "@lucide/svelte/icons/minimize-2";

	interface Props {
		app: AppTrayEntry;
		onremove: (id: string) => void;
		ondragstart: (id: string, e: PointerEvent) => void;
	}

	const { app, onremove, ondragstart }: Props = $props();

	const hasUI = $derived(!!app.manifest?.ui);
</script>

<div class="widget-card sig-panel">
	<!-- Drag handle + title bar -->
	<div
		class="widget-titlebar sig-panel-header"
		onpointerdown={(e) => {
			if ((e.target as HTMLElement).closest('button')) return;
			ondragstart(app.id, e);
		}}
	>
		<GripVertical class="size-3 opacity-30 shrink-0 cursor-grab" />
		<span class="widget-title">{app.name}</span>
		<div class="widget-titlebar-actions">
			<button
				class="widget-titlebar-btn"
				title="Move to tray"
				onclick={() => onremove(app.id)}
			>
				<Minimize2 class="size-3" />
			</button>
		</div>
	</div>

	<!-- Content area -->
	<div class="widget-content">
		{#if hasUI}
			<iframe
				src={app.manifest.ui}
				title={app.name}
				class="widget-iframe"
				sandbox="allow-scripts allow-forms"
			></iframe>
		{:else}
			<AutoCard
				autoCard={app.autoCard}
				name={app.name}
				icon={app.icon}
			/>
		{/if}
	</div>
</div>

<style>
	.widget-card {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}

	.widget-titlebar {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		min-height: 28px;
		cursor: grab;
		user-select: none;
	}

	.widget-titlebar:active {
		cursor: grabbing;
	}

	.widget-title {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		color: var(--sig-text-bright);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.widget-titlebar-actions {
		display: flex;
		gap: 2px;
	}

	.widget-titlebar-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		border-radius: 3px;
		border: none;
		background: transparent;
		color: var(--sig-text-muted);
		cursor: pointer;
		transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
	}

	.widget-titlebar-btn:hover {
		color: var(--sig-text-bright);
		background: rgba(255, 255, 255, 0.06);
	}

	.widget-content {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.widget-iframe {
		width: 100%;
		height: 100%;
		border: none;
		background: var(--sig-bg);
	}
</style>
