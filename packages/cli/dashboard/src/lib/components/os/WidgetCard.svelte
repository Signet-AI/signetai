<script lang="ts">
import type { AppTrayEntry, WidgetSizePreset } from "$lib/stores/os.svelte";
import {
	os,
	expandWidget,
	fetchWidgetHtml,
	requestWidgetGen,
	widgetGenerating,
	widgetHtmlCache,
} from "$lib/stores/os.svelte";
import { WIDGET_SIZES } from "$lib/stores/os.svelte";
import GripVertical from "@lucide/svelte/icons/grip-vertical";
import Maximize2 from "@lucide/svelte/icons/maximize-2";
import Minimize2 from "@lucide/svelte/icons/minimize-2";
import RefreshCw from "@lucide/svelte/icons/refresh-cw";
import { onMount } from "svelte";
import AutoCard from "./AutoCard.svelte";
import WidgetSandbox from "./WidgetSandbox.svelte";

interface Props {
	app: AppTrayEntry;
	onremove: (id: string) => void;
	ondragstart: (id: string, e: PointerEvent) => void;
}

let { app, onremove, ondragstart }: Props = $props();

// Auto-fetch cached widget HTML on mount if not already in memory
onMount(() => {
	if (!app.manifest.html && !widgetHtmlCache.has(app.id)) {
		fetchWidgetHtml(app.id);
	}
});

// Force reactivity on cache changes
const _v = $derived(os.widgetCacheVersion);

const widgetHtml = $derived.by(() => {
	// Access _v to subscribe to cache changes
	void _v;
	if (app.manifest.html) return app.manifest.html;
	return widgetHtmlCache.get(app.id) ?? null;
});

const generating = $derived.by(() => {
	void _v;
	return widgetGenerating.has(app.id);
});
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
			<button
				class="widget-titlebar-btn"
				title="Expand widget"
				onclick={() => expandWidget(app.id)}
			>
				<Maximize2 class="size-3" />
			</button>
			{#if !app.manifest.html && !generating}
				<button
					class="widget-titlebar-btn"
					title={widgetHtml ? "Regenerate widget" : "Generate widget UI"}
					onclick={() => requestWidgetGen(app.id)}
				>
					<RefreshCw class="size-3" />
				</button>
			{/if}
		</div>
	</div>

	<!-- Content area -->
	<div class="widget-content">
		{#if widgetHtml}
			<WidgetSandbox html={widgetHtml} serverId={app.id} />
		{:else if generating}
			<div class="widget-generating">
				<div class="widget-generating-border"></div>
				<span class="widget-generating-text">Widget Generating...</span>
			</div>
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

	.widget-generating {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		position: relative;
	}

	.widget-generating-border {
		position: absolute;
		inset: 8px;
		border: 2px dashed var(--sig-border-strong);
		border-radius: 8px;
		animation: pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
	}

	.widget-generating-text {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		animation: pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

</style>
