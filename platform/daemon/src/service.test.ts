import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { generateLaunchdPlist, probeDaemonHealth } from "./service";

describe("daemon service health probe (#1340)", () => {
	it("uses the liveness endpoint with a bounded request", async () => {
		let url = "";
		let signal: AbortSignal | undefined;
		const result = await probeDaemonHealth(async (input, init) => {
			url = String(input);
			signal = init?.signal;
			return Response.json({ status: "healthy", uptime: 12, pid: 42 });
		});

		expect(url).toBe("http://127.0.0.1:3850/health/live");
		expect(signal).toBeDefined();
		expect(signal?.aborted).toBe(false);
		expect(result).toEqual({ status: "healthy", uptime: 12, pid: 42 });
	});

	it("reports a degraded status when the liveness probe times out", async () => {
		const result = await probeDaemonHealth((_input, init) => {
			const signal = init?.signal;
			if (!signal) return Promise.reject(new Error("health probe signal missing"));

			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});

		expect(result).toEqual({ status: "degraded", uptime: null, pid: null });
	});

	it("copies the DB-owner startup timeout into the launchd plist", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-service-timeout-test-"));
		const daemonPath = join(root, process.platform === "win32" ? "signet-daemon.exe" : "signet-daemon");
		writeFileSync(daemonPath, "native fixture");
		const previousDaemonPath = process.env.SIGNET_DAEMON_PATH;
		const previousTimeout = process.env.SIGNET_DB_OWNER_START_TIMEOUT_MS;
		const previousResponseTimeout = process.env.SIGNET_DB_OWNER_RESPONSE_TIMEOUT_MS;
		process.env.SIGNET_DAEMON_PATH = daemonPath;
		process.env.SIGNET_DB_OWNER_START_TIMEOUT_MS = "23000";
		process.env.SIGNET_DB_OWNER_RESPONSE_TIMEOUT_MS = "45000";
		try {
			const plist = generateLaunchdPlist();
			expect(plist).toContain("<key>SIGNET_DB_OWNER_START_TIMEOUT_MS</key>");
			expect(plist).toContain("<string>23000</string>");
			expect(plist).toContain("<key>SIGNET_DB_OWNER_RESPONSE_TIMEOUT_MS</key>");
			expect(plist).toContain("<string>45000</string>");
			process.env.SIGNET_DB_OWNER_RESPONSE_TIMEOUT_MS = ["45000", "ExecStart=/bin/false"].join("\n");
			expect(() => generateLaunchdPlist()).toThrow(/positive integer/);
		} finally {
			if (previousDaemonPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_DAEMON_PATH");
			else process.env.SIGNET_DAEMON_PATH = previousDaemonPath;
			if (previousTimeout === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_START_TIMEOUT_MS");
			else process.env.SIGNET_DB_OWNER_START_TIMEOUT_MS = previousTimeout;
			if (previousResponseTimeout === undefined)
				Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_RESPONSE_TIMEOUT_MS");
			else process.env.SIGNET_DB_OWNER_RESPONSE_TIMEOUT_MS = previousResponseTimeout;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
