export type SourceIndexJobStatus = "queued" | "running" | "complete" | "paused" | "error";

export interface SourceIndexJob {
	readonly id: string;
	readonly sourceId: string;
	readonly status: SourceIndexJobStatus;
	readonly queuedAt: string;
	readonly startedAt?: string;
	readonly finishedAt?: string;
	readonly scanned?: number;
	readonly total?: number;
	readonly indexed?: number;
	readonly currentPath?: string;
	readonly statusMessage?: string;
	readonly partial?: boolean;
	readonly pauseReason?: string;
	readonly resumeFrontier?: string | null;
	readonly error?: string;
}

export interface SourceIndexProgressEvent {
	readonly scanned: number;
	readonly total: number;
	readonly indexed: number;
	readonly currentPath: string;
	readonly statusMessage?: string;
}

export type SourceIndexRunKind = "route" | "startup";

export interface TrackedSourceIndexRun {
	readonly sourceId: string;
	readonly jobId: string;
	readonly kind: SourceIndexRunKind;
	readonly run: Promise<void>;
}

const sourceIndexJobs = new Map<string, SourceIndexJob>();
const sourceIndexInFlight = new Set<string>();
const canceledSourceIndexJobs = new Set<string>();
const sourceIndexRuns = new Set<TrackedSourceIndexRun>();

export function trackSourceIndexRun(input: TrackedSourceIndexRun): void {
	sourceIndexRuns.add(input);
	void input.run.then(
		() => sourceIndexRuns.delete(input),
		() => sourceIndexRuns.delete(input),
	);
}

export function getSourceIndexRuns(sourceId: string): readonly TrackedSourceIndexRun[] {
	return [...sourceIndexRuns].filter((run) => run.sourceId === sourceId);
}

export async function waitForSourceIndexRuns(kind?: SourceIndexRunKind): Promise<void> {
	while (true) {
		const runs = [...sourceIndexRuns].filter((run) => kind === undefined || run.kind === kind).map((run) => run.run);
		if (runs.length === 0) return;
		await Promise.allSettled(runs);
	}
}

export function getSourceIndexJob(sourceId: string): SourceIndexJob | undefined {
	return sourceIndexJobs.get(sourceId);
}

export function beginSourceIndexJob(sourceId: string, prefix = "source-index"): SourceIndexJob {
	const existing = sourceIndexJobs.get(sourceId);
	if (existing && (existing.status === "queued" || existing.status === "running")) return existing;
	const job: SourceIndexJob = {
		id: `${prefix}:${sourceId}:${Date.now()}`,
		sourceId,
		status: "queued",
		queuedAt: new Date().toISOString(),
	};
	sourceIndexJobs.set(sourceId, job);
	return job;
}

export function markSourceIndexJobRunning(sourceId: string, jobId: string): SourceIndexJob | undefined {
	if (!isCurrentSourceIndexJob(sourceId, jobId)) return undefined;
	const current = sourceIndexJobs.get(sourceId);
	if (!current || (current.status !== "queued" && current.status !== "running")) return undefined;
	const running: SourceIndexJob = {
		...current,
		status: "running",
		startedAt: current.startedAt ?? new Date().toISOString(),
	};
	sourceIndexJobs.set(sourceId, running);
	return running;
}

export function updateSourceIndexJobProgress(sourceId: string, jobId: string, event: SourceIndexProgressEvent): void {
	if (!isCurrentSourceIndexJob(sourceId, jobId)) return;
	const current = sourceIndexJobs.get(sourceId);
	if (!current) return;
	if (current.status === "complete" || current.status === "error") return;
	sourceIndexJobs.set(sourceId, {
		...current,
		status: "running",
		startedAt: current.startedAt ?? new Date().toISOString(),
		scanned: event.scanned,
		total: event.total,
		indexed: event.indexed,
		currentPath: event.currentPath,
		statusMessage: event.statusMessage,
	});
}

export function completeSourceIndexJob(sourceId: string, jobId: string, indexed: number): void {
	if (!isCurrentSourceIndexJob(sourceId, jobId)) return;
	const current = sourceIndexJobs.get(sourceId);
	if (!current) return;
	sourceIndexJobs.set(sourceId, {
		...current,
		status: "complete",
		finishedAt: new Date().toISOString(),
		indexed,
	});
}

export function completeSourceIndexJobFromProgress(sourceId: string, jobId: string): void {
	completeSourceIndexJob(sourceId, jobId, sourceIndexJobs.get(sourceId)?.indexed ?? 0);
}

export function pauseSourceIndexJob(
	sourceId: string,
	jobId: string,
	input: {
		readonly pauseReason: string;
		readonly resumeFrontier: string | null;
		readonly scanned: number;
		readonly indexed: number;
	},
): void {
	if (!isCurrentSourceIndexJob(sourceId, jobId)) return;
	const current = sourceIndexJobs.get(sourceId);
	if (!current) return;
	sourceIndexJobs.set(sourceId, {
		...current,
		status: "paused",
		finishedAt: new Date().toISOString(),
		partial: true,
		scanned: input.scanned,
		indexed: input.indexed,
		pauseReason: input.pauseReason,
		resumeFrontier: input.resumeFrontier,
	});
}

export function failSourceIndexJob(sourceId: string, jobId: string, error: unknown): void {
	if (!isCurrentSourceIndexJob(sourceId, jobId)) return;
	const current = sourceIndexJobs.get(sourceId);
	if (!current) return;
	sourceIndexJobs.set(sourceId, {
		...current,
		status: "error",
		finishedAt: new Date().toISOString(),
		error: error instanceof Error ? error.message : String(error),
	});
}

export function isCurrentSourceIndexJob(sourceId: string, jobId: string): boolean {
	return sourceIndexJobs.get(sourceId)?.id === jobId;
}

export function isSourceIndexInFlight(sourceId: string): boolean {
	return sourceIndexInFlight.has(sourceId);
}

export function markSourceIndexInFlight(sourceId: string): void {
	sourceIndexInFlight.add(sourceId);
}

export function clearSourceIndexInFlight(sourceId: string): void {
	sourceIndexInFlight.delete(sourceId);
}

export function cancelSourceIndexJob(sourceId: string): void {
	const job = sourceIndexJobs.get(sourceId);
	if (job && (job.status === "queued" || job.status === "running")) canceledSourceIndexJobs.add(job.id);
	sourceIndexJobs.delete(sourceId);
}
export function invalidateSourceIndexJob(sourceId: string): void {
	sourceIndexJobs.delete(sourceId);
}

export function consumeCanceledSourceIndexJob(jobId: string): boolean {
	return canceledSourceIndexJobs.delete(jobId);
}

export function clearSourceIndexProgressForTests(): void {
	sourceIndexJobs.clear();
	sourceIndexInFlight.clear();
	canceledSourceIndexJobs.clear();
	sourceIndexRuns.clear();
}
