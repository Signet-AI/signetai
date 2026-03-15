<script lang="ts">
	import type { AppTrayEntry } from "$lib/stores/os.svelte";
	import { moveToTray, moveToDock } from "$lib/stores/os.svelte";
	import AddMcpDialog from "./AddMcpDialog.svelte";
	import Box from "@lucide/svelte/icons/box";
	import Pin from "@lucide/svelte/icons/pin";
	import PinOff from "@lucide/svelte/icons/pin-off";
	import Plus from "@lucide/svelte/icons/plus";

	interface Props {
		trayApps: AppTrayEntry[];
		dockApps: AppTrayEntry[];
		ondragtoboard: (id: string) => void;
	}

	const { trayApps, dockApps, ondragtoboard }: Props = $props();

	let showAddDialog = $state(false);

	function handleDragStart(e: DragEvent, id: string): void {
		if (!e.dataTransfer) return;
		e.dataTransfer.setData("text/plain", id);
		e.dataTransfer.effectAllowed = "move";
	}

	async function toggleDock(app: AppTrayEntry): Promise<void> {
		if (app.state === "dock") {
			await moveToTray(app.id);
		} else {
			await moveToDock(app.id);
		}
	}

	const allApps = $derived([...dockApps, ...trayApps]);
</script>

<div class="app-dock">
	{#if allApps.length === 0}
		<div class="dock-empty">
			<button class="dock-add-btn" title="Add MCP Server" onclick={() => showAddDialog = true}>
				<Plus class="size-4" />
				<span class="dock-add-label">Add MCP Server</span>
			</button>
		</div>
	{:else}
		<div class="dock-items">
			{#each dockApps as app (app.id)}
				<div
					class="dock-item dock-item--pinned"
					title="{app.name} (pinned to dock)"
					draggable="true"
					ondragstart={(e) => handleDragStart(e, app.id)}
					role="listitem"
				>
					{#if app.icon}
						<img src={app.icon} alt={app.name} class="dock-icon" referrerpolicy="no-referrer" />
					{:else}
						<div class="dock-icon-placeholder">
							<Box class="size-4" />
						</div>
					{/if}
					<span class="dock-label">{app.name}</span>
					<button
						class="dock-pin-btn"
						title="Unpin from dock"
						onclick={(e) => { e.stopPropagation(); toggleDock(app); }}
					>
						<PinOff class="size-2.5" />
					</button>
				</div>
			{/each}

			{#if dockApps.length > 0 && trayApps.length > 0}
				<div class="dock-separator"></div>
			{/if}

			{#each trayApps as app (app.id)}
				<div
					class="dock-item"
					title="{app.name} — drag to grid to place"
					draggable="true"
					ondragstart={(e) => handleDragStart(e, app.id)}
					role="listitem"
				>
					{#if app.icon}
						<img src={app.icon} alt={app.name} class="dock-icon" referrerpolicy="no-referrer" />
					{:else}
						<div class="dock-icon-placeholder">
							<Box class="size-4" />
						</div>
					{/if}
					<span class="dock-label">{app.name}</span>
					<button
						class="dock-pin-btn"
						title="Pin to dock"
						onclick={(e) => { e.stopPropagation(); toggleDock(app); }}
					>
						<Pin class="size-2.5" />
					</button>
				</div>
			{/each}
			<div class="dock-separator"></div>
			<button
				class="dock-item dock-item--add"
				title="Add MCP Server"
				onclick={() => showAddDialog = true}
			>
				<div class="dock-icon-placeholder dock-icon-add">
					<Plus class="size-4" />
				</div>
				<span class="dock-label">Add New</span>
			</button>
		</div>
	{/if}
</div>

<AddMcpDialog open={showAddDialog} onclose={() => showAddDialog = false} />

<style>
	.app-dock {
		border-top: 1px solid var(--sig-border-strong);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
		background: var(--sig-surface);
		padding: 6px var(--space-md);
		min-height: 52px;
		display: flex;
		align-items: center;
	}

	.dock-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		padding: 4px;
	}

	.dock-items {
		display: flex;
		gap: 4px;
		align-items: center;
		overflow-x: auto;
		flex: 1;
	}

	.dock-item {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 4px 8px;
		border-radius: 6px;
		border: 1px solid transparent;
		background: transparent;
		cursor: grab;
		position: relative;
		min-width: 56px;
		transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease);
	}

	.dock-item:hover {
		background: var(--sig-surface-raised);
		border-color: var(--sig-border);
	}

	.dock-item:active {
		cursor: grabbing;
	}

	.dock-item--pinned {
		border-color: var(--sig-highlight-dim);
	}

	.dock-icon {
		width: 24px;
		height: 24px;
		border-radius: 4px;
		object-fit: cover;
	}

	.dock-icon-placeholder {
		width: 24px;
		height: 24px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		background: var(--sig-surface-raised);
		color: var(--sig-text-muted);
	}

	.dock-label {
		font-family: var(--font-mono);
		font-size: 8px;
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		max-width: 56px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.dock-pin-btn {
		position: absolute;
		top: -2px;
		right: -2px;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: none;
		background: var(--sig-surface-raised);
		color: var(--sig-text-muted);
		display: none;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		padding: 0;
	}

	.dock-item:hover .dock-pin-btn {
		display: flex;
	}

	.dock-pin-btn:hover {
		color: var(--sig-highlight-text);
		background: var(--sig-highlight-muted);
	}

	.dock-separator {
		width: 1px;
		height: 28px;
		background: var(--sig-border-strong);
		margin: 0 4px;
		flex-shrink: 0;
	}

	.dock-item--add {
		cursor: pointer;
		border: 1px dashed var(--sig-border);
		opacity: 0.7;
		transition: opacity var(--dur) var(--ease), border-color var(--dur) var(--ease);
	}

	.dock-item--add:hover {
		opacity: 1;
		border-color: var(--sig-highlight-dim);
		background: var(--sig-surface-raised);
	}

	.dock-icon-add {
		background: transparent;
		border: 1px dashed var(--sig-border);
		color: var(--sig-highlight-dim);
	}

	.dock-item--add:hover .dock-icon-add {
		border-color: var(--sig-highlight-dim);
		color: var(--sig-highlight-text);
	}

	.dock-add-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 14px;
		border: 1px dashed var(--sig-border);
		border-radius: 6px;
		background: transparent;
		color: var(--sig-text-muted);
		cursor: pointer;
		font-family: var(--font-mono);
		font-size: 11px;
		transition: all var(--dur) var(--ease);
	}

	.dock-add-btn:hover {
		border-color: var(--sig-highlight-dim);
		color: var(--sig-highlight-text);
		background: var(--sig-surface-raised);
	}

	.dock-add-label {
		font-family: var(--font-mono);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
</style>
