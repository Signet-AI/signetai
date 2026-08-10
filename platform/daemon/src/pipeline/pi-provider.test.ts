import { describe, expect, mock, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels as getModels } from "@earendil-works/pi-ai/providers/all";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { createPiModelProvider, isPiAgentSessionProvider, mapSessionStatsToUsage, resolvePiModel } from "./pi-provider";

describe("pi provider catalog models", () => {
	test("preserves the Codex responses API and registry metadata", () => {
		const model = getModels("openai-codex").find((candidate) => candidate.id === "gpt-5.4");
		expect(model).toBeDefined();
		const resolved = resolvePiModel({
			executor: "openai-codex",
			providerFamily: "openai-codex",
			model: "gpt-5.4",
			piModel: model as Model<Api>,
			apiKey: "oauth-access",
		});

		expect(resolved.piModel.api).toBe("openai-codex-responses");
		expect(resolved.piModel.baseUrl).toBe("https://chatgpt.com/backend-api");
		expect(resolved.apiKey).toBe("oauth-access");
	});

	test("normalizes a pasted OpenAI chat-completions endpoint to Pi's base URL", () => {
		const model = getModels("opencode-go").find((candidate) => candidate.id === "deepseek-v4-flash");
		expect(model).toBeDefined();
		const resolved = resolvePiModel({
			executor: "openai-compatible",
			providerFamily: "opencode-go",
			model: "deepseek-v4-flash",
			piModel: model as Model<Api>,
			apiKey: "test-key",
			baseUrl: "https://opencode.ai/zen/go/v1/chat/completions",
		});

		expect(resolved.piModel.baseUrl).toBe("https://opencode.ai/zen/go/v1");
	});

	test("does not label a remote zero-rate model as provider-reported cost", () => {
		const provider = createPiModelProvider({
			executor: "openai-compatible",
			model: "gateway-model",
			baseUrl: "https://gateway.example.test/v1",
		});
		const stats: SessionStats = {
			sessionFile: undefined,
			sessionId: "session",
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 2,
			tokens: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, total: 4 },
			cost: 0,
		};

		expect(provider.accountingProvenance).toBe("unavailable");
		expect(mapSessionStatsToUsage(stats, 10, provider.accountingProvenance)).toMatchObject({
			totalTokens: 4,
			totalCost: null,
			accountingProvenance: "unavailable",
		});
	});

	test("creates an isolated AgentSession with no ambient tools", async () => {
		const provider = createPiModelProvider({
			executor: "openai-compatible",
			model: "test-model",
			baseUrl: "http://127.0.0.1:1234/v1",
		});
		expect(isPiAgentSessionProvider(provider)).toBe(true);
		const session = await provider.createAgentSession([]);
		try {
			expect(session.getActiveToolNames()).toEqual([]);
		} finally {
			session.dispose();
		}
	});

	test("accepts a reachable OpenAI-compatible gateway without a models endpoint", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("not found", { status: 404 })),
		) as unknown as typeof fetch;
		try {
			const provider = createPiModelProvider({
				executor: "openai-compatible",
				model: "gateway-model",
				baseUrl: "https://gateway.example.test/v1",
				apiKey: "test-key",
			});
			await expect(provider.available()).resolves.toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("settles a successful silent-overflow response without continuing from an assistant message", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					[
						`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\n`,
						`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
						"data: [DONE]\n\n",
					].join(""),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
			),
		) as unknown as typeof fetch;

		const provider = createPiModelProvider({
			executor: "openai-compatible",
			model: "silent-overflow-test",
			baseUrl: "http://127.0.0.1:1234/v1",
			contextWindow: 2,
		});
		await expect(provider.generate("ordinary routed call")).resolves.toBe("done");
		const session = await provider.createAgentSession([]);
		try {
			await expect(session.prompt("finish without tools")).resolves.toBeUndefined();
		} finally {
			session.dispose();
			globalThis.fetch = originalFetch;
		}
	});
});
