import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS cross_agent_messages (
			id TEXT PRIMARY KEY,
			from_agent_id TEXT NOT NULL,
			from_session_key TEXT,
			to_agent_id TEXT,
			to_session_key TEXT,
			to_session_agent_id TEXT,
			broadcast INTEGER NOT NULL DEFAULT 0 CHECK(broadcast IN (0, 1)),
			message_type TEXT NOT NULL CHECK(message_type IN ('assist_request', 'decision_update', 'info', 'question')),
			content TEXT NOT NULL,
			delivery_path TEXT NOT NULL CHECK(delivery_path IN ('local', 'acp')),
			delivery_status TEXT NOT NULL CHECK(delivery_status IN ('queued', 'delivered', 'failed')),
			delivery_error TEXT,
			delivery_receipt_json TEXT,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			CHECK(
				delivery_path = 'acp'
				OR (
					CAST(to_agent_id IS NOT NULL AS INTEGER)
					+ CAST(to_session_key IS NOT NULL AS INTEGER)
					+ broadcast = 1
				)
			)
		);

		CREATE TABLE IF NOT EXISTS cross_agent_message_receipts (
			message_id TEXT NOT NULL REFERENCES cross_agent_messages(id) ON DELETE CASCADE,
			agent_id TEXT NOT NULL,
			acknowledged_at TEXT NOT NULL,
			PRIMARY KEY (message_id, agent_id)
		);

		CREATE INDEX IF NOT EXISTS idx_cross_agent_messages_agent
			ON cross_agent_messages(to_agent_id, expires_at, created_at, id);
		CREATE INDEX IF NOT EXISTS idx_cross_agent_messages_session
			ON cross_agent_messages(to_session_key, expires_at, created_at, id);
		CREATE INDEX IF NOT EXISTS idx_cross_agent_messages_session_agent
			ON cross_agent_messages(to_session_agent_id, expires_at, created_at, id);
		CREATE INDEX IF NOT EXISTS idx_cross_agent_messages_broadcast
			ON cross_agent_messages(broadcast, expires_at, created_at, id);
		CREATE INDEX IF NOT EXISTS idx_cross_agent_messages_sender
			ON cross_agent_messages(from_agent_id, expires_at, created_at, id);
		CREATE INDEX IF NOT EXISTS idx_cross_agent_receipts_agent
			ON cross_agent_message_receipts(agent_id, acknowledged_at, message_id);
	`);
}
