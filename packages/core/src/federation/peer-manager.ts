/**
 * @module federation/peer-manager
 * @description Peer lifecycle management — add, trust, block, remove, heartbeat tracking.
 */

import type {
	FederationDb,
	FederationPeer,
	TrustLevel,
} from "./types";

// ---------------------------------------------------------------------------
// Row → FederationPeer conversion
// ---------------------------------------------------------------------------

function rowToPeer(row: Record<string, unknown>): FederationPeer {
	return {
		id: row.id as string,
		did: row.did as string,
		displayName: (row.display_name as string) || undefined,
		publicKey: row.public_key as string,
		endpointUrl: (row.endpoint_url as string) || undefined,
		chainAddress: (row.chain_address as string) || undefined,
		trustLevel: (row.trust_level as TrustLevel) || "pending",
		lastSeen: (row.last_seen as string) || undefined,
		lastSync: (row.last_sync as string) || undefined,
		memoriesShared: (row.memories_shared as number) || 0,
		memoriesReceived: (row.memories_received as number) || 0,
		createdAt: row.created_at as string,
	};
}

// ---------------------------------------------------------------------------
// Add peer
// ---------------------------------------------------------------------------

/**
 * Register a new peer in the federation_peers table.
 *
 * @param db - Database instance
 * @param peer - Peer data (id, did, publicKey are required)
 * @returns The created FederationPeer
 * @throws If a peer with the same DID already exists
 */
export function addPeer(
	db: FederationDb,
	peer: {
		id: string;
		did: string;
		publicKey: string;
		displayName?: string;
		endpointUrl?: string;
		chainAddress?: string;
		trustLevel?: TrustLevel;
	},
): FederationPeer {
	db.prepare(
		`INSERT INTO federation_peers
		 (id, did, display_name, public_key, endpoint_url, chain_address, trust_level)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		peer.id,
		peer.did,
		peer.displayName ?? null,
		peer.publicKey,
		peer.endpointUrl ?? null,
		peer.chainAddress ?? null,
		peer.trustLevel ?? "pending",
	);

	const row = db.prepare("SELECT * FROM federation_peers WHERE id = ?").get(peer.id);
	return rowToPeer(row!);
}

// ---------------------------------------------------------------------------
// Get peers
// ---------------------------------------------------------------------------

/**
 * Get a single peer by ID.
 */
export function getPeerById(db: FederationDb, peerId: string): FederationPeer | null {
	const row = db.prepare("SELECT * FROM federation_peers WHERE id = ?").get(peerId);
	return row ? rowToPeer(row) : null;
}

/**
 * Get a single peer by DID.
 */
export function getPeerByDid(db: FederationDb, did: string): FederationPeer | null {
	const row = db.prepare("SELECT * FROM federation_peers WHERE did = ?").get(did);
	return row ? rowToPeer(row) : null;
}

/**
 * List all peers, optionally filtered by trust level.
 */
export function getPeers(db: FederationDb, trustLevel?: TrustLevel): FederationPeer[] {
	if (trustLevel) {
		return db
			.prepare("SELECT * FROM federation_peers WHERE trust_level = ? ORDER BY created_at DESC")
			.all(trustLevel)
			.map(rowToPeer);
	}
	return db
		.prepare("SELECT * FROM federation_peers ORDER BY created_at DESC")
		.all()
		.map(rowToPeer);
}

/**
 * List trusted peers (the only ones allowed to sync).
 */
export function getTrustedPeers(db: FederationDb): FederationPeer[] {
	return getPeers(db, "trusted");
}

// ---------------------------------------------------------------------------
// Update trust
// ---------------------------------------------------------------------------

/**
 * Upgrade or downgrade a peer's trust level.
 *
 * @param db - Database instance
 * @param peerId - Peer ID to update
 * @param trustLevel - New trust level
 * @throws If peer does not exist
 */
export function updatePeerTrust(
	db: FederationDb,
	peerId: string,
	trustLevel: TrustLevel,
): void {
	const result = db
		.prepare("UPDATE federation_peers SET trust_level = ? WHERE id = ?")
		.run(trustLevel, peerId);
	if (result.changes === 0) {
		throw new Error(`Peer not found: ${peerId}`);
	}
}

/**
 * Block a peer — sets trust to 'blocked'.
 */
export function blockPeer(db: FederationDb, peerId: string): void {
	updatePeerTrust(db, peerId, "blocked");
}

// ---------------------------------------------------------------------------
// Remove peer
// ---------------------------------------------------------------------------

/**
 * Remove a peer and all associated shared/received records.
 */
export function removePeer(db: FederationDb, peerId: string): void {
	// Delete shared & received records first (foreign key)
	db.prepare("DELETE FROM federation_shared WHERE peer_id = ?").run(peerId);
	db.prepare("DELETE FROM federation_received WHERE peer_id = ?").run(peerId);
	const result = db.prepare("DELETE FROM federation_peers WHERE id = ?").run(peerId);
	if (result.changes === 0) {
		throw new Error(`Peer not found: ${peerId}`);
	}
}

// ---------------------------------------------------------------------------
// Heartbeat tracking
// ---------------------------------------------------------------------------

/**
 * Update a peer's last_seen timestamp (called on every received message).
 */
export function updatePeerLastSeen(db: FederationDb, peerId: string): void {
	db.prepare(
		"UPDATE federation_peers SET last_seen = datetime('now') WHERE id = ?",
	).run(peerId);
}

/**
 * Update a peer's last_sync timestamp (called after successful sync).
 */
export function updatePeerLastSync(db: FederationDb, peerId: string): void {
	db.prepare(
		"UPDATE federation_peers SET last_sync = datetime('now') WHERE id = ?",
	).run(peerId);
}

// ---------------------------------------------------------------------------
// Counter updates
// ---------------------------------------------------------------------------

/**
 * Increment the memories_shared counter for a peer.
 */
export function incrementMemoriesShared(db: FederationDb, peerId: string, count: number = 1): void {
	db.prepare(
		"UPDATE federation_peers SET memories_shared = memories_shared + ? WHERE id = ?",
	).run(count, peerId);
}

/**
 * Increment the memories_received counter for a peer.
 */
export function incrementMemoriesReceived(db: FederationDb, peerId: string, count: number = 1): void {
	db.prepare(
		"UPDATE federation_peers SET memories_received = memories_received + ? WHERE id = ?",
	).run(count, peerId);
}

/**
 * Update the peer's endpoint URL.
 */
export function updatePeerEndpoint(db: FederationDb, peerId: string, endpointUrl: string): void {
	db.prepare(
		"UPDATE federation_peers SET endpoint_url = ? WHERE id = ?",
	).run(endpointUrl, peerId);
}
