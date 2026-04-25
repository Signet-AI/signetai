import { afterEach, describe, expect, test } from "bun:test";
import { createDaemonClient } from "./daemon.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("createDaemonClient", () => {
	test("fetchDaemonResult uses SIGNET_DAEMON_URL when configured", async () => {
		const previous = process.env.SIGNET_DAEMON_URL;
		process.env.SIGNET_DAEMON_URL = "http://192.168.0.60:3850/";
		let seenUrl = "";
		globalThis.fetch = async (input) => {
			seenUrl = String(input);
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		try {
			const client = createDaemonClient(3850);
			await client.fetchDaemonResult("/api/hooks/session-start");

			expect(client.url).toBe("http://192.168.0.60:3850");
			expect(seenUrl).toBe("http://192.168.0.60:3850/api/hooks/session-start");
		} finally {
			if (previous === undefined) Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
			else process.env.SIGNET_DAEMON_URL = previous;
		}
	});

	test("rejects invalid SIGNET_DAEMON_URL instead of falling back to localhost", () => {
		const previous = process.env.SIGNET_DAEMON_URL;
		process.env.SIGNET_DAEMON_URL = "ssh://192.168.0.60:3850";

		try {
			expect(() => createDaemonClient(3850)).toThrow("SIGNET_DAEMON_URL must use http or https");
		} finally {
			if (previous === undefined) Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
			else process.env.SIGNET_DAEMON_URL = previous;
		}
	});

	test("fetchDaemonResult uses SIGNET_HOST and SIGNET_PORT when no daemon URL is configured", async () => {
		const previousUrl = process.env.SIGNET_DAEMON_URL;
		const previousHost = process.env.SIGNET_HOST;
		const previousPort = process.env.SIGNET_PORT;
		Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
		process.env.SIGNET_HOST = "192.168.0.60";
		process.env.SIGNET_PORT = "3850";
		let seenUrl = "";
		globalThis.fetch = async (input) => {
			seenUrl = String(input);
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		try {
			const client = createDaemonClient(3000);
			await client.fetchDaemonResult("/api/status");

			expect(client.url).toBe("http://192.168.0.60:3850");
			expect(seenUrl).toBe("http://192.168.0.60:3850/api/status");
		} finally {
			if (previousUrl === undefined) Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
			else process.env.SIGNET_DAEMON_URL = previousUrl;
			if (previousHost === undefined) Reflect.deleteProperty(process.env, "SIGNET_HOST");
			else process.env.SIGNET_HOST = previousHost;
			if (previousPort === undefined) Reflect.deleteProperty(process.env, "SIGNET_PORT");
			else process.env.SIGNET_PORT = previousPort;
		}
	});

	test("rejects invalid SIGNET_PORT instead of falling back to the default port", () => {
		const previousUrl = process.env.SIGNET_DAEMON_URL;
		const previousPort = process.env.SIGNET_PORT;
		Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
		process.env.SIGNET_PORT = "nope";

		try {
			expect(() => createDaemonClient(3850)).toThrow("SIGNET_PORT must be an integer");
		} finally {
			if (previousUrl === undefined) Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
			else process.env.SIGNET_DAEMON_URL = previousUrl;
			if (previousPort === undefined) Reflect.deleteProperty(process.env, "SIGNET_PORT");
			else process.env.SIGNET_PORT = previousPort;
		}
	});

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
