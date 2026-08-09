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
	TELEMETRY_DEPLOYMENT_ROLES,
	TELEMETRY_INSTALL_CHANNELS,
	type TelemetryDeploymentRole,
	type TelemetryInstallChannel,
	parseSimpleYaml,
} from "@signet/core";
import { createDatabase } from "../sqlite.js";

export const TELEMETRY_EVENT = "command.invoked";
const TELEMETRY_FLUSH_TIMEOUT_MS = 2_000;
const TELEMETRY_CLAIM_TIMEOUT_MS = 10 * 60 * 1_000;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 500;

interface CliTelemetrySettings {
	readonly enabled: boolean;
	readonly posthogHost: string;
	readonly posthogApiKey: string;
	readonly flushBatchSize: number;
	readonly deploymentRole: TelemetryDeploymentRole;
	readonly installChannel: TelemetryInstallChannel;
}

interface QueuedEvent {
	readonly id: string;
	readonly event: string;
	readonly timestamp: string;
	readonly properties: Record<string, string | number | boolean | null>;
}

interface ClaimedEvents {
	readonly token: string;
	readonly rows: readonly {
		readonly id: string;
		readonly event: string;
		readonly timestamp: string;
		readonly properties: string;
	}[];
}

function createTelemetryDatabase(dbPath: string): ReturnType<typeof createDatabase> {
	const db = createDatabase(dbPath);
	db.exec("PRAGMA busy_timeout = 5000");
	return db;
}

export type CliTelemetryDeployment = "dev";

export function cliTelemetryDeployment(env: NodeJS.ProcessEnv = process.env): CliTelemetryDeployment | undefined {
	return env.SIGNET_TELEMETRY_ENV?.trim().toLowerCase() === "dev" ? "dev" : undefined;
}

function validTelemetryValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return (allowed as readonly string[]).includes(normalized) ? (normalized as T) : undefined;
}

export function cliTelemetryDeploymentRole(
	configured: unknown,
	env: NodeJS.ProcessEnv = process.env,
): TelemetryDeploymentRole {
	if (cliTelemetryDeployment(env) === "dev") return "development";
	return (
		validTelemetryValue(env.SIGNET_TELEMETRY_DEPLOYMENT_ROLE, TELEMETRY_DEPLOYMENT_ROLES) ??
		validTelemetryValue(configured, TELEMETRY_DEPLOYMENT_ROLES) ??
		"unknown"
	);
}

export function cliTelemetryInstallChannel(
	configured: unknown,
	env: NodeJS.ProcessEnv = process.env,
): TelemetryInstallChannel {
	return (
		validTelemetryValue(env.SIGNET_TELEMETRY_INSTALL_CHANNEL, TELEMETRY_INSTALL_CHANNELS) ??
		validTelemetryValue(configured, TELEMETRY_INSTALL_CHANNELS) ??
		"unknown"
	);
}

function cliTelemetryDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
	return env.SIGNET_TELEMETRY_OPTOUT === "1" || env.SIGNET_TELEMETRY_OPTOUT === "true";
}

/**
 * Resolve the shared open-telemetry log path, mirroring the daemon's
 * `defaultTelemetryLogPath` (issue #1026).
 */
export function cliTelemetryLogPath(agentsDir: string): string {
	return join(agentsDir, ".daemon", "telemetry", "events.jsonl");
}

function readTelemetrySettings(agentsDir: string, env: NodeJS.ProcessEnv = process.env): CliTelemetrySettings | null {
	try {
		const yamlPath = join(agentsDir, "agent.yaml");
		if (!existsSync(yamlPath)) return null;
		if (cliTelemetryDisabledByEnv(env)) {
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
		const posthogApiKey = configuredKey || DEFAULT_TELEMETRY_POSTHOG_API_KEY;
		const configuredBatchSize = telemetry?.flushBatchSize;
		const flushBatchSize =
			typeof configuredBatchSize === "number"
				? Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, Math.floor(configuredBatchSize)))
				: DEFAULT_TELEMETRY_FLUSH_BATCH_SIZE;

		return {
			enabled: true,
			posthogHost,
			posthogApiKey,
			flushBatchSize,
			deploymentRole: cliTelemetryDeploymentRole(telemetry?.deploymentRole, env),
			installChannel: cliTelemetryInstallChannel(telemetry?.installChannel, env),
		};
	} catch {
		return null;
	}
}

/**
 * True when anonymous telemetry is active for this workspace. Telemetry is on
 * by default, so the flag is only false when agent.yaml is unavailable,
 * telemetry is explicitly disabled, or the runtime opt-out is set.
 */
export function cliTelemetryEnabled(agentsDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
	return readTelemetrySettings(agentsDir, env)?.enabled === true;
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
		db = createTelemetryDatabase(dbPath);
		if (!getOrCreateInstallId(db)) return;
		db.prepare(
			`INSERT OR IGNORE INTO telemetry_events
			 (id, event, timestamp, properties, sent_to_posthog, created_at, source)
			 VALUES (?, ?, ?, ?, 0, ?, 'cli')`,
		).run(event.id, event.event, event.timestamp, JSON.stringify(event.properties), new Date().toISOString());
	} catch {
		// Older workspaces may not have the telemetry migrations yet.
	} finally {
		db?.close();
	}
}

function claimEvents(db: ReturnType<typeof createDatabase>, limit: number): ClaimedEvents | null {
	const token = randomUUID();
	const now = new Date();
	const staleBefore = new Date(now.getTime() - TELEMETRY_CLAIM_TIMEOUT_MS).toISOString();
	const claimedAt = now.toISOString();
	try {
		db.prepare(
			`UPDATE telemetry_events
			 SET claim_token = ?, claimed_at = ?
			 WHERE id IN (
				 SELECT id FROM telemetry_events
				 WHERE event = ? AND source = 'cli' AND sent_to_posthog = 0
					 AND (claim_token IS NULL OR claimed_at < ?)
				 ORDER BY timestamp ASC
				 LIMIT ?
			 )`,
		).run(token, claimedAt, TELEMETRY_EVENT, staleBefore, limit);
		const rows = db
			.prepare(
				`SELECT id, event, timestamp, properties
				 FROM telemetry_events
				 WHERE claim_token = ?
				 ORDER BY timestamp ASC`,
			)
			.all(token) as unknown as ClaimedEvents["rows"];
		return rows.length > 0 ? { token, rows } : null;
	} catch {
		return null;
	}
}

function releaseClaim(db: ReturnType<typeof createDatabase>, token: string): void {
	try {
		db.prepare("UPDATE telemetry_events SET claim_token = NULL, claimed_at = NULL WHERE claim_token = ?").run(token);
	} catch {
		// Best effort. Stale claims are recoverable on a later flush.
	}
}

function markClaimedSent(db: ReturnType<typeof createDatabase>, token: string): void {
	try {
		db.prepare(
			"UPDATE telemetry_events SET sent_to_posthog = 1, claim_token = NULL, claimed_at = NULL WHERE claim_token = ?",
		).run(token);
	} catch {
		// Best effort. Stale claims are recoverable on a later flush.
	}
}

/**
 * Append a `command.invoked` event to the audit log and durable flush queue.
 * Payload is the command name only. This function is synchronous for the
 * local write and never performs a network request.
 */
export function recordCommandInvoked(
	agentsDir: string,
	commandName: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const settings = readTelemetrySettings(agentsDir, env);
	if (!settings) return;

	try {
		const deployment = cliTelemetryDeployment(env);
		const event: QueuedEvent = {
			id: randomUUID(),
			event: TELEMETRY_EVENT,
			timestamp: new Date().toISOString(),
			properties: {
				command: commandName,
				deploymentRole: settings.deploymentRole,
				installChannel: settings.installChannel,
				...(deployment ? { deployment } : {}),
			},
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
	let claimToken: string | null = null;
	try {
		db = createTelemetryDatabase(dbPath);
		const installId = getOrCreateInstallId(db);
		if (!installId) return;
		const claimed = claimEvents(db, settings.flushBatchSize);
		if (!claimed) return;
		claimToken = claimed.token;

		const batch = claimed.rows.map((row) => ({
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
		if (!response.ok) {
			releaseClaim(db, claimToken);
			return;
		}

		markClaimedSent(db, claimToken);
		claimToken = null;
	} catch {
		if (db && claimToken) releaseClaim(db, claimToken);
		// Best effort. Unsent rows remain queued for the daemon or next CLI run.
	} finally {
		db?.close();
	}
}
