import { describe, expect, it } from "bun:test";
import { buildLaunchdDaemonPlist, buildSystemdDaemonStartArgs, resolveDaemonLaunchCommand } from "./runtime.js";

describe("native production launch remains fail-closed", () => {
	it("does not infer Bun-JS from an omitted runtime and JavaScript path", () => {
		const daemonPath = "/opt/signet/runtime/daemon-js/daemon.js";
		expect(() => resolveDaemonLaunchCommand(daemonPath, {})).toThrow("Native Signet daemon executable is required");
		expect(buildSystemdDaemonStartArgs({ daemonPath, agentsDir: "/tmp/agents", port: 3850, host: "127.0.0.1", bind: "127.0.0.1", startupLogPath: "/tmp/daemon.log" })).not.toContain("--setenv=SIGNET_DAEMON_RUNTIME=bun-js");
		expect(() => buildLaunchdDaemonPlist({ daemonPath, agentsDir: "/tmp/agents", port: 3850, host: "127.0.0.1", bind: "127.0.0.1", startupLogPath: "/tmp/daemon.log" })).toThrow("Native Signet daemon executable is required");
	});

	it("keeps explicit compiled selection native", () => {
		expect(resolveDaemonLaunchCommand("/opt/signet/bin/signet", {}, "compiled")).toEqual(["/opt/signet/bin/signet"]);
	});
});
