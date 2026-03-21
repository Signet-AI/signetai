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
	import { API_BASE } from "$lib/api";
	import TaskBoard from "$lib/components/tasks/TaskBoard.svelte";
	import TaskForm from "$lib/components/tasks/TaskForm.svelte";
	import TaskDetail from "$lib/components/tasks/TaskDetail.svelte";
	import Plus from "@lucide/svelte/icons/plus";
	import Zap from "@lucide/svelte/icons/zap";

	let selectedColumn = $state(0);
	let selectedTask = $state(0);
	let predictorActive = $state(false);

	const taskCount = $derived(ts.tasks.length);

	onMount(() => {
		fetchTasks();
		checkPredictor();
		const interval = setInterval(fetchTasks, 15_000);
		return () => clearInterval(interval);
	});

	async function checkPredictor(): Promise<void> {
		try {
			const res = await fetch(`${API_BASE}/api/predictor/status`);
			if (res.ok) {
				const data = await res.json();
				predictorActive = data.enabled === true;
			}
		} catch {
			predictorActive = false;
		}
	}
</script>

<div class="tasks-panel">
	<div class="tasks-header">
		<div class="tasks-header-left">
			<span class="tasks-title">SCHEDULER</span>
			<span class="tasks-count">{taskCount} TASKS</span>
			{#if predictorActive}
				<span class="predictor-badge">
					<Zap class="size-2.5" />
					PREDICTOR
				</span>
			{/if}
		</div>
		<button class="new-task-btn" onclick={() => openForm()}>
			<Plus class="size-3" />
			<span>NEW TASK</span>
		</button>
	</div>

	<div class="tasks-content">
		<TaskBoard
			tasks={ts.tasks}
			loading={ts.loading}
			{selectedColumn}
			selectedTaskInColumn={selectedTask}
			onopendetail={(id, col, task) => {
				selectedColumn = col;
				selectedTask = task;
				openDetail(id);
			}}
			ontrigger={doTrigger}
			ontoggle={(id, enabled) => doUpdate(id, { enabled })}
		/>
	</div>

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
	.tasks-panel {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.tasks-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-sm) var(--space-md);
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.tasks-header-left {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.tasks-title {
		font-family: var(--font-display);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-bright);
	}

	.tasks-count {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}

	.predictor-badge {
		display: flex;
		align-items: center;
		gap: 3px;
		font-family: var(--font-mono);
		font-size: 8px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sig-highlight-text);
		background: var(--sig-highlight-muted);
		border: 1px solid var(--sig-highlight-dim);
		padding: 1px 6px;
		border-radius: 4px;
		line-height: 1.4;
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

	.tasks-content {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: auto;
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
		.tasks-header {
			padding-left: var(--mobile-header-inset);
		}
	}
</style>
