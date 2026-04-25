import { describe, expect, test } from "bun:test";
import { resolveSignetDaemonUrl } from "./daemon-url.js";

describe("resolveSignetDaemonUrl", () => {
	test("normalizes explicit SIGNET_DAEMON_URL", () => {
		expect(resolveSignetDaemonUrl({ env: { SIGNET_DAEMON_URL: " https://signet.example.com:8443/ " } })).toBe(
			"https://signet.example.com:8443",
		);
	});

	test("resolves SIGNET_HOST and SIGNET_PORT when no explicit daemon URL is set", () => {
		expect(
			resolveSignetDaemonUrl({
				env: { SIGNET_HOST: "192.168.0.60", SIGNET_PORT: "3851" },
				defaultHost: "localhost",
				defaultPort: 3850,
			}),
		).toBe("http://192.168.0.60:3851");
	});

	test("supports IPv6 hosts from SIGNET_HOST", () => {
		expect(resolveSignetDaemonUrl({ env: { SIGNET_HOST: "::1", SIGNET_PORT: "3850" } })).toBe("http://[::1]:3850");
	});

	test("rejects explicit daemon URLs with shell-breaking path or query syntax", () => {
		expect(() =>
			resolveSignetDaemonUrl({
				env: { SIGNET_DAEMON_URL: 'http://192.168.0.60:3850/" && calc' },
			}),
		).toThrow("SIGNET_DAEMON_URL must point at the daemon origin");
		expect(() => resolveSignetDaemonUrl({ env: { SIGNET_DAEMON_URL: "http://192.168.0.60:3850/?x=1" } })).toThrow(
			"SIGNET_DAEMON_URL must not include query strings",
		);
	});

	test("rejects unsupported protocols and credential-bearing URLs", () => {
		expect(() => resolveSignetDaemonUrl({ env: { SIGNET_DAEMON_URL: "file:///tmp/signet.sock" } })).toThrow(
			"SIGNET_DAEMON_URL must use http or https",
		);
		expect(() => resolveSignetDaemonUrl({ env: { SIGNET_DAEMON_URL: "http://user:pass@192.168.0.60:3850" } })).toThrow(
			"SIGNET_DAEMON_URL must not include username or password",
		);
	});

	test("rejects invalid host and port overrides", () => {
		expect(() => resolveSignetDaemonUrl({ env: { SIGNET_HOST: "http://192.168.0.60" } })).toThrow(
			"SIGNET_HOST must be a hostname or IP address",
		);
		expect(() => resolveSignetDaemonUrl({ env: { SIGNET_HOST: '192.168.0.60"&&calc' } })).toThrow(
			"SIGNET_HOST must be a hostname or IP address",
		);
		expect(() => resolveSignetDaemonUrl({ env: { SIGNET_PORT: "70000" } })).toThrow("SIGNET_PORT must be an integer");
	});
});
