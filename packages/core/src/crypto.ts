/**
 * Cryptographic signing — Ed25519 keypair generation, storage, and operations.
 *
 * Signing keys are stored encrypted at rest using the same scheme as the
 * daemon's secrets.ts: a machine-derived BLAKE2b master key protects the
 * private key via XSalsa20-Poly1305 (libsodium secretbox).
 *
 * The keypair file lives at `~/.agents/.keys/signing.enc` and contains:
 *   { publicKey: base64, encryptedPrivateKey: base64(nonce‖ciphertext), created: ISO }
 *
 * All exported functions are async because libsodium initialisation is async.
 */

import sodium from "libsodium-wrappers";
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, writeSync, closeSync, chmodSync } from "fs";
import { homedir, hostname } from "os";
import { join } from "path";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");
const KEYS_DIR = join(AGENTS_DIR, ".keys");
const SIGNING_KEY_FILE = join(KEYS_DIR, "signing.enc");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoredKeypair {
	publicKey: string; // base64
	encryptedPrivateKey: string; // base64(nonce + ciphertext)
	created: string; // ISO-8601
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

	// macOS: IOPlatformUUID
	try {
		const out = execSync(
			"ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID | awk '{print $3}'",
			{ timeout: 2000 },
		)
			.toString()
			.trim()
			.replace(/"/g, "");
		if (out) return out;
	} catch {
		// ignore
	}

	// Last resort: hostname + username
	return `${hostname()}-${process.env.USER || process.env.USERNAME || "user"}`;
}

// ---------------------------------------------------------------------------
// Master key derivation (matches daemon/secrets.ts exactly)
// ---------------------------------------------------------------------------

let _masterKey: Uint8Array | null = null;

/**
 * Derive the 32-byte master encryption key from machine-specific identifiers.
 *
 * Uses the same `signet:secrets:<machineId>` → BLAKE2b derivation as the
 * daemon secrets store so encrypted artefacts are machine-bound and
 * interoperable with the daemon's encryption layer.
 */
export async function getMasterKey(): Promise<Uint8Array> {
	if (_masterKey) return _masterKey;

	await sodium.ready;

	const machineId = getMachineId();
	const input = `signet:secrets:${machineId}`;
	const inputBytes = new TextEncoder().encode(input);

	const key = sodium.crypto_generichash(32, inputBytes, null);
	_masterKey = key;
	return key;
}

// ---------------------------------------------------------------------------
// Low-level encrypt / decrypt (secretbox: XSalsa20-Poly1305)
// ---------------------------------------------------------------------------

/**
 * Encrypt raw bytes with the machine-bound master key.
 * Returns base64(nonce ‖ ciphertext).
 */
async function encryptBytes(plaintext: Uint8Array): Promise<string> {
	await sodium.ready;
	const key = await getMasterKey();
	const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
	const box = sodium.crypto_secretbox_easy(plaintext, nonce, key);

	const combined = new Uint8Array(nonce.length + box.length);
	combined.set(nonce);
	combined.set(box, nonce.length);

	return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
}

/**
 * Decrypt a base64(nonce ‖ ciphertext) blob with the machine-bound master key.
 * Returns the raw plaintext bytes.
 */
async function decryptBytes(encoded: string): Promise<Uint8Array> {
	await sodium.ready;
	const key = await getMasterKey();

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
			`Signing keypair not found at ${SIGNING_KEY_FILE}. ` +
			"Call generateSigningKeypair() first.",
		);
	}

	try {
		const raw = readFileSync(SIGNING_KEY_FILE, "utf-8");
		const data = JSON.parse(raw) as StoredKeypair;

		if (!data.publicKey || !data.encryptedPrivateKey || !data.created) {
			throw new Error("Keypair file is missing required fields");
		}

		return data;
	} catch (err) {
		if (err instanceof SyntaxError) {
			throw new Error(`Signing keypair file is corrupt (invalid JSON): ${SIGNING_KEY_FILE}`);
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
 */
async function ensureKeypair(): Promise<DecryptedKeypair> {
	if (_cachedKeypair) return _cachedKeypair;
	if (!_loadPromise) {
		_loadPromise = loadSigningKeypair().then((kp) => {
			_cachedKeypair = kp;
			_loadPromise = null;
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

	const publicKeyB64 = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
	const encryptedPrivateKey = await encryptBytes(kp.privateKey);

	const stored: StoredKeypair = {
		publicKey: publicKeyB64,
		encryptedPrivateKey,
		created: new Date().toISOString(),
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

	const publicKey = sodium.from_base64(stored.publicKey, sodium.base64_variants.ORIGINAL);
	const privateKey = await decryptBytes(stored.encryptedPrivateKey);

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
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Zero and release the cached keypair from memory.
 *
 * Best-effort in JavaScript (GC may retain copies), but significantly
 * shrinks the attack window for memory-scraping attacks.
 */
export function clearCachedKeypair(): void {
	if (_cachedKeypair) {
		_cachedKeypair.privateKey.fill(0);
		_cachedKeypair.publicKey.fill(0);
		_cachedKeypair = null;
	}
	if (_masterKey) {
		_masterKey.fill(0);
		_masterKey = null;
	}
}

// Register best-effort cleanup on process exit
process.on("exit", clearCachedKeypair);
process.on("SIGINT", () => { clearCachedKeypair(); process.exit(130); });
process.on("SIGTERM", () => { clearCachedKeypair(); process.exit(143); });
