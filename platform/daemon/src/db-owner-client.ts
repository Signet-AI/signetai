import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEmbeddedWorkerPath } from "./native-runtime-assets";
import type {
	DbOwnerCommand,
	DbOwnerEvent,
	DbOwnerJob,
	DbOwnerLane,
	DbOwnerRequest,
	DbOwnerSerializedError,
} from "./db-owner-protocol";
import {
	DB_OWNER_MAX_DEADLINE_MS,
	DB_OWNER_MAX_QUEUE_DEPTH,
	DB_OWNER_MAX_RESULT_BYTES,
	DB_OWNER_MAX_WORK_UNITS,
} from "./db-owner-protocol";

export type { DbOwnerLane, DbOwnerRequest } from "./db-owner-protocol";

export type DbOwnerHealthState = "starting" | "ready" | "dead" | "failed" | "closed";

/** Keep owner admission bounded like the Phase B async database queues. */
export const MAX_DB_OWNER_PENDING_JOBS = DB_OWNER_MAX_QUEUE_DEPTH;
export const MAX_DB_OWNER_WORK_UNITS = DB_OWNER_MAX_WORK_UNITS;
export const MAX_DB_OWNER_DEADLINE_MS = DB_OWNER_MAX_DEADLINE_MS;
export const MAX_DB_OWNER_RESULT_BYTES = DB_OWNER_MAX_RESULT_BYTES;

export interface DbOwnerHealth {
	readonly state: DbOwnerHealthState;
	readonly pid: number | null;
	readonly generation: number;
	readonly queuedJobs: number;
	readonly activeJobId: string | null;
	readonly lastError: string | null;
	/** Number of owner processes SIGKILLed by a hard job deadline. */
	readonly deadlineKills: number;
}

export interface DbOwnerSubmitOptions {
	readonly operation: string;
	readonly lane: DbOwnerLane;
	readonly deadlineMs: number;
	readonly estimatedWorkUnits?: number;
}

export interface DbOwnerJobHandle<Result> {
	readonly job: DbOwnerJob;
	readonly result: Promise<Result>;
	readonly cancel: () => void;
}

export interface DbOwnerClient {
	start(): Promise<void>;
	submit<Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result>;
	awaitResult<Result>(handle: DbOwnerJobHandle<Result>, timeoutMs?: number): Promise<Result>;
	cancel(jobId: string): void;
	health(): DbOwnerHealth;
	close(): Promise<void>;
}

export class DbOwnerError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "DbOwnerError";
		this.code = code;
	}
}

export class DbOwnerDeadlineError extends DbOwnerError {
	constructor(jobId: string) {
		super("DB_OWNER_DEADLINE", `DB owner job ${jobId} exceeded its deadline`);
		this.name = "DbOwnerDeadlineError";
	}
}

export class DbOwnerCancelledError extends DbOwnerError {
	constructor(jobId: string) {
		super("DB_OWNER_CANCELLED", `DB owner job ${jobId} was cancelled`);
		this.name = "DbOwnerCancelledError";
	}
}

export class DbOwnerDiedError extends DbOwnerError {
	constructor(message = "DB owner process died; pending jobs failed closed") {
		super("DB_OWNER_DIED", message);
		this.name = "DbOwnerDiedError";
	}
}

export class DbOwnerAdmissionError extends DbOwnerError {
	constructor(code: "DB_OWNER_QUEUE_FULL" | "DB_OWNER_WORK_BUDGET", message: string) {
		super(code, message);
		this.name = "DbOwnerAdmissionError";
	}
}

interface PendingJob<Result> {
	readonly job: DbOwnerJob;
	readonly resolve: (value: Result | PromiseLike<Result>) => void;
	readonly reject: (reason?: unknown) => void;
	readonly timer: ReturnType<typeof setTimeout>;
	settled: boolean;
	dispatched: boolean;
}

export interface DbOwnerClientOptions {
	readonly dbPath: string;
	readonly workerPath?: string;
	readonly startupTimeoutMs?: number;
	readonly workerRole?: "generic" | "recall";
}

function workerArguments(workerPath: string | undefined): readonly string[] {
	if (workerPath !== undefined) return [workerPath];
	if (resolveEmbeddedWorkerPath("db-owner-worker") !== null) {
		// Compiled native binaries dispatch embedded workers through cli-native.ts.
		// Passing the materialized .mjs path would make the binary treat it as a
		// CLI command instead of entering the worker dispatcher.
		return [];
	}
	const directory = dirname(fileURLToPath(import.meta.url));
	const bundled = join(directory, "db-owner-worker.js");
	return [existsSync(bundled) ? bundled : join(directory, "db-owner-worker.ts")];
}

function ownerIsDead(owner: ChildProcess): boolean {
	if (owner.exitCode !== null || owner.signalCode !== null || owner.killed) return true;
	if (process.platform !== "linux" || owner.pid === undefined) return false;
	try {
		const status = readFileSync(`/proc/${owner.pid}/status`, "utf8");
		// Linux keeps a SIGABRTing process in core-dump state until the dump
		// completes. Its stdio can still accept writes during that interval.
		return /^(?:State:\s+Z|CoreDumping:\s+1)/m.test(status);
	} catch {
		return false;
	}
}

function messageFromError(error: DbOwnerSerializedError): Error {
	return new DbOwnerError(error.name, error.message);
}

function createSingleDbOwnerClient(options: DbOwnerClientOptions): DbOwnerClient {
	let child: ChildProcess | null = null;
	let startPromise: Promise<void> | null = null;
	let startupResolve: (() => void) | null = null;
	let startupReject: ((error: unknown) => void) | null = null;
	let closed = false;
	let generation = 0;
	let state: DbOwnerHealthState = "dead";
	let pid: number | null = null;
	let activeJobId: string | null = null;
	let lastError: string | null = null;
	let deadlineKills = 0;
	let sequence = 0;
	let input = "";
	const pending = new Map<string, PendingJob<unknown>>();

	function currentHealth(): DbOwnerHealth {
		return {
			state,
			pid,
			generation,
			queuedJobs: pending.size,
			activeJobId,
			lastError,
			deadlineKills,
		};
	}

	function write(owner: ChildProcess, command: DbOwnerCommand): Promise<void> {
		const stdin = owner.stdin;
		if (
			child !== owner ||
			stdin === null ||
			stdin === undefined ||
			ownerIsDead(owner) ||
			stdin.destroyed ||
			stdin.writableEnded
		) {
			return Promise.reject(new DbOwnerDiedError());
		}
		return new Promise<void>((resolve, reject) => {
			try {
				stdin.write(`${JSON.stringify(command)}\n`, (error?: Error | null) => {
					if (error === undefined || error === null) resolve();
					else reject(error);
				});
			} catch (error) {
				reject(error);
			}
		});
	}

	function settle(jobId: string, callback: (job: PendingJob<unknown>) => void): void {
		const job = pending.get(jobId);
		if (job === undefined) return;
		pending.delete(jobId);
		clearTimeout(job.timer);
		if (activeJobId === jobId) activeJobId = pending.keys().next().value ?? null;
		callback(job);
	}

	function rejectAll(error: Error, dispatchedOnly = false): void {
		for (const jobId of pending.keys()) {
			if (dispatchedOnly && pending.get(jobId)?.dispatched !== true) continue;
			settle(jobId, (job) => {
				if (!job.settled) {
					job.settled = true;
					job.reject(error);
				}
			});
		}
	}

	function retireOwner(
		error: Error,
		owner: ChildProcess | null = child,
		nextState: "dead" | "failed" = "dead",
		dispatchedOnly = false,
	): void {
		if (owner !== null && child !== owner) return;
		const retired = child;
		child = null;
		pid = null;
		activeJobId = null;
		input = "";
		startPromise = null;
		state = closed ? "closed" : nextState;
		lastError = error.message;
		const rejectStartup = startupReject;
		startupResolve = null;
		startupReject = null;
		rejectStartup?.(error);
		if (!closed) rejectAll(error, dispatchedOnly);
		if (retired !== null) {
			try {
				retired.kill("SIGKILL");
			} catch {
				// The owner may already have exited.
			}
		}
	}

	function handleEvent(owner: ChildProcess, event: DbOwnerEvent): void {
		if (child !== owner) return;
		if (event.type === "ready") {
			state = "ready";
			pid = event.pid;
			startupResolve?.();
			startupResolve = null;
			startupReject = null;
			return;
		}
		if (event.type === "fatal") {
			lastError = event.error.message;
			state = "failed";
			startupReject?.(messageFromError(event.error));
			startupReject = null;
			startupResolve = null;
			return;
		}
		settle(event.jobId, (job) => {
			if (job.settled) return;
			job.settled = true;
			if (event.outcome === "completed") {
				job.resolve(event.result as never);
			} else if (event.outcome === "cancelled") {
				job.reject(new DbOwnerCancelledError(event.jobId));
			} else if (event.outcome === "timed_out") {
				job.reject(new DbOwnerDeadlineError(event.jobId));
			} else {
				job.reject(
					event.error === undefined
						? new DbOwnerError("DB_OWNER_JOB_FAILED", "DB owner job failed")
						: messageFromError(event.error),
				);
			}
		});
	}

	function handleStdout(owner: ChildProcess, chunk: string): void {
		if (child !== owner) return;
		input += chunk;
		const lines = input.split("\n");
		input = lines.pop() ?? "";
		for (const line of lines) {
			if (line.length === 0) continue;
			try {
				handleEvent(owner, JSON.parse(line) as DbOwnerEvent);
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				state = "failed";
			}
		}
	}

	function handleExit(owner: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
		if (child !== owner) return;
		const expected = closed;
		if (expected) {
			child = null;
			pid = null;
			activeJobId = null;
			input = "";
			startPromise = null;
			return;
		}
		const message = signal === null ? `DB owner exited with code ${code ?? "unknown"}` : `DB owner killed by ${signal}`;
		retireOwner(
			new DbOwnerDiedError(message),
			owner,
			state === "starting" || state === "failed" ? "failed" : "dead",
			true,
		);
	}

	function handleTransportError(owner: ChildProcess, error: Error): void {
		if (child !== owner || closed) return;
		retireOwner(new DbOwnerDiedError(error.message), owner, state === "starting" ? "failed" : "dead", true);
	}

	async function start(): Promise<void> {
		if (closed) throw new DbOwnerError("DB_OWNER_CLOSED", "DB owner client is closed");
		if (state === "ready" && child !== null) {
			const owner = child;
			if (ownerIsDead(owner)) {
				retireOwner(new DbOwnerDiedError(), owner, "dead", true);
				return await start();
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			if (child !== owner || state !== "ready") return await start();
			return;
		}
		if (startPromise !== null) return await startPromise;
		const timeoutMs = options.startupTimeoutMs ?? 5_000;
		state = "starting";
		lastError = null;
		generation++;
		startPromise = new Promise<void>((resolve, reject) => {
			startupResolve = resolve;
			startupReject = reject;
			const owner = spawn(process.execPath, workerArguments(options.workerPath), {
				env: {
					...process.env,
					SIGNET_DB_OWNER_DB_PATH: options.dbPath,
					SIGNET_DB_OWNER_WORKER: "1",
					...(options.workerRole === "recall" ? { SIGNET_DB_OWNER_RECALL_WORKER: "1" } : {}),
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			child = owner;
			owner.stdout?.setEncoding("utf8");
			owner.stdout?.on("data", (chunk: string) => handleStdout(owner, chunk));
			owner.stdin?.on("error", (error: Error) => handleTransportError(owner, error));
			owner.stderr?.resume();
			owner.once("error", (error: Error) => handleTransportError(owner, error));
			owner.once("close", (code, signal) => handleExit(owner, code, signal));
			const timer = setTimeout(() => {
				if (state !== "ready") {
					lastError = `DB owner did not become ready within ${timeoutMs}ms`;
					state = "failed";
					owner.kill("SIGKILL");
					startupReject?.(new DbOwnerError("DB_OWNER_START_TIMEOUT", lastError));
				}
			}, timeoutMs);
			const resolveStartup = startupResolve;
			const rejectStartup = startupReject;
			startupResolve = () => {
				clearTimeout(timer);
				resolveStartup?.();
			};
			startupReject = (error: unknown) => {
				clearTimeout(timer);
				rejectStartup?.(error);
			};
		});
		const currentStartPromise = startPromise;
		try {
			await currentStartPromise;
		} finally {
			if (startPromise === currentStartPromise) startPromise = null;
		}
	}

	function dispatch(jobId: string): void {
		activeJobId ??= jobId;
		void start().then(
			() => {
				const entry = pending.get(jobId);
				if (entry === undefined || entry.settled) return;
				const owner = child;
				if (owner === null || state !== "ready") {
					dispatch(jobId);
					return;
				}
				void write(owner, { type: "submit", job: entry.job }).then(
					() => {
						const current = pending.get(jobId);
						if (current === undefined || current.settled) return;
						if (child !== owner) {
							settle(jobId, (job) => {
								if (!job.settled) {
									job.settled = true;
									job.reject(new DbOwnerDiedError());
								}
							});
							return;
						}
						current.dispatched = true;
					},
					(error: unknown) => {
						if (child === owner && !closed) {
							const transportError = error instanceof Error ? error : new Error(String(error));
							handleTransportError(owner, transportError);
						}
						if (!closed && pending.get(jobId)?.settled !== true) dispatch(jobId);
					},
				);
			},
			(error: unknown) => {
				settle(jobId, (entry) => {
					if (!entry.settled) {
						entry.settled = true;
						entry.reject(error);
					}
				});
			},
		);
	}

	function submit<Result>(request: DbOwnerRequest, submitOptions: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> {
		if (!Number.isFinite(submitOptions.deadlineMs) || submitOptions.deadlineMs <= 0) {
			throw new RangeError("DB owner deadlineMs must be a positive finite number");
		}
		if (submitOptions.deadlineMs > MAX_DB_OWNER_DEADLINE_MS) {
			throw new DbOwnerAdmissionError(
				"DB_OWNER_WORK_BUDGET",
				`DB owner deadlineMs exceeds the ${MAX_DB_OWNER_DEADLINE_MS}ms admission limit`,
			);
		}
		const estimatedWorkUnits = submitOptions.estimatedWorkUnits ?? 1;
		if (!Number.isFinite(estimatedWorkUnits) || estimatedWorkUnits < 0) {
			throw new RangeError("DB owner estimatedWorkUnits must be a non-negative finite number");
		}
		if (estimatedWorkUnits > MAX_DB_OWNER_WORK_UNITS) {
			throw new DbOwnerAdmissionError(
				"DB_OWNER_WORK_BUDGET",
				`DB owner estimatedWorkUnits exceeds the ${MAX_DB_OWNER_WORK_UNITS}-unit admission limit`,
			);
		}
		if (pending.size >= MAX_DB_OWNER_PENDING_JOBS) {
			throw new DbOwnerAdmissionError(
				"DB_OWNER_QUEUE_FULL",
				`DB owner admission queue is full at ${MAX_DB_OWNER_PENDING_JOBS} pending jobs`,
			);
		}
		const now = Date.now();
		const job: DbOwnerJob = {
			id: `db-owner-${process.pid}-${++sequence}`,
			operation: submitOptions.operation,
			lane: submitOptions.lane,
			enqueuedAt: now,
			deadlineAt: now + submitOptions.deadlineMs,
			estimatedWorkUnits,
			cancellation: "pending",
			request,
		};
		let pendingJob: PendingJob<Result> | null = null;
		const result = new Promise<Result>((resolve, reject) => {
			const timer = setTimeout(() => {
				const entry = pending.get(job.id);
				if (entry === undefined || entry.settled) return;
				lastError = `deadline exceeded for ${job.id}`;
				deadlineKills++;
				settle(job.id, (settledJob) => {
					if (!settledJob.settled) {
						settledJob.settled = true;
						settledJob.reject(new DbOwnerDeadlineError(job.id));
					}
				});
				retireOwner(new DbOwnerDiedError(`DB owner killed after deadline for ${job.id}`));
			}, submitOptions.deadlineMs);
			pendingJob = { job, resolve, reject, timer, settled: false, dispatched: false };
			pending.set(job.id, pendingJob as PendingJob<unknown>);
			activeJobId ??= job.id;
			dispatch(job.id);
		});
		return { job, result, cancel: () => cancel(job.id) };
	}

	function cancel(jobId: string): void {
		const entry = pending.get(jobId);
		if (entry === undefined || entry.settled) return;
		settle(jobId, (job) => {
			if (!job.settled) {
				job.settled = true;
				job.reject(new DbOwnerCancelledError(jobId));
			}
		});
		if (state === "ready" && child !== null)
			void write(child, { type: "cancel", jobId }).catch(() => {
				// The exit handler reports a dead owner to other pending jobs.
			});
	}

	async function awaitResult<Result>(handle: DbOwnerJobHandle<Result>, timeoutMs?: number): Promise<Result> {
		if (timeoutMs === undefined) return await handle.result;
		return await new Promise<Result>((resolve, reject) => {
			const timer = setTimeout(() => {
				handle.cancel();
				reject(new DbOwnerDeadlineError(handle.job.id));
			}, timeoutMs);
			handle.result.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error: unknown) => {
					clearTimeout(timer);
					reject(error);
				},
			);
		});
	}

	async function close(): Promise<void> {
		closed = true;
		if (child !== null) {
			void write(child, { type: "shutdown" }).catch(() => {
				// The close path remains idempotent after an owner crash.
			});
			await new Promise<void>((resolve) => {
				if (child === null) {
					resolve();
					return;
				}
				child.once("close", () => resolve());
				setTimeout(() => {
					child?.kill("SIGKILL");
					resolve();
				}, 250);
			});
		}
		state = "closed";
		rejectAll(new DbOwnerDiedError("DB owner client closed"));
	}

	return { start, submit, awaitResult, cancel, health: currentHealth, close };
}

/**
 * Keep recall independent from serial writes and maintenance. Each lane owns
 * its own SQLite connection and FIFO queue. Read jobs therefore cannot wait
 * behind a synchronous maintenance job, while writes and maintenance remain
 * serialized on one owner connection.
 */
export function createDbOwnerClient(options: DbOwnerClientOptions): DbOwnerClient {
	const readLane = createSingleDbOwnerClient(options);
	const maintenanceLane = createSingleDbOwnerClient(options);
	let closed = false;

	function laneFor(requestLane: DbOwnerLane): DbOwnerClient {
		return requestLane === "read" ? readLane : maintenanceLane;
	}

	function health(): DbOwnerHealth {
		const read = readLane.health();
		const maintenance = maintenanceLane.health();
		const state: DbOwnerHealthState =
			read.state === "closed" && maintenance.state === "closed"
				? "closed"
				: read.state === "failed" || maintenance.state === "failed"
					? "failed"
					: (read.state === "dead" && read.generation > 0) ||
							(maintenance.state === "dead" && maintenance.generation > 0)
						? "dead"
						: read.state === "starting" || maintenance.state === "starting"
							? "starting"
							: read.state === "ready" || maintenance.state === "ready"
								? "ready"
								: "dead";
		return {
			state,
			pid: read.pid ?? maintenance.pid,
			generation: Math.max(read.generation, maintenance.generation),
			queuedJobs: read.queuedJobs + maintenance.queuedJobs,
			activeJobId: read.activeJobId ?? maintenance.activeJobId,
			lastError: read.lastError ?? maintenance.lastError,
			deadlineKills: read.deadlineKills + maintenance.deadlineKills,
		};
	}

	return {
		async start(): Promise<void> {
			if (closed) throw new DbOwnerError("DB_OWNER_CLOSED", "DB owner client is closed");
			await Promise.all([readLane.start(), maintenanceLane.start()]);
		},
		submit<Result>(request: DbOwnerRequest, submitOptions: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> {
			return laneFor(submitOptions.lane).submit<Result>(request, submitOptions);
		},
		awaitResult<Result>(handle: DbOwnerJobHandle<Result>, timeoutMs?: number): Promise<Result> {
			return laneFor(handle.job.lane).awaitResult(handle, timeoutMs);
		},
		cancel(jobId) {
			readLane.cancel(jobId);
			maintenanceLane.cancel(jobId);
		},
		health,
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			await Promise.all([readLane.close(), maintenanceLane.close()]);
		},
	};
}
