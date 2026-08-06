import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliTelemetryEnabled, cliTelemetryLogPath, recordCommandInvoked } from "./telemetry";

let dir = "";

function writeAgentYaml(telemetryEnabled?: boolean): void {
	const telemetryLine = telemetryEnabled === undefined ? "" : `telemetryEnabled: ${telemetryEnabled}`;
	writeFileSync(
		join(dir, "agent.yaml"),
		`version: 1\nschema: signet/v1\npipelineV2:\n  ${telemetryLine || "# no telemetry"}\n`,
		"utf-8",
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "signet-cli-telemetry-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("cli telemetry (issue #1026 Phase 2)", () => {
	it("is disabled when agent.yaml has no telemetryEnabled", () => {
		writeAgentYaml();
		expect(cliTelemetryEnabled(dir)).toBe(false);
	});

	it("is disabled when telemetryEnabled is false", () => {
		writeAgentYaml(false);
		expect(cliTelemetryEnabled(dir)).toBe(false);
	});

	it("is enabled when telemetryEnabled is true", () => {
		writeAgentYaml(true);
		expect(cliTelemetryEnabled(dir)).toBe(true);
	});

	it("is disabled when agent.yaml is missing", () => {
		expect(cliTelemetryEnabled(dir)).toBe(false);
	});

	it("records command.invoked to the shared log when enabled", () => {
		writeAgentYaml(true);
		recordCommandInvoked(dir, "remember");
		const logPath = cliTelemetryLogPath(dir);
		expect(existsSync(logPath)).toBe(true);
		const line = JSON.parse(readFileSync(logPath, "utf-8").trim()) as {
			event: string;
			properties: { command: string };
		};
		expect(line.event).toBe("command.invoked");
		expect(line.properties.command).toBe("remember");
	});

	it("does not write anything when telemetry is disabled", () => {
		writeAgentYaml(false);
		recordCommandInvoked(dir, "remember");
		expect(existsSync(cliTelemetryLogPath(dir))).toBe(false);
	});

	it("never throws when the agents dir is missing", () => {
		expect(() => recordCommandInvoked(join(dir, "missing"), "status")).not.toThrow();
	});
});
