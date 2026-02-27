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
import PageHero from "$lib/components/layout/PageHero.svelte";
import { PAGE_HEADERS } from "$lib/components/layout/page-headers";
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
	<PageHero
		title={PAGE_HEADERS.tasks.title}
		wordmarkLines={PAGE_HEADERS.tasks.wordmarkLines}
		eyebrow={PAGE_HEADERS.tasks.eyebrow}
		description={PAGE_HEADERS.tasks.description}
	>
		{#snippet actions()}
			<Button
				variant="outline"
				size="sm"
				class="h-7 gap-1.5 text-[11px]"
				onclick={() => openForm()}
			>
				<Plus class="size-3.5" />
				New Task
			</Button>
		{/snippet}
	</PageHero>

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
	onedit={(id) => {
		closeDetail();
		openForm(id);
	}}
/>
