/**
 * @module federation/handshake
 * @description DID-verified peer handshake with challenge-response authentication.
 *
 * Protocol:
 *   1. Initiator sends HANDSHAKE with DID, publicKey, and a random challenge nonce
 *   2. Responder verifies initiator's DID, signs the challenge to prove own identity,
 *      responds with HANDSHAKE_ACK containing their own DID + a counter-challenge
 *   3. Initiator verifies response, signs the counter-challenge, completes handshake
 *
 * This ensures both parties cryptographically prove DID ownership — no imposters.
 */

import { randomBytes } from "node:crypto";
import sodium from "libsodium-wrappers";
import { signContent, verifySignature } from "../crypto";
import { didToPublicKey, isValidDid } from "../did";
import type {
	HandshakePayload,
	HandshakeAckPayload,
	PeerMessage,
} from "./types";
import { createMessage, verifyMessage } from "./protocol";

// ---------------------------------------------------------------------------
// Challenge generation
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random challenge nonce (32 bytes, hex-encoded).
 */
export function generateChallenge(): string {
	return randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// Step 1: Initiate handshake
// ---------------------------------------------------------------------------

/**
 * Create a HANDSHAKE message to initiate a peer connection.
 *
 * @param localDid - Our DID string
 * @param localPublicKey - Our base64 public key
 * @param options - Optional display name and chain address
 * @returns The handshake message and the challenge (caller must store for step 3)
 */
export async function initiateHandshake(
	localDid: string,
	localPublicKey: string,
	options?: { displayName?: string; chainAddress?: string },
): Promise<{ message: PeerMessage<HandshakePayload>; challenge: string }> {
	const challenge = generateChallenge();

	const payload: HandshakePayload = {
		did: localDid,
		publicKey: localPublicKey,
		challenge,
		displayName: options?.displayName,
		chainAddress: options?.chainAddress,
	};

	const message = await createMessage<HandshakePayload>("HANDSHAKE", payload, localDid);

	return { message, challenge };
}

// ---------------------------------------------------------------------------
// Step 2: Respond to handshake
// ---------------------------------------------------------------------------

/**
 * Validate and respond to an incoming HANDSHAKE message.
 *
 * Verifies:
 * - The sender's DID is valid
 * - The DID matches the public key in the payload
 * - The message signature is valid
 *
 * Then signs the sender's challenge and creates a counter-challenge.
 *
 * @param handshake - The received HANDSHAKE message
 * @param localDid - Our DID string
 * @param localPublicKey - Our base64 public key
 * @param options - Optional display name and chain address
 * @returns The HANDSHAKE_ACK message and our counter-challenge
 * @throws If DID verification fails
 */
export async function respondToHandshake(
	handshake: PeerMessage<HandshakePayload>,
	localDid: string,
	localPublicKey: string,
	options?: { displayName?: string; chainAddress?: string },
): Promise<{ message: PeerMessage<HandshakeAckPayload>; counterChallenge: string }> {
	await sodium.ready;

	const { did: peerDid, publicKey: peerPublicKeyB64, challenge } = handshake.payload;

	// 1. Validate peer's DID format
	if (!isValidDid(peerDid)) {
		throw new Error(`Invalid peer DID: ${peerDid}`);
	}

	// 2. Verify DID matches the public key
	const didPublicKey = didToPublicKey(peerDid);
	const peerPublicKey = sodium.from_base64(peerPublicKeyB64, sodium.base64_variants.ORIGINAL);
	if (!sodium.memcmp(didPublicKey, peerPublicKey)) {
		throw new Error("Peer DID does not match the provided public key — possible impersonation");
	}

	// 3. Verify the handshake message signature
	const valid = await verifyMessage(handshake, peerPublicKey);
	if (!valid) {
		throw new Error("Invalid handshake signature — message may be tampered");
	}

	// 4. Sign the peer's challenge to prove our DID ownership
	const challengeResponse = await signContent(challenge);

	// 5. Generate our counter-challenge
	const counterChallenge = generateChallenge();

	const payload: HandshakeAckPayload = {
		did: localDid,
		publicKey: localPublicKey,
		challengeResponse,
		counterChallenge,
		displayName: options?.displayName,
		chainAddress: options?.chainAddress,
	};

	const message = await createMessage<HandshakeAckPayload>("HANDSHAKE_ACK", payload, localDid);

	return { message, counterChallenge };
}

// ---------------------------------------------------------------------------
// Step 3: Complete handshake
// ---------------------------------------------------------------------------

/**
 * Validate the HANDSHAKE_ACK and complete the handshake.
 *
 * Verifies:
 * - The responder's DID is valid
 * - The DID matches the public key
 * - The message signature is valid
 * - The challenge response correctly signs our original challenge
 *
 * @param ack - The received HANDSHAKE_ACK message
 * @param originalChallenge - The challenge we sent in step 1
 * @returns Verified peer info (DID, publicKey, displayName)
 * @throws If any verification fails
 */
export async function completeHandshake(
	ack: PeerMessage<HandshakeAckPayload>,
	originalChallenge: string,
): Promise<{
	peerDid: string;
	peerPublicKey: Uint8Array;
	peerPublicKeyB64: string;
	displayName?: string;
	chainAddress?: string;
	counterChallenge: string;
}> {
	await sodium.ready;

	const {
		did: peerDid,
		publicKey: peerPublicKeyB64,
		challengeResponse,
		counterChallenge,
		displayName,
		chainAddress,
	} = ack.payload;

	// 1. Validate peer's DID format
	if (!isValidDid(peerDid)) {
		throw new Error(`Invalid peer DID in handshake ACK: ${peerDid}`);
	}

	// 2. Verify DID matches the public key
	const didPublicKey = didToPublicKey(peerDid);
	const peerPublicKey = sodium.from_base64(peerPublicKeyB64, sodium.base64_variants.ORIGINAL);
	if (!sodium.memcmp(didPublicKey, peerPublicKey)) {
		throw new Error("Peer DID does not match the provided public key in ACK");
	}

	// 3. Verify the ACK message signature
	const valid = await verifyMessage(ack, peerPublicKey);
	if (!valid) {
		throw new Error("Invalid handshake ACK signature");
	}

	// 4. Verify the challenge response: peer signed our original challenge
	const challengeValid = await verifySignature(originalChallenge, challengeResponse, peerPublicKey);
	if (!challengeValid) {
		throw new Error("Challenge-response verification failed — peer cannot prove DID ownership");
	}

	return {
		peerDid,
		peerPublicKey,
		peerPublicKeyB64,
		displayName,
		chainAddress,
		counterChallenge,
	};
}

/**
 * Sign a counter-challenge to send back to the peer (final handshake step).
 * The peer who initiated will call this to respond to the counterChallenge.
 *
 * @param counterChallenge - The counter-challenge received from the peer
 * @returns Base64 signature over the counter-challenge
 */
export async function signCounterChallenge(counterChallenge: string): Promise<string> {
	return signContent(counterChallenge);
}

/**
 * Verify the initiator's counter-challenge response (called by responder).
 *
 * @param counterChallenge - The counter-challenge we sent
 * @param response - The initiator's signature over our counter-challenge
 * @param peerPublicKey - The initiator's public key
 * @returns true if valid
 */
export async function verifyCounterChallengeResponse(
	counterChallenge: string,
	response: string,
	peerPublicKey: Uint8Array,
): Promise<boolean> {
	return verifySignature(counterChallenge, response, peerPublicKey);
}
