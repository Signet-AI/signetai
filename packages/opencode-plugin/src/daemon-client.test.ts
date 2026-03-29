import { afterEach, describe, expect, test } from "bun:test";
import { createDaemonClient } from "./daemon-client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("createDaemonClient", () => {
	test("postResult classifies timeout failures separately from offline", async () => {
		globalThis.fetch = Object.assign(async () => {
			const err = new Error("timed out");
			Object.defineProperty(err, "name", { value: "TimeoutError" });
			throw err;
		}, {
			preconnect: originalFetch.preconnect,
		});

		const client = createDaemonClient("http://daemon.test");
		const result = await client.postResult("/api/hooks/session-start", {});

		expect(result).toEqual({ ok: false, reason: "timeout" });
	});

	test("postResult preserves http failures for session-start fallback callers", async () => {
		globalThis.fetch = Object.assign(
			async () =>
				new Response("bad gateway", {
					status: 502,
					headers: { "Content-Type": "text/plain" },
				}),
			{
				preconnect: originalFetch.preconnect,
			},
		);

		const client = createDaemonClient("http://daemon.test");
		const result = await client.postResult("/api/hooks/session-start", {});

		expect(result).toEqual({ ok: false, reason: "http", status: 502 });
	});
});
