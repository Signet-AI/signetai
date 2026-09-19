import { describe, expect, test } from "bun:test";
import { parseDaemonRuntime, resolveDaemonRuntime } from "./daemon-runtime";

describe("daemon runtime selection", () => {
	test("defaults to the compiled runtime", () => {
		expect(resolveDaemonRuntime(undefined, {})).toBe("compiled");
	});

	test("reads the environment when no explicit value is provided", () => {
		expect(() => resolveDaemonRuntime(undefined, { SIGNET_DAEMON_RUNTIME: "legacy-js" })).toThrow(
			"native compiled daemon",
		);
	});

	test("explicit values take precedence over the environment", () => {
		expect(resolveDaemonRuntime("compiled", { SIGNET_DAEMON_RUNTIME: "legacy-js" })).toBe("compiled");
	});

	test("rejects unsupported values", () => {
		expect(parseDaemonRuntime("node")).toBeNull();
		expect(parseDaemonRuntime("LEGACY-JS")).toBeNull();
		expect(() => resolveDaemonRuntime("node", {})).toThrow("native compiled daemon");
		expect(() => resolveDaemonRuntime(" ", {})).toThrow("native compiled daemon");
	});
});
