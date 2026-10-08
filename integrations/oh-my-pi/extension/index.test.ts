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
	delete process.env.SIGNET_BYPASS;
});

describe("SignetOhMyPiExtension", () => {
	it("injects recall through before_agent_start so it persists for follow-up attribution", async () => {
		const handlers: HandlerMap = {};
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				(handlers[event] ??= []).push(handler);
			},
		};

		const requestedUrls: string[] = [];
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				requestedUrls.push(url);
				if (url.endsWith("/api/hooks/session-start")) {
					return Response.json({ inject: "session context" });
				}
				if (url.endsWith("/api/hooks/user-prompt-submit")) {
					return Response.json({ inject: "[signet:recall]\n- Favorite color is blue" });
				}
				if (url.endsWith("/api/hooks/notifications")) {
					return Response.json({ inject: "peer notification" });
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
		expect(requestedUrls.some((url) => url.endsWith("/api/hooks/notifications"))).toBe(true);
		expect((result as { message: { content: string } }).message.content).toContain("peer notification");
	});

	it("submits the prompt once from input and settles it in before_agent_start", async () => {
		const handlers: HandlerMap = {};
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				(handlers[event] ??= []).push(handler);
			},
		};

		let promptSubmits = 0;
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url.endsWith("/api/hooks/session-start")) return Response.json({});
				if (url.endsWith("/api/hooks/user-prompt-submit")) {
					promptSubmits += 1;
					return new Response("daemon busy", { status: 503 });
				}
				if (url.endsWith("/api/hooks/notifications")) return Response.json({});
				throw new Error(`Unexpected fetch: ${url}`);
			},
			{ preconnect: originalFetch.preconnect },
		);

		SignetOhMyPiExtension(pi as never);
		const ctx = {
			cwd: "/tmp/project",
			sessionManager: {
				getBranch: () => [],
				getEntries: () => [],
				getHeader: () => ({ id: "session-2", cwd: "/tmp/project" }),
				getSessionFile: () => undefined,
				getSessionId: () => "session-2",
			},
		};

		expect(handlers.input?.[0]?.({ text: "hello" }, ctx)).toBeUndefined();
		await handlers.before_agent_start[0]?.({ prompt: "hello" }, ctx);
		expect(promptSubmits).toBe(1);
	});

	it("bypass mode skips all handler registration", () => {
		process.env.SIGNET_BYPASS = "1";

		const events = new Set<string>();
		const pi = {
			on(event: string, _handler: unknown) {
				events.add(event);
			},
		};

		SignetOhMyPiExtension(pi as never);

		expect(events.size).toBe(0);
	});
});
