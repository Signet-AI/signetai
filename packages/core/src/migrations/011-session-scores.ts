import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_scores (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			project TEXT,
			harness TEXT,
			score REAL NOT NULL,
			memories_recalled INTEGER,
			memories_used INTEGER,
			novel_context_count INTEGER,
			reasoning TEXT,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_session_scores_project
			ON session_scores(project, created_at);
		CREATE INDEX IF NOT EXISTS idx_session_scores_session
			ON session_scores(session_key);
	`);
}
