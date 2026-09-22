import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_claims (
			session_key TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
			runtime_path TEXT CHECK(runtime_path IN ('plugin', 'legacy')),
			harness TEXT,
			claimed_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'expired', 'ended')),
			ended_at TEXT,
			end_marker TEXT,
			PRIMARY KEY (agent_id, session_key)
		);

		CREATE INDEX IF NOT EXISTS idx_session_claims_expiry
			ON session_claims(state, expires_at);
		CREATE INDEX IF NOT EXISTS idx_session_claims_agent
			ON session_claims(agent_id, state, expires_at);
	`);
}
