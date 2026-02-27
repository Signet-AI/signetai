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
	detailStreamConnected: false,

	// Create/edit form
	formOpen: false,
	editingId: null as string | null,

	// Action states
	creating: false,
	deleting: null as string | null,
	triggering: null as string | null,
});

type TaskStreamEvent =
	| {
			readonly type: "connected";
			readonly taskId: string;
	  }
	| {
			readonly type: "run-started";
			readonly taskId: string;
			readonly runId: string;
			readonly startedAt: string;
	  }
	| {
			readonly type: "run-output";
			readonly taskId: string;
			readonly runId: string;
			readonly stream: "stdout" | "stderr";
			readonly chunk: string;
	  }
	| {
			readonly type: "run-completed";
			readonly taskId: string;
			readonly runId: string;
			readonly status: "completed" | "failed";
			readonly completedAt: string;
			readonly exitCode: number | null;
			readonly error: string | null;
	  };

function isTaskStreamEvent(value: unknown): value is TaskStreamEvent {
	if (!value || typeof value !== "object") return false;
	if (!("type" in value) || typeof value.type !== "string") return false;
	if (!("taskId" in value) || typeof value.taskId !== "string") return false;

	switch (value.type) {
		case "connected":
			return true;
		case "run-started":
			return "runId" in value &&
				typeof value.runId === "string" &&
				"startedAt" in value &&
				typeof value.startedAt === "string";
		case "run-output":
			return "runId" in value &&
				typeof value.runId === "string" &&
				"stream" in value &&
				(value.stream === "stdout" || value.stream === "stderr") &&
				"chunk" in value &&
				typeof value.chunk === "string";
		case "run-completed":
			return "runId" in value &&
				typeof value.runId === "string" &&
				"status" in value &&
				(value.status === "completed" || value.status === "failed") &&
				"completedAt" in value &&
				typeof value.completedAt === "string" &&
				"exitCode" in value &&
				(value.exitCode === null || typeof value.exitCode === "number") &&
				"error" in value &&
				(value.error === null || typeof value.error === "string");
		default:
			return false;
	}
}

const TASKS_STREAM_BASE = import.meta.env.DEV ? "http://localhost:3850" : "";
let detailEventSource: EventSource | null = null;
let detailReconnectTimer: ReturnType<typeof setTimeout> | null = null;

const ansiPattern =
	/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

interface OpenCodeJsonTextEvent {
	readonly type: "text";
	readonly part: {
		readonly type: "text";
		readonly text: string;
	};
}

interface OpenCodeJsonToolEvent {
	readonly type: "tool_use";
	readonly part: {
		readonly type: "tool";
		readonly tool: string;
		readonly state?: {
			readonly status?: string;
		};
	};
}

function stripAnsi(value: string): string {
	return value.replace(ansiPattern, "");
}

function isOpenCodeJsonTextEvent(value: unknown): value is OpenCodeJsonTextEvent {
	if (!value || typeof value !== "object") return false;
	if (!("type" in value) || value.type !== "text") return false;
	if (!("part" in value) || typeof value.part !== "object" || value.part === null) {
		return false;
	}

	const part = value.part;
	if (!("type" in part) || part.type !== "text") return false;
	return "text" in part && typeof part.text === "string";
}

function isOpenCodeJsonToolEvent(value: unknown): value is OpenCodeJsonToolEvent {
	if (!value || typeof value !== "object") return false;
	if (!("type" in value) || value.type !== "tool_use") return false;
	if (!("part" in value) || typeof value.part !== "object" || value.part === null) {
		return false;
	}

	const part = value.part;
	if (!("type" in part) || part.type !== "tool") return false;
	return "tool" in part && typeof part.tool === "string";
}

function normalizeOutputChunk(chunk: string): string {
	const cleanChunk = stripAnsi(chunk);
	const lines = cleanChunk.split(/\r?\n/);
	let extractedText = "";
	let extractedAnyEvent = false;
	let sawAnyJsonLine = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;

		try {
			const parsed: unknown = JSON.parse(trimmed);
			sawAnyJsonLine = true;
			if (isOpenCodeJsonTextEvent(parsed)) {
				extractedAnyEvent = true;
				extractedText += parsed.part.text;
				if (!parsed.part.text.endsWith("\n")) {
					extractedText += "\n";
				}
				continue;
			}

			if (isOpenCodeJsonToolEvent(parsed)) {
				extractedAnyEvent = true;
				const status = parsed.part.state?.status;
				if (typeof status === "string" && status.length > 0) {
					extractedText += `[tool:${status}] ${parsed.part.tool}\n`;
				} else {
					extractedText += `[tool] ${parsed.part.tool}\n`;
				}
			}
		} catch {
			// Non-JSON output line, keep fallback behavior
		}
	}

	if (extractedAnyEvent) return extractedText;
	if (sawAnyJsonLine) return "";
	return cleanChunk;
}

function normalizeRunOutput(run: TaskRun): TaskRun {
	return {
		...run,
		stdout: run.stdout ? normalizeOutputChunk(run.stdout) : run.stdout,
		stderr: run.stderr ? normalizeOutputChunk(run.stderr) : run.stderr,
	};
}

function clearDetailReconnectTimer(): void {
	if (detailReconnectTimer) {
		clearTimeout(detailReconnectTimer);
		detailReconnectTimer = null;
	}
}

function closeDetailStream(): void {
	clearDetailReconnectTimer();
	if (detailEventSource) {
		detailEventSource.close();
		detailEventSource = null;
	}
	ts.detailStreamConnected = false;
}

function upsertRun(run: TaskRun): void {
	const existingIndex = ts.detailRuns.findIndex((r) => r.id === run.id);
	if (existingIndex === -1) {
		ts.detailRuns = [run, ...ts.detailRuns];
		return;
	}

	const next = [...ts.detailRuns];
	next[existingIndex] = run;
	ts.detailRuns = next;
}

function startDetailStream(taskId: string): void {
	closeDetailStream();

	const url = `${TASKS_STREAM_BASE}/api/tasks/${encodeURIComponent(taskId)}/stream`;
	detailEventSource = new EventSource(url);

	detailEventSource.onmessage = (event) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(event.data);
		} catch {
			return;
		}

		if (!isTaskStreamEvent(parsed)) return;

		if (parsed.taskId !== taskId || ts.selectedId !== taskId) {
			return;
		}

		if (parsed.type === "connected") {
			ts.detailStreamConnected = true;
			return;
		}

		if (parsed.type === "run-started") {
			upsertRun({
				id: parsed.runId,
				task_id: parsed.taskId,
				status: "running",
				started_at: parsed.startedAt,
				completed_at: null,
				exit_code: null,
				stdout: "",
				stderr: "",
				error: null,
			});
			return;
		}

		if (parsed.type === "run-output") {
			const current = ts.detailRuns.find((r) => r.id === parsed.runId);
			if (!current) return;
			const normalizedChunk = normalizeOutputChunk(parsed.chunk);

			if (parsed.stream === "stdout") {
				upsertRun({
					...current,
					stdout: `${current.stdout ?? ""}${normalizedChunk}`,
				});
				return;
			}

			upsertRun({
				...current,
				stderr: `${current.stderr ?? ""}${normalizedChunk}`,
			});
			return;
		}

		const current = ts.detailRuns.find((r) => r.id === parsed.runId);
		if (!current) return;

		upsertRun({
			...current,
			status: parsed.status,
			completed_at: parsed.completedAt,
			exit_code: parsed.exitCode,
			error: parsed.error,
		});
		fetchTasks();
	};

	detailEventSource.onerror = () => {
		ts.detailStreamConnected = false;
		detailEventSource?.close();
		detailEventSource = null;
		clearDetailReconnectTimer();

		detailReconnectTimer = setTimeout(() => {
			if (ts.detailOpen && ts.selectedId === taskId) {
				startDetailStream(taskId);
			}
		}, 2000);
	};
}

export async function fetchTasks(): Promise<void> {
	ts.loading = true;
	const data = await getTasks();
	ts.tasks = data.tasks;
	ts.presets = data.presets;
	ts.loading = false;
}

export async function openDetail(id: string): Promise<void> {
	closeDetailStream();
	ts.selectedId = id;
	ts.detailOpen = true;
	ts.detailLoading = true;
	ts.detailTask = null;
	ts.detailRuns = [];

	const data = await getTask(id);
	if (data) {
		ts.detailTask = data.task;
		ts.detailRuns = data.runs.map((run) => normalizeRunOutput(run));
	}
	ts.detailLoading = false;

	if (ts.selectedId === id && ts.detailOpen) {
		startDetailStream(id);
	}
}

export function closeDetail(): void {
	closeDetailStream();
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

		if (ts.selectedId === id && ts.detailOpen) {
			const now = new Date().toISOString();
			upsertRun({
				id: result.runId,
				task_id: id,
				status: "running",
				started_at: now,
				completed_at: null,
				exit_code: null,
				stdout: "",
				stderr: "",
				error: null,
			});
		}
	} else {
		toast(result.error ?? "Failed to trigger task", "error");
	}
	ts.triggering = null;
}
