import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonAccessLines, resolveDaemonNetwork } from "./network.js";

const DIRS: string[] = [];

afterEach(() => {
	for (const dir of DIRS.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeDir(): string {
	const dir = join(tmpdir(), `signet-network-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	DIRS.push(dir);
	return dir;
}

describe("resolveDaemonNetwork", () => {
	test("uses tailscale mode from agent.yaml while keeping localhost as the primary host", () => {
		const dir = makeDir();
		writeFileSync(join(dir, "agent.yaml"), "network:\n  mode: tailscale\n");

		const net = resolveDaemonNetwork(dir, {});

		expect(net.host).toBe("127.0.0.1");
		expect(net.bind).toBe("0.0.0.0");
		expect(net.mode).toBe("tailscale");
	});

	test("prefers explicit environment overrides", () => {
		const dir = makeDir();
		writeFileSync(join(dir, "agent.yaml"), "network:\n  mode: tailscale\n");

		const net = resolveDaemonNetwork(dir, {
			SIGNET_HOST: "127.0.0.1",
			SIGNET_BIND: "127.0.0.1",
		});

		expect(net.host).toBe("127.0.0.1");
		expect(net.bind).toBe("127.0.0.1");
		expect(net.mode).toBe("localhost");
	});
});

describe("daemonAccessLines", () => {
	test("includes a tailnet hint when the daemon is remotely bound", () => {
		expect(daemonAccessLines(3850, { bindHost: "0.0.0.0" })).toEqual([
			"Dashboard: http://127.0.0.1:3850",
			"Tailnet: this machine's Tailscale IP on port 3850 (bind 0.0.0.0)",
		]);
	});
});
