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
import { logger } from "./logger.js";
import { ONEPASSWORD_SERVICE_ACCOUNT_SECRET, isOnePasswordReference, readOnePasswordReference } from "./onepassword.js";
import { recordPluginAuditEvent } from "./plugins/audit.js";
import { SIGNET_SECRETS_PLUGIN_ID } from "./plugins/bundled/secrets.js";

// ---------------------------------------------------------------------------
// Storage layout
// ---------------------------------------------------------------------------

function getAgentsDir(): string {
	return process.env.SIGNET_PATH || join(homedir(), ".agents");
}

function getSecretsDir(): string {
	return join(getAgentsDir(), ".secrets");
}

function getSecretsFile(): string {
	return join(getSecretsDir(), "secrets.enc");
}

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

export interface SecretContextV1 {
	readonly agentId?: string;
}

export interface SecretDescriptorV1 {
	readonly name: string;
	readonly ref: string;
	readonly providerId: "local";
	readonly created: string;
	readonly updated: string;
}

export interface ResolvedSecretV1 {
	readonly ref: string;
	readonly providerId: "local";
	readonly value: string;
}

export interface SecretProviderHealthV1 {
	readonly status: "healthy" | "degraded" | "unhealthy";
	readonly message?: string;
	readonly checkedAt: string;
}

export interface LocalSecretProviderV1 {
	readonly id: "local";
	list(ctx: SecretContextV1): Promise<readonly SecretDescriptorV1[]>;
	put(name: string, value: string, ctx: SecretContextV1): Promise<void>;
	delete(name: string, ctx: SecretContextV1): Promise<boolean>;
	resolve(ref: string, ctx: SecretContextV1): Promise<ResolvedSecretV1>;
	health(ctx: SecretContextV1): Promise<SecretProviderHealthV1>;
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

	let message: Uint8Array | false;
	try {
		message = sodium.crypto_secretbox_open_easy(box, nonce, key);
	} catch {
		throw new Error("Decryption failed - key mismatch or corrupted data");
	}
	if (!message) throw new Error("Decryption failed - key mismatch or corrupted data");

	return new TextDecoder().decode(message);
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

function loadStore(): SecretsStore {
	const file = getSecretsFile();
	if (!existsSync(file)) {
		return { version: 1, secrets: {} };
	}
	try {
		return parseSecretsStore(JSON.parse(readFileSync(file, "utf-8")));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to read secrets store: ${message}`);
	}
}

function saveStore(store: SecretsStore): void {
	mkdirSync(getSecretsDir(), { recursive: true });
	writeFileSync(getSecretsFile(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function putSecret(name: string, value: string): Promise<void> {
	const localName = parseLocalSecretName(name);
	const store = loadStore();
	const now = new Date().toISOString();
	const existing = store.secrets[localName];

	store.secrets[localName] = {
		ciphertext: await encrypt(value),
		created: existing?.created ?? now,
		updated: now,
	};

	saveStore(store);
	recordSecretEvent("secret.stored", { name: localName });
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

	return getStoredSecret(parseLocalSecretName(name));
}

export function hasSecret(name: string): boolean {
	const store = loadStore();
	return parseLocalSecretName(name) in store.secrets;
}

export function listSecrets(): string[] {
	const names = Object.keys(loadStore().secrets).sort((a, b) => a.localeCompare(b));
	recordSecretEvent("secret.listed", { count: names.length });
	return names;
}

export function deleteSecret(name: string): boolean {
	const store = loadStore();
	const localName = parseLocalSecretName(name);
	if (!(localName in store.secrets)) return false;
	delete store.secrets[localName];
	saveStore(store);
	recordSecretEvent("secret.deleted", { name: localName });
	return true;
}

export const localSecretProvider: LocalSecretProviderV1 = {
	id: "local",
	async list(_ctx) {
		const store = loadStore();
		const descriptors = Object.entries(store.secrets)
			.map(([name, entry]) => ({
				name,
				ref: `local://${name}`,
				providerId: "local" as const,
				created: entry.created,
				updated: entry.updated,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
		recordSecretEvent("secret.listed", { count: descriptors.length });
		return descriptors;
	},
	async put(name, value, _ctx) {
		await putSecret(name, value);
	},
	async delete(name, _ctx) {
		return deleteSecret(name);
	},
	async resolve(ref, _ctx) {
		const name = parseLocalSecretName(ref);
		return {
			ref: `local://${name}`,
			providerId: "local",
			value: await getStoredSecret(name),
		};
	},
	async health(_ctx) {
		return getLocalSecretProviderHealth();
	},
};

export function getLocalSecretProviderHealth(): SecretProviderHealthV1 {
	try {
		loadStore();
		return { status: "healthy", checkedAt: new Date().toISOString() };
	} catch (err) {
		return {
			status: "unhealthy",
			message: err instanceof Error ? err.message : String(err),
			checkedAt: new Date().toISOString(),
		};
	}
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
	recordSecretEvent("secret.resolved_for_exec", {
		secretCount: Object.keys(secretRefs).length,
		envVars: Object.keys(secretRefs),
	});

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

	recordSecretEvent("secret.exec_started", {
		secretCount: Object.keys(secretRefs).length,
		envVars: Object.keys(secretRefs),
	});

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

			recordSecretEvent("secret.exec_completed", {
				code: code ?? 1,
				secretCount: secretValues.length,
			});

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
			recordSecretEvent("secret.exec_completed", {
				code: 1,
				secretCount: secretValues.length,
				error: err.message,
			});
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

function recordSecretEvent(event: string, data: Record<string, unknown>): void {
	recordPluginAuditEvent({
		event,
		pluginId: SIGNET_SECRETS_PLUGIN_ID,
		result: event === "secret.exec_completed" && data.code !== 0 ? "error" : "ok",
		source: "secrets-provider",
		data: {
			providerId: "local",
			...data,
		},
	});
	logger.info("secrets", event, {
		pluginId: SIGNET_SECRETS_PLUGIN_ID,
		providerId: "local",
		timestamp: new Date().toISOString(),
		...data,
	});
}

export function parseLocalSecretName(ref: string): string {
	const name = ref.startsWith("local://") ? ref.slice("local://".length) : ref;
	validateName(name);
	return name;
}

function parseSecretsStore(value: unknown): SecretsStore {
	if (!isRecord(value)) {
		throw new Error("store must be a JSON object");
	}
	if (value.version !== 1) {
		throw new Error("unsupported secrets store version");
	}
	if (!isRecord(value.secrets)) {
		throw new Error("secrets field must be an object");
	}
	const secrets: Record<string, SecretEntry> = {};
	for (const [name, entry] of Object.entries(value.secrets)) {
		validateName(name);
		if (!isRecord(entry)) {
			throw new Error(`secret '${name}' must be an object`);
		}
		if (
			typeof entry.ciphertext !== "string" ||
			typeof entry.created !== "string" ||
			typeof entry.updated !== "string"
		) {
			throw new Error(`secret '${name}' is missing required fields`);
		}
		secrets[name] = {
			ciphertext: entry.ciphertext,
			created: entry.created,
			updated: entry.updated,
		};
	}
	return { version: 1, secrets };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
