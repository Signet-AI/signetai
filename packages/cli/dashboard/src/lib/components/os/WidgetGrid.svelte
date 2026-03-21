<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import type { AppTrayEntry, GridPosition } from "$lib/stores/os.svelte";
	import { os, updateGridPosition, moveToTray, collapseWidget, findFreeGridPosition } from "$lib/stores/os.svelte";
	import WidgetCard from "./WidgetCard.svelte";

	interface Props {
		apps: AppTrayEntry[];
		ongriddrop: (appId: string, x: number, y: number) => void;
		resolveDefaultSize?: (appId: string) => { w: number; h: number };
	}

	const { apps, ongriddrop, resolveDefaultSize }: Props = $props();

	const GRID_COLS = 12;
	const ROW_HEIGHT = 80;
	const GAP = 8;

	let dragId = $state<string | null>(null);
	let dragStartX = $state(0);
	let dragStartY = $state(0);
	let dragOffsetX = $state(0);
	let dragOffsetY = $state(0);
	let gridEl = $state<HTMLDivElement | null>(null);

	let activeMoveListener: ((e: PointerEvent) => void) | null = null;
	let activeUpListener: (() => void) | null = null;

	function cleanupDragListeners(): void {
		if (activeMoveListener) {
			window.removeEventListener("pointermove", activeMoveListener);
			activeMoveListener = null;
		}
		if (activeUpListener) {
			window.removeEventListener("pointerup", activeUpListener);
			activeUpListener = null;
		}
	}

	onDestroy(() => {
		cleanupDragListeners();
		window.removeEventListener("keydown", handleKeydown);
	});

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === "Escape" && os.focusedId) collapseWidget();
	}

	onMount(() => {
		window.addEventListener("keydown", handleKeydown);
	});

	const focusedApp = $derived(os.focusedId ? apps.find((a) => a.id === os.focusedId) ?? null : null);

	const maxRow = $derived.by(() => {
		let max = 4;
		for (const app of apps) {
			if (app.gridPosition) {
				const bottom = app.gridPosition.y + app.gridPosition.h;
				if (bottom > max) max = bottom;
			}
		}
		return max + 2;
	});

	// Convert grid units to percentage-based absolute positioning
	function getStyle(pos: GridPosition | undefined): string {
		if (!pos) return "display: none;";
		const left = (pos.x / GRID_COLS) * 100;
		const width = (pos.w / GRID_COLS) * 100;
		const top = pos.y * ROW_HEIGHT;
		const height = pos.h * ROW_HEIGHT - GAP;
		return `left: ${left}%; width: ${width}%; top: ${top}px; height: ${height}px;`;
	}

	function handleDragStart(id: string, e: PointerEvent): void {
		cleanupDragListeners();
		dragId = id;
		dragStartX = e.clientX;
		dragStartY = e.clientY;
		dragOffsetX = 0;
		dragOffsetY = 0;

		const onMove = (me: PointerEvent) => {
			dragOffsetX = me.clientX - dragStartX;
			dragOffsetY = me.clientY - dragStartY;
		};

		const onUp = () => {
			cleanupDragListeners();
			commitDrag();
		};

		activeMoveListener = onMove;
		activeUpListener = onUp;
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	function findFreePosition(desired: GridPosition, excludeId: string): GridPosition {
		const occupied = apps.flatMap((a) =>
			a.id !== excludeId && a.gridPosition ? [a.gridPosition] : [],
		);
		return findFreeGridPosition(occupied, { w: desired.w, h: desired.h }, { x: desired.x, y: desired.y });
	}

	function commitDrag(): void {
		if (!dragId || !gridEl) {
			dragId = null;
			return;
		}

		const app = apps.find((a) => a.id === dragId);
		if (!app?.gridPosition) {
			dragId = null;
			return;
		}

		const gridWidth = gridEl.clientWidth;
		if (gridWidth === 0) {
			dragId = null;
			return;
		}
		const cellWidth = gridWidth / GRID_COLS;
		const dx = dragOffsetX / cellWidth;
		const dy = dragOffsetY / ROW_HEIGHT;

		if (Math.abs(dx) < 0.15 && Math.abs(dy) < 0.15) {
			dragId = null;
			return;
		}

		// Free placement with collision avoidance — land where dropped unless overlapping
		const desired: GridPosition = {
			x: Math.max(0, Math.min(GRID_COLS - app.gridPosition.w, app.gridPosition.x + dx)),
			y: Math.max(0, app.gridPosition.y + dy),
			w: app.gridPosition.w,
			h: app.gridPosition.h,
		};
		const resolved = findFreePosition(desired, app.id);
		updateGridPosition(app.id, resolved);
		dragId = null;
		dragOffsetX = 0;
		dragOffsetY = 0;
	}

	async function handleRemove(id: string): Promise<void> {
		await moveToTray(id);
	}

	function handleGridDragOver(e: DragEvent): void {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
	}

	function handleGridDrop(e: DragEvent): void {
		e.preventDefault();
		const appId = e.dataTransfer?.getData("text/plain");
		if (!appId || !gridEl) return;

		const rect = gridEl.getBoundingClientRect();
		if (rect.width === 0) return;
		const cellWidth = rect.width / GRID_COLS;
		const rawX = Math.max(0, Math.min(GRID_COLS - 1, Math.floor((e.clientX - rect.left) / cellWidth)));
		const rawY = Math.max(0, Math.floor((e.clientY - rect.top) / ROW_HEIGHT));

		const size = resolveDefaultSize ? resolveDefaultSize(appId) : { w: 4, h: 3 };
		const desired: GridPosition = { x: rawX, y: rawY, ...size };
		const resolved = findFreePosition(desired, appId);

		ongriddrop(appId, resolved.x, resolved.y);
	}
</script>

<div
	class="widget-grid"
	class:has-focus={os.focusedId !== null}
	ondragover={handleGridDragOver}
	ondrop={handleGridDrop}
	role="grid"
>
	<div class="grid-inner" bind:this={gridEl} style="height: {maxRow * ROW_HEIGHT}px;">
	{#if apps.length === 0}
		<div class="grid-empty">
			<span class="sig-label">Drag apps from the tray below to place them here</span>
		</div>
	{/if}

	{#each apps as app (app.id)}
		{@const isDragging = dragId === app.id}
		<div
			class="grid-item"
			class:grid-item--dragging={isDragging}
			style="{getStyle(app.gridPosition)}{isDragging ? ` transform: translate(${dragOffsetX}px, ${dragOffsetY}px);` : ''}"
		>
			<WidgetCard
				{app}
				onremove={handleRemove}
				ondragstart={handleDragStart}
			/>
		</div>
	{/each}

	</div>

	{#if focusedApp}
		<div
			class="widget-focus-backdrop"
			onclick={collapseWidget}
			onkeydown={(e) => e.key === "Escape" && collapseWidget()}
			role="dialog"
			aria-modal="true"
			tabindex="-1"
		>
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div class="widget-focus-panel" onclick={(e) => e.stopPropagation()}>
				<WidgetCard
					app={focusedApp}
					onremove={() => collapseWidget()}
					ondragstart={() => {}}
				/>
			</div>
		</div>
	{/if}
</div>

<style>
	.widget-grid {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
	}

	.grid-inner {
		position: relative;
		min-height: 100%;
	}

	.grid-empty {
		position: absolute;
		inset: var(--space-md);
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius);
	}

	.grid-item {
		position: absolute;
		z-index: 1;
		transition: box-shadow 0.15s ease;
		border-radius: var(--radius);
		overflow: hidden;
		padding: 4px;
	}

	.grid-item--dragging {
		z-index: 100;
		opacity: 0.85;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		pointer-events: none;
	}

	.widget-grid.has-focus .grid-item {
		opacity: 0.15;
		pointer-events: none;
	}

	.widget-focus-backdrop {
		position: fixed;
		inset: 0;
		z-index: 200;
		background: rgba(0, 0, 0, 0.8);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 32px;
	}

	.widget-focus-panel {
		width: 100%;
		max-width: 900px;
		height: 80vh;
		border-radius: 12px;
		overflow: hidden;
	}

	@media (max-width: 768px) {
		.widget-focus-panel {
			max-width: 100%;
			height: 70vh;
		}
	}
</style>
