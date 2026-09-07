import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("installs through a worker thread without spawning the Signet runtime", () => {
	const home = mkdtempSync(join(tmpdir(), "signet-install-proof-"));
	const fixture = join(home, "proof.ts");
	writeFileSync(
		fixture,
		`
 import { strict as assert } from "node:assert";
 import { readFileSync } from "node:fs";
 import { Hono } from ${JSON.stringify(require.resolve("hono"))};
 import { installHarness, registerHarnessInstallRoutes } from ${JSON.stringify(join(import.meta.dir, "harness-install.ts"))};
 import { authConfig } from ${JSON.stringify(join(import.meta.dir, "state.ts"))};
 const routeSource = readFileSync(${JSON.stringify(join(import.meta.dir, "harness-install.ts"))}, "utf8");
 assert.match(routeSource, /new Worker/);
 assert.doesNotMatch(routeSource, /process\\.execPath|spawnHidden|SIGNET_INSTALL_HARNESS/);
 const app = new Hono(); registerHarnessInstallRoutes(app);
 authConfig.mode = "team";
 assert.equal((await app.request("/api/harnesses/claude-code/connect", {method:"POST"})).status, 403);
 authConfig.mode = "local";
 assert.equal((await app.request("/api/harnesses/unknown/connect", {method:"POST"})).status, 400);
 assert.equal((await app.request("/api/harnesses/claude-code/connect", {method:"POST"})).status, 200);
 assert.ok(readFileSync(${JSON.stringify(join(home, ".claude", "settings.json"))}, "utf8").includes("hook session-start"));
 await installHarness("claude-code", new AbortController().signal);
 console.log("permission, worker-thread installation, and no internal runtime spawn passed");
 const {logger} = await import(${JSON.stringify(join(import.meta.dir, "../logger.ts"))}); logger.shutdown();
 `,
	);
	try {
		const result = spawnSync(process.execPath, [fixture], {
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				SIGNET_PATH: join(home, ".agents"),
			},
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, 40_000);
