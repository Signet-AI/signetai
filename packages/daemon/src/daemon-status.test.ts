import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

let app: Hono;
let dir = "";
let prev: string | undefined;
let countConnectorsActive: (connectors: readonly { readonly status: string }[]) => number;

describe("daemon status contract", () => {
	beforeAll(async () => {
		prev = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-daemon-status-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: true
`,
		);
		process.env.SIGNET_PATH = dir;

		const daemon = await import("./daemon");
		const state = await import("./routes/state.js");
		state.reloadAuthState(dir);
		app = daemon.app;
		countConnectorsActive = daemon.countConnectorsActive;
	});

	afterAll(() => {
		if (prev === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
		}
		if (prev !== undefined) process.env.SIGNET_PATH = prev;
		rmSync(dir, { recursive: true, force: true });
	});

	it("exposes extraction worker load-shedding fields on /api/status", async () => {
		const res = await app.request("http://localhost/api/status");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			pipeline?: {
				extraction?: {
					running?: unknown;
					overloaded?: unknown;
					loadPerCpu?: unknown;
					maxLoadPerCpu?: unknown;
					overloadBackoffMs?: unknown;
					overloadSince?: unknown;
					nextTickInMs?: unknown;
				};
			};
		};
		const extraction = body.pipeline?.extraction;
		expect(typeof extraction?.running).toBe("boolean");
		expect(typeof extraction?.overloaded).toBe("boolean");
		expect(extraction).toHaveProperty("maxLoadPerCpu");
		expect(extraction).toHaveProperty("overloadBackoffMs");
		expect(extraction?.maxLoadPerCpu === null || typeof extraction?.maxLoadPerCpu === "number").toBe(true);
		expect(extraction?.overloadBackoffMs === null || typeof extraction?.overloadBackoffMs === "number").toBe(true);
		expect(extraction).toHaveProperty("loadPerCpu");
		expect(extraction).toHaveProperty("overloadSince");
		expect(extraction).toHaveProperty("nextTickInMs");
	});

	it("exposes providerResolution.extraction runtime fields on /api/status", async () => {
		const res = await app.request("http://localhost/api/status");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			providerResolution?: {
				extraction?: {
					configured?: unknown;
					resolved?: unknown;
					effective?: unknown;
					fallbackProvider?: unknown;
					status?: unknown;
					degraded?: unknown;
					fallbackApplied?: unknown;
					reason?: unknown;
					since?: unknown;
				};
			};
		};
		const extraction = body.providerResolution?.extraction;
		expect(extraction).toBeDefined();
		expect(typeof extraction?.resolved).toBe("string");
		expect(typeof extraction?.effective).toBe("string");
		expect(
			extraction?.fallbackProvider === "ollama" ||
				extraction?.fallbackProvider === "llama-cpp" ||
				extraction?.fallbackProvider === "none",
		).toBe(true);
		expect(
			extraction?.status === "active" ||
				extraction?.status === "degraded" ||
				extraction?.status === "blocked" ||
				extraction?.status === "disabled" ||
				extraction?.status === "paused",
		).toBe(true);
		expect(typeof extraction?.degraded).toBe("boolean");
		expect(typeof extraction?.fallbackApplied).toBe("boolean");
		expect(extraction).toHaveProperty("reason");
		expect(extraction).toHaveProperty("since");
	});

	it("counts non-errored connectors as active for heartbeat telemetry", () => {
		expect(countConnectorsActive([{ status: "idle" }, { status: "syncing" }, { status: "error" }])).toBe(2);
	});
});
