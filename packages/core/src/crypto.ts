/**
 * Cryptographic signing — Ed25519 keypair generation, storage, and operations.
 *
 * Signing keys are stored encrypted at rest using XSalsa20-Poly1305 (libsodium
 * secretbox) under a master key derived from the machine identity.
 *
 * KDF versions:
 *   v1 (legacy): BLAKE2b hash of machine ID — zero stretching, trivially reversible
 *   v2 (legacy): Argon2id (MODERATE cost) with machineId as password — still weak
 *   v3 (current): Argon2id (MODERATE cost) with user passphrase — recommended
 *
 * The keypair file lives at `~/.agents/.keys/signing.enc` and contains:
 *   { publicKey, encryptedPrivateKey: base64(nonce‖ciphertext), salt, created, kdfVersion }
 *
 * All exported functions are async because libsodium initialisation is async.
 */

import sodium from "libsodium-wrappers";
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, writeSync, closeSync, chmodSync, statSync, lstatSync, realpathSync } from "fs";
import { homedir, hostname } from "os";
import { join, resolve, normalize } from "path";
import { execFileSync } from "child_process";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Sensitive directory prefixes that SIGNET_PATH must never resolve to.
 * Prevents an attacker from redirecting key storage to system directories.
 */
const BLOCKED_PATH_PREFIXES = [
	"/etc", "/var/run", "/var/log", "/System", "/Library",
	"/usr", "/bin", "/sbin", "/dev", "/proc", "/sys",
	"/tmp", "/var/tmp",
];

/**
 * Validate and resolve SIGNET_PATH — prevents attacks via environment variable manipulation:
 * - Symlinks (redirect writes to attacker-controlled location)
 * - Non-canonical paths with .. traversal
 * - World-readable directories (key exposure)
 * - Sensitive system directories
 *
 * Exported so did-setup.ts (and other modules) can share the same validated path
 * instead of doing their own raw `process.env.SIGNET_PATH` access.
 */
export function resolveAgentsDir(): string {
	const envPath = process.env.SIGNET_PATH;
	if (!envPath) return join(homedir(), ".agents");

	// Normalize and resolve to an absolute path to prevent .. traversal
	const normalized = resolve(normalize(envPath));

	// Reject if the normalized path differs from input (catches some traversal tricks)
	// but allow simple relative→absolute resolution
	if (normalized !== resolve(envPath)) {
		throw new Error(
			`SIGNET_PATH contains path traversal: "${envPath}" resolves to "${normalized}"`,
		);
	}

	// Check against blocked sensitive directories
	for (const prefix of BLOCKED_PATH_PREFIXES) {
		if (normalized === prefix || normalized.startsWith(prefix + "/")) {
			throw new Error(
				`SIGNET_PATH must not point to a sensitive system directory: ${prefix}`,
			);
		}
	}

	try {
		// Check for symlink attacks — lstat doesn't follow symlinks
		const lstat = lstatSync(normalized);
		if (lstat.isSymbolicLink()) {
			throw new Error("SIGNET_PATH must not be a symlink");
		}

		// Verify the real path matches (catches symlinks in parent dirs)
		const real = realpathSync(normalized);
		if (real !== normalized) {
			throw new Error(
				`SIGNET_PATH contains symlinks in its path: "${normalized}" resolves to "${real}"`,
			);
		}

		const stat = statSync(normalized);
		if (!stat.isDirectory()) {
			throw new Error("SIGNET_PATH must be a directory");
		}

		// Check ownership — must be owned by current user
		if (process.platform !== "win32" && process.getuid) {
			const uid = process.getuid();
			if (stat.uid !== uid) {
				throw new Error(
					`SIGNET_PATH is owned by uid ${stat.uid}, but current user is uid ${uid}. ` +
					"The key directory must be owned by the running user.",
				);
			}
		}

		// Reject group/world-readable directories (keys would be exposed)
		if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
			// Auto-fix permissions instead of erroring — more user-friendly
			try {
				chmodSync(normalized, 0o700);
			} catch {
				throw new Error(
					"SIGNET_PATH directory is group/world-accessible and could not be fixed. " +
					"Run: chmod 700 " + normalized,
				);
			}
		}
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("SIGNET_PATH")) throw err;
		// Directory doesn't exist yet — it will be created with proper permissions later
		// Still validate it won't land in a sensitive location (already checked above)
	}

	return normalized;
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
	kdfVersion?: number;          // 1 = legacy BLAKE2b, 2 = Argon2id+machineId, 3 = Argon2id+passphrase
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
// Passphrase resolution
// ---------------------------------------------------------------------------

/**
 * Injected passphrase provider — set by CLI or test harness.
 * When set, this function is called to obtain the user's passphrase
 * instead of falling back to machineId-based derivation.
 *
 * The provider returns `null` if the user declines to enter a passphrase
 * (e.g., Ctrl+C during prompt), in which case we fall back to machineId.
 */
let _passphraseProvider: (() => Promise<string | null>) | null = null;

/**
 * Register a passphrase provider function. Called by CLI commands
 * (setup, rekey) to inject interactive prompting without coupling
 * crypto.ts to TTY/readline concerns.
 */
export function setPassphraseProvider(provider: (() => Promise<string | null>) | null): void {
	_passphraseProvider = provider;
}

/**
 * Resolve the passphrase for key derivation. Priority:
 * 1. Injected provider (interactive CLI prompt)
 * 2. SIGNET_PASSPHRASE env var (daemon / CI usage — documented as less secure)
 * 3. null (triggers machineId fallback with loud warning)
 */
async function resolvePassphrase(): Promise<string | null> {
	// 1. Interactive provider (set by CLI)
	if (_passphraseProvider) {
		const pp = await _passphraseProvider();
		if (pp && pp.length > 0) return pp;
	}

	// 2. Environment variable (for daemons — documented as less secure)
	const envPassphrase = process.env.SIGNET_PASSPHRASE;
	if (envPassphrase && envPassphrase.length > 0) {
		return envPassphrase;
	}

	// 3. No passphrase available
	return null;
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
 * encrypted before the Argon2id upgrade. New keys MUST use v3.
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
 * Derive a v2 master key via Argon2id with machineId as password.
 *
 * DEPRECATED: Still uses machineId which any local process can read.
 * Kept for backward compatibility with v2 keypair files. Use v3 for new keys.
 */
async function getMasterKeyV2(salt: Uint8Array): Promise<Uint8Array> {
	const cacheKey = `v2:${sodium.to_base64(salt, sodium.base64_variants.ORIGINAL)}`;
	const cached = _masterKeyCache.get(cacheKey);
	if (cached) return new Uint8Array(cached);

	await sodium.ready;

	const machineId = getMachineId();
	const password = `signet:secrets:${machineId}`;

	const key = sodium.crypto_pwhash(
		32,
		password,
		salt,
		sodium.crypto_pwhash_OPSLIMIT_MODERATE,
		sodium.crypto_pwhash_MEMLIMIT_MODERATE,
		sodium.crypto_pwhash_ALG_ARGON2ID13,
	);

	const copy = new Uint8Array(key);
	_masterKeyCache.set(cacheKey, copy);
	return new Uint8Array(copy);
}

/**
 * Derive a v3 master key via Argon2id with a user-provided passphrase.
 *
 * The passphrase is combined with the machineId to create the password input:
 *   password = `signet:v3:${passphrase}:${machineId}`
 *
 * This means both the passphrase AND physical machine access are needed
 * to derive the key — a stolen passphrase alone won't work on another machine.
 *
 * Cost: OPSLIMIT_MODERATE / MEMLIMIT_MODERATE (~0.7s on modern hardware).
 */
async function getMasterKeyV3(salt: Uint8Array, passphrase: string): Promise<Uint8Array> {
	const cacheKey = `v3:${sodium.to_base64(salt, sodium.base64_variants.ORIGINAL)}`;
	const cached = _masterKeyCache.get(cacheKey);
	if (cached) return new Uint8Array(cached);

	await sodium.ready;

	const machineId = getMachineId();
	// Combine passphrase + machineId: requires BOTH to derive the key
	const password = `signet:v3:${passphrase}:${machineId}`;

	const key = sodium.crypto_pwhash(
		32,
		password,
		salt,
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
 * @param kdfVersion  - 1 (or undefined) for legacy BLAKE2b, 2 for Argon2id+machineId,
 *                      3 for Argon2id+passphrase
 * @param salt        - Required for v2/v3; ignored for v1
 * @param passphrase  - Required for v3; resolved via provider/env if not provided
 */
export async function getMasterKey(
	kdfVersion?: number,
	salt?: Uint8Array,
	passphrase?: string,
): Promise<Uint8Array> {
	await sodium.ready;

	if (!kdfVersion || kdfVersion === 1) {
		return getMasterKeyV1();
	}

	// Validate salt for v2 and v3
	if (kdfVersion === 2 || kdfVersion === 3) {
		if (!salt || salt.length !== sodium.crypto_pwhash_SALTBYTES) {
			throw new Error(
				`Argon2id requires a ${sodium.crypto_pwhash_SALTBYTES}-byte salt, ` +
				`got ${salt ? salt.length : 0} bytes`,
			);
		}
	}

	if (kdfVersion === 2) {
		return getMasterKeyV2(salt!);
	}

	if (kdfVersion === 3) {
		// Resolve passphrase if not explicitly provided
		const pp = passphrase ?? await resolvePassphrase();
		if (!pp) {
			// No passphrase available — this is a hard error for v3 keys.
			// The key was encrypted with a passphrase; we can't decrypt without one.
			throw new Error(
				"This keypair requires a passphrase (KDF v3). " +
				"Provide it via interactive prompt, SIGNET_PASSPHRASE env var, " +
				"or setPassphraseProvider().",
			);
		}
		return getMasterKeyV3(salt!, pp);
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
 * Uses v3 (Argon2id + passphrase) if a passphrase is available via provider
 * or SIGNET_PASSPHRASE env var. Falls back to v2 (Argon2id + machineId only)
 * with a loud warning if no passphrase is available.
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

	// Try to use passphrase-based derivation (v3)
	const passphrase = await resolvePassphrase();
	let kdfVersion: number;
	let masterKey: Uint8Array;

	if (passphrase) {
		kdfVersion = 3;
		masterKey = await getMasterKey(3, salt, passphrase);
	} else {
		// Fall back to machineId-only derivation with loud warning
		kdfVersion = 2;
		masterKey = await getMasterKey(2, salt);
		console.warn(
			"\n⚠️  WARNING: No passphrase provided — using machine-ID-only key derivation.\n" +
			"   Any process on this machine can potentially derive your master key.\n" +
			"   For wallet security, re-run with a passphrase:\n" +
			"     signet rekey          (interactive)\n" +
			"     SIGNET_PASSPHRASE=... (daemon env var — less secure)\n",
		);
	}

	const publicKeyB64 = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
	const encryptedPrivateKey = await encryptBytes(kp.privateKey, masterKey);

	const stored: StoredKeypair = {
		publicKey: publicKeyB64,
		encryptedPrivateKey,
		salt: sodium.to_base64(salt, sodium.base64_variants.ORIGINAL),
		created: new Date().toISOString(),
		kdfVersion,
	};

	writeKeypairFileExclusive(stored);

	// Cache for immediate use — MUST copy the Uint8Arrays because we zero
	// the originals below (Uint8Array assignment is by reference, not copy).
	_cachedKeypair = {
		publicKey: new Uint8Array(kp.publicKey),
		privateKey: new Uint8Array(kp.privateKey),
	};
	resetKeypairCacheTimer();

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
 * The decrypted keypair is cached in memory (with TTL) to avoid repeated
 * disk I/O and Argon2id derivation overhead on every signing operation.
 *
 * Emits upgrade warnings for v1/v2 keypairs that should be migrated to v3.
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

	// Emit upgrade warnings for legacy KDF versions
	if (kdfVersion <= 2) {
		console.warn(
			`⚠️  Keypair uses KDF v${kdfVersion} (${kdfVersion === 1 ? "BLAKE2b — no stretching" : "Argon2id — machineId only"}). ` +
			"Run `signet rekey` to upgrade to passphrase-based key derivation (v3).",
		);
	}

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
 * Re-encrypt the keypair file with a new KDF version.
 *
 * Supports upgrading from any version to v3 (Argon2id + passphrase):
 *   v1 → v3: Decrypts with BLAKE2b(machineId), re-encrypts with Argon2id(passphrase)
 *   v2 → v3: Decrypts with Argon2id(machineId), re-encrypts with Argon2id(passphrase)
 *   v3 → v3: Re-encrypts with a new passphrase (passphrase rotation)
 *
 * For v3→v3 migration, the old passphrase must be available to decrypt first.
 *
 * The Ed25519 keypair itself doesn't change — only the encryption wrapper.
 * This means the DID and all existing signatures remain valid.
 *
 * @param newPassphrase - The new passphrase to encrypt with. If not provided,
 *                        resolves via provider/env var.
 * @param oldPassphrase - For v3→v3 migration, the current passphrase. If not
 *                        provided, resolves via provider/env var.
 * @returns Object with `upgraded: true` and `fromVersion`/`toVersion` on success,
 *          or `upgraded: false` if already on v3 with the same passphrase.
 */
export async function reEncryptKeypair(
	newPassphrase?: string,
	oldPassphrase?: string,
): Promise<{ upgraded: boolean; fromVersion: number; toVersion: number }> {
	await sodium.ready;

	const stored = readKeypairFile();
	const fromVersion = stored.kdfVersion ?? 1;

	// Decrypt with the current KDF version
	const salt = stored.salt
		? sodium.from_base64(stored.salt, sodium.base64_variants.ORIGINAL)
		: undefined;

	let oldKey: Uint8Array;
	if (fromVersion === 3) {
		// v3→v3: need the old passphrase to decrypt
		const oldPp = oldPassphrase ?? await resolvePassphrase();
		if (!oldPp) {
			throw new Error(
				"Current keypair uses passphrase-based encryption (v3). " +
				"Provide the current passphrase to decrypt before re-keying.",
			);
		}
		oldKey = await getMasterKey(3, salt, oldPp);
	} else {
		oldKey = await getMasterKey(fromVersion, salt);
	}

	const privateKey = await decryptBytes(stored.encryptedPrivateKey, oldKey);
	oldKey.fill(0);

	// Verify integrity before re-encrypting
	const publicKey = sodium.from_base64(stored.publicKey, sodium.base64_variants.ORIGINAL);
	const derivedPublicKey = sodium.crypto_sign_ed25519_sk_to_pk(privateKey);
	if (!sodium.memcmp(derivedPublicKey, publicKey)) {
		privateKey.fill(0);
		throw new Error(
			"Public/private key mismatch during migration — keypair file may be corrupted",
		);
	}

	// Resolve the new passphrase
	const newPp = newPassphrase ?? await resolvePassphrase();
	if (!newPp) {
		privateKey.fill(0);
		throw new Error(
			"A passphrase is required to upgrade to v3 key derivation. " +
			"Provide it via interactive prompt or SIGNET_PASSPHRASE env var.",
		);
	}

	// Re-encrypt with v3 (Argon2id + passphrase)
	const newSalt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
	const v3Key = await getMasterKey(3, newSalt, newPp);
	const encryptedPrivateKey = await encryptBytes(privateKey, v3Key);
	v3Key.fill(0);
	privateKey.fill(0);

	const upgraded: StoredKeypair = {
		publicKey: stored.publicKey,
		encryptedPrivateKey,
		salt: sodium.to_base64(newSalt, sodium.base64_variants.ORIGINAL),
		created: stored.created,
		kdfVersion: 3,
	};

	// Overwrite the file (not exclusive — file must already exist)
	writeFileSync(SIGNING_KEY_FILE, JSON.stringify(upgraded, null, 2), { mode: 0o600 });
	chmodSync(SIGNING_KEY_FILE, 0o600);

	// Invalidate any cached keypair and master keys so next load uses v3 derivation
	if (_cachedKeypair) {
		_cachedKeypair.privateKey.fill(0);
		_cachedKeypair.publicKey.fill(0);
		_cachedKeypair = null;
	}
	_masterKeyCache.forEach((key) => key.fill(0));
	_masterKeyCache.clear();

	return { upgraded: true, fromVersion, toVersion: 3 };
}

/**
 * Get the current KDF version of the stored keypair file.
 * Returns null if no keypair exists.
 */
export function getKeypairKdfVersion(): number | null {
	if (!existsSync(SIGNING_KEY_FILE)) return null;
	try {
		const stored = readKeypairFile();
		return stored.kdfVersion ?? 1;
	} catch {
		return null;
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
	_masterKeyCache.forEach((key) => key.fill(0));
	_masterKeyCache.clear();
}

// Register best-effort cleanup on process exit
process.on("exit", clearCachedKeypair);
// Re-raise signals properly so other cleanup handlers can run.
// Using process.kill(pid, signal) instead of process.exit() preserves
// the correct exit code AND allows the OS to deliver the signal to
// any parent process watchers.
process.on("SIGINT", () => {
	clearCachedKeypair();
	process.removeAllListeners("SIGINT");
	process.kill(process.pid, "SIGINT");
});
process.on("SIGTERM", () => {
	clearCachedKeypair();
	process.removeAllListeners("SIGTERM");
	process.kill(process.pid, "SIGTERM");
});
