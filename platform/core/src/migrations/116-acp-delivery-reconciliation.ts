import type { MigrationDb } from "./index";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	return db
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.some((row) => row.name === column);
}

function addColumnIfMissing(db: MigrationDb, column: string, definition: string): void {
	if (!hasColumn(db, "cross_agent_messages", column)) {
		db.exec(`ALTER TABLE cross_agent_messages ADD COLUMN ${column} ${definition}`);
	}
}

/**
 * Migration 116: durable ACP relay attempt reconciliation (#1263).
 *
 * The existing delivery_status column is kept for compatibility with clients
 * that only understand queued/delivered/failed. delivery_state carries the
 * finer-grained crash-window state and the lease fields prevent another
 * daemon from declaring an active relay abandoned.
 */
export function up(db: MigrationDb): void {
	const table = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cross_agent_messages'")
		.get() as { name?: string } | null | undefined;
	if (table == null) return;

	addColumnIfMissing(db, "delivery_state", "TEXT NOT NULL DEFAULT 'pending'");
	addColumnIfMissing(db, "delivery_attempt_id", "TEXT");
	addColumnIfMissing(db, "delivery_attempts", "INTEGER NOT NULL DEFAULT 0");
	addColumnIfMissing(db, "delivery_lease_token", "TEXT");
	addColumnIfMissing(db, "delivery_lease_expires_at", "TEXT");
	addColumnIfMissing(db, "delivery_attempt_started_at", "TEXT");
	addColumnIfMissing(db, "delivery_updated_at", "TEXT");
	addColumnIfMissing(db, "acp_base_url", "TEXT");
	addColumnIfMissing(db, "acp_target_agent_name", "TEXT");
	addColumnIfMissing(db, "acp_timeout_ms", "INTEGER");
	addColumnIfMissing(db, "acp_metadata_json", "TEXT");

	db.exec(`
		UPDATE cross_agent_messages
		SET delivery_state = CASE delivery_status
			WHEN 'delivered' THEN 'delivered'
			WHEN 'failed' THEN 'failed'
			ELSE 'pending'
		END
		WHERE delivery_state = 'pending';

		UPDATE cross_agent_messages
		SET delivery_attempt_id = id
		WHERE delivery_attempt_id IS NULL;

		UPDATE cross_agent_messages
		SET delivery_updated_at = created_at
		WHERE delivery_updated_at IS NULL;

		CREATE INDEX IF NOT EXISTS idx_cross_agent_messages_delivery_reconciliation
			ON cross_agent_messages(delivery_path, delivery_state, delivery_lease_expires_at, delivery_updated_at);
	`);
}
