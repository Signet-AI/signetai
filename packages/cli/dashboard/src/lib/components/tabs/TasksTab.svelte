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
		document.activeElement?.closest('.tasks-board') !== null;

	if (!ts.detailOpen) {
		if (e.key === "ArrowLeft" && isBoardFocused) {
			e.preventDefault();
			if (selectedColumn === 0) {
				// At first column, return to sidebar
				returnToSidebar();
			} else if (selectedColumn > 0) {
				// Move to previous column (skip empty columns)
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
					// No non-empty column found to the left, return to sidebar
					returnToSidebar();
				}
			}
			return;
		}

		if (e.key === "ArrowRight") {
			e.preventDefault();
			// If coming from sidebar (no task focused yet), select first task
			const currentFocus = document.activeElement;
			const isTaskFocused = currentFocus?.classList.contains('task-card');

			if (!isTaskFocused && ts.tasks.length > 0) {
				// First arrow right from sidebar - focus first task
				selectedColumn = findFirstColumnWithTasks();
				selectedTaskInColumn = 0;
				focusTaskCard(selectedColumn, selectedTaskInColumn);
			} else if (selectedColumn < columnKeys.length - 1) {
				// Move to next column (skip empty columns)
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
		// R: Trigger/Run task
		if (e.key === "r" || e.key === "R") {
			e.preventDefault();
			doTrigger(ts.selectedId);
			return;
		}

		// D: Delete task
		if (e.key === "d" || e.key === "D") {
			e.preventDefault();
			doDelete(ts.selectedId);
			return;
		}
	}
}

function focusTaskCard(columnIndex: number, taskIndex: number): void {
	// Find the column container and get only the cards within that column
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
</script>

<svelte:window onkeydown={handleGlobalKey} />

<div class="h-full flex flex-col overflow-hidden">
	<!-- Board -->
	<div class="flex-1 min-h-0 overflow-auto">
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

	<!-- Keyboard shortcuts -->
	<div
		class="shrink-0 px-4 py-2 border-t border-[var(--sig-border)]
			flex items-center gap-4 text-[10px] text-[var(--sig-text-muted)]
			font-[family-name:var(--font-mono)]"
	>
		{#if !ts.formOpen}
			<span><kbd class="px-1 py-px bg-[var(--sig-surface-raised)] border border-[var(--sig-border)]">N</kbd> New</span>
		{/if}
		{#if ts.detailOpen}
			<span><kbd class="px-1 py-px bg-[var(--sig-surface-raised)] border border-[var(--sig-border)]">R</kbd> Run</span>
			<span><kbd class="px-1 py-px bg-[var(--sig-surface-raised)] border border-[var(--sig-border)]">D</kbd> Delete</span>
			<span><kbd class="px-1 py-px bg-[var(--sig-surface-raised)] border border-[var(--sig-border)]">Esc</kbd> Close</span>
		{:else if ts.formOpen}
			<span><kbd class="px-1 py-px bg-[var(--sig-surface-raised)] border border-[var(--sig-border)]">Esc</kbd> Cancel</span>
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
