import { afterEach, describe, expect, it } from "bun:test";
import SignetOhMyPiExtension from "./src/index.js";

const originalFetch = globalThis.fetch;

interface HandlerMap {
	[event: string]: Array<(event: unknown, ctx: unknown) => unknown>;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.SIGNET_ENABLED;
	delete process.env.SIGNET_AGENT_ID;
	delete process.env.SIGNET_DAEMON_URL;
});

describe("SignetOhMyPiExtension", () => {
	it("injects recall through before_agent_start so it persists for follow-up attribution", async () => {
		const handlers: HandlerMap = {};
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				(handlers[event] ??= []).push(handler);
			},
		};

		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url.endsWith("/api/hooks/session-start")) {
					return Response.json({ inject: "session context" });
				}
				if (url.endsWith("/api/hooks/user-prompt-submit")) {
					return Response.json({ inject: "[signet:recall]\n- Favorite color is blue" });
				}
				throw new Error(`Unexpected fetch: ${url}`);
			},
			{ preconnect: originalFetch.preconnect },
		);

		SignetOhMyPiExtension(pi as never);
		expect(handlers.context).toBeUndefined();
		expect(handlers.before_agent_start).toHaveLength(1);

		const ctx = {
			cwd: "/tmp/project",
			sessionManager: {
				getBranch: () => [],
				getEntries: () => [],
				getHeader: () => ({ id: "session-1", cwd: "/tmp/project" }),
				getSessionFile: () => undefined,
				getSessionId: () => "session-1",
			},
		};

		const result = await handlers.before_agent_start[0]?.({ prompt: "do I have a fav color?" }, ctx);
		expect(result).toMatchObject({
			message: {
				customType: "signet-oh-my-pi-hidden-recall",
				display: false,
				attribution: "agent",
			},
		});
		expect((result as { message: { content: string } }).message.content).toContain("session context");
		expect((result as { message: { content: string } }).message.content).toContain("Favorite color is blue");
	});
});
