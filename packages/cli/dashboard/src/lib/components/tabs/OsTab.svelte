<script lang="ts">
	import { onMount } from "svelte";
	import {
		os,
		fetchTrayEntries,
		getTrayApps,
		getGridApps,
		getDockApps,
		moveToGrid,
		loadGroups,
		type GridPosition,
	} from "$lib/stores/os.svelte";
	import WidgetGrid from "$lib/components/os/WidgetGrid.svelte";
	import AppDock from "$lib/components/os/AppDock.svelte";
	import SidebarGroups from "$lib/components/os/SidebarGroups.svelte";
	import RefreshCw from "@lucide/svelte/icons/refresh-cw";

	const trayApps = $derived(getTrayApps());
	const gridApps = $derived(getGridApps());
	const dockApps = $derived(getDockApps());

	onMount(() => {
		fetchTrayEntries();
		loadGroups();
	});

	async function handleDragToBoard(id: string): Promise<void> {
		await moveToGrid(id);
	}

	function handleGridDrop(appId: string, x: number, y: number): void {
		const entry = os.entries.find((a) => a.id === appId);
		if (!entry) return;
		const size = entry.manifest?.defaultSize ?? { w: 4, h: 3 };
		moveToGrid(appId, { x, y, ...size });
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
				<span class="sig-heading">Signet OS</span>
				<span class="sig-eyebrow">{os.entries.length} apps</span>
			</div>
			<div class="os-topbar-right">
				<button
					class="sig-switch os-refresh-btn"
					title="Refresh app tray"
					onclick={() => fetchTrayEntries()}
					disabled={os.loading}
				>
					<RefreshCw class="size-3.5 {os.loading ? 'animate-spin' : ''}" />
				</button>
			</div>
		</div>

		{#if os.error}
			<div class="os-error">
				<span class="sig-label text-[var(--sig-danger)]">{os.error}</span>
			</div>
		{/if}

		<!-- Widget grid -->
		<WidgetGrid apps={gridApps} ongriddrop={handleGridDrop} />

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
		background: var(--sig-surface);
		overflow-y: auto;
		padding-top: var(--space-sm);
	}

	.os-main {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}

	.os-topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px var(--space-md);
		border-bottom: 1px solid var(--sig-border);
		background: var(--sig-surface);
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
	}

	.os-error {
		padding: 6px var(--space-md);
		background: rgba(138, 74, 72, 0.1);
		border-bottom: 1px solid var(--sig-danger);
	}

	@media (max-width: 768px) {
		.os-sidebar {
			display: none;
		}
	}
</style>
