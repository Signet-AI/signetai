/**
 * Shared tasks state for TasksTab and sub-components.
 * Follows the same $state pattern as skills.svelte.ts.
 */

import {
	getTasks,
	getTask,
	createTask,
	updateTask,
	deleteTask,
	triggerTaskRun,
	type ScheduledTask,
	type TaskRun,
	type CronPreset,
} from "$lib/api";
import { toast } from "$lib/stores/toast.svelte";

export const ts = $state({
	tasks: [] as ScheduledTask[],
	presets: [] as CronPreset[],
	loading: false,

	// Detail panel
	selectedId: null as string | null,
	detailOpen: false,
	detailTask: null as ScheduledTask | null,
	detailRuns: [] as TaskRun[],
	detailLoading: false,

	// Create/edit form
	formOpen: false,
	editingId: null as string | null,

	// Action states
	creating: false,
	deleting: null as string | null,
	triggering: null as string | null,
});

export async function fetchTasks(): Promise<void> {
	ts.loading = true;
	const data = await getTasks();
	ts.tasks = data.tasks;
	ts.presets = data.presets;
	ts.loading = false;
}

export async function openDetail(id: string): Promise<void> {
	ts.selectedId = id;
	ts.detailOpen = true;
	ts.detailLoading = true;
	ts.detailTask = null;
	ts.detailRuns = [];

	const data = await getTask(id);
	if (data) {
		ts.detailTask = data.task;
		ts.detailRuns = data.runs;
	}
	ts.detailLoading = false;
}

export function closeDetail(): void {
	ts.detailOpen = false;
	ts.selectedId = null;
	ts.detailTask = null;
	ts.detailRuns = [];
}

export function openForm(editId?: string): void {
	ts.formOpen = true;
	ts.editingId = editId ?? null;
}

export function closeForm(): void {
	ts.formOpen = false;
	ts.editingId = null;
}

export async function doCreate(data: {
	name: string;
	prompt: string;
	cronExpression: string;
	harness: string;
	workingDirectory?: string;
}): Promise<boolean> {
	ts.creating = true;
	const result = await createTask(data);
	ts.creating = false;

	if (result.id) {
		toast("Task created", "success");
		await fetchTasks();
		closeForm();
		return true;
	}
	toast(result.error ?? "Failed to create task", "error");
	return false;
}

export async function doUpdate(
	id: string,
	data: Partial<{
		name: string;
		prompt: string;
		cronExpression: string;
		harness: string;
		workingDirectory: string | null;
		enabled: boolean;
	}>,
): Promise<boolean> {
	const result = await updateTask(id, data);
	if (result.success) {
		await fetchTasks();
		return true;
	}
	toast(result.error ?? "Failed to update task", "error");
	return false;
}

export async function doDelete(id: string): Promise<void> {
	ts.deleting = id;
	const result = await deleteTask(id);
	if (result.success) {
		toast("Task deleted", "success");
		await fetchTasks();
		if (ts.selectedId === id) closeDetail();
	} else {
		toast(result.error ?? "Failed to delete task", "error");
	}
	ts.deleting = null;
}

export async function doTrigger(id: string): Promise<void> {
	ts.triggering = id;
	const result = await triggerTaskRun(id);
	if (result.runId) {
		toast("Task triggered", "success");
		await fetchTasks();
		// Refresh detail if open
		if (ts.selectedId === id) {
			await openDetail(id);
		}
	} else {
		toast(result.error ?? "Failed to trigger task", "error");
	}
	ts.triggering = null;
}
