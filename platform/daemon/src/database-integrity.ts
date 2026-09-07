/**
 * Startup integrity checks for SQLite's derived database surfaces.
 *
 * `PRAGMA quick_check` deliberately does not validate every index/table
 * relationship. The telemetry table is append-only and its indexes are
 * disposable, so it gets a targeted full check and a transactional REINDEX
 * when SQLite reports an index mismatch.
 */

import { spawnHidden as spawn, type ChildProcess } from "@signet/core";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { DbOwnerDeadlineError, type DbOwnerClient } from "./db-owner-client";
import { ownerQueryAll, ownerRunStatement, ownerTransaction } from "./db-owner-maintenance";
import type { DbOwnerStatement } from "./db-owner-protocol";
import { logger } from "./logger";
import { resolveEmbeddedWorkerPath } from "./native-runtime-assets";

export type DatabaseIntegrityState = "unknown" | "healthy" | "repaired" | "corrupt" | "unavailable" | "degraded";

export interface DatabaseIntegrityProgress {
	readonly checkpointKey: string;
	readonly phase: "running" | "complete" | "cancelled" | "timed_out" | "unavailable" | "degraded";
	readonly checkedObjects: number;
	readonly failedObjects: number;
	readonly remainingObjects: number;
	readonly lastObject: string | null;
	readonly databasePagesObserved: number;
	readonly databaseBytesObserved: number;
	readonly elapsedMs: number;
	readonly ownerQueueAdmissionMs: number;
	readonly ownerExecutionMs: number;
	readonly cancellationReason: string | null;
	readonly degradationReason: string | null;
}

export interface IntegrityCheckStatus {
	readonly ok: boolean;
	readonly messages: readonly string[];
}

export interface DatabaseIntegrityStatus {
	readonly checkedAt: string;
	readonly state: DatabaseIntegrityState;
	readonly phase: "pending" | "running" | "complete" | "timed_out" | "degraded";
	readonly integrity: string | null;
	readonly quickCheck: IntegrityCheckStatus;
	readonly telemetryCheck: IntegrityCheckStatus;
	readonly rebuiltIndexes: readonly string[];
	readonly durationMs: number;
	readonly repairGuidance: string | null;
	readonly ownerState: string | null;
	readonly ownerGeneration: number | null;
	readonly incrementalProgress: DatabaseIntegrityProgress | null;
}

const UNKNOWN_CHECK: IntegrityCheckStatus = { ok: false, messages: ["not checked"] };
const REPAIR_GUIDANCE =
	"Stop the daemon, back up the database, and run the operator integrity repair flow before restarting.";
const INTEGRITY_CHILD_ENV_KEYS = [
	"BUN_INSPECT",
	"BUN_OPTIONS",
	"NODE_OPTIONS",
	"SIGNET_INSPECTOR_HANDOFF",
	"SIGNET_INSPECTOR_PUBLIC",
	"SIGNET_INSPECTOR_PROXY_PUBLIC",
	"SIGNET_INSPECTOR_PROXY_TARGET",
] as const;

/**
 * Integrity's direct-database compatibility path remains process-isolated:
 * SQLite work is synchronous and must be hard-killable at its deadline. It
 * deliberately admits one child at a time and does not queue callers. The
 * owner-routed production path below does not use this child at all.
 */
let integrityChildActive = false;

class IntegrityChildAdmissionError extends Error {
	readonly code = "INTEGRITY_CHILD_BUSY";

	constructor() {
		super("database integrity child is already running");
		this.name = "IntegrityChildAdmissionError";
	}
}

async function withIntegrityChildSlot<Result>(run: () => Promise<Result>): Promise<Result> {
	if (integrityChildActive) throw new IntegrityChildAdmissionError();
	integrityChildActive = true;
	try {
		return await run();
	} finally {
		integrityChildActive = false;
	}
}

function childHasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess): Promise<void> {
	if (childHasExited(child)) return Promise.resolve();
	return new Promise<void>((resolve) => {
		child.once("close", () => resolve());
		if (childHasExited(child)) resolve();
	});
}

async function terminateAndReapChild(child: ChildProcess, reaped: Promise<void>): Promise<void> {
	if (!childHasExited(child)) {
		try {
			child.kill("SIGKILL");
		} catch {
			// The child may have exited between the state check and kill.
		}
	}
	await reaped;
	// Let the runtime finish releasing stdio and native file handles after the
	// close event before another operation can touch the database path.
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function integrityChildEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
	for (const key of INTEGRITY_CHILD_ENV_KEYS) delete env[key];
	return env;
}

let latestStatus: DatabaseIntegrityStatus = {
	checkedAt: "",
	state: "unknown",
	phase: "pending",
	integrity: null,
	quickCheck: UNKNOWN_CHECK,
	telemetryCheck: UNKNOWN_CHECK,
	rebuiltIndexes: [],
	durationMs: 0,
	repairGuidance: null,
	ownerState: null,
	ownerGeneration: null,
	incrementalProgress: null,
};

type GlobalIntegrityState = "healthy" | "corrupt" | "unavailable" | "degraded";
let globalIntegrityState: GlobalIntegrityState | null = null;
let globalIntegrityMessage: string | null = null;
let incrementalIntegrityState: DatabaseIntegrityState = "unknown";
let incrementalIntegrityMessage: string | null = null;

const INTEGRITY_STATE_SEVERITY: Record<DatabaseIntegrityState, number> = {
	unknown: 0,
	healthy: 1,
	repaired: 1,
	degraded: 2,
	unavailable: 3,
	corrupt: 4,
};

function mergeIntegrityState(
	globalState: GlobalIntegrityState | null,
	incrementalState: DatabaseIntegrityState,
): DatabaseIntegrityState {
	if (globalState === null) return incrementalState;
	return INTEGRITY_STATE_SEVERITY[incrementalState] > INTEGRITY_STATE_SEVERITY[globalState]
		? incrementalState
		: globalState;
}

/** Clear the migration-wide latch after a confirmed clean global scan. */
export function resetGlobalIntegrityLatch(): void {
	globalIntegrityState = null;
	globalIntegrityMessage = null;
}

function check(db: ReadDb, pragma: "quick_check" | "integrity_check", table?: string): IntegrityCheckStatus {
	const sql = table === undefined ? `PRAGMA ${pragma}` : `PRAGMA ${pragma}(${table})`;
	const key = pragma === "quick_check" ? "quick_check" : "integrity_check";
	const rows = db.prepare(sql).all() as ReadonlyArray<Record<string, unknown>>;
	const messages = rows.map((row) => String(row[key] ?? ""));
	if (messages.length === 1 && messages[0] === "ok") return { ok: true, messages: [] };
	return { ok: false, messages };
}

function listTelemetryIndexes(db: ReadDb): readonly string[] {
	const rows = db
		.prepare(
			"SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'telemetry_events' AND sql IS NOT NULL ORDER BY name",
		)
		.all() as ReadonlyArray<{ name?: unknown }>;
	return rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : []));
}

function escapedIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

function statusWith(
	state: DatabaseIntegrityState,
	quickCheck: IntegrityCheckStatus,
	telemetryCheck: IntegrityCheckStatus,
	rebuiltIndexes: readonly string[],
	phase: DatabaseIntegrityStatus["phase"] = "complete",
	durationMs = 0,
	repairGuidance: string | null = state === "corrupt" || state === "unavailable" ? REPAIR_GUIDANCE : null,
	owner?: DbOwnerClient,
): DatabaseIntegrityStatus {
	const health = owner?.health();
	return {
		checkedAt: new Date().toISOString(),
		state,
		phase,
		integrity: null,
		quickCheck,
		telemetryCheck,
		rebuiltIndexes,
		durationMs,
		repairGuidance,
		ownerState: health?.state ?? null,
		ownerGeneration: health?.generation ?? null,
		incrementalProgress: null,
	};
}

/** Publish checkpointed integrity maintenance through the existing health surfaces. */
export function updateDatabaseIntegrityStatus(
	progress: DatabaseIntegrityProgress,
	errors: readonly string[] = [],
	owner?: DbOwnerClient,
): void {
	const health = owner?.health();
	const failed = progress.failedObjects > 0 || errors.length > 0;
	const operationalFailure = progress.phase === "unavailable" || progress.phase === "timed_out";
	const degraded = progress.phase === "degraded" || progress.degradationReason !== null;
	const state: DatabaseIntegrityState = operationalFailure
		? "unavailable"
		: degraded
			? "degraded"
			: failed
				? "corrupt"
				: progress.phase === "complete"
					? "healthy"
					: "unknown";
	const phase: DatabaseIntegrityStatus["phase"] =
		globalIntegrityState === "degraded"
			? "degraded"
			: progress.phase === "timed_out"
				? "timed_out"
				: progress.phase === "running"
					? "running"
					: progress.phase === "degraded"
						? "degraded"
						: "complete";
	const incrementalIntegrity =
		errors.length > 0
			? errors.join("; ")
			: degraded
				? progress.degradationReason
				: failed
					? "incremental integrity check failed"
					: operationalFailure
						? "incremental integrity check unavailable"
						: null;
	incrementalIntegrityState = state;
	incrementalIntegrityMessage = incrementalIntegrity;
	const publishedState = mergeIntegrityState(globalIntegrityState, incrementalIntegrityState);
	const globalStateWins =
		globalIntegrityState !== null &&
		INTEGRITY_STATE_SEVERITY[globalIntegrityState] >= INTEGRITY_STATE_SEVERITY[incrementalIntegrityState];
	latestStatus = {
		...latestStatus,
		checkedAt: new Date().toISOString(),
		state: publishedState,
		phase,
		integrity: globalStateWins ? globalIntegrityMessage : incrementalIntegrityMessage,
		quickCheck: failed
			? { ok: false, messages: errors.length > 0 ? errors : ["incremental integrity check failed"] }
			: globalStateWins
				? latestStatus.quickCheck
				: progress.phase === "complete"
					? { ok: true, messages: [] }
					: latestStatus.quickCheck,
		durationMs: progress.elapsedMs,
		repairGuidance: publishedState === "corrupt" || publishedState === "unavailable" ? REPAIR_GUIDANCE : null,
		ownerState: health?.state ?? latestStatus.ownerState,
		ownerGeneration: health?.generation ?? latestStatus.ownerGeneration,
		incrementalProgress: progress,
	};
}

/** Publish migration-wide integrity without replacing quick-check details. */
export function publishDatabaseIntegrityStatus(
	state: "healthy" | GlobalIntegrityState,
	messages: readonly string[] = [],
	owner?: DbOwnerClient,
): void {
	const shouldReplaceLatch =
		globalIntegrityState === null || INTEGRITY_STATE_SEVERITY[state] >= INTEGRITY_STATE_SEVERITY[globalIntegrityState];
	if (shouldReplaceLatch) {
		globalIntegrityState = state;
		globalIntegrityMessage =
			messages.length > 0
				? messages.join("; ")
				: state === "degraded"
					? "degraded:integrity-unverified"
					: state === "healthy"
						? null
						: "global integrity check failed";
	}
	const latchedState = globalIntegrityState ?? state;
	const publishedState = mergeIntegrityState(latchedState, incrementalIntegrityState);
	const globalStateWins = INTEGRITY_STATE_SEVERITY[latchedState] >= INTEGRITY_STATE_SEVERITY[incrementalIntegrityState];
	const health = owner?.health();
	latestStatus = {
		...latestStatus,
		checkedAt: new Date().toISOString(),
		state: publishedState,
		phase: publishedState === "degraded" ? "degraded" : "complete",
		integrity: globalStateWins ? globalIntegrityMessage : incrementalIntegrityMessage,
		repairGuidance: publishedState === "corrupt" || publishedState === "unavailable" ? REPAIR_GUIDANCE : null,
		ownerState: health?.state ?? latestStatus.ownerState,
		ownerGeneration: health?.generation ?? latestStatus.ownerGeneration,
	};
}

/** Return the last startup integrity result without touching SQLite. */
export function getDatabaseIntegrityStatus(): DatabaseIntegrityStatus {
	return latestStatus;
}

export type TelemetryIndexRepairAudit = (
	db: WriteDb,
	indexes: readonly string[],
	detectionMessages: readonly string[],
) => void;

export interface DatabaseIntegrityWorkerResult {
	readonly quickCheck: IntegrityCheckStatus;
}

export interface DatabaseIntegrityWorkerMessage {
	readonly type: "result";
	readonly result: DatabaseIntegrityWorkerResult;
}

function ownerCheck(rows: readonly Record<string, unknown>[], key: string): IntegrityCheckStatus {
	const messages = rows.map((row) => String(row[key] ?? ""));
	if (messages.length === 1 && messages[0] === "ok") return { ok: true, messages: [] };
	return { ok: false, messages };
}

export interface DeferredIntegrityCheckOptions {
	readonly workerPath?: string;
	readonly timeoutMs?: number;
	readonly ownerTimeoutMs?: number;
	readonly audit?: TelemetryIndexRepairAudit;
	readonly onWorkerStarted?: () => void;
	readonly owner?: DbOwnerClient;
	readonly ownerAudit?: (
		indexes: readonly string[],
		detectionMessages: readonly string[],
	) => readonly DbOwnerStatement[];
}

const DEFAULT_INTEGRITY_TIMEOUT_MS = 30_000;
let deferredIntegrityRun: Promise<DatabaseIntegrityStatus> | null = null;

class IntegrityRepairTimeoutError extends Error {
	readonly timedOut = true;

	constructor(timeoutMs: number) {
		super(`telemetry index repair exceeded ${timeoutMs}ms`);
		this.name = "IntegrityRepairTimeoutError";
	}
}

class IntegrityCheckTimeoutError extends Error {
	readonly timedOut = true;

	constructor(timeoutMs: number) {
		super(`database integrity check exceeded ${timeoutMs}ms`);
		this.name = "IntegrityCheckTimeoutError";
	}
}

interface KillableChildOutput {
	readonly stdout: string;
	readonly stderr: string;
}

interface KillableChildOptions {
	readonly executable: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
	readonly timeoutMs: number;
	readonly timeoutError: () => Error;
	readonly onLine?: (line: string) => boolean;
	readonly errorMessage?: (code: number | null, stderr: string) => string;
}

/** Run a synchronous child with one timeout/reap path for all integrity phases. */
async function runKillableChild(options: KillableChildOptions): Promise<KillableChildOutput> {
	const child = spawn(options.executable, [...options.args], {
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const reaped = waitForChildExit(child);
	let stopPromise: Promise<void> | undefined;
	const stop = (): Promise<void> => {
		if (stopPromise !== undefined) return stopPromise;
		stopPromise = terminateAndReapChild(child, reaped);
		return stopPromise;
	};
	try {
		return await new Promise<KillableChildOutput>((resolve, reject) => {
			let settled = false;
			let stdout = "";
			let stdoutBuffer = "";
			let stderr = "";
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				void stop().then(
					() => reject(options.timeoutError()),
					(error) => reject(error),
				);
			}, options.timeoutMs);
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			};
			const complete = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve({ stdout, stderr });
			};
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
				stdoutBuffer += chunk;
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) {
					if (line.length === 0) continue;
					try {
						if (options.onLine?.(line) === true) complete();
					} catch (error: unknown) {
						fail(error instanceof Error ? error : new Error(String(error)));
					}
					if (settled) return;
				}
			});
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.once("error", fail);
			child.once("close", (code) => {
				if (settled) return;
				clearTimeout(timer);
				if (code !== 0) {
					fail(
						new Error(options.errorMessage?.(code, stderr) ?? `integrity child exited with code ${code ?? "unknown"}`),
					);
					return;
				}
				if (options.onLine !== undefined) {
					fail(new Error("integrity child exited without a result"));
					return;
				}
				complete();
			});
			child.stderr?.resume();
		});
	} finally {
		await stop();
	}
}

async function runIntegrityWorkerCheck(
	dbPath: string,
	timeoutMs: number,
	options: Partial<DeferredIntegrityCheckOptions>,
): Promise<DatabaseIntegrityWorkerResult> {
	return await withIntegrityChildSlot(async () => {
		const startedAt = Date.now();
		const embeddedWorkerPath = resolveEmbeddedWorkerPath("database-integrity-worker");
		const workerPath = options.workerPath ?? embeddedWorkerPath ?? workerPathFromModule();
		const workerArgs = options.workerPath === undefined && embeddedWorkerPath !== null ? [] : [workerPath];
		let result: DatabaseIntegrityWorkerResult | undefined;
		await runKillableChild({
			executable: process.execPath,
			args: workerArgs,
			env: integrityChildEnv({ SIGNET_DATABASE_INTEGRITY_DB_PATH: dbPath }),
			timeoutMs,
			timeoutError: () => new IntegrityCheckTimeoutError(timeoutMs),
			onLine: (line) => {
				if (line === "started") {
					options.onWorkerStarted?.();
					return false;
				}
				try {
					const message = JSON.parse(line) as DatabaseIntegrityWorkerMessage;
					if (message.type !== "result") return false;
					result = message.result;
					return true;
				} catch {
					return false;
				}
			},
		});
		if (result === undefined) throw new Error("database integrity worker exited without a result");
		logger.info("startup-recovery", "Database integrity check complete", { elapsedMs: Date.now() - startedAt });
		return result;
	});
}

const REPAIR_BUSY_TIMEOUT_MS = 5_000;
const REPAIR_BUSY_RETRIES = 3;
const REPAIR_BUSY_BACKOFF_MS = 50;

const REPAIR_WORKER_SOURCE = `
import { createRequire } from "node:module";
const load = createRequire(process.env.SIGNET_DATABASE_INTEGRITY_REQUIRE_BASE || process.cwd() + "/package.json");
const Database = (() => {
  if (typeof Bun !== "undefined") return load("bun:sqlite").Database;
  try { return load("node:sqlite").DatabaseSync; } catch { return load("better-sqlite3"); }
})();
const dbPath = process.env.SIGNET_DATABASE_INTEGRITY_DB_PATH;
const indexes = JSON.parse(process.env.SIGNET_DATABASE_INTEGRITY_INDEXES || "[]");
if (typeof dbPath !== "string" || !Array.isArray(indexes)) throw new Error("invalid integrity repair arguments");
const escaped = (name) => '"' + String(name).replaceAll('"', '""') + '"';
const database = typeof Bun === "undefined"
  ? new Database(dbPath, { timeout: ${REPAIR_BUSY_TIMEOUT_MS} })
  : new Database(dbPath);
database.exec("PRAGMA busy_timeout = ${REPAIR_BUSY_TIMEOUT_MS}");
const isBusyError = (error) => {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_BUSY" || message.includes("SQLITE_BUSY") || message.includes("database is locked");
};
const wait = (milliseconds) => {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
};
const repair = () => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      database.exec("BEGIN IMMEDIATE");
      for (const index of indexes) database.exec("REINDEX " + escaped(index));
      database.exec("COMMIT");
      return;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      if (!isBusyError(error) || attempt >= ${REPAIR_BUSY_RETRIES}) throw error;
      wait(${REPAIR_BUSY_BACKOFF_MS} * 2 ** attempt);
    }
  }
};
try {
  repair();
  process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
} catch (error) {
  try { database.exec("ROLLBACK"); } catch {}
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  database.close();
}
`;

function workerPathFromModule(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const bundled = join(moduleDir, "database-integrity-worker.js");
	if (existsSync(bundled)) return bundled;
	return join(moduleDir, "database-integrity-worker.ts");
}

async function runOwnerIntegrityCheck(
	owner: DbOwnerClient,
	deadlineMs: number,
): Promise<DatabaseIntegrityWorkerResult> {
	const rows = await ownerQueryAll<Record<string, unknown>>(owner, "integrity.quick-check", "PRAGMA quick_check", [], {
		deadlineMs,
	});
	return { quickCheck: ownerCheck(rows, "quick_check") };
}

async function runKillableTelemetryRepair(
	dbPath: string,
	indexes: readonly string[],
	timeoutMs: number,
	workerPath?: string,
	runtimePath?: string,
	requireBase?: string,
): Promise<void> {
	return await withIntegrityChildSlot(async () => {
		const dir = workerPath === undefined ? await mkdtemp(join(tmpdir(), "signet-integrity-repair-")) : null;
		const scriptPath = workerPath ?? join(dir ?? tmpdir(), "repair.mjs");
		try {
			if (workerPath === undefined) await writeFile(scriptPath, REPAIR_WORKER_SOURCE, "utf8");
			const output = await runKillableChild({
				executable: runtimePath ?? process.execPath,
				args: [scriptPath],
				env: integrityChildEnv({
					SIGNET_DATABASE_INTEGRITY_DB_PATH: dbPath,
					SIGNET_DATABASE_INTEGRITY_INDEXES: JSON.stringify(indexes),
					SIGNET_DATABASE_INTEGRITY_REQUIRE_BASE: requireBase ?? fileURLToPath(import.meta.url),
				}),
				timeoutMs,
				timeoutError: () => new IntegrityRepairTimeoutError(timeoutMs),
				errorMessage: (code, stderr) => {
					const detail = stderr.trim();
					return `telemetry index repair worker exited with code ${code ?? "unknown"}${detail.length > 0 ? `: ${detail}` : ""}`;
				},
			});
			const result = JSON.parse(output.stdout.trim()) as { ok?: unknown };
			if (result.ok !== true) throw new Error("telemetry index repair worker returned an invalid result");
		} finally {
			if (dir !== null) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
		}
	});
}

async function writeAsync<Result>(accessor: DbAccessor, processBatch: (db: WriteDb) => Result): Promise<Result> {
	return accessor.withWriteTxAsync(processBatch, { siteToken: "db:database.integrity.write" });
}

/**
 * Run the global quick_check away from Bun's main event loop after readiness.
 * The scan runs in a child process because SQLite's synchronous PRAGMA cannot
 * observe Worker.terminate() while native code is running. A child process can
 * be SIGKILLed at the deadline, so the budget is a real upper bound.
 */
export function runDeferredIntegrityCheck(
	accessor: DbAccessor,
	dbPath: string,
	options: Partial<DeferredIntegrityCheckOptions> = {},
): Promise<DatabaseIntegrityStatus> {
	if (deferredIntegrityRun !== null) return deferredIntegrityRun;
	const run = runDeferredIntegrityCheckInternal(accessor, dbPath, options);
	deferredIntegrityRun = run;
	const clear = (): void => {
		if (deferredIntegrityRun === run) deferredIntegrityRun = null;
	};
	run.then(clear, clear);
	return run;
}

async function runOwnerDeferredIntegrityCheck(
	accessor: DbAccessor,
	options: Partial<DeferredIntegrityCheckOptions>,
): Promise<DatabaseIntegrityStatus> {
	const owner = options.owner;
	if (owner === undefined) throw new Error("owner integrity check requires a DB owner");
	const timeoutMs = options.timeoutMs ?? DEFAULT_INTEGRITY_TIMEOUT_MS;
	const ownerTimeoutMs = options.ownerTimeoutMs ?? Math.min(timeoutMs, DEFAULT_INTEGRITY_TIMEOUT_MS);
	const startedAt = Date.now();
	latestStatus = statusWith("unknown", UNKNOWN_CHECK, UNKNOWN_CHECK, [], "running", 0, null, owner);
	logger.info("startup-recovery", "Deferred database integrity check started through the DB owner", {
		timeoutMs,
		ownerTimeoutMs,
	});
	const progressTimer = setInterval(() => {
		const health = owner.health();
		logger.info("startup-recovery", "Database integrity owner work in progress", {
			elapsedMs: Date.now() - startedAt,
			budgetMs: ownerTimeoutMs,
			ownerState: health.state,
			ownerGeneration: health.generation,
		});
	}, 1_000);
	try {
		const result = await runOwnerIntegrityCheck(owner, ownerTimeoutMs);
		const status = await repairTelemetryIndexes(accessor, options.audit, {
			quickCheck: result.quickCheck,
			repairTimeoutMs: ownerTimeoutMs,
			owner,
			ownerAudit: options.ownerAudit,
		});
		latestStatus = { ...status, durationMs: Date.now() - startedAt };
		logger.info("startup-recovery", "Deferred database integrity check complete through the DB owner", {
			state: latestStatus.state,
			durationMs: latestStatus.durationMs,
			ownerState: latestStatus.ownerState,
			ownerGeneration: latestStatus.ownerGeneration,
		});
		return latestStatus;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const timedOut = error instanceof DbOwnerDeadlineError || error instanceof IntegrityCheckTimeoutError;
		latestStatus = statusWith(
			"unavailable",
			{ ok: false, messages: [message] },
			UNKNOWN_CHECK,
			[],
			timedOut ? "timed_out" : "complete",
			Date.now() - startedAt,
			REPAIR_GUIDANCE,
			owner,
		);
		logger.error("startup-recovery", "Owner-routed database integrity check failed", undefined, {
			error: message,
			ownerState: latestStatus.ownerState,
			ownerGeneration: latestStatus.ownerGeneration,
		});
		return latestStatus;
	} finally {
		clearInterval(progressTimer);
	}
}

async function runDeferredIntegrityCheckInternal(
	accessor: DbAccessor,
	dbPath: string,
	options: Partial<DeferredIntegrityCheckOptions>,
): Promise<DatabaseIntegrityStatus> {
	if (options.owner !== undefined) return await runOwnerDeferredIntegrityCheck(accessor, options);
	const timeoutMs = options.timeoutMs ?? DEFAULT_INTEGRITY_TIMEOUT_MS;
	const startedAt = Date.now();
	latestStatus = statusWith("unknown", UNKNOWN_CHECK, UNKNOWN_CHECK, [], "running", 0);
	logger.info("startup-recovery", "Deferred database integrity check started", { timeoutMs });
	try {
		const result = await runIntegrityWorkerCheck(dbPath, timeoutMs, options);
		const databaseIntegrity = await repairTelemetryIndexes(accessor, options.audit, {
			quickCheck: result.quickCheck,
			dbPath,
			repairTimeoutMs: timeoutMs,
		});
		latestStatus = { ...databaseIntegrity, durationMs: Date.now() - startedAt };
		logger.info("startup-recovery", "Deferred database integrity check complete", {
			state: latestStatus.state,
			durationMs: latestStatus.durationMs,
		});
		return latestStatus;
	} catch (error) {
		latestStatus = statusWith(
			"unavailable",
			{ ok: false, messages: [error instanceof Error ? error.message : String(error)] },
			UNKNOWN_CHECK,
			[],
			error instanceof IntegrityCheckTimeoutError ? "timed_out" : "complete",
			Date.now() - startedAt,
			REPAIR_GUIDANCE,
		);
		logger.error("startup-recovery", "Deferred database integrity check failed", undefined, {
			error: latestStatus.quickCheck.messages[0],
			durationMs: latestStatus.durationMs,
		});
		return latestStatus;
	}
}

/**
 * Check the database and repair only disposable telemetry indexes when the
 * targeted check identifies damage. Production REINDEX work runs in a
 * killable child with a real deadline. Production audits are admitted through
 * the bounded async writer queue only after the child commits and verification
 * succeeds. Owner-routed repairs keep their audit statement in the same
 * transaction as REINDEX; test doubles without a database path use one queued
 * transaction for both operations.
 */
export interface IntegrityRepairOptions {
	readonly quickCheck?: IntegrityCheckStatus;
	readonly dbPath?: string;
	readonly repairTimeoutMs?: number;
	readonly repairWorkerPath?: string;
	readonly repairRuntimePath?: string;
	readonly repairRequireBase?: string;
	readonly owner?: DbOwnerClient;
	readonly ownerAudit?: (
		indexes: readonly string[],
		detectionMessages: readonly string[],
	) => readonly DbOwnerStatement[];
}

async function readIntegrityChecks(
	accessor: DbAccessor,
	options: IntegrityRepairOptions | undefined,
): Promise<{
	readonly quick: IntegrityCheckStatus;
	readonly telemetry: IntegrityCheckStatus;
	readonly indexes: readonly string[];
}> {
	if (options?.owner === undefined) {
		return await accessor.withReadDbAsync(
			async (db) => ({
				quick: options?.quickCheck ?? check(db, "quick_check"),
				telemetry: check(db, "integrity_check", "telemetry_events"),
				indexes: listTelemetryIndexes(db),
			}),
			{ siteToken: "db:database.integrity.read-checks" },
		);
	}
	const deadlineMs = options.repairTimeoutMs ?? DEFAULT_INTEGRITY_TIMEOUT_MS;
	const quick =
		options.quickCheck ??
		ownerCheck(
			await ownerQueryAll<Record<string, unknown>>(options.owner, "integrity.quick-check", "PRAGMA quick_check", [], {
				deadlineMs,
			}),
			"quick_check",
		);
	const telemetry = ownerCheck(
		await ownerQueryAll<Record<string, unknown>>(
			options.owner,
			"integrity.telemetry-check",
			"PRAGMA integrity_check(telemetry_events)",
			[],
			{ deadlineMs },
		),
		"integrity_check",
	);
	const indexes = (
		await ownerQueryAll<{ name?: unknown }>(
			options.owner,
			"integrity.telemetry-indexes",
			"SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'telemetry_events' AND sql IS NOT NULL ORDER BY name",
			[],
			{ deadlineMs },
		)
	).flatMap((row) => (typeof row.name === "string" ? [row.name] : []));
	return { quick, telemetry, indexes };
}

export async function repairTelemetryIndexes(
	accessor: DbAccessor,
	audit?: TelemetryIndexRepairAudit,
	options?: IntegrityRepairOptions,
): Promise<DatabaseIntegrityStatus> {
	let quickCheck: IntegrityCheckStatus;
	let telemetryCheck: IntegrityCheckStatus;
	let telemetryIndexes: readonly string[];
	try {
		const checks = await readIntegrityChecks(accessor, options);
		quickCheck = checks.quick;
		telemetryCheck = checks.telemetry;
		telemetryIndexes = checks.indexes;
	} catch (error) {
		latestStatus = statusWith(
			"unavailable",
			{ ok: false, messages: [error instanceof Error ? error.message : String(error)] },
			UNKNOWN_CHECK,
			[],
			"complete",
			0,
			REPAIR_GUIDANCE,
			options?.owner,
		);
		return latestStatus;
	}

	if (quickCheck.ok && telemetryCheck.ok) {
		latestStatus = statusWith("healthy", quickCheck, telemetryCheck, [], "complete", 0, null, options?.owner);
		return latestStatus;
	}

	// quick_check covers the whole database. A failed global check is not
	// safely repairable by rebuilding a telemetry index.
	if (!quickCheck.ok) {
		latestStatus = statusWith(
			"corrupt",
			quickCheck,
			telemetryCheck,
			[],
			"complete",
			0,
			REPAIR_GUIDANCE,
			options?.owner,
		);
		return latestStatus;
	}

	if (!telemetryCheck.ok) {
		try {
			if (options?.owner !== undefined) {
				const statements = [
					...(options.ownerAudit?.(telemetryIndexes, telemetryCheck.messages) ?? []),
					...telemetryIndexes.map((index) => ownerRunStatement(`REINDEX ${escapedIdentifier(index)}`)),
				];
				if (statements.length === 0) throw new Error("telemetry repair has no owner statements");
				await ownerTransaction(options.owner, "integrity.repair", statements, {
					deadlineMs: options.repairTimeoutMs ?? DEFAULT_INTEGRITY_TIMEOUT_MS,
					estimatedWorkUnits: Math.max(1, statements.length),
				});
			} else if (options?.dbPath !== undefined) {
				await runKillableTelemetryRepair(
					options.dbPath,
					telemetryIndexes,
					options.repairTimeoutMs ?? DEFAULT_INTEGRITY_TIMEOUT_MS,
					options.repairWorkerPath,
					options.repairRuntimePath,
					options.repairRequireBase,
				);
			} else {
				await writeAsync(accessor, (db) => {
					for (const index of telemetryIndexes) db.exec(`REINDEX ${escapedIdentifier(index)}`);
					audit?.(db, telemetryIndexes, telemetryCheck.messages);
				});
			}

			const verifiedTelemetry =
				options?.owner === undefined
					? await accessor.withReadDbAsync(async (db) => check(db, "integrity_check", "telemetry_events"), {
							siteToken: "db:database.integrity.verify",
						})
					: ownerCheck(
							await ownerQueryAll<Record<string, unknown>>(
								options.owner,
								"integrity.telemetry-verify",
								"PRAGMA integrity_check(telemetry_events)",
								[],
								{ deadlineMs: options.repairTimeoutMs ?? DEFAULT_INTEGRITY_TIMEOUT_MS },
							),
							"integrity_check",
						);
			if (verifiedTelemetry.ok) {
				if (options?.dbPath !== undefined && audit !== undefined) {
					await writeAsync(accessor, (db) => audit(db, telemetryIndexes, telemetryCheck.messages));
				}
				latestStatus = statusWith(
					"repaired",
					quickCheck,
					verifiedTelemetry,
					[...telemetryIndexes],
					"complete",
					0,
					null,
					options?.owner,
				);
				return latestStatus;
			}
			telemetryCheck = verifiedTelemetry;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			telemetryCheck = { ok: false, messages: [...telemetryCheck.messages, message] };
			if (
				error instanceof IntegrityRepairTimeoutError ||
				error instanceof DbOwnerDeadlineError ||
				error instanceof IntegrityChildAdmissionError
			) {
				latestStatus = statusWith(
					"unavailable",
					quickCheck,
					telemetryCheck,
					[],
					error instanceof IntegrityRepairTimeoutError ? "timed_out" : "complete",
					0,
					REPAIR_GUIDANCE,
					options?.owner,
				);
				return latestStatus;
			}
		}
	}

	latestStatus = statusWith("corrupt", quickCheck, telemetryCheck, [], "complete", 0, REPAIR_GUIDANCE, options?.owner);
	return latestStatus;
}
