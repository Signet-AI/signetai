import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import type { ReadDb } from "../db-accessor";
import { clearTaskModelCache, resolveTaskModel, selectDueTasks } from "./worker";

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
		clearTaskModelCache();
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

describe("resolveTaskModel", () => {
	afterEach(() => {
		clearTaskModelCache();
	});

	it("returns the configured codex extraction model for codex tasks", () => {
		const agentsDir = mkdtempSync(join(tmpdir(), "signet-agents-"));
		try {
			writeFileSync(
				join(agentsDir, "agent.yaml"),
				["memory:", "  pipelineV2:", "    extraction:", "      provider: codex", "      model: gpt-5.3-codex"].join(
					"\n",
				),
			);

			expect(resolveTaskModel("codex", agentsDir)).toBe("gpt-5.3-codex");
			expect(resolveTaskModel("opencode", agentsDir)).toBeUndefined();
		} finally {
			rmSync(agentsDir, { recursive: true, force: true });
		}
	});

	it("caches the resolved model for repeated codex task lookups", () => {
		const agentsDir = mkdtempSync(join(tmpdir(), "signet-agents-"));
		try {
			const configPath = join(agentsDir, "agent.yaml");
			writeFileSync(
				configPath,
				["memory:", "  pipelineV2:", "    extraction:", "      provider: codex", "      model: gpt-5.3-codex"].join(
					"\n",
				),
			);

			expect(resolveTaskModel("codex", agentsDir)).toBe("gpt-5.3-codex");

			writeFileSync(
				configPath,
				["memory:", "  pipelineV2:", "    extraction:", "      provider: codex", "      model: gpt-5.4-codex"].join(
					"\n",
				),
			);

			expect(resolveTaskModel("codex", agentsDir)).toBe("gpt-5.3-codex");
			clearTaskModelCache();
			expect(resolveTaskModel("codex", agentsDir)).toBe("gpt-5.4-codex");
		} finally {
			rmSync(agentsDir, { recursive: true, force: true });
		}
	});
});
