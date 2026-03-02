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
import TaskBoard from "$lib/components/tasks/TaskBoard.svelte";
import TaskForm from "$lib/components/tasks/TaskForm.svelte";
import TaskDetail from "$lib/components/tasks/TaskDetail.svelte";


function handleGlobalKey(e: KeyboardEvent) {
	const target = e.target as HTMLElement;
	const isInput =
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.isContentEditable;

	// Escape: Close modals
	if (e.key === "Escape") {
		if (ts.formOpen) {
			e.preventDefault();
			closeForm();
			return;
		}
		if (ts.detailOpen) {
			e.preventDefault();
			closeDetail();
			return;
		}
	}

	// Don't process other shortcuts when typing in inputs or form is open
	if (isInput || ts.formOpen) return;

	// N: Create new task
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
			onopendetail={openDetail}
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
