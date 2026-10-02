import { afterEach, describe, expect, test } from "bun:test";
import { createDaemonClient } from "./daemon-client.js";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.SIGNET_API_KEY;
const originalToken = process.env.SIGNET_TOKEN;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalApiKey === undefined) Reflect.deleteProperty(process.env, "SIGNET_API_KEY");
	else process.env.SIGNET_API_KEY = originalApiKey;
	if (originalToken === undefined) Reflect.deleteProperty(process.env, "SIGNET_TOKEN");
	else process.env.SIGNET_TOKEN = originalToken;
});

describe("createDaemonClient", () => {
	test("sends OpenCode runtime identity and bearer auth", async () => {
		process.env.SIGNET_API_KEY = " sig_sk_opencode_secret ";
		process.env.SIGNET_TOKEN = "legacy-token";
		let authorization = "";
		let actor = "";
		let runtimePath = "";
		let requestBody = "";
		globalThis.fetch = Object.assign(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				authorization = headers.get("authorization") ?? "";
				actor = headers.get("x-signet-actor") ?? "";
				runtimePath = headers.get("x-signet-runtime-path") ?? "";
				requestBody = typeof init?.body === "string" ? init.body : "";
				return Response.json({ accepted: true });
			},
			{ preconnect: originalFetch.preconnect },
		);

		const client = createDaemonClient("http://daemon.test");
		const result = await client.postResult("/api/hooks/session-start", { sessionKey: "session-1" });

		expect(authorization).toBe("Bearer sig_sk_opencode_secret");
		expect(actor).toBe("opencode-plugin");
		expect(runtimePath).toBe("plugin");
		expect(requestBody).toBe(JSON.stringify({ sessionKey: "session-1" }));
		expect(result).toEqual({ ok: true, data: { accepted: true } });
	});
});
