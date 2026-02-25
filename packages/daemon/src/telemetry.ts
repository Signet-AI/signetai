/**
 * Anonymous, opt-in telemetry collector for the Signet daemon.
 *
 * Records events to an in-memory buffer, periodically flushing to
 * SQLite (always) and a self-hosted PostHog instance (when configured).
 * No memory content, user identity, or file paths are ever included.
 */

import type { PipelineTelemetryConfig } from "@signet/core";
import type { DbAccessor } from "./db-accessor";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export const TELEMETRY_EVENTS = [
	"llm.generate",
	"pipeline.extraction",
	"pipeline.decision",
	"pipeline.embedding",
	"pipeline.error",
	"session.start",
	"session.end",
	"daemon.heartbeat",
] as const;

export type TelemetryEventType = (typeof TELEMETRY_EVENTS)[number];

export type TelemetryProperties = Readonly<
	Record<string, string | number | boolean | null>
>;

export interface TelemetryEvent {
	readonly id: string;
	readonly event: TelemetryEventType;
	readonly timestamp: string;
	readonly properties: TelemetryProperties;
}

// ---------------------------------------------------------------------------
// Collector interface
// ---------------------------------------------------------------------------

export interface TelemetryCollector {
	record(
		event: TelemetryEventType,
		properties: TelemetryProperties,
	): void;

	flush(): Promise<void>;
	start(): void;
	stop(): Promise<void>;

	query(opts?: {
		event?: TelemetryEventType;
		since?: string;
		until?: string;
		limit?: number;
	}): readonly TelemetryEvent[];

	readonly enabled: boolean;
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

const MAX_BUFFER_SIZE = 200;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_MULTIPLIER = 5;

async function sendToPostHog(
	host: string,
	apiKey: string,
	events: readonly TelemetryEvent[],
	daemonVersion: string,
): Promise<boolean> {
	const batch: readonly PostHogBatchEvent[] = events.map((e) => ({
		event: e.event,
		distinct_id: "signet-anonymous",
		timestamp: e.timestamp,
		properties: {
			...e.properties,
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
		return res.ok;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTelemetryCollector(
	db: DbAccessor,
	config: PipelineTelemetryConfig,
	daemonVersion: string,
): TelemetryCollector {
	const buffer: TelemetryEvent[] = [];
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	let consecutiveFailures = 0;
	let effectiveIntervalMs = config.flushIntervalMs;

	const posthogConfigured =
		config.posthogHost.length > 0 && config.posthogApiKey.length > 0;

	function writeToDb(events: readonly TelemetryEvent[]): void {
		if (events.length === 0) return;
		try {
			db.withWriteTx((w) => {
				const stmt = w.prepare(
					`INSERT OR IGNORE INTO telemetry_events
					 (id, event, timestamp, properties, sent_to_posthog, created_at)
					 VALUES (?, ?, ?, ?, 0, ?)`,
				);
				const now = new Date().toISOString();
				for (const e of events) {
					stmt.run(e.id, e.event, e.timestamp, JSON.stringify(e.properties), now);
				}
			});
		} catch (err) {
			logger.warn(
				"telemetry",
				"Failed to write events to db",
				{ error: err instanceof Error ? err.message : String(err) },
			);
		}
	}

	function markSent(ids: readonly string[]): void {
		if (ids.length === 0) return;
		try {
			db.withWriteTx((w) => {
				const stmt = w.prepare(
					"UPDATE telemetry_events SET sent_to_posthog = 1 WHERE id = ?",
				);
				for (const id of ids) {
					stmt.run(id);
				}
			});
		} catch {
			// best effort
		}
	}

	function loadUnsent(limit: number): readonly TelemetryEvent[] {
		try {
			return db.withReadDb((r) => {
				const rows = r
					.prepare(
						`SELECT id, event, timestamp, properties
						 FROM telemetry_events
						 WHERE sent_to_posthog = 0
						 ORDER BY timestamp ASC
						 LIMIT ?`,
					)
					.all(limit) as readonly {
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
	}

	function pruneOldEvents(): void {
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - config.retentionDays);
		try {
			db.withWriteTx((w) => {
				w.prepare(
					"DELETE FROM telemetry_events WHERE timestamp < ?",
				).run(cutoff.toISOString());
			});
		} catch {
			// best effort
		}
	}

	async function doFlush(): Promise<void> {
		// Drain buffer to SQLite
		const pending = buffer.splice(0, buffer.length);
		writeToDb(pending);

		// Send to PostHog if configured
		if (posthogConfigured) {
			const unsent = loadUnsent(config.flushBatchSize);
			if (unsent.length > 0) {
				const ok = await sendToPostHog(
					config.posthogHost,
					config.posthogApiKey,
					unsent,
					daemonVersion,
				);
				if (ok) {
					markSent(unsent.map((e) => e.id));
					consecutiveFailures = 0;
					effectiveIntervalMs = config.flushIntervalMs;
				} else {
					consecutiveFailures++;
					if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
						effectiveIntervalMs =
							config.flushIntervalMs * BACKOFF_MULTIPLIER;
						logger.warn("telemetry", "PostHog unreachable, backing off", {
							intervalMs: effectiveIntervalMs,
						});
					}
				}
			}
		}

		// Occasional pruning (roughly every 10th flush)
		if (Math.random() < 0.1) {
			pruneOldEvents();
		}
	}

	return {
		enabled: true,

		record(event, properties): void {
			buffer.push({
				id: crypto.randomUUID(),
				event,
				timestamp: new Date().toISOString(),
				properties,
			});

			if (buffer.length >= MAX_BUFFER_SIZE) {
				doFlush().catch(() => {});
			}
		},

		async flush(): Promise<void> {
			await doFlush();
		},

		start(): void {
			if (running) return;
			running = true;

			function scheduleFlush(): void {
				if (!running) return;
				flushTimer = setTimeout(() => {
					flushTimer = null;
					doFlush()
						.catch(() => {})
						.finally(() => scheduleFlush());
				}, effectiveIntervalMs);
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
			await doFlush();
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

					const where =
						conditions.length > 0
							? `WHERE ${conditions.join(" AND ")}`
							: "";
					const limit = opts?.limit ?? 100;

					const rows = r
						.prepare(
							`SELECT id, event, timestamp, properties
							 FROM telemetry_events
							 ${where}
							 ORDER BY timestamp DESC
							 LIMIT ?`,
						)
						.all(...params, limit) as readonly {
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
}
