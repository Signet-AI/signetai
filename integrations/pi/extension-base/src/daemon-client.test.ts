import { afterEach, describe, expect, test } from "bun:test";
import { type DaemonClientConfig, createDaemonClient } from "./daemon-client.js";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.SIGNET_API_KEY;

const testConfig: DaemonClientConfig = {
	logPrefix: "signet-pi",
	actorName: "pi-test",
	runtimePath: "plugin",
	defaultTimeout: 5000,
};

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalApiKey === undefined) Reflect.deleteProperty(process.env, "SIGNET_API_KEY");
	else process.env.SIGNET_API_KEY = originalApiKey;
});

describe("createDaemonClient (extension-base)", () => {
	test("postResult sends SIGNET_API_KEY as bearer auth", async () => {
		process.env.SIGNET_API_KEY = "sig_sk_extension_secret";
		let authorization = "";
		globalThis.fetch = Object.assign(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				authorization = new Headers(init?.headers).get("authorization") ?? "";
				return Response.json({ ok: true });
			},
			{ preconnect: originalFetch.preconnect },
		);

		const client = createDaemonClient("http://daemon.test", testConfig);
		await client.postResult("/api/hooks/session-start", {});
		expect(authorization).toBe("Bearer sig_sk_extension_secret");
	});

	test("postResult returns timeout when body read is aborted mid-stream", async () => {
		globalThis.fetch = Object.assign(
			async () => {
				const body = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"inje'));
						setTimeout(() => controller.error(Object.assign(new DOMException("signal timed out", "TimeoutError"))), 5);
					},
				});
				return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
			},
			{ preconnect: originalFetch.preconnect },
		);

		const client = createDaemonClient("http://daemon.test", testConfig);
		const result = await client.postResult("/api/hooks/user-prompt-submit", {});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("timeout");
		}
	});

	test("postResult classifies non-timeout body read failures separately from timeout", async () => {
		globalThis.fetch = Object.assign(
			async () => {
				const body = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"inje'));
						setTimeout(() => controller.error(new Error("stream reset")), 5);
					},
				});
				return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
			},
			{ preconnect: originalFetch.preconnect },
		);

		const client = createDaemonClient("http://daemon.test", testConfig);
		const result = await client.postResult("/api/hooks/user-prompt-submit", {});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("body-read");
		}
	});

	test("postResult returns invalid-json with diagnostic info for empty body", async () => {
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};

		globalThis.fetch = Object.assign(
			async () => new Response("", { status: 200, headers: { "Content-Type": "application/json" } }),
			{ preconnect: originalFetch.preconnect },
		);

		const client = createDaemonClient("http://daemon.test", testConfig);
		const result = await client.postResult("/api/hooks/user-prompt-submit", {});

		console.warn = originalWarn;

		expect(result).toEqual({ ok: false, reason: "invalid-json", status: 200 });
		expect(warnings.some((w) => w.includes("0 chars") && w.includes("empty body"))).toBe(true);
	});

	test("postResult parses valid JSON through text-first path", async () => {
		globalThis.fetch = Object.assign(async () => Response.json({ inject: "memory-context", memoryCount: 3 }), {
			preconnect: originalFetch.preconnect,
		});

		const client = createDaemonClient("http://daemon.test", testConfig);
		const result = await client.postResult<{ inject: string; memoryCount: number }>(
			"/api/hooks/user-prompt-submit",
			{},
		);

		expect(result).toEqual({ ok: true, data: { inject: "memory-context", memoryCount: 3 } });
	});

	test("postResult classifies connection-level timeout separately from offline", async () => {
		globalThis.fetch = Object.assign(
			async () => {
				const err = new Error("timed out");
				Object.defineProperty(err, "name", { value: "TimeoutError" });
				throw err;
			},
			{ preconnect: originalFetch.preconnect },
		);

		const client = createDaemonClient("http://daemon.test", testConfig);
		const result = await client.postResult("/api/hooks/session-start", {});

		expect(result).toEqual({ ok: false, reason: "timeout" });
	});
});
