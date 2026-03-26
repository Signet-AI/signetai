import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "./openclaw-types";

// Mock readStaticIdentity so staticFallback() always returns a
// truthy result regardless of whether ~/.agents exists on the host.
mock.module("@signet/core", () => ({
	readStaticIdentity: () => "mocked-static-identity",
}));

// Import after mock so the module picks up the stub.
const signet = await import("./index");
const signetPlugin = signet.default;
const { memoryStore } = signet;

type HookHandler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown> | unknown;
type ToolRegistration = { name: string; label?: string; description?: string };

const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

let intervalCallbacks: Array<() => void | Promise<void>> = [];
let nextIntervalId = 1;
let pathCounts = new Map<string, number>();
let registeredServices: Array<{ stop: () => void | Promise<void> }> = [];
let failSessionStartCount = 0;
let failPromptSubmitCount = 0;
let delaySessionStartMs = 0;
let delayPromptSubmitMs = 0;
let lastRememberBody: unknown = null;
let lastPreCompactionBody: unknown = null;
let lastCompactionBody: unknown = null;
let lastSessionEndBody: unknown = null;
let warnMessages: string[] = [];
let testDir = "";

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

async function flushIntervals(): Promise<void> {
	for (const callback of intervalCallbacks) {
		await callback();
	}
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
	hookOptions: Map<string, unknown>;
	tools: Array<ToolRegistration>;
} {
	const hooks = new Map<string, HookHandler>();
	const hookOptions = new Map<string, unknown>();
	const tools: Array<ToolRegistration> = [];

	const api: OpenClawPluginApi = {
		pluginConfig: {
			enabled: true,
			daemonUrl: "http://daemon.test",
		},
		logger: {
			info() {
				// no-op in tests
			},
			warn(message) {
				warnMessages.push(String(message));
			},
			error() {
				// no-op in tests
			},
		},
		registerTool(tool) {
			tools.push({
				name: tool.name,
				label: tool.label,
				description: tool.description,
			});
		},
		registerCli() {
			// no-op
		},
		registerService(service) {
			registeredServices.push(service);
		},
		on(event, handler, opts) {
			hooks.set(event, handler);
			if (opts !== undefined) {
				hookOptions.set(event, opts);
			}
		},
		resolvePath(input) {
			return input;
		},
	};

	return { api, hooks, hookOptions, tools };
}

beforeEach(() => {
	pathCounts = new Map<string, number>();
	registeredServices = [];
	failSessionStartCount = 0;
	failPromptSubmitCount = 0;
	delaySessionStartMs = 0;
	delayPromptSubmitMs = 0;
	lastRememberBody = null;
	lastPreCompactionBody = null;
	lastCompactionBody = null;
	lastSessionEndBody = null;
	warnMessages = [];
	testDir = mkdtempSync(join(tmpdir(), "signet-openclaw-test-"));

	const mockFetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const path = new URL(url).pathname;
			hit(path);

			switch (path) {
				case "/health":
					return jsonResponse({ pid: 1234 });
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
					lastSessionEndBody = init?.body ? JSON.parse(String(init.body)) : null;
					return jsonResponse({ memoriesSaved: 0 });
				case "/api/hooks/pre-compaction":
					lastPreCompactionBody = init?.body ? JSON.parse(String(init.body)) : null;
					return jsonResponse({ summaryPrompt: "flush durable state", guidelines: "focus decisions" });
				case "/api/hooks/compaction-complete":
					lastCompactionBody = init?.body ? JSON.parse(String(init.body)) : null;
					return jsonResponse({ success: true, memoryId: "sum-1" });
				case "/api/memory/remember":
					lastRememberBody = init?.body ? JSON.parse(String(init.body)) : null;
					return jsonResponse({ id: "mem-1" });
				case "/api/marketplace/mcp/tools":
					return jsonResponse({
						count: 2,
						servers: [{ id: "server-a", name: "Server A" }],
						tools: [
							{
								serverId: "server-a",
								serverName: "Server A",
								toolName: "alpha",
								description: "Alpha tool",
							},
							{
								serverId: "server-a",
								serverName: "Server A",
								toolName: "beta",
								description: "Beta tool",
							},
						],
					});
				case "/api/marketplace/mcp/policy":
					return jsonResponse({
						policy: {
							mode: "hybrid",
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
	intervalCallbacks = [];
	nextIntervalId = 1;
	globalThis.setInterval = ((handler: TimerHandler) => {
		if (typeof handler === "function") {
			intervalCallbacks.push(handler as () => void | Promise<void>);
		}
		return nextIntervalId++ as ReturnType<typeof setInterval>;
	}) as typeof setInterval;
	globalThis.clearInterval = (() => undefined) as typeof clearInterval;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	globalThis.setInterval = originalSetInterval;
	globalThis.clearInterval = originalClearInterval;
	rmSync(testDir, { recursive: true, force: true });
	for (const service of registeredServices) {
		await service.stop();
	}
});

describe("signet-memory-openclaw lifecycle hooks", () => {
	it("prefers before_prompt_build and deduplicates legacy fallback for the same turn", async () => {
		const { api, hooks, hookOptions } = createMockApi();
		signetPlugin.register(api);

		const beforePromptBuild = hooks.get("before_prompt_build");
		const beforeAgentStart = hooks.get("before_agent_start");

		expect(beforePromptBuild).toBeDefined();
		expect(beforeAgentStart).toBeDefined();
		expect(hookOptions.get("before_prompt_build")).toMatchObject({ priority: 20 });

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

	it("does not dedupe prompt injection across different agents sharing a session key", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const beforePromptBuild = hooks.get("before_prompt_build");
		expect(beforePromptBuild).toBeDefined();

		const event = {
			prompt: "Remember release criteria for this plugin",
			messages: [{ role: "assistant", content: "Prior context" }],
		};

		const first = await beforePromptBuild?.(event, { sessionKey: "shared-session", agentId: "agent-a" });
		const second = await beforePromptBuild?.(event, { sessionKey: "shared-session", agentId: "agent-b" });

		expect(getPrependContext(first)).toContain("turn-memory");
		expect(getPrependContext(second)).toContain("turn-memory");
		expect(getHits("/api/hooks/session-start")).toBe(2);
		expect(getHits("/api/hooks/user-prompt-submit")).toBe(2);
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

	it("normalizes memory_store tags to a comma string", async () => {
		const id = await memoryStore("save this", {
			daemonUrl: "http://daemon.test",
			tags: ["alpha", " beta ", ""],
		});

		expect(id).toBe("mem-1");
		expect(lastRememberBody).toEqual({
			content: "save this",
			tags: "alpha,beta",
			who: "openclaw",
		});
		expect(lastRememberBody).not.toHaveProperty("type");
		expect(lastRememberBody).not.toHaveProperty("importance");
	});

	it("deduplicates session-start for sessionless turns even if recall runs on both hooks", async () => {
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
		expect(getPrependContext(second)).toContain("turn-memory");
		expect(getHits("/api/hooks/session-start")).toBe(1);
		expect(getHits("/api/hooks/user-prompt-submit")).toBe(2);
	});

	it("does not retry session-start on fallback hook after prompt dedupe kicks in", async () => {
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

		expect(getHits("/api/hooks/session-start")).toBe(1);
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

	it("fires pre-compaction hooks once across both OpenClaw compaction event names", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const beforeCompaction = hooks.get("before_compaction");
		const sessionCompactBefore = hooks.get("session:compact:before");
		expect(beforeCompaction).toBeDefined();
		expect(sessionCompactBefore).toBeDefined();

		const event = { messageCount: 12, tokenCount: 240, compactingCount: 8 };
		const ctx = {
			sessionKey: "session-compact-1",
			sessionFile: join(testDir, "session-compact-1.jsonl"),
			agentId: "agent-1",
		};

		await beforeCompaction?.(event, ctx);
		await sessionCompactBefore?.(event, ctx);

		expect(getHits("/api/hooks/pre-compaction")).toBe(1);
		expect(lastPreCompactionBody).toMatchObject({
			harness: "openclaw",
			sessionKey: "session-compact-1",
			messageCount: 12,
			runtimePath: "plugin",
		});
	});

	it("uses compactedCount as a fallback pre-compaction message count", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const beforeCompaction = hooks.get("before_compaction");
		expect(beforeCompaction).toBeDefined();

		await beforeCompaction?.({ compactedCount: 6 }, { sessionKey: "session-compact-count", agentId: "agent-1" });

		expect(lastPreCompactionBody).toMatchObject({
			harness: "openclaw",
			sessionKey: "session-compact-count",
			messageCount: 6,
			runtimePath: "plugin",
		});
	});

	it("uses nested compaction counts as a fallback pre-compaction message count", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const beforeCompaction = hooks.get("before_compaction");
		expect(beforeCompaction).toBeDefined();

		await beforeCompaction?.(
			{ compaction: { compactingCount: 9 } },
			{ sessionKey: "session-compact-nested", agentId: "agent-1" },
		);

		expect(lastPreCompactionBody).toMatchObject({
			harness: "openclaw",
			sessionKey: "session-compact-nested",
			messageCount: 9,
			runtimePath: "plugin",
		});
	});

	it("combines summaryPrompt and guidelines for pre-compaction context", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const beforeCompaction = hooks.get("before_compaction");
		expect(beforeCompaction).toBeDefined();

		const result = await beforeCompaction?.(
			{ messageCount: 7, compactedCount: 2 },
			{ sessionKey: "session-compact-guidance", agentId: "agent-1" },
		);

		expect(getPrependContext(result)).toContain("flush durable state");
		expect(getPrependContext(result)).toContain("focus decisions");
	});

	it("does not dedupe pre-compaction hooks across different agents sharing a session key", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const beforeCompaction = hooks.get("before_compaction");
		expect(beforeCompaction).toBeDefined();

		const event = { messageCount: 12, compactedCount: 5 };
		await beforeCompaction?.(event, { sessionKey: "shared-compaction", agentId: "agent-a" });
		await beforeCompaction?.(event, { sessionKey: "shared-compaction", agentId: "agent-b" });

		expect(getHits("/api/hooks/pre-compaction")).toBe(2);
	});

	it("does not collapse distinct pre-compaction events that reuse the same message count", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const beforeCompaction = hooks.get("before_compaction");
		expect(beforeCompaction).toBeDefined();

		const ctx = { sessionKey: "shared-compaction-shape", agentId: "agent-a" };
		await beforeCompaction?.({ messageCount: 12, tokenCount: 100 }, ctx);
		await beforeCompaction?.({ messageCount: 12, tokenCount: 200 }, ctx);

		expect(getHits("/api/hooks/pre-compaction")).toBe(2);
	});

	it("reads the compaction summary from sessionFile and saves it once", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const afterCompaction = hooks.get("after_compaction");
		const sessionCompactAfter = hooks.get("session:compact:after");
		expect(afterCompaction).toBeDefined();
		expect(sessionCompactAfter).toBeDefined();

		const sessionFile = join(testDir, "session-after.jsonl");
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 1, id: "session-after" }),
				JSON.stringify({
					type: "compaction",
					id: "comp-1",
					summary: "Compacted history keeps the release blockers and migration plan.",
				}),
			].join("\n"),
			"utf-8",
		);

		const event = { messageCount: 4, compactedCount: 2, sessionFile };
		const ctx = {
			sessionKey: "session-after",
			sessionFile,
			agentId: "agent-1",
		};

		await afterCompaction?.(event, ctx);
		await sessionCompactAfter?.(event, ctx);

		expect(getHits("/api/hooks/compaction-complete")).toBe(1);
		expect(lastCompactionBody).toMatchObject({
			harness: "openclaw",
			sessionKey: "session-after",
			runtimePath: "plugin",
			summary: "Compacted history keeps the release blockers and migration plan.",
		});
		expect(lastCompactionBody).not.toHaveProperty("project");
	});

	it("reads the compaction summary from the event payload sessionFile when hook context lacks it", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const afterCompaction = hooks.get("after_compaction");
		expect(afterCompaction).toBeDefined();

		const sessionFile = join(testDir, "session-after-event.jsonl");
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 1, id: "session-after-event" }),
				JSON.stringify({
					type: "compaction",
					id: "comp-2",
					summary: "Recovered from event metadata session file.",
				}),
			].join("\n"),
			"utf-8",
		);

		await afterCompaction?.(
			{ messageCount: 5, compactedCount: 3, sessionFile },
			{ sessionKey: "session-after-event", agentId: "agent-1" },
		);

		expect(getHits("/api/hooks/compaction-complete")).toBe(1);
		expect(lastCompactionBody).toMatchObject({
			harness: "openclaw",
			sessionKey: "session-after-event",
			runtimePath: "plugin",
			summary: "Recovered from event metadata session file.",
		});
		expect(lastCompactionBody).not.toHaveProperty("project");
	});

	it("prefers event project lineage over workspace fallback for compaction-complete", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const afterCompaction = hooks.get("after_compaction");
		expect(afterCompaction).toBeDefined();

		await afterCompaction?.(
			{ summary: "Scoped summary", cwd: "/tmp/branch-lineage" },
			{ sessionKey: "session-lineage", agentId: "agent-1" },
		);

		expect(lastCompactionBody).toMatchObject({
			project: "/tmp/branch-lineage",
			sessionKey: "session-lineage",
		});
	});

	it("recovers project lineage from the session file header when the event lacks cwd/project hints", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const afterCompaction = hooks.get("after_compaction");
		expect(afterCompaction).toBeDefined();

		const sessionFile = join(testDir, "session-lineage-header.jsonl");
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({
					type: "session",
					version: 1,
					id: "session-lineage-header",
					cwd: "/tmp/header-lineage",
				}),
				JSON.stringify({
					type: "compaction",
					id: "comp-lineage-header",
					summary: "Recovered project from session header.",
				}),
			].join("\n"),
			"utf-8",
		);

		await afterCompaction?.({ sessionFile }, { sessionKey: "session-lineage-header", agentId: "agent-1" });

		expect(lastCompactionBody).toMatchObject({
			project: "/tmp/header-lineage",
			sessionKey: "session-lineage-header",
		});
	});

	it("deduplicates duplicate compaction-complete writes even when session file visibility differs across hook aliases", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const afterCompaction = hooks.get("after_compaction");
		const sessionCompactAfter = hooks.get("session:compact:after");
		expect(afterCompaction).toBeDefined();
		expect(sessionCompactAfter).toBeDefined();

		const sessionFile = join(testDir, "session-after-dedupe.jsonl");
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 1, id: "session-after-dedupe" }),
				JSON.stringify({
					type: "compaction",
					id: "comp-dedupe",
					summary: "Stable recovered summary.",
				}),
			].join("\n"),
			"utf-8",
		);

		await afterCompaction?.(
			{ summary: "Stable recovered summary.", sessionFile },
			{ sessionKey: "session-after-dedupe", sessionFile, agentId: "agent-1" },
		);
		await sessionCompactAfter?.(
			{ summary: "Stable recovered summary." },
			{ sessionKey: "session-after-dedupe", agentId: "agent-1" },
		);

		expect(getHits("/api/hooks/compaction-complete")).toBe(1);
	});

	it("does not dedupe distinct compaction summaries that share the same prefix", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const afterCompaction = hooks.get("after_compaction");
		expect(afterCompaction).toBeDefined();

		const prefix = "x".repeat(140);
		await afterCompaction?.({ summary: `${prefix}-a` }, { sessionKey: "session-prefix", agentId: "agent-1" });
		await afterCompaction?.({ summary: `${prefix}-b` }, { sessionKey: "session-prefix", agentId: "agent-1" });

		expect(getHits("/api/hooks/compaction-complete")).toBe(2);
	});

	it("does not dedupe compaction-complete hooks across different agents sharing a session key", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const afterCompaction = hooks.get("after_compaction");
		expect(afterCompaction).toBeDefined();

		await afterCompaction?.(
			{ summary: "Shared summary text" },
			{ sessionKey: "shared-compaction", agentId: "agent-a" },
		);
		await afterCompaction?.(
			{ summary: "Shared summary text" },
			{ sessionKey: "shared-compaction", agentId: "agent-b" },
		);

		expect(getHits("/api/hooks/compaction-complete")).toBe(2);
	});

	it("does not collapse distinct compactions that reuse the same summary text", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const afterCompaction = hooks.get("after_compaction");
		expect(afterCompaction).toBeDefined();

		const ctx = { sessionKey: "same-summary", agentId: "agent-a" };
		await afterCompaction?.({ compactedCount: 2, messageCount: 8, summary: "Stable summary" }, ctx);
		await afterCompaction?.({ compactedCount: 3, messageCount: 9, summary: "Stable summary" }, ctx);

		expect(getHits("/api/hooks/compaction-complete")).toBe(2);
	});

	it("clears prompt dedupe after compaction even when no summary is recoverable", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const beforePromptBuild = hooks.get("before_prompt_build");
		const afterCompaction = hooks.get("after_compaction");
		expect(beforePromptBuild).toBeDefined();
		expect(afterCompaction).toBeDefined();

		const event = {
			prompt: "Need the same context again",
			messages: [{ role: "assistant", content: "Earlier turn" }],
		};
		const ctx = {
			sessionKey: "compact-reset-nosummary",
			agentId: "agent-1",
		};

		const first = await beforePromptBuild?.(event, ctx);
		expect(getPrependContext(first)).toContain("turn-memory");
		expect(getHits("/api/hooks/user-prompt-submit")).toBe(1);

		await afterCompaction?.({ compactedCount: 2 }, ctx);
		expect(getHits("/api/hooks/compaction-complete")).toBe(0);
		expect(warnMessages.some((message) => message.includes("compaction summary unavailable"))).toBe(true);

		const second = await beforePromptBuild?.(event, ctx);
		expect(getPrependContext(second)).toContain("turn-memory");
		expect(getHits("/api/hooks/user-prompt-submit")).toBe(2);
	});

	it("clears prompt dedupe after compaction so the next turn can re-inject context", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const beforePromptBuild = hooks.get("before_prompt_build");
		const afterCompaction = hooks.get("after_compaction");
		expect(beforePromptBuild).toBeDefined();
		expect(afterCompaction).toBeDefined();

		const event = {
			prompt: "Need the same context again",
			messages: [{ role: "assistant", content: "Earlier turn" }],
		};
		const ctx = {
			sessionKey: "compact-reset",
			agentId: "agent-1",
		};

		const first = await beforePromptBuild?.(event, ctx);
		expect(getPrependContext(first)).toContain("turn-memory");
		expect(getHits("/api/hooks/user-prompt-submit")).toBe(1);

		await afterCompaction?.({ summary: "Compacted state" }, ctx);
		expect(getHits("/api/hooks/compaction-complete")).toBe(1);

		const second = await beforePromptBuild?.(event, ctx);
		expect(getPrependContext(second)).toContain("turn-memory");
		expect(getHits("/api/hooks/user-prompt-submit")).toBe(2);
	});

	it("forwards transcript and project lineage on agent_end session capture", async () => {
		const { api, hooks } = createMockApi();
		signetPlugin.register(api);

		const agentEnd = hooks.get("agent_end");
		expect(agentEnd).toBeDefined();

		const sessionFile = join(testDir, "session-end.jsonl");
		await agentEnd?.(
			{
				cwd: "/tmp/session-end-project",
				sessionId: "session-end-id",
				sessionKey: "session-end-key",
				sessionFile,
			},
			{
				agentId: "agent-1",
				sessionFile,
			},
		);

		expect(getHits("/api/hooks/session-end")).toBe(1);
		expect(lastSessionEndBody).toMatchObject({
			agentId: "agent-1",
			cwd: "/tmp/session-end-project",
			harness: "openclaw",
			runtimePath: "plugin",
			sessionId: "session-end-id",
			sessionKey: "session-end-key",
			transcriptPath: sessionFile,
		});
	});

	it("does not reregister marketplace proxy tools on refresh", async () => {
		const { api, tools } = createMockApi();
		signetPlugin.register(api);
		await Bun.sleep(0);

		const firstNames = tools.map((tool) => tool.name);
		const proxyNames = firstNames.filter((name) => name.startsWith("signet_server_a_"));
		expect(proxyNames).toEqual(["signet_server_a_alpha", "signet_server_a_beta"]);

		await flushIntervals();
		await Bun.sleep(0);

		const refreshedNames = tools.map((tool) => tool.name);
		expect(refreshedNames.filter((name) => name === "signet_server_a_alpha").length).toBe(1);
		expect(refreshedNames.filter((name) => name === "signet_server_a_beta").length).toBe(1);
		expect(refreshedNames.some((name) => name === "signet_server_a_alpha_2")).toBeFalse();
		expect(refreshedNames.some((name) => name === "signet_server_a_beta_2")).toBeFalse();
	});
});
