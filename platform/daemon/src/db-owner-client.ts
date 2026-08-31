import { randomUUID } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEmbeddedWorkerPath } from "./native-runtime-assets";
import type {
	DbOwnerCommand,
	DbOwnerEvent,
	DbOwnerJob,
	DbOwnerJobMetrics,
	DbOwnerLane,
	DbOwnerRequest,
	DbOwnerSerializedError,
	DbOwnerFailureCause,
	DbOwnerWorkloadClass,
} from "./db-owner-protocol";
import {
	DB_OWNER_MAX_DEADLINE_MS,
	DB_OWNER_MAX_MAINTENANCE_DEADLINE_MS,
	DB_OWNER_MAX_QUEUE_DEPTH,
	DB_OWNER_MAX_RESULT_BYTES,
	DB_OWNER_MAX_WORK_UNITS,
} from "./db-owner-protocol";

export type { DbOwnerLane, DbOwnerRequest, DbOwnerWorkloadClass } from "./db-owner-protocol";

export type DbOwnerHealthState = "starting" | "ready" | "dead" | "failed" | "closed";
export type DbOwnerInitializationState = "not_started" | "running" | "ready" | "failed";

/** Keep owner admission bounded like the Phase B async database queues. */
export const MAX_DB_OWNER_PENDING_JOBS = DB_OWNER_MAX_QUEUE_DEPTH;
/** Each scheduling class has its own bounded admission queue. */
export const MAX_DB_OWNER_FOREGROUND_JOBS = DB_OWNER_MAX_QUEUE_DEPTH;
export const MAX_DB_OWNER_MAINTENANCE_JOBS = DB_OWNER_MAX_QUEUE_DEPTH;
export const MAX_DB_OWNER_WORK_UNITS = DB_OWNER_MAX_WORK_UNITS;
export const MAX_DB_OWNER_DEADLINE_MS = DB_OWNER_MAX_DEADLINE_MS;
export const MAX_DB_OWNER_RESULT_BYTES = DB_OWNER_MAX_RESULT_BYTES;
const dbOwnerWallClockNow = Date.now.bind(Date);

export interface DbOwnerLaneHealth {
	readonly state: DbOwnerHealthState;
	readonly pid: number | null;
	readonly generation: number;
	readonly queuedJobs: number;
	readonly activeJobId: string | null;
	readonly activeWorkloadClass: DbOwnerWorkloadClass | null;
	readonly foregroundQueuedJobs: number;
	readonly maintenanceQueuedJobs: number;
	readonly foregroundOldestAgeMs: number | null;
	readonly maintenanceOldestAgeMs: number | null;
	readonly lastError: string | null;
}

export interface DbOwnerHealth {
	/** Process/IPC state. `ready` means transport is usable, not schema-ready. */
	readonly state: DbOwnerHealthState;
	/** State of the explicit database initialization job. */
	readonly initialization: DbOwnerInitializationState;
	readonly databaseReady: boolean;
	readonly pid: number | null;
	readonly generation: number;
	readonly queuedJobs: number;
	readonly foregroundQueuedJobs: number;
	readonly maintenanceQueuedJobs: number;
	readonly activeJobId: string | null;
	readonly activeWorkloadClass: DbOwnerWorkloadClass | null;
	readonly foregroundOldestAgeMs: number | null;
	readonly maintenanceOldestAgeMs: number | null;
	/** Per-owner-lane snapshot; present on the aggregate client health surface. */
	readonly lanes?: {
		readonly read: DbOwnerLaneHealth;
		readonly write: DbOwnerLaneHealth;
		readonly maintenance: DbOwnerLaneHealth;
	};
	readonly lastError: string | null;
}

export interface DbOwnerSubmitOptions {
	readonly operation: string;
	readonly lane: DbOwnerLane;
	/** Defaults to foreground for read/write and maintenance for maintenance lane. */
	readonly workloadClass?: DbOwnerWorkloadClass;
	readonly deadlineMs: number;
	readonly estimatedWorkUnits?: number;
}

export interface DbOwnerJobHandle<Result> {
	readonly job: DbOwnerJob;
	readonly result: Promise<Result>;
	/** Resolves with owner-side execution timing when the job completes. */
	readonly metrics?: Promise<DbOwnerJobMetrics | undefined>;
	readonly cancel: () => void;
}

export interface DbOwnerInitializationResult {
	readonly initialized: true;
	readonly pendingVecBackfill: boolean;
	/** sqlite-vec path resolved in the owner process, if available. */
	readonly extensionPath?: string | null;
	readonly deferredMigrationVerification?: boolean;
}

export interface DbOwnerClient {
	start(): Promise<void>;
	initialize(agentsDir?: string): Promise<DbOwnerInitializationResult>;
	submit<Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result>;
	/** Fail closed on every non-read lane, including owners spawned later. */
	setWriteBlocked(blocked: boolean): void;
	awaitResult<Result>(handle: DbOwnerJobHandle<Result>, timeoutMs?: number): Promise<Result>;
	cancel(jobId: string): void;
	health(): DbOwnerHealth;
	close(): Promise<void>;
}

export class DbOwnerError extends Error {
	readonly code: string | number;
	readonly sqliteCode?: string | number;
	readonly causeFamily?: DbOwnerFailureCause;

	constructor(code: string | number, message: string, causeFamily?: DbOwnerFailureCause, sqliteCode?: string | number) {
		super(message);
		this.name = "DbOwnerError";
		this.code = code;
		this.sqliteCode = sqliteCode;
		this.causeFamily = causeFamily;
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
	constructor(
		message = "DB owner process died; pending jobs failed closed",
		code: string | number = "DB_OWNER_DIED",
		causeFamily?: DbOwnerFailureCause,
		sqliteCode?: string | number,
	) {
		super(code, message, causeFamily, sqliteCode);
		this.name = "DbOwnerDiedError";
	}
}

export class DbOwnerAdmissionError extends DbOwnerError {
	constructor(code: "DB_OWNER_QUEUE_FULL" | "DB_OWNER_WORK_BUDGET", message: string) {
		super(code, message);
		this.name = "DbOwnerAdmissionError";
	}
}

export class DbOwnerWritesBlockedError extends DbOwnerError {
	constructor() {
		super("DB_OWNER_WRITES_BLOCKED", "DB owner writes are blocked while database integrity is unresolved");
		this.name = "DbOwnerWritesBlockedError";
	}
}

interface PendingJob<Result> {
	readonly job: DbOwnerJob;
	readonly resolve: (value: Result | PromiseLike<Result>) => void;
	readonly reject: (reason?: unknown) => void;
	readonly timer: ReturnType<typeof setTimeout>;
	readonly resolveMetrics: (value: DbOwnerJobMetrics | undefined) => void;
	settled: boolean;
	dispatched: boolean;
}

export interface DbOwnerClientOptions {
	readonly dbPath: string;
	readonly workerPath?: string;
	/** SQLite runtime library to activate before the worker opens the database. */
	readonly sqlitePath?: string;
	readonly startupTimeoutMs?: number;
	readonly workerRole?: "generic" | "recall";
}

const DEFAULT_DB_OWNER_START_TIMEOUT_MS = 15_000;
export const DB_OWNER_CANCEL_REGISTRY_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const CANCEL_REGISTRY_PREFIX = ".db-owner-cancel-";

function sweepStaleCancellationRegistries(directory: string): void {
	const cutoff = Date.now() - DB_OWNER_CANCEL_REGISTRY_MAX_AGE_MS;
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(CANCEL_REGISTRY_PREFIX)) continue;
		const path = join(directory, entry);
		try {
			if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
		} catch {
			// Another client may have removed the registry concurrently.
		}
	}
}

function resolveStartupTimeoutMs(options: DbOwnerClientOptions): number {
	const configured = options.startupTimeoutMs ?? process.env.SIGNET_DB_OWNER_START_TIMEOUT_MS;
	const timeoutMs = configured === undefined ? DEFAULT_DB_OWNER_START_TIMEOUT_MS : Number(configured);
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new DbOwnerError(
			"DB_OWNER_START_TIMEOUT_INVALID",
			"DB owner startup timeout must be a positive integer in milliseconds",
		);
	}
	return timeoutMs;
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

function messageFromError(error: DbOwnerSerializedError): DbOwnerError {
	return new DbOwnerError(error.code ?? error.name, error.message, error.causeFamily, error.sqliteCode);
}

function oldestAge(first: number | null, second: number | null): number | null {
	if (first === null) return second;
	if (second === null) return first;
	return Math.max(first, second);
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
	let initialization: DbOwnerInitializationState = "not_started";
	let sequence = 0;
	let input = "";
	let stderr = "";
	let writeBlocked = false;
	sweepStaleCancellationRegistries(dirname(options.dbPath));
	const cancellationRegistryPath = join(
		dirname(options.dbPath),
		`${CANCEL_REGISTRY_PREFIX}${process.pid}-${randomUUID()}`,
	);
	const pending = new Map<string, PendingJob<unknown>>();
	const abandonedMetrics = new Map<string, (value: DbOwnerJobMetrics | undefined) => void>();

	function unlinkCancellationRegistry(): void {
		try {
			unlinkSync(cancellationRegistryPath);
		} catch {
			// The registry may not have been created or may already be gone.
		}
	}

	function recordCancellation(jobId: string): void {
		try {
			appendFileSync(cancellationRegistryPath, `${jobId}\n`);
		} catch {
			// The protocol cancel command remains the fallback for queued jobs.
		}
	}

	function diagnostic(message: string): string {
		return stderr.trim().length === 0 ? message : `${message}; child stderr: ${stderr.trim()}`;
	}

	function currentHealth(): DbOwnerHealth {
		const now = dbOwnerWallClockNow();
		const jobs = [...pending.values()].filter((entry) => entry.job.id !== activeJobId);
		const count = (workloadClass: DbOwnerWorkloadClass): number =>
			jobs.filter((entry) => entry.job.workloadClass === workloadClass).length;
		const oldestAge = (workloadClass: DbOwnerWorkloadClass): number | null => {
			const oldest = jobs
				.filter((entry) => entry.job.workloadClass === workloadClass)
				.reduce<number | null>(
					(value, entry) => (value === null ? entry.job.enqueuedAt : Math.min(value, entry.job.enqueuedAt)),
					null,
				);
			return oldest === null ? null : Math.max(0, now - oldest);
		};
		return {
			state,
			initialization,
			databaseReady: initialization === "ready",
			pid,
			generation,
			queuedJobs: jobs.length,
			foregroundQueuedJobs: count("foreground"),
			maintenanceQueuedJobs: count("maintenance"),
			activeJobId,
			activeWorkloadClass: activeJobId === null ? null : (pending.get(activeJobId)?.job.workloadClass ?? null),
			foregroundOldestAgeMs: oldestAge("foreground"),
			maintenanceOldestAgeMs: oldestAge("maintenance"),
			lastError,
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
		if (activeJobId === jobId) activeJobId = null;
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
		if (initialization === "running") initialization = "failed";
		const rejectStartup = startupReject;
		startupResolve = null;
		startupReject = null;
		rejectStartup?.(error);
		if (!closed) rejectAll(error, dispatchedOnly);
		for (const resolveMetrics of abandonedMetrics.values()) resolveMetrics(undefined);
		abandonedMetrics.clear();
		unlinkCancellationRegistry();
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
			void write(owner, { type: "set_write_blocked", blocked: writeBlocked }).catch((error: unknown) => {
				if (child !== owner || closed) return;
				retireOwner(error instanceof Error ? error : new Error(String(error)), owner, "dead", true);
			});
			startupResolve?.();
			startupResolve = null;
			startupReject = null;
			return;
		}
		if (event.type === "started") {
			if (pending.has(event.jobId)) activeJobId = event.jobId;
			return;
		}
		if (event.type === "fatal") {
			const fatalError = messageFromError(event.error);
			retireOwner(
				new DbOwnerDiedError(fatalError.message, fatalError.code, fatalError.causeFamily, fatalError.sqliteCode),
				owner,
				"failed",
				true,
			);
			return;
		}
		const pendingJob = pending.get(event.jobId);
		pendingJob?.resolveMetrics(event.metrics);
		const abandonedResolveMetrics = abandonedMetrics.get(event.jobId);
		if (abandonedResolveMetrics !== undefined) {
			abandonedMetrics.delete(event.jobId);
			abandonedResolveMetrics(event.metrics);
		}
		if (pendingJob?.job.request.kind === "initialize") {
			initialization = event.outcome === "completed" ? "ready" : "failed";
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

	function handleExit(owner: ChildProcess, code: number | null, signal: NodeJS.Signals | null, detail?: string): void {
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
			new DbOwnerDiedError(detail === undefined ? diagnostic(message) : `${message}; child stderr: ${detail}`),
			owner,
			state === "starting" || state === "failed" ? "failed" : "dead",
			true,
		);
	}

	function handleTransportError(owner: ChildProcess, error: Error): void {
		if (child !== owner || closed) return;
		// Node can report the pipe error before the stderr readable has emitted
		// its final queued chunk. Defer retirement until the current I/O turn has
		// drained so transport diagnostics retain the same stderr context as the
		// close and timeout paths.
		setImmediate(() => {
			if (child !== owner || closed) return;
			const message = error.message;
			retireOwner(
				new DbOwnerDiedError(stderr.trim().length === 0 ? message : `${message}; child stderr: ${stderr.trim()}`),
				owner,
				state === "starting" ? "failed" : "dead",
				true,
			);
		});
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
		const timeoutMs = resolveStartupTimeoutMs(options);
		state = "starting";
		lastError = null;
		stderr = "";
		generation++;
		startPromise = new Promise<void>((resolve, reject) => {
			startupResolve = resolve;
			startupReject = reject;
			const workerEnv: NodeJS.ProcessEnv = {
				...process.env,
				SIGNET_DB_OWNER_DB_PATH: options.dbPath,
				SIGNET_DB_OWNER_WORKER: "1",
				...(options.sqlitePath === undefined ? {} : { SIGNET_DB_OWNER_SQLITE_PATH: options.sqlitePath }),
				...(options.workerRole === "recall" ? { SIGNET_DB_OWNER_RECALL_WORKER: "1" } : {}),
				SIGNET_DB_OWNER_CANCEL_REGISTRY: cancellationRegistryPath,
			};
			// A compiled daemon sets this marker so the native entrypoint dispatches
			// into the daemon. It must not leak into the worker child: the worker
			// marker is the authoritative dispatch selector for this process.
			delete workerEnv.SIGNET_DAEMON_ENTRYPOINT;
			const owner = spawn(process.execPath, workerArguments(options.workerPath), {
				env: workerEnv,
				stdio: ["pipe", "pipe", "pipe"],
			});
			child = owner;
			const appendStderr = (chunk: string): void => {
				stderr = `${stderr}${chunk}`.slice(-8_192);
			};
			owner.stdout?.setEncoding("utf8");
			owner.stdout?.on("data", (chunk: string) => handleStdout(owner, chunk));
			owner.stdin?.on("error", (error: Error) => handleTransportError(owner, error));
			owner.stderr?.setEncoding("utf8");
			owner.stderr?.on("data", appendStderr);
			owner.once("error", (error: Error) => handleTransportError(owner, error));
			owner.once("close", (code, signal) => handleExit(owner, code, signal, stderr.trim() || undefined));
			const timer = setTimeout(() => {
				if (state !== "ready") {
					const error = new DbOwnerError(
						"DB_OWNER_START_TIMEOUT",
						diagnostic(`DB owner did not become ready within ${timeoutMs}ms`),
					);
					retireOwner(error, owner, "failed", true);
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
						if (child !== owner || closed) return;
						const transportError = error instanceof Error ? error : new Error(String(error));
						retireOwner(transportError, owner, state === "starting" ? "failed" : "dead", true);
						if (child === owner || pending.get(jobId)?.settled === true) return;
						dispatch(jobId);
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
		if (writeBlocked && submitOptions.lane !== "read" && submitOptions.lane !== "verify")
			throw new DbOwnerWritesBlockedError();
		if (!Number.isFinite(submitOptions.deadlineMs) || submitOptions.deadlineMs <= 0) {
			throw new RangeError("DB owner deadlineMs must be a positive finite number");
		}
		const maxDeadlineMs =
			submitOptions.lane === "maintenance" || submitOptions.lane === "verify"
				? DB_OWNER_MAX_MAINTENANCE_DEADLINE_MS
				: MAX_DB_OWNER_DEADLINE_MS;
		if (submitOptions.deadlineMs > maxDeadlineMs) {
			throw new DbOwnerAdmissionError(
				"DB_OWNER_WORK_BUDGET",
				`DB owner deadlineMs exceeds the ${maxDeadlineMs}ms admission limit for the ${submitOptions.lane} lane`,
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
		const workloadClass =
			submitOptions.workloadClass ??
			(submitOptions.lane === "maintenance" || submitOptions.lane === "verify" ? "maintenance" : "foreground");
		const classJobs = [...pending.values()].filter((entry) => entry.job.workloadClass === workloadClass).length;
		const maxClassJobs = workloadClass === "foreground" ? MAX_DB_OWNER_FOREGROUND_JOBS : MAX_DB_OWNER_MAINTENANCE_JOBS;
		if (classJobs >= maxClassJobs) {
			throw new DbOwnerAdmissionError(
				"DB_OWNER_QUEUE_FULL",
				`DB owner ${workloadClass} admission queue is full at ${maxClassJobs} pending jobs`,
			);
		}
		const now = dbOwnerWallClockNow();
		const job: DbOwnerJob = {
			id: `db-owner-${process.pid}-${++sequence}`,
			operation: submitOptions.operation,
			lane: submitOptions.lane,
			...(submitOptions.lane === "verify" ? { allowWriteBlocked: true } : {}),
			workloadClass,
			enqueuedAt: now,
			deadlineAt: now + submitOptions.deadlineMs,
			estimatedWorkUnits,
			cancellation: "pending",
			request,
		};
		let pendingJob: PendingJob<Result> | null = null;
		let resolveMetrics: (value: DbOwnerJobMetrics | undefined) => void = () => {};
		const metrics = new Promise<DbOwnerJobMetrics | undefined>((resolve) => {
			resolveMetrics = resolve;
		});
		const result = new Promise<Result>((resolve, reject) => {
			const timer = setTimeout(() => {
				const entry = pending.get(job.id);
				if (entry === undefined || entry.settled) return;
				lastError = `deadline exceeded for ${job.id}`;
				const owner = child;
				const dispatched = entry.dispatched;
				settle(job.id, (settledJob) => {
					if (dispatched) abandonedMetrics.set(job.id, settledJob.resolveMetrics);
					if (!settledJob.settled) {
						settledJob.settled = true;
						settledJob.reject(new DbOwnerDeadlineError(job.id));
					}
				});
				// A job deadline abandons the work; it is not authority to kill the
				// owner. The owner may still be finishing a synchronous operation,
				// but interactive work is admitted through a separate owner below.
				// This preserves the owner process and lets the worker consume the
				// cancellation when the job is still queued.
				if (dispatched && owner !== null && state === "ready") {
					void write(owner, { type: "cancel", jobId: job.id }).catch(() => {
						// A transport failure is handled by the owner exit path.
					});
				}
			}, submitOptions.deadlineMs);
			pendingJob = { job, resolve, reject, timer, resolveMetrics, settled: false, dispatched: false };
			pending.set(job.id, pendingJob as PendingJob<unknown>);
			if (request.kind === "initialize") initialization = "running";
			dispatch(job.id);
		});
		return { job, result, metrics, cancel: () => cancel(job.id) };
	}

	function cancel(jobId: string): void {
		const entry = pending.get(jobId);
		if (entry === undefined || entry.settled) return;
		const active = activeJobId === jobId;
		recordCancellation(jobId);
		if (active) {
			// Active jobs must finish in the owner so a cancellation that arrives
			// during SQLite COMMIT can report the durable outcome accurately. The
			// worker fences the transaction before COMMIT and reads this registry
			// after COMMIT; queued jobs still use the protocol cancel command.
			return;
		}
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

	function setWriteBlocked(blocked: boolean): void {
		writeBlocked = blocked;
		if (blocked) {
			// Do not leave already-admitted application writes queued behind the
			// control message. Read and verification jobs remain available for
			// recovery/status surfaces.
			for (const entry of [...pending.values()]) {
				if (entry.job.lane !== "read" && entry.job.lane !== "verify") cancel(entry.job.id);
			}
		}
		if (state !== "ready" || child === null) return;
		const owner = child;
		void write(owner, { type: "set_write_blocked", blocked }).catch((error: unknown) => {
			if (child !== owner || closed) return;
			retireOwner(error instanceof Error ? error : new Error(String(error)), owner, "dead", true);
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
		try {
			unlinkSync(cancellationRegistryPath);
		} catch {
			// The registry may not have been created or may already be gone.
		}
	}

	async function initialize(agentsDir?: string): Promise<DbOwnerInitializationResult> {
		const handle = submit<DbOwnerInitializationResult>(
			{ kind: "initialize", agentsDir },
			{ operation: "db.initialize", lane: "maintenance", deadlineMs: 60_000, estimatedWorkUnits: 10_000 },
		);
		return await awaitResult<DbOwnerInitializationResult>(handle, 60_000);
	}

	return { start, initialize, submit, setWriteBlocked, awaitResult, cancel, health: currentHealth, close };
}

/**
 * Keep recall independent from serial writes and maintenance. Each lane owns
 * its own SQLite connection and FIFO queue. Read jobs therefore cannot wait
 * behind a synchronous maintenance job, while writes and maintenance remain
 * serialized on one owner connection.
 */
export function createDbOwnerClient(options: DbOwnerClientOptions): DbOwnerClient {
	const readLane = createSingleDbOwnerClient(options);
	// Interactive writes must never share the maintenance owner. Queue priority
	// inside one saturated child is not capacity reservation: a synchronous
	// maintenance job can still hold that child and its SQLite connection.
	const writeLane = options.workerRole === "recall" ? readLane : createSingleDbOwnerClient(options);
	const maintenanceLane = options.workerRole === "recall" ? readLane : createSingleDbOwnerClient(options);
	let closed = false;

	function laneFor(requestLane: DbOwnerLane, workloadClass?: DbOwnerWorkloadClass): DbOwnerClient {
		if (workloadClass === "maintenance" || requestLane === "maintenance" || requestLane === "verify")
			return maintenanceLane;
		return requestLane === "read" ? readLane : writeLane;
	}

	function toLaneHealth(lane: DbOwnerHealth): DbOwnerLaneHealth {
		return {
			state: lane.state,
			pid: lane.pid,
			generation: lane.generation,
			queuedJobs: lane.queuedJobs,
			activeJobId: lane.activeJobId,
			activeWorkloadClass: lane.activeWorkloadClass,
			foregroundQueuedJobs: lane.foregroundQueuedJobs,
			maintenanceQueuedJobs: lane.maintenanceQueuedJobs,
			foregroundOldestAgeMs: lane.foregroundOldestAgeMs,
			maintenanceOldestAgeMs: lane.maintenanceOldestAgeMs,
			lastError: lane.lastError,
		};
	}

	function health(): DbOwnerHealth {
		const read = readLane.health();
		const write = writeLane.health();
		const maintenance = maintenanceLane.health();
		const state: DbOwnerHealthState =
			read.state === "closed" && write.state === "closed" && maintenance.state === "closed"
				? "closed"
				: read.state === "failed" || write.state === "failed" || maintenance.state === "failed"
					? "failed"
					: (read.state === "dead" && read.generation > 0) ||
							(write.state === "dead" && write.generation > 0) ||
							(maintenance.state === "dead" && maintenance.generation > 0)
						? "dead"
						: read.state === "starting" || write.state === "starting" || maintenance.state === "starting"
							? "starting"
							: read.state === "ready" || write.state === "ready" || maintenance.state === "ready"
								? "ready"
								: "dead";
		return {
			state,
			initialization: maintenance.initialization,
			databaseReady: maintenance.databaseReady,
			pid: read.pid ?? write.pid ?? maintenance.pid,
			generation: Math.max(read.generation, write.generation, maintenance.generation),
			queuedJobs: read.queuedJobs + write.queuedJobs + maintenance.queuedJobs,
			foregroundQueuedJobs: read.foregroundQueuedJobs + write.foregroundQueuedJobs + maintenance.foregroundQueuedJobs,
			maintenanceQueuedJobs:
				read.maintenanceQueuedJobs + write.maintenanceQueuedJobs + maintenance.maintenanceQueuedJobs,
			activeJobId: read.activeJobId ?? write.activeJobId ?? maintenance.activeJobId,
			activeWorkloadClass: read.activeWorkloadClass ?? write.activeWorkloadClass ?? maintenance.activeWorkloadClass,
			foregroundOldestAgeMs: oldestAge(
				oldestAge(read.foregroundOldestAgeMs, write.foregroundOldestAgeMs),
				maintenance.foregroundOldestAgeMs,
			),
			maintenanceOldestAgeMs: oldestAge(read.maintenanceOldestAgeMs, maintenance.maintenanceOldestAgeMs),
			lanes: {
				read: toLaneHealth(read),
				write: toLaneHealth(write),
				maintenance: toLaneHealth(maintenance),
			},
			lastError: read.lastError ?? write.lastError ?? maintenance.lastError,
		};
	}

	return {
		async start(): Promise<void> {
			if (closed) throw new DbOwnerError("DB_OWNER_CLOSED", "DB owner client is closed");
			await Promise.all([readLane.start(), writeLane.start(), maintenanceLane.start()]);
		},
		async initialize(agentsDir?: string): Promise<DbOwnerInitializationResult> {
			return await maintenanceLane.initialize(agentsDir);
		},
		submit<Result>(request: DbOwnerRequest, submitOptions: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> {
			return laneFor(submitOptions.lane, submitOptions.workloadClass).submit<Result>(request, submitOptions);
		},
		setWriteBlocked(blocked: boolean): void {
			readLane.setWriteBlocked(blocked);
			if (writeLane !== readLane) writeLane.setWriteBlocked(blocked);
			if (maintenanceLane !== readLane && maintenanceLane !== writeLane) maintenanceLane.setWriteBlocked(blocked);
		},
		awaitResult<Result>(handle: DbOwnerJobHandle<Result>, timeoutMs?: number): Promise<Result> {
			return laneFor(handle.job.lane, handle.job.workloadClass).awaitResult(handle, timeoutMs);
		},
		cancel(jobId) {
			readLane.cancel(jobId);
			writeLane.cancel(jobId);
			maintenanceLane.cancel(jobId);
		},
		health,
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			const lanes = [readLane];
			if (writeLane !== readLane) lanes.push(writeLane);
			if (maintenanceLane !== readLane && maintenanceLane !== writeLane) lanes.push(maintenanceLane);
			await Promise.all(lanes.map((lane) => lane.close()));
		},
	};
}
