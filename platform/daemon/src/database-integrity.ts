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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

function workerPathFromModule(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const bundled = join(moduleDir, "database-integrity-worker.js");
	if (existsSync(bundled)) return bundled;
	return join(moduleDir, "database-integrity-worker.ts");
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
		const databaseIntegrity = repairTelemetryIndexes(accessor, options.audit, { quickCheck: result.quickCheck });
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
 * Check the database before background workers start and repair only the
 * disposable telemetry indexes when the targeted check identifies damage.
 * The optional audit runs inside the same write transaction as REINDEX.
 */
export function repairTelemetryIndexes(
	accessor: DbAccessor,
	audit?: TelemetryIndexRepairAudit,
	options?: { readonly quickCheck?: IntegrityCheckStatus },
): DatabaseIntegrityStatus {
	let quickCheck: IntegrityCheckStatus;
	let telemetryCheck: IntegrityCheckStatus;
	let telemetryIndexes: readonly string[];
	try {
		const checks = accessor.withReadDb((db) => ({
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
	// safely repairable by rebuilding a telemetry index, even if that index is
	// also mentioned in the targeted failure.
	if (!quickCheck.ok) {
		latestStatus = statusWith("corrupt", quickCheck, telemetryCheck, []);
		return latestStatus;
	}

	if (!telemetryCheck.ok) {
		try {
			accessor.withWriteTx((db) => {
				for (const index of telemetryIndexes) db.exec(`REINDEX ${escapedIdentifier(index)}`);
				audit?.(db, telemetryIndexes, telemetryCheck.messages);
			});
			const verifiedTelemetry = accessor.withReadDb((db) => check(db, "integrity_check", "telemetry_events"));
			if (verifiedTelemetry.ok) {
				latestStatus = statusWith("repaired", quickCheck, verifiedTelemetry, [...telemetryIndexes]);
				return latestStatus;
			}
			telemetryCheck = verifiedTelemetry;
		} catch (error) {
			telemetryCheck = {
				ok: false,
				messages: [...telemetryCheck.messages, error instanceof Error ? error.message : String(error)],
			};
		}
	}

	latestStatus = statusWith("corrupt", quickCheck, telemetryCheck, []);
	return latestStatus;
}
