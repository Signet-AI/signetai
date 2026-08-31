import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEmbeddedWorkerPath } from "./native-runtime-assets";
import type { ProjectionResult } from "./umap-projection";
import type { ProjectionWorkerInput } from "./embedding-projection-worker";

export const PROJECTION_MAX_ROWS = 1_000;
export const PROJECTION_MAX_IN_FLIGHT = 2;
export const PROJECTION_DEADLINE_MS = 10_000;
export const PROJECTION_JOB_TTL_MS = 60_000;

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
	input: ProjectionWorkerInput,
	options: ProjectionWorkerOptions = {},
): { readonly result: Promise<ProjectionResult>; readonly cancel: () => void } {
	const timeoutMs = options.timeoutMs ?? PROJECTION_DEADLINE_MS;
	const serialized = JSON.stringify(input);
	let child: ChildProcess | null = null;
	let cancelRequested = false;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

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
					const message = JSON.parse(output.trim()) as { type?: unknown; result?: ProjectionResult };
					if (message.type !== "result" || message.result === undefined)
						throw new Error("invalid projection worker result");
					resolve(message.result);
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
		cancel: () => {
			if (settled || child === null) return;
			cancelRequested = true;
			killChild(child);
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
	readonly cancel: () => void;
	readonly expiresAt: number;
}

export class ProjectionJobManager {
	private readonly jobs = new Map<string, ProjectionJob>();
	private sequence = 0;
	private active = 0;

	constructor(private readonly maxInFlight = PROJECTION_MAX_IN_FLIGHT) {}

	start(
		key: string,
		dimensions: 2 | 3,
		run: () => { readonly result: Promise<ProjectionResult>; readonly cancel: () => void },
		metadata: Pick<ProjectionJobStatus, "total" | "count" | "limit" | "offset" | "hasMore" | "sampled"> = {},
	): ProjectionJobStatus {
		this.prune();
		const existing = this.jobs.get(key);
		if (existing !== undefined && (existing.status === "accepted" || existing.status === "running")) return existing;
		if (this.active >= this.maxInFlight) throw new ProjectionAdmissionError();
		const jobId = `projection-${Date.now()}-${this.sequence++}`;
		const started: ProjectionJob = {
			jobId,
			key,
			status: "accepted",
			createdAt: new Date().toISOString(),
			dimensions,
			...metadata,
			cancel: () => undefined,
			expiresAt: Date.now() + PROJECTION_JOB_TTL_MS,
		};
		this.jobs.set(key, started);
		this.active += 1;
		let handle: { readonly result: Promise<ProjectionResult>; readonly cancel: () => void };
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
		void handle.result.then(
			(result) => {
				this.active = Math.max(0, this.active - 1);
				const current = this.jobs.get(key);
				if (current?.jobId !== jobId) return;
				this.jobs.set(key, { ...current, status: "ready", result, expiresAt: Date.now() + PROJECTION_JOB_TTL_MS });
			},
			(error: unknown) => {
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
			},
		);
		return running;
	}

	get(jobId: string): ProjectionJobStatus | null {
		this.prune();
		for (const job of this.jobs.values()) if (job.jobId === jobId) return job;
		return null;
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

	cancel(jobId: string): ProjectionJobStatus | null {
		for (const job of this.jobs.values()) {
			if (job.jobId !== jobId) continue;
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
	}
}
