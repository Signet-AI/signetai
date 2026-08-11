import { describe, expect, it } from "bun:test";
import { resolveDaemonRestartMode } from "./daemon-restart";

describe("daemon update restart handoff", () => {
	it("lets launchd KeepAlive restart after the old process releases the lock", () => {
		expect(resolveDaemonRestartMode({ SIGNET_DAEMON_SERVICE: "launchd" })).toBe("service-manager");
		expect(resolveDaemonRestartMode({})).toBe("replacement");
	});
});
