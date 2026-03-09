import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import signetPlugin from "./index";
import type { OpenClawPluginApi } from "./openclaw-types";

type HookHandler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown> | unknown;

const originalFetch = globalThis.fetch;
let pathCounts = new Map<string, number>();
let registeredServices: Array<{ stop: () => void | Promise<void> }> = [];
let failSessionStartCount = 0;
let failPromptSubmitCount = 0;
let delaySessionStartMs = 0;
let delayPromptSubmitMs = 0;

function hit(path: string): void {
	pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
}

function getHits(path: string): number {
	return pathCounts.get(path) ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getPrependContext(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	return typeof value.prependContext === "string" ? value.prependContext : undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
		},
	});
}

function createMockApi(): {
	api: OpenClawPluginApi;
	hooks: Map<string, HookHandler>;
} {
	const hooks = new Map<string, HookHandler>();

	const api: OpenClawPluginApi = {
		pluginConfig: {
			enabled: true,
			daemonUrl: "http://daemon.test",
		},
		logger: {
			info() {
				// no-op in tests
			},
			warn() {
				// no-op in tests
			},
			error() {
				// no-op in tests
			},
		},
		registerTool() {
			// no-op
		},
		registerCli() {
			// no-op
		},
		registerService(service) {
			registeredServices.push(service);
		},
		on(event, handler) {
			hooks.set(event, handler);
		},
		resolvePath(input) {
			return input;
		},
	};

	return { api, hooks };
}

beforeEach(() => {
	pathCounts = new Map<string, number>();
	registeredServices = [];
	failSessionStartCount = 0;
	failPromptSubmitCount = 0;
	delaySessionStartMs = 0;
	delayPromptSubmitMs = 0;

	const mockFetch = Object.assign(
		async (input: RequestInfo | URL): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const path = new URL(url).pathname;
			hit(path);

			switch (path) {
				case "/health":
					return new Response("ok", { status: 200 });
				case "/api/hooks/session-start":
					if (delaySessionStartMs > 0) {
						await Bun.sleep(delaySessionStartMs);
					}
					if (failSessionStartCount > 0) {
						failSessionStartCount -= 1;
						return jsonResponse({ error: "temporarily unavailable" }, 503);
					}
					return jsonResponse({ ok: true });
				case "/api/hooks/user-prompt-submit":
					if (delayPromptSubmitMs > 0) {
						await Bun.sleep(delayPromptSubmitMs);
					}
					if (failPromptSubmitCount > 0) {
						failPromptSubmitCount -= 1;
						return jsonResponse({ error: "temporarily unavailable" }, 503);
					}
					return jsonResponse({
						inject: "turn-memory",
						memoryCount: 2,
						engine: "fts+decay",
					});
				case "/api/hooks/session-end":
					return jsonResponse({ memoriesSaved: 0 });
				case "/api/marketplace/mcp/tools":
					return jsonResponse({ count: 0, tools: [], servers: [] });
				case "/api/marketplace/mcp/policy":
					return jsonResponse({
						policy: {
							mode: "compact",
							maxExpandedTools: 12,
							maxSearchResults: 20,
							updatedAt: "2026-03-08T00:00:00Z",
						},
					});
				default:
					return jsonResponse({ error: "not found" }, 404);
			}
		},
		{
			preconnect: originalFetch.preconnect,
		},
	);

	globalThis.fetch = mockFetch;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	for (const service of registeredServices) {
		await service.stop();
	}
});

describe("signet-memory-openclaw lifecycle hooks", () => {
	it("prefers before_prompt_build and deduplicates legacy fallback for the same turn", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const beforePromptBuild = hooks.get("before_prompt_build");
		const beforeAgentStart = hooks.get("before_agent_start");

		expect(beforePromptBuild).toBeDefined();
		expect(beforeAgentStart).toBeDefined();

		const event = {
			prompt: "Remember release criteria for this plugin",
			messages: [{ role: "assistant", content: "Prior context" }],
		};
		const ctx = {
			sessionKey: "session-1",
			agentId: "agent-1",
		};

		const first = await beforePromptBuild?.(event, ctx);
		const second = await beforeAgentStart?.(event, ctx);

		expect(getPrependContext(first)).toContain("turn-memory");
		expect(second).toBeUndefined();
		expect(getHits("/api/hooks/user-prompt-submit")).toBe(1);
		expect(getHits("/api/hooks/session-start")).toBe(1);
	});

	it("keeps legacy before_agent_start path working when used alone", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const beforeAgentStart = hooks.get("before_agent_start");
		expect(beforeAgentStart).toBeDefined();

		const result = await beforeAgentStart?.(
			{ prompt: "Legacy prompt path should still inject" },
			{ sessionKey: "legacy-1", agentId: "agent-legacy" },
		);

		expect(getPrependContext(result)).toContain("turn-memory");
		expect(getHits("/api/hooks/user-prompt-submit")).toBe(1);
		expect(getHits("/api/hooks/session-start")).toBe(1);
	});

	it("deduplicates session-start for sessionless turns when both hooks fire", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const beforePromptBuild = hooks.get("before_prompt_build");
		const beforeAgentStart = hooks.get("before_agent_start");

		const event = {
			prompt: "sessionless turn",
			messages: [{ role: "assistant", content: "Prior context" }],
		};
		const ctx = {
			agentId: "agent-1",
		};

		const first = await beforePromptBuild?.(event, ctx);
		const second = await beforeAgentStart?.(event, ctx);

		expect(getPrependContext(first)).toContain("turn-memory");
		expect(second).toBeUndefined();
		expect(getHits("/api/hooks/session-start")).toBe(1);
		expect(getHits("/api/hooks/user-prompt-submit")).toBe(1);
	});

	it("retries session-start on fallback hook when initial claim attempt fails", async () => {
		failSessionStartCount = 1;
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const beforePromptBuild = hooks.get("before_prompt_build");
		const beforeAgentStart = hooks.get("before_agent_start");
		const event = {
			prompt: "retry session claim",
			messages: [{ role: "assistant", content: "Prior context" }],
		};
		const ctx = {
			sessionKey: "session-retry",
			agentId: "agent-1",
		};

		await beforePromptBuild?.(event, ctx);
		await beforeAgentStart?.(event, ctx);

		expect(getHits("/api/hooks/session-start")).toBe(2);
	});

	it("does not suppress legacy fallback recall when first recall attempt fails", async () => {
		failPromptSubmitCount = 1;
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const beforePromptBuild = hooks.get("before_prompt_build");
		const beforeAgentStart = hooks.get("before_agent_start");
		const event = {
			prompt: "fallback recall retry",
			messages: [{ role: "assistant", content: "Prior context" }],
		};
		const ctx = {
			sessionKey: "session-fallback",
			agentId: "agent-1",
		};

		const first = await beforePromptBuild?.(event, ctx);
		const second = await beforeAgentStart?.(event, ctx);

		expect(first).toBeUndefined();
		expect(getPrependContext(second)).toContain("turn-memory");
		expect(getHits("/api/hooks/user-prompt-submit")).toBe(2);
	});

	it("keeps prompt dedupe when recall call is slower than the dedupe window", async () => {
		delayPromptSubmitMs = 1_200;
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const beforePromptBuild = hooks.get("before_prompt_build");
		const beforeAgentStart = hooks.get("before_agent_start");
		const event = {
			prompt: "slow recall dedupe",
			messages: [{ role: "assistant", content: "Prior context" }],
		};
		const ctx = {
			sessionKey: "session-slow-recall",
			agentId: "agent-1",
		};

		const first = await beforePromptBuild?.(event, ctx);
		const second = await beforeAgentStart?.(event, ctx);

		expect(getPrependContext(first)).toContain("turn-memory");
		expect(second).toBeUndefined();
		expect(getHits("/api/hooks/user-prompt-submit")).toBe(1);
	});

	it("keeps sessionless session-start dedupe when startup call is slow", async () => {
		delaySessionStartMs = 1_200;
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const beforePromptBuild = hooks.get("before_prompt_build");
		const beforeAgentStart = hooks.get("before_agent_start");
		const event = {
			prompt: "slow sessionless startup",
			messages: [{ role: "assistant", content: "Prior context" }],
		};
		const ctx = {
			agentId: "agent-1",
		};

		await beforePromptBuild?.(event, ctx);
		await beforeAgentStart?.(event, ctx);

		expect(getHits("/api/hooks/session-start")).toBe(1);
	});
});
