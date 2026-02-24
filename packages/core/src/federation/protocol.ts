/**
 * @module federation/protocol
 * @description WebSocket message protocol — signed message creation, verification, parsing.
 *
 * Every federation message is DID-signed. The signable payload is:
 *   JSON.stringify({ type, payload, timestamp })
 * The signature is a detached Ed25519 signature over this string.
 */

import sodium from "libsodium-wrappers";
import { signContent, verifySignature } from "../crypto";
import type {
	PeerMessage,
	MessageType,
	MESSAGE_TYPES,
} from "./types";

// ---------------------------------------------------------------------------
// Message creation (sign with local DID key)
// ---------------------------------------------------------------------------

/**
 * Build the canonical signable string for a message.
 * Deterministic: type + payload + timestamp, JSON-serialized.
 */
export function buildMessageSignable(type: MessageType, payload: unknown, timestamp: string): string {
	return JSON.stringify({ type, payload, timestamp });
}

/**
 * Create a signed federation message.
 *
 * @param type - Message type (HANDSHAKE, SYNC_REQUEST, etc.)
 * @param payload - Message payload (type-specific)
 * @param senderDid - The sender's DID string
 * @returns Signed PeerMessage ready for serialization
 */
export async function createMessage<T = unknown>(
	type: MessageType,
	payload: T,
	senderDid: string,
): Promise<PeerMessage<T>> {
	const timestamp = new Date().toISOString();
	const signable = buildMessageSignable(type, payload, timestamp);
	const signature = await signContent(signable);

	return {
		type,
		payload,
		timestamp,
		signature,
		senderDid,
	};
}

// ---------------------------------------------------------------------------
// Message verification
// ---------------------------------------------------------------------------

/**
 * Verify a federation message's signature using the sender's public key.
 *
 * @param message - The received PeerMessage
 * @param publicKey - The sender's Ed25519 public key (raw Uint8Array, 32 bytes)
 * @returns true if signature is valid
 */
export async function verifyMessage(
	message: PeerMessage,
	publicKey: Uint8Array,
): Promise<boolean> {
	const signable = buildMessageSignable(message.type, message.payload, message.timestamp);
	return verifySignature(signable, message.signature, publicKey);
}

// ---------------------------------------------------------------------------
// Message parsing & validation
// ---------------------------------------------------------------------------

const VALID_MESSAGE_TYPES = new Set<string>([
	"HANDSHAKE",
	"HANDSHAKE_ACK",
	"SYNC_REQUEST",
	"SYNC_RESPONSE",
	"MEMORY_PUSH",
	"MEMORY_ACK",
	"PING",
	"PONG",
	"ERROR",
]);

/**
 * Parse a raw WebSocket message string into a PeerMessage.
 * Validates structure but does NOT verify the signature — call verifyMessage separately.
 *
 * @param raw - Raw JSON string from WebSocket
 * @returns Parsed PeerMessage
 * @throws Error if the message is malformed
 */
export function parseMessage(raw: string): PeerMessage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Invalid JSON in federation message");
	}

	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("Federation message must be a JSON object");
	}

	const msg = parsed as Record<string, unknown>;

	// Validate required fields
	if (typeof msg.type !== "string" || !VALID_MESSAGE_TYPES.has(msg.type)) {
		throw new Error(`Invalid message type: ${msg.type}`);
	}
	if (msg.payload === undefined) {
		throw new Error("Missing message payload");
	}
	if (typeof msg.timestamp !== "string") {
		throw new Error("Missing or invalid timestamp");
	}
	if (typeof msg.signature !== "string" || msg.signature.length === 0) {
		throw new Error("Missing message signature — all federation messages must be DID-signed");
	}
	if (typeof msg.senderDid !== "string" || !msg.senderDid.startsWith("did:")) {
		throw new Error("Missing or invalid senderDid");
	}

	// Validate timestamp is not too old (5 minute window to prevent replay attacks)
	const msgTime = new Date(msg.timestamp).getTime();
	const now = Date.now();
	if (Number.isNaN(msgTime)) {
		throw new Error("Invalid timestamp format");
	}
	const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
	if (Math.abs(now - msgTime) > MAX_AGE_MS) {
		throw new Error("Message timestamp outside acceptable window (±5 minutes)");
	}

	return {
		type: msg.type as MessageType,
		payload: msg.payload,
		timestamp: msg.timestamp as string,
		signature: msg.signature as string,
		senderDid: msg.senderDid as string,
	};
}

/**
 * Serialize a PeerMessage to a JSON string for WebSocket transmission.
 */
export function serializeMessage(message: PeerMessage): string {
	return JSON.stringify(message);
}
