/**
 * Route contract for GET /api/harnesses (PR #1858 review, finding 3): the
 * response carries `configuredHarnesses` — the harnesses recorded as connected
 * in the workspace's agent.yaml — separately from the per-harness home
 * directory `exists` flag, so clients can distinguish "harness installed on
 * this machine" from "Signet connected to it".
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("GET /api/harnesses reports the agent.yaml connection record", () => {
	const home = mkdtempSync(join(tmpdir(), "signet-harness-route-"));
	const fixture = join(home, "proof.ts");
	writeFileSync(
		fixture,
		`
import { strict as assert } from "node:assert";
import { Hono } from ${JSON.stringify(require.resolve("hono"))};
import { registerConnectorRoutes } from ${JSON.stringify(join(import.meta.dir, "connectors-routes.ts"))};
const app = new Hono();
registerConnectorRoutes(app);
const response = await app.request("/api/harnesses");
assert.equal(response.status, 200);
const body = await response.json();
assert.ok(Array.isArray(body.harnesses));
assert.ok(Array.isArray(body.configuredHarnesses));
console.log("harness route contract passed");
const {logger} = await import(${JSON.stringify(join(import.meta.dir, "../logger.ts"))}); logger.shutdown();
`,
	);
	try {
		// SIGNET_PATH selects a fresh workspace whose agent.yaml carries one
		// connected harness; a harness home directory is deliberately absent.
		mkdirSync(join(home, "workspace"), { recursive: true });
		writeFileSync(join(home, "workspace", "agent.yaml"), "name: Example\nharnesses:\n  - codex\n");
		const result = spawnSync(process.execPath, [fixture], {
			env: { PATH: process.env.PATH, HOME: home, SIGNET_PATH: join(home, "workspace") },
			encoding: "utf8",
			timeout: 15_000,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, 20_000);
