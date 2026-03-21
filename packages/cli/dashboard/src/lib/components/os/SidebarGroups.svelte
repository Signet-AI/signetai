<script lang="ts">
	import {
		os,
		createGroup,
		deleteGroup,
		renameGroup,
		setActiveGroup,
		addToGroup,
		type SidebarGroup,
	} from "$lib/stores/os.svelte";
	import Folder from "@lucide/svelte/icons/folder";
	import FolderOpen from "@lucide/svelte/icons/folder-open";
	import Plus from "@lucide/svelte/icons/plus";
	import Trash2 from "@lucide/svelte/icons/trash-2";
	import LayoutGrid from "@lucide/svelte/icons/layout-grid";

	let newGroupName = $state("");
	let showNewInput = $state(false);
	let editingId = $state<string | null>(null);
	let editingName = $state("");

	function handleCreateGroup(): void {
		const name = newGroupName.trim();
		if (!name) return;
		createGroup(name);
		newGroupName = "";
		showNewInput = false;
	}

	function startRename(group: SidebarGroup): void {
		editingId = group.id;
		editingName = group.name;
	}

	function commitRename(): void {
		if (editingId && editingName.trim()) {
			renameGroup(editingId, editingName.trim());
		}
		editingId = null;
		editingName = "";
	}

	function handleGroupDragOver(e: DragEvent): void {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
	}

	function handleGroupDrop(e: DragEvent, groupId: string): void {
		e.preventDefault();
		const appId = e.dataTransfer?.getData("text/plain");
		if (appId) {
			addToGroup(groupId, appId);
		}
	}
</script>

<div class="sidebar-groups">
	<div class="groups-header">
		<span class="sig-eyebrow">Groups</span>
		<button
			class="group-add-btn"
			title="New group"
			onclick={() => { showNewInput = !showNewInput; }}
		>
			<Plus class="size-3" />
		</button>
	</div>

	<!-- All apps (no filter) -->
	<button
		class="group-item"
		class:group-item--active={os.activeGroup === null}
		onclick={() => setActiveGroup(null)}
	>
		<LayoutGrid class="size-3.5" />
		<span>All Apps</span>
	</button>

	<!-- User groups -->
	{#each os.groups as group (group.id)}
		<div
			class="group-item"
			class:group-item--active={os.activeGroup === group.id}
			onclick={() => setActiveGroup(group.id)}
			ondragover={handleGroupDragOver}
			ondrop={(e) => handleGroupDrop(e, group.id)}
			role="button"
			tabindex="0"
			onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") setActiveGroup(group.id); }}
		>
			{#if os.activeGroup === group.id}
				<FolderOpen class="size-3.5" />
			{:else}
				<Folder class="size-3.5" />
			{/if}

			{#if editingId === group.id}
				<input
					class="group-rename-input"
					type="text"
					bind:value={editingName}
					onblur={commitRename}
					onkeydown={(e) => {
						if (e.key === "Enter") commitRename();
						if (e.key === "Escape") { editingId = null; }
					}}
				/>
			{:else}
				<span
					class="flex-1 truncate"
					ondblclick={() => startRename(group)}
				>{group.name}</span>
			{/if}

			<span class="sig-meta">{group.items.length}</span>

			<button
				class="group-delete-btn"
				title="Delete group"
				onclick={(e) => { e.stopPropagation(); deleteGroup(group.id); }}
			>
				<Trash2 class="size-2.5" />
			</button>
		</div>
	{/each}

	<!-- New group input -->
	{#if showNewInput}
		<div class="group-new-input-wrap">
			<input
				class="group-new-input"
				type="text"
				placeholder="Group name…"
				bind:value={newGroupName}
				onkeydown={(e) => {
					if (e.key === "Enter") handleCreateGroup();
					if (e.key === "Escape") { showNewInput = false; }
				}}
			/>
		</div>
	{/if}
</div>

<style>
	.sidebar-groups {
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 0 var(--space-sm);
	}

	.groups-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 4px 4px;
	}

	.group-add-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border-radius: 3px;
		border: none;
		background: transparent;
		color: var(--sig-text-muted);
		cursor: pointer;
		padding: 0;
	}

	.group-add-btn:hover {
		color: var(--sig-highlight-text);
		background: var(--sig-highlight-muted);
	}

	.group-item {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		border-radius: 4px;
		border: none;
		background: transparent;
		color: var(--sig-text);
		font-family: var(--font-mono);
		font-size: 11px;
		cursor: pointer;
		text-align: left;
		width: 100%;
		transition: background var(--dur) var(--ease);
	}

	.group-item:hover {
		background: rgba(255, 255, 255, 0.04);
	}

	.group-item--active {
		background: var(--sig-surface-raised);
		color: var(--sig-text-bright);
	}

	.group-delete-btn {
		display: none;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		border-radius: 3px;
		border: none;
		background: transparent;
		color: var(--sig-text-muted);
		cursor: pointer;
		padding: 0;
	}

	.group-item:hover .group-delete-btn {
		display: flex;
	}

	.group-delete-btn:hover {
		color: var(--sig-danger);
	}

	.group-rename-input {
		background: var(--sig-bg);
		border: 1px solid var(--sig-border-strong);
		border-radius: 3px;
		padding: 1px 4px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-bright);
		flex: 1;
		outline: none;
	}

	.group-new-input-wrap {
		padding: 2px 4px;
	}

	.group-new-input {
		width: 100%;
		background: var(--sig-bg);
		border: 1px solid var(--sig-border-strong);
		border-radius: 4px;
		padding: 3px 8px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-bright);
		outline: none;
	}

	.group-new-input:focus {
		border-color: var(--sig-highlight);
	}

	:root[data-theme="light"] .group-item:hover {
		background: rgba(0, 0, 0, 0.04);
	}

	:root[data-theme="light"] .group-item--active {
		background: rgba(0, 0, 0, 0.06);
	}

	@media (max-width: 768px) {
		.sidebar-groups {
			flex-direction: row;
			flex-wrap: wrap;
			gap: 4px;
		}

		.groups-header {
			padding: 0 4px;
			min-width: fit-content;
		}

		.group-item {
			width: auto;
			white-space: nowrap;
			padding: 4px 10px;
		}

		.group-new-input-wrap {
			padding: 0 4px;
		}

		.group-new-input {
			width: 120px;
		}
	}
</style>
