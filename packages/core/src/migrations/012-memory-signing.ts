/**
 * Migration 012: Memory Signing & Merkle Anchoring
 *
 * Adds cryptographic signing columns to the memories table and
 * creates the merkle_roots table for on-chain anchoring support.
 *
 * New columns on memories:
 *   - signature: Ed25519 detached signature (base64) of contentHash+createdAt+signerDid
 *   - signer_did: DID of the agent that signed this memory (did:key:z6Mk...)
 *
 * New table merkle_roots:
 *   - Tracks periodic Merkle root computations for memory provenance
 *   - Supports optional on-chain anchoring metadata
 */

import type { MigrationDb } from "./index";

/** Helper: add a column only if it doesn't already exist. */
function addColumnIfMissing(
	db: MigrationDb,
	table: string,
	column: string,
	definition: string,
): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<
		Record<string, unknown>
	>;
	if (!cols.some((c) => c.name === column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}

export function up(db: MigrationDb): void {
	// Add signing columns to memories table
	addColumnIfMissing(db, "memories", "signature", "TEXT");
	addColumnIfMissing(db, "memories", "signer_did", "TEXT");

	// Create merkle_roots table for provenance anchoring
	db.exec(`
		CREATE TABLE IF NOT EXISTS merkle_roots (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			root_hash TEXT NOT NULL,
			memory_count INTEGER NOT NULL,
			leaf_hashes TEXT,
			computed_at TEXT NOT NULL,
			signer_did TEXT,
			signature TEXT,
			anchor_chain TEXT,
			anchor_tx TEXT,
			anchor_block INTEGER,
			anchor_timestamp TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_merkle_roots_computed_at
			ON merkle_roots(computed_at);
		CREATE INDEX IF NOT EXISTS idx_merkle_roots_anchor_chain
			ON merkle_roots(anchor_chain);
		CREATE INDEX IF NOT EXISTS idx_memories_signer_did
			ON memories(signer_did);
	`);
}
