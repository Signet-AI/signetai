/**
 * Migration 019: Session Keys, Payment Log, and Export Bundles
 *
 * Phase 4B — Session Keys, x402 Payments, and Portable Export/Import
 *
 * Creates tables for:
 * - session_keys: Ephemeral session keys with scoped permissions
 * - payment_log: x402 payment transaction history
 * - export_bundles: Signed export bundle records
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_keys (
			id TEXT PRIMARY KEY,
			wallet_address TEXT NOT NULL,
			session_address TEXT NOT NULL,
			encrypted_private_key TEXT NOT NULL,
			permissions TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			created_at TEXT DEFAULT (datetime('now')),
			revoked_at TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_session_keys_wallet
			ON session_keys(wallet_address);
		CREATE INDEX IF NOT EXISTS idx_session_keys_session_address
			ON session_keys(session_address);
		CREATE INDEX IF NOT EXISTS idx_session_keys_expires
			ON session_keys(expires_at);

		CREATE TABLE IF NOT EXISTS payment_log (
			id TEXT PRIMARY KEY,
			session_key_id TEXT REFERENCES session_keys(id),
			from_address TEXT NOT NULL,
			to_address TEXT NOT NULL,
			amount TEXT NOT NULL,
			tx_hash TEXT,
			purpose TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			created_at TEXT DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_payment_log_session_key
			ON payment_log(session_key_id);
		CREATE INDEX IF NOT EXISTS idx_payment_log_from
			ON payment_log(from_address);
		CREATE INDEX IF NOT EXISTS idx_payment_log_to
			ON payment_log(to_address);
		CREATE INDEX IF NOT EXISTS idx_payment_log_status
			ON payment_log(status);
		CREATE INDEX IF NOT EXISTS idx_payment_log_created
			ON payment_log(created_at);

		CREATE TABLE IF NOT EXISTS export_bundles (
			id TEXT PRIMARY KEY,
			format TEXT NOT NULL,
			memory_count INTEGER NOT NULL DEFAULT 0,
			file_path TEXT,
			checksum TEXT,
			signature TEXT,
			exported_at TEXT DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_export_bundles_format
			ON export_bundles(format);
		CREATE INDEX IF NOT EXISTS idx_export_bundles_exported
			ON export_bundles(exported_at);
	`);
}
