import { afterEach, describe, expect, test } from "bun:test";
import { SignetPlugin } from "./index.js";

const originalFetch = globalThis.fetch;
const originalDaemonUrl = process.env.SIGNET_DAEMON_URL;
const originalAgentId = process.env.SIGNET_AGENT_ID;

interface RequestRecord {
	readonly path: string;
	readonly body: Record<string, unknown>;
}

interface OpenCodeHooks {
	readonly event: (input: {
		readonly event: { readonly type: string; readonly properties?: Record<string, unknown> };
	}) => Promise<void>;
	readonly "chat.message": (
		input: { readonly sessionID: string },
		output: { readonly parts: ReadonlyArray<{ readonly type: "text"; readonly text: string }> },
	) => Promise<void>;
	readonly "experimental.chat.system.transform": (
		input: { readonly sessionID: string },
		output: { readonly system: string[] },
	) => Promise<void>;
	readonly "experimental.session.compacting": (
		input: { readonly sessionID: string },
		output: { readonly context: string[] },
	) => Promise<void>;
}

function installFetch(): RequestRecord[] {
	const records: RequestRecord[] = [];
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = new URL(String(input));
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			records.push({ path: url.pathname, body });

			if (url.pathname === "/api/hooks/session-start") {
				const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey : "";
				return Response.json({ inject: sessionKey ? `session-start:${sessionKey}` : "workspace-start" });
			}

			if (url.pathname === "/api/hooks/user-prompt-submit") {
				return Response.json({ inject: "prompt-submit-context" });
			}

			return Response.json({});
		},
		{ preconnect: originalFetch.preconnect },
	);
	return records;
}

async function createHooks(): Promise<OpenCodeHooks> {
	process.env.SIGNET_DAEMON_URL = "http://daemon.test";
	const plugin = await SignetPlugin({
		directory: "/repo",
		client: {
			session: {
				messages: async () => ({ data: [] }),
			},
		} as never,
	} as never);
	return plugin as OpenCodeHooks;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalDaemonUrl === undefined) {
		process.env.SIGNET_DAEMON_URL = undefined;
	} else {
		process.env.SIGNET_DAEMON_URL = originalDaemonUrl;
	}
	if (originalAgentId === undefined) {
		process.env.SIGNET_AGENT_ID = undefined;
	} else {
		process.env.SIGNET_AGENT_ID = originalAgentId;
	}
});

describe("SignetPlugin OpenCode lifecycle", () => {
	test("injects per-session start context when system transform runs before chat.message", async () => {
		process.env.SIGNET_AGENT_ID = undefined;
		const records = installFetch();
		const hooks = await createHooks();
		await hooks.event({
			event: { type: "session.created", properties: { id: "child-transform-first", parentID: "parent" } },
		});

		const output = { system: [] };
		await hooks["experimental.chat.system.transform"]({ sessionID: "child-transform-first" }, output);

		expect(output.system.join("\n")).toContain("session-start:child-transform-first");
		expect(records).toContainEqual({
			path: "/api/hooks/session-start",
			body: {
				harness: "opencode",
				project: "/repo",
				sessionKey: "child-transform-first",
				parentSessionKey: "parent",
				runtimePath: "plugin",
			},
		});
	});

	test("keeps session-start context available for the same prompt when chat.message runs first", async () => {
		process.env.SIGNET_AGENT_ID = undefined;
		installFetch();
		const hooks = await createHooks();
		await hooks.event({
			event: { type: "session.created", properties: { id: "child-chat-first", parentID: "parent" } },
		});

		await hooks["chat.message"](
			{ sessionID: "child-chat-first" },
			{ parts: [{ type: "text", text: "start the delegated task" }] },
		);
		const output = { system: [] };
		await hooks["experimental.chat.system.transform"]({ sessionID: "child-chat-first" }, output);

		expect(output.system.join("\n")).toContain("session-start:child-chat-first");
		expect(output.system.join("\n")).toContain("prompt-submit-context");
	});

	test("single-flights concurrent per-session start hooks", async () => {
		process.env.SIGNET_AGENT_ID = undefined;
		const records: RequestRecord[] = [];
		let releaseSessionStart: (() => void) | undefined;
		const sessionStartGate = new Promise<void>((resolve) => {
			releaseSessionStart = resolve;
		});
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const url = new URL(String(input));
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				records.push({ path: url.pathname, body });

				if (url.pathname === "/api/hooks/session-start") {
					const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey : "";
					if (sessionKey) await sessionStartGate;
					return Response.json({ inject: sessionKey ? `session-start:${sessionKey}` : "workspace-start" });
				}

				if (url.pathname === "/api/hooks/user-prompt-submit") {
					return Response.json({ inject: "prompt-submit-context" });
				}

				return Response.json({});
			},
			{ preconnect: originalFetch.preconnect },
		);
		const hooks = await createHooks();
		const output = { system: [] };

		const chat = hooks["chat.message"](
			{ sessionID: "concurrent-child" },
			{ parts: [{ type: "text", text: "start concurrent child" }] },
		);
		const transform = hooks["experimental.chat.system.transform"]({ sessionID: "concurrent-child" }, output);
		await Promise.resolve();
		releaseSessionStart?.();
		await Promise.all([chat, transform]);

		const sessionStarts = records.filter(
			(record) => record.path === "/api/hooks/session-start" && record.body.sessionKey === "concurrent-child",
		);
		expect(sessionStarts).toHaveLength(1);
		expect(output.system.join("\n").match(/session-start:concurrent-child/g)).toHaveLength(1);
	});

	test("does not fail closed when per-session start context is unavailable", async () => {
		process.env.SIGNET_AGENT_ID = undefined;
		let sessionStartCount = 0;
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL): Promise<Response> => {
				const url = new URL(String(input));
				if (url.pathname === "/api/hooks/session-start") {
					sessionStartCount += 1;
					if (sessionStartCount > 1) return new Response("daemon unavailable", { status: 503 });
					return Response.json({ inject: "workspace-start" });
				}
				return Response.json({});
			},
			{ preconnect: originalFetch.preconnect },
		);
		const hooks = await createHooks();
		const output = { system: [] };

		await expect(
			hooks["experimental.chat.system.transform"]({ sessionID: "daemon-down-child" }, output),
		).resolves.toBeUndefined();
	});

	test("does not skip prompt-submit when per-session start context is unavailable", async () => {
		process.env.SIGNET_AGENT_ID = undefined;
		const records: RequestRecord[] = [];
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const url = new URL(String(input));
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				records.push({ path: url.pathname, body });
				if (url.pathname === "/api/hooks/session-start") {
					return new Response("daemon unavailable", { status: 503 });
				}
				if (url.pathname === "/api/hooks/user-prompt-submit") {
					return Response.json({ inject: "prompt-submit-context" });
				}
				return Response.json({});
			},
			{ preconnect: originalFetch.preconnect },
		);
		const hooks = await createHooks();

		await hooks["chat.message"]({ sessionID: "daemon-down-child" }, { parts: [{ type: "text", text: "keep recall" }] });

		expect(records.map((record) => record.path)).toContain("/api/hooks/user-prompt-submit");
	});

	test("threads configured Signet agent scope through session-end", async () => {
		process.env.SIGNET_AGENT_ID = "named-agent";
		const records = installFetch();
		const hooks = await createHooks();

		await hooks.event({
			event: { type: "session.idle", properties: { sessionID: "finished-session" } },
		});
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(records).toContainEqual({
			path: "/api/hooks/session-end",
			body: {
				harness: "opencode",
				agentId: "named-agent",
				runtimePath: "plugin",
				reason: "session.idle",
				sessionKey: "finished-session",
			},
		});
	});

	test("threads configured Signet agent scope through pre-compaction", async () => {
		process.env.SIGNET_AGENT_ID = "named-agent";
		const records = installFetch();
		const hooks = await createHooks();
		const output = { context: [] };

		await hooks["experimental.session.compacting"]({ sessionID: "compact-session" }, output);

		expect(records).toContainEqual({
			path: "/api/hooks/pre-compaction",
			body: {
				harness: "opencode",
				agentId: "named-agent",
				sessionKey: "compact-session",
				runtimePath: "plugin",
			},
		});
	});
});
