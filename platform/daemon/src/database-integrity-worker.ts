/**
 * This entrypoint intentionally remains a child process, not a Worker-thread
 * module. It opens SQLite directly and the caller must be able to SIGKILL the
 * whole operation when synchronous quick_check exceeds its deadline. The
 * owner-routed daemon path performs quick_check through the DB owner and does
 * not launch this process; this boundary serves only the direct-DB compatibility
 * path, which admits one child at a time and reaps it before admitting another.
 */
import { createRequire } from "node:module";

const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";
const require = createRequire(import.meta.url);
const Database = isBun ? require("bun:sqlite").Database : require("better-sqlite3");

type IntegrityCheckStatus = {
	readonly ok: boolean;
	readonly messages: readonly string[];
};

type WorkerMessage = {
	readonly type: "result";
	readonly result: { readonly quickCheck: IntegrityCheckStatus };
};

function quickCheck(dbPath: string): IntegrityCheckStatus {
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db.prepare("PRAGMA quick_check").all() as Array<{ quick_check?: unknown }>;
		const messages = rows.map((row) => String(row.quick_check ?? ""));
		return messages.length === 1 && messages[0] === "ok" ? { ok: true, messages: [] } : { ok: false, messages };
	} finally {
		db.close();
	}
}

export function runDatabaseIntegrityWorker(): void {
	const processDbPath = process.env.SIGNET_DATABASE_INTEGRITY_DB_PATH;
	if (processDbPath === undefined) throw new Error("database integrity worker requires a database path");
	process.stdout.write("started\n");
	const result: WorkerMessage = { type: "result", result: { quickCheck: quickCheck(processDbPath) } };
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entrypoint = process.argv[1] ?? "";
if (
	process.env.SIGNET_DATABASE_INTEGRITY_DB_PATH !== undefined &&
	(entrypoint.endsWith("database-integrity-worker.ts") ||
		entrypoint.endsWith("database-integrity-worker.js") ||
		entrypoint.endsWith("database-integrity-worker.mjs"))
) {
	runDatabaseIntegrityWorker();
}
