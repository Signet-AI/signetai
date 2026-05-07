import { afterEach, describe, expect, test } from "bun:test";
import { SignetPlugin } from "./index.js";

const originalFetch = globalThis.fetch;
const originalDaemonUrl = process.env.SIGNET_DAEMON_URL;

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
});

describe("SignetPlugin OpenCode lifecycle", () => {
	test("injects per-session start context when system transform runs before chat.message", async () => {
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
});
