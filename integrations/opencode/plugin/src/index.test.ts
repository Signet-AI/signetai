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

	test("keeps turn context available for title and primary transforms", async () => {
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
		const titleOutput = { system: [] };
		const primaryOutput = { system: [] };
		await hooks["experimental.chat.system.transform"]({ sessionID: "child-chat-first" }, titleOutput);
		await hooks["experimental.chat.system.transform"]({ sessionID: "child-chat-first" }, primaryOutput);

		for (const output of [titleOutput, primaryOutput]) {
			expect(output.system.join("\n")).toContain("session-start:child-chat-first");
			expect(output.system.join("\n")).toContain("prompt-submit-context");
		}
	});

	test("clears prior turn context when the next message has no text", async () => {
		process.env.SIGNET_AGENT_ID = undefined;
		installFetch();
		const hooks = await createHooks();

		await hooks["chat.message"](
			{ sessionID: "non-text-next-turn" },
			{ parts: [{ type: "text", text: "recall this turn" }] },
		);
		await hooks["chat.message"]({ sessionID: "non-text-next-turn" }, { parts: [{ type: "text", text: "" }] });
		const output = { system: [] };
		await hooks["experimental.chat.system.transform"]({ sessionID: "non-text-next-turn" }, output);

		expect(output.system.join("\n")).not.toContain("session-start:non-text-next-turn");
		expect(output.system.join("\n")).not.toContain("prompt-submit-context");
	});

	test("does not let an older prompt response overwrite a newer turn", async () => {
		process.env.SIGNET_AGENT_ID = undefined;
		let releaseSessionStart: (() => void) | undefined;
		let markSessionStartStarted: (() => void) | undefined;
		let releaseOlderPrompt: (() => void) | undefined;
		let markOlderPromptStarted: (() => void) | undefined;
		const sessionStartGate = new Promise<void>((resolve) => {
			releaseSessionStart = resolve;
		});
		const sessionStartStarted = new Promise<void>((resolve) => {
			markSessionStartStarted = resolve;
		});
		const olderPromptGate = new Promise<void>((resolve) => {
			releaseOlderPrompt = resolve;
		});
		const olderPromptStarted = new Promise<void>((resolve) => {
			markOlderPromptStarted = resolve;
		});
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const url = new URL(String(input));
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				if (url.pathname === "/api/hooks/session-start") {
					if (body.sessionKey) {
						markSessionStartStarted?.();
						await sessionStartGate;
						return Response.json({ inject: "session-start-context" });
					}
					return Response.json({ inject: "workspace-start" });
				}
				if (url.pathname === "/api/hooks/user-prompt-submit") {
					if (body.userMessage === "older prompt") {
						markOlderPromptStarted?.();
						await olderPromptGate;
						return Response.json({ inject: "older-prompt-context" });
					}
					return Response.json({ inject: "newer-prompt-context" });
				}
				return Response.json({});
			},
			{ preconnect: originalFetch.preconnect },
		);
		const hooks = await createHooks();

		const olderChat = hooks["chat.message"](
			{ sessionID: "overlapping-turns" },
			{ parts: [{ type: "text", text: "older prompt" }] },
		);
		await sessionStartStarted;
		const newerChat = hooks["chat.message"](
			{ sessionID: "overlapping-turns" },
			{ parts: [{ type: "text", text: "newer prompt" }] },
		);
		releaseSessionStart?.();
		await olderPromptStarted;
		await newerChat;
		releaseOlderPrompt?.();
		await olderChat;

		const output = { system: [] };
		await hooks["experimental.chat.system.transform"]({ sessionID: "overlapping-turns" }, output);
		expect(output.system.join("\n")).toContain("session-start-context");
		expect(output.system.join("\n")).toContain("newer-prompt-context");
		expect(output.system.join("\n")).not.toContain("older-prompt-context");
	});

	test("does not restore turn context after session end", async () => {
		process.env.SIGNET_AGENT_ID = undefined;
		let releasePrompt: (() => void) | undefined;
		let markPromptStarted: (() => void) | undefined;
		const promptGate = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		const promptStarted = new Promise<void>((resolve) => {
			markPromptStarted = resolve;
		});
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL): Promise<Response> => {
				const url = new URL(String(input));
				if (url.pathname === "/api/hooks/session-start") return Response.json({ inject: "session-start-context" });
				if (url.pathname === "/api/hooks/user-prompt-submit") {
					markPromptStarted?.();
					await promptGate;
					return Response.json({ inject: "late-prompt-context" });
				}
				return Response.json({});
			},
			{ preconnect: originalFetch.preconnect },
		);
		const hooks = await createHooks();

		const chat = hooks["chat.message"](
			{ sessionID: "ending-turn" },
			{ parts: [{ type: "text", text: "ending prompt" }] },
		);
		await promptStarted;
		await hooks.event({ event: { type: "session.deleted", properties: { id: "ending-turn" } } });
		releasePrompt?.();
		await chat;

		const output = { system: [] };
		await hooks["experimental.chat.system.transform"]({ sessionID: "ending-turn" }, output);
		expect(output.system.join("\n")).not.toContain("late-prompt-context");
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
