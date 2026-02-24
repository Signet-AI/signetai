import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS scheduled_tasks (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			prompt TEXT NOT NULL,
			cron_expression TEXT NOT NULL,
			harness TEXT NOT NULL,
			working_directory TEXT,
			enabled INTEGER NOT NULL DEFAULT 1,
			last_run_at TEXT,
			next_run_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled_next
			ON scheduled_tasks(enabled, next_run_at);

		CREATE TABLE IF NOT EXISTS task_runs (
			id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
			status TEXT NOT NULL DEFAULT 'pending',
			started_at TEXT NOT NULL,
			completed_at TEXT,
			exit_code INTEGER,
			stdout TEXT,
			stderr TEXT,
			error TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_task_runs_task_id
			ON task_runs(task_id);
		CREATE INDEX IF NOT EXISTS idx_task_runs_status
			ON task_runs(status);
	`);
}
