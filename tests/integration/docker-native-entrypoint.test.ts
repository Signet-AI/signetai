import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

describe("compiled native Docker entrypoint", () => {
	it("delegates only to the packaged native daemon and fails closed when absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-native-entrypoint-"));
		const marker = join(dir, "marker");
		const daemon = join(dir, "signet-daemon");
		writeFileSync(daemon, `#!/bin/sh\nprintf native > ${marker}\nexit 23\n`);
		chmodSync(daemon, 0o755);

		const cli = join(import.meta.dir, "../../surfaces/cli/dist/cli.js");
		const delegated = spawnSync("node", [cli], {
			env: { ...process.env, SIGNET_DAEMON_ENTRYPOINT: "1", SIGNET_DAEMON_PATH: daemon },
			encoding: "utf8",
		});
		expect(delegated.status).toBe(23);
		expect(delegated.stderr).not.toContain("daemon.js");
		expect(Bun.file(marker).text()).resolves.toBe("native");

		const missing = spawnSync("node", [cli], {
			env: { ...process.env, SIGNET_DAEMON_ENTRYPOINT: "1", SIGNET_DAEMON_PATH: join(dir, "missing") },
			encoding: "utf8",
		});
		expect(missing.status).not.toBe(0);
		expect(missing.stderr).toContain("Native daemon");
	});

	it("forwards container termination to the native daemon and exits with its status", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-native-entrypoint-signal-"));
		const marker = join(dir, "term-marker");
		const daemon = join(dir, "signet-daemon");
		writeFileSync(
			daemon,
			`#!/bin/sh\ntrap 'printf terminated > ${marker}; exit 0' TERM INT\nwhile :; do sleep 1; done\n`,
		);
		chmodSync(daemon, 0o755);

		const cli = join(import.meta.dir, "../../surfaces/cli/dist/cli.js");
		const child = Bun.spawn(["node", cli], {
			env: { ...process.env, SIGNET_DAEMON_ENTRYPOINT: "1", SIGNET_DAEMON_PATH: daemon },
			stdout: "ignore",
			stderr: "ignore",
		});
		await Bun.sleep(1_000);
		child.kill("SIGTERM");
		expect(await child.exited).toBe(0);
		expect(await Bun.file(marker).text()).toBe("terminated");
	});
});
