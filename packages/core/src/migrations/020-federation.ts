/**
 * Migration 020: Federation Tables
 *
 * Phase 5 — P2P Federation with DID-verified handshakes and selective memory publishing.
 *
 * Creates tables for:
 * - federation_peers: Known peer identities with trust levels
 * - federation_shared: Track memories shared with each peer
 * - federation_received: Track memories received from peers with provenance
 * - federation_publish_rules: User-defined rules for selective memory publishing
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS federation_peers (
			id TEXT PRIMARY KEY,
			did TEXT NOT NULL UNIQUE,
			display_name TEXT,
			public_key TEXT NOT NULL,
			endpoint_url TEXT,
			chain_address TEXT,
			trust_level TEXT DEFAULT 'pending',
			last_seen TEXT,
			last_sync TEXT,
			memories_shared INTEGER DEFAULT 0,
			memories_received INTEGER DEFAULT 0,
			created_at TEXT DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_federation_peers_did
			ON federation_peers(did);
		CREATE INDEX IF NOT EXISTS idx_federation_peers_trust
			ON federation_peers(trust_level);
		CREATE INDEX IF NOT EXISTS idx_federation_peers_endpoint
			ON federation_peers(endpoint_url);

		CREATE TABLE IF NOT EXISTS federation_shared (
			id TEXT PRIMARY KEY,
			memory_id TEXT NOT NULL,
			peer_id TEXT NOT NULL REFERENCES federation_peers(id),
			shared_at TEXT DEFAULT (datetime('now')),
			UNIQUE(memory_id, peer_id)
		);

		CREATE INDEX IF NOT EXISTS idx_federation_shared_peer
			ON federation_shared(peer_id);
		CREATE INDEX IF NOT EXISTS idx_federation_shared_memory
			ON federation_shared(memory_id);

		CREATE TABLE IF NOT EXISTS federation_received (
			id TEXT PRIMARY KEY,
			memory_id TEXT,
			peer_id TEXT NOT NULL REFERENCES federation_peers(id),
			original_content TEXT NOT NULL,
			original_signature TEXT,
			original_did TEXT,
			verified INTEGER DEFAULT 0,
			received_at TEXT DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_federation_received_peer
			ON federation_received(peer_id);
		CREATE INDEX IF NOT EXISTS idx_federation_received_memory
			ON federation_received(memory_id);
		CREATE INDEX IF NOT EXISTS idx_federation_received_verified
			ON federation_received(verified);

		CREATE TABLE IF NOT EXISTS federation_publish_rules (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			query TEXT,
			tags TEXT,
			types TEXT,
			min_importance REAL DEFAULT 0.5,
			peer_ids TEXT,
			auto_publish INTEGER DEFAULT 0,
			created_at TEXT DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_federation_publish_rules_auto
			ON federation_publish_rules(auto_publish);
	`);
}
