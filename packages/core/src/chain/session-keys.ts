/**
 * @module chain/session-keys
 * @description Ephemeral session key management for scoped agent operations.
 *
 * Session keys are temporary Ethereum wallets with restricted permissions,
 * ideal for automated agent tasks like x402 payments. The private key is
 * encrypted at rest using the same XSalsa20-Poly1305 (libsodium secretbox)
 * scheme as the master wallet in wallet.ts.
 *
 * Session keys enforce:
 * - Time-based expiry (configurable duration)
 * - Maximum transaction value
 * - Allowed contracts and function selectors
 * - Daily transaction count and spend limits
 */

import { ethers } from "ethers";
import sodium from "libsodium-wrappers";
import { getMasterKey, getKeypairKdfVersion } from "../crypto";
import type { ChainDb } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionPermissions {
	/** Maximum value per transaction in ETH (as string for precision) */
	maxTransactionValue: string;
	/** Allowed contract addresses (empty = all allowed) */
	allowedContracts: string[];
	/** Allowed function selectors (4-byte hex, empty = all allowed) */
	allowedFunctions: string[];
	/** Maximum number of transactions per day */
	maxDailyTransactions: number;
	/** Maximum total spend per day in ETH (as string) */
	maxDailySpend: string;
}

export interface SessionKey {
	/** Unique session key identifier */
	id: string;
	/** Parent wallet address that owns this session key */
	walletAddress: string;
	/** Ethereum address of the session key */
	sessionAddress: string;
	/** Encrypted private key (base64, XSalsa20-Poly1305) */
	encryptedPrivateKey: string;
	/** Scoped permissions for this session key */
	permissions: SessionPermissions;
	/** ISO-8601 expiry timestamp */
	expiresAt: string;
	/** ISO-8601 creation timestamp */
	createdAt: string;
	/** ISO-8601 revocation timestamp (if revoked) */
	revokedAt?: string;
}

export interface TransactionData {
	/** Target contract address */
	to: string;
	/** Transaction value in ETH (as string) */
	value: string;
	/** Calldata (hex) — first 4 bytes = function selector */
	data?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
	return `sk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Encrypt a private key using the master key from crypto.ts.
 * Returns base64(nonce || ciphertext).
 */
async function encryptPrivateKey(privateKey: string): Promise<string> {
	await sodium.ready;

	const kdfVersion = getKeypairKdfVersion() ?? 1;
	const masterKey = await getMasterKey(kdfVersion);

	const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
	const plaintext = new TextEncoder().encode(privateKey);
	const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, masterKey);

	const combined = new Uint8Array(nonce.length + ciphertext.length);
	combined.set(nonce);
	combined.set(ciphertext, nonce.length);

	masterKey.fill(0);
	return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
}

/**
 * Decrypt a private key using the master key from crypto.ts.
 */
async function decryptPrivateKey(encrypted: string): Promise<string> {
	await sodium.ready;

	const kdfVersion = getKeypairKdfVersion() ?? 1;
	const masterKey = await getMasterKey(kdfVersion);

	const combined = sodium.from_base64(encrypted, sodium.base64_variants.ORIGINAL);
	if (combined.length < sodium.crypto_secretbox_NONCEBYTES + sodium.crypto_secretbox_MACBYTES) {
		throw new Error("Encrypted session key data is too short — may be corrupted");
	}

	const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
	const ciphertext = combined.slice(sodium.crypto_secretbox_NONCEBYTES);

	const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, masterKey);
	masterKey.fill(0);

	if (!plaintext) {
		throw new Error(
			"Failed to decrypt session key — master key mismatch or corrupted data.",
		);
	}

	return new TextDecoder().decode(plaintext);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new ephemeral session key with scoped permissions.
 *
 * Generates a random Ethereum wallet, encrypts its private key with the
 * master key, and stores it in the session_keys table.
 *
 * @param db - Database instance with session_keys table
 * @param walletAddress - Parent wallet that owns this session key
 * @param permissions - Scoped permissions for the session key
 * @param durationHours - Validity duration in hours (default: 24)
 * @returns The created SessionKey record
 */
export async function createSessionKey(
	db: ChainDb,
	walletAddress: string,
	permissions: SessionPermissions,
	durationHours: number = 24,
): Promise<SessionKey> {
	// Validate permissions
	if (parseFloat(permissions.maxTransactionValue) <= 0) {
		throw new Error("maxTransactionValue must be positive");
	}
	if (permissions.maxDailyTransactions <= 0) {
		throw new Error("maxDailyTransactions must be positive");
	}
	if (parseFloat(permissions.maxDailySpend) <= 0) {
		throw new Error("maxDailySpend must be positive");
	}
	if (durationHours <= 0 || durationHours > 720) {
		throw new Error("Duration must be between 1 and 720 hours (30 days)");
	}

	// Generate ephemeral wallet
	const wallet = ethers.Wallet.createRandom();
	const encryptedKey = await encryptPrivateKey(wallet.privateKey);

	const id = generateId();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + durationHours * 60 * 60 * 1000);

	const sessionKey: SessionKey = {
		id,
		walletAddress,
		sessionAddress: wallet.address,
		encryptedPrivateKey: encryptedKey,
		permissions,
		expiresAt: expiresAt.toISOString(),
		createdAt: now.toISOString(),
	};

	db.prepare(
		`INSERT INTO session_keys
		 (id, wallet_address, session_address, encrypted_private_key, permissions, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		walletAddress,
		wallet.address,
		encryptedKey,
		JSON.stringify(permissions),
		sessionKey.expiresAt,
		sessionKey.createdAt,
	);

	return sessionKey;
}

/**
 * Load and decrypt a session key, returning an ethers.js Wallet.
 *
 * Validates that the session key is not expired or revoked before decrypting.
 *
 * @param db - Database instance
 * @param sessionKeyId - Session key ID
 * @param rpcUrl - Optional RPC URL to connect the wallet to a provider
 * @returns Connected ethers.Wallet
 */
export async function loadSessionKey(
	db: ChainDb,
	sessionKeyId: string,
	rpcUrl?: string,
): Promise<ethers.Wallet> {
	const row = db
		.prepare("SELECT * FROM session_keys WHERE id = ?")
		.get(sessionKeyId) as Record<string, unknown> | undefined;

	if (!row) {
		throw new Error(`Session key not found: ${sessionKeyId}`);
	}

	// Check revocation
	if (row.revoked_at) {
		throw new Error(`Session key ${sessionKeyId} has been revoked`);
	}

	// Check expiry
	const expiresAt = new Date(row.expires_at as string);
	if (expiresAt <= new Date()) {
		throw new Error(`Session key ${sessionKeyId} has expired`);
	}

	const privateKey = await decryptPrivateKey(row.encrypted_private_key as string);
	let wallet = new ethers.Wallet(privateKey);

	if (rpcUrl) {
		const provider = new ethers.JsonRpcProvider(rpcUrl);
		wallet = wallet.connect(provider);
	}

	return wallet;
}

/**
 * Revoke a session key, marking it as no longer valid.
 *
 * @param db - Database instance
 * @param sessionKeyId - Session key ID to revoke
 */
export function revokeSessionKey(db: ChainDb, sessionKeyId: string): void {
	const row = db
		.prepare("SELECT id, revoked_at FROM session_keys WHERE id = ?")
		.get(sessionKeyId) as Record<string, unknown> | undefined;

	if (!row) {
		throw new Error(`Session key not found: ${sessionKeyId}`);
	}

	if (row.revoked_at) {
		throw new Error(`Session key ${sessionKeyId} is already revoked`);
	}

	db.prepare("UPDATE session_keys SET revoked_at = ? WHERE id = ?")
		.run(new Date().toISOString(), sessionKeyId);
}

/**
 * Get all active (non-expired, non-revoked) session keys for a wallet.
 *
 * @param db - Database instance
 * @param walletAddress - Parent wallet address
 * @returns Array of active SessionKey records
 */
export function getActiveSessionKeys(
	db: ChainDb,
	walletAddress: string,
): SessionKey[] {
	const now = new Date().toISOString();
	const rows = db
		.prepare(
			`SELECT * FROM session_keys
			 WHERE wallet_address = ?
			   AND revoked_at IS NULL
			   AND expires_at > ?
			 ORDER BY created_at DESC`,
		)
		.all(walletAddress, now) as Record<string, unknown>[];

	return rows.map(rowToSessionKey);
}

/**
 * Get a session key by ID (regardless of status).
 *
 * @param db - Database instance
 * @param sessionKeyId - Session key ID
 * @returns SessionKey or null
 */
export function getSessionKeyById(
	db: ChainDb,
	sessionKeyId: string,
): SessionKey | null {
	const row = db
		.prepare("SELECT * FROM session_keys WHERE id = ?")
		.get(sessionKeyId) as Record<string, unknown> | undefined;

	return row ? rowToSessionKey(row) : null;
}

/**
 * Validate whether a transaction is within the session key's permissions.
 *
 * Checks:
 * 1. Key is not expired or revoked
 * 2. Transaction value is within maxTransactionValue
 * 3. Target contract is in allowedContracts (if restricted)
 * 4. Function selector is in allowedFunctions (if restricted)
 *
 * Does NOT check daily limits — use getDailySpend() for that.
 *
 * @param key - Session key to validate against
 * @param txData - Transaction data to validate
 * @returns Object with valid flag and reason if invalid
 */
export function validateSessionKeyPermission(
	key: SessionKey,
	txData: TransactionData,
): { valid: boolean; reason?: string } {
	// Check expiry
	if (new Date(key.expiresAt) <= new Date()) {
		return { valid: false, reason: "Session key has expired" };
	}

	// Check revocation
	if (key.revokedAt) {
		return { valid: false, reason: "Session key has been revoked" };
	}

	// Check transaction value
	const txValue = parseFloat(txData.value);
	const maxValue = parseFloat(key.permissions.maxTransactionValue);
	if (txValue > maxValue) {
		return {
			valid: false,
			reason: `Transaction value ${txData.value} ETH exceeds limit ${key.permissions.maxTransactionValue} ETH`,
		};
	}

	// Check allowed contracts
	if (key.permissions.allowedContracts.length > 0) {
		const normalizedTo = txData.to.toLowerCase();
		const allowed = key.permissions.allowedContracts.map((c) => c.toLowerCase());
		if (!allowed.includes(normalizedTo)) {
			return {
				valid: false,
				reason: `Contract ${txData.to} is not in the allowed list`,
			};
		}
	}

	// Check allowed functions (first 4 bytes of calldata)
	if (key.permissions.allowedFunctions.length > 0 && txData.data) {
		const selector = txData.data.slice(0, 10); // 0x + 8 hex chars
		const normalizedSelector = selector.toLowerCase();
		const allowed = key.permissions.allowedFunctions.map((f) => f.toLowerCase());
		if (!allowed.includes(normalizedSelector)) {
			return {
				valid: false,
				reason: `Function selector ${selector} is not in the allowed list`,
			};
		}
	}

	return { valid: true };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function rowToSessionKey(row: Record<string, unknown>): SessionKey {
	return {
		id: row.id as string,
		walletAddress: row.wallet_address as string,
		sessionAddress: row.session_address as string,
		encryptedPrivateKey: row.encrypted_private_key as string,
		permissions: JSON.parse(row.permissions as string) as SessionPermissions,
		expiresAt: row.expires_at as string,
		createdAt: row.created_at as string,
		revokedAt: (row.revoked_at as string) ?? undefined,
	};
}
