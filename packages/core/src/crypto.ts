/**
 * Cryptographic signing — Ed25519 keypair generation, storage, and operations.
 *
 * Signing keys are stored encrypted at rest using XSalsa20-Poly1305 (libsodium
 * secretbox) under a master key derived from the machine identity.
 *
 * KDF versions:
 *   v1 (legacy): BLAKE2b hash of machine ID — zero stretching, trivially reversible
 *   v2 (current): Argon2id (MODERATE cost) with a random 16-byte salt per keypair
 *
 * The keypair file lives at `~/.agents/.keys/signing.enc` and contains:
 *   { publicKey, encryptedPrivateKey: base64(nonce‖ciphertext), salt, created, kdfVersion }
 *
 * All exported functions are async because libsodium initialisation is async.
 */

import sodium from "libsodium-wrappers";
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, writeSync, closeSync, chmodSync, statSync, lstatSync } from "fs";
import { homedir, hostname } from "os";
import { join } from "path";
import { execFileSync } from "child_process";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Validate SIGNET_PATH if set — prevents attacks via environment variable manipulation:
 * - Pointing to world-readable directories (key exposure)
 * - Pointing to symlinks (redirect writes to attacker-controlled location)
 * - Pointing to NFS mounts (keys transmitted over network)
 */
function resolveAgentsDir(): string {
	const envPath = process.env.SIGNET_PATH;
	if (!envPath) return join(homedir(), ".agents");

	try {
		// Check for symlink attacks
		const lstat = lstatSync(envPath);
		if (lstat.isSymbolicLink()) {
			throw new Error("SIGNET_PATH must not be a symlink");
		}

		const stat = statSync(envPath);
		if (!stat.isDirectory()) {
			throw new Error("SIGNET_PATH must be a directory");
		}

		// Reject group/world-readable directories (keys would be exposed)
		if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
			// Auto-fix permissions instead of erroring — more user-friendly
			try {
				chmodSync(envPath, 0o700);
			} catch {
				throw new Error(
					"SIGNET_PATH directory is group/world-accessible and could not be fixed. " +
					"Run: chmod 700 " + envPath,
				);
			}
		}
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("SIGNET_PATH")) throw err;
		// Directory doesn't exist yet — it will be created with proper permissions later
	}

	return envPath;
}

const AGENTS_DIR = resolveAgentsDir();
const KEYS_DIR = join(AGENTS_DIR, ".keys");
const SIGNING_KEY_FILE = join(KEYS_DIR, "signing.enc");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoredKeypair {
	publicKey: string;            // base64
	encryptedPrivateKey: string;  // base64(nonce + ciphertext)
	salt: string;                 // base64, 16 bytes — Argon2id salt (empty string for v1)
	created: string;              // ISO-8601
	kdfVersion?: number;          // 1 = legacy BLAKE2b, 2 = Argon2id (default 2 for new keys)
}

interface DecryptedKeypair {
	publicKey: Uint8Array;
	privateKey: Uint8Array;
}

// ---------------------------------------------------------------------------
// Machine identity (copied from daemon/secrets.ts — no cross-package dep)
// ---------------------------------------------------------------------------

/**
 * Read a machine-specific identifier to bind the key to this host.
 * Falls back to hostname + username if no platform id is available.
 */
function getMachineId(): string {
	// Linux: /etc/machine-id or dbus machine-id
	const candidates = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
	for (const p of candidates) {
		try {
			const id = readFileSync(p, "utf-8").trim();
			if (id) return id;
		} catch {
			// try next
		}
	}

	// macOS: IOPlatformUUID — use execFileSync with absolute path to avoid
	// $PATH manipulation attacks (defense in depth for key derivation input)
	try {
		const ioregOut = execFileSync(
			"/usr/sbin/ioreg",
			["-rd1", "-c", "IOPlatformExpertDevice"],
			{ timeout: 2000 },
		).toString();
		const uuidMatch = ioregOut
			.split("\n")
			.find((l) => l.includes("IOPlatformUUID"))
			?.match(/"([^"]+)"$/);
		if (uuidMatch?.[1]) return uuidMatch[1];
	} catch {
		// ignore
	}

	// Last resort: hostname + username
	return `${hostname()}-${process.env.USER || process.env.USERNAME || "user"}`;
}

// ---------------------------------------------------------------------------
// Master key derivation
// ---------------------------------------------------------------------------

/**
 * Cache keyed by KDF version + salt to avoid re-deriving on every operation.
 * v1 keys have no salt so we use the string "v1" as the cache key.
 */
const _masterKeyCache = new Map<string, Uint8Array>();

/**
 * Derive the legacy v1 master key (BLAKE2b, zero stretching).
 *
 * Kept for backward compatibility with existing keypair files that were
 * encrypted before the Argon2id upgrade. New keys MUST use v2.
 */
async function getMasterKeyV1(): Promise<Uint8Array> {
	const cacheKey = "v1";
	const cached = _masterKeyCache.get(cacheKey);
	if (cached) return new Uint8Array(cached);

	await sodium.ready;

	const machineId = getMachineId();
	const input = `signet:secrets:${machineId}`;
	const inputBytes = new TextEncoder().encode(input);

	const key = sodium.crypto_generichash(32, inputBytes, null);
	const copy = new Uint8Array(key);
	_masterKeyCache.set(cacheKey, copy);
	return new Uint8Array(copy);
}

/**
 * Derive a v2 master key via Argon2id with the given salt.
 *
 * Cost: OPSLIMIT_MODERATE / MEMLIMIT_MODERATE — a reasonable balance between
 * resistance to brute-force and startup latency on modern hardware.
 */
async function getMasterKeyV2(salt: Uint8Array): Promise<Uint8Array> {
	const cacheKey = `v2:${sodium.to_base64(salt, sodium.base64_variants.ORIGINAL)}`;
	const cached = _masterKeyCache.get(cacheKey);
	if (cached) return new Uint8Array(cached);

	await sodium.ready;

	const machineId = getMachineId();
	const password = `signet:secrets:${machineId}`;

	const key = sodium.crypto_pwhash(
		32,                                       // output key length
		password,                                  // password (machine ID)
		salt,                                      // random per-keypair salt
		sodium.crypto_pwhash_OPSLIMIT_MODERATE,
		sodium.crypto_pwhash_MEMLIMIT_MODERATE,
		sodium.crypto_pwhash_ALG_ARGON2ID13,
	);

	const copy = new Uint8Array(key);
	_masterKeyCache.set(cacheKey, copy);
	return new Uint8Array(copy);
}

/**
 * Derive the 32-byte master encryption key, dispatching on KDF version.
 *
 * @param kdfVersion - 1 (or undefined) for legacy BLAKE2b, 2 for Argon2id
 * @param salt       - Required for v2; ignored for v1
 */
export async function getMasterKey(kdfVersion?: number, salt?: Uint8Array): Promise<Uint8Array> {
	if (!kdfVersion || kdfVersion === 1) {
		return getMasterKeyV1();
	}
	if (kdfVersion === 2) {
		if (!salt || salt.length !== sodium.crypto_pwhash_SALTBYTES) {
			throw new Error(
				`Argon2id requires a ${sodium.crypto_pwhash_SALTBYTES}-byte salt, ` +
				`got ${salt ? salt.length : 0} bytes`,
			);
		}
		return getMasterKeyV2(salt);
	}
	throw new Error(`Unknown KDF version: ${kdfVersion}`);
}

// ---------------------------------------------------------------------------
// Low-level encrypt / decrypt (secretbox: XSalsa20-Poly1305)
// ---------------------------------------------------------------------------

/**
 * Encrypt raw bytes with the given key.
 * Returns base64(nonce ‖ ciphertext).
 */
async function encryptBytes(plaintext: Uint8Array, key: Uint8Array): Promise<string> {
	await sodium.ready;
	const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
	const box = sodium.crypto_secretbox_easy(plaintext, nonce, key);

	const combined = new Uint8Array(nonce.length + box.length);
	combined.set(nonce);
	combined.set(box, nonce.length);

	return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
}

/**
 * Decrypt a base64(nonce ‖ ciphertext) blob with the given key.
 * Returns the raw plaintext bytes.
 */
async function decryptBytes(encoded: string, key: Uint8Array): Promise<Uint8Array> {
	await sodium.ready;

	const combined = sodium.from_base64(encoded, sodium.base64_variants.ORIGINAL);
	if (combined.length < sodium.crypto_secretbox_NONCEBYTES + sodium.crypto_secretbox_MACBYTES) {
		throw new Error("Encrypted data is too short — file may be corrupted");
	}

	const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
	const box = combined.slice(sodium.crypto_secretbox_NONCEBYTES);

	const plaintext = sodium.crypto_secretbox_open_easy(box, nonce, key);
	if (!plaintext) {
		throw new Error(
			"Decryption failed — master key mismatch or corrupted keypair file. " +
			"This can happen if the keypair was generated on a different machine.",
		);
	}

	return plaintext;
}

// ---------------------------------------------------------------------------
// Keypair file I/O
// ---------------------------------------------------------------------------

function readKeypairFile(): StoredKeypair {
	if (!existsSync(SIGNING_KEY_FILE)) {
		throw new Error(
			"Signing keypair not found. Run `signet did init` to generate one.",
		);
	}

	try {
		const raw = readFileSync(SIGNING_KEY_FILE, "utf-8");
		const data = JSON.parse(raw) as Partial<StoredKeypair>;

		if (!data.publicKey || !data.encryptedPrivateKey || !data.created) {
			throw new Error("Keypair file is missing required fields");
		}

		// Normalise legacy files that pre-date the Argon2id upgrade
		return {
			publicKey: data.publicKey,
			encryptedPrivateKey: data.encryptedPrivateKey,
			salt: data.salt ?? "",
			created: data.created,
			kdfVersion: data.kdfVersion,   // undefined → treated as v1
		};
	} catch (err) {
		if (err instanceof SyntaxError) {
			throw new Error("Signing keypair file is corrupt (invalid JSON)");
		}
		throw err;
	}
}

/**
 * Write keypair to disk with exclusive creation (O_CREAT | O_EXCL).
 *
 * Uses `openSync(path, 'wx')` to atomically fail if the file already exists,
 * preventing TOCTOU races where concurrent processes could overwrite each other's keys.
 */
function writeKeypairFileExclusive(data: StoredKeypair): void {
	mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
	const fd = openSync(SIGNING_KEY_FILE, "wx", 0o600); // atomic create-or-fail
	try {
		writeSync(fd, JSON.stringify(data, null, 2));
	} finally {
		closeSync(fd);
	}
	// Belt-and-suspenders: ensure permissions even if umask interfered
	chmodSync(SIGNING_KEY_FILE, 0o600);
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

let _cachedKeypair: DecryptedKeypair | null = null;

/**
 * TTL for cached keypair — private key is zeroed and evicted after this
 * period of inactivity. Limits the exposure window for memory-scraping
 * attacks (heap snapshots, core dumps, debugger attach).
 *
 * Each signing operation resets the timer.
 */
const KEYPAIR_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let _keypairCacheTimer: ReturnType<typeof setTimeout> | null = null;

function resetKeypairCacheTimer(): void {
	if (_keypairCacheTimer) clearTimeout(_keypairCacheTimer);
	_keypairCacheTimer = setTimeout(() => {
		if (_cachedKeypair) {
			_cachedKeypair.privateKey.fill(0);
			_cachedKeypair.publicKey.fill(0);
			_cachedKeypair = null;
		}
		_keypairCacheTimer = null;
	}, KEYPAIR_CACHE_TTL_MS);
	// Don't let the timer keep the process alive
	if (_keypairCacheTimer && typeof _keypairCacheTimer.unref === "function") {
		_keypairCacheTimer.unref();
	}
}

/**
 * Promise-based concurrency guard for keypair loading.
 * Prevents duplicate loads when multiple async callers hit ensureKeypair() simultaneously.
 */
let _loadPromise: Promise<DecryptedKeypair> | null = null;

/**
 * Ensure libsodium is initialised and the cached keypair is loaded.
 * All public functions that need the keypair call this first.
 *
 * Uses a promise lock to prevent duplicate concurrent loads (which would
 * leave orphaned private key copies in memory).
 *
 * Resets the cache TTL on each access — keypair is evicted after 5 minutes
 * of inactivity to limit memory exposure window.
 */
async function ensureKeypair(): Promise<DecryptedKeypair> {
	if (_cachedKeypair) {
		resetKeypairCacheTimer();
		return _cachedKeypair;
	}
	if (!_loadPromise) {
		_loadPromise = loadSigningKeypair().then((kp) => {
			_cachedKeypair = kp;
			_loadPromise = null;
			resetKeypairCacheTimer();
			return kp;
		}).catch((err) => {
			_loadPromise = null;
			throw err;
		});
	}
	return _loadPromise;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a new Ed25519 signing keypair and store it encrypted on disk.
 *
 * Throws if a keypair already exists — call {@link hasSigningKeypair} first
 * or delete the existing file manually if you intend to rotate keys.
 *
 * @returns The base64-encoded public key of the newly created keypair.
 */
export async function generateSigningKeypair(): Promise<string> {
	await sodium.ready;

	// Fast-path check — avoids generating a keypair we'd throw away.
	// The real atomicity guarantee comes from writeKeypairFileExclusive (O_EXCL).
	if (existsSync(SIGNING_KEY_FILE)) {
		throw new Error(
			"Signing keypair already exists. " +
			"Delete it manually or use a key rotation workflow to replace it.",
		);
	}

	const kp = sodium.crypto_sign_keypair();

	// Generate a random salt for Argon2id key derivation
	const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
	const masterKey = await getMasterKey(2, salt);

	const publicKeyB64 = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
	const encryptedPrivateKey = await encryptBytes(kp.privateKey, masterKey);

	const stored: StoredKeypair = {
		publicKey: publicKeyB64,
		encryptedPrivateKey,
		salt: sodium.to_base64(salt, sodium.base64_variants.ORIGINAL),
		created: new Date().toISOString(),
		kdfVersion: 2,
	};

	writeKeypairFileExclusive(stored);

	// Cache for immediate use — MUST copy the Uint8Arrays because we zero
	// the originals below (Uint8Array assignment is by reference, not copy).
	_cachedKeypair = {
		publicKey: new Uint8Array(kp.publicKey),
		privateKey: new Uint8Array(kp.privateKey),
	};

	// Zero the libsodium keypair object's original buffers (best-effort in JS).
	// Safe because _cachedKeypair now holds independent copies.
	kp.privateKey.fill(0);
	kp.publicKey.fill(0);

	// Zero the master key — it's cached inside _masterKeyCache already
	masterKey.fill(0);

	return publicKeyB64;
}

/**
 * Load and decrypt the existing signing keypair from disk.
 *
 * The decrypted keypair is cached in memory for the lifetime of the process
 * to avoid repeated disk I/O and decryption overhead.
 *
 * @returns The decrypted public and private key as raw `Uint8Array`s.
 */
export async function loadSigningKeypair(): Promise<DecryptedKeypair> {
	if (_cachedKeypair) return _cachedKeypair;

	await sodium.ready;

	const stored = readKeypairFile();

	// Derive the correct master key based on KDF version
	const kdfVersion = stored.kdfVersion ?? 1;
	const salt = stored.salt
		? sodium.from_base64(stored.salt, sodium.base64_variants.ORIGINAL)
		: undefined;
	const masterKey = await getMasterKey(kdfVersion, salt);

	const publicKey = sodium.from_base64(stored.publicKey, sodium.base64_variants.ORIGINAL);
	const privateKey = await decryptBytes(stored.encryptedPrivateKey, masterKey);

	// Zero the master key copy — the cache holds its own
	masterKey.fill(0);

	// Sanity check key lengths
	if (publicKey.length !== sodium.crypto_sign_PUBLICKEYBYTES) {
		throw new Error(
			`Invalid public key length: expected ${sodium.crypto_sign_PUBLICKEYBYTES}, ` +
			`got ${publicKey.length}`,
		);
	}
	if (privateKey.length !== sodium.crypto_sign_SECRETKEYBYTES) {
		throw new Error(
			`Invalid private key length: expected ${sodium.crypto_sign_SECRETKEYBYTES}, ` +
			`got ${privateKey.length}`,
		);
	}

	// Verify public/private key consistency — detect tampered keypair files.
	// Derive the public key from the private key and compare.
	const derivedPublicKey = sodium.crypto_sign_ed25519_sk_to_pk(privateKey);
	if (!sodium.memcmp(derivedPublicKey, publicKey)) {
		// Zero the private key before throwing — don't leave it in memory
		privateKey.fill(0);
		throw new Error(
			"Public/private key mismatch — keypair file may be corrupted or tampered",
		);
	}

	_cachedKeypair = { publicKey, privateKey };
	return _cachedKeypair;
}

/**
 * Check whether a signing keypair file exists on disk.
 *
 * Does **not** attempt decryption — only checks file presence.
 * Synchronous because it only uses `existsSync`.
 */
export function hasSigningKeypair(): boolean {
	return existsSync(SIGNING_KEY_FILE);
}

/**
 * Get the raw public key bytes of the current signing keypair.
 *
 * @returns 32-byte Ed25519 public key as `Uint8Array`.
 * @throws If no keypair exists or decryption fails.
 */
export async function getPublicKeyBytes(): Promise<Uint8Array> {
	const kp = await ensureKeypair();
	return new Uint8Array(kp.publicKey); // Defensive copy — callers can't corrupt the cache
}

/**
 * Get the base64-encoded public key of the current signing keypair.
 *
 * @returns Standard base64 string (no URL-safe variant).
 * @throws If no keypair exists or decryption fails.
 */
export async function getPublicKeyBase64(): Promise<string> {
	await sodium.ready;
	const kp = await ensureKeypair();
	return sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
}

/**
 * Produce an Ed25519 detached signature over a UTF-8 string.
 *
 * @param content - The string content to sign.
 * @returns Base64-encoded 64-byte detached signature.
 * @throws If no keypair exists or decryption fails.
 */
export async function signContent(content: string): Promise<string> {
	if (!content || content.length === 0) {
		throw new Error("Cannot sign empty content");
	}
	await sodium.ready;
	const kp = await ensureKeypair();
	const message = new TextEncoder().encode(content);
	const signature = sodium.crypto_sign_detached(message, kp.privateKey);
	return sodium.to_base64(signature, sodium.base64_variants.ORIGINAL);
}

/**
 * Verify an Ed25519 detached signature over a UTF-8 string.
 *
 * @param content   - The original string content that was signed.
 * @param signature - Base64-encoded detached signature to verify.
 * @param publicKey - 32-byte Ed25519 public key of the signer.
 * @returns `true` if the signature is valid, `false` otherwise.
 */
export async function verifySignature(
	content: string,
	signature: string,
	publicKey: Uint8Array,
): Promise<boolean> {
	await sodium.ready;

	try {
		const message = new TextEncoder().encode(content);
		const sigBytes = sodium.from_base64(signature, sodium.base64_variants.ORIGINAL);

		if (sigBytes.length !== sodium.crypto_sign_BYTES) {
			return false;
		}
		if (publicKey.length !== sodium.crypto_sign_PUBLICKEYBYTES) {
			return false;
		}

		return sodium.crypto_sign_verify_detached(sigBytes, message, publicKey);
	} catch {
		// Malformed base64 or other decoding errors → invalid signature
		return false;
	}
}

/**
 * Produce a raw Ed25519 detached signature over arbitrary bytes.
 *
 * @param data - The bytes to sign.
 * @returns 64-byte detached signature as `Uint8Array`.
 * @throws If no keypair exists or decryption fails.
 */
export async function signBytes(data: Uint8Array): Promise<Uint8Array> {
	await sodium.ready;
	const kp = await ensureKeypair();
	return sodium.crypto_sign_detached(data, kp.privateKey);
}

/**
 * Verify a raw Ed25519 detached signature over arbitrary bytes.
 *
 * @param data      - The original bytes that were signed.
 * @param signature - 64-byte detached signature to verify.
 * @param publicKey - 32-byte Ed25519 public key of the signer.
 * @returns `true` if the signature is valid, `false` otherwise.
 */
export async function verifyBytes(
	data: Uint8Array,
	signature: Uint8Array,
	publicKey: Uint8Array,
): Promise<boolean> {
	await sodium.ready;

	try {
		if (signature.length !== sodium.crypto_sign_BYTES) {
			return false;
		}
		if (publicKey.length !== sodium.crypto_sign_PUBLICKEYBYTES) {
			return false;
		}

		return sodium.crypto_sign_verify_detached(signature, data, publicKey);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Signing payload construction
// ---------------------------------------------------------------------------

/**
 * Build the canonical signable payload for a memory entry.
 *
 * Format: `contentHash|createdAt|signerDid`
 * This binds the signature to the content, timestamp, and signer identity.
 *
 * All fields are validated to prevent delimiter injection attacks where a
 * crafted field containing `|` could forge a different payload.
 *
 * Exported from core so both daemon and CLI can use the same function,
 * preventing format drift between signing and verification paths.
 */
/**
 * Build the v1 signable payload: `contentHash|createdAt|signerDid`
 * Used for backward compatibility with existing signatures.
 */
export function buildSignablePayload(
	contentHash: string,
	createdAt: string,
	signerDid: string,
): string {
	if (!/^[0-9a-f]+$/.test(contentHash)) {
		throw new Error("contentHash must be lowercase hex");
	}
	if (createdAt.includes("|") || signerDid.includes("|")) {
		throw new Error("Signing payload fields must not contain pipe characters");
	}
	return `${contentHash}|${createdAt}|${signerDid}`;
}

/**
 * Build the v2 signable payload: `v2|memoryId|contentHash|createdAt|signerDid`
 * Includes memory ID to prevent cross-memory signature reuse.
 * The `v2` prefix acts as a version tag for payload format detection.
 */
export function buildSignablePayloadV2(
	memoryId: string,
	contentHash: string,
	createdAt: string,
	signerDid: string,
): string {
	if (!/^[0-9a-f]+$/.test(contentHash)) {
		throw new Error("contentHash must be lowercase hex");
	}
	if ([memoryId, createdAt, signerDid].some((f) => f.includes("|"))) {
		throw new Error("Signing payload fields must not contain pipe characters");
	}
	return `v2|${memoryId}|${contentHash}|${createdAt}|${signerDid}`;
}

// ---------------------------------------------------------------------------
// KDF Migration
// ---------------------------------------------------------------------------

/**
 * Upgrade a v1 (BLAKE2b) keypair file to v2 (Argon2id) in-place.
 *
 * 1. Reads and decrypts the private key with the legacy v1 master key.
 * 2. Generates a fresh random Argon2id salt.
 * 3. Derives a v2 master key from the machine ID + new salt.
 * 4. Re-encrypts the private key under the v2 key.
 * 5. Atomically overwrites the keypair file with the upgraded payload.
 *
 * Safe to call on an already-v2 keypair — it will return `false` without
 * making any changes.
 *
 * @returns `true` if the keypair was upgraded, `false` if already v2.
 * @throws If the keypair file doesn't exist or decryption fails.
 */
export async function reEncryptKeypair(): Promise<boolean> {
	await sodium.ready;

	const stored = readKeypairFile();

	// Already on v2 — nothing to do
	if (stored.kdfVersion === 2) return false;

	// Decrypt with legacy v1 key
	const v1Key = await getMasterKey(1);
	const privateKey = await decryptBytes(stored.encryptedPrivateKey, v1Key);
	v1Key.fill(0);

	// Verify integrity before re-encrypting
	const publicKey = sodium.from_base64(stored.publicKey, sodium.base64_variants.ORIGINAL);
	const derivedPublicKey = sodium.crypto_sign_ed25519_sk_to_pk(privateKey);
	if (!sodium.memcmp(derivedPublicKey, publicKey)) {
		privateKey.fill(0);
		throw new Error(
			"Public/private key mismatch during migration — keypair file may be corrupted",
		);
	}

	// Re-encrypt with v2 (Argon2id)
	const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
	const v2Key = await getMasterKey(2, salt);
	const encryptedPrivateKey = await encryptBytes(privateKey, v2Key);
	v2Key.fill(0);
	privateKey.fill(0);

	const upgraded: StoredKeypair = {
		publicKey: stored.publicKey,
		encryptedPrivateKey,
		salt: sodium.to_base64(salt, sodium.base64_variants.ORIGINAL),
		created: stored.created,
		kdfVersion: 2,
	};

	// Overwrite the file (not exclusive — file must already exist)
	writeFileSync(SIGNING_KEY_FILE, JSON.stringify(upgraded, null, 2), { mode: 0o600 });
	chmodSync(SIGNING_KEY_FILE, 0o600);

	// Invalidate any cached keypair so next load uses v2 derivation
	if (_cachedKeypair) {
		_cachedKeypair.privateKey.fill(0);
		_cachedKeypair.publicKey.fill(0);
		_cachedKeypair = null;
	}

	return true;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Zero and release the cached keypair from memory.
 *
 * Best-effort in JavaScript (GC may retain copies), but significantly
 * shrinks the attack window for memory-scraping attacks.
 */
export function clearCachedKeypair(): void {
	if (_keypairCacheTimer) {
		clearTimeout(_keypairCacheTimer);
		_keypairCacheTimer = null;
	}
	if (_cachedKeypair) {
		_cachedKeypair.privateKey.fill(0);
		_cachedKeypair.publicKey.fill(0);
		_cachedKeypair = null;
	}
	// Zero and clear all cached master keys
	for (const key of _masterKeyCache.values()) {
		key.fill(0);
	}
	_masterKeyCache.clear();
}

// Register best-effort cleanup on process exit
process.on("exit", clearCachedKeypair);
process.on("SIGINT", () => { clearCachedKeypair(); process.exit(130); });
process.on("SIGTERM", () => { clearCachedKeypair(); process.exit(143); });
