import { describe, expect, test } from "bun:test";
import { resolveMcpDaemonUrl } from "./mcp-stdio-url.js";

describe("resolveMcpDaemonUrl", () => {
	test("normalizes IPv6-first localhost resolution for standalone MCP stdio", () => {
		expect(resolveMcpDaemonUrl({ SIGNET_DAEMON_URL: "http://localhost:3850" })).toBe("http://127.0.0.1:3850");
		expect(resolveMcpDaemonUrl({ SIGNET_HOST: "::1", SIGNET_PORT: "3850" })).toBe("http://127.0.0.1:3850");
	});

	test("preserves explicit IPv4-only client endpoints", () => {
		expect(resolveMcpDaemonUrl({ SIGNET_HOST: "127.0.0.1", SIGNET_PORT: "4123" })).toBe("http://127.0.0.1:4123");
	});
});
