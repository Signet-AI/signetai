import { afterEach, describe, expect, test } from "bun:test";
import { createDaemonFetcher, createDaemonIdentityHeaders, createDaemonPluginHeaders } from "./src/daemon-client.js";

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const fetchResult = createDaemonFetcher({
	headers: () => ({ "x-signet-runtime-path": "plugin", Authorization: "Bearer test-token" }),
	logPrefix: "test",
});

function setFetch(handler: typeof fetch): void {
	globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect });
}

function bodyReadFailure(name: string): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("partial"));
		},
	});
	const response = new Response(body, { status: 200 });
	Object.defineProperty(response, "text", {
		value: async () => {
			const error = new Error("stream read failed");
			error.name = name;
			throw error;
		},
	});
	return response;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	console.warn = originalWarn;
});

describe("shared daemon fetch", () => {
	test("separates identity headers from optional authentication", () => {
		expect(createDaemonIdentityHeaders("openclaw-plugin", "plugin")).toEqual({
			"Content-Type": "application/json",
			"x-signet-runtime-path": "plugin",
			"x-signet-actor": "openclaw-plugin",
			"x-signet-actor-type": "harness",
		});
		expect(
			createDaemonPluginHeaders("pi-plugin", "extension", {
				SIGNET_API_KEY: "  ",
				SIGNET_TOKEN: " legacy-test-token ",
			}),
		).toMatchObject({
			Authorization: "Bearer legacy-test-token",
		});
	});

	test("sends caller headers and JSON body, then parses the response", async () => {
		let request:
			| { readonly url: string; readonly method: string | undefined; readonly body: string | undefined }
			| undefined;
		setFetch(async (input, init) => {
			request = {
				url: String(input),
				method: init?.method,
				body: typeof init?.body === "string" ? init.body : undefined,
			};
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
			return Response.json({ accepted: true });
		});

		const result = await fetchResult<{ accepted: boolean }>("http://daemon.test", "/api/hooks/session-start", {
			method: "POST",
			body: { sessionKey: "session-1" },
			timeout: 1000,
		});

		expect(request).toEqual({
			url: "http://daemon.test/api/hooks/session-start",
			method: "POST",
			body: JSON.stringify({ sessionKey: "session-1" }),
		});
		expect(result).toEqual({ ok: true, data: { accepted: true } });
	});

	test("reports HTTP status without reading and cancels the response body", async () => {
		let canceled = false;
		setFetch(async () => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("error"));
				},
				cancel() {
					canceled = true;
				},
			});
			return new Response(body, { status: 503 });
		});

		expect(await fetchResult("http://daemon.test", "/health", { method: "GET" })).toEqual({
			ok: false,
			reason: "http",
			status: 503,
		});
		expect(canceled).toBe(true);
	});

	test("distinguishes invalid JSON from failed and timed-out body reads", async () => {
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
		setFetch(async () => new Response("", { status: 200 }));
		expect(await fetchResult("http://daemon.test", "/empty")).toEqual({
			ok: false,
			reason: "invalid-json",
			status: 200,
		});
		expect(warnings.some((warning) => warning.includes("0 chars") && warning.includes("empty body"))).toBe(true);

		setFetch(async () => bodyReadFailure("Error"));
		expect(await fetchResult("http://daemon.test", "/broken")).toEqual({ ok: false, reason: "body-read" });

		setFetch(async () => bodyReadFailure("TimeoutError"));
		expect(await fetchResult("http://daemon.test", "/slow-body", { timeout: 1000 })).toEqual({
			ok: false,
			reason: "timeout",
		});
	});

	test("distinguishes a request timeout from an unavailable daemon", async () => {
		setFetch(async () => {
			const error = new Error("timed out");
			error.name = "TimeoutError";
			throw error;
		});
		expect(await fetchResult("http://daemon.test", "/slow-request")).toEqual({ ok: false, reason: "timeout" });

		setFetch(async () => {
			throw new TypeError("connection refused");
		});
		expect(await fetchResult("http://daemon.test", "/offline")).toEqual({ ok: false, reason: "offline" });
	});

	test("supports successful status requests without parsing a response body", async () => {
		let canceled = false;
		setFetch(async () => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("not json"));
				},
				cancel() {
					canceled = true;
				},
			});
			const response = new Response(body, { status: 200 });
			Object.defineProperty(response, "text", {
				value: async () => {
					throw new Error("body must not be read");
				},
			});
			return response;
		});

		expect(await fetchResult<void>("http://daemon.test", "/api/hooks/remember", { parseJson: false })).toEqual({
			ok: true,
			data: undefined,
		});
		expect(canceled).toBe(true);
	});
});
