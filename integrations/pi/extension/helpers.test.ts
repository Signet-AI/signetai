import { afterEach, describe, expect, it } from "bun:test";
import { readRuntimeEnv, readTrimmedRuntimeEnv } from "@signet/pi-extension-base";

const originalEnv = {
	SIGNET_AGENT_ID: process.env.SIGNET_AGENT_ID,
	SIGNET_DAEMON_URL: process.env.SIGNET_DAEMON_URL,
};

afterEach(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("runtime env helpers", () => {
	it("trims whitespace-only runtime env values to undefined", () => {
		process.env.SIGNET_AGENT_ID = "   ";
		process.env.SIGNET_DAEMON_URL = "\n\t";

		expect(readRuntimeEnv("SIGNET_AGENT_ID")).toBe("   ");
		expect(readTrimmedRuntimeEnv("SIGNET_AGENT_ID")).toBeUndefined();
		expect(readTrimmedRuntimeEnv("SIGNET_DAEMON_URL")).toBeUndefined();
	});

	it("returns trimmed runtime env values when present", () => {
		process.env.SIGNET_AGENT_ID = " agent-123 ";
		process.env.SIGNET_DAEMON_URL = " http://127.0.0.1:3850 ";

		expect(readTrimmedRuntimeEnv("SIGNET_AGENT_ID")).toBe("agent-123");
		expect(readTrimmedRuntimeEnv("SIGNET_DAEMON_URL")).toBe("http://127.0.0.1:3850");
	});
});
