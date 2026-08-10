/**
 * Anonymous, opt-in telemetry collector for the Signet daemon.
 *
 * Records events to an in-memory buffer, periodically flushing to
 * SQLite (always) and a self-hosted PostHog instance (when configured).
 * No memory content, user identity, or file paths are ever included.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
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

function appendToTelemetryLog(logPath: string | null, line: string): void {
	if (!logPath) return;
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${line}\n`, "utf-8");
	} catch {
		// Telemetry must never break the daemon. Best-effort only.
	}
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
	readonly inferenceMode: "local" | "remote";
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
	 * Record with a bounded synchronous JSONL audit append while deferring
	 * SQLite persistence. The local line survives a hard process kill; the
	 * wedge path does not enter SQLite or provider work.
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

	query(opts?: {
		event?: TelemetryEventType;
		since?: string;
		until?: string;
		limit?: number;
	}): readonly TelemetryEvent[];

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
function getOrCreateInstallId(
	db: DbAccessor,
	daemonVersion: string,
): { readonly id: string; readonly created: boolean; readonly previousVersion?: string } {
	try {
		return db.withWriteTx((w) => {
			const existing = w
				.prepare("SELECT id, last_seen_version FROM telemetry_install ORDER BY created_at ASC LIMIT 1")
				.get() as { readonly id: string; readonly last_seen_version?: string | null } | null | undefined;
			if (existing?.id) {
				if (!existing.last_seen_version) {
					// Establish a baseline for installs upgraded from pre-117
					// schemas without fabricating a transition event.
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
		});
	} catch {
		// Test harnesses and partially upgraded workspaces can still expose the
		// pre-117 telemetry_install shape. Preserve telemetry there without
		// claiming a transition; the next normal migration adds the column.
		try {
			return db.withWriteTx((w) => {
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
			});
		} catch {
			return { id: crypto.randomUUID(), created: false };
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

const HOME_PATH_PATTERNS = [/\/home\/[^\/\s]+/g, /\/Users\/[^\/\s]+/g];

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
			signal: AbortSignal.timeout(10000),
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
		readonly configSnapshot?: TelemetryConfigSnapshot;
		readonly env?: NodeJS.ProcessEnv;
	} = {},
): TelemetryCollector {
	const buffer: TelemetryEvent[] = [];
	const logPath = opts.telemetryLogPath ?? null;
	const deployment = telemetryDeployment(opts.env);
	const reportedVersion = telemetryReportedVersion(daemonVersion, deployment);
	const deploymentRole = telemetryDeploymentRole(config.deploymentRole, opts.env);
	const installChannel = telemetryInstallChannel(config.installChannel, opts.env);
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	let recordingStopped = false;
	let consecutiveFailures = 0;
	let flushCount = 0;
	let effectiveIntervalMs = config.flushIntervalMs;
	let nextAllowedFlushAt = 0;
	let droppedEventCount = 0;
	let pendingDroppedEventCount = 0;
	let flushPromise: Promise<void> | null = null;
	let deliveryStatePersistenceFailed = false;
	const { id: installId, created: installActivated, previousVersion } = getOrCreateInstallId(db, daemonVersion);

	const posthogConfigured = config.posthogHost.length > 0 && config.posthogApiKey.length > 0;

	function readDeliveryState(): TelemetryDeliveryState {
		try {
			const row = db.withReadDb(
				(r) =>
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
			);
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

	const initialDeliveryState = readDeliveryState();
	consecutiveFailures = initialDeliveryState.consecutiveFailures;
	effectiveIntervalMs = nextFlushIntervalMs(config.flushIntervalMs, consecutiveFailures);
	const lastAttemptMs = initialDeliveryState.lastAttemptAt
		? parseTelemetryTimestamp(initialDeliveryState.lastAttemptAt)
		: Number.NaN;
	if (Number.isFinite(lastAttemptMs)) nextAllowedFlushAt = lastAttemptMs + effectiveIntervalMs;

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
	function persistFirstUse(kind: FirstUseKind): TelemetryEvent | null {
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
			const column = FIRST_USE_COLUMNS[kind];
			let claimed = false;
			db.withWriteTx((w) => {
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

	function writeToDb(events: readonly TelemetryEvent[]): boolean {
		if (events.length === 0) return true;
		try {
			db.withWriteTx((w) => {
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

	function markSent(token: string): void {
		const now = new Date().toISOString();
		let stateUpdated = false;
		try {
			db.withWriteTx((w) => {
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
				db.withWriteTx((w) => {
					w.prepare(
						"UPDATE telemetry_events SET sent_to_posthog = 1, claim_token = NULL, claimed_at = NULL WHERE claim_token = ?",
					).run(token);
				});
			} catch {
				// best effort
			}
		}
		deliveryStatePersistenceFailed = !stateUpdated;
		consecutiveFailures = 0;
		effectiveIntervalMs = config.flushIntervalMs;
		nextAllowedFlushAt = 0;
	}

	function releaseClaim(token: string, failureCode?: string): void {
		const now = new Date().toISOString();
		let stateUpdated = false;
		try {
			db.withWriteTx((w) => {
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
				db.withWriteTx((w) => {
					w.prepare("UPDATE telemetry_events SET claim_token = NULL, claimed_at = NULL WHERE claim_token = ?").run(
						token,
					);
				});
			} catch {
				// Stale claims remain recoverable on a later flush.
			}
		}
		deliveryStatePersistenceFailed = !stateUpdated;
		consecutiveFailures++;
		effectiveIntervalMs = nextFlushIntervalMs(config.flushIntervalMs, consecutiveFailures);
		nextAllowedFlushAt = Date.now() + effectiveIntervalMs;
	}

	function claimUnsent(limit: number): ClaimedTelemetryEvents | null {
		const token = crypto.randomUUID();
		const now = new Date();
		const staleBefore = new Date(now.getTime() - TELEMETRY_CLAIM_TIMEOUT_MS).toISOString();
		try {
			return db.withWriteTx((w) => {
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

	function pruneOldEvents(): void {
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - config.retentionDays);
		try {
			db.withWriteTx((w) => {
				// Never prune a row that is still waiting for remote delivery.
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
		const state = readDeliveryState();
		let queuedUnsentEventCount = buffer.length;
		let oldestUnsentTimestamp: string | null = null;
		let lastDaemonEventTimestamp: string | null = null;
		try {
			db.withReadDb((r) => {
				const queue = r
					.prepare(
						`SELECT COUNT(*) AS count, MIN(timestamp) AS oldestTimestamp
						 FROM telemetry_events WHERE source = 'daemon' AND sent_to_posthog = 0`,
					)
					.get() as { count?: number; oldestTimestamp?: string | null } | undefined;
				queuedUnsentEventCount += queue?.count ?? 0;
				oldestUnsentTimestamp = queue?.oldestTimestamp ?? null;
				const latest = r
					.prepare(
						"SELECT MAX(timestamp) AS timestamp FROM telemetry_events WHERE source = 'daemon' AND event <> 'telemetry.health'",
					)
					.get() as { timestamp?: string | null } | undefined;
				lastDaemonEventTimestamp = latest?.timestamp ?? null;
			});
		} catch {
			// Keep local in-memory health available when SQLite is unavailable.
		}
		const bufferedOldest = buffer[0]?.timestamp ?? null;
		if (bufferedOldest && (oldestUnsentTimestamp === null || bufferedOldest.localeCompare(oldestUnsentTimestamp) < 0)) {
			oldestUnsentTimestamp = bufferedOldest;
		}
		const bufferedLatest = buffer.at(-1)?.timestamp ?? null;
		if (
			bufferedLatest &&
			(lastDaemonEventTimestamp === null || bufferedLatest.localeCompare(lastDaemonEventTimestamp) > 0)
		) {
			lastDaemonEventTimestamp = bufferedLatest;
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
			lastDaemonEventAgeSec: ageSec(lastDaemonEventTimestamp),
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

	function appendBufferedEvent(event: TelemetryEventType, properties: TelemetryProperties): void {
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
			properties: addContext(event, enrichSessionEvent(event, properties)),
		};
		buffer.push(next);
		if (logPath) appendToTelemetryLog(logPath, JSON.stringify(next));
	}

	function drainBuffer(): void {
		const pending = buffer.splice(0, buffer.length);
		if (writeToDb(pending)) return;
		// Preserve events for a later attempt when SQLite is temporarily locked.
		buffer.unshift(...pending);
		if (buffer.length > MAX_BUFFER_EVENTS) {
			const dropped = buffer.length - MAX_BUFFER_EVENTS;
			buffer.splice(0, dropped);
			recordDroppedEvents(dropped);
		}
	}

	async function doFlush(emitHealth: boolean, allowRemote = true): Promise<void> {
		flushCount++;
		// Drain buffer to SQLite
		drainBuffer();
		if (emitHealth) {
			// Snapshot before adding this diagnostic event. Its local value must not
			// depend on the success of the request that carries the snapshot.
			appendBufferedEvent("telemetry.health", { ...deliveryHealth() });
			drainBuffer();
		}

		// Send to PostHog if configured
		if (allowRemote && posthogConfigured) {
			const claimed = claimUnsent(config.flushBatchSize);
			if (claimed) {
				const result = await sendToPostHog(
					config.posthogHost,
					config.posthogApiKey,
					installId,
					claimed.events,
					reportedVersion,
				);
				if (result.ok) {
					markSent(claimed.token);
				} else {
					releaseClaim(claimed.token, result.failureCode);
					if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
						logger.warn("telemetry", "PostHog unreachable, backing off", {
							intervalMs: effectiveIntervalMs,
						});
					}
				}
			}
		}

		// Occasional pruning (every 10th flush, deterministic for tests)
		if (flushCount % PRUNE_EVERY_N_FLUSHES === 0) {
			pruneOldEvents();
		}
	}

	function flushInternal(emitHealth: boolean, force = false): Promise<void> {
		if (flushPromise) return flushPromise;
		if (!force && Date.now() < nextAllowedFlushAt) {
			// Backoff suppresses network claims, not local durability. Persist the
			// in-memory buffer so an outage cannot exhaust RAM or lose events;
			// retain local health/pruning maintenance while skipping PostHog.
			flushPromise = doFlush(emitHealth, false)
				.catch(() => {})
				.finally(() => {
					flushPromise = null;
				});
			return flushPromise;
		}
		flushPromise = doFlush(emitHealth)
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
			appendBufferedEvent(event, properties);

			if (buffer.length >= MAX_BUFFER_SIZE) {
				void flushInternal(false);
			}
		},

		recordDeferred(event, properties): void {
			appendBufferedEvent(event, properties);
		},

		recordFirstUse(kind): void {
			const event = persistFirstUse(kind);
			if (!event) return;
			// The database row is durable before the open log mirror is written.
			// A failed log write must not affect the claim or delivery queue.
			appendToTelemetryLog(logPath, JSON.stringify(event));
		},

		async flush(): Promise<void> {
			await flushInternal(false, true);
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
			// Stop accepting new events only after the first drain completes,
			// so events recorded while an outbound request was awaiting are
			// included in this final serialized drain.
			recordingStopped = true;
			await flushInternal(true, true);
			logger.info("telemetry", "Telemetry collector stopped");
		},

		query(opts): readonly TelemetryEvent[] {
			try {
				return db.withReadDb((r) => {
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
				});
			} catch {
				return [];
			}
		},
	};

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

	return collector;
}
