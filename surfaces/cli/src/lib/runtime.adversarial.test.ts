import { describe, expect, it } from "bun:test";
import { buildLaunchdDaemonPlist, buildSystemdDaemonStartArgs, resolveDaemonLaunchCommand } from "./runtime.js";

describe("native production launch remains fail-closed", () => {
	it("keeps explicit compiled production launch fail-closed for JavaScript paths", () => {
		const daemonPath = "/opt/signet/runtime/daemon-js/daemon.js";
		expect(() => resolveDaemonLaunchCommand(daemonPath, {}, "compiled")).toThrow(
			"Native Signet daemon executable is required",
		);
		expect(() =>
			buildSystemdDaemonStartArgs({
				daemonPath,
				runtime: "compiled",
				agentsDir: "/tmp/agents",
				port: 3850,
				host: "127.0.0.1",
				bind: "127.0.0.1",
				startupLogPath: "/tmp/daemon.log",
			}),
		).toThrow("Native Signet daemon executable is required");
		expect(() =>
			buildLaunchdDaemonPlist({
				daemonPath,
				runtime: "compiled",
				agentsDir: "/tmp/agents",
				port: 3850,
				host: "127.0.0.1",
				bind: "127.0.0.1",
				startupLogPath: "/tmp/daemon.log",
			}),
		).toThrow("Native Signet daemon executable is required");
	});

	it("preserves omitted-runtime helper compatibility for JavaScript paths", () => {
		const daemonPath = "/opt/signet/runtime/daemon-js/daemon.js";
		expect(resolveDaemonLaunchCommand(daemonPath, {})).toHaveLength(2);
	});

	it("keeps explicit compiled selection native", () => {
		expect(resolveDaemonLaunchCommand("/opt/signet/bin/signet", {}, "compiled")).toEqual(["/opt/signet/bin/signet"]);
	});
});
