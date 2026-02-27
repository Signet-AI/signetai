import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@signet/core";
import type { ReadDb } from "../db-accessor";
import { selectDueTasks } from "./worker";

interface TaskInsert {
	readonly id: string;
	readonly nextRunAt: string | null;
	readonly enabled?: number;
}

function insertTask(db: Database, input: TaskInsert): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO scheduled_tasks
		 (id, name, prompt, cron_expression, harness, working_directory,
		  enabled, last_run_at, next_run_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.id,
		`task-${input.id}`,
		"test prompt",
		"*/15 * * * *",
		"opencode",
		null,
		input.enabled ?? 1,
		null,
		input.nextRunAt,
		now,
		now,
	);
}

function insertRunningRun(db: Database, taskId: string): void {
	db.prepare(
		`INSERT INTO task_runs (id, task_id, status, started_at)
		 VALUES (?, ?, 'running', ?)`,
	).run(`run-${taskId}`, taskId, new Date().toISOString());
}

describe("scheduler due task selection", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
	});

	it("selects tasks that are overdue when next_run_at is ISO timestamp", () => {
		const nowIso = "2026-02-27T12:10:00.000Z";
		insertTask(db, { id: "due", nextRunAt: "2026-02-27T12:00:00.000Z" });

		const rows = selectDueTasks(db as unknown as ReadDb, nowIso, 10);
		expect(rows.map((row) => row.id)).toEqual(["due"]);
	});

	it("does not select tasks scheduled in the future", () => {
		const nowIso = "2026-02-27T12:10:00.000Z";
		insertTask(db, { id: "future", nextRunAt: "2026-02-27T12:15:00.000Z" });

		const rows = selectDueTasks(db as unknown as ReadDb, nowIso, 10);
		expect(rows).toHaveLength(0);
	});

	it("skips tasks that already have a running run", () => {
		const nowIso = "2026-02-27T12:10:00.000Z";
		insertTask(db, { id: "running", nextRunAt: "2026-02-27T12:00:00.000Z" });
		insertRunningRun(db, "running");

		const rows = selectDueTasks(db as unknown as ReadDb, nowIso, 10);
		expect(rows).toHaveLength(0);
	});

	it("orders due tasks by next_run_at and respects limit", () => {
		const nowIso = "2026-02-27T12:10:00.000Z";
		insertTask(db, { id: "latest", nextRunAt: "2026-02-27T12:09:00.000Z" });
		insertTask(db, { id: "earliest", nextRunAt: "2026-02-27T12:01:00.000Z" });
		insertTask(db, { id: "middle", nextRunAt: "2026-02-27T12:05:00.000Z" });

		const rows = selectDueTasks(db as unknown as ReadDb, nowIso, 2);
		expect(rows.map((row) => row.id)).toEqual(["earliest", "middle"]);
	});
});
