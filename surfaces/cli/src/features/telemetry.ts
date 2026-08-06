/**
 * CLI-side open telemetry log (issue #1026 Phase 2).
 *
 * The daemon mirrors every opted-in telemetry event to a JSONL file at
 * `<agentsDir>/.daemon/telemetry/events.jsonl`. The CLI appends
 * `command.invoked` lines to the same file when the user has opted in
 * (`telemetryEnabled: true` in agent.yaml), so the open telemetry log is
 * the single audit surface for both daemon events and command usage.
 *
 * Local-first: reading the flag and appending a line are best-effort and
 * never block or fail the command. No daemon round-trip, no auth needed.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSimpleYaml } from "@signet/core";

export const TELEMETRY_EVENT = "command.invoked";

/**
 * Resolve the shared open-telemetry log path, mirroring the daemon's
 * `defaultTelemetryLogPath` (issue #1026).
 */
export function cliTelemetryLogPath(agentsDir: string): string {
	return join(agentsDir, ".daemon", "telemetry", "events.jsonl");
}

/** True when the user has opted into anonymous telemetry in agent.yaml. */
export function cliTelemetryEnabled(agentsDir: string): boolean {
	try {
		const yamlPath = join(agentsDir, "agent.yaml");
		if (!existsSync(yamlPath)) return false;
		const config = parseSimpleYaml(readFileSync(yamlPath, "utf-8"));
		const pipeline = config?.pipelineV2 as Record<string, unknown> | undefined;
		return pipeline?.telemetryEnabled === true;
	} catch {
		return false;
	}
}

/**
 * Append a `command.invoked` line to the open telemetry log when telemetry
 * is enabled. Payload is the command name only — never arguments. Best-effort.
 */
export function recordCommandInvoked(agentsDir: string, commandName: string): void {
	try {
		if (!cliTelemetryEnabled(agentsDir)) return;
		const logPath = cliTelemetryLogPath(agentsDir);
		mkdirSync(dirname(logPath), { recursive: true });
		const line = JSON.stringify({
			id: crypto.randomUUID(),
			event: TELEMETRY_EVENT,
			timestamp: new Date().toISOString(),
			properties: { command: commandName },
		});
		appendFileSync(logPath, `${line}\n`, "utf-8");
	} catch {
		// Never break the command on telemetry write failures.
	}
}
