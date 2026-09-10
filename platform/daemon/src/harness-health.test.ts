import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runHarnessInspection, stopHarnessHealth } from "./harness-health";

const request = (id: string) => ({ id, configured: true, lastSeen: null });

test("a blocked connector cannot block the parent event loop or suppress another result; timeout joins its worker", async () => {
	const dir = mkdtempSync("/tmp/signet-health-proof-");
	const entrypoint = join(dir, "worker.ts");
	writeFileSync(
		entrypoint,
		`
import { parentPort, workerData } from "node:worker_threads";
setInterval(() => {}, 1000);
import { inspectRegisteredConnector } from ${JSON.stringify(join(import.meta.dir, "harness-registry.ts"))};
class Connector {
 name = "fixture";
 getConfigPath() { if (workerData.id === "blocked") { while (true) {} } return ""; }
 isDetected() { return true; }
 isInstalled() { return true; }
 async inspectHealth() { if (workerData.id === "pending") await new Promise(() => {}); return {status:"healthy",message:"Probe passed"}; }
}
parentPort.postMessage(await inspectRegisteredConnector(workerData.id, async () => Connector, true, null, new Date().toISOString()));
parentPort.close();
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
