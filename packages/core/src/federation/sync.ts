/**
 * @module federation/sync
 * @description Memory synchronization — request, handle, process syncs between peers.
 *
 * Trust enforcement: only peers with trust_level='trusted' can sync.
 * Privacy enforcement: only memories matching publish rules are shared.
 */

import { randomBytes } from "node:crypto";
import type {
	FederationDb,
	SyncRequest,
	SyncResponse,
	SyncMemory,
	PublishRule,
	SharedMemory,
	ReceivedMemory,
} from "./types";
import { getPublishableMemories } from "./publisher";
import {
	updatePeerLastSync,
	incrementMemoriesShared,
	incrementMemoriesReceived,
	getPeerById,
} from "./peer-manager";

// ---------------------------------------------------------------------------
// Generate IDs
// ---------------------------------------------------------------------------

function generateId(prefix: string = "fed"): string {
	return `${prefix}_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Request sync
// ---------------------------------------------------------------------------

/**
 * Build a sync request to send to a peer.
 * Optionally specify a 'since' date to get only newer memories.
 *
 * @param db - Database instance
 * @param peerId - Peer to sync with
 * @param since - ISO-8601 date — only request memories after this time
 * @returns SyncRequest payload
 */
export function requestSync(
	db: FederationDb,
	peerId: string,
	since?: string,
): SyncRequest {
	const peer = getPeerById(db, peerId);
	if (!peer) {
		throw new Error(`Peer not found: ${peerId}`);
	}
	if (peer.trustLevel !== "trusted") {
		throw new Error(`Cannot sync with peer ${peerId} — trust level is '${peer.trustLevel}', requires 'trusted'`);
	}

	// If no since date given, use the peer's last_sync time
	const effectiveSince = since ?? peer.lastSync ?? undefined;

	return {
		since: effectiveSince,
		limit: 100,
	};
}

// ---------------------------------------------------------------------------
// Handle incoming sync request
// ---------------------------------------------------------------------------

/**
 * Handle an incoming sync request from a peer.
 * Filters local memories by publish rules to determine what to share.
 *
 * @param db - Database instance
 * @param peerId - The requesting peer's ID
 * @param request - The sync request parameters
 * @returns SyncResponse with matching memories
 */
export function handleSyncRequest(
	db: FederationDb,
	peerId: string,
	request: SyncRequest,
): SyncResponse {
	const peer = getPeerById(db, peerId);
	if (!peer) {
		throw new Error(`Peer not found: ${peerId}`);
	}
	if (peer.trustLevel !== "trusted") {
		return { memories: [], hasMore: false, syncedAt: new Date().toISOString() };
	}

	// Get memories that match publish rules for this peer
	const publishable = getPublishableMemories(db, peerId);

	// Apply since filter
	let filtered = publishable;
	if (request.since) {
		const sinceMs = new Date(request.since).getTime();
		filtered = filtered.filter((m) => {
			const createdMs = new Date(m.createdAt).getTime();
			return !Number.isNaN(createdMs) && createdMs > sinceMs;
		});
	}

	// Apply types filter
	if (request.types && request.types.length > 0) {
		const typeSet = new Set(request.types);
		filtered = filtered.filter((m) => typeSet.has(m.type));
	}

	// Apply limit
	const limit = request.limit ?? 100;
	const hasMore = filtered.length > limit;
	const memories = filtered.slice(0, limit);

	// Record what we shared
	for (const memory of memories) {
		recordShared(db, memory.id, peerId);
	}

	if (memories.length > 0) {
		incrementMemoriesShared(db, peerId, memories.length);
		updatePeerLastSync(db, peerId);
	}

	return {
		memories,
		hasMore,
		syncedAt: new Date().toISOString(),
	};
}

// ---------------------------------------------------------------------------
// Process sync response (import received memories)
// ---------------------------------------------------------------------------

/**
 * Process memories received from a sync response.
 * Stores them in federation_received with provenance tracking.
 *
 * @param db - Database instance
 * @param peerId - The peer we received from
 * @param memories - The memories received
 * @returns Number of memories imported
 */
export function processSyncResponse(
	db: FederationDb,
	peerId: string,
	memories: SyncMemory[],
): number {
	let imported = 0;

	for (const memory of memories) {
		const id = generateId("recv");

		// Check if we already received this exact memory from this peer
		const existing = db.prepare(
			`SELECT id FROM federation_received
			 WHERE peer_id = ? AND original_content = ?`,
		).get(peerId, memory.content);
		if (existing) continue;

		db.prepare(
			`INSERT INTO federation_received
			 (id, memory_id, peer_id, original_content, original_signature, original_did, verified)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			null, // memory_id is null until explicitly imported into local memory
			peerId,
			memory.content,
			memory.signature ?? null,
			memory.signerDid ?? null,
			memory.signature && memory.signerDid ? 1 : 0,
		);
		imported++;
	}

	if (imported > 0) {
		incrementMemoriesReceived(db, peerId, imported);
		updatePeerLastSync(db, peerId);
	}

	return imported;
}

// ---------------------------------------------------------------------------
// Shared / Received tracking
// ---------------------------------------------------------------------------

/**
 * Record that a memory was shared with a peer.
 */
function recordShared(db: FederationDb, memoryId: string, peerId: string): void {
	const id = generateId("shared");
	try {
		db.prepare(
			`INSERT OR IGNORE INTO federation_shared (id, memory_id, peer_id)
			 VALUES (?, ?, ?)`,
		).run(id, memoryId, peerId);
	} catch {
		// UNIQUE constraint — already shared, that's fine
	}
}

/**
 * Get all memories we've shared with a specific peer.
 */
export function getSharedMemories(db: FederationDb, peerId: string): SharedMemory[] {
	return db
		.prepare("SELECT * FROM federation_shared WHERE peer_id = ? ORDER BY shared_at DESC")
		.all(peerId)
		.map((row) => ({
			id: row.id as string,
			memoryId: row.memory_id as string,
			peerId: row.peer_id as string,
			sharedAt: row.shared_at as string,
		}));
}

/**
 * Get all memories we've received from a specific peer.
 */
export function getReceivedMemories(db: FederationDb, peerId: string): ReceivedMemory[] {
	return db
		.prepare("SELECT * FROM federation_received WHERE peer_id = ? ORDER BY received_at DESC")
		.all(peerId)
		.map((row) => ({
			id: row.id as string,
			memoryId: (row.memory_id as string) || undefined,
			peerId: row.peer_id as string,
			originalContent: row.original_content as string,
			originalSignature: (row.original_signature as string) || undefined,
			originalDid: (row.original_did as string) || undefined,
			verified: !!(row.verified as number),
			receivedAt: row.received_at as string,
		}));
}
