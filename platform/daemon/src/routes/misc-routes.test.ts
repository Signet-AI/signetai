import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
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
