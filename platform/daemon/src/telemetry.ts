/**
 * Anonymous, opt-in telemetry collector for the Signet daemon.
 *
 * Records events to an in-memory buffer, periodically flushing to
 * SQLite (always) and a self-hosted PostHog instance (when configured).
 * No memory content, user identity, or file paths are ever included.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type AccountingProvenance,
	type PipelineTelemetryConfig,
	TELEMETRY_DEPLOYMENT_ROLES,
	TELEMETRY_INSTALL_CHANNELS,
	type TelemetryDeploymentRole,
	type TelemetryInstallChannel,
	summarizeAccountingProvenance,
} from "@signet/core";
import type { DbAccessor } from "./db-accessor";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Open telemetry log (issue #1026 Phase 2)
// ---------------------------------------------------------------------------

/**
 * Default location of the open telemetry log: one JSON line per recorded
 * event, so users can inspect exactly what was sent. Configurable via
 * `telemetryLogPath` on the collector; derived from the agents base path.
 */
export function defaultTelemetryLogPath(agentsDir: string): string {
	return join(agentsDir, ".daemon", "telemetry", "events.jsonl");
}

/** Parse both ISO timestamps and SQLite's UTC `CURRENT_TIMESTAMP` format. */
export function parseTelemetryTimestamp(timestamp: string): number {
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(timestamp)
		? `${timestamp.replace(" ", "T")}Z`
		: timestamp;
	return Date.parse(normalized);
}

export const TELEMETRY_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const TELEMETRY_LOG_MAX_ROTATED_FILES = 5;
export const TELEMETRY_LOG_RETENTION_DAYS = 90;
const MAX_PENDING_LOG_LINES = 1_000;

let telemetryLogRotationSequence = 0;

interface TelemetryLogOptions {
	readonly maxBytes: number;
	readonly maxRotatedFiles: number;
	readonly retentionDays: number;
}

function rotatedTelemetryLogPrefix(logPath: string): string {
	return `${logPath.slice(0, -".jsonl".length)}.`;
}

async function cleanupTelemetryLog(logPath: string, options: TelemetryLogOptions): Promise<void> {
	const directory = dirname(logPath);
	const basename = logPath.slice(directory.length + 1);
	const prefix = rotatedTelemetryLogPrefix(basename);
	let entries: string[];
	try {
		entries = (await readdir(directory)).filter((entry) => entry.startsWith(prefix) && entry.endsWith(".jsonl"));
	} catch {
		return;
	}

	const cutoff = Date.now() - options.retentionDays * 24 * 60 * 60 * 1_000;
	const rotated: Array<{ readonly path: string; readonly mtimeMs: number }> = [];
	for (const entry of entries) {
		const path = join(directory, entry);
		try {
			const metadata = await stat(path);
			if (metadata.mtimeMs < cutoff) {
				await unlink(path);
				continue;
			}
			rotated.push({ path, mtimeMs: metadata.mtimeMs });
		} catch {
			// Another cleanup or operator action may remove a rotated file first.
		}
	}

	rotated.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
	for (const entry of rotated.slice(Math.max(0, options.maxRotatedFiles))) {
		try {
			await unlink(entry.path);
		} catch {
			// Best effort retention cleanup.
		}
	}
}

async function appendToTelemetryLog(
	logPath: string | null,
	lines: readonly string[],
	options: TelemetryLogOptions,
): Promise<number> {
	if (!logPath) return 0;
	let dropped = 0;
	try {
		await mkdir(dirname(logPath), { recursive: true });
	} catch (error) {
		// The whole batch is undeliverable when its parent cannot be prepared.
		// Count it explicitly rather than silently losing the lines removed from
		// the pending queue. Telemetry must never break the daemon.
		logger.warn("telemetry", "Failed to prepare JSONL audit log", {
			dropped: lines.length,
			error: error instanceof Error ? error.message : String(error),
		});
		return lines.length;
	}

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line === undefined) continue;
		const payload = `${line}\n`;
		if (Buffer.byteLength(payload) > options.maxBytes) {
			dropped++;
			continue;
		}
		try {
			let currentSize = 0;
			try {
				currentSize = (await stat(logPath)).size;
			} catch (error) {
				if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") {
					throw error;
				}
			}
			if (currentSize > 0 && currentSize + Buffer.byteLength(payload) > options.maxBytes) {
				const rotatedPath = `${rotatedTelemetryLogPrefix(logPath)}${Date.now()}-${telemetryLogRotationSequence++}.jsonl`;
				await rename(logPath, rotatedPath);
			}
			await appendFile(logPath, payload, "utf-8");
		} catch (error) {
			// Do not continue past a failed write or rotation. Writing a later line
			// would make the JSONL appear reordered relative to this batch. The
			// failed line and all following lines are dropped and reported together.
			const remaining = lines.length - index;
			dropped += remaining;
			logger.warn("telemetry", "Dropped JSONL audit events after write failure", {
				dropped: remaining,
				error: error instanceof Error ? error.message : String(error),
			});
			break;
		}
	}

	await cleanupTelemetryLog(logPath, options);
	return dropped;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export const TELEMETRY_EVENTS = [
	"llm.generate",
	"pipeline.extraction",
	"pipeline.decision",
	"pipeline.embedding",
	"pipeline.error",
	"pipeline.operation",
	"inference.route",
	"inference.execute",
	"inference.stream",
	"inference.fallback",
	"session.start",
	// Per non-boundary session-end hook call — a "turns persisted" counter
	// (harness activity volume), distinct from the real session boundary event.
	"session.turn",
	// Fired only at actual session boundaries (recognized lifecycle reason or
	// TTL eviction), dedup'd once per session lifetime (#1212/#1231).
	"session.end",
	"daemon.heartbeat",
	"telemetry.health",
	// Lifecycle events (issue #1026 Phase 2): fired when the user has opted
	// into anonymous telemetry. No PII, no code, no memory content.
	"daemon.started",
	"daemon.previous_exit",
	"install.activated",
	// First-use milestones (issue #1202): fired exactly once per install,
	// at the first successful remember / recall. Guards the activation
	// funnel (install.activated -> first.remember/recall) so "activated"
	// stops including installs that never did anything.
	"first.remember",
	"first.recall",
	"dreaming.pass",
	"command.invoked",
	"error.occurred",
	"version.upgraded",
	// Observed at daemon start; unlike version.upgraded, this makes no claim
	// about the mechanism that changed the installed version.
	"version.observed",
	// Cloud events (issue #1207): declared now so the future cloud-connect
	// layer inherits the typed contract instead of retrofitting it. Nothing
	// emits them until the Signet Cloud surface exists. Same anonymous
	// contract — no credentials, account identifiers, or content.
	"cloud.connect_attempt",
	"cloud.sync",
	"cloud.storage",
	"recall.performed",
	// Retrieval-outcome contract (#1277): attempt and delivery are separate
	// boundaries so search execution cannot be mistaken for delivered context.
	"recall.attempted",
	"recall.outcome",
	"source.lifecycle",
	"config.snapshot",
] as const;

export type TelemetryEventType = (typeof TELEMETRY_EVENTS)[number];

/**
 * Which first-use milestone to claim. Each fires at most once per
 * install, persisted on the telemetry_install row (migration 111).
 */
export type FirstUseKind = "remember" | "recall";

export type TelemetryProperties = Readonly<Record<string, string | number | boolean | null>>;

export interface TelemetryConfigSnapshot {
	readonly graphEnabled: boolean;
	readonly rerankerEnabled: boolean;
	readonly autonomousEnabled: boolean;
	readonly semanticContradictionEnabled: boolean;
	readonly embeddingProvider: string;
	readonly embeddingModel: string;
	/** Configuration-derived execution locality. Unknown is never coerced to local. */
	readonly inferenceMode: "local" | "remote" | "unknown";
	readonly harnesses: string;
}

export interface TelemetryEvent {
	readonly id: string;
	readonly event: TelemetryEventType;
	readonly timestamp: string;
	readonly properties: TelemetryProperties;
}

export type TelemetryDeliveryStatus = "healthy" | "degraded" | "local-only";

/** Aggregate collector state safe for local diagnostics and PostHog. */
export interface TelemetryDeliveryHealth {
	readonly status: TelemetryDeliveryStatus;
	readonly deliveryConfigured: boolean;
	readonly bufferedEventCount: number;
	readonly queuedUnsentEventCount: number;
	readonly oldestUnsentEventAgeSec: number | null;
	readonly lastDaemonEventAgeSec: number | null;
	readonly lastAttemptAgeSec: number | null;
	readonly lastSuccessfulDeliveryAgeSec: number | null;
	readonly recentDeliverySuccessCount: number;
	readonly recentDeliveryFailureCount: number;
	readonly consecutiveFailures: number;
	readonly backoffActive: boolean;
	readonly droppedEventCount: number;
	readonly flushIntervalMs: number;
}

interface SessionCostAccumulator {
	tokensInput: number;
	tokensOutput: number;
	tokensCacheRead: number;
	tokensCacheWrite: number;
	cost: number;
	provenances: AccountingProvenance[];
}

const MAX_ACTIVE_SESSIONS = 1024;

function emptySessionCost(): SessionCostAccumulator {
	return {
		tokensInput: 0,
		tokensOutput: 0,
		tokensCacheRead: 0,
		tokensCacheWrite: 0,
		cost: 0,
		provenances: [],
	};
}

function addNumber(target: number, value: string | number | boolean | null | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? target + value : target;
}

function accountingProvenance(value: unknown): AccountingProvenance {
	return value === "provider_reported" ||
		value === "locally_estimated" ||
		value === "configured_rate" ||
		value === "local_zero_cost"
		? value
		: "unavailable";
}

function addEventCost(
	accumulator: SessionCostAccumulator,
	event: TelemetryEventType,
	properties: TelemetryProperties,
): void {
	accumulator.provenances.push(accountingProvenance(properties.accountingProvenance));
	if (event === "llm.generate") {
		accumulator.tokensInput = addNumber(accumulator.tokensInput, properties.inputTokens);
		accumulator.tokensOutput = addNumber(accumulator.tokensOutput, properties.outputTokens);
		accumulator.tokensCacheRead = addNumber(accumulator.tokensCacheRead, properties.cacheReadTokens);
		accumulator.tokensCacheWrite = addNumber(accumulator.tokensCacheWrite, properties.cacheCreationTokens);
		accumulator.cost = addNumber(accumulator.cost, properties.totalCost);
		return;
	}
	if (event === "dreaming.pass") {
		accumulator.tokensInput = addNumber(accumulator.tokensInput, properties.tokensInput);
		accumulator.tokensOutput = addNumber(accumulator.tokensOutput, properties.tokensOutput);
		accumulator.tokensCacheRead = addNumber(accumulator.tokensCacheRead, properties.tokensCacheRead);
		accumulator.tokensCacheWrite = addNumber(accumulator.tokensCacheWrite, properties.tokensCacheWrite);
		accumulator.cost = addNumber(accumulator.cost, properties.cost);
		return;
	}
	if (event === "pipeline.embedding") {
		accumulator.tokensInput = addNumber(accumulator.tokensInput, properties.tokens);
		accumulator.cost = addNumber(accumulator.cost, properties.cost);
	}
}

function sessionCostProperties(cost: SessionCostAccumulator): TelemetryProperties {
	return {
		tokensInput: cost.tokensInput,
		tokensOutput: cost.tokensOutput,
		tokensCacheRead: cost.tokensCacheRead,
		tokensCacheWrite: cost.tokensCacheWrite,
		cost: cost.cost,
		accountingProvenance: summarizeAccountingProvenance(cost.provenances),
	};
}

// ---------------------------------------------------------------------------
// Collector interface
// ---------------------------------------------------------------------------

export interface TelemetryCollector {
	record(event: TelemetryEventType, properties: TelemetryProperties): void;
	/**
	 * Record with a bounded asynchronous JSONL audit append while deferring
	 * SQLite persistence. The local line is best effort and may be dropped
	 * under pressure; drops are included in delivery health.
	 */
	recordDeferred?(event: TelemetryEventType, properties: TelemetryProperties): void;
	reopenSession(sessionHash: string): void;

	/**
	 * Claim a one-shot first-use milestone (issue #1202). Emits
	 * first.remember / first.recall only when this call wins the claim
	 * for this install — later calls are silent no-ops.
	 */
	recordFirstUse(kind: FirstUseKind): void;

	flush(): Promise<void>;
	deliveryHealth(): TelemetryDeliveryHealth;
	start(): void;
	stop(): Promise<void>;
	/** Discard buffered and unsent events when the user opts out. */
	discardPending?(): Promise<void>;

	query(opts?: {
		event?: TelemetryEventType;
		since?: string;
		until?: string;
		limit?: number;
	}): Promise<readonly TelemetryEvent[]>;

	readonly enabled: boolean;

	/**
	 * Hash an agent id with the per-install id so inference telemetry never
	 * carries the raw agent name: stable within an install, not joinable
	 * across installs, not reversible. Returns "" when no install id exists.
	 */
	anonymizeAgentId(agentId: string): string;
}

// ---------------------------------------------------------------------------
// Active collector reference
// ---------------------------------------------------------------------------
// Mirrored here by the daemon for pipeline and hooks layers, which are not
// route modules and therefore don't read the route-layer ref in routes/state.

let activeCollector: TelemetryCollector | undefined;

export function setActiveTelemetry(collector: TelemetryCollector | undefined): void {
	activeCollector = collector;
}

/** Stop recording immediately when the persisted telemetry opt-out changes. */
export async function stopActiveTelemetry(): Promise<void> {
	const collector = activeCollector;
	activeCollector = undefined;
	if (collector?.discardPending) {
		await collector.discardPending();
	} else if (collector) {
		await collector.stop();
	}
}

export function getActiveTelemetry(): TelemetryCollector | undefined {
	return activeCollector;
}

/**
 * True when the process environment disables telemetry. The same
 * SIGNET_TELEMETRY_OPTOUT knob the install ping honors (issue #1026) so one
 * switch opts a whole machine or CI runner out — without touching config.
 */
export function telemetryDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.SIGNET_TELEMETRY_OPTOUT === "1" || env.SIGNET_TELEMETRY_OPTOUT === "true";
}

export type TelemetryDeployment = "dev";

/**
 * Resolve the optional deployment marker used to separate operator-owned
 * development checkouts from production installs in PostHog.
 */
export function telemetryDeployment(env: NodeJS.ProcessEnv = process.env): TelemetryDeployment | undefined {
	return env.SIGNET_TELEMETRY_ENV?.trim().toLowerCase() === "dev" ? "dev" : undefined;
}

function validTelemetryValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	return typeof value === "string" && (allowed as readonly string[]).includes(value.trim().toLowerCase())
		? (value.trim().toLowerCase() as T)
		: undefined;
}

/**
 * Resolve a bounded deployment declaration. The dev marker remains a
 * compatible shorthand for the existing development-fleet behavior. No
 * paths, process names, repository names, or network data participate.
 */
export function telemetryDeploymentRole(
	configured: TelemetryDeploymentRole | undefined,
	env: NodeJS.ProcessEnv = process.env,
): TelemetryDeploymentRole {
	if (telemetryDeployment(env) === "dev") return "development";
	return (
		validTelemetryValue(env.SIGNET_TELEMETRY_DEPLOYMENT_ROLE, TELEMETRY_DEPLOYMENT_ROLES) ??
		validTelemetryValue(configured, TELEMETRY_DEPLOYMENT_ROLES) ??
		"unknown"
	);
}

/** Resolve installation provenance only from an explicit config or env value. */
export function telemetryInstallChannel(
	configured: TelemetryInstallChannel | undefined,
	env: NodeJS.ProcessEnv = process.env,
): TelemetryInstallChannel {
	return (
		validTelemetryValue(env.SIGNET_TELEMETRY_INSTALL_CHANNEL, TELEMETRY_INSTALL_CHANNELS) ??
		validTelemetryValue(configured, TELEMETRY_INSTALL_CHANNELS) ??
		"unknown"
	);
}

/**
 * Keep development builds visible in version breakdowns without changing the
 * daemon's operational version or update behavior.
 */
export function telemetryReportedVersion(version: string, deployment: TelemetryDeployment | undefined): string {
	if (deployment !== "dev" || version.endsWith("-dev")) return version;
	return `${version}-dev`;
}

/**
 * Resolve the anonymous per-install identifier, creating and persisting it on
 * first use. Falls back to an in-memory id if the database is unusable.
 * A truthy guard is required here: bun:sqlite returns null for a missing row
 * while better-sqlite3 returns undefined (dual-DB daemon).
 *
 * `created` is true only when the id was actually inserted — the daemon uses
 * it to emit install.activated (the true first-run signal that covers bun,
 * desktop, and npm installs alike; the wrapper postinstall ping misses bun
 * and desktop entirely).
 */
type InstallIdentity = { readonly id: string; readonly created: boolean; readonly previousVersion?: string };
type DeferredInstallIdentity = InstallIdentity & { readonly ready?: Promise<InstallIdentity> };

function resolveInstallIdentity(w: import("./db-accessor").WriteDb, daemonVersion: string): InstallIdentity {
	const existing = w
		.prepare("SELECT id, last_seen_version FROM telemetry_install ORDER BY created_at ASC LIMIT 1")
		.get() as { readonly id: string; readonly last_seen_version?: string | null } | null | undefined;
	if (existing?.id) {
		if (!existing.last_seen_version) {
			w.prepare("UPDATE telemetry_install SET last_seen_version = ? WHERE id = ?").run(daemonVersion, existing.id);
		}
		return {
			id: existing.id,
			created: false,
			...(existing.last_seen_version ? { previousVersion: existing.last_seen_version } : {}),
		};
	}
	const id = crypto.randomUUID();
	const result = w
		.prepare("INSERT OR IGNORE INTO telemetry_install (id, created_at, last_seen_version) VALUES (?, ?, ?)")
		.run(id, new Date().toISOString(), daemonVersion);
	if (result.changes > 0) return { id, created: true };
	const inserted = w
		.prepare("SELECT id, last_seen_version FROM telemetry_install ORDER BY created_at ASC LIMIT 1")
		.get() as { readonly id: string; readonly last_seen_version?: string | null } | null | undefined;
	return inserted?.id
		? {
				id: inserted.id,
				created: false,
				...(inserted.last_seen_version ? { previousVersion: inserted.last_seen_version } : {}),
			}
		: { id, created: false };
}

function resolveLegacyInstallIdentity(w: import("./db-accessor").WriteDb): InstallIdentity {
	const existing = w.prepare("SELECT id FROM telemetry_install ORDER BY created_at ASC LIMIT 1").get() as
		| { readonly id: string }
		| null
		| undefined;
	if (existing?.id) return { id: existing.id, created: false };
	const id = crypto.randomUUID();
	const result = w
		.prepare("INSERT OR IGNORE INTO telemetry_install (id, created_at) VALUES (?, ?)")
		.run(id, new Date().toISOString());
	if (result.changes > 0) return { id, created: true };
	const inserted = w.prepare("SELECT id FROM telemetry_install ORDER BY created_at ASC LIMIT 1").get() as
		| { readonly id: string }
		| null
		| undefined;
	return inserted?.id ? { id: inserted.id, created: false } : { id, created: false };
}

function getOrCreateInstallId(db: DbAccessor, daemonVersion: string): DeferredInstallIdentity {
	const fallback = { id: crypto.randomUUID(), created: false } as const;
	const withWriteTxAsync = db.withWriteTxAsync;
	if (withWriteTxAsync) {
		const runAsync = <T>(fn: (w: import("./db-accessor").WriteDb) => T): Promise<T> =>
			withWriteTxAsync.call(db, fn) as Promise<T>;
		const ready = runAsync((w) => resolveInstallIdentity(w, daemonVersion))
			.catch(() => runAsync(resolveLegacyInstallIdentity))
			.catch(() => fallback);
		return { ...fallback, ready };
	}
	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
		return db.withWriteTx(
			(w: import("./db-accessor").WriteDb) => resolveInstallIdentity(w, daemonVersion),
			"telemetry.ts:551",
		);
	} catch {
		try {
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
			return db.withWriteTx(
				(w: import("./db-accessor").WriteDb) => resolveLegacyInstallIdentity(w),
				"telemetry.ts:558",
			);
		} catch {
			return fallback;
		}
	}
}

// ---------------------------------------------------------------------------
// Crash diagnostics
// ---------------------------------------------------------------------------
// error.occurred reports are sanitized at the boundary: the message is
// truncated and stripped of user paths, the stack keeps only the top frames
// with home directories removed, and no memory content is ever captured.
// Enough to reproduce and fix a crash remotely, nothing to leak.

const MAX_CRASH_MESSAGE_CHARS = 400;
const MAX_CRASH_STACK_FRAMES = 8;

const HOME_PATH_PATTERNS = [/\/home\/[^/\s]+/g, /\/Users\/[^/\s]+/g];

function stripUserPaths(text: string): string {
	let out = text;
	for (const pattern of HOME_PATH_PATTERNS) {
		out = out.replace(pattern, "~");
	}
	return out;
}

function sanitizeCrashText(value: string): string {
	const cleaned = Array.from(value, (char) => {
		const code = char.charCodeAt(0);
		return code <= 0x1f || code === 0x7f ? " " : char;
	}).join("");
	return stripUserPaths(cleaned).slice(0, MAX_CRASH_MESSAGE_CHARS);
}

function crashStackFrames(stack: string | undefined): string[] | undefined {
	if (!stack) return undefined;
	return stack
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => stripUserPaths(line))
		.slice(0, MAX_CRASH_STACK_FRAMES);
}

/**
 * Build the sanitized error.occurred properties for a process-level crash.
 * Non-Error reasons (unhandledRejection with a primitive) degrade to a
 * truncated string.
 */
export function sanitizeCrashError(error: unknown, uptimeMs: number): TelemetryProperties {
	const uptime = Math.round(uptimeMs);
	if (error instanceof Error) {
		const stack = crashStackFrames(error.stack);
		return {
			type: error.name || "Error",
			message: sanitizeCrashText(error.message || String(error)),
			...(stack ? { stack: stack.join("\n") } : {}),
			uptimeMs: uptime,
		};
	}
	return {
		type: "UnhandledRejection",
		message: sanitizeCrashText(String(error)),
		uptimeMs: uptime,
	};
}

// ---------------------------------------------------------------------------
// PostHog batch sender
// ---------------------------------------------------------------------------

interface PostHogBatchEvent {
	readonly event: string;
	readonly distinct_id: string;
	readonly timestamp: string;
	readonly properties: Record<string, string | number | boolean | null>;
}

interface PostHogDeliveryResult {
	readonly ok: boolean;
	readonly failureCode?: "http" | "timeout" | "network";
}

interface TelemetryDeliveryState {
	readonly windowStartedAt: string;
	readonly successCount: number;
	readonly failureCount: number;
	readonly consecutiveFailures: number;
	readonly lastAttemptAt: string | null;
	readonly lastSuccessAt: string | null;
	readonly lastFailureCode: string | null;
	readonly droppedEventCount: number;
}

interface ClaimedTelemetryEvents {
	readonly token: string;
	readonly events: readonly TelemetryEvent[];
}

const MAX_BUFFER_SIZE = 200;
const MAX_BUFFER_EVENTS = 5000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_MULTIPLIER = 5;
const PRUNE_EVERY_N_FLUSHES = 10;
const TELEMETRY_CLAIM_TIMEOUT_MS = 10 * 60 * 1_000;
const DELIVERY_HEALTH_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_HEALTH_FAILURE_CODE_LENGTH = 24;
const MAX_PERSISTED_QUEUE_EVENTS = 20_000;

/**
 * Interval used after `failures` consecutive PostHog failures. Pure so the
 * backoff behavior is testable without driving timers.
 */
export function nextFlushIntervalMs(baseIntervalMs: number, consecutiveFailures: number): number {
	return consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? baseIntervalMs * BACKOFF_MULTIPLIER : baseIntervalMs;
}

async function sendToPostHog(
	host: string,
	apiKey: string,
	distinctId: string,
	events: readonly TelemetryEvent[],
	daemonVersion: string,
	signal?: AbortSignal,
): Promise<PostHogDeliveryResult> {
	const batch: readonly PostHogBatchEvent[] = events.map((e) => ({
		event: e.event,
		distinct_id: distinctId,
		timestamp: e.timestamp,
		properties: {
			...e.properties,
			$insert_id: e.id,
			$lib: "signet-daemon",
			$lib_version: daemonVersion,
		},
	}));

	try {
		const res = await fetch(`${host}/batch/`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ api_key: apiKey, batch }),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
		});
		return res.ok ? { ok: true } : { ok: false, failureCode: "http" };
	} catch (error) {
		return {
			ok: false,
			failureCode: error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network",
		};
	}
}

// ---------------------------------------------------------------------------
// First-use milestones (issue #1202)
// ---------------------------------------------------------------------------

/**
 * telemetry_install column that records the first-use timestamp for each
 * kind. Fixed internal map — the column name is interpolated into SQL,
 * so it must never accept caller input.
 */
const FIRST_USE_COLUMNS: Readonly<Record<FirstUseKind, string>> = {
	remember: "first_remember_at",
	recall: "first_recall_at",
};

const FIRST_USE_EVENTS: Readonly<Record<FirstUseKind, TelemetryEventType>> = {
	remember: "first.remember",
	recall: "first.recall",
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTelemetryCollector(
	db: DbAccessor,
	config: PipelineTelemetryConfig,
	daemonVersion: string,
	opts: {
		readonly telemetryLogPath?: string | null;
		readonly telemetryLogMaxBytes?: number;
		readonly telemetryLogMaxRotatedFiles?: number;
		readonly telemetryLogRetentionDays?: number;
		readonly configSnapshot?: TelemetryConfigSnapshot;
		readonly env?: NodeJS.ProcessEnv;
	} = {},
): TelemetryCollector {
	const buffer: TelemetryEvent[] = [];
	const logPath = opts.telemetryLogPath ?? null;
	const logOptions: TelemetryLogOptions = {
		maxBytes: opts.telemetryLogMaxBytes ?? TELEMETRY_LOG_MAX_BYTES,
		maxRotatedFiles: opts.telemetryLogMaxRotatedFiles ?? TELEMETRY_LOG_MAX_ROTATED_FILES,
		retentionDays: opts.telemetryLogRetentionDays ?? TELEMETRY_LOG_RETENTION_DAYS,
	};
	const pendingLogLines: string[] = [];
	let logFlushPromise: Promise<void> | null = null;

	function flushLog(): Promise<void> {
		if (!logPath || logFlushPromise) return logFlushPromise ?? Promise.resolve();
		logFlushPromise = (async () => {
			while (pendingLogLines.length > 0) {
				const lines = pendingLogLines.splice(0, MAX_PENDING_LOG_LINES);
				const dropped = await appendToTelemetryLog(logPath, lines, logOptions);
				if (dropped > 0) recordDroppedEvents(dropped);
			}
		})()
			.catch(() => {})
			.finally(() => {
				logFlushPromise = null;
			});
		return logFlushPromise;
	}

	function queueLogLine(event: TelemetryEvent): void {
		if (!logPath) return;
		if (pendingLogLines.length >= MAX_PENDING_LOG_LINES) {
			pendingLogLines.shift();
			recordDroppedEvents(1);
		}
		pendingLogLines.push(JSON.stringify(event));
		void flushLog();
	}
	const deployment = telemetryDeployment(opts.env);
	const reportedVersion = telemetryReportedVersion(daemonVersion, deployment);
	const deploymentRole = telemetryDeploymentRole(config.deploymentRole, opts.env);
	const installChannel = telemetryInstallChannel(config.installChannel, opts.env);
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	let flushAbortController: AbortController | null = null;
	let recordingStopped = false;
	let consecutiveFailures = 0;
	let flushCount = 0;
	let effectiveIntervalMs = config.flushIntervalMs;
	let nextAllowedFlushAt = 0;
	let droppedEventCount = 0;
	let pendingDroppedEventCount = 0;
	let flushPromise: Promise<void> | null = null;
	let installLifecycleReady = Promise.resolve();
	const pendingAsyncWrites = new Set<Promise<void>>();
	let deliveryStatePersistenceFailed = false;
	let deliveryState: TelemetryDeliveryState = {
		windowStartedAt: new Date().toISOString(),
		successCount: 0,
		failureCount: 0,
		consecutiveFailures: 0,
		lastAttemptAt: null,
		lastSuccessAt: null,
		lastFailureCode: null,
		droppedEventCount: 0,
	};
	let persistedQueueCount = 0;
	let persistedOldestTimestamp: string | null = null;
	let lastDaemonEventTimestamp: string | null = null;
	const installIdentity = getOrCreateInstallId(db, daemonVersion);
	let installId = installIdentity.id;
	let installActivated = installIdentity.created;
	let previousVersion = installIdentity.previousVersion;

	const posthogConfigured = config.posthogHost.length > 0 && config.posthogApiKey.length > 0;

	async function readDeliveryState(): Promise<TelemetryDeliveryState> {
		try {
			const row = await db.withReadDbAsync(
				async (r) =>
					r
						.prepare(
							`SELECT window_started_at AS windowStartedAt,
							success_count AS successCount, failure_count AS failureCount,
							consecutive_failures AS consecutiveFailures,
							last_attempt_at AS lastAttemptAt, last_success_at AS lastSuccessAt,
							last_failure_code AS lastFailureCode,
							dropped_event_count AS droppedEventCount
					 FROM telemetry_delivery_state WHERE id = 1`,
						)
						.get() as TelemetryDeliveryState | undefined,
			{ siteToken: "telemetry.ts:827" });
			if (row) {
				droppedEventCount = Math.max(droppedEventCount, row.droppedEventCount ?? 0);
				return row;
			}
		} catch {
			// Test doubles and pre-migration workspaces fall back to in-memory state.
			deliveryStatePersistenceFailed = true;
		}
		return {
			windowStartedAt: new Date().toISOString(),
			successCount: 0,
			failureCount: 0,
			consecutiveFailures,
			lastAttemptAt: null,
			lastSuccessAt: null,
			lastFailureCode: null,
			droppedEventCount,
		};
	}

	async function refreshPersistedQueue(): Promise<void> {
		try {
			const queue = await db.withReadDbAsync(async (r) => {
				const pending = r
					.prepare(
						`SELECT COUNT(*) AS count, MIN(timestamp) AS oldestTimestamp
						 FROM telemetry_events WHERE source = 'daemon' AND sent_to_posthog = 0`,
					)
					.get() as { count?: number; oldestTimestamp?: string | null } | undefined;
				const latest = r
					.prepare(
						"SELECT MAX(timestamp) AS timestamp FROM telemetry_events WHERE source = 'daemon' AND event <> 'telemetry.health'",
					)
					.get() as { timestamp?: string | null } | undefined;
				return {
					count: pending?.count ?? 0,
					oldestTimestamp: pending?.oldestTimestamp ?? null,
					lastTimestamp: latest?.timestamp ?? null,
				};
			}, { siteToken: "telemetry.ts:863" });
			persistedQueueCount = queue.count;
			persistedOldestTimestamp = queue.oldestTimestamp;
			lastDaemonEventTimestamp = queue.lastTimestamp;
		} catch {
			// Keep local in-memory health available when SQLite is unavailable.
		}
	}

	function trackAsyncWrite(work: Promise<void>): void {
		pendingAsyncWrites.add(work);
		void work.finally(() => pendingAsyncWrites.delete(work));
	}

	async function awaitPendingAsyncWrites(): Promise<void> {
		if (pendingAsyncWrites.size === 0) return;
		await Promise.all([...pendingAsyncWrites]);
	}

	function recordDroppedEvents(count: number): void {
		droppedEventCount += count;
		pendingDroppedEventCount += count;
	}

	function persistPendingDroppedEvents(w: { prepare(sql: string): { run(...args: unknown[]): unknown } }): void {
		if (pendingDroppedEventCount === 0) return;
		w.prepare(
			`UPDATE telemetry_delivery_state
			 SET dropped_event_count = dropped_event_count + ? WHERE id = 1`,
		).run(pendingDroppedEventCount);
		pendingDroppedEventCount = 0;
	}

	const deliveryStateReady = readDeliveryState().then((state) => {
		deliveryState = state;
		consecutiveFailures = state.consecutiveFailures;
		effectiveIntervalMs = nextFlushIntervalMs(config.flushIntervalMs, consecutiveFailures);
		const lastAttemptMs = state.lastAttemptAt ? parseTelemetryTimestamp(state.lastAttemptAt) : Number.NaN;
		if (Number.isFinite(lastAttemptMs)) nextAllowedFlushAt = lastAttemptMs + effectiveIntervalMs;
	});
	void refreshPersistedQueue();

	/**
	 * Claim and persist a first-use event in one transaction. Only the first
	 * caller wins (changes === 1); every later call is a no-op, so concurrent
	 * remembers cannot double-fire. Keeping the event in the same transaction
	 * as the claim means a process can be terminated before the normal buffer
	 * flush without losing the milestone.
	 *
	 * When the install id fell back to an in-memory value (broken DB), the
	 * UPDATE matches no row and the milestone never fires. Telemetry is
	 * degraded anyway.
	 */
	async function persistFirstUse(kind: FirstUseKind): Promise<TelemetryEvent | null> {
		const event: TelemetryEvent = {
			id: crypto.randomUUID(),
			event: FIRST_USE_EVENTS[kind],
			timestamp: new Date().toISOString(),
			properties: addContext(FIRST_USE_EVENTS[kind], {
				version: daemonVersion,
				platform: process.platform,
			}),
		};

		try {
			const withWriteTxAsync = db.withWriteTxAsync;
			if (!withWriteTxAsync) return null;
			const column = FIRST_USE_COLUMNS[kind];
			let claimed = false;
			await withWriteTxAsync((w) => {
				const result = w
					.prepare(
						`UPDATE telemetry_install SET ${column} = ?
						 WHERE id = ? AND ${column} IS NULL`,
					)
					.run(event.timestamp, installId);
				if (result.changes === 0) return;

				w.prepare(
					`INSERT INTO telemetry_events
					 (id, event, timestamp, properties, sent_to_posthog, created_at, source)
					 VALUES (?, ?, ?, ?, 0, ?, 'daemon')`,
				).run(event.id, event.event, event.timestamp, JSON.stringify(event.properties), event.timestamp);
				claimed = true;
			});
			return claimed ? event : null;
		} catch {
			// The transaction rolls back both the claim and event on any
			// failure, allowing a later successful call to retry the milestone.
			return null;
		}
	}

	function addContext(event: TelemetryEventType, properties: TelemetryProperties): TelemetryProperties {
		return {
			...properties,
			deploymentRole,
			installChannel,
			...(deployment ? { deployment } : {}),
			...(typeof properties.version === "string"
				? { version: telemetryReportedVersion(properties.version, deployment) }
				: {}),
			...(typeof properties.from === "string"
				? {
						from:
							event === "version.observed" ? properties.from : telemetryReportedVersion(properties.from, deployment),
					}
				: {}),
			...(typeof properties.to === "string" ? { to: telemetryReportedVersion(properties.to, deployment) } : {}),
		};
	}

	async function writeToDb(events: readonly TelemetryEvent[]): Promise<boolean> {
		if (events.length === 0) return true;
		const withWriteTxAsync = db.withWriteTxAsync;
		if (!withWriteTxAsync) return false;
		try {
			await withWriteTxAsync((w) => {
				const stmt = w.prepare(
					`INSERT OR IGNORE INTO telemetry_events
					 (id, event, timestamp, properties, sent_to_posthog, created_at, source)
					 VALUES (?, ?, ?, ?, 0, ?, 'daemon')`,
				);
				const now = new Date().toISOString();
				for (const e of events) {
					stmt.run(e.id, e.event, e.timestamp, JSON.stringify(e.properties), now);
				}
				// Advance the observation marker in the same transaction as the
				// event. A crash before flush therefore repeats the observation
				// instead of losing it permanently.
				if (events.some((event) => event.event === "version.observed")) {
					w.prepare("UPDATE telemetry_install SET last_seen_version = ? WHERE id = ?").run(daemonVersion, installId);
				}
				persistPendingDroppedEvents(w);
				const overflow = w
					.prepare(
						`SELECT COUNT(*) AS count FROM telemetry_events
						 WHERE source = 'daemon' AND sent_to_posthog = 0 AND claim_token IS NULL`,
					)
					.get() as { count?: number } | undefined;
				const dropCount = Math.max(0, (overflow?.count ?? 0) - MAX_PERSISTED_QUEUE_EVENTS);
				if (dropCount > 0) {
					w.prepare(
						`DELETE FROM telemetry_events WHERE id IN (
						 SELECT id FROM telemetry_events
						 WHERE source = 'daemon' AND sent_to_posthog = 0 AND claim_token IS NULL
						 ORDER BY timestamp ASC LIMIT ?
					 )`,
					).run(dropCount);
					w.prepare(
						"UPDATE telemetry_delivery_state SET dropped_event_count = dropped_event_count + ? WHERE id = 1",
					).run(dropCount);
					droppedEventCount += dropCount;
					logger.warn("telemetry", "Persisted telemetry queue reached capacity", {
						dropped: dropCount,
						maxQueueEvents: MAX_PERSISTED_QUEUE_EVENTS,
					});
				}
			});
			return true;
		} catch (err) {
			logger.warn("telemetry", "Failed to write events to db", {
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	async function markSent(token: string): Promise<void> {
		const now = new Date().toISOString();
		let stateUpdated = false;
		try {
			const withWriteTxAsync = db.withWriteTxAsync;
			if (!withWriteTxAsync) throw new Error("async writer unavailable");
			await withWriteTxAsync((w) => {
				w.prepare(
					"UPDATE telemetry_events SET sent_to_posthog = 1, sent_at = ?, claim_token = NULL, claimed_at = NULL WHERE claim_token = ?",
				).run(now, token);
				const row = w.prepare("SELECT id FROM telemetry_delivery_state WHERE id = 1").get();
				if (row) {
					w.prepare(
						`UPDATE telemetry_delivery_state
						 SET success_count = CASE WHEN julianday(?) - julianday(window_started_at) >= ? / 86400000.0 THEN 1 ELSE success_count + 1 END,
						     failure_count = CASE WHEN julianday(?) - julianday(window_started_at) >= ? / 86400000.0 THEN 0 ELSE failure_count END,
						     window_started_at = CASE WHEN julianday(?) - julianday(window_started_at) >= ? / 86400000.0 THEN ? ELSE window_started_at END,
						     consecutive_failures = 0, last_attempt_at = ?, last_success_at = ?, last_failure_code = NULL
						 WHERE id = 1`,
					).run(
						now,
						DELIVERY_HEALTH_WINDOW_MS,
						now,
						DELIVERY_HEALTH_WINDOW_MS,
						now,
						DELIVERY_HEALTH_WINDOW_MS,
						now,
						now,
						now,
					);
					stateUpdated = true;
				}
			});
		} catch {
			// Older/partially migrated workspaces still need the event marked sent
			// after PostHog accepted it; otherwise the claim would be retried.
			try {
				const withWriteTxAsync = db.withWriteTxAsync;
				if (!withWriteTxAsync) throw new Error("async writer unavailable");
				await withWriteTxAsync((w) => {
					w.prepare(
						"UPDATE telemetry_events SET sent_to_posthog = 1, claim_token = NULL, claimed_at = NULL WHERE claim_token = ?",
					).run(token);
				});
			} catch {
				// best effort
			}
		}
		const windowExpired =
			Date.now() - parseTelemetryTimestamp(deliveryState.windowStartedAt) >= DELIVERY_HEALTH_WINDOW_MS;
		deliveryState = {
			...deliveryState,
			windowStartedAt: windowExpired ? now : deliveryState.windowStartedAt,
			successCount: windowExpired ? 1 : deliveryState.successCount + 1,
			failureCount: windowExpired ? 0 : deliveryState.failureCount,
			consecutiveFailures: 0,
			lastAttemptAt: now,
			lastSuccessAt: now,
			lastFailureCode: null,
		};
		deliveryStatePersistenceFailed = !stateUpdated;
		consecutiveFailures = 0;
		effectiveIntervalMs = config.flushIntervalMs;
		nextAllowedFlushAt = 0;
	}

	async function releaseClaim(token: string, failureCode?: string): Promise<void> {
		const now = new Date().toISOString();
		let stateUpdated = false;
		try {
			const withWriteTxAsync = db.withWriteTxAsync;
			if (!withWriteTxAsync) throw new Error("async writer unavailable");
			await withWriteTxAsync((w) => {
				w.prepare(
					"UPDATE telemetry_events SET last_attempt_at = ?, last_failure_code = ?, claim_token = NULL, claimed_at = NULL WHERE claim_token = ?",
				).run(now, failureCode?.slice(0, MAX_HEALTH_FAILURE_CODE_LENGTH) ?? "unknown", token);
				const row = w.prepare("SELECT id FROM telemetry_delivery_state WHERE id = 1").get();
				if (row) {
					w.prepare(
						`UPDATE telemetry_delivery_state
						 SET failure_count = CASE WHEN julianday(?) - julianday(window_started_at) >= ? / 86400000.0 THEN 1 ELSE failure_count + 1 END,
						     success_count = CASE WHEN julianday(?) - julianday(window_started_at) >= ? / 86400000.0 THEN 0 ELSE success_count END,
						     window_started_at = CASE WHEN julianday(?) - julianday(window_started_at) >= ? / 86400000.0 THEN ? ELSE window_started_at END,
						     consecutive_failures = consecutive_failures + 1, last_attempt_at = ?, last_failure_code = ?
						 WHERE id = 1`,
					).run(
						now,
						DELIVERY_HEALTH_WINDOW_MS,
						now,
						DELIVERY_HEALTH_WINDOW_MS,
						now,
						DELIVERY_HEALTH_WINDOW_MS,
						now,
						now,
						failureCode?.slice(0, MAX_HEALTH_FAILURE_CODE_LENGTH) ?? "unknown",
					);
					stateUpdated = true;
				}
			});
		} catch {
			try {
				const withWriteTxAsync = db.withWriteTxAsync;
				if (!withWriteTxAsync) throw new Error("async writer unavailable");
				await withWriteTxAsync((w) => {
					w.prepare("UPDATE telemetry_events SET claim_token = NULL, claimed_at = NULL WHERE claim_token = ?").run(
						token,
					);
				});
			} catch {
				// Stale claims remain recoverable on a later flush.
			}
		}
		const code = failureCode?.slice(0, MAX_HEALTH_FAILURE_CODE_LENGTH) ?? "unknown";
		const windowExpired =
			Date.now() - parseTelemetryTimestamp(deliveryState.windowStartedAt) >= DELIVERY_HEALTH_WINDOW_MS;
		deliveryState = {
			...deliveryState,
			windowStartedAt: windowExpired ? now : deliveryState.windowStartedAt,
			failureCount: windowExpired ? 1 : deliveryState.failureCount + 1,
			successCount: windowExpired ? 0 : deliveryState.successCount,
			consecutiveFailures: consecutiveFailures + 1,
			lastAttemptAt: now,
			lastFailureCode: code,
		};
		deliveryStatePersistenceFailed = !stateUpdated;
		consecutiveFailures++;
		effectiveIntervalMs = nextFlushIntervalMs(config.flushIntervalMs, consecutiveFailures);
		nextAllowedFlushAt = Date.now() + effectiveIntervalMs;
	}

	async function claimUnsent(limit: number): Promise<ClaimedTelemetryEvents | null> {
		const token = crypto.randomUUID();
		const now = new Date();
		const staleBefore = new Date(now.getTime() - TELEMETRY_CLAIM_TIMEOUT_MS).toISOString();
		try {
			const withWriteTxAsync = db.withWriteTxAsync;
			if (!withWriteTxAsync) return null;
			return await withWriteTxAsync((w) => {
				w.prepare(
					`UPDATE telemetry_events
					 SET claim_token = ?, claimed_at = ?
					     , delivery_attempts = delivery_attempts + 1, last_attempt_at = ?
					 WHERE id IN (
						 SELECT id FROM telemetry_events
						 WHERE source = 'daemon' AND sent_to_posthog = 0
							 AND (claim_token IS NULL OR claimed_at < ?)
						 ORDER BY timestamp ASC
						 LIMIT ?
					 )`,
				).run(token, now.toISOString(), now.toISOString(), staleBefore, limit);
				const rows = w
					.prepare(
						`SELECT id, event, timestamp, properties
						 FROM telemetry_events
						 WHERE claim_token = ?
						 ORDER BY timestamp ASC`,
					)
					.all(token) as unknown as readonly {
					id: string;
					event: string;
					timestamp: string;
					properties: string;
				}[];
				return rows.length > 0
					? {
							token,
							events: rows.map((row) => ({
								id: row.id,
								event: row.event as TelemetryEventType,
								timestamp: row.timestamp,
								properties: JSON.parse(row.properties) as TelemetryProperties,
							})),
						}
					: null;
			});
		} catch {
			return null;
		}
	}

	async function pruneOldEvents(): Promise<void> {
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - config.retentionDays);
		try {
			const withWriteTxAsync = db.withWriteTxAsync;
			if (!withWriteTxAsync) return;
			await withWriteTxAsync((w) => {
				w.prepare("DELETE FROM telemetry_events WHERE timestamp < ? AND sent_to_posthog = 1").run(cutoff.toISOString());
			});
		} catch {
			// best effort
		}
	}

	function ageSec(timestamp: string | null): number | null {
		if (!timestamp) return null;
		const parsed = parseTelemetryTimestamp(timestamp);
		return Number.isFinite(parsed) ? Math.max(0, (Date.now() - parsed) / 1000) : null;
	}

	function deliveryHealth(): TelemetryDeliveryHealth {
		const state = deliveryState;
		let oldestUnsentTimestamp = persistedOldestTimestamp;
		let latestEventTimestamp = lastDaemonEventTimestamp;
		const queuedUnsentEventCount = buffer.length + persistedQueueCount;
		const bufferedOldest = buffer[0]?.timestamp ?? null;
		if (bufferedOldest && (oldestUnsentTimestamp === null || bufferedOldest.localeCompare(oldestUnsentTimestamp) < 0)) {
			oldestUnsentTimestamp = bufferedOldest;
		}
		const bufferedLatest = buffer.at(-1)?.timestamp ?? null;
		if (bufferedLatest && (latestEventTimestamp === null || bufferedLatest.localeCompare(latestEventTimestamp) > 0)) {
			latestEventTimestamp = bufferedLatest;
		}
		const windowExpired = Date.now() - parseTelemetryTimestamp(state.windowStartedAt) >= DELIVERY_HEALTH_WINDOW_MS;
		const recentSuccesses = windowExpired ? 0 : state.successCount;
		const recentFailures = windowExpired ? 0 : state.failureCount;
		const oldestAge = ageSec(oldestUnsentTimestamp);
		const effectiveConsecutiveFailures = deliveryStatePersistenceFailed
			? consecutiveFailures
			: Math.max(state.consecutiveFailures, consecutiveFailures);
		const degraded =
			posthogConfigured &&
			(effectiveConsecutiveFailures > 0 ||
				recentFailures > 0 ||
				(oldestAge !== null && oldestAge > (effectiveIntervalMs / 1000) * 2));
		return {
			status: !posthogConfigured ? "local-only" : degraded ? "degraded" : "healthy",
			deliveryConfigured: posthogConfigured,
			bufferedEventCount: buffer.length,
			queuedUnsentEventCount,
			oldestUnsentEventAgeSec: oldestAge,
			lastDaemonEventAgeSec: ageSec(latestEventTimestamp),
			lastAttemptAgeSec: ageSec(state.lastAttemptAt),
			lastSuccessfulDeliveryAgeSec: ageSec(state.lastSuccessAt),
			recentDeliverySuccessCount: recentSuccesses,
			recentDeliveryFailureCount: recentFailures,
			consecutiveFailures: effectiveConsecutiveFailures,
			backoffActive: effectiveConsecutiveFailures >= MAX_CONSECUTIVE_FAILURES,
			droppedEventCount: Math.max(droppedEventCount, state.droppedEventCount),
			flushIntervalMs: effectiveIntervalMs,
		};
	}

	function appendBufferedEvent(event: TelemetryEventType, properties: TelemetryProperties, enriched = false): void {
		if (recordingStopped) return;
		if (buffer.length >= MAX_BUFFER_EVENTS) {
			const dropCount = buffer.length - MAX_BUFFER_EVENTS + 1;
			buffer.splice(0, dropCount);
			recordDroppedEvents(dropCount);
			logger.warn("telemetry", "Buffer exceeded max capacity, dropping oldest events", {
				dropped: dropCount,
				maxBufferEvents: MAX_BUFFER_EVENTS,
			});
		}
		const next: TelemetryEvent = {
			id: crypto.randomUUID(),
			event,
			timestamp: new Date().toISOString(),
			properties: addContext(event, enriched ? properties : enrichSessionEvent(event, properties)),
		};
		buffer.push(next);
		queueLogLine(next);
	}

	const pendingIdentityRecords: Array<{
		readonly event: TelemetryEventType;
		readonly properties: TelemetryProperties;
	}> = [];
	let installIdentityReady = false;
	function appendAfterInstallIdentity(event: TelemetryEventType, properties: TelemetryProperties): void {
		if (!installIdentityReady) {
			pendingIdentityRecords.push({ event, properties: enrichSessionEvent(event, properties) });
			return;
		}
		appendBufferedEvent(event, properties);
	}

	async function drainBuffer(): Promise<void> {
		const pending = buffer.splice(0, buffer.length);
		if (await writeToDb(pending)) {
			await refreshPersistedQueue();
			return;
		}
		// Preserve events for a later attempt when SQLite is temporarily locked.
		buffer.unshift(...pending);
		if (buffer.length > MAX_BUFFER_EVENTS) {
			const dropped = buffer.length - MAX_BUFFER_EVENTS;
			buffer.splice(0, dropped);
			recordDroppedEvents(dropped);
		}
	}

	async function doFlush(emitHealth: boolean, allowRemote = true, force = false): Promise<void> {
		// The persisted delivery state may still be loading when the first timer
		// fires. Do not let that first delivery bypass a restart backoff, and
		// re-check the gate after the state has been applied because the caller's
		// initial check necessarily ran before this await.
		await deliveryStateReady;
		await installLifecycleReady;
		if (allowRemote && !force && Date.now() < nextAllowedFlushAt) allowRemote = false;
		await awaitPendingAsyncWrites();
		flushCount++;
		await drainBuffer();
		if (emitHealth) {
			// Snapshot before adding this diagnostic event. Its local value must not
			// depend on the success of the request that carries the snapshot.
			appendBufferedEvent("telemetry.health", { ...deliveryHealth() });
			await drainBuffer();
		}

		// Send to PostHog if configured
		if (allowRemote && posthogConfigured) {
			const claimed = await claimUnsent(config.flushBatchSize);
			if (claimed) {
				const abortController = new AbortController();
				flushAbortController = abortController;
				try {
					const result = await sendToPostHog(
						config.posthogHost,
						config.posthogApiKey,
						installId,
						claimed.events,
						reportedVersion,
						abortController.signal,
					);
					if (result.ok) {
						await markSent(claimed.token);
					} else {
						await releaseClaim(claimed.token, result.failureCode);
						if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
							logger.warn("telemetry", "PostHog unreachable, backing off", {
								intervalMs: effectiveIntervalMs,
							});
						}
					}
				} finally {
					if (flushAbortController === abortController) flushAbortController = null;
				}
			}
		}

		// Occasional pruning (every 10th flush, deterministic for tests)
		if (flushCount % PRUNE_EVERY_N_FLUSHES === 0) {
			await pruneOldEvents();
		}
		await refreshPersistedQueue();
	}

	function flushInternal(emitHealth: boolean, force = false): Promise<void> {
		if (flushPromise) return flushPromise;
		if (!force && Date.now() < nextAllowedFlushAt) {
			// Backoff suppresses network claims, not local durability. Persist the
			// in-memory buffer so an outage cannot exhaust RAM or lose events;
			// retain local health/pruning maintenance while skipping PostHog.
			flushPromise = doFlush(emitHealth, false, force)
				.catch(() => {})
				.finally(() => {
					flushPromise = null;
				});
			return flushPromise;
		}
		flushPromise = doFlush(emitHealth, true, force)
			.catch(() => {
				// Telemetry must never surface a flush failure to the daemon.
			})
			.finally(() => {
				flushPromise = null;
			});
		return flushPromise;
	}

	function sessionKeyFor(properties: TelemetryProperties): string | null {
		const hashed = properties.sessionHash;
		if (typeof hashed === "string" && hashed.length > 0) return hashed;
		const harness = properties.harness;
		return typeof harness === "string" && harness.length > 0 ? `harness:${harness}` : null;
	}

	const sessionCosts = new Map<string, SessionCostAccumulator>();
	const activeSessionKeys = new Set<string>();

	function pruneSessionState(): void {
		for (const key of sessionCosts.keys()) {
			if (!activeSessionKeys.has(key)) sessionCosts.delete(key);
		}
		while (activeSessionKeys.size > MAX_ACTIVE_SESSIONS) {
			const oldest = activeSessionKeys.values().next().value;
			if (typeof oldest !== "string") break;
			activeSessionKeys.delete(oldest);
			sessionCosts.delete(oldest);
		}
	}

	function reopenSession(sessionHash: string): void {
		if (!sessionHash) return;
		if (!activeSessionKeys.has(sessionHash)) {
			activeSessionKeys.add(sessionHash);
			sessionCosts.set(sessionHash, emptySessionCost());
		}
		pruneSessionState();
	}

	function enrichSessionEvent(event: TelemetryEventType, properties: TelemetryProperties): TelemetryProperties {
		const key = sessionKeyFor(properties);
		if (event === "session.start") {
			if (key) reopenSession(key);
			return properties;
		}
		if (event === "llm.generate" || event === "dreaming.pass" || event === "pipeline.embedding") {
			if (key) {
				if (!activeSessionKeys.has(key)) return properties;
				const cost = sessionCosts.get(key) ?? emptySessionCost();
				addEventCost(cost, event, properties);
				sessionCosts.set(key, cost);
				return properties;
			}
			if (activeSessionKeys.size === 1) {
				const activeKey = activeSessionKeys.values().next().value;
				if (typeof activeKey === "string") {
					const cost = sessionCosts.get(activeKey) ?? emptySessionCost();
					addEventCost(cost, event, properties);
					sessionCosts.set(activeKey, cost);
				}
			}
			return properties;
		}
		if (event !== "session.end") return properties;
		let closingKey = key;
		let cost = key ? sessionCosts.get(key) : undefined;
		if (!key && activeSessionKeys.size === 1) {
			const onlyActiveKey = activeSessionKeys.values().next().value;
			if (typeof onlyActiveKey === "string") {
				closingKey = onlyActiveKey;
				cost = sessionCosts.get(onlyActiveKey);
			}
		}
		if (closingKey) {
			activeSessionKeys.delete(closingKey);
			sessionCosts.delete(closingKey);
		}
		pruneSessionState();
		return cost ? { ...properties, ...sessionCostProperties(cost) } : properties;
	}

	const collector: TelemetryCollector = {
		enabled: true,
		reopenSession,
		deliveryHealth,
		anonymizeAgentId(agentId: string): string {
			return createHash("sha256").update(`${agentId}:${installId}`).digest("hex").slice(0, 16);
		},

		record(event, properties): void {
			appendAfterInstallIdentity(event, properties);

			if (buffer.length >= MAX_BUFFER_SIZE) {
				void flushInternal(false);
			}
		},

		recordDeferred(event, properties): void {
			appendAfterInstallIdentity(event, properties);
		},

		recordFirstUse(kind): void {
			if (recordingStopped) return;
			const pending = persistFirstUse(kind)
				.then((event) => {
					if (!event) return;
					// The database row is durable before the open log mirror is written.
					// A failed log write must not affect the claim or delivery queue.
					queueLogLine(event);
				})
				.catch((error) => {
					logger.warn("telemetry", "Dropped first-use telemetry event", {
						dropped: 1,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			trackAsyncWrite(pending);
		},

		async flush(): Promise<void> {
			await flushInternal(false, true);
			await flushLog();
		},

		start(): void {
			if (running) return;
			running = true;

			function scheduleFlush(): void {
				if (!running) return;
				const delayMs = nextAllowedFlushAt > Date.now() ? nextAllowedFlushAt - Date.now() : effectiveIntervalMs;
				flushTimer = setTimeout(() => {
					flushTimer = null;
					flushInternal(true).finally(() => scheduleFlush());
				}, delayMs);
			}

			scheduleFlush();
			logger.info("telemetry", "Telemetry collector started", {
				posthog: posthogConfigured,
				flushIntervalMs: config.flushIntervalMs,
			});
		},

		async stop(): Promise<void> {
			running = false;
			if (flushTimer !== null) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			await flushInternal(true, true);
			await flushLog();
			// Stop accepting new events only after the first drain completes,
			// so events recorded while an outbound request was awaiting are
			// included in this final serialized drain.
			recordingStopped = true;
			await flushInternal(true, true);
			await flushLog();
			logger.info("telemetry", "Telemetry collector stopped");
		},

		async discardPending(): Promise<void> {
			running = false;
			if (flushTimer !== null) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			recordingStopped = true;
			buffer.splice(0, buffer.length);
			flushAbortController?.abort();
			if (flushPromise) await flushPromise;
			await awaitPendingAsyncWrites();
			try {
				const withWriteTxAsync = db.withWriteTxAsync;
				if (!withWriteTxAsync) throw new Error("async writer unavailable");
				await withWriteTxAsync((w) => {
					w.prepare("DELETE FROM telemetry_events WHERE sent_to_posthog = 0").run();
				});
			} catch {
				logger.warn("telemetry", "Failed to discard pending telemetry events");
			}
			logger.info("telemetry", "Telemetry collector disabled");
		},

		async query(opts): Promise<readonly TelemetryEvent[]> {
			try {
				return await db.withReadDbAsync(async (r) => {
					const conditions: string[] = [];
					const params: unknown[] = [];

					if (opts?.event) {
						conditions.push("event = ?");
						params.push(opts.event);
					}
					if (opts?.since) {
						conditions.push("timestamp >= ?");
						params.push(opts.since);
					}
					if (opts?.until) {
						conditions.push("timestamp <= ?");
						params.push(opts.until);
					}

					const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
					const limit = opts?.limit ?? 100;

					const rows = r
						.prepare(
							`SELECT id, event, timestamp, properties
							 FROM telemetry_events
							 ${where}
							 ORDER BY timestamp DESC
							 LIMIT ?`,
						)
						.all(...params, limit) as unknown as readonly {
						id: string;
						event: string;
						timestamp: string;
						properties: string;
					}[];

					return rows.map((row) => ({
						id: row.id,
						event: row.event as TelemetryEventType,
						timestamp: row.timestamp,
						properties: JSON.parse(row.properties) as TelemetryProperties,
					}));
				}, { siteToken: "telemetry.ts:1597" });
			} catch {
				return [];
			}
		},
	};

	const emitInstallLifecycle = (): void => {
		// First run of a new install: emit install.activated so daemon-running
		// installs are countable regardless of how they were installed (the npm
		// postinstall ping never fires for bun global or desktop installs).
		if (installActivated) {
			collector.record("install.activated", {
				version: reportedVersion,
				platform: process.platform,
			});
			if (opts.configSnapshot) {
				collector.record("config.snapshot", { ...opts.configSnapshot });
			}
		}
		if (previousVersion && previousVersion !== daemonVersion) {
			collector.record("version.observed", {
				from: previousVersion,
				to: daemonVersion,
			});
		}
	};
	const finishInstallIdentity = (resolved?: InstallIdentity): void => {
		if (resolved) {
			installId = resolved.id;
			installActivated = resolved.created;
			previousVersion = resolved.previousVersion;
		}
		installIdentityReady = true;
		emitInstallLifecycle();
		for (const pending of pendingIdentityRecords.splice(0))
			appendBufferedEvent(pending.event, pending.properties, true);
	};
	installLifecycleReady =
		installIdentity.ready?.then(finishInstallIdentity) ?? Promise.resolve().then(() => finishInstallIdentity());

	return collector;
}
