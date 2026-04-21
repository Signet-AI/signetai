import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { logger } from "../logger";
import { executeTask } from "./worker";

function isTaskRunRow(value: unknown): value is { status: string; error: string | null } {
	if (typeof value !== "object" || value === null) return false;
	return "status" in value && "error" in value;
}

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
		).run("task-1", "task-task-1", "test prompt", "*/15 * * * *", "codex", null, 1, null, now, now, now);

		const accessor: DbAccessor = {
			withReadDb<T>(fn: (rdb: ReadDb) => T): T {
				return fn(db as unknown as ReadDb);
			},
			withWriteTx<T>(fn: (wdb: WriteDb) => T): T {
				return fn(db as unknown as WriteDb);
			},
			close() {},
		};

		await executeTask(
			accessor,
			{
				id: "task-1",
				agent_id: "default",
				name: "task-task-1",
				prompt: "test prompt",
				cron_expression: "*/15 * * * *",
				harness: "codex",
				working_directory: null,
				skill_name: null,
				skill_mode: null,
			},
			{
				computeNextRun: () => "2026-03-06T16:00:00.000Z",
				resolveSkillPrompt: (prompt: string) => prompt,
				spawnTask: mock(async () => ({
					exitCode: 0,
					stdout: "",
					stderr: "",
					error: null,
					timedOut: false,
				})),
				emitTaskStream() {},
				logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as typeof logger,
				resolveTaskModel: () => {
					throw new Error("config read failed");
				},
				recordSkillInvocation() {},
			},
		);

		const run = db
			.prepare("SELECT status, error FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
			.get("task-1");

		expect(isTaskRunRow(run)).toBe(true);
		if (!isTaskRunRow(run)) {
			throw new Error("expected task run row");
		}
		expect(run?.status).toBe("failed");
		expect(run?.error).toContain("config read failed");
	});

	it("records skill usage when a task runs with a skill", async () => {
		const used: Array<{ skillName: string; agentId: string; source: string; success: boolean }> = [];
		const now = "2026-03-06T15:55:00.000Z";
		db.prepare(
			`INSERT INTO scheduled_tasks
			 (id, name, prompt, cron_expression, harness, working_directory,
			  enabled, last_run_at, next_run_at, created_at, updated_at, skill_name)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("task-2", "task-task-2", "test prompt", "*/15 * * * *", "codex", null, 1, null, now, now, now, "web-search");

		const accessor: DbAccessor = {
			withReadDb<T>(fn: (rdb: ReadDb) => T): T {
				return fn(db as unknown as ReadDb);
			},
			withWriteTx<T>(fn: (wdb: WriteDb) => T): T {
				return fn(db as unknown as WriteDb);
			},
			close() {},
		};

		await executeTask(
			accessor,
			{
				id: "task-2",
				agent_id: "agent-a",
				name: "task-task-2",
				prompt: "test prompt",
				cron_expression: "*/15 * * * *",
				harness: "codex",
				working_directory: null,
				skill_name: "web-search",
				skill_mode: null,
			},
			{
				computeNextRun: () => "2026-03-06T16:00:00.000Z",
				resolveSkillPrompt: (prompt: string) => prompt,
				spawnTask: mock(async () => ({
					exitCode: 0,
					stdout: "ok",
					stderr: "",
					error: null,
					timedOut: false,
				})),
				emitTaskStream() {},
				logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as typeof logger,
				resolveTaskModel: () => "gpt-test",
				recordSkillInvocation(input) {
					used.push({
						skillName: input.skillName,
						agentId: input.agentId,
						source: input.source,
						success: input.success,
					});
				},
			},
		);

		expect(used).toEqual([{ skillName: "web-search", agentId: "agent-a", source: "scheduler", success: true }]);
	});
});
