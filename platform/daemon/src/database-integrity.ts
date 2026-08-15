/**
 * Startup integrity checks for SQLite's derived database surfaces.
 *
 * `PRAGMA quick_check` deliberately does not validate every index/table
 * relationship. The telemetry table is append-only and its indexes are
 * disposable, so it gets a targeted full check and a transactional REINDEX
 * when SQLite reports an index mismatch.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { logger } from "./logger";
import { resolveEmbeddedWorkerPath } from "./native-runtime-assets";

export type DatabaseIntegrityState = "unknown" | "healthy" | "repaired" | "corrupt" | "unavailable";

export interface IntegrityCheckStatus {
	readonly ok: boolean;
	readonly messages: readonly string[];
}

export interface DatabaseIntegrityStatus {
	readonly checkedAt: string;
	readonly state: DatabaseIntegrityState;
	readonly phase: "pending" | "running" | "complete" | "timed_out";
	readonly quickCheck: IntegrityCheckStatus;
	readonly telemetryCheck: IntegrityCheckStatus;
	readonly rebuiltIndexes: readonly string[];
	readonly durationMs: number;
	readonly repairGuidance: string | null;
}

const UNKNOWN_CHECK: IntegrityCheckStatus = { ok: false, messages: ["not checked"] };
const REPAIR_GUIDANCE =
	"Stop the daemon, back up the database, and run the operator integrity repair flow before restarting.";

let latestStatus: DatabaseIntegrityStatus = {
	checkedAt: "",
	state: "unknown",
	phase: "pending",
	quickCheck: UNKNOWN_CHECK,
	telemetryCheck: UNKNOWN_CHECK,
	rebuiltIndexes: [],
	durationMs: 0,
	repairGuidance: null,
};

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
): DatabaseIntegrityStatus {
	return {
		checkedAt: new Date().toISOString(),
		state,
		phase,
		quickCheck,
		telemetryCheck,
		rebuiltIndexes,
		durationMs,
		repairGuidance,
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

export interface DeferredIntegrityCheckOptions {
	readonly workerPath?: string;
	readonly timeoutMs?: number;
	readonly audit?: TelemetryIndexRepairAudit;
	readonly onWorkerStarted?: () => void;
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
const database = new Database(dbPath);
try {
  database.exec("BEGIN IMMEDIATE");
  for (const index of indexes) database.exec("REINDEX " + escaped(index));
  database.exec("COMMIT");
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

async function runKillableTelemetryRepair(
	dbPath: string,
	indexes: readonly string[],
	timeoutMs: number,
	workerPath?: string,
	runtimePath?: string,
	requireBase?: string,
): Promise<void> {
	const dir = workerPath === undefined ? await mkdtemp(join(tmpdir(), "signet-integrity-repair-")) : null;
	const scriptPath = workerPath ?? join(dir ?? tmpdir(), "repair.mjs");
	if (workerPath === undefined) await writeFile(scriptPath, REPAIR_WORKER_SOURCE, "utf8");

	let child: ChildProcess | undefined;
	try {
		child = spawn(runtimePath ?? process.execPath, [scriptPath], {
			env: {
				...process.env,
				SIGNET_DATABASE_INTEGRITY_DB_PATH: dbPath,
				SIGNET_DATABASE_INTEGRITY_INDEXES: JSON.stringify(indexes),
				SIGNET_DATABASE_INTEGRITY_REQUIRE_BASE: requireBase ?? fileURLToPath(import.meta.url),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				child?.kill("SIGKILL");
				reject(new IntegrityRepairTimeoutError(timeoutMs));
			}, timeoutMs);
			let output = "";
			child?.stdout?.setEncoding("utf8");
			child?.stdout?.on("data", (chunk: string) => {
				output += chunk;
			});
			child?.once("error", (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			});
			child?.once("close", (code) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (code !== 0) {
					reject(new Error(`telemetry index repair worker exited with code ${code ?? "unknown"}`));
					return;
				}
				try {
					const result = JSON.parse(output.trim()) as { ok?: unknown };
					if (result.ok !== true) throw new Error("telemetry index repair worker returned an invalid result");
					resolve();
				} catch (error) {
					reject(error);
				}
			});
			child?.stderr?.resume();
		});
	} finally {
		if (child !== undefined && child.exitCode === null) child.kill("SIGKILL");
		if (dir !== null) await rm(dir, { recursive: true, force: true });
	}
}

async function writeAsync<Result>(accessor: DbAccessor, processBatch: (db: WriteDb) => Result): Promise<Result> {
	return accessor.withWriteTxAsync(processBatch);
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

async function runDeferredIntegrityCheckInternal(
	accessor: DbAccessor,
	dbPath: string,
	options: Partial<DeferredIntegrityCheckOptions>,
): Promise<DatabaseIntegrityStatus> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_INTEGRITY_TIMEOUT_MS;
	const startedAt = Date.now();
	latestStatus = statusWith("unknown", UNKNOWN_CHECK, UNKNOWN_CHECK, [], "running", 0);
	logger.info("startup-recovery", "Deferred database integrity check started", { timeoutMs });
	const embeddedWorkerPath = resolveEmbeddedWorkerPath("database-integrity-worker");
	const workerPath = options.workerPath ?? embeddedWorkerPath ?? workerPathFromModule();
	const workerArgs = options.workerPath === undefined && embeddedWorkerPath !== null ? [] : [workerPath];
	let worker: ChildProcess | undefined;
	let timedOut = false;
	let progressTimer: ReturnType<typeof setInterval> | undefined;

	try {
		const child = spawn(process.execPath, workerArgs, {
			env: {
				...process.env,
				SIGNET_DATABASE_INTEGRITY_DB_PATH: dbPath,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		worker = child;
		const result = await new Promise<DatabaseIntegrityWorkerResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
				reject(new Error(`database integrity check exceeded ${timeoutMs}ms`));
			}, timeoutMs);
			let output = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				for (const line of `${output}${chunk}`.split("\n").slice(0, -1)) {
					if (line === "started") {
						options.onWorkerStarted?.();
						continue;
					}
					if (line.length > 0) {
						try {
							const message = JSON.parse(line) as DatabaseIntegrityWorkerMessage;
							if (message.type === "result") {
								clearTimeout(timer);
								resolve(message.result);
							}
						} catch {
							// The close handler reports a malformed or incomplete response.
						}
					}
				}
				output = `${output}${chunk}`.split("\n").at(-1) ?? "";
			});
			progressTimer = setInterval(() => {
				logger.info("startup-recovery", "Database integrity check in progress", {
					elapsedMs: Date.now() - startedAt,
					budgetMs: timeoutMs,
				});
			}, 1000);
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("close", (code) => {
				if (timedOut) return;
				if (code !== 0) {
					clearTimeout(timer);
					reject(new Error(`database integrity worker exited with code ${code ?? "unknown"}`));
				} else {
					clearTimeout(timer);
					reject(new Error("database integrity worker exited without a result"));
				}
			});
			child.stderr.resume();
		});
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
			timedOut ? "timed_out" : "complete",
			Date.now() - startedAt,
			REPAIR_GUIDANCE,
		);
		logger.error("startup-recovery", "Deferred database integrity check failed", undefined, {
			error: latestStatus.quickCheck.messages[0],
			durationMs: latestStatus.durationMs,
		});
		return latestStatus;
	} finally {
		if (progressTimer !== undefined) clearInterval(progressTimer);
		if (worker !== undefined && worker.exitCode === null) worker.kill("SIGKILL");
	}
}

/**
 * Check the database and repair only disposable telemetry indexes when the
 * targeted check identifies damage. Production REINDEX work runs in a
 * killable child with a real deadline. Production audits are admitted through
 * the bounded async writer queue before the child can commit its repair; test
 * doubles without a database path use one queued transaction for both
 * operations.
 */
export async function repairTelemetryIndexes(
	accessor: DbAccessor,
	audit?: TelemetryIndexRepairAudit,
	options?: {
		readonly quickCheck?: IntegrityCheckStatus;
		readonly dbPath?: string;
		readonly repairTimeoutMs?: number;
		readonly repairWorkerPath?: string;
		readonly repairRuntimePath?: string;
		readonly repairRequireBase?: string;
	},
): Promise<DatabaseIntegrityStatus> {
	let quickCheck: IntegrityCheckStatus;
	let telemetryCheck: IntegrityCheckStatus;
	let telemetryIndexes: readonly string[];
	try {
		const checks = await accessor.withReadDbAsync(async (db) => ({
			quick: options?.quickCheck ?? check(db, "quick_check"),
			telemetry: check(db, "integrity_check", "telemetry_events"),
			indexes: listTelemetryIndexes(db),
		}));
		quickCheck = checks.quick;
		telemetryCheck = checks.telemetry;
		telemetryIndexes = checks.indexes;
	} catch (error) {
		latestStatus = statusWith(
			"unavailable",
			{ ok: false, messages: [error instanceof Error ? error.message : String(error)] },
			UNKNOWN_CHECK,
			[],
		);
		return latestStatus;
	}

	if (quickCheck.ok && telemetryCheck.ok) {
		latestStatus = statusWith("healthy", quickCheck, telemetryCheck, []);
		return latestStatus;
	}

	// quick_check covers the whole database. A failed global check is not
	// safely repairable by rebuilding a telemetry index.
	if (!quickCheck.ok) {
		latestStatus = statusWith("corrupt", quickCheck, telemetryCheck, []);
		return latestStatus;
	}

	if (!telemetryCheck.ok) {
		try {
			if (options?.dbPath !== undefined) {
				if (audit !== undefined) {
					await writeAsync(accessor, (db) => audit(db, telemetryIndexes, telemetryCheck.messages));
				}
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

			const verifiedTelemetry = await accessor.withReadDbAsync(async (db) =>
				check(db, "integrity_check", "telemetry_events"),
			);
			if (verifiedTelemetry.ok) {
				latestStatus = statusWith("repaired", quickCheck, verifiedTelemetry, [...telemetryIndexes]);
				return latestStatus;
			}
			telemetryCheck = verifiedTelemetry;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			telemetryCheck = { ok: false, messages: [...telemetryCheck.messages, message] };
			if (error instanceof IntegrityRepairTimeoutError) {
				latestStatus = statusWith("unavailable", quickCheck, telemetryCheck, [], "timed_out", 0);
				return latestStatus;
			}
		}
	}

	latestStatus = statusWith("corrupt", quickCheck, telemetryCheck, []);
	return latestStatus;
}
