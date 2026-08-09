import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../sqlite";
import {
	cliTelemetryDeployment,
	cliTelemetryDeploymentRole,
	cliTelemetryEnabled,
	cliTelemetryInstallChannel,
	cliTelemetryLogPath,
	flushCliTelemetry,
	recordCommandInvoked,
} from "./telemetry";

let dir = "";
const originalFetch = globalThis.fetch;

function writeAgentYaml(telemetryEnabled?: boolean): void {
	const telemetryLine = telemetryEnabled === undefined ? "" : `telemetryEnabled: ${telemetryEnabled}`;
	writeFileSync(
		join(dir, "agent.yaml"),
		`version: 1\nschema: signet/v1\nmemory:\n  pipelineV2:\n    ${telemetryLine || "# no telemetry"}\n`,
		"utf-8",
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "signet-cli-telemetry-"));
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	process.env.SIGNET_TELEMETRY_OPTOUT = undefined;
	rmSync(dir, { recursive: true, force: true });
});

describe("cli telemetry (issue #1206)", () => {
	it("is enabled by default when agent.yaml has no telemetryEnabled", () => {
		writeAgentYaml();
		expect(cliTelemetryEnabled(dir)).toBe(true);
	});

	it("is disabled when telemetryEnabled is false", () => {
		writeAgentYaml(false);
		expect(cliTelemetryEnabled(dir)).toBe(false);
	});

	it("is enabled when telemetryEnabled is true", () => {
		writeAgentYaml(true);
		expect(cliTelemetryEnabled(dir)).toBe(true);
	});

	it("honors the shared runtime opt-out", () => {
		writeAgentYaml(true);
		process.env.SIGNET_TELEMETRY_OPTOUT = "1";
		expect(cliTelemetryEnabled(dir)).toBe(false);
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

	it("tags development command events", () => {
		writeAgentYaml(true);
		expect(cliTelemetryDeployment({})).toBeUndefined();
		expect(cliTelemetryDeployment({ SIGNET_TELEMETRY_ENV: "DEV" })).toBe("dev");
		recordCommandInvoked(dir, "remember", { SIGNET_TELEMETRY_ENV: "dev" });
		const line = JSON.parse(readFileSync(cliTelemetryLogPath(dir), "utf-8").trim()) as {
			properties: { deployment: string; deploymentRole: string; installChannel: string };
		};
		expect(line.properties.deployment).toBe("dev");
		expect(line.properties.deploymentRole).toBe("development");
		expect(line.properties.installChannel).toBe("unknown");
	});

	it("accepts only bounded explicit role and channel declarations", () => {
		expect(cliTelemetryDeploymentRole("service", {})).toBe("service");
		expect(cliTelemetryInstallChannel("container", {})).toBe("container");
		expect(cliTelemetryDeploymentRole("service", { SIGNET_TELEMETRY_DEPLOYMENT_ROLE: "CI" })).toBe("ci");
		expect(cliTelemetryInstallChannel("container", { SIGNET_TELEMETRY_INSTALL_CHANNEL: "bad" })).toBe("container");
		expect(cliTelemetryDeploymentRole("bad", {})).toBe("unknown");
		expect(cliTelemetryInstallChannel("bad", {})).toBe("unknown");
	});

	it("honors the runtime telemetry opt-out", () => {
		writeAgentYaml(true);
		expect(cliTelemetryEnabled(dir, { SIGNET_TELEMETRY_OPTOUT: "1" })).toBe(false);
		recordCommandInvoked(dir, "remember", { SIGNET_TELEMETRY_OPTOUT: "true" });
		expect(existsSync(cliTelemetryLogPath(dir))).toBe(false);
	});

	it("does not write anything when telemetry is disabled", () => {
		writeAgentYaml(false);
		recordCommandInvoked(dir, "remember");
		expect(existsSync(cliTelemetryLogPath(dir))).toBe(false);
	});

	it("flushes queued events with the daemon's persisted install id", async () => {
		writeAgentYaml(true);
		const memoryDir = join(dir, "memory");
		mkdirSync(memoryDir, { recursive: true });
		const db = createDatabase(join(memoryDir, "memories.db"));
		db.exec(`
			CREATE TABLE telemetry_install (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
			CREATE TABLE telemetry_events (
				id TEXT PRIMARY KEY,
				event TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				properties TEXT NOT NULL,
				sent_to_posthog INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				source TEXT NOT NULL DEFAULT 'daemon',
				claim_token TEXT,
				claimed_at TEXT
			);
			INSERT INTO telemetry_install (id, created_at) VALUES ('install-from-daemon', '2026-01-01T00:00:00.000Z');
		`);
		db.close();

		recordCommandInvoked(dir, "remember");
		const request: { current: { api_key: string; batch: Array<{ distinct_id: string; event: string }> } | null } = {
			current: null,
		};
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			request.current = JSON.parse(String(init?.body ?? "{}")) as {
				api_key: string;
				batch: Array<{ distinct_id: string; event: string }>;
			};
			return new Response("1", { status: 200 });
		}) as typeof fetch;

		await flushCliTelemetry(dir, "0.176.8");

		expect(request.current?.api_key).toBe("phc_mLsvJmbmp6e9UarrX9Cq5QtTjVNiiphM9mvi5Xnddd8Q");
		expect(request.current?.batch).toHaveLength(1);
		expect(request.current?.batch[0]?.event).toBe("command.invoked");
		expect(request.current?.batch[0]?.distinct_id).toBe("install-from-daemon");

		const check = createDatabase(join(memoryDir, "memories.db"), { readonly: true });
		const row = check.prepare("SELECT sent_to_posthog FROM telemetry_events").get() as { sent_to_posthog: number };
		expect(row.sent_to_posthog).toBe(1);
		check.close();
	});

	it("claims CLI rows so overlapping flushes send each event once", async () => {
		writeAgentYaml(true);
		const memoryDir = join(dir, "memory");
		mkdirSync(memoryDir, { recursive: true });
		const db = createDatabase(join(memoryDir, "memories.db"));
		db.exec(`
			CREATE TABLE telemetry_install (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
			CREATE TABLE telemetry_events (
				id TEXT PRIMARY KEY,
				event TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				properties TEXT NOT NULL,
				sent_to_posthog INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				source TEXT NOT NULL DEFAULT 'daemon',
				claim_token TEXT,
				claimed_at TEXT
			);
			INSERT INTO telemetry_install (id, created_at) VALUES ('install-from-daemon', '2026-01-01T00:00:00.000Z');
		`);
		db.close();

		recordCommandInvoked(dir, "status");
		let calls = 0;
		let enteredResolve = (): void => {};
		const entered = new Promise<void>((resolve) => {
			enteredResolve = resolve;
		});
		let releaseResolve = (): void => {};
		const release = new Promise<void>((resolve) => {
			releaseResolve = resolve;
		});
		globalThis.fetch = (async () => {
			calls++;
			enteredResolve();
			await release;
			return new Response("1", { status: 200 });
		}) as unknown as typeof fetch;

		const first = flushCliTelemetry(dir, "0.176.9");
		await entered;
		const second = flushCliTelemetry(dir, "0.176.9");
		releaseResolve();
		await Promise.all([first, second]);

		expect(calls).toBe(1);
		const check = createDatabase(join(memoryDir, "memories.db"), { readonly: true });
		const row = check.prepare("SELECT sent_to_posthog, claim_token FROM telemetry_events").get() as {
			sent_to_posthog: number;
			claim_token: string | null;
		};
		expect(row.sent_to_posthog).toBe(1);
		expect(row.claim_token).toBeNull();
		check.close();
	});

	it("never throws when the agents dir is missing", () => {
		expect(() => recordCommandInvoked(join(dir, "missing"), "status")).not.toThrow();
	});
});
