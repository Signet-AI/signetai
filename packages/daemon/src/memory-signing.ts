/**
 * Memory signing middleware.
 *
 * Signs memory content before insertion into the database.
 * This module provides async functions that should be called BEFORE
 * entering the synchronous database transaction.
 *
 * Signing is optional — if no keypair exists, memories are stored unsigned.
 * The `autoSign` flag in agent.yaml controls whether signing is attempted.
 */

import {
	hasSigningKeypair,
	signContent,
	getPublicKeyBytes,
	verifySignature,
	publicKeyToDid,
	didToPublicKey,
	isAutoSignEnabled,
} from "@signet/core";
import type { IngestEnvelope } from "./transactions";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Cached DID — resolved once at first signing attempt. */
let _cachedDid: string | null = null;

/** Whether signing is available (keypair exists). Cached with 60s TTL. */
let _signingAvailable: boolean | null = null;
let _signingCheckedAt = 0;
const SIGNING_CACHE_TTL_MS = 60_000; // Re-check every 60s

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if memory signing is available (keypair exists).
 * Cached with 60s TTL so key creation mid-process is detected
 * without requiring a daemon restart.
 */
export function isSigningAvailable(): boolean {
	const now = Date.now();
	if (_signingAvailable !== null && now - _signingCheckedAt < SIGNING_CACHE_TTL_MS) {
		return _signingAvailable;
	}
	_signingAvailable = hasSigningKeypair();
	_signingCheckedAt = now;
	return _signingAvailable;
}

/**
 * Get the agent's DID. Returns null if no keypair exists.
 */
export async function getAgentDid(): Promise<string | null> {
	if (_cachedDid !== null) return _cachedDid;
	if (!isSigningAvailable()) return null;

	try {
		const pubKey = await getPublicKeyBytes();
		_cachedDid = publicKeyToDid(pubKey);
		return _cachedDid;
	} catch {
		_signingAvailable = false;
		return null;
	}
}

/**
 * Build the signable payload for a memory entry.
 *
 * The signed content is: `contentHash|createdAt|signerDid`
 * This binds the signature to the content, timestamp, and signer identity.
 *
 * All fields are validated to prevent delimiter injection attacks where a
 * crafted field containing `|` could forge a different payload.
 */
export function buildSignablePayload(
	contentHash: string,
	createdAt: string,
	signerDid: string,
): string {
	// Validate contentHash is lowercase hex only (SHA-256 output)
	if (!/^[0-9a-f]+$/.test(contentHash)) {
		throw new Error("contentHash must be lowercase hex");
	}
	// Validate no delimiters in any field (defense in depth)
	if (createdAt.includes("|") || signerDid.includes("|")) {
		throw new Error("Signing payload fields must not contain pipe characters");
	}
	return `${contentHash}|${createdAt}|${signerDid}`;
}

/**
 * Sign an ingest envelope before database insertion.
 *
 * Returns a new envelope with `signature` and `signerDid` added.
 * If signing is not available (no keypair) or autoSign is disabled
 * in agent.yaml, the envelope is returned unchanged.
 *
 * This MUST be called outside the database transaction (signing is async).
 */
export async function signEnvelope(
	envelope: IngestEnvelope,
): Promise<IngestEnvelope> {
	if (!isSigningAvailable()) return envelope;

	// Respect the autoSign config flag in agent.yaml
	if (!isAutoSignEnabled()) return envelope;

	const did = await getAgentDid();
	if (!did) return envelope;

	try {
		const payload = buildSignablePayload(
			envelope.contentHash,
			envelope.createdAt,
			did,
		);
		const signature = await signContent(payload);

		// Return a new object — don't mutate the input (avoids race conditions
		// if the caller retries or passes the same envelope elsewhere).
		return { ...envelope, signerDid: did, signature };
	} catch (err) {
		// Signing failed — log but don't block memory creation
		console.warn(
			"[memory-signing] Failed to sign memory:",
			err instanceof Error ? err.message : String(err),
		);
	}

	return envelope;
}

/**
 * Verify a memory's signature.
 *
 * @param contentHash - The memory's content hash
 * @param createdAt - The memory's creation timestamp
 * @param signerDid - The DID that signed the memory
 * @param signature - The base64-encoded signature
 * @returns true if valid, false if invalid or verification fails
 */
export async function verifyMemorySignature(
	contentHash: string,
	createdAt: string,
	signerDid: string,
	signature: string,
): Promise<boolean> {
	try {
		// Extract public key from DID (statically imported, not dynamic import)
		const publicKey = didToPublicKey(signerDid);

		const payload = buildSignablePayload(contentHash, createdAt, signerDid);
		return await verifySignature(payload, signature, publicKey);
	} catch {
		return false;
	}
}

/**
 * Reset cached state. Useful after keypair generation.
 */
export function resetSigningCache(): void {
	_cachedDid = null;
	_signingAvailable = null;
	_signingCheckedAt = 0;
}
