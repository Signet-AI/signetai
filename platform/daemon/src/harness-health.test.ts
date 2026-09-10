import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { runHarnessInspection, stopHarnessHealth } from "./harness-health";

const request = (id: string) => ({ id, configured: true, lastSeen: null });

test("a blocked connector cannot block the parent event loop or suppress another result; timeout joins its child", async () => {
	const dir = mkdtempSync("/tmp/signet-health-proof-");
	const entrypoint = join(dir, "worker.ts");
	writeFileSync(
		entrypoint,
		`
import { readFileSync, writeFileSync } from "node:fs";
const workerData = JSON.parse(process.env.SIGNET_HEALTH_INSPECTION);
setInterval(() => {}, 1000);
import { inspectRegisteredConnector } from ${JSON.stringify(join(import.meta.dir, "harness-registry.ts"))};
class Connector {
 name = "fixture";
 getConfigPath() {
 if (workerData.id === "fifo") { writeFileSync(${JSON.stringify(join(dir, "started"))}, "ready"); readFileSync(${JSON.stringify(join(dir, "pipe"))}); }
 if (workerData.id === "blocked") { while (true) {} } return ""; }
 isDetected() { return true; }
 isInstalled() { return true; }
 async inspectHealth() { if (workerData.id === "pending") await new Promise(() => {}); return {status:"healthy",message:"Probe passed"}; }
}
console.log("SIGNET_HEALTH_RESULT " + JSON.stringify(await inspectRegisteredConnector(workerData.id, async () => Connector, true, null, new Date().toISOString())));

`,
	);
	try {
		let ticks = 0;
		const timer = setInterval(() => ticks++, 10);
		const blocked = runHarnessInspection(request("blocked"), { entrypoint, timeoutMs: 300 });
		const duplicate = await runHarnessInspection(request("blocked"), { entrypoint });
		expect(duplicate.health.message).toContain("already running");
		const healthy = await runHarnessInspection(request("healthy"), { entrypoint, timeoutMs: 2000 });
		expect(healthy.health.status).toBe("healthy");
		expect((await blocked).health.message).toContain("timed out");
		clearInterval(timer);
		expect(ticks).toBeGreaterThan(2);
		if (process.platform !== "win32") {
			execFileSync("mkfifo", [join(dir, "pipe")]);
			const fifo = runHarnessInspection(request("fifo"), { entrypoint, timeoutMs: 1000 });
			expect((await fifo).health.message).toContain("timed out");
			expect(existsSync(join(dir, "started"))).toBe(true);
		}
		// A resolved timeout releases admission only after termination.
		const retry = await runHarnessInspection(request("blocked"), { entrypoint, timeoutMs: 100 });
		expect(retry.health.message).toContain("timed out");
		const pending = await runHarnessInspection(request("pending"), { entrypoint, timeoutMs: 300 });
		expect(pending.health.message).toContain("timed out");
		const controller = new AbortController();
		const cancelled = runHarnessInspection(request("blocked"), { entrypoint, signal: controller.signal });
		controller.abort();
		expect((await cancelled).health.message).toContain("cancelled");
		const shutdown = runHarnessInspection(request("blocked"), { entrypoint });
		await stopHarnessHealth();
		expect((await shutdown).health.message).toContain("cancelled");
		expect((await runHarnessInspection(request("healthy"), { entrypoint })).health.message).toContain("cancelled");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test.skipIf(process.platform === "win32")(
	"the inspection child bounds native I/O even without a supervising daemon",
	() => {
		const dir = mkdtempSync("/tmp/signet-health-watchdog-");
		try {
			execFileSync("mkfifo", [join(dir, "config.yaml")]);
			const start = Date.now();
			const child = spawnSync(process.execPath, [join(import.meta.dir, "harness-health-worker.ts")], {
				env: { ...process.env, HERMES_HOME: dir, SIGNET_HEALTH_INSPECTION: JSON.stringify(request("hermes-agent")) },
				encoding: "utf8",
				timeout: 8000,
			});
			expect(child.error).toBeUndefined();
			expect(child.status).toBe(1);
			expect(Date.now() - start).toBeGreaterThan(4000);
			expect(child.stdout).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	10000,
);
