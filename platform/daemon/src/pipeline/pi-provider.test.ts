import { describe, expect, mock, test } from "bun:test";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { getBuiltinModels as getModels } from "@earendil-works/pi-ai/providers/all";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import {
	createPiModelProvider,
	isPiAgentSessionProvider,
	mapSessionStatsToUsage,
	mapUsage,
	resolvePiModel,
	summarizeCacheRequests,
	awaitWithAbort,
} from "./pi-provider";
import { configureLlmConcurrency, getLlmConcurrencyStatus, withLlmConcurrency } from "./provider";

describe("pi provider catalog models", () => {
	test.each([
		["modelRuntime", () => new Promise<never>(() => {})],
		["resourceLoader.reload", () => new Promise<never>(() => {})],
		["createAgentSession", () => new Promise<never>(() => {})],
	] as const)("aborts stalled %s initialization within the shared deadline", async (stage, createStalled) => {
		const controller = new AbortController();
		const pending = awaitWithAbort(createStalled(), controller.signal);
		setTimeout(() => controller.abort(new Error("Agent session exceeded the 25ms deadline")), 25);
		await expect(pending).rejects.toThrow("Agent session exceeded the 25ms deadline");
		expect(stage).toBeDefined();
	});

	test("allows initialization to complete before the shared deadline", async () => {
		const controller = new AbortController();
		await expect(awaitWithAbort(Promise.resolve("initialized"), controller.signal)).resolves.toBe("initialized");
		expect(controller.signal.aborted).toBe(false);
	});

	test("does not resurrect a late session after initialization cancellation", async () => {
		const controller = new AbortController();
		let disposed = false;
		let resolveLate: ((session: { dispose: () => void }) => void) | undefined;
		const pending = awaitWithAbort(
			new Promise<{ dispose: () => void }>((resolve) => {
				resolveLate = resolve;
			}),
			controller.signal,
			(session) => session.dispose(),
		);
		controller.abort(new Error("Agent session exceeded the 25ms deadline"));
		await expect(pending).rejects.toThrow("Agent session exceeded the 25ms deadline");
		resolveLate?.({ dispose: () => (disposed = true) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(disposed).toBe(true);
	});

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
		expect(
			mapSessionStatsToUsage(stats, 10, provider.accountingProvenance, [
				{ cacheRead: 3, cacheWrite: 0 },
				{ cacheRead: 0, cacheWrite: 2 },
				{ cacheRead: 0, cacheWrite: 0 },
			] as Usage[]),
		).toMatchObject({
			totalTokens: 4,
			totalCost: null,
			accountingProvenance: "unavailable",
		});
		expect(
			mapSessionStatsToUsage(stats, 10, provider.accountingProvenance, [
				{ cacheRead: 3, cacheWrite: 0 },
				{ cacheRead: 0, cacheWrite: 2 },
				{ cacheRead: 0, cacheWrite: 0 },
			] as Usage[]).cacheRequests,
		).toEqual({ requests: 3, hits: 1, misses: 1, unknown: 1, writes: 1 });
	});

	test("does not report request cache accounting when a provider omits cache fields", () => {
		const mapped = mapUsage({} as Usage, "provider_reported");
		expect(mapped).toMatchObject({
			totalTokens: null,
			totalCost: null,
			accountingProvenance: "unavailable",
		});
		expect(mapped.cacheRequests).toBeNull();
	});

	test("keeps provider-reported zero cache fields as an unknown request", () => {
		const mapped = mapUsage({ cacheRead: 0, cacheWrite: 0 } as Usage, "provider_reported");

		expect(mapped.cacheRequests).toEqual({ requests: 1, hits: 0, misses: 0, unknown: 1, writes: 0 });
	});

	test("classifies per-response cache usage without treating zero reads as a miss", () => {
		const usage = (cacheRead: number, cacheWrite: number): Usage => ({ cacheRead, cacheWrite }) as Usage;

		expect(summarizeCacheRequests([usage(12, 0), usage(0, 8), usage(0, 0), usage(0, 0)])).toEqual({
			requests: 4,
			hits: 1,
			misses: 1,
			unknown: 2,
			writes: 1,
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

	test("admits normal Pi completions through the global LLM semaphore (#1333)", async () => {
		const originalFetch = globalThis.fetch;
		const originalLimit = getLlmConcurrencyStatus().limit;
		let releaseBlocker: (() => void) | undefined;
		try {
			configureLlmConcurrency(1);
			const blocker = withLlmConcurrency(
				() =>
					new Promise<void>((resolve) => {
						releaseBlocker = resolve;
					}),
				5000,
				"test-blocker",
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			let requests = 0;
			globalThis.fetch = mock(() => {
				requests++;
				return Promise.resolve(
					new Response(
						`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
				);
			}) as unknown as typeof fetch;
			const provider = createPiModelProvider({
				executor: "openai-compatible",
				model: "concurrency-test",
				baseUrl: "http://127.0.0.1:1234/v1",
			});
			const generated = provider.generate("wait for admission", { timeoutMs: 5000 });
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(requests).toBe(0);

			releaseBlocker?.();
			await blocker;
			await expect(generated).resolves.toBe("done");
			expect(requests).toBe(1);
			expect(getLlmConcurrencyStatus().running).toBe(0);
		} finally {
			releaseBlocker?.();
			configureLlmConcurrency(originalLimit);
			globalThis.fetch = originalFetch;
		}
	});

	test("admits Pi streams through the global LLM semaphore until their upstream work settles (#1333)", async () => {
		const originalFetch = globalThis.fetch;
		const originalLimit = getLlmConcurrencyStatus().limit;
		let releaseBlocker: (() => void) | undefined;
		try {
			configureLlmConcurrency(1);
			const blocker = withLlmConcurrency(
				() =>
					new Promise<void>((resolve) => {
						releaseBlocker = resolve;
					}),
				5000,
				"test-blocker",
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			let requests = 0;
			globalThis.fetch = mock(() => {
				requests++;
				return Promise.resolve(
					new Response(
						`data: ${JSON.stringify({ choices: [{ delta: { content: "streamed" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
				);
			}) as unknown as typeof fetch;
			const provider = createPiModelProvider({
				executor: "openai-compatible",
				model: "stream-concurrency-test",
				baseUrl: "http://127.0.0.1:1234/v1",
			});
			const streamWithUsage = provider.streamWithUsage;
			if (!streamWithUsage) throw new Error("expected Pi stream support");
			const upstream = streamWithUsage("wait for admission", { timeoutMs: 5000 });
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(requests).toBe(0);

			releaseBlocker?.();
			await blocker;
			const result = await upstream;
			const reader = result.stream.getReader();
			let text = "";
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				if (next.value.type === "text-delta") text += next.value.text;
			}
			expect(text).toBe("streamed");
			expect(requests).toBe(1);
			expect(getLlmConcurrencyStatus().running).toBe(0);
		} finally {
			releaseBlocker?.();
			configureLlmConcurrency(originalLimit);
			globalThis.fetch = originalFetch;
		}
	});

	test("keeps the Pi stream permit through cancellation until the upstream stream settles (#1333)", async () => {
		const originalFetch = globalThis.fetch;
		const originalLimit = getLlmConcurrencyStatus().limit;
		let resolveResponse: ((response: Response) => void) | undefined;
		try {
			configureLlmConcurrency(1);
			let requests = 0;
			globalThis.fetch = mock(() => {
				requests++;
				return new Promise<Response>((resolve) => {
					resolveResponse = resolve;
				});
			}) as unknown as typeof fetch;
			const provider = createPiModelProvider({
				executor: "openai-compatible",
				model: "stream-cancel-concurrency-test",
				baseUrl: "http://127.0.0.1:1234/v1",
			});
			const streamWithUsage = provider.streamWithUsage;
			if (!streamWithUsage) throw new Error("expected Pi stream support");
			const result = await streamWithUsage("cancel after opening", { timeoutMs: 5000 });
			for (let i = 0; i < 20 && requests === 0; i += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(requests).toBe(1);
			expect(getLlmConcurrencyStatus().running).toBe(1);

			result.cancel();
			expect(getLlmConcurrencyStatus().running).toBe(1);
			resolveResponse?.(
				new Response(
					`data: ${JSON.stringify({ choices: [{ delta: { content: "late" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
			);
			await result.stream.getReader().closed.catch(() => {});
			for (let i = 0; i < 20 && getLlmConcurrencyStatus().running !== 0; i += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(getLlmConcurrencyStatus().running).toBe(0);
		} finally {
			resolveResponse?.(
				new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
			);
			configureLlmConcurrency(originalLimit);
			globalThis.fetch = originalFetch;
		}
	});
});
