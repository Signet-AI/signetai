<script lang="ts">
import type { ScheduledTask } from "$lib/api";
import TaskCard from "./TaskCard.svelte";

interface Props {
	tasks: ScheduledTask[];
	loading: boolean;
	onopendetail: (id: string) => void;
	ontrigger: (id: string) => void;
	ontoggle: (id: string, enabled: boolean) => void;
}

let { tasks, loading, onopendetail, ontrigger, ontoggle }: Props = $props();

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
	<div class="grid grid-cols-4 gap-3 p-[var(--space-md)] h-full min-h-0">
		{#each columns as col (col.key)}
			{@const colTasks = getColumnTasks(col.key)}
			<div class="flex flex-col gap-2 min-h-0">
				<div class="flex items-center gap-2 shrink-0 px-1">
					<span
						class="inline-block w-2 h-2 shrink-0"
						style="background: {col.color}"
					></span>
					<span
						class="text-[10px] font-bold uppercase tracking-[0.1em]
							text-[var(--sig-text-muted)]
							font-[family-name:var(--font-display)]"
					>
						{col.label}
					</span>
					<span
						class="text-[10px] text-[var(--sig-text-muted)]
							font-[family-name:var(--font-mono)]"
					>
						{colTasks.length}
					</span>
				</div>
				<div class="flex flex-col gap-2 overflow-y-auto min-h-0 flex-1">
					{#each colTasks as task (task.id)}
						<TaskCard
							{task}
							columnKey={col.key}
							onclick={() => onopendetail(task.id)}
							ontrigger={() => ontrigger(task.id)}
							ontoggle={(enabled) => ontoggle(task.id, enabled)}
						/>
					{/each}
				</div>
			</div>
		{/each}
	</div>

	{#if disabled.length > 0}
		<div class="px-[var(--space-md)] pb-[var(--space-md)]">
			<div class="flex items-center gap-2 px-1 mb-2">
				<span
					class="text-[10px] font-bold uppercase tracking-[0.1em]
						text-[var(--sig-text-muted)]
						font-[family-name:var(--font-display)]"
				>
					Disabled
				</span>
				<span
					class="text-[10px] text-[var(--sig-text-muted)]
						font-[family-name:var(--font-mono)]"
				>
					{disabled.length}
				</span>
			</div>
			<div class="flex gap-2 flex-wrap">
				{#each disabled as task (task.id)}
					<TaskCard
						{task}
						columnKey="disabled"
						onclick={() => onopendetail(task.id)}
						ontrigger={() => ontrigger(task.id)}
						ontoggle={(enabled) => ontoggle(task.id, enabled)}
					/>
				{/each}
			</div>
		</div>
	{/if}
{/if}
