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
import { Button } from "$lib/components/ui/button/index.js";
import Plus from "@lucide/svelte/icons/plus";

function handleGlobalKey(e: KeyboardEvent) {
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
	<!-- Hero header -->
	<div
		class="shrink-0 px-[var(--space-md)] pt-[var(--space-md)]
			pb-[var(--space-sm)] flex items-start gap-6
			border-b border-[var(--sig-border)]"
	>
		<div class="flex flex-col gap-1 shrink-0">
			<h1 class="absolute hidden">Tasks</h1>
			<div class="relative max-w-[260px] overflow-hidden">
				<pre
					class="tasks-ascii m-0 text-[var(--sig-text-muted)]
						select-none whitespace-pre"
					aria-hidden="true"
				>████████╗ █████╗ ███████╗██╗  ██╗███████╗
╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝██╔════╝
   ██║   ███████║███████╗█████╔╝ ███████╗
   ██║   ██╔══██║╚════██║██╔═██╗ ╚════██║
   ██║   ██║  ██║███████║██║  ██╗███████║
   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝</pre>
				<pre
					class="tasks-ascii absolute top-0 left-0 m-0
						text-[var(--sig-text-bright)] select-none whitespace-pre"
					aria-label="TASKS"
				>████████  █████  ███████ ██   ██ ███████
   ██    ██   ██ ██      ██  ██  ██
   ██    ███████ ███████ █████   ███████
   ██    ██   ██      ██ ██  ██       ██
   ██    ██   ██ ███████ ██   ██ ███████
{' '}</pre>
			</div>
			<span
				class="font-[family-name:var(--font-mono)] text-[10px]
					font-medium text-[var(--sig-text)]
					uppercase tracking-[0.12em]"
			>
				Scheduled agent prompts
			</span>
		</div>
		<div class="flex flex-col gap-2 pt-[2px]">
			<p
				class="text-[12px] text-[var(--sig-text)] leading-[1.5] m-0
					max-w-[460px]"
			>
				Schedule recurring prompts to run automatically via Claude Code or
				OpenCode. The daemon evaluates cron expressions and spawns CLI
				processes on schedule.
			</p>
			<div class="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					class="h-7 gap-1.5 text-[11px]"
					onclick={() => openForm()}
				>
					<Plus class="size-3.5" />
					New Task
				</Button>
			</div>
		</div>
	</div>

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
	onedit={(id) => openForm(id)}
/>

<style>
	.tasks-ascii {
		font-size: 8px;
		line-height: 1.15;
		font-family: var(--font-mono);
		letter-spacing: -0.04em;
	}
</style>
