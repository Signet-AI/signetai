<script lang="ts">
import { onMount } from "svelte";
import {
	ts,
	fetchTasks,
	openDetail,
	closeDetail,
	openForm,
	closeForm,
	doDelete,
	doTrigger,
	doUpdate,
} from "$lib/stores/tasks.svelte";
import { returnToSidebar, setFocusZone } from "$lib/stores/focus.svelte";
import { nav } from "$lib/stores/navigation.svelte";
import TaskBoard from "$lib/components/tasks/TaskBoard.svelte";
import TaskForm from "$lib/components/tasks/TaskForm.svelte";
import TaskDetail from "$lib/components/tasks/TaskDetail.svelte";
import Plus from "@lucide/svelte/icons/plus";

// Track position as [columnIndex, taskIndex]
let selectedColumn = $state(0);
let selectedTaskInColumn = $state(0);

// Column order matches TaskBoard columns
const columnKeys = ["scheduled", "running", "completed", "failed"] as const;

// Get tasks for a specific column
function getColumnTasks(columnKey: string) {
	switch (columnKey) {
		case "scheduled":
			return ts.tasks.filter(t => t.enabled && t.last_run_status !== "running");
		case "running":
			return ts.tasks.filter(t => t.last_run_status === "running");
		case "completed":
			return ts.tasks.filter(t => t.last_run_status === "completed");
		case "failed":
			return ts.tasks.filter(t => t.last_run_status === "failed");
		default:
			return [];
	}
}

// Find the first column with tasks
function findFirstColumnWithTasks(): number {
	for (let i = 0; i < columnKeys.length; i++) {
		if (getColumnTasks(columnKeys[i]).length > 0) {
			return i;
		}
	}
	return 0;
}

// Set focus zone when entering tasks tab (but don't auto-select)
$effect(() => {
	if (nav.activeTab === 'tasks') {
		setFocusZone("page-content");
	}
});

function handleGlobalKey(e: KeyboardEvent) {
	// Only handle events when Tasks tab is active
	if (nav.activeTab !== "tasks") return;

	if (e.defaultPrevented) return;

	const target = e.target as HTMLElement;
	const isInput =
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.isContentEditable;

	// Escape: Close modals first, then return to sidebar
	if (e.key === "Escape") {
		if (ts.formOpen) {
			e.preventDefault();
			closeForm();
			return;
		}
		if (ts.detailOpen) {
			e.preventDefault();
			closeDetail();
			// Refocus the task card after closing detail
			setTimeout(() => focusTaskCard(selectedColumn, selectedTaskInColumn), 50);
			return;
		}
		// No modal open, return to sidebar
		e.preventDefault();
		returnToSidebar();
		return;
	}

	// Don't process other shortcuts when typing in inputs or form is open
	if (isInput || ts.formOpen) return;

	// Arrow navigation between columns and tasks (only when detail is closed and board is focused)
	const isBoardFocused = document.activeElement?.classList.contains('task-card') ||
		document.activeElement?.closest('[data-column-idx]') !== null;

	if (!ts.detailOpen) {
		if (e.key === "ArrowLeft" && isBoardFocused) {
			e.preventDefault();
			if (selectedColumn === 0) {
				returnToSidebar();
			} else if (selectedColumn > 0) {
				let newCol = selectedColumn - 1;
				while (newCol > 0 && getColumnTasks(columnKeys[newCol]).length === 0) {
					newCol--;
				}
				const prevColTasks = getColumnTasks(columnKeys[newCol]);
				if (prevColTasks.length > 0) {
					selectedColumn = newCol;
					selectedTaskInColumn = Math.min(selectedTaskInColumn, prevColTasks.length - 1);
					focusTaskCard(selectedColumn, selectedTaskInColumn);
				} else {
					returnToSidebar();
				}
			}
			return;
		}

		if (e.key === "ArrowRight") {
			e.preventDefault();
			const currentFocus = document.activeElement;
			const isTaskFocused = currentFocus?.classList.contains('task-card');

			if (!isTaskFocused && ts.tasks.length > 0) {
				selectedColumn = findFirstColumnWithTasks();
				const colTasks = getColumnTasks(columnKeys[selectedColumn]);
				if (colTasks.length > 0) {
					selectedTaskInColumn = 0;
					focusTaskCard(selectedColumn, selectedTaskInColumn);
				}
			} else if (selectedColumn < columnKeys.length - 1) {
				let newCol = selectedColumn + 1;
				while (newCol < columnKeys.length - 1 && getColumnTasks(columnKeys[newCol]).length === 0) {
					newCol++;
				}
				const nextColTasks = getColumnTasks(columnKeys[newCol]);
				if (nextColTasks.length > 0) {
					selectedColumn = newCol;
					selectedTaskInColumn = Math.min(selectedTaskInColumn, nextColTasks.length - 1);
					focusTaskCard(selectedColumn, selectedTaskInColumn);
				}
			}
			return;
		}

		if (e.key === "ArrowUp" && isBoardFocused) {
			e.preventDefault();
			if (selectedTaskInColumn > 0) {
				selectedTaskInColumn--;
				focusTaskCard(selectedColumn, selectedTaskInColumn);
			}
			return;
		}

		if (e.key === "ArrowDown" && isBoardFocused) {
			e.preventDefault();
			const colTasks = getColumnTasks(columnKeys[selectedColumn]);
			if (selectedTaskInColumn < colTasks.length - 1) {
				selectedTaskInColumn++;
				focusTaskCard(selectedColumn, selectedTaskInColumn);
			}
			return;
		}
	}

	// Enter to view task detail (only when board is focused)
	if (e.key === "Enter" && !ts.detailOpen && isBoardFocused) {
		const colTasks = getColumnTasks(columnKeys[selectedColumn]);
		const task = colTasks[selectedTaskInColumn];
		if (task) {
			e.preventDefault();
			openDetail(task.id);
		}
		return;
	}

	// N: Create new task (works even when detail is open)
	if (e.key === "n" || e.key === "N") {
		e.preventDefault();
		openForm();
		return;
	}

	// R/D require a selected task (detail panel must be open)
	if (ts.detailOpen && ts.selectedId) {
		if (e.key === "r" || e.key === "R") {
			e.preventDefault();
			doTrigger(ts.selectedId);
			return;
		}

		if (e.key === "d" || e.key === "D") {
			e.preventDefault();
			doDelete(ts.selectedId);
			return;
		}
	}
}

function focusTaskCard(columnIndex: number, taskIndex: number): void {
	const columns = document.querySelectorAll('[data-column-idx]');
	const column = columns[columnIndex];
	if (!column) return;

	const cards = column.querySelectorAll('.task-card');
	if (cards[taskIndex] instanceof HTMLElement) {
		(cards[taskIndex] as HTMLElement).focus({ preventScroll: false });
		(cards[taskIndex] as HTMLElement).scrollIntoView({ behavior: "smooth", block: "nearest" });
	}
}

// Auto-refresh every 15s while tab is visible
let refreshTimer: ReturnType<typeof setInterval> | null = null;

onMount(() => {
	fetchTasks();
	refreshTimer = setInterval(fetchTasks, 15_000);
	return () => {
		if (refreshTimer) clearInterval(refreshTimer);
	};
});

const taskCount = $derived(ts.tasks.length);
</script>

<svelte:window onkeydown={handleGlobalKey} />

<div class="flex flex-col flex-1 min-h-0 overflow-hidden">
	<!-- Inline header -->
	<div class="tab-header">
		<div class="tab-header-left">
			<span class="tab-header-title">SCHEDULER</span>
			<span class="tab-header-count">{taskCount} TASKS</span>
		</div>
		<button class="new-task-btn" onclick={() => openForm()}>
			<Plus class="size-3" />
			<span>NEW TASK</span>
		</button>
	</div>

	<!-- Board -->
	<div class="flex flex-col flex-1 min-h-0 overflow-auto">
		<TaskBoard
			tasks={ts.tasks}
			loading={ts.loading}
			selectedColumn={selectedColumn}
			selectedTaskInColumn={selectedTaskInColumn}
			onopendetail={(id, colIdx, taskIdx) => {
				selectedColumn = colIdx;
				selectedTaskInColumn = taskIdx;
				openDetail(id);
			}}
			ontrigger={doTrigger}
			ontoggle={(id, enabled) => doUpdate(id, { enabled })}
		/>
	</div>

	<!-- Keyboard hints -->
	<div class="shortcut-bar">
		{#if !ts.formOpen}
			<span class="shortcut"><kbd>N</kbd> NEW</span>
		{/if}
		{#if ts.detailOpen}
			<span class="shortcut"><kbd>R</kbd> RUN</span>
			<span class="shortcut"><kbd>D</kbd> DELETE</span>
			<span class="shortcut"><kbd>ESC</kbd> CLOSE</span>
		{:else if ts.formOpen}
			<span class="shortcut"><kbd>ESC</kbd> CANCEL</span>
		{/if}
	</div>
</div>

<!-- Sheets -->
<TaskForm
	open={ts.formOpen}
	editingId={ts.editingId}
	tasks={ts.tasks}
	presets={ts.presets}
	onclose={closeForm}
/>

<TaskDetail
	open={ts.detailOpen}
	task={ts.detailTask}
	runs={ts.detailRuns}
	loading={ts.detailLoading}
	liveConnected={ts.detailStreamConnected}
	onclose={closeDetail}
	ontrigger={doTrigger}
	ondelete={doDelete}
	onedit={(id) => {
		closeDetail();
		openForm(id);
	}}
/>

<style>
	.tab-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
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
	}

	.new-task-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 3px 10px;
		background: transparent;
		border: 1px solid var(--sig-border-strong);
		border-radius: var(--radius);
		color: var(--sig-text-muted);
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.06em;
		cursor: pointer;
		transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
	}

	.new-task-btn:hover {
		color: var(--sig-highlight);
		border-color: var(--sig-highlight);
	}

	.shortcut-bar {
		display: flex;
		align-items: center;
		gap: 12px;
		height: 22px;
		padding: 0 12px;
		border-top: 1px solid var(--sig-border);
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
	}

	.shortcut {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.shortcut kbd {
		font-family: var(--font-mono);
		font-size: 8px;
		padding: 0 3px;
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border);
		border-radius: 2px;
		color: var(--sig-text-muted);
	}

	@media (max-width: 1023px) {
		:global(:has(.mobile-sidebar-trigger)) .tab-header {
			padding-left: 6.5rem;
		}
	}
</style>
