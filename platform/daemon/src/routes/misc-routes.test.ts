import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { type LogEntry, logger } from "../logger";
import { getSseDiagnosticsSnapshot } from "../sse-stream";
import { registerMiscRoutes } from "./misc-routes";
import { loadDashboardIdentity } from "./dashboard-identity";

function withWorkspace(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "signet-dashboard-identity-"));
	try {
		mkdirSync(join(dir, "memory"), { recursive: true });
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("dashboard identity", () => {
	test("loads the agent name from modern agent.yaml", () => {
		withWorkspace((dir) => {
			writeFileSync(join(dir, "agent.yaml"), "agent:\n  name: My Agent\n  description: Personal AI assistant\n");

			expect(loadDashboardIdentity(dir)).toEqual({
				name: "My Agent",
				creature: "Personal AI assistant",
				vibe: "",
			});
		});
	});

	test("keeps legacy IDENTITY.md keys as a fallback", () => {
		withWorkspace((dir) => {
			writeFileSync(join(dir, "IDENTITY.md"), "- name: Legacy\n- creature: helper\n- vibe: direct\n");

			expect(loadDashboardIdentity(dir)).toEqual({
				name: "Legacy",
				creature: "helper",
				vibe: "direct",
			});
		});
	});

	test("keeps scheduled task endpoints removed", async () => {
		const app = new Hono();
		registerMiscRoutes(app);
		const endpoints: readonly (readonly [string, string])[] = [
			["GET", "/api/tasks"],
			["POST", "/api/tasks"],
			["GET", "/api/tasks/task-id"],
			["PATCH", "/api/tasks/task-id"],
			["DELETE", "/api/tasks/task-id"],
			["POST", "/api/tasks/task-id/run"],
			["GET", "/api/tasks/task-id/runs"],
			["GET", "/api/tasks/task-id/stream"],
		];
		for (const [method, path] of endpoints) {
			expect((await app.request(path, { method })).status).toBe(404);
		}
	});
});

describe("GET /api/logs/stream", () => {
	test("reports dropped entries after a slow reader resumes and releases its listener on cancel", async () => {
		const app = new Hono();
		registerMiscRoutes(app);
		const before = getSseDiagnosticsSnapshot();
		const listenerCount = getEventListeners(logger, "log").length;
		const response = await app.request("/api/logs/stream");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Log stream response did not expose a body");

		const connected = await reader.read();
		expect(connected.done).toBe(false);
		expect(new TextDecoder().decode(connected.value)).toContain('"type":"connected"');

		const entry: LogEntry = {
			timestamp: new Date().toISOString(),
			level: "info",
			category: "daemon",
			message: "x".repeat(50_000),
		};
		for (let index = 0; index < 20; index += 1) logger.emit("log", { ...entry, message: `${index}:${entry.message}` });

		let text = "";
		for (let index = 0; index < 12 && !text.includes("event: dropped"); index += 1) {
			const next = await reader.read();
			if (next.done) break;
			text += new TextDecoder().decode(next.value);
		}
		expect(text).toContain("event: dropped");
		expect(text).toMatch(/"count":\d+/);
		expect(getSseDiagnosticsSnapshot().droppedEventCount).toBeGreaterThan(before.droppedEventCount);

		await reader.cancel("test complete");
		expect(getEventListeners(logger, "log")).toHaveLength(listenerCount);
		expect(getSseDiagnosticsSnapshot().activeStreams).toBe(before.activeStreams);
	});
});
