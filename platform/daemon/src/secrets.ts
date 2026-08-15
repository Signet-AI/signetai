/**
 * Daemon secrets provider integration and asynchronous exec queue.
 *
 * Encrypted local storage and command execution live in @signet/core so the
 * CLI can use the same implementation when the daemon is offline.
 */

import { randomUUID } from "node:crypto";
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
import {
	deleteLocalSecret as deleteLocalSecretCore,
	execWithSecrets,
	getLocalSecretProviderHealth,
	getLocalSecretValue,
	hasLocalSecret,
	listLocalSecretNames,
	localSecretProvider,
	normalizeSecretExecTimeoutMs,
	parseLocalSecretName,
	putLocalSecret,
	SecretKeyringError,
	setMachineIdResolverForTests,
	setSecretEventRecorder,
	setSecretKeyringAdapterForTests,
	__setSecretStoreWriteHookForTests,
	type ExecResult,
	type SecretContextV1,
	type SecretDescriptorV1,
	type SecretExecOptions,
	type SecretProviderHealthV1,
	type SecretProviderV1,
	type ResolvedSecretV1,
	type SecretKeyringAdapter,
} from "@signet/core";
import { ONEPASSWORD_SERVICE_ACCOUNT_SECRET, isOnePasswordReference, readOnePasswordReference } from "./onepassword.js";
import { recordPluginAuditEvent } from "./plugins/audit.js";
import { SIGNET_SECRETS_PLUGIN_ID } from "./plugins/bundled/secrets.js";

export {
	deleteLocalSecretCore as deleteLocalSecret,
	execWithSecrets,
	getLocalSecretProviderHealth,
	getLocalSecretValue,
	hasLocalSecret,
	listLocalSecretNames,
	localSecretProvider,
	normalizeSecretExecTimeoutMs,
	parseLocalSecretName,
	putLocalSecret,
	SecretKeyringError,
	setMachineIdResolverForTests,
	setSecretKeyringAdapterForTests,
	__setSecretStoreWriteHookForTests,
};
export type {
	ExecResult,
	SecretContextV1,
	SecretDescriptorV1,
	SecretExecOptions,
	SecretProviderHealthV1,
	SecretProviderV1,
	ResolvedSecretV1,
};
export type LocalSecretProviderV1 = SecretProviderV1;
export type { SecretKeyringAdapter };

const BITWARDEN_DELETED_NAMES_SECRET = "BITWARDEN_DELETED_SECRET_NAMES";
const SECRET_EXEC_JOB_TTL_MS = 60 * 60_000;
const MAX_SECRET_EXEC_RUNNING_JOBS = 4;
const MAX_SECRET_EXEC_QUEUED_JOBS = 64;
const MAX_SECRET_EXEC_RETAINED_JOBS = MAX_SECRET_EXEC_RUNNING_JOBS + MAX_SECRET_EXEC_QUEUED_JOBS + 64;
const secretExecJobs = new Map<string, SecretExecJob>();
const pendingSecretExecJobs: string[] = [];
const secretExecJobRequests = new Map<
	string,
	{ command: string; secretRefs: Record<string, string>; options: SecretExecOptions }
>();
let runningSecretExecJobs = 0;

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

export class SecretExecQueueFullError extends Error {
	constructor() {
		super("secret exec queue is full");
		this.name = "SecretExecQueueFullError";
	}
}

export function hasSecret(name: string): boolean {
	return hasLocalSecret(name);
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

function recordSecretEvent(event: string, data: Record<string, unknown>): void {
	recordPluginAuditEvent({
		event,
		pluginId: SIGNET_SECRETS_PLUGIN_ID,
		result: event === "secret.exec_completed" && data.code !== 0 ? "error" : "ok",
		source: "secrets-provider",
		data: { providerId: "local", ...data },
	});
	logger.info("secrets", event, {
		pluginId: SIGNET_SECRETS_PLUGIN_ID,
		providerId: "local",
		timestamp: new Date().toISOString(),
		...data,
	});
}
setSecretEventRecorder(recordSecretEvent);

export async function putSecret(name: string, value: string): Promise<void> {
	invalidateSecretsCache();
	const localName = parseLocalSecretName(name);
	if (isInternalSecretName(localName) || !(await isBitwardenProviderActive())) {
		await putLocalSecret(localName, value);
		return;
	}

	const session = await getLocalSecretValue(BITWARDEN_SESSION_SECRET);
	let folderId: string | undefined;
	try {
		folderId = await getLocalSecretValue(BITWARDEN_MANAGED_FOLDER_SECRET);
	} catch {
		folderId = undefined;
	}
	await putBitwardenSecret(localName, value, session, { folderId, overwrite: true });
	await clearBitwardenDeletedName(localName);
	recordSecretEvent("secret.stored", { name: localName, providerId: "bitwarden" });
}

function canonicalBitwardenDeletedName(name: string): string {
	return buildBitwardenManagedSecretName(parseLocalSecretName(name));
}

async function readBitwardenDeletedNames(): Promise<Set<string>> {
	try {
		const parsed = JSON.parse(await getLocalSecretValue(BITWARDEN_DELETED_NAMES_SECRET));
		return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
	} catch {
		return new Set();
	}
}

async function writeBitwardenDeletedNames(names: Set<string>): Promise<void> {
	if (names.size === 0) {
		await deleteLocalSecretCore(BITWARDEN_DELETED_NAMES_SECRET);
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
		const token = await getLocalSecretValue(ONEPASSWORD_SERVICE_ACCOUNT_SECRET);
		return readOnePasswordReference(name, token);
	}

	if (isBitwardenReference(name)) {
		const session = await getLocalSecretValue(BITWARDEN_SESSION_SECRET);
		return readBitwardenReference(name, session);
	}

	const localName = parseLocalSecretName(name);
	if (isInternalSecretName(localName)) {
		return getLocalSecretValue(localName);
	}
	if (await isBitwardenProviderActive()) {
		try {
			const session = await getLocalSecretValue(BITWARDEN_SESSION_SECRET);
			return readBitwardenReference(
				`bw://name/${encodeURIComponent(buildBitwardenManagedSecretName(localName))}`,
				session,
			);
		} catch (error) {
			if (!hasLocalSecret(localName) || (await isBitwardenDeletedName(localName))) throw error;
		}
	}

	return getLocalSecretValue(localName);
}

// TTL cache for listSecrets — avoids Bitwarden round-trips on every session start.
let cachedSecretNames: string[] | null = null;
let cachedSecretAt = 0;
const SECRET_CACHE_TTL_MS = 60_000;

export function invalidateSecretsCache(): void {
	cachedSecretNames = null;
	cachedSecretAt = 0;
}

export async function listSecrets(): Promise<string[]> {
	const now = Date.now();
	if (cachedSecretNames !== null && now - cachedSecretAt < SECRET_CACHE_TTL_MS) {
		return cachedSecretNames;
	}

	const localNames = listLocalSecretNames({ includeInternal: false });
	if (!(await isBitwardenProviderActive())) {
		recordSecretEvent("secret.listed", { count: localNames.length });
		cachedSecretNames = localNames;
		cachedSecretAt = now;
		return localNames;
	}

	const deletedNames = await readBitwardenDeletedNames();
	const visibleLocalNames = localNames.filter((name) => !deletedNames.has(canonicalBitwardenDeletedName(name)));
	try {
		const session = await getLocalSecretValue(BITWARDEN_SESSION_SECRET);
		const bitwardenNames = await listBitwardenSecretNames(session);
		const names = Array.from(new Set([...bitwardenNames, ...visibleLocalNames])).sort((a, b) => a.localeCompare(b));
		recordSecretEvent("secret.listed", { count: names.length, providerId: "bitwarden" });
		cachedSecretNames = names;
		cachedSecretAt = now;
		return names;
	} catch {
		recordSecretEvent("secret.listed", {
			count: visibleLocalNames.length,
			providerId: "local",
			degradedProviderId: "bitwarden",
		});
		// Don't cache degraded results — Bitwarden may recover
		return visibleLocalNames;
	}
}

export async function deleteSecret(name: string): Promise<boolean> {
	invalidateSecretsCache();
	return deleteLocalSecretCore(name);
}

export async function deleteSecretFromActiveProvider(name: string): Promise<boolean> {
	invalidateSecretsCache();
	const explicitLocal = name.startsWith("local://");
	const localName = parseLocalSecretName(name);
	if (explicitLocal || isInternalSecretName(localName) || !(await isBitwardenProviderActive())) {
		return deleteLocalSecretCore(localName);
	}

	const session = await getLocalSecretValue(BITWARDEN_SESSION_SECRET);
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

export async function deleteLocalSecretForMigration(name: string): Promise<boolean> {
	return deleteLocalSecretCore(name);
}

export async function setActiveSecretProvider(provider: "local" | "bitwarden"): Promise<void> {
	if (provider === "local") {
		await deleteLocalSecretCore(BITWARDEN_ACTIVE_PROVIDER_SECRET);
		return;
	}
	await putLocalSecret(BITWARDEN_ACTIVE_PROVIDER_SECRET, "bitwarden");
}

export async function getActiveSecretProvider(): Promise<"local" | "bitwarden"> {
	return (await isBitwardenProviderActive()) ? "bitwarden" : "local";
}

async function isBitwardenProviderActive(): Promise<boolean> {
	try {
		return isBitwardenActiveProvider(await getLocalSecretValue(BITWARDEN_ACTIVE_PROVIDER_SECRET));
	} catch {
		return false;
	}
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
