<script lang="ts">
import type { ScheduledTask, TaskRun } from "$lib/api";
import * as Sheet from "$lib/components/ui/sheet/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";
import * as ScrollArea from "$lib/components/ui/scroll-area/index.js";
import RunLog from "./RunLog.svelte";
import Play from "@lucide/svelte/icons/play";
import Pencil from "@lucide/svelte/icons/pencil";
import Trash2 from "@lucide/svelte/icons/trash-2";

interface Props {
	open: boolean;
	task: ScheduledTask | null;
	runs: TaskRun[];
	loading: boolean;
	liveConnected: boolean;
	onclose: () => void;
	ontrigger: (id: string) => void;
	ondelete: (id: string) => void;
	onedit: (id: string) => void;
}

let {
	open,
	task,
	runs,
	loading,
	liveConnected,
	onclose,
	ontrigger,
	ondelete,
	onedit,
}: Props =
	$props();

function formatDate(iso: string | null): string {
	if (!iso) return "—";
	return new Date(iso).toLocaleString();
}

let confirmingDelete = $state(false);

function handleDelete() {
	if (!task) return;
	if (!confirmingDelete) {
		confirmingDelete = true;
		setTimeout(() => { confirmingDelete = false; }, 3000);
		return;
	}
	ondelete(task.id);
	confirmingDelete = false;
}
</script>

<Sheet.Root {open} onOpenChange={(v) => { if (!v) onclose(); }}>
	<Sheet.Content
		class="bg-[var(--sig-surface)] border-[var(--sig-border)]
			text-[var(--sig-text)] w-[520px] sm:max-w-[520px]"
	>
		{#if loading}
			<div class="flex items-center justify-center h-32 text-[var(--sig-text-muted)] text-[12px]">
				Loading...
			</div>
		{:else if task}
			<Sheet.Header>
				<Sheet.Title class="text-[var(--sig-text-bright)] text-[14px]">
					{task.name}
				</Sheet.Title>
				<Sheet.Description class="text-[var(--sig-text-muted)] text-[11px]">
					{task.cron_expression} · {task.harness}
				</Sheet.Description>
			</Sheet.Header>

			<div class="flex flex-col gap-4 py-4">
				<!-- Task info -->
				<div class="flex flex-col gap-2">
					<div class="flex items-center gap-2">
						<Badge
							variant={task.enabled ? "default" : "outline"}
							class="text-[9px]"
						>
							{task.enabled ? "Enabled" : "Disabled"}
						</Badge>
						<Badge variant="outline" class="text-[9px]">
							{task.harness}
						</Badge>
					</div>

					<div class="text-[11px] text-[var(--sig-text)] leading-[1.6]
						bg-[var(--sig-surface-raised)] p-3 rounded
						border border-[var(--sig-border)]
						font-[family-name:var(--font-mono)]
						whitespace-pre-wrap">
						{task.prompt}
					</div>

					<div
						class="grid grid-cols-2 gap-2 text-[10px]
							text-[var(--sig-text-muted)]
							font-[family-name:var(--font-mono)]"
					>
						<div>
							<span class="text-[var(--sig-text-muted)]">Next run:</span>
							<span class="text-[var(--sig-text)]">
								{formatDate(task.next_run_at)}
							</span>
						</div>
						<div>
							<span class="text-[var(--sig-text-muted)]">Last run:</span>
							<span class="text-[var(--sig-text)]">
								{formatDate(task.last_run_at)}
							</span>
						</div>
						{#if task.working_directory}
							<div class="col-span-2">
								<span class="text-[var(--sig-text-muted)]">CWD:</span>
								<span class="text-[var(--sig-text)]">
									{task.working_directory}
								</span>
							</div>
						{/if}
						<div>
							<span class="text-[var(--sig-text-muted)]">Created:</span>
							<span class="text-[var(--sig-text)]">
								{formatDate(task.created_at)}
							</span>
						</div>
					</div>
				</div>

				<!-- Actions -->
				<div class="flex gap-2">
					<Button
						variant="outline"
						size="sm"
						class="h-7 gap-1.5 text-[11px]"
						onclick={() => task && ontrigger(task.id)}
					>
						<Play class="size-3" />
						Run Now
					</Button>
					<Button
						variant="outline"
						size="sm"
						class="h-7 gap-1.5 text-[11px]"
						onclick={() => task && onedit(task.id)}
					>
						<Pencil class="size-3" />
						Edit
					</Button>
					<Button
						variant={confirmingDelete ? "destructive" : "outline"}
						size="sm"
						class="h-7 gap-1.5 text-[11px] ml-auto"
						onclick={handleDelete}
					>
						<Trash2 class="size-3" />
						{confirmingDelete ? "Confirm Delete" : "Delete"}
					</Button>
				</div>

				<!-- Run history -->
				<div class="flex flex-col gap-2 min-h-0">
					<div class="flex items-center gap-2">
						<span
							class="text-[10px] font-bold uppercase tracking-[0.1em]
							text-[var(--sig-text-muted)]
							font-[family-name:var(--font-display)]"
						>
							Run History ({runs.length})
						</span>
						{#if liveConnected}
							<span
								class="text-[9px] text-[var(--sig-success)]
									font-[family-name:var(--font-mono)]"
							>
								Live
							</span>
						{/if}
					</div>

					{#if runs.length === 0}
						<span class="text-[11px] text-[var(--sig-text-muted)]">
							No runs yet
						</span>
					{:else}
						<ScrollArea.Root class="max-h-[400px]">
							<div class="flex flex-col gap-2 w-full">
								{#each runs as run (run.id)}
									<RunLog {run} />
								{/each}
							</div>
							<ScrollArea.Scrollbar orientation="vertical" />
						</ScrollArea.Root>
					{/if}
				</div>
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>
