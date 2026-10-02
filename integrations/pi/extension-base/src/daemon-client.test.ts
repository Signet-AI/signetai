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
	test("sends configured Pi runtime identity and bearer auth", async () => {
		process.env.SIGNET_API_KEY = "sig_sk_extension_secret";
		let authorization = "";
		let actor = "";
		let runtimePath = "";
		globalThis.fetch = Object.assign(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				authorization = headers.get("authorization") ?? "";
				actor = headers.get("x-signet-actor") ?? "";
				runtimePath = headers.get("x-signet-runtime-path") ?? "";
				return Response.json({ accepted: true });
			},
			{ preconnect: originalFetch.preconnect },
		);

		const client = createDaemonClient("http://daemon.test", testConfig);
		const result = await client.postResult("/api/hooks/session-start", {});

		expect(authorization).toBe("Bearer sig_sk_extension_secret");
		expect(actor).toBe("pi-test");
		expect(runtimePath).toBe("plugin");
		expect(result).toEqual({ ok: true, data: { accepted: true } });
	});

	test("postStatus accepts a successful empty body without parsing JSON", async () => {
		globalThis.fetch = Object.assign(async () => new Response(null, { status: 200 }), {
			preconnect: originalFetch.preconnect,
		});

		const client = createDaemonClient("http://daemon.test", testConfig);
		const result = await client.postStatus("/api/hooks/remember", {});

		expect(result).toEqual({ ok: true, data: undefined });
	});
});
