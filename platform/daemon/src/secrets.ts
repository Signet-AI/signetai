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
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
	BITWARDEN_ACTIVE_PROVIDER_SECRET,
	BITWARDEN_MANAGED_FOLDER_SECRET,
	BITWARDEN_SESSION_SECRET,
	buildBitwardenManagedSecretName,
	deleteBitwardenSecret,
	isBitwardenActiveProvider,
	isBitwardenReference,
	listBitwardenSecretNames,
	putBitwardenSecret,
	readBitwardenReference,
} from "./bitwarden.js";
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
const SECRET_EXEC_JOB_TTL_MS = 60 * 60_000;
const MAX_SECRET_EXEC_RUNNING_JOBS = 4;
const MAX_SECRET_EXEC_QUEUED_JOBS = 64;
const MAX_SECRET_EXEC_RETAINED_JOBS = MAX_SECRET_EXEC_RUNNING_JOBS + MAX_SECRET_EXEC_QUEUED_JOBS + 64;

const BITWARDEN_DELETED_NAMES_SECRET = "BITWARDEN_DELETED_SECRET_NAMES";

const secretExecJobs = new Map<string, SecretExecJob>();
const pendingSecretExecJobs: string[] = [];
const secretExecJobRequests = new Map<
	string,
	{ command: string; secretRefs: Record<string, string>; options: SecretExecOptions }
>();
let runningSecretExecJobs = 0;

export class SecretExecQueueFullError extends Error {
	constructor() {
		super("secret exec queue is full");
		this.name = "SecretExecQueueFullError";
	}
}

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
type SodiumModule = typeof import("libsodium-wrappers").default;
let sodiumPromise: Promise<SodiumModule> | null = null;

async function getSodium(): Promise<SodiumModule> {
	sodiumPromise ??= import("libsodium-wrappers").then(async (mod) => {
		const sodium = mod.default;
		await sodium.ready;
		return sodium;
	});
	return sodiumPromise;
}

async function getMasterKey(): Promise<Uint8Array> {
	if (_masterKey) return _masterKey;

	const sodium = await getSodium();

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
	const sodium = await getSodium();
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
	const sodium = await getSodium();
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

async function putLocalSecret(name: string, value: string): Promise<void> {
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

export async function putSecret(name: string, value: string): Promise<void> {
	const localName = parseLocalSecretName(name);
	if (isInternalSecretName(localName) || !(await isBitwardenProviderActive())) {
		await putLocalSecret(localName, value);
		return;
	}

	const session = await getStoredSecret(BITWARDEN_SESSION_SECRET);
	let folderId: string | undefined;
	try {
		folderId = await getStoredSecret(BITWARDEN_MANAGED_FOLDER_SECRET);
	} catch {
		folderId = undefined;
	}
	await putBitwardenSecret(localName, value, session, { folderId, overwrite: true });
	await clearBitwardenDeletedName(localName);
	recordSecretEvent("secret.stored", { name: localName, providerId: "bitwarden" });
}

async function getStoredSecret(name: string): Promise<string> {
	const store = loadStore();
	const entry = store.secrets[name];
	if (!entry) throw new Error(`Secret '${name}' not found`);
	return decrypt(entry.ciphertext);
}

function canonicalBitwardenDeletedName(name: string): string {
	return buildBitwardenManagedSecretName(parseLocalSecretName(name));
}

async function readBitwardenDeletedNames(): Promise<Set<string>> {
	try {
		const parsed = JSON.parse(await getStoredSecret(BITWARDEN_DELETED_NAMES_SECRET));
		return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
	} catch {
		return new Set();
	}
}

async function writeBitwardenDeletedNames(names: Set<string>): Promise<void> {
	if (names.size === 0) {
		deleteLocalSecret(BITWARDEN_DELETED_NAMES_SECRET);
		return;
	}
	await putLocalSecret(BITWARDEN_DELETED_NAMES_SECRET, JSON.stringify(Array.from(names).sort()));
}

async function markBitwardenDeletedName(name: string): Promise<void> {
	const names = await readBitwardenDeletedNames();
	names.add(canonicalBitwardenDeletedName(name));
	await writeBitwardenDeletedNames(names);
}

async function clearBitwardenDeletedName(name: string): Promise<void> {
	const names = await readBitwardenDeletedNames();
	if (!names.delete(canonicalBitwardenDeletedName(name))) return;
	await writeBitwardenDeletedNames(names);
}

async function isBitwardenDeletedName(name: string): Promise<boolean> {
	return (await readBitwardenDeletedNames()).has(canonicalBitwardenDeletedName(name));
}

export async function getSecret(name: string): Promise<string> {
	if (isOnePasswordReference(name)) {
		const token = await getStoredSecret(ONEPASSWORD_SERVICE_ACCOUNT_SECRET);
		return readOnePasswordReference(name, token);
	}

	if (isBitwardenReference(name)) {
		const session = await getStoredSecret(BITWARDEN_SESSION_SECRET);
		return readBitwardenReference(name, session);
	}

	const localName = parseLocalSecretName(name);
	if (isInternalSecretName(localName)) {
		return getStoredSecret(localName);
	}
	if (await isBitwardenProviderActive()) {
		try {
			const session = await getStoredSecret(BITWARDEN_SESSION_SECRET);
			return readBitwardenReference(
				`bw://name/${encodeURIComponent(buildBitwardenManagedSecretName(localName))}`,
				session,
			);
		} catch (error) {
			if (!hasLocalSecret(localName) || (await isBitwardenDeletedName(localName))) throw error;
		}
	}

	return getStoredSecret(localName);
}

function hasLocalSecret(name: string): boolean {
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

export async function listSecrets(): Promise<string[]> {
	const localNames = listLocalSecretNames({ includeInternal: false });
	if (!(await isBitwardenProviderActive())) {
		recordSecretEvent("secret.listed", { count: localNames.length });
		return localNames;
	}

	const deletedNames = await readBitwardenDeletedNames();
	const visibleLocalNames = localNames.filter((name) => !deletedNames.has(canonicalBitwardenDeletedName(name)));
	try {
		const session = await getStoredSecret(BITWARDEN_SESSION_SECRET);
		const bitwardenNames = await listBitwardenSecretNames(session);
		const names = Array.from(new Set([...bitwardenNames, ...visibleLocalNames])).sort((a, b) => a.localeCompare(b));
		recordSecretEvent("secret.listed", { count: names.length, providerId: "bitwarden" });
		return names;
	} catch {
		recordSecretEvent("secret.listed", {
			count: visibleLocalNames.length,
			providerId: "local",
			degradedProviderId: "bitwarden",
		});
		return visibleLocalNames;
	}
}

function deleteLocalSecret(name: string): boolean {
	const store = loadStore();
	const localName = parseLocalSecretName(name);
	if (!(localName in store.secrets)) return false;
	delete store.secrets[localName];
	saveStore(store);
	recordSecretEvent("secret.deleted", { name: localName });
	return true;
}

export function deleteSecret(name: string): boolean {
	return deleteLocalSecret(name);
}

export async function deleteSecretFromActiveProvider(name: string): Promise<boolean> {
	const explicitLocal = name.startsWith("local://");
	const localName = parseLocalSecretName(name);
	if (explicitLocal || isInternalSecretName(localName) || !(await isBitwardenProviderActive())) {
		return deleteLocalSecret(localName);
	}

	const session = await getStoredSecret(BITWARDEN_SESSION_SECRET);
	const deletedFromBitwarden = await deleteBitwardenSecret(localName, session);
	const localFallbackPreserved = hasLocalSecret(localName);
	if (deletedFromBitwarden || localFallbackPreserved) {
		await markBitwardenDeletedName(localName);
	}
	if (deletedFromBitwarden) {
		recordSecretEvent("secret.deleted", {
			name: localName,
			providerId: "bitwarden",
			localFallbackPreserved,
		});
	}
	return deletedFromBitwarden || localFallbackPreserved;
}

export async function getLocalSecretValue(name: string): Promise<string> {
	return getStoredSecret(parseLocalSecretName(name));
}

export function deleteLocalSecretForMigration(name: string): boolean {
	return deleteLocalSecret(name);
}

export async function setActiveSecretProvider(provider: "local" | "bitwarden"): Promise<void> {
	if (provider === "local") {
		deleteLocalSecret(BITWARDEN_ACTIVE_PROVIDER_SECRET);
		return;
	}
	await putLocalSecret(BITWARDEN_ACTIVE_PROVIDER_SECRET, "bitwarden");
}

export async function getActiveSecretProvider(): Promise<"local" | "bitwarden"> {
	return (await isBitwardenProviderActive()) ? "bitwarden" : "local";
}

async function isBitwardenProviderActive(): Promise<boolean> {
	try {
		return isBitwardenActiveProvider(await getStoredSecret(BITWARDEN_ACTIVE_PROVIDER_SECRET));
	} catch {
		return false;
	}
}

function isInternalSecretName(name: string): boolean {
	return [
		ONEPASSWORD_SERVICE_ACCOUNT_SECRET,
		BITWARDEN_SESSION_SECRET,
		BITWARDEN_ACTIVE_PROVIDER_SECRET,
		BITWARDEN_MANAGED_FOLDER_SECRET,
		BITWARDEN_DELETED_NAMES_SECRET,
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

	function createStreamingRedactor(): { push: (text: string) => string; finish: () => string } {
		const longestSecret = Math.max(0, ...secretValues.filter((value) => value.length > 3).map((value) => value.length));
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

export function startSecretExecJob(
	command: string,
	secretRefs: Record<string, string>,
	options: SecretExecOptions = {},
): SecretExecJob {
	pruneSecretExecJobs();
	evictRetainedSecretExecResults();
	if (
		secretExecJobs.size >= MAX_SECRET_EXEC_RETAINED_JOBS ||
		pendingSecretExecJobs.length >= MAX_SECRET_EXEC_QUEUED_JOBS
	) {
		throw new SecretExecQueueFullError();
	}
	const timeoutMs = normalizeSecretExecTimeoutMs(options.timeoutMs);
	const job: SecretExecJob = {
		id: randomUUID(),
		status: "queued",
		createdAt: new Date().toISOString(),
		timeoutMs,
	};
	secretExecJobs.set(job.id, job);
	secretExecJobRequests.set(job.id, { command, secretRefs: { ...secretRefs }, options: { ...options, timeoutMs } });
	pendingSecretExecJobs.push(job.id);
	drainSecretExecQueue();

	return { ...job };
}

function drainSecretExecQueue(): void {
	while (runningSecretExecJobs < MAX_SECRET_EXEC_RUNNING_JOBS && pendingSecretExecJobs.length > 0) {
		const jobId = pendingSecretExecJobs.shift();
		if (!jobId) return;
		const job = secretExecJobs.get(jobId);
		const request = secretExecJobRequests.get(jobId);
		if (!job || !request || job.status !== "queued") {
			secretExecJobRequests.delete(jobId);
			continue;
		}

		runningSecretExecJobs += 1;
		void (async () => {
			job.status = "running";
			job.startedAt = new Date().toISOString();
			try {
				job.result = await execWithSecrets(request.command, request.secretRefs, request.options);
				job.status = "completed";
			} catch (err) {
				job.status = "failed";
				job.error = err instanceof Error ? err.message : String(err);
			} finally {
				job.completedAt = new Date().toISOString();
				secretExecJobRequests.delete(jobId);
				runningSecretExecJobs = Math.max(0, runningSecretExecJobs - 1);
				drainSecretExecQueue();
			}
		})();
	}
}

export function getSecretExecJob(id: string): SecretExecJob | undefined {
	pruneSecretExecJobs();
	const job = secretExecJobs.get(id);
	return job ? { ...job, result: job.result ? { ...job.result } : undefined } : undefined;
}

export function resetSecretExecJobsForTests(): void {
	secretExecJobs.clear();
	secretExecJobRequests.clear();
	pendingSecretExecJobs.length = 0;
	runningSecretExecJobs = 0;
}

export function normalizeSecretExecTimeoutMs(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SECRET_EXEC_TIMEOUT_MS;
	return Math.min(MAX_SECRET_EXEC_TIMEOUT_MS, Math.max(MIN_SECRET_EXEC_TIMEOUT_MS, Math.trunc(value)));
}

function normalizeSecretExecMaxOutputBytes(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SECRET_EXEC_MAX_OUTPUT_BYTES;
	return Math.min(DEFAULT_SECRET_EXEC_MAX_OUTPUT_BYTES, Math.max(1024, Math.trunc(value)));
}

function pruneSecretExecJobs(now = Date.now()): void {
	for (const [id, job] of secretExecJobs) {
		const timestamp = Date.parse(job.completedAt ?? job.createdAt);
		if (Number.isFinite(timestamp) && now - timestamp > SECRET_EXEC_JOB_TTL_MS) {
			secretExecJobs.delete(id);
			secretExecJobRequests.delete(id);
		}
	}
}

function evictRetainedSecretExecResults(): void {
	if (secretExecJobs.size < MAX_SECRET_EXEC_RETAINED_JOBS) return;
	const evictable = Array.from(secretExecJobs.entries())
		.filter(([, job]) => job.status === "completed" || job.status === "failed")
		.sort(([, a], [, b]) => {
			const aTime = Date.parse(a.completedAt ?? a.createdAt);
			const bTime = Date.parse(b.completedAt ?? b.createdAt);
			return aTime - bTime;
		});

	for (const [jobId] of evictable) {
		if (secretExecJobs.size < MAX_SECRET_EXEC_RETAINED_JOBS) return;
		secretExecJobs.delete(jobId);
		secretExecJobRequests.delete(jobId);
	}
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
