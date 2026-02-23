/**
 * Migration 018: On-Chain Identity Tables
 *
 * Phase 4A — On-Chain Identity (ERC-8004)
 *
 * Creates tables for:
 * - onchain_identity: Stores on-chain agent identity registrations
 * - memory_anchors: Tracks memory Merkle root anchoring transactions
 * - wallet_config: Ethereum wallet configuration (keys encrypted with master key)
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS onchain_identity (
			id TEXT PRIMARY KEY,
			chain TEXT NOT NULL,
			token_id TEXT,
			contract_address TEXT,
			wallet_address TEXT NOT NULL,
			did TEXT NOT NULL,
			tx_hash TEXT,
			registered_at TEXT,
			created_at TEXT DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_onchain_identity_chain
			ON onchain_identity(chain);
		CREATE INDEX IF NOT EXISTS idx_onchain_identity_did
			ON onchain_identity(did);
		CREATE INDEX IF NOT EXISTS idx_onchain_identity_wallet
			ON onchain_identity(wallet_address);

		CREATE TABLE IF NOT EXISTS memory_anchors (
			id TEXT PRIMARY KEY,
			onchain_id TEXT REFERENCES onchain_identity(id),
			memory_root TEXT NOT NULL,
			memory_count INTEGER NOT NULL,
			tx_hash TEXT,
			anchored_at TEXT,
			created_at TEXT DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_memory_anchors_onchain
			ON memory_anchors(onchain_id);
		CREATE INDEX IF NOT EXISTS idx_memory_anchors_root
			ON memory_anchors(memory_root);

		CREATE TABLE IF NOT EXISTS wallet_config (
			id TEXT PRIMARY KEY,
			chain TEXT NOT NULL,
			address TEXT NOT NULL,
			encrypted_key TEXT,
			key_type TEXT DEFAULT 'secp256k1',
			is_default INTEGER DEFAULT 0,
			created_at TEXT DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_wallet_config_chain
			ON wallet_config(chain);
		CREATE INDEX IF NOT EXISTS idx_wallet_config_address
			ON wallet_config(address);
		CREATE INDEX IF NOT EXISTS idx_wallet_config_default
			ON wallet_config(is_default);
	`);
}
