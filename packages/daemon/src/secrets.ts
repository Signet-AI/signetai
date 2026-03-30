/**
 * Secrets management - encrypted storage for sensitive values.
 *
 * Secrets are encrypted at rest using libsodium secretbox (XSalsa20-Poly1305).
 * The master key is derived from machine-specific identifiers so the encrypted
 * file is bound to the machine without requiring a user passphrase.
 *
 * Agents never receive secret values directly. They can only request actions
 * that use secrets (e.g. exec_with_secrets), which injects values into a
 * subprocess environment that the agent cannot inspect.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { ONEPASSWORD_SERVICE_ACCOUNT_SECRET, isOnePasswordReference, readOnePasswordReference } from "./onepassword.js";

// ---------------------------------------------------------------------------
// Storage layout
// ---------------------------------------------------------------------------

const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");
const SECRETS_DIR = join(AGENTS_DIR, ".secrets");
const SECRETS_FILE = join(SECRETS_DIR, "secrets.enc");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SecretEntry {
	ciphertext: string; // base64-encoded nonce+ciphertext
	created: string;
	updated: string;
}

interface SecretsStore {
	version: 1;
	secrets: Record<string, SecretEntry>;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Read a machine-specific identifier to bind the key to this host.
 * Falls back to hostname + username if no machine-id is available.
 */
function getMachineId(): string {
	const isWindows = process.platform === "win32";

	if (!isWindows) {
		// Linux: /etc/machine-id
		const candidates = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
		for (const p of candidates) {
			try {
				const id = readFileSync(p, "utf-8").trim();
				if (id) return id;
			} catch {
				// try next
			}
		}

		// macOS fallback
		try {
			const out = execSync("ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID | awk '{print $3}'", {
				timeout: 2000,
			})
				.toString()
				.trim()
				.replace(/"/g, "");
			if (out) return out;
		} catch {
			// ignore
		}
	} else {
		// Windows: use MachineGuid from registry
		try {
			const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', {
				encoding: "utf-8",
				timeout: 2000,
				windowsHide: true,
			});
			const match = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
			if (match?.[1]) return match[1];
		} catch {
			// ignore
		}
	}

	// Last resort: hostname + username
	return `${hostname()}-${process.env.USER || process.env.USERNAME || "user"}`;
}

let _masterKey: Uint8Array | null = null;

async function getMasterKey(): Promise<Uint8Array> {
	if (_masterKey) return _masterKey;

	await sodium.ready;

	const machineId = getMachineId();
	const input = `signet:secrets:${machineId}`;
	const inputBytes = new TextEncoder().encode(input);

	// Stretch the machine-id into a 32-byte key via BLAKE2b.
	// In a future version this can be replaced with Argon2 + passphrase.
	const key = sodium.crypto_generichash(32, inputBytes, null);
	_masterKey = key;
	return key;
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

async function encrypt(plaintext: string): Promise<string> {
	await sodium.ready;
	const key = await getMasterKey();
	const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
	const message = new TextEncoder().encode(plaintext);
	const box = sodium.crypto_secretbox_easy(message, nonce, key);

	// Prepend nonce so we can recover it during decryption
	const combined = new Uint8Array(nonce.length + box.length);
	combined.set(nonce);
	combined.set(box, nonce.length);

	return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
}

async function decrypt(ciphertext: string): Promise<string> {
	await sodium.ready;
	const key = await getMasterKey();

	const combined = sodium.from_base64(ciphertext, sodium.base64_variants.ORIGINAL);
	const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
	const box = combined.slice(sodium.crypto_secretbox_NONCEBYTES);

	const message = sodium.crypto_secretbox_open_easy(box, nonce, key);
	if (!message) throw new Error("Decryption failed - key mismatch or corrupted data");

	return new TextDecoder().decode(message);
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

function loadStore(): SecretsStore {
	if (!existsSync(SECRETS_FILE)) {
		return { version: 1, secrets: {} };
	}
	try {
		return JSON.parse(readFileSync(SECRETS_FILE, "utf-8")) as SecretsStore;
	} catch {
		return { version: 1, secrets: {} };
	}
}

function saveStore(store: SecretsStore): void {
	mkdirSync(SECRETS_DIR, { recursive: true });
	writeFileSync(SECRETS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function putSecret(name: string, value: string): Promise<void> {
	validateName(name);
	const store = loadStore();
	const now = new Date().toISOString();
	const existing = store.secrets[name];

	store.secrets[name] = {
		ciphertext: await encrypt(value),
		created: existing?.created ?? now,
		updated: now,
	};

	saveStore(store);
}

async function getStoredSecret(name: string): Promise<string> {
	const store = loadStore();
	const entry = store.secrets[name];
	if (!entry) throw new Error(`Secret '${name}' not found`);
	return decrypt(entry.ciphertext);
}

export async function getSecret(name: string): Promise<string> {
	if (isOnePasswordReference(name)) {
		const token = await getStoredSecret(ONEPASSWORD_SERVICE_ACCOUNT_SECRET);
		return readOnePasswordReference(name, token);
	}

	return getStoredSecret(name);
}

export function hasSecret(name: string): boolean {
	const store = loadStore();
	return name in store.secrets;
}

export function listSecrets(): string[] {
	return Object.keys(loadStore().secrets);
}

export function deleteSecret(name: string): boolean {
	const store = loadStore();
	if (!(name in store.secrets)) return false;
	delete store.secrets[name];
	saveStore(store);
	return true;
}

// Belt-and-suspenders: reject obvious shell metacharacters even though
// we no longer use sh -c. Catches injection attempts early with a
// clear error message before argv parsing.
const SHELL_META = /[;&|`$(){}[\]<>!\\]/;

/**
 * Spawn a subprocess with one or more secrets injected as environment
 * variables. The agent only supplies references (env var names), never
 * the actual values.
 *
 * Uses direct argv execution (no shell) to eliminate glob/tilde/pipe
 * expansion. The command string is parsed into argv tokens.
 *
 * @param command  Command string to execute (parsed as argv, no shell)
 * @param secretRefs  Map of env var name → secret name, e.g. { OPENAI_API_KEY: "OPENAI_API_KEY" }
 */
export async function execWithSecrets(command: string, secretRefs: Record<string, string>): Promise<ExecResult> {
	if (SHELL_META.test(command)) {
		return { stdout: "", stderr: "command contains disallowed shell metacharacters", code: 1 };
	}

	// Parse command into argv — no shell, so no glob/tilde/pipe expansion
	const argv = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
	if (!argv || argv.length === 0) {
		return { stdout: "", stderr: "empty command", code: 1 };
	}
	const cmd = argv.map((a) => a.replace(/^["']|["']$/g, ""));

	// Resolve all secret values up front so we can redact them from output
	const resolved: Record<string, string> = {};
	for (const [envVar, secretName] of Object.entries(secretRefs)) {
		resolved[envVar] = await getSecret(secretName);
	}

	const secretValues = Object.values(resolved);

	function redact(text: string): string {
		let out = text;
		for (const val of secretValues) {
			if (val.length > 3) {
				out = out.replaceAll(val, "[REDACTED]");
			}
		}
		return out;
	}

	return new Promise((resolve, reject) => {
		const proc = spawn(cmd[0], cmd.slice(1), {
			env: { ...process.env, ...resolved },
			stdio: "pipe",
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});

		proc.on("close", (code) => {
			// Zero out resolved values from memory (best-effort in JS)
			for (const key of Object.keys(resolved)) {
				resolved[key] = "";
			}

			resolve({
				stdout: redact(stdout),
				stderr: redact(stderr),
				code: code ?? 1,
			});
		});

		proc.on("error", (err) => {
			for (const key of Object.keys(resolved)) {
				resolved[key] = "";
			}
			reject(err);
		});
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateName(name: string): void {
	if (!NAME_RE.test(name)) {
		throw new Error(`Invalid secret name '${name}'. Use letters, digits, and underscores only.`);
	}
}
