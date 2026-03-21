<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import {
		os,
		fetchTrayEntries,
		getTrayApps,
		getGridApps,
		getDockApps,
		moveToGrid,
		loadGroups,
		requestWidgetGen,
		fetchWidgetHtml,
		onWidgetGenerated,
		widgetHtmlCache,
		findFreeGridPosition,
		type GridPosition,
	} from "$lib/stores/os.svelte";
	import { API_BASE } from "$lib/api";
	import WidgetGrid from "$lib/components/os/WidgetGrid.svelte";
	import AppDock from "$lib/components/os/AppDock.svelte";
	import SidebarGroups from "$lib/components/os/SidebarGroups.svelte";
	import RefreshCw from "@lucide/svelte/icons/refresh-cw";

	const trayApps = $derived(getTrayApps());
	const gridApps = $derived(getGridApps());
	const dockApps = $derived(getDockApps());

	let eventSource: EventSource | null = null;

	onMount(() => {
		fetchTrayEntries();
		loadGroups();

		// Subscribe to widget generation events via SSE
		eventSource = new EventSource(`${API_BASE}/api/os/events/stream?type=widget`);
		eventSource.onmessage = (e) => {
			try {
				const event = JSON.parse(e.data);
				if (event.type === "widget.generated" && event.payload?.serverId) {
					// Fetch the generated HTML and update the cache
					fetchWidgetHtml(event.payload.serverId);
				}
			} catch {
				// Ignore parse errors from heartbeats
			}
		};
	});

	onDestroy(() => {
		eventSource?.close();
	});

	async function handleDragToBoard(id: string): Promise<void> {
		const entry = os.entries.find((a) => a.id === id);
		if (!entry) return;
		const size = entry.manifest?.defaultSize ?? { w: 4, h: 3 };

		// Compute a free grid position to avoid overlapping at (0,0)
		const occupied = gridApps.flatMap((a) =>
			a.id !== id && a.gridPosition ? [a.gridPosition] : [],
		);
		const pos = findFreeGridPosition(occupied, size);

		await moveToGrid(id, pos);

		// Trigger widget generation if no declared or cached HTML
		if (!entry.manifest.html && !widgetHtmlCache.has(id)) {
			fetchWidgetHtml(id).then((cached) => {
				if (!cached) requestWidgetGen(id);
			});
		}
	}

	function handleGridDrop(appId: string, x: number, y: number): void {
		const entry = os.entries.find((a) => a.id === appId);
		if (!entry) return;
		const size = entry.manifest?.defaultSize ?? { w: 4, h: 3 };
		moveToGrid(appId, { x, y, ...size });
	}

	/** Resolve the default widget size for a given appId (for WidgetGrid collision detection) */
	function resolveDefaultSize(appId: string): { w: number; h: number } {
		const entry = os.entries.find((a) => a.id === appId);
		return entry?.manifest?.defaultSize ?? { w: 4, h: 3 };
	}
</script>

<div class="os-tab">
	<!-- Sidebar groups panel (left) -->
	<div class="os-sidebar">
		<SidebarGroups />
	</div>

	<!-- Main content area -->
	<div class="os-main">
		<!-- Top bar -->
		<div class="os-topbar">
			<div class="os-topbar-left">
				<span class="sig-heading">View and Manage your Apps</span>
				<span class="sig-eyebrow">{os.entries.length} {os.entries.length === 1 ? "server" : "servers"}</span>
			</div>
			<div class="os-topbar-right">
				<button
					class="os-refresh-btn"
					title="Refresh app tray"
					onclick={() => fetchTrayEntries()}
					disabled={os.loading}
				>
					<RefreshCw class={`size-3${os.loading ? " animate-spin" : ""}`} />
				</button>
			</div>
		</div>

		{#if os.error}
			<div class="os-error">
				<span class="sig-label text-[var(--sig-danger)]">{os.error}</span>
			</div>
		{/if}

		<!-- Widget grid -->
		<WidgetGrid apps={gridApps} ongriddrop={handleGridDrop} {resolveDefaultSize} />

		<!-- Bottom dock / tray -->
		<AppDock
			{trayApps}
			{dockApps}
			ondragtoboard={handleDragToBoard}
		/>
	</div>
</div>

<style>
	.os-tab {
		display: flex;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.os-sidebar {
		width: 180px;
		min-width: 180px;
		border-right: 1px solid var(--sig-border);
		background: var(--sig-bg);
		overflow-y: auto;
		padding: var(--space-sm) 0;
		flex-shrink: 0;
	}

	.os-main {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		background: var(--sig-bg);
	}

	.os-topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px var(--space-md);
		background: var(--sig-surface);
		flex-shrink: 0;
	}

	.os-topbar-left {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.os-topbar-right {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.os-refresh-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: 1px solid var(--sig-border);
		border-radius: 6px;
		background: var(--sig-surface);
		color: var(--sig-text-muted);
		cursor: pointer;
		transition: all var(--dur) var(--ease);
	}

	.os-refresh-btn:hover:not(:disabled) {
		border-color: var(--sig-border-strong);
		color: var(--sig-text-bright);
	}

	.os-refresh-btn:disabled {
		opacity: 0.4;
	}

	.os-error {
		padding: 8px var(--space-md);
		background: color-mix(in srgb, var(--sig-danger) 8%, var(--sig-bg));
	}

	@media (max-width: 768px) {
		.os-tab {
			flex-direction: column;
		}

		.os-sidebar {
			width: 100%;
			min-width: 0;
			max-height: 120px;
			border-right: none;
			border-bottom: 1px solid var(--sig-border);
			padding: var(--space-sm);
			overflow-x: auto;
			overflow-y: hidden;
		}
	}
</style>
