<script lang="ts">
import type { ScheduledTask } from "$lib/api";
import TaskCard from "./TaskCard.svelte";

interface Props {
	tasks: ScheduledTask[];
	loading: boolean;
	selectedColumn?: number;
	selectedTaskInColumn?: number;
	onopendetail: (id: string, columnIndex: number, taskIndex: number) => void;
	ontrigger: (id: string) => void;
	ontoggle: (id: string, enabled: boolean) => void;
}

let { tasks, loading, selectedColumn = 0, selectedTaskInColumn = 0, onopendetail, ontrigger, ontoggle }: Props = $props();

// Derive columns from task + run state
let scheduled = $derived(
	tasks.filter((t) => t.enabled && t.last_run_status !== "running"),
);
let running = $derived(
	tasks.filter(
		(t) => t.last_run_status === "running",
	),
);

// For completed/failed, show recent tasks that had runs with that status
let completed = $derived(
	tasks.filter(
		(t) =>
			t.last_run_status === "completed" &&
			!running.some((r) => r.id === t.id),
	),
);
let failed = $derived(
	tasks.filter(
		(t) =>
			t.last_run_status === "failed" &&
			!running.some((r) => r.id === t.id),
	),
);
let disabled = $derived(tasks.filter((t) => !t.enabled));

const columns = [
	{ key: "scheduled", label: "Scheduled", color: "var(--sig-accent)" },
	{ key: "running", label: "Running", color: "var(--sig-warning, #f59e0b)" },
	{ key: "completed", label: "Completed", color: "var(--sig-success)" },
	{ key: "failed", label: "Failed", color: "var(--sig-error, #ef4444)" },
] as const;

function getColumnTasks(key: string): ScheduledTask[] {
	switch (key) {
		case "scheduled":
			return scheduled;
		case "running":
			return running;
		case "completed":
			return completed;
		case "failed":
			return failed;
		default:
			return [];
	}
}
</script>

{#if loading && tasks.length === 0}
	<div
		class="flex items-center justify-center h-full
			text-[var(--sig-text-muted)] text-[12px]"
	>
		Loading tasks...
	</div>
{:else if tasks.length === 0}
	<div
		class="flex flex-col items-center justify-center h-full gap-2
			text-[var(--sig-text-muted)]"
	>
		<span class="text-[13px]">No scheduled tasks yet</span>
		<span class="text-[11px]">
			Create one to start automating agent workflows
		</span>
	</div>
{:else}
	<div class="board-grid">
		{#each columns as col, colIndex (col.key)}
			{@const colTasks = getColumnTasks(col.key)}
			<div class="column-window" data-column-idx={colIndex}>
				<div class="column-header">
					<span
						class="column-dot"
						style="background: {col.color}"
					></span>
					<span class="column-label">{col.label}</span>
					<span class="column-count">{colTasks.length}</span>
				</div>
				<div class="column-cards">
					{#each colTasks as task, taskIndex (task.id)}
						<TaskCard
							{task}
							columnKey={col.key}
							isSelected={colIndex === selectedColumn && taskIndex === selectedTaskInColumn}
							onclick={() => onopendetail(task.id, colIndex, taskIndex)}
							ontrigger={() => ontrigger(task.id)}
							ontoggle={(enabled) => ontoggle(task.id, enabled)}
						/>
					{/each}
					{#if colTasks.length === 0}
						<div class="column-empty">No tasks</div>
					{/if}
				</div>
			</div>
		{/each}
	</div>

	{#if disabled.length > 0}
		<div class="disabled-section">
			<div class="column-window">
				<div class="column-header">
					<span class="column-dot" style="background: var(--sig-text-muted)"></span>
					<span class="column-label">Disabled</span>
					<span class="column-count">{disabled.length}</span>
				</div>
				<div class="disabled-cards">
					{#each disabled as task (task.id)}
						<TaskCard
							{task}
							columnKey="disabled"
							isSelected={false}
							onclick={() => onopendetail(task.id, -1, -1)}
							ontrigger={() => ontrigger(task.id)}
							ontoggle={(enabled) => ontoggle(task.id, enabled)}
						/>
					{/each}
				</div>
			</div>
		</div>
	{/if}
{/if}

<style>
	.board-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: var(--space-sm);
		padding: var(--space-md);
		min-height: 0;
		flex: 1;
	}

	.column-window {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border: 1px solid var(--sig-border-strong);
		border-radius: 8px;
		overflow: hidden;
		background: var(--sig-surface);
	}

	.column-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: var(--space-sm) var(--space-md);
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.column-dot {
		display: inline-block;
		width: 6px;
		height: 6px;
		flex-shrink: 0;
		border-radius: 50%;
	}

	.column-label {
		font-family: var(--font-display);
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}

	.column-count {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		margin-left: auto;
	}

	.column-cards {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		padding: var(--space-sm);
		overflow-y: auto;
		min-height: 0;
		flex: 1;
	}

	.column-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-lg) var(--space-md);
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		opacity: 0.5;
	}

	.disabled-section {
		padding: 0 var(--space-md) var(--space-md);
	}

	.disabled-cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: var(--space-sm);
		padding: var(--space-sm);
	}
</style>
