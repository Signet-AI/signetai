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
	{ key: "scheduled", label: "Scheduled", color: "var(--sig-highlight)" },
	{ key: "running", label: "Running", color: "var(--sig-warning)" },
	{ key: "completed", label: "Completed", color: "var(--sig-success)" },
	{ key: "failed", label: "Failed", color: "var(--sig-danger)" },
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
	<div class="empty-state">LOADING</div>
{:else if tasks.length === 0}
	<div class="empty-state">
		<span>NO SCHEDULED TASKS</span>
		<span class="empty-hint">PRESS N TO CREATE ONE</span>
	</div>
{:else}
	<div class="board-grid">
		{#each columns as col, colIndex (col.key)}
			{@const colTasks = getColumnTasks(col.key)}
			<div class="column" data-column-idx={colIndex}>
				<div class="column-header">
					<span
						class="column-pip"
						style="background: {col.color}"
					></span>
					<span class="column-label">{col.label}</span>
					<span class="column-count">{colTasks.length}</span>
				</div>
				<div class="column-body">
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
						<div class="column-empty">NO TASKS</div>
					{/if}
				</div>
			</div>
		{/each}
	</div>

	{#if disabled.length > 0}
		<div class="disabled-section">
			<div class="column">
				<div class="column-header">
					<span class="column-pip" style="background: var(--sig-text-muted)"></span>
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
		grid-template-columns: repeat(4, 1fr);
		gap: var(--space-sm);
		padding: var(--space-sm);
		min-height: 0;
		align-items: start;
	}

	@media (max-width: 900px) {
		.board-grid {
			grid-template-columns: repeat(2, 1fr);
		}
	}

	@media (max-width: 480px) {
		.board-grid {
			grid-template-columns: 1fr;
		}
	}

	.column {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--sig-border);
		border-radius: var(--radius);
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

	.column-pip {
		display: inline-block;
		width: 4px;
		height: 4px;
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
		font-size: 9px;
		color: var(--sig-text-muted);
		margin-left: auto;
		font-variant-numeric: tabular-nums;
	}

	.column-body {
		display: flex;
		flex-direction: column;
		gap: 1px;
		overflow-y: auto;
		max-height: 60vh;
	}

	.column-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 80px;
		padding: var(--space-sm) var(--space-md);
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
		opacity: 0.4;
	}

	.disabled-section {
		padding: 0 var(--space-sm) var(--space-sm);
	}

	.disabled-cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 1px;
		padding: 0;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 4px;
		height: 100%;
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}

	.empty-hint {
		font-size: 8px;
		opacity: 0.5;
	}
</style>
