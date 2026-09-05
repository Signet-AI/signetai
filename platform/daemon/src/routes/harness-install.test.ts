import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.platform === "win32")(
	"installer rejects unauthorized requests and drains cancelled worker processes",
	() => {
		const home = mkdtempSync(join(tmpdir(), "signet-install-proof-"));
		const fixture = join(home, "proof.ts");
		writeFileSync(
			fixture,
			`
 import { strict as assert } from "node:assert";
 import { writeFileSync, readFileSync, existsSync } from "node:fs";
 import { Hono } from ${JSON.stringify(require.resolve("hono"))};
 import { installHarness, registerHarnessInstallRoutes, stopHarnessInstall } from ${JSON.stringify(join(import.meta.dir, "harness-install.ts"))};
 import { authConfig } from ${JSON.stringify(join(import.meta.dir, "state.ts"))};
 const app = new Hono(); registerHarnessInstallRoutes(app);
 authConfig.mode = "team";
 assert.equal((await app.request("/api/harnesses/claude-code/connect",{method:"POST"})).status,403);
 authConfig.mode = "local";
 assert.equal((await app.request("/api/harnesses/unknown/connect",{method:"POST"})).status,400);
 const worker = ${JSON.stringify(join(home, "worker"))};
 const pidFile = ${JSON.stringify(join(home, "pid"))};
 process.execPath = worker;
 writeFileSync(worker, ${JSON.stringify("#!/bin/sh\necho SIGNET_INSTALL_RESULT success\n")}, {mode:0o755});
 assert.equal((await app.request("/api/harnesses/claude-code/connect",{method:"POST"})).status,200);
 writeFileSync(worker, '#!/bin/sh\\necho $$ > '+pidFile+'\\nsleep 60 &\\nwait\\n',{mode:0o755});
 const abort = new AbortController();
 const pending = installHarness("claude-code",abort.signal);
 const rejected = assert.rejects(pending,/cancelled/);
 for(let i=0;i<100&&!existsSync(pidFile);i++) await Bun.sleep(10);
 const pid = Number(readFileSync(pidFile,"utf8").trim());
 assert.equal((await app.request("/api/harnesses/codex/connect",{method:"POST"})).status,409);
 await stopHarnessInstall(); await rejected;
 assert.throws(()=>process.kill(pid,0));
 writeFileSync(worker,'#!/bin/sh\\nexit 1\\n',{mode:0o755});
 await assert.rejects(installHarness("claude-code",new AbortController().signal),/failed/);
 console.log("permission, admission, success, shutdown cancellation, process cleanup, and failure passed");
 const {logger} = await import(${JSON.stringify(join(import.meta.dir, "../logger.ts"))}); logger.shutdown();
 `,
		);
		try {
			const result = spawnSync(process.execPath, [fixture], {
				env: { PATH: process.env.PATH, HOME: home, SIGNET_PATH: join(home, ".agents") },
				encoding: "utf8",
				timeout: 15_000,
			});
			expect(result.status, result.stdout + result.stderr).toBe(0);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	},
	20_000,
);
