/**
 * @module federation/types
 * @description Type definitions for P2P federation protocol.
 *
 * Covers peer identity, WebSocket message protocol, sync requests/responses,
 * selective publish rules, and federation configuration.
 */

// ---------------------------------------------------------------------------
// Trust Levels
// ---------------------------------------------------------------------------

export const TRUST_LEVELS = ["pending", "trusted", "blocked"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

// ---------------------------------------------------------------------------
// Federation Peer
// ---------------------------------------------------------------------------

export interface FederationPeer {
	id: string;
	did: string;
	displayName?: string;
	publicKey: string;          // base64 Ed25519 public key
	endpointUrl?: string;       // WebSocket URL
	chainAddress?: string;      // On-chain identity if verified
	trustLevel: TrustLevel;
	lastSeen?: string;          // ISO-8601
	lastSync?: string;          // ISO-8601
	memoriesShared: number;
	memoriesReceived: number;
	createdAt: string;          // ISO-8601
}

// ---------------------------------------------------------------------------
// Message Protocol
// ---------------------------------------------------------------------------

export const MESSAGE_TYPES = [
	"HANDSHAKE",
	"HANDSHAKE_ACK",
	"SYNC_REQUEST",
	"SYNC_RESPONSE",
	"MEMORY_PUSH",
	"MEMORY_ACK",
	"PING",
	"PONG",
	"ERROR",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface PeerMessage<T = unknown> {
	type: MessageType;
	payload: T;
	timestamp: string;          // ISO-8601
	signature: string;          // base64, Ed25519 detached over JSON.stringify({type,payload,timestamp})
	senderDid: string;          // DID of the sender
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

export interface HandshakePayload {
	did: string;
	publicKey: string;          // base64
	displayName?: string;
	challenge: string;          // random hex nonce for challenge-response
	chainAddress?: string;
}

export interface HandshakeAckPayload {
	did: string;
	publicKey: string;          // base64
	displayName?: string;
	challengeResponse: string;  // signature over the received challenge
	counterChallenge: string;   // our own challenge for the initiator
	chainAddress?: string;
}

export interface HandshakeCompletePayload {
	challengeResponse: string;  // signature over the counterChallenge
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface SyncRequest {
	since?: string;             // ISO-8601 — only memories after this date
	types?: string[];           // memory types to sync
	limit?: number;
}

export interface SyncMemory {
	id: string;
	content: string;
	type: string;
	tags?: string[];
	importance?: number;
	who?: string;
	contentHash?: string;
	signature?: string;
	signerDid?: string;
	createdAt: string;
}

export interface SyncResponse {
	memories: SyncMemory[];
	hasMore: boolean;
	syncedAt: string;           // ISO-8601
}

// ---------------------------------------------------------------------------
// Memory Push/Ack
// ---------------------------------------------------------------------------

export interface MemoryPushPayload {
	memory: SyncMemory;
}

export interface MemoryAckPayload {
	memoryId: string;
	accepted: boolean;
	reason?: string;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export interface ErrorPayload {
	code: string;
	message: string;
}

// ---------------------------------------------------------------------------
// Shared / Received Tracking
// ---------------------------------------------------------------------------

export interface SharedMemory {
	id: string;
	memoryId: string;
	peerId: string;
	sharedAt: string;
}

export interface ReceivedMemory {
	id: string;
	memoryId?: string;          // local memory ID after import
	peerId: string;
	originalContent: string;
	originalSignature?: string;
	originalDid?: string;
	verified: boolean;
	receivedAt: string;
}

// ---------------------------------------------------------------------------
// Publish Rules
// ---------------------------------------------------------------------------

export interface PublishRule {
	id: string;
	name: string;
	query?: string;             // memory search query
	tags?: string[];            // JSON array of tags to match
	types?: string[];           // JSON array of memory types to match
	minImportance: number;
	peerIds?: string[];         // JSON array of peer IDs; null = all trusted
	autoPublish: boolean;
	createdAt: string;
}

// ---------------------------------------------------------------------------
// Federation Config
// ---------------------------------------------------------------------------

export interface FederationConfig {
	/** Port for the WebSocket server */
	port: number;
	/** Agent's DID string */
	did: string;
	/** Agent's base64 public key */
	publicKey: string;
	/** Optional display name */
	displayName?: string;
	/** Ping interval in ms (default 30000) */
	pingIntervalMs?: number;
	/** Max messages per minute per peer (rate limiting) */
	maxMessagesPerMinute?: number;
	/** Auto-reconnect delay in ms for client connections */
	reconnectDelayMs?: number;
	/** Max reconnect attempts before giving up */
	maxReconnectAttempts?: number;
	/** On-chain address if registered */
	chainAddress?: string;
}

// ---------------------------------------------------------------------------
// DB interface (subset compatible with better-sqlite3)
// ---------------------------------------------------------------------------

export interface FederationDb {
	prepare(sql: string): {
		run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
	exec(sql: string): void;
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export interface PeerConnection {
	peerId: string;
	did: string;
	publicKey: string;
	trustLevel: TrustLevel;
	connected: boolean;
	lastPing?: string;
}
