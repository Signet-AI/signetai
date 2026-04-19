import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "../../core/src/migrations";
import { readScopedTask, readTaskAgentId } from "./task-scope";

describe("task scope helpers", () => {
	let db: Database;
	let path: string;

	beforeEach(() => {
		path = join("/tmp", `signet-task-scope-${crypto.randomUUID()}.db`);
		db = new Database(path);
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		db.prepare(
			`INSERT INTO scheduled_tasks
			 (id, name, prompt, cron_expression, harness, enabled, next_run_at, created_at, updated_at)
			 VALUES (?, 'Test task', 'Prompt', '* * * * *', 'codex', 1, datetime('now'), datetime('now'), datetime('now'))`,
		).run("task-1");
		db.prepare(
			`INSERT INTO task_scope_hints (task_id, agent_id, created_at, updated_at)
			 VALUES ('task-1', 'agent-b', datetime('now'), datetime('now'))`,
		).run();
	});

	afterEach(() => {
		db.close();
		rmSync(path, { force: true });
	});

	it("hides out-of-scope tasks when scope enforcement is active", () => {
		const row = readScopedTask(db, "task-1", "agent-a", true);
		expect(row).toBeUndefined();
	});

	it("returns the owning agent when the task is in scope", () => {
		const row = readScopedTask(db, "task-1", "agent-b", true);
		expect(row).toBeDefined();
		expect(readTaskAgentId(row ?? {}, "default")).toBe("agent-b");
	});

	it("allows bare id lookup when scope enforcement is disabled", () => {
		const row = readScopedTask(db, "task-1", "agent-a", false);
		expect(row).toBeDefined();
		expect(readTaskAgentId(row ?? {}, "agent-a")).toBe("agent-b");
	});
});
