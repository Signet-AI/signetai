/**
 * CLI-side anonymous telemetry.
 *
 * The CLI mirrors command.invoked events to the open JSONL audit log and queues
 * them in the workspace database. A best-effort, non-awaited batch flush sends
 * queued CLI events to the same PostHog project and install id as the daemon.
 * Telemetry must never change the command's result or failure behavior.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	DEFAULT_TELEMETRY_FLUSH_BATCH_SIZE,
	DEFAULT_TELEMETRY_POSTHOG_API_KEY,
	DEFAULT_TELEMETRY_POSTHOG_HOST,
	parseSimpleYaml,
} from "@signet/core";
import { createDatabase } from "../sqlite.js";

export const TELEMETRY_EVENT = "command.invoked";
const TELEMETRY_FLUSH_TIMEOUT_MS = 2_000;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 500;

interface CliTelemetrySettings {
	readonly enabled: boolean;
	readonly posthogHost: string;
	readonly posthogApiKey: string;
	readonly flushBatchSize: number;
}

interface QueuedEvent {
	readonly id: string;
	readonly event: string;
	readonly timestamp: string;
	readonly properties: Record<string, string | number | boolean | null>;
}

/**
 * Resolve the shared open-telemetry log path, mirroring the daemon's
 * `defaultTelemetryLogPath` (issue #1026).
 */
export function cliTelemetryLogPath(agentsDir: string): string {
	return join(agentsDir, ".daemon", "telemetry", "events.jsonl");
}

function readTelemetrySettings(agentsDir: string): CliTelemetrySettings | null {
	try {
		const yamlPath = join(agentsDir, "agent.yaml");
		if (!existsSync(yamlPath)) return null;
		if (process.env.SIGNET_TELEMETRY_OPTOUT === "1" || process.env.SIGNET_TELEMETRY_OPTOUT === "true") {
			return null;
		}

		const config = parseSimpleYaml(readFileSync(yamlPath, "utf-8"));
		const memory = config?.memory as Record<string, unknown> | undefined;
		const pipeline = memory?.pipelineV2 as Record<string, unknown> | undefined;
		if (pipeline?.telemetryEnabled === false) return null;

		const telemetry = pipeline?.telemetry as Record<string, unknown> | undefined;
		const posthogHost =
			typeof telemetry?.posthogHost === "string" ? telemetry.posthogHost : DEFAULT_TELEMETRY_POSTHOG_HOST;
		const configuredKey = typeof telemetry?.posthogApiKey === "string" ? telemetry.posthogApiKey : "";
		const posthogApiKey = configuredKey || process.env.POSTHOG_API_KEY || DEFAULT_TELEMETRY_POSTHOG_API_KEY;
		const configuredBatchSize = telemetry?.flushBatchSize;
		const flushBatchSize =
			typeof configuredBatchSize === "number"
				? Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, Math.floor(configuredBatchSize)))
				: DEFAULT_TELEMETRY_FLUSH_BATCH_SIZE;

		return { enabled: true, posthogHost, posthogApiKey, flushBatchSize };
	} catch {
		return null;
	}
}

/**
 * True when anonymous telemetry is active for this workspace. Telemetry is on
 * by default, so the flag is only false when agent.yaml is unavailable,
 * telemetry is explicitly disabled, or the runtime opt-out is set.
 */
export function cliTelemetryEnabled(agentsDir: string): boolean {
	return readTelemetrySettings(agentsDir)?.enabled === true;
}

function getOrCreateInstallId(db: ReturnType<typeof createDatabase>): string | null {
	try {
		const existing = db.prepare("SELECT id FROM telemetry_install ORDER BY created_at ASC LIMIT 1").get() as
			| { readonly id?: unknown }
			| null
			| undefined;
		if (typeof existing?.id === "string" && existing.id.length > 0) return existing.id;

		const id = randomUUID();
		db.prepare("INSERT OR IGNORE INTO telemetry_install (id, created_at) VALUES (?, ?)").run(
			id,
			new Date().toISOString(),
		);
		const stored = db.prepare("SELECT id FROM telemetry_install ORDER BY created_at ASC LIMIT 1").get() as
			| { readonly id?: unknown }
			| null
			| undefined;
		return typeof stored?.id === "string" && stored.id.length > 0 ? stored.id : id;
	} catch {
		return null;
	}
}

function queueCommandEvent(agentsDir: string, event: QueuedEvent): void {
	const dbPath = join(agentsDir, "memory", "memories.db");
	if (!existsSync(dbPath)) return;

	let db: ReturnType<typeof createDatabase> | null = null;
	try {
		db = createDatabase(dbPath);
		if (!getOrCreateInstallId(db)) return;
		db.prepare(
			`INSERT OR IGNORE INTO telemetry_events
			 (id, event, timestamp, properties, sent_to_posthog, created_at)
			 VALUES (?, ?, ?, ?, 0, ?)`,
		).run(event.id, event.event, event.timestamp, JSON.stringify(event.properties), new Date().toISOString());
	} catch {
		// Older workspaces may not have the telemetry migrations yet.
	} finally {
		db?.close();
	}
}

/**
 * Append a `command.invoked` event to the audit log and durable flush queue.
 * Payload is the command name only. This function is synchronous for the
 * local write and never performs a network request.
 */
export function recordCommandInvoked(agentsDir: string, commandName: string): void {
	const settings = readTelemetrySettings(agentsDir);
	if (!settings) return;

	try {
		const event: QueuedEvent = {
			id: randomUUID(),
			event: TELEMETRY_EVENT,
			timestamp: new Date().toISOString(),
			properties: { command: commandName },
		};
		const logPath = cliTelemetryLogPath(agentsDir);
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${JSON.stringify(event)}\n`, "utf-8");
		if (settings.posthogHost.length > 0 && settings.posthogApiKey.length > 0) {
			queueCommandEvent(agentsDir, event);
		}
	} catch {
		// Never break the command on telemetry write failures.
	}
}

/**
 * Flush queued CLI command events to PostHog. Callers should deliberately not
 * await this function from command hooks. The batch size and request timeout
 * bound the work, while SQLite preserves events when the request fails.
 */
export async function flushCliTelemetry(agentsDir: string, cliVersion: string): Promise<void> {
	const settings = readTelemetrySettings(agentsDir);
	if (!settings || settings.posthogHost.length === 0 || settings.posthogApiKey.length === 0) return;

	const dbPath = join(agentsDir, "memory", "memories.db");
	if (!existsSync(dbPath)) return;

	let db: ReturnType<typeof createDatabase> | null = null;
	try {
		db = createDatabase(dbPath);
		const installId = getOrCreateInstallId(db);
		if (!installId) return;
		const rows = db
			.prepare(
				`SELECT id, event, timestamp, properties
				 FROM telemetry_events
				 WHERE event = ? AND sent_to_posthog = 0
				 ORDER BY timestamp ASC
				 LIMIT ?`,
			)
			.all(TELEMETRY_EVENT, settings.flushBatchSize) as unknown as readonly {
			id: string;
			event: string;
			timestamp: string;
			properties: string;
		}[];
		if (rows.length === 0) return;

		const batch = rows.map((row) => ({
			event: row.event,
			distinct_id: installId,
			timestamp: row.timestamp,
			properties: {
				...(JSON.parse(row.properties) as Record<string, string | number | boolean | null>),
				$lib: "signet-cli",
				$lib_version: cliVersion,
			},
		}));
		const response = await fetch(`${settings.posthogHost}/batch/`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ api_key: settings.posthogApiKey, batch }),
			signal: AbortSignal.timeout(TELEMETRY_FLUSH_TIMEOUT_MS),
		});
		if (!response.ok) return;

		const markSent = db.prepare("UPDATE telemetry_events SET sent_to_posthog = 1 WHERE id = ?");
		for (const row of rows) markSent.run(row.id);
	} catch {
		// Best effort. Unsent rows remain queued for the daemon or next CLI run.
	} finally {
		db?.close();
	}
}
