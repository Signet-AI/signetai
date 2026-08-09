import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Daemon lifecycle record.
 *
 * The daemon writes its state to `.daemon/lifecycle.json` at startup and on
 * every catchable exit path (signal handlers, fatal errors). The record is the
 * one durable artifact that survives the process itself, so a later
 * `signet status` / `signet doctor` can tell a clean shutdown apart from an
 * external kill or a hard crash (issue #1148): a process that died without
 * writing `clean` (SIGKILL, OOM, segfault) leaves the record stuck at
 * `starting`/`running`, and the CLI reports an unrecorded death instead of a
 * silent disappearance.
 *
 * The record is written synchronously and atomically (temp file + rename) so a
 * concurrent reader never observes a partial write.
 */

export type DaemonLifecycleState = "starting" | "running" | "clean" | "error";

export interface DaemonLifecycle {
	readonly state: DaemonLifecycleState;
	readonly pid: number;
	readonly version: string;
	readonly startedAt: string;
	/** systemd transient unit name (Linux service-manager launch), when known. */
	readonly systemdUnit?: string;
	readonly exitedAt?: string;
	readonly exitCode?: number;
	/** Exit-path label: "signal:SIGTERM" | "signal:SIGINT" | "error:uncaughtException" | ... */
	readonly reason?: string;
	readonly error?: string;
}

export type DaemonPreviousExitClassification = "clean" | "error" | "unrecorded";
export type DaemonPreviousExitReasonCategory =
	| "signal"
	| "update"
	| "uncaught_exception"
	| "unhandled_rejection"
	| "startup"
	| "other";

/** Bounded fields for the anonymous daemon.previous_exit event. */
export interface DaemonPreviousExitTelemetry {
	readonly classification: DaemonPreviousExitClassification;
	readonly previousVersion?: string;
	readonly previousUptimeMs?: number;
	readonly reasonCategory?: DaemonPreviousExitReasonCategory;
	readonly exitCode?: number;
	readonly restartDelayMs?: number;
}

const MAX_PREVIOUS_EXIT_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_EXIT_CODE = 255;

function intervalMs(startAt: string | undefined, endAt: string | undefined): number | null {
	if (typeof startAt !== "string" || typeof endAt !== "string") return null;
	const duration = Date.parse(endAt) - Date.parse(startAt);
	if (!Number.isFinite(duration) || duration < 0) return null;
	return Math.min(Math.round(duration), MAX_PREVIOUS_EXIT_INTERVAL_MS);
}

function boundedVersion(version: string | undefined): string | null {
	if (typeof version !== "string" || version.length === 0) return null;
	return Array.from(version, (char) => {
		const code = char.charCodeAt(0);
		return code <= 0x1f || code === 0x7f ? " " : char;
	})
		.join("")
		.slice(0, 64);
}

function boundedExitCode(exitCode: number | undefined): number | null {
	if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || !Number.isFinite(exitCode)) return null;
	return Math.max(-MAX_EXIT_CODE, Math.min(MAX_EXIT_CODE, exitCode));
}

function reasonCategory(reason: string | undefined): DaemonPreviousExitReasonCategory | null {
	if (typeof reason !== "string") return null;
	if (reason.startsWith("signal:")) return "signal";
	if (reason.startsWith("update:")) return "update";
	if (reason === "error:uncaughtException") return "uncaught_exception";
	if (reason === "error:unhandledRejection") return "unhandled_rejection";
	if (reason === "error:startup") return "startup";
	if (reason.startsWith("error:")) return "other";
	return null;
}

/**
 * Convert the previous durable record into bounded anonymous telemetry fields.
 * A terminal record is a catchable exit; a starting/running record is an
 * unrecorded death because the process did not reach a terminal exit path.
 */
export function classifyPreviousDaemonExit(
	record: DaemonLifecycle | null,
	currentStartedAt: string,
): DaemonPreviousExitTelemetry | null {
	if (record === null) return null;

	const classification: DaemonPreviousExitClassification =
		record.state === "clean" ? "clean" : record.state === "error" ? "error" : "unrecorded";
	const properties: {
		classification: DaemonPreviousExitClassification;
		previousVersion?: string;
		previousUptimeMs?: number;
		reasonCategory?: DaemonPreviousExitReasonCategory;
		exitCode?: number;
		restartDelayMs?: number;
	} = { classification };
	const version = boundedVersion(record.version);
	if (version !== null) properties.previousVersion = version;

	const previousUptimeMs = intervalMs(
		record.startedAt,
		classification === "unrecorded" ? currentStartedAt : record.exitedAt,
	);
	if (previousUptimeMs !== null) properties.previousUptimeMs = previousUptimeMs;

	if (classification !== "unrecorded") {
		const category = reasonCategory(record.reason);
		if (category !== null) properties.reasonCategory = category;
		const exitCode = boundedExitCode(record.exitCode);
		if (exitCode !== null) properties.exitCode = exitCode;
		const restartDelayMs = intervalMs(record.exitedAt, currentStartedAt);
		if (restartDelayMs !== null) properties.restartDelayMs = restartDelayMs;
	}

	return properties;
}

export function previousExitTelemetryProperties(
	telemetry: DaemonPreviousExitTelemetry,
): Readonly<Record<string, string | number>> {
	const properties: Record<string, string | number> = {
		classification: telemetry.classification,
	};
	if (telemetry.previousVersion !== undefined) properties.previousVersion = telemetry.previousVersion;
	if (telemetry.previousUptimeMs !== undefined) properties.previousUptimeMs = telemetry.previousUptimeMs;
	if (telemetry.reasonCategory !== undefined) properties.reasonCategory = telemetry.reasonCategory;
	if (telemetry.exitCode !== undefined) properties.exitCode = telemetry.exitCode;
	if (telemetry.restartDelayMs !== undefined) properties.restartDelayMs = telemetry.restartDelayMs;
	return properties;
}

export function lifecyclePath(agentsDir: string): string {
	return join(agentsDir, ".daemon", "lifecycle.json");
}

/** Tolerant read: a missing or corrupt record returns null, never throws. */
export function readDaemonLifecycle(agentsDir: string): DaemonLifecycle | null {
	try {
		const raw = readFileSync(lifecyclePath(agentsDir), "utf-8");
		const parsed = JSON.parse(raw) as Partial<DaemonLifecycle>;
		if (typeof parsed.state !== "string" || typeof parsed.pid !== "number") {
			return null;
		}
		return parsed as DaemonLifecycle;
	} catch {
		return null;
	}
}

/** Best-effort atomic write; recording must never take the daemon down. */
export function writeDaemonLifecycle(agentsDir: string, record: DaemonLifecycle): void {
	const path = lifecyclePath(agentsDir);
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmpPath = `${path}.tmp`;
		writeFileSync(tmpPath, JSON.stringify(record, null, 2));
		renameSync(tmpPath, path);
	} catch {
		// Best effort.
	}
}
