import { createRequire } from "node:module";
import type { DbOwnerCommand, DbOwnerEvent, DbOwnerJob, DbOwnerParameter, DbOwnerStatement } from "./db-owner-protocol";
import { serializeError } from "./db-owner-protocol";

interface SqliteRunResult {
	readonly changes: number;
	readonly lastInsertRowid?: number | bigint;
}

interface SqliteStatement {
	all(...params: readonly unknown[]): unknown[];
	get(...params: readonly unknown[]): unknown;
	run(...params: readonly unknown[]): SqliteRunResult;
}

interface SqliteDatabase {
	prepare(sql: string): SqliteStatement;
	exec(sql: string): void;
	close(): void;
}

const require = createRequire(import.meta.url);
const Database = (
	typeof (globalThis as Record<string, unknown>).Bun !== "undefined"
		? require("bun:sqlite").Database
		: require("better-sqlite3")
) as new (
	path: string,
	options?: Record<string, unknown>,
) => SqliteDatabase;

const dbPath = process.env.SIGNET_DB_OWNER_DB_PATH;
if (dbPath === undefined) throw new Error("DB owner requires SIGNET_DB_OWNER_DB_PATH");

const db = new Database(dbPath);
db.exec("PRAGMA busy_timeout = 5000");

const cancelled = new Set<string>();
const queue: DbOwnerJob[] = [];
let activeJobId: string | null = null;
let draining = false;

function send(event: DbOwnerEvent): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

function bindParameter(value: DbOwnerParameter): unknown {
	if (typeof value === "object" && value !== null && value.type === "bytes") return Buffer.from(value.base64, "base64");
	return value;
}

function executeStatement(statement: DbOwnerStatement): unknown {
	const params = (statement.params ?? []).map(bindParameter);
	const prepared = db.prepare(statement.sql);
	if (statement.result === "all") return prepared.all(...params);
	if (statement.result === "get") return prepared.get(...params);
	if (statement.transactional === false) return prepared.run(...params);

	db.exec("BEGIN IMMEDIATE");
	try {
		const result = prepared.run(...params);
		db.exec("COMMIT");
		return result;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// The original error is the actionable failure.
		}
		throw error;
	}
}

function execute(job: DbOwnerJob): unknown {
	if (job.request.kind === "query") return executeStatement(job.request.statement);
	const durationMs = Math.max(0, Math.floor(job.request.durationMs));
	const wait = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(wait, 0, 0, durationMs);
	return { sleptMs: durationMs };
}

function result(jobId: string, outcome: "completed" | "cancelled" | "timed_out", value?: unknown): void {
	send({ type: "result", jobId, outcome, ...(value === undefined ? {} : { result: value }) });
}

function runNext(): void {
	if (draining) return;
	draining = true;
	const next = (): void => {
		const job = queue.shift();
		if (job === undefined) {
			draining = false;
			return;
		}
		activeJobId = job.id;
		try {
			if (cancelled.delete(job.id)) {
				result(job.id, "cancelled");
			} else if (Date.now() >= job.deadlineAt) {
				result(job.id, "timed_out");
			} else {
				result(job.id, "completed", execute(job));
			}
		} catch (error) {
			send({ type: "result", jobId: job.id, outcome: "failed", error: serializeError(error) });
		} finally {
			activeJobId = null;
			setImmediate(next);
		}
	};
	setImmediate(next);
}

function handle(command: DbOwnerCommand): void {
	if (command.type === "shutdown") {
		db.close();
		process.exit(0);
	}
	if (command.type === "cancel") {
		cancelled.add(command.jobId);
		return;
	}
	queue.push(command.job);
	runNext();
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	input += chunk;
	const lines = input.split("\n");
	input = lines.pop() ?? "";
	for (const line of lines) {
		if (line.length === 0) continue;
		try {
			handle(JSON.parse(line) as DbOwnerCommand);
		} catch (error) {
			send({ type: "fatal", error: serializeError(error) });
			process.exitCode = 1;
		}
	}
});

send({ type: "ready", pid: process.pid });
void activeJobId;
