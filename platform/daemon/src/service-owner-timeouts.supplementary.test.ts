import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateLaunchdPlist } from "./service";

test("copies and validates DB-owner timeouts in the launchd plist", () => {
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
