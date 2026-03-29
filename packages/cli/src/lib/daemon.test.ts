import { afterEach, describe, expect, test } from "bun:test";
import { createDaemonClient } from "./daemon.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("createDaemonClient", () => {
	test("secretApiCall returns structured failure when fetch rejects", async () => {
		globalThis.fetch = async () => {
			throw new Error("boom");
		};

		const client = createDaemonClient(3850);
		const result = await client.secretApiCall("GET", "/api/status");

		expect(result.ok).toBe(false);
		expect(result.data).toEqual({ error: "Could not reach Signet daemon" });
	});

	test("secretApiCall falls back to text error payload when response is not json", async () => {
		globalThis.fetch = async () =>
			new Response("bad gateway", {
				status: 502,
				headers: { "Content-Type": "text/plain" },
			});

		const client = createDaemonClient(3850);
		const result = await client.secretApiCall("GET", "/api/status");

		expect(result.ok).toBe(false);
		expect(result.data).toEqual({ error: "bad gateway" });
	});

	test("secretApiCall returns parsed json on success", async () => {
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ ok: true, value: 42 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		const client = createDaemonClient(3850);
		const result = await client.secretApiCall("GET", "/api/status");

		expect(result.ok).toBe(true);
		expect(result.data).toEqual({ ok: true, value: 42 });
	});

	test("fetchDaemonResult classifies timeout failures separately from offline", async () => {
		globalThis.fetch = async () => {
			const err = new Error("timed out");
			Object.defineProperty(err, "name", { value: "TimeoutError" });
			throw err;
		};

		const client = createDaemonClient(3850);
		const result = await client.fetchDaemonResult("/api/hooks/session-start");

		expect(result).toEqual({ ok: false, reason: "timeout" });
	});

	test("fetchDaemonResult preserves http failures for callers that need accurate fallback handling", async () => {
		globalThis.fetch = async () =>
			new Response("bad gateway", {
				status: 502,
				headers: { "Content-Type": "text/plain" },
			});

		const client = createDaemonClient(3850);
		const result = await client.fetchDaemonResult("/api/hooks/session-start");

		expect(result).toEqual({ ok: false, reason: "http", status: 502 });
	});
});
