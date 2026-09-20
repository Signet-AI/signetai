import { describe, expect, test } from "bun:test";
import { parseDaemonRuntime, resolveDaemonRuntime } from "./daemon-runtime";

describe("daemon runtime selection", () => {
	test("defaults to the compiled runtime", () => {
		expect(resolveDaemonRuntime(undefined, {})).toBe("compiled");
	});

	test("reads the environment when no explicit value is provided", () => {
		expect(resolveDaemonRuntime(undefined, { SIGNET_DAEMON_RUNTIME: "bun-js" })).toBe("bun-js");
	});

	test("explicit values take precedence over the environment", () => {
		expect(resolveDaemonRuntime("compiled", { SIGNET_DAEMON_RUNTIME: "bun-js" })).toBe("compiled");
	});

	test("rejects unsupported values", () => {
		expect(parseDaemonRuntime("node")).toBeNull();
		expect(parseDaemonRuntime("BUN-JS")).toBeNull();
		expect(() => resolveDaemonRuntime("node", {})).toThrow("Choose one of: compiled, bun-js");
		expect(() => resolveDaemonRuntime(" ", {})).toThrow("Choose one of: compiled, bun-js");
	});
});
