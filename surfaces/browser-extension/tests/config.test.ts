import { describe, expect, test } from "bun:test";
import { getConfig, migrateDaemonUrl } from "../src/shared/config.js";

describe("browser extension daemon URL migration", () => {
	test("rewrites stored localhost URLs to the permissioned loopback origin", () => {
		expect(migrateDaemonUrl("http://localhost:3850")).toBe("http://127.0.0.1:3850");
		expect(migrateDaemonUrl("http://localhost:3850/")).toBe("http://127.0.0.1:3850");
	});

	test("persists the migrated URL when reading an existing localhost config", async () => {
		const writes: Array<Record<string, unknown>> = [];
		const stored = { signet_config: { daemonUrl: "http://localhost:3850", authToken: "token", theme: "auto" } };
		Object.assign(globalThis, {
			chrome: {
				storage: {
					local: {
						get: (_keys: readonly string[], callback: (value: typeof stored) => void) => callback(stored),
						set: (value: Record<string, unknown>, callback: () => void) => {
							writes.push(value);
							callback();
						},
					},
				},
			},
		});

		expect(await getConfig()).toEqual({
			daemonUrl: "http://127.0.0.1:3850",
			authToken: "token",
			theme: "auto",
		});
		expect(writes).toEqual([
			{
				signet_config: {
					daemonUrl: "http://127.0.0.1:3850",
					authToken: "token",
					theme: "auto",
				},
			},
		]);
	});

	test("preserves non-localhost daemon URLs", () => {
		expect(migrateDaemonUrl("https://signet.example.com:8443")).toBe("https://signet.example.com:8443");
		expect(migrateDaemonUrl("not a URL")).toBe("not a URL");
	});
});
