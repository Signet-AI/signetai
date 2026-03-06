import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { runMigrations } from "@signet/core";

mock.module("../memory-config", () => ({
	loadMemoryConfig: () => {
		throw new Error("config read failed");
	},
}));

mock.module("./spawn", () => ({
	spawnTask: mock(async () => ({
		exitCode: 0,
		stdout: "",
		stderr: "",
		error: null,
		timedOut: false,
	})),
}));

mock.module("./task-stream", () => ({
	emitTaskStream() {},
}));

mock.module("./skill-resolver", () => ({
	resolveSkillPrompt: (prompt: string) => prompt,
}));

mock.module("./cron", () => ({
	computeNextRun: () => "2026-03-06T16:00:00.000Z",
}));

mock.module("../logger", () => ({
	logger: {
		info() {},
		warn() {},
		error() {},
	},
}));

const { executeTask } = await import("./worker");

describe("executeTask", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
	});

	it("marks the run failed when task model resolution throws", async () => {
		const now = "2026-03-06T15:55:00.000Z";
		db.prepare(
			`INSERT INTO scheduled_tasks
			 (id, name, prompt, cron_expression, harness, working_directory,
			  enabled, last_run_at, next_run_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"task-1",
			"task-task-1",
			"test prompt",
			"*/15 * * * *",
			"codex",
			null,
			1,
			null,
			now,
			now,
			now,
		);

		const accessor = {
			withReadDb<T>(fn: (rdb: unknown) => T): T {
				return fn(db);
			},
			withWriteTx<T>(fn: (wdb: unknown) => T): T {
				return fn(db);
			},
		};

		await executeTask(accessor as never, {
			id: "task-1",
			name: "task-task-1",
			prompt: "test prompt",
			cron_expression: "*/15 * * * *",
			harness: "codex",
			working_directory: null,
			skill_name: null,
			skill_mode: null,
		});

		const run = db.prepare(
			`SELECT status, error FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`,
		).get("task-1") as { status: string; error: string | null } | undefined;

		expect(run?.status).toBe("failed");
		expect(run?.error).toContain("config read failed");
	});
});
