import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@signet/core";

/**
 * Tests for task endpoint agent-scoping SQL patterns.
 *
 * These verify that the SQL queries used by task CRUD endpoints
 * (list, detail, update, delete, run, stream, runs) correctly
 * scope by agent_id with no cross-agent existence oracle.
 */
describe("task agent-scoping", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db);
	});

	afterEach(() => {
		if (db) db.close();
	});

	function createTask(id: string, agentId: string, name = "test task"): void {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO scheduled_tasks
			 (id, name, prompt, cron_expression, harness, enabled, next_run_at, agent_id, created_at, updated_at)
			 VALUES (?, ?, 'test prompt', '0 * * * *', 'claude-code', 1, ?, ?, ?, ?)`,
		).run(id, name, now, agentId, now, now);
	}

	function createTaskRun(runId: string, taskId: string): void {
		db.prepare(
			`INSERT INTO task_runs (id, task_id, status, started_at)
			 VALUES (?, ?, 'completed', datetime('now'))`,
		).run(runId, taskId);
	}

	// -- List endpoint SQL pattern --
	it("list: only returns tasks for the scoped agent", () => {
		createTask("t1", "agent-a");
		createTask("t2", "agent-b");
		createTask("t3", "agent-a");

		const tasks = db
			.prepare(
				`SELECT t.*
				 FROM scheduled_tasks t
				 WHERE t.agent_id = ?
				 ORDER BY t.created_at DESC`,
			)
			.all("agent-a") as { id: string }[];

		expect(tasks.length).toBe(2);
		expect(tasks.map((t) => t.id).sort()).toEqual(["t1", "t3"]);
	});

	// -- Detail endpoint SQL pattern --
	it("detail: returns task only if agent_id matches", () => {
		createTask("t1", "agent-a");

		const found = db
			.prepare("SELECT * FROM scheduled_tasks WHERE id = ? AND agent_id = ?")
			.get("t1", "agent-a");
		expect(found).toBeTruthy();

		const notFound = db
			.prepare("SELECT * FROM scheduled_tasks WHERE id = ? AND agent_id = ?")
			.get("t1", "agent-b");
		expect(notFound).toBeNull();
	});

	it("detail: cross-agent query returns null (no existence oracle)", () => {
		createTask("t1", "agent-a");

		// Agent-b cannot distinguish "task doesn't exist" from "task belongs to another agent"
		const missing = db
			.prepare("SELECT * FROM scheduled_tasks WHERE id = ? AND agent_id = ?")
			.get("nonexistent", "agent-b");
		const crossAgent = db
			.prepare("SELECT * FROM scheduled_tasks WHERE id = ? AND agent_id = ?")
			.get("t1", "agent-b");

		// Both return null — identical response, no information leak
		expect(missing).toBeNull();
		expect(crossAgent).toBeNull();
	});

	// -- Delete endpoint SQL pattern --
	it("delete: only deletes task if agent_id matches", () => {
		createTask("t1", "agent-a");
		createTask("t2", "agent-b");

		const result = db
			.prepare("DELETE FROM scheduled_tasks WHERE id = ? AND agent_id = ?")
			.run("t1", "agent-b");
		expect(result.changes).toBe(0);

		const correctDelete = db
			.prepare("DELETE FROM scheduled_tasks WHERE id = ? AND agent_id = ?")
			.run("t1", "agent-a");
		expect(correctDelete.changes).toBe(1);
	});

	// -- Stream endpoint SQL pattern --
	it("stream: existence check scopes by agent_id", () => {
		createTask("t1", "agent-a");

		const scoped = db
			.prepare("SELECT 1 FROM scheduled_tasks WHERE id = ? AND agent_id = ?")
			.get("t1", "agent-a");
		expect(scoped).toBeTruthy();

		const crossAgent = db
			.prepare("SELECT 1 FROM scheduled_tasks WHERE id = ? AND agent_id = ?")
			.get("t1", "agent-b");
		expect(crossAgent).toBeNull();
	});

	// -- Runs endpoint SQL pattern --
	it("runs: ownership check prevents cross-agent run history access", () => {
		createTask("t1", "agent-a");
		createTaskRun("r1", "t1");
		createTaskRun("r2", "t1");

		// Agent-a can verify ownership
		const owned = db
			.prepare("SELECT 1 FROM scheduled_tasks WHERE id = ? AND agent_id = ?")
			.get("t1", "agent-a");
		expect(owned).toBeTruthy();

		// Agent-b cannot
		const notOwned = db
			.prepare("SELECT 1 FROM scheduled_tasks WHERE id = ? AND agent_id = ?")
			.get("t1", "agent-b");
		expect(notOwned).toBeNull();

		// Runs query itself (only reachable after ownership check)
		const runs = db
			.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC")
			.all("t1");
		expect(runs.length).toBe(2);
	});

	// -- Run endpoint SQL pattern --
	it("run: task lookup scopes by agent_id before execution", () => {
		createTask("t1", "agent-a");

		const task = db
			.prepare("SELECT * FROM scheduled_tasks WHERE id = ? AND agent_id = ?")
			.get("t1", "agent-a") as Record<string, unknown>;
		expect(task).toBeTruthy();
		expect(task.agent_id).toBe("agent-a");

		const crossAgent = db
			.prepare("SELECT * FROM scheduled_tasks WHERE id = ? AND agent_id = ?")
			.get("t1", "agent-b");
		expect(crossAgent).toBeNull();
	});

	// -- Migration 054 default behavior --
	it("migration: new tasks get explicit agent_id, default is 'default'", () => {
		// Insert without specifying agent_id — should get DEFAULT 'default'
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO scheduled_tasks
			 (id, name, prompt, cron_expression, harness, enabled, next_run_at, created_at, updated_at)
			 VALUES ('legacy', 'old task', 'prompt', '0 * * * *', 'claude-code', 1, ?, ?, ?)`,
		).run(now, now, now);

		const row = db.prepare("SELECT agent_id FROM scheduled_tasks WHERE id = 'legacy'").get() as { agent_id: string };
		expect(row.agent_id).toBe("default");
	});

	it("migration: agent_id column is NOT NULL", () => {
		const cols = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as ReadonlyArray<Record<string, unknown>>;
		const agentIdCol = cols.find((c) => c.name === "agent_id");
		expect(agentIdCol).toBeTruthy();
		expect(agentIdCol!.notnull).toBe(1);
	});
});
