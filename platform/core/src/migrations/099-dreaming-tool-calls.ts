import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS dreaming_tool_calls (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			pass_id TEXT NOT NULL,
			sequence INTEGER NOT NULL,
			tool_call_id TEXT,
			tool_name TEXT NOT NULL,
			input_json TEXT NOT NULL,
			output_json TEXT NOT NULL,
			success INTEGER NOT NULL,
			latency_ms INTEGER NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(agent_id, pass_id, sequence)
		);
		CREATE INDEX IF NOT EXISTS idx_dreaming_tool_calls_pass
			ON dreaming_tool_calls (agent_id, pass_id, sequence ASC);
	`);
}
