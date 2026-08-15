/**
 * Shared secrets storage and execution primitives.
 *
 * This module is intentionally daemon-independent so the CLI can use the same
 * encrypted store when no daemon is running.
 */

import { execSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { resolveDefaultBasePath } from "./constants.js";
import {
	getSecretKeyring,
	setSecretKeyringForTests,
	type SecretKeyringAdapter,
	type SecretKeyringResult,
	type SecretKeyringState,
} from "./secrets-keyring.js";

export type SecretEventRecorder = (event: string, data: Record<string, unknown>) => void;
let secretEventRecorder: SecretEventRecorder = () => {};
export function setSecretEventRecorder(recorder: SecretEventRecorder | null): void {
	secretEventRecorder = recorder ?? (() => {});
}
function recordSecretEvent(event: string, data: Record<string, unknown>): void {
	secretEventRecorder(event, data);
}

// ---------------------------------------------------------------------------
// Storage layout
// ---------------------------------------------------------------------------

function getAgentsDir(): string {
	return resolveDefaultBasePath();
}

function getSecretsDir(): string {
	return join(getAgentsDir(), ".secrets");
}

function getSecretsFile(): string {
	return join(getSecretsDir(), "secrets.enc");
}

function getMachineIdFile(): string {
	return join(getSecretsDir(), ".machine-id");
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
	version: 1 | 2;
	provider?: "legacy-obfuscated" | "native-keyring";
	secrets: Record<string, SecretEntry>;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	timedOut?: boolean;
}

export interface SecretExecOptions {
	timeoutMs?: number;
	maxOutputBytes?: number;
}

export type SecretExecJobStatus = "queued" | "running" | "completed" | "failed";

export interface SecretExecJob {
	id: string;
	status: SecretExecJobStatus;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	timeoutMs: number;
	result?: ExecResult;
	error?: string;
}

const DEFAULT_SECRET_EXEC_TIMEOUT_MS = 5 * 60_000;
const MAX_SECRET_EXEC_TIMEOUT_MS = 30 * 60_000;
const MIN_SECRET_EXEC_TIMEOUT_MS = 1_000;
const DEFAULT_SECRET_EXEC_MAX_OUTPUT_BYTES = 1024 * 1024;
const SECRET_STORE_TEMP_PREFIX = "secrets.enc.tmp-";

export interface SecretContextV1 {
	readonly agentId?: string;
}

export interface SecretDescriptorV1 {
	readonly name: string;
	readonly ref: string;
	readonly providerId: string;
	readonly created: string;
	readonly updated: string;
}

export interface ResolvedSecretV1 {
	readonly ref: string;
	readonly providerId: string;
	readonly value: string;
}

export interface SecretProviderHealthV1 {
	readonly status: "healthy" | "degraded" | "unhealthy";
	readonly message?: string;
	readonly checkedAt: string;
}

export interface SecretProviderV1 {
	readonly id: string;
	list(ctx: SecretContextV1): Promise<readonly SecretDescriptorV1[]>;
	put(name: string, value: string, ctx: SecretContextV1): Promise<void>;
	delete(name: string, ctx: SecretContextV1): Promise<boolean>;
	resolve(ref: string, ctx: SecretContextV1): Promise<ResolvedSecretV1>;
	health(ctx: SecretContextV1): Promise<SecretProviderHealthV1>;
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

type MachineIdResolver = () => string | undefined;
type MachineIdSource = "persisted" | "resolved" | "fallback";

interface MachineIdSelection {
	readonly id: string;
	readonly source: MachineIdSource;
}

/** Read a machine-specific identifier to bind the key to this host. */
function resolveMachineId(): string | undefined {
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

	return undefined;
}

let machineIdSelection: MachineIdSelection | null = null;
let machineIdResolverForTests: MachineIdResolver | null = null;
type SodiumModule = typeof import("libsodium-wrappers").default;
let sodiumPromise: Promise<SodiumModule> | null = null;
let degradedWarningEmitted = false;

const NATIVE_STORE_VERSION = 2 as const;
const DEGRADED_WARNING_FILE = ".degraded-warning";
const KEYRING_ACCOUNT_SCOPE = "workspace";

interface MasterKeyResolution {
	readonly key: Uint8Array;
	readonly provider: "legacy-obfuscated" | "native-keyring";
}

export class SecretKeyringError extends Error {
	readonly state: SecretKeyringState;
	readonly retryable: boolean;

	constructor(result: SecretKeyringResult) {
		super(result.message ?? `Secrets keyring is ${result.state}`);
		this.name = "SecretKeyringError";
		this.state = result.state;
		this.retryable = result.state === "locked" || result.state === "unavailable";
	}
}

function readPersistedMachineId(): string | undefined {
	try {
		const persisted = readFileSync(getMachineIdFile(), "utf-8").trim();
		if (!persisted) throw new Error("persisted machine identity is empty");
		return persisted;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read persisted secrets machine identity: ${message}`);
	}
}

function persistMachineId(machineId: string): string {
	const file = getMachineIdFile();
	try {
		mkdirSync(getSecretsDir(), { recursive: true, mode: 0o700 });
		chmodSync(getSecretsDir(), 0o700);
		writeFileSync(file, `${machineId}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		chmodSync(file, 0o600);
		return machineId;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") {
			const persisted = readPersistedMachineId();
			if (persisted) return persisted;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to persist secrets machine identity: ${message}`);
	}
}

/**
 * Resolve the durable identity used by the secrets key.
 *
 * Existing stores predate the identity anchor. Do not persist a newly selected
 * identity for one of those stores until its ciphertext has been verified with
 * that identity. A transient resolver failure must not make the old key
 * unrecoverable.
 */
function getMachineId(): string {
	const persisted = readPersistedMachineId();
	if (persisted) {
		machineIdSelection = { id: persisted, source: "persisted" };
		return persisted;
	}

	if (!machineIdSelection) {
		const resolved = (machineIdResolverForTests ?? resolveMachineId)()?.trim();
		if (resolved) {
			machineIdSelection = { id: resolved, source: "resolved" };
		} else {
			const username = process.env.USER?.trim() || process.env.USERNAME?.trim();
			if (!username) {
				throw new Error("Unable to derive stable secrets machine identity: USER and USERNAME are unset");
			}

			machineIdSelection = { id: `${hostname()}-${username}`, source: "fallback" };
		}
	}

	if (!existsSync(getSecretsFile())) {
		const persistedId = persistMachineId(machineIdSelection.id);
		machineIdSelection = { id: persistedId, source: "persisted" };
	}
	return machineIdSelection.id;
}

export function setMachineIdResolverForTests(resolver: MachineIdResolver | null): void {
	machineIdResolverForTests = resolver;
	machineIdSelection = null;
}

export function setSecretKeyringAdapterForTests(adapter: SecretKeyringAdapter | null): void {
	setSecretKeyringForTests(adapter);
	degradedWarningEmitted = false;
}

async function getSodium(): Promise<SodiumModule> {
	sodiumPromise ??= import("libsodium-wrappers").then(async (mod) => {
		const sodium = mod.default;
		await sodium.ready;
		return sodium;
	});
	return sodiumPromise;
}

async function getLegacyMasterKey(): Promise<Uint8Array> {
	const sodium = await getSodium();
	const machineId = getMachineId();
	const input = `signet:secrets:${machineId}`;
	const inputBytes = new TextEncoder().encode(input);
	return sodium.crypto_generichash(32, inputBytes, null);
}

function decodeKeyringValue(result: SecretKeyringResult): Uint8Array {
	if (result.value === undefined)
		throw new SecretKeyringError({ state: "corrupt", message: "Keyring returned no master key" });
	try {
		const key = Buffer.from(result.value, "base64");
		if (key.length !== 32 || key.toString("base64") !== result.value) {
			throw new Error("master key is not valid canonical base64");
		}
		return new Uint8Array(key);
	} catch (error) {
		throw new SecretKeyringError({ state: "corrupt", message: error instanceof Error ? error.message : String(error) });
	}
}

function emitDegradedWarning(result: SecretKeyringResult): void {
	void result;
	if (degradedWarningEmitted) return;
	degradedWarningEmitted = true;
	try {
		mkdirSync(getSecretsDir(), { recursive: true, mode: 0o700 });
		writeFileSync(join(getSecretsDir(), DEGRADED_WARNING_FILE), "legacy-obfuscated\n", {
			encoding: "utf-8",
			mode: 0o600,
		});
	} catch {
		// The health response still reports degraded state if the marker cannot be written.
	}
}

function clearDegradedWarning(): void {
	try {
		unlinkSync(join(getSecretsDir(), DEGRADED_WARNING_FILE));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
}

async function migrateLegacyStore(store: SecretsStore, legacyKey: Uint8Array, nativeKey: Uint8Array): Promise<void> {
	const plaintexts = new Map<string, string>();
	for (const [name, entry] of Object.entries(store.secrets)) {
		plaintexts.set(name, await decryptWithKey(entry.ciphertext, legacyKey));
	}
	const migrated: SecretsStore = {
		version: NATIVE_STORE_VERSION,
		provider: "native-keyring",
		secrets: {},
	};
	for (const [name, plaintext] of plaintexts) {
		const entry = store.secrets[name];
		if (!entry) continue;
		migrated.secrets[name] = {
			ciphertext: await encryptWithKey(plaintext, nativeKey),
			created: entry.created,
			updated: entry.updated,
		};
	}
	store.version = migrated.version;
	store.provider = migrated.provider;
	store.secrets = migrated.secrets;
	saveStore(store);
	clearDegradedWarning();
}

async function resolveMasterKey(store: SecretsStore): Promise<MasterKeyResolution> {
	const keyring = getSecretKeyring(`${KEYRING_ACCOUNT_SCOPE}:${getAgentsDir()}`);
	const result = await keyring.get();
	if (store.version === NATIVE_STORE_VERSION || store.provider === "native-keyring") {
		if (result.state !== "found") throw new SecretKeyringError(result);
		return { key: decodeKeyringValue(result), provider: "native-keyring" };
	}

	if (result.state === "found") {
		const nativeKey = decodeKeyringValue(result);
		if (existsSync(getSecretsFile())) await migrateLegacyStore(store, await getLegacyMasterKey(), nativeKey);
		return { key: nativeKey, provider: "native-keyring" };
	}

	if (result.state === "missing") {
		const nativeKey = randomBytes(32);
		const legacyKey = existsSync(getSecretsFile()) ? await getLegacyMasterKey() : undefined;
		const saved = await keyring.set(Buffer.from(nativeKey).toString("base64"));
		if (saved.state === "found") {
			if (legacyKey) await migrateLegacyStore(store, legacyKey, nativeKey);
			return { key: nativeKey, provider: "native-keyring" };
		}
		throw new SecretKeyringError(saved);
	}

	if (result.state === "locked") throw new SecretKeyringError(result);
	if (result.state !== "unavailable" && result.state !== "unsupported") throw new SecretKeyringError(result);
	emitDegradedWarning(result);
	return { key: await getLegacyMasterKey(), provider: "legacy-obfuscated" };
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

async function decryptWithKey(ciphertext: string, key: Uint8Array): Promise<string> {
	const sodium = await getSodium();
	let message: Uint8Array | false;
	try {
		const combined = sodium.from_base64(ciphertext, sodium.base64_variants.ORIGINAL);
		const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
		const box = combined.slice(sodium.crypto_secretbox_NONCEBYTES);
		message = sodium.crypto_secretbox_open_easy(box, nonce, key);
	} catch {
		throw new Error("Decryption failed - key mismatch or corrupted data");
	}
	if (!message) throw new Error("Decryption failed - key mismatch or corrupted data");
	return new TextDecoder().decode(message);
}

async function anchorLegacyMachineIdAfterVerification(key: Uint8Array): Promise<void> {
	if (
		!machineIdSelection ||
		machineIdSelection.source === "persisted" ||
		existsSync(getMachineIdFile()) ||
		!existsSync(getSecretsFile())
	) {
		return;
	}
	const store = loadStore();
	for (const entry of Object.values(store.secrets)) await decryptWithKey(entry.ciphertext, key);
	const persistedId = persistMachineId(machineIdSelection.id);
	machineIdSelection = { id: persistedId, source: "persisted" };
}

async function encryptWithKey(plaintext: string, key: Uint8Array): Promise<string> {
	const sodium = await getSodium();
	const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
	const message = new TextEncoder().encode(plaintext);
	const box = sodium.crypto_secretbox_easy(message, nonce, key);
	const combined = new Uint8Array(nonce.length + box.length);
	combined.set(nonce);
	combined.set(box, nonce.length);
	return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

function isSecretStoreTempProcessLive(name: string): boolean {
	const pid = name.slice(SECRET_STORE_TEMP_PREFIX.length).split("-", 1)[0];
	if (!/^\d+$/.test(pid)) return false;

	try {
		process.kill(Number(pid), 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

function cleanupStaleSecretStoreTemps(): void {
	const dir = getSecretsDir();
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}

	for (const name of names) {
		if (!name.startsWith(SECRET_STORE_TEMP_PREFIX) || isSecretStoreTempProcessLive(name)) continue;
		try {
			unlinkSync(join(dir, name));
		} catch {
			// Best effort. Another process may have finished or removed the file.
		}
	}
}

function loadStore(): SecretsStore {
	cleanupStaleSecretStoreTemps();
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

type SecretStoreWriteStage = "after-write" | "before-close";
type SecretStoreWriteHookForTests = (stage: SecretStoreWriteStage, fd?: number) => void;
let secretStoreWriteHookForTests: SecretStoreWriteHookForTests | null = null;

/** @internal Inject a failure or process kill while testing atomic store replacement. */
export function __setSecretStoreWriteHookForTests(hook: SecretStoreWriteHookForTests | null): void {
	secretStoreWriteHookForTests = hook;
}

function saveStore(store: SecretsStore): void {
	const file = getSecretsFile();
	const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
	mkdirSync(getSecretsDir(), { recursive: true });

	let fd: number | null = null;
	try {
		fd = openSync(tmp, "w", 0o600);
		writeFileSync(fd, JSON.stringify(store, null, 2), "utf-8");
		secretStoreWriteHookForTests?.("after-write");
		fsyncSync(fd);
		secretStoreWriteHookForTests?.("before-close", fd);
		closeSync(fd);
		fd = null;
		renameSync(tmp, file);
	} catch (error) {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				// Continue cleanup and preserve the original write error.
			}
		}
		try {
			unlinkSync(tmp);
		} catch {
			// Best effort cleanup. The existing store remains untouched if replacement did not happen.
		}
		throw error;
	}
}

const SECRET_STORE_LOCK_FILE = "secrets.enc.lock";
const SECRET_STORE_LOCK_RETRIES = 400;
const SECRET_STORE_LOCK_WAIT_MS = 10;

type SecretStoreLockHookForTests = (stage: "after-acquire") => void;
let secretStoreLockHookForTests: SecretStoreLockHookForTests | null = null;

/** @internal Pause an acquired lock in a child-process race regression test. */
export function __setSecretStoreLockHookForTests(hook: SecretStoreLockHookForTests | null): void {
	secretStoreLockHookForTests = hook;
}

function getSecretStoreLockFile(): string {
	return join(getSecretsDir(), SECRET_STORE_LOCK_FILE);
}

function readSecretStoreLockOwner(): string | null | undefined {
	try {
		const owner = readFileSync(getSecretStoreLockFile(), "utf-8").trim();
		return owner || null;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function isSecretStoreLockLive(owner: string): boolean | null {
	const pid = Number(owner.split("-", 1)[0]);
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

function tryAcquireSecretStoreLock(owner: string): boolean {
	const lockFile = getSecretStoreLockFile();
	const tempFile = `${lockFile}.${owner}`;
	let fd: number | null = null;
	try {
		// Publish the complete owner token through a hard link. The lock path is
		// never visible in its empty or partially-written state.
		fd = openSync(tempFile, "wx", 0o600);
		writeFileSync(fd, `${owner}\n`, "utf-8");
		fsyncSync(fd);
		closeSync(fd);
		fd = null;
		linkSync(tempFile, lockFile);
		secretStoreLockHookForTests?.("after-acquire");
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
		throw error;
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				// Preserve the original lock acquisition error.
			}
		}
		try {
			unlinkSync(tempFile);
		} catch {
			// Best effort cleanup. The lock path owns the published link.
		}
	}
}

function removeStaleSecretStoreLock(observedOwner: string): boolean {
	const currentOwner = readSecretStoreLockOwner();
	if (currentOwner !== observedOwner || isSecretStoreLockLive(currentOwner) !== false) return false;
	const staleFile = `${getSecretStoreLockFile()}.stale-${randomUUID()}`;
	try {
		// Re-check the token immediately before rename. A new owner can only
		// appear after this path is removed, so it cannot be moved by this CAS.
		renameSync(getSecretStoreLockFile(), staleFile);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
	try {
		unlinkSync(staleFile);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	return true;
}

interface SecretStoreLock {
	release: () => Promise<void>;
}

async function acquireSecretStoreLock(): Promise<SecretStoreLock> {
	const owner = `${process.pid}-${randomUUID()}`;
	for (let attempt = 0; attempt < SECRET_STORE_LOCK_RETRIES; attempt += 1) {
		mkdirSync(getSecretsDir(), { recursive: true, mode: 0o700 });
		if (tryAcquireSecretStoreLock(owner)) {
			return {
				release: async () => {
					try {
						if (readSecretStoreLockOwner() !== owner) return;
						unlinkSync(getSecretStoreLockFile());
					} catch (error) {
						if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
					}
				},
			};
		}
		const existingOwner = readSecretStoreLockOwner();
		if (existingOwner !== undefined && existingOwner !== null && removeStaleSecretStoreLock(existingOwner)) continue;
		await new Promise<void>((resolve) => setTimeout(resolve, SECRET_STORE_LOCK_WAIT_MS));
	}
	throw new Error("Timed out waiting for the secrets store lock");
}

async function withSecretStoreLock<T>(fn: () => Promise<T> | T): Promise<T> {
	const lock = await acquireSecretStoreLock();
	try {
		return await fn();
	} finally {
		await lock.release();
	}
}

export async function putLocalSecret(name: string, value: string): Promise<void> {
	await withSecretStoreLock(async () => {
		const localName = parseLocalSecretName(name);
		const store = loadStore();
		const resolution = await resolveMasterKey(store);
		if (
			resolution.provider === "legacy-obfuscated" &&
			existsSync(getSecretsFile()) &&
			!existsSync(getMachineIdFile()) &&
			machineIdResolverForTests !== null &&
			!machineIdResolverForTests()?.trim()
		) {
			throw new Error("Existing secrets store could not be verified: unable to resolve its machine identity");
		}
		await anchorLegacyMachineIdAfterVerification(resolution.key);
		store.version = resolution.provider === "native-keyring" ? NATIVE_STORE_VERSION : 1;
		store.provider = resolution.provider;
		const now = new Date().toISOString();
		const existing = store.secrets[localName];

		store.secrets[localName] = {
			ciphertext: await encryptWithKey(value, resolution.key),
			created: existing?.created ?? now,
			updated: now,
		};

		saveStore(store);
		recordSecretEvent("secret.stored", { name: localName, providerId: resolution.provider });
	});
}

export async function getLocalSecretValue(name: string): Promise<string> {
	const store = loadStore();
	const resolution = await resolveMasterKey(store);
	const localName = parseLocalSecretName(name);
	const entry = store.secrets[localName];
	if (!entry) throw new Error(`Secret '${localName}' not found`);
	const plaintext = await decryptWithKey(entry.ciphertext, resolution.key);
	if (resolution.provider === "legacy-obfuscated") {
		await withSecretStoreLock(() => anchorLegacyMachineIdAfterVerification(resolution.key));
	}
	return plaintext;
}

export function hasLocalSecret(name: string): boolean {
	const store = loadStore();
	return parseLocalSecretName(name) in store.secrets;
}

export function hasSecret(name: string): boolean {
	return hasLocalSecret(name);
}

export function listLocalSecretNames(options: { includeInternal?: boolean } = {}): string[] {
	const names = Object.keys(loadStore().secrets).sort((a, b) => a.localeCompare(b));
	if (options.includeInternal === true) return names;
	return names.filter((name) => !isInternalSecretName(name));
}

export async function deleteLocalSecret(name: string): Promise<boolean> {
	return withSecretStoreLock(async () => {
		const store = loadStore();
		const localName = parseLocalSecretName(name);
		if (!(localName in store.secrets)) return false;
		delete store.secrets[localName];
		saveStore(store);
		recordSecretEvent("secret.deleted", { name: localName });
		return true;
	});
}

function isInternalSecretName(name: string): boolean {
	return [
		"OP_SERVICE_ACCOUNT_TOKEN",
		"BITWARDEN_SESSION",
		"SIGNET_SECRETS_ACTIVE_PROVIDER",
		"BITWARDEN_MANAGED_FOLDER_ID",
		"BITWARDEN_DELETED_SECRET_NAMES",
	].includes(name);
}

export type LocalSecretProviderV1 = SecretProviderV1;

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
		await putLocalSecret(name, value);
	},
	async delete(name, _ctx) {
		return deleteLocalSecret(name);
	},
	async resolve(ref, _ctx) {
		const name = parseLocalSecretName(ref);
		return {
			ref: `local://${name}`,
			providerId: "local",
			value: await getLocalSecretValue(name),
		};
	},
	async health(_ctx) {
		return getLocalSecretProviderHealth();
	},
};

function healthForKeyringState(result: SecretKeyringResult): SecretProviderHealthV1 {
	const checkedAt = new Date().toISOString();
	const message = result.message ?? `Native secrets keyring is ${result.state}`;
	if (
		result.state === "missing" ||
		result.state === "locked" ||
		result.state === "unavailable" ||
		result.state === "unsupported"
	) {
		return { status: "degraded", message, checkedAt };
	}
	if (result.state === "permission-denied" || result.state === "corrupt") {
		return { status: "unhealthy", message, checkedAt };
	}
	return { status: "healthy", checkedAt };
}

export function getLocalSecretProviderHealth(): SecretProviderHealthV1 {
	try {
		const store = loadStore();
		if (existsSync(join(getSecretsDir(), DEGRADED_WARNING_FILE))) {
			return {
				status: "degraded",
				message: "Using legacy machine-id-obfuscated secrets encryption because no native keyring is available",
				checkedAt: new Date().toISOString(),
			};
		}
		if (store.version === NATIVE_STORE_VERSION || store.provider === "native-keyring") {
			const keyring = getSecretKeyring(`${KEYRING_ACCOUNT_SCOPE}:${getAgentsDir()}`);
			const state = keyring.getStatus?.();
			if (state && state.state !== "found") return healthForKeyringState(state);
			if (state) {
				try {
					decodeKeyringValue(state);
				} catch (error) {
					return {
						status: "degraded",
						message: `Native secrets keyring is corrupt: ${error instanceof Error ? error.message : String(error)}`,
						checkedAt: new Date().toISOString(),
					};
				}
			}
		}
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
export async function execWithSecrets(
	command: string,
	secretRefs: Record<string, string>,
	options: SecretExecOptions = {},
): Promise<ExecResult> {
	if (SHELL_META.test(command)) {
		return { stdout: "", stderr: "command contains disallowed shell metacharacters", code: 1 };
	}

	// Parse command into argv — no shell, so no glob/tilde/pipe expansion
	const argv = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
	if (!argv || argv.length === 0) {
		return { stdout: "", stderr: "empty command", code: 1 };
	}
	const cmd = argv.map((a) => a.replace(/^["']|["']$/g, ""));
	const timeoutMs = normalizeSecretExecTimeoutMs(options.timeoutMs);
	const maxOutputBytes = normalizeSecretExecMaxOutputBytes(options.maxOutputBytes);

	// Resolve all secret values up front so we can redact them from output
	const resolved: Record<string, string> = {};
	for (const [envVar, secretName] of Object.entries(secretRefs)) {
		resolved[envVar] = await getLocalSecretValue(secretName);
	}
	recordSecretEvent("secret.resolved_for_exec", {
		secretCount: Object.keys(secretRefs).length,
		envVars: Object.keys(secretRefs),
	});

	const secretValues = Object.values(resolved);

	function redact(text: string): string {
		let out = text;
		for (const val of secretValues) {
			if (val.length > 0) {
				out = out.replaceAll(val, "[REDACTED]");
			}
		}
		return out;
	}

	function createStreamingRedactor(): { push: (text: string) => string; finish: () => string } {
		const longestSecret = Math.max(0, ...secretValues.map((value) => value.length));
		const overlap = Math.max(0, longestSecret * 2);
		let pending = "";
		return {
			push(text: string): string {
				if (overlap === 0) return text;
				pending += text;
				if (pending.length <= overlap) return "";
				const emitLength = pending.length - overlap;
				const emit = pending.slice(0, emitLength);
				pending = pending.slice(emitLength);
				return redact(emit);
			},
			finish(): string {
				const emit = pending;
				pending = "";
				return redact(emit);
			},
		};
	}

	recordSecretEvent("secret.exec_started", {
		secretCount: Object.keys(secretRefs).length,
		envVars: Object.keys(secretRefs),
		timeoutMs,
	});

	return new Promise((resolve, reject) => {
		const useProcessGroup = process.platform !== "win32";
		const proc = spawn(cmd[0], cmd.slice(1), {
			detached: useProcessGroup,
			env: { ...process.env, ...resolved },
			stdio: "pipe",
			windowsHide: true,
		});

		const stdoutRedactor = createStreamingRedactor();
		const stderrRedactor = createStreamingRedactor();
		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let settled = false;
		let timedOut = false;

		function killSpawnedProcess(signal: NodeJS.Signals): void {
			if (!proc.pid) return;
			try {
				if (useProcessGroup) process.kill(-proc.pid, signal);
				else proc.kill(signal);
			} catch {
				try {
					proc.kill(signal);
				} catch {
					// Already gone.
				}
			}
		}

		const timer = setTimeout(() => {
			timedOut = true;
			killSpawnedProcess("SIGTERM");
			setTimeout(() => {
				if (!settled && proc.exitCode === null) killSpawnedProcess("SIGKILL");
			}, 2_000).unref();
		}, timeoutMs);
		timer.unref();

		function appendRedactedOutput(
			current: string,
			bytes: number,
			text: string,
			stream: "stdout" | "stderr",
		): [string, number] {
			const chunk = Buffer.from(text);
			if (bytes >= maxOutputBytes) {
				if (chunk.length > 0) {
					if (stream === "stdout") stdoutTruncated = true;
					else stderrTruncated = true;
				}
				return [current, bytes + chunk.length];
			}
			const remaining = maxOutputBytes - bytes;
			const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
			if (chunk.length > remaining) {
				if (stream === "stdout") stdoutTruncated = true;
				else stderrTruncated = true;
			}
			return [current + slice.toString(), bytes + chunk.length];
		}

		function zeroResolved(): void {
			for (const key of Object.keys(resolved)) {
				resolved[key] = "";
			}
		}

		proc.stdout?.on("data", (d: Buffer) => {
			[stdout, stdoutBytes] = appendRedactedOutput(stdout, stdoutBytes, stdoutRedactor.push(d.toString()), "stdout");
		});
		proc.stderr?.on("data", (d: Buffer) => {
			[stderr, stderrBytes] = appendRedactedOutput(stderr, stderrBytes, stderrRedactor.push(d.toString()), "stderr");
		});

		proc.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			zeroResolved();
			const finalCode = timedOut ? 124 : (code ?? 1);
			[stdout, stdoutBytes] = appendRedactedOutput(stdout, stdoutBytes, stdoutRedactor.finish(), "stdout");
			[stderr, stderrBytes] = appendRedactedOutput(stderr, stderrBytes, stderrRedactor.finish(), "stderr");
			if (stdoutTruncated) stdout += "\n[signet secret exec: stdout truncated]\n";
			if (stderrTruncated) stderr += "\n[signet secret exec: stderr truncated]\n";
			if (timedOut) stderr += `\n[signet secret exec: timed out after ${timeoutMs}ms]\n`;

			recordSecretEvent("secret.exec_completed", {
				code: finalCode,
				secretCount: secretValues.length,
				timedOut,
			});

			resolve({
				stdout,
				stderr,
				code: finalCode,
				...(timedOut ? { timedOut: true } : {}),
			});
		});

		proc.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			zeroResolved();
			recordSecretEvent("secret.exec_completed", {
				code: 1,
				secretCount: secretValues.length,
				error: err.message,
			});
			reject(err);
		});
	});
}

export function normalizeSecretExecTimeoutMs(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SECRET_EXEC_TIMEOUT_MS;
	return Math.min(MAX_SECRET_EXEC_TIMEOUT_MS, Math.max(MIN_SECRET_EXEC_TIMEOUT_MS, Math.trunc(value)));
}

function normalizeSecretExecMaxOutputBytes(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SECRET_EXEC_MAX_OUTPUT_BYTES;
	return Math.min(DEFAULT_SECRET_EXEC_MAX_OUTPUT_BYTES, Math.max(1024, Math.trunc(value)));
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

export function parseLocalSecretName(ref: string): string {
	const name = ref.startsWith("local://") ? ref.slice("local://".length) : ref;
	validateName(name);
	return name;
}

function parseSecretsStore(value: unknown): SecretsStore {
	if (!isRecord(value)) {
		throw new Error("store must be a JSON object");
	}
	if (value.version !== 1 && value.version !== NATIVE_STORE_VERSION) {
		throw new Error("unsupported secrets store version");
	}
	if (value.version === NATIVE_STORE_VERSION && value.provider !== "native-keyring") {
		throw new Error("native-keyring store is missing its provider marker");
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
	return {
		version: value.version,
		...(value.provider === "native-keyring" ? { provider: value.provider } : {}),
		secrets,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
