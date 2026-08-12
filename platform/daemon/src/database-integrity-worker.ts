import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

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

const db = new Database(workerData.dbPath, { readonly: true });
try {
	const rows = db.prepare("PRAGMA quick_check").all() as Array<{ quick_check?: unknown }>;
	const messages = rows.map((row) => String(row.quick_check ?? ""));
	const quickCheck: IntegrityCheckStatus =
		messages.length === 1 && messages[0] === "ok" ? { ok: true, messages: [] } : { ok: false, messages };
	const message: WorkerMessage = { type: "result", result: { quickCheck } };
	parentPort?.postMessage(message);
} finally {
	db.close();
}
