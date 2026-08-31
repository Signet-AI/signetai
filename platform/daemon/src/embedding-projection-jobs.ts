import { randomUUID } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEmbeddedWorkerPath } from "./native-runtime-assets";
import type { ProjectionResult } from "./umap-projection";
import {
	PROJECTION_JOB_STATUS_TTL_MS,
	PROJECTION_MAX_IN_FLIGHT,
	PROJECTION_JOB_DEADLINE_MS,
	PROJECTION_JOB_STATUS_MAX_ENTRIES,
	PROJECTION_READY_CACHE_MAX_ENTRIES,
} from "./embedding-projection-contract";
export { PROJECTION_MAX_IN_FLIGHT, PROJECTION_MAX_ROWS } from "./embedding-projection-contract";
export const PROJECTION_DEADLINE_MS = PROJECTION_JOB_DEADLINE_MS;
export const PROJECTION_JOB_TTL_MS = PROJECTION_JOB_STATUS_TTL_MS;
import type { ProjectionPrincipal, ProjectionSnapshotDescriptor } from "./embedding-projection-contract";
import type { ProjectionWorkerInput } from "./embedding-projection-worker";

export class ProjectionWorkerTimeoutError extends Error {
	readonly code = "PROJECTION_TIMEOUT" as const;

	constructor(timeoutMs: number) {
		super(`Embedding projection exceeded its ${timeoutMs}ms deadline`);
		this.name = "ProjectionWorkerTimeoutError";
	}
}

export class ProjectionWorkerCancelledError extends Error {
	readonly code = "PROJECTION_CANCELLED" as const;

	constructor() {
		super("Embedding projection was cancelled");
		this.name = "ProjectionWorkerCancelledError";
	}
}

export class ProjectionAdmissionError extends Error {
	readonly code = "PROJECTION_OVERLOADED" as const;

	constructor() {
		super("Embedding projection capacity is full; retry after an active job completes");
		this.name = "ProjectionAdmissionError";
	}
}

export interface ProjectionWorkerOptions {
	readonly runtimePath?: string;
	readonly workerPath?: string;
	readonly timeoutMs?: number;
	readonly holdForTests?: boolean;
}

function workerArguments(workerPath?: string): readonly string[] {
	if (workerPath !== undefined) return [workerPath];
	if (resolveEmbeddedWorkerPath("embedding-projection-worker") !== null) return [];
	const directory = dirname(fileURLToPath(import.meta.url));
	const bundled = join(directory, "embedding-projection-worker.js");
	return [existsSync(bundled) ? bundled : join(directory, "embedding-projection-worker.ts")];
}

function killChild(child: ChildProcess): void {
	if (child.exitCode !== null) return;
	try {
		child.kill("SIGKILL");
	} catch {
		// The process may have exited between the check and the signal.
	}
}

export function runProjectionWorker(
	input: ProjectionWorkerInput | ProjectionSnapshotDescriptor,
	options: ProjectionWorkerOptions = {},
): {
	readonly result: Promise<ProjectionResult>;
	readonly serializedResult: Promise<string>;
	readonly cancel: () => void;
} {
	const timeoutMs = options.timeoutMs ?? PROJECTION_DEADLINE_MS;
	const serialized = JSON.stringify(input);
	let child: ChildProcess | null = null;
	let cancelRequested = false;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let serializedOutput: string | null = null;

	const result = new Promise<ProjectionResult>((resolve, reject) => {
		child = spawn(options.runtimePath ?? process.execPath, workerArguments(options.workerPath), {
			env: {
				...process.env,
				SIGNET_EMBEDDING_PROJECTION_WORKER: "1",
				...(options.holdForTests === true ? { SIGNET_PROJECTION_WORKER_HOLD: "1" } : {}),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let output = "";
		let errorOutput = "";
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			fn();
		};
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			errorOutput += chunk;
		});
		child.once("error", (error) => finish(() => reject(error)));
		child.once("close", (code) => {
			if (settled) return;
			finish(() => {
				if (cancelRequested) {
					reject(new ProjectionWorkerCancelledError());
					return;
				}
				if (code !== 0) {
					const detail = errorOutput.trim();
					reject(new Error(`Projection worker exited with code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`));
					return;
				}
				try {
					const lines = output.trim().split("\n");
					const message = JSON.parse(lines.shift() ?? "") as { type?: unknown };
					serializedOutput = lines.join("\n").trim();
					if (message.type !== "result" || serializedOutput.length === 0)
						throw new Error("invalid projection worker result");
					resolve(JSON.parse(serializedOutput) as ProjectionResult);
				} catch (error) {
					reject(error);
				}
			});
		});
		child.stderr?.resume();
		timer = setTimeout(() => {
			if (settled) return;
			cancelRequested = true;
			finish(() => reject(new ProjectionWorkerTimeoutError(timeoutMs)));
			killChild(child as ChildProcess);
		}, timeoutMs);
		child.stdin?.end(`${serialized}\n`);
	});

	return {
		result,
		serializedResult: result.then(
			() => {
				if (serializedOutput === null) throw new Error("projection worker did not publish a serialized result");
				return serializedOutput;
			},
			() => "",
		),
		cancel: () => {
			if (settled || child === null) return;
			cancelRequested = true;
			killChild(child);
		},
	};
}

export interface ProjectionJobControl {
	readonly deadlineAt: number;
	readonly remainingMs: () => number;
	readonly isCancelled: () => boolean;
	readonly onCancel: (callback: () => void) => void;
}

export interface BoundedProjectionJobOptions {
	readonly deadlineMs?: number;
	readonly workerOptions?: Omit<ProjectionWorkerOptions, "timeoutMs">;
	readonly publish?: (
		result: ProjectionResult,
		serializedResult: string,
		control: ProjectionJobControl,
	) => Promise<void>;
	readonly cleanup?: (input: ProjectionWorkerInput | ProjectionSnapshotDescriptor) => void | Promise<void>;
}

export interface ProjectionJobRunHandle {
	readonly result: Promise<ProjectionResult>;
	readonly cancel: () => void;
	/** Resolves after cancellation cleanup has released all child resources. */
	readonly finished?: Promise<void>;
}

/** Run snapshot, compute, and optional publication under one killable deadline. */
export function runBoundedProjectionJob(
	load: (control: ProjectionJobControl) => Promise<ProjectionWorkerInput | ProjectionSnapshotDescriptor>,
	options: BoundedProjectionJobOptions = {},
): ProjectionJobRunHandle {
	const deadlineMs = options.deadlineMs ?? PROJECTION_DEADLINE_MS;
	const deadlineAt = Date.now() + deadlineMs;
	let cancelled = false;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let rejectResult: ((error: unknown) => void) | undefined;
	let worker: ReturnType<typeof runProjectionWorker> | null = null;
	let loadedInput: ProjectionWorkerInput | ProjectionSnapshotDescriptor | undefined;
	let finishResources!: () => void;
	const finished = new Promise<void>((resolve) => {
		finishResources = resolve;
	});
	const cancellationCallbacks: Array<() => void> = [];

	const control: ProjectionJobControl = {
		deadlineAt,
		remainingMs: () => Math.max(0, deadlineAt - Date.now()),
		isCancelled: () => cancelled,
		onCancel: (callback) => {
			if (cancelled) {
				callback();
				return;
			}
			cancellationCallbacks.push(callback);
		},
	};
	const cancelOutstanding = (): void => {
		for (const callback of cancellationCallbacks) {
			try {
				callback();
			} catch {
				// The operation may already have settled at the cancellation boundary.
			}
		}
		worker?.cancel();
	};

	const result = new Promise<ProjectionResult>((resolve, reject) => {
		const finishReject = (error: unknown): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			cancelOutstanding();
			reject(error);
		};
		rejectResult = finishReject;
		timer = setTimeout(() => {
			cancelled = true;
			finishReject(new ProjectionWorkerTimeoutError(deadlineMs));
		}, deadlineMs);
		void (async () => {
			try {
				const input = await load(control);
				loadedInput = input;
				if (cancelled) throw new ProjectionWorkerCancelledError();
				const remainingMs = control.remainingMs();
				if (remainingMs <= 0) throw new ProjectionWorkerTimeoutError(deadlineMs);
				worker = runProjectionWorker(input, { ...options.workerOptions, timeoutMs: remainingMs });
				const projection = await worker.result;
				const serializedResult = await worker.serializedResult;
				if (cancelled) throw new ProjectionWorkerCancelledError();
				if (options.publish !== undefined) await options.publish(projection, serializedResult, control);
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				resolve(projection);
			} catch (error) {
				if (error instanceof ProjectionWorkerTimeoutError || error instanceof ProjectionWorkerCancelledError) {
					finishReject(error);
					return;
				}
				if (cancelled) {
					finishReject(new ProjectionWorkerCancelledError());
					return;
				}
				if (control.remainingMs() <= 0) {
					finishReject(new ProjectionWorkerTimeoutError(deadlineMs));
					return;
				}
				finishReject(error);
			} finally {
				try {
					if (loadedInput !== undefined && options.cleanup !== undefined) await options.cleanup(loadedInput);
				} finally {
					finishResources();
				}
			}
		})();
	});

	return {
		result,
		finished,
		cancel: () => {
			if (settled) return;
			cancelled = true;
			rejectResult?.(new ProjectionWorkerCancelledError());
		},
	};
}

type ProjectionJobState = "accepted" | "running" | "ready" | "timeout" | "cancelled" | "error";

export interface ProjectionJobStatus {
	readonly jobId: string;
	readonly key: string;
	readonly status: ProjectionJobState;
	readonly createdAt: string;
	readonly dimensions: 2 | 3;
	readonly total?: number;
	readonly count?: number;
	readonly limit?: number;
	readonly offset?: number;
	readonly hasMore?: boolean;
	readonly sampled?: boolean;
	readonly result?: ProjectionResult;
	readonly message?: string;
}

interface ProjectionJob extends ProjectionJobStatus {
	readonly principal?: ProjectionPrincipal;
	readonly cancel: () => void;
	readonly expiresAt: number;
}

export class ProjectionJobManager {
	private readonly jobs = new Map<string, ProjectionJob>();
	private active = 0;

	constructor(private readonly maxInFlight = PROJECTION_MAX_IN_FLIGHT) {}

	start(
		key: string,
		dimensions: 2 | 3,
		run: () => ProjectionJobRunHandle,
		metadata: Pick<ProjectionJobStatus, "total" | "count" | "limit" | "offset" | "hasMore" | "sampled"> = {},
		principal?: ProjectionPrincipal,
	): ProjectionJobStatus {
		this.prune();
		const existing = this.jobs.get(key);
		if (existing !== undefined && (existing.status === "accepted" || existing.status === "running")) return existing;
		if (this.active >= this.maxInFlight) throw new ProjectionAdmissionError();
		const jobId = `projection-${randomUUID()}`;
		const started: ProjectionJob = {
			jobId,
			key,
			status: "accepted",
			createdAt: new Date().toISOString(),
			dimensions,
			...metadata,
			...(principal === undefined ? {} : { principal }),
			cancel: () => undefined,
			expiresAt: Date.now() + PROJECTION_JOB_TTL_MS,
		};
		this.jobs.set(key, started);
		this.active += 1;
		let handle: ProjectionJobRunHandle;
		try {
			handle = run();
		} catch (error) {
			this.active = Math.max(0, this.active - 1);
			const failed = {
				...started,
				status: "error" as const,
				message: error instanceof Error ? error.message : String(error),
			};
			this.jobs.set(key, failed);
			return failed;
		}
		const running = { ...started, status: "running" as const, cancel: handle.cancel };
		this.jobs.set(key, running);
		const finished =
			handle.finished ??
			handle.result.then(
				() => undefined,
				() => undefined,
			);
		void handle.result.then(
			(result) => {
				void finished.then(() => {
					this.active = Math.max(0, this.active - 1);
					const current = this.jobs.get(key);
					if (current?.jobId !== jobId) return;
					this.jobs.set(key, { ...current, status: "ready", result, expiresAt: Date.now() + PROJECTION_JOB_TTL_MS });
				});
			},
			(error: unknown) => {
				void finished.then(() => {
					this.active = Math.max(0, this.active - 1);
					const current = this.jobs.get(key);
					if (current?.jobId !== jobId) return;
					const status: ProjectionJobState =
						error instanceof ProjectionWorkerTimeoutError
							? "timeout"
							: error instanceof ProjectionWorkerCancelledError
								? "cancelled"
								: "error";
					this.jobs.set(key, {
						...current,
						status,
						message: error instanceof Error ? error.message : String(error),
						expiresAt: Date.now() + PROJECTION_JOB_TTL_MS,
					});
				});
			},
		);
		return running;
	}

	get(jobId: string, principal?: ProjectionPrincipal): ProjectionJobStatus | null {
		this.prune();
		for (const job of this.jobs.values()) {
			if (job.jobId !== jobId) continue;
			if (
				principal !== undefined &&
				(job.principal?.agentId !== principal.agentId || job.principal?.project !== principal.project)
			)
				return null;
			return job;
		}
		return null;
	}

	getByKey(key: string, principal?: ProjectionPrincipal): ProjectionJobStatus | null {
		this.prune();
		const job = this.jobs.get(key);
		if (job === undefined) return null;
		if (
			principal !== undefined &&
			(job.principal?.agentId !== principal.agentId || job.principal?.project !== principal.project)
		)
			return null;
		return job;
	}

	updateMetadata(
		jobId: string,
		metadata: Pick<ProjectionJobStatus, "total" | "count" | "limit" | "offset" | "hasMore" | "sampled">,
	): void {
		for (const job of this.jobs.values()) {
			if (job.jobId !== jobId) continue;
			this.jobs.set(job.key, { ...job, ...metadata });
			return;
		}
	}

	updateMetadataByKey(
		key: string,
		metadata: Pick<ProjectionJobStatus, "total" | "count" | "limit" | "offset" | "hasMore" | "sampled">,
	): void {
		const job = this.jobs.get(key);
		if (job !== undefined) this.jobs.set(key, { ...job, ...metadata });
	}

	cancel(jobId: string, principal?: ProjectionPrincipal): ProjectionJobStatus | null {
		for (const job of this.jobs.values()) {
			if (job.jobId !== jobId) continue;
			if (
				principal !== undefined &&
				(job.principal?.agentId !== principal.agentId || job.principal?.project !== principal.project)
			)
				return null;
			if (job.status === "accepted" || job.status === "running") {
				job.cancel();
				const cancelled = { ...job, status: "cancelled" as const, message: "Embedding projection was cancelled" };
				this.jobs.set(job.key, cancelled);
				return cancelled;
			}
			return job;
		}
		return null;
	}

	reset(): void {
		for (const job of this.jobs.values()) if (job.status === "accepted" || job.status === "running") job.cancel();
		this.jobs.clear();
		this.active = 0;
	}

	private prune(): void {
		const now = Date.now();
		for (const [key, job] of this.jobs) if (job.expiresAt <= now) this.jobs.delete(key);
		const terminal = [...this.jobs.entries()].filter(([, job]) => job.status === "ready");
		while (terminal.length > PROJECTION_READY_CACHE_MAX_ENTRIES) {
			const oldest = terminal.shift();
			if (oldest !== undefined) this.jobs.delete(oldest[0]);
		}
		const statuses = [...this.jobs.entries()];
		while (statuses.length > PROJECTION_JOB_STATUS_MAX_ENTRIES) {
			const oldest = statuses.shift();
			if (oldest !== undefined && oldest[1].status !== "accepted" && oldest[1].status !== "running")
				this.jobs.delete(oldest[0]);
		}
	}
}
