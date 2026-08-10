import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	fetchEmbedding,
	requiresOpenAiApiKey,
	setNativeEmbeddingProviderForTest,
	setNativeFallbackProvider,
} from "./embedding-fetch";
import { countTokens } from "./pipeline/tokenizer";
import { type TelemetryCollector, type TelemetryEvent, setActiveTelemetry } from "./telemetry";

const originalFetch = globalThis.fetch;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

function captureTelemetry(): { readonly collector: TelemetryCollector; readonly events: TelemetryEvent[] } {
	const events: TelemetryEvent[] = [];
	const collector: TelemetryCollector = {
		enabled: true,
		record(event, properties): void {
			events.push({ id: "test", event, timestamp: "2026-01-01T00:00:00.000Z", properties });
		},
		async flush(): Promise<void> {},
		start(): void {},
		async stop(): Promise<void> {},
		query(): readonly TelemetryEvent[] {
			return events;
		},
	};
	return { collector, events };
}

describe("requiresOpenAiApiKey", () => {
	it("requires a key for official OpenAI endpoints", () => {
		expect(requiresOpenAiApiKey("https://api.openai.com/v1")).toBe(true);
	});

	it("does not require a key for custom OpenAI-compatible endpoints", () => {
		expect(requiresOpenAiApiKey("http://localhost:1234/v1")).toBe(false);
	});

	it("does not treat proxy paths containing api.openai.com as official", () => {
		expect(requiresOpenAiApiKey("http://proxy.example.com/api.openai.com/v1")).toBe(false);
	});
});

describe("fetchEmbedding", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
		setActiveTelemetry(undefined);
		setNativeEmbeddingProviderForTest(null);
		setNativeFallbackProvider(null);
		if (originalOpenAiApiKey === undefined) {
			Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
		} else {
			process.env.OPENAI_API_KEY = originalOpenAiApiKey;
		}
	});

	it("allows keyless requests for custom OpenAI-compatible endpoints", async () => {
		let capturedHeaders: HeadersInit | undefined;
		globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = init?.headers;
			return Promise.resolve(Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
		}) as unknown as typeof fetch;

		const result = await fetchEmbedding("hello", {
			provider: "openai",
			model: "text-embedding-3-small",
			dimensions: 3,
			base_url: "http://localhost:1234/v1",
		});

		expect(result).toEqual([0.1, 0.2, 0.3]);
		expect(capturedHeaders).toEqual({
			"Content-Type": "application/json",
		});
	});

	it("does not record provider-down telemetry when the official OpenAI provider is not configured", async () => {
		const telemetry = captureTelemetry();
		setActiveTelemetry(telemetry.collector);
		Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
		globalThis.fetch = mock(() => {
			throw new Error("the provider must not be contacted");
		}) as unknown as typeof fetch;

		await expect(
			fetchEmbedding("hello", {
				provider: "openai",
				model: "text-embedding-3-small",
				dimensions: 3,
				base_url: "https://api.openai.com/v1",
			}),
		).resolves.toBeNull();

		expect(telemetry.events.filter((event) => event.event === "pipeline.error")).toHaveLength(0);
	});

	it("uses the query formatter when role is passed before request options", async () => {
		let capturedInput = "";
		globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
			capturedInput = (JSON.parse(String(init?.body)) as { input: string }).input;
			return Promise.resolve(Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
		}) as unknown as typeof fetch;

		await fetchEmbedding(
			"where is my note?",
			{
				provider: "openai",
				model: "nomic-embed-text-v1.5",
				dimensions: 3,
				base_url: "http://localhost:1234/v1",
				profile: "nomic-embed-text-v1.5",
			},
			"query",
		);

		expect(capturedInput).toBe("search_query: where is my note?");
	});

	it("composes caller abort signals with provider timeouts", async () => {
		const controller = new AbortController();
		let capturedSignal: AbortSignal | null | undefined;
		globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
			capturedSignal = init?.signal;
			expect(capturedSignal).not.toBe(controller.signal);
			expect(capturedSignal?.aborted).toBe(false);
			controller.abort();
			expect(capturedSignal?.aborted).toBe(true);
			return Promise.resolve(Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
		}) as unknown as typeof fetch;

		const result = await fetchEmbedding(
			"hello",
			{
				provider: "openai",
				model: "text-embedding-3-small",
				dimensions: 3,
				base_url: "http://localhost:1234/v1",
			},
			{ signal: controller.signal },
		);

		expect(result).toEqual([0.1, 0.2, 0.3]);
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("uses configured timeout for provider requests", async () => {
		const telemetry = captureTelemetry();
		setActiveTelemetry(telemetry.collector);
		let capturedSignal: AbortSignal | null | undefined;
		globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
			capturedSignal = init?.signal;
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
					once: true,
				});
			});
		}) as unknown as typeof fetch;

		const start = Date.now();
		const result = await fetchEmbedding(
			"hello",
			{
				provider: "openai",
				model: "text-embedding-3-small",
				dimensions: 3,
				base_url: "http://localhost:1234/v1",
			},
			{ timeoutMs: 20 },
		);

		expect(result).toBeNull();
		expect(capturedSignal?.aborted).toBe(true);
		expect(Date.now() - start).toBeLessThan(1000);
		expect(telemetry.events).toContainEqual(
			expect.objectContaining({
				event: "pipeline.error",
				properties: { stage: "embedding", code: "EMBEDDING_TIMEOUT" },
			}),
		);
	});

	it("routes to ollama when nativeFallbackProvider is 'ollama'", async () => {
		let capturedUrl: string | undefined;
		globalThis.fetch = mock((url: string | URL | Request) => {
			capturedUrl = url.toString();
			return Promise.resolve(Response.json({ embedding: [0.5, 0.6, 0.7] }));
		}) as unknown as typeof fetch;

		setNativeFallbackProvider("ollama");
		const result = await fetchEmbedding("test", {
			provider: "native",
			model: "nomic-embed-text",
			dimensions: 3,
			base_url: "",
		});

		expect(result).toEqual([0.5, 0.6, 0.7]);
		expect(capturedUrl).toContain("/api/embeddings");
	});

	it("classifies an embedding context-limit rejection without exposing its response body", async () => {
		const causes: string[] = [];
		globalThis.fetch = mock(() =>
			Promise.resolve(Response.json({ error: { message: "maximum context length exceeded" } }, { status: 400 })),
		) as unknown as typeof fetch;

		await expect(
			fetchEmbedding(
				"oversized input",
				{
					provider: "openai",
					model: "text-embedding-3-small",
					dimensions: 3,
					base_url: "http://localhost:1234/v1",
				},
				{ onFailure: (cause) => causes.push(cause) },
			),
		).resolves.toBeNull();

		expect(causes).toEqual(["context_limit"]);
	});

	it("never touches native when warmNative is false and routes to the fallback chain (#1073)", async () => {
		let capturedUrl: string | undefined;
		globalThis.fetch = mock((url: string | URL | Request) => {
			capturedUrl = url.toString();
			return Promise.resolve(Response.json({ embedding: [0.5, 0.6, 0.7] }));
		}) as unknown as typeof fetch;

		// No fallback provider cached yet: the kill-switch must fall through
		// to the probe chain (ollama is probed), never initialize native.
		setNativeFallbackProvider(null);
		const result = await fetchEmbedding("test", {
			provider: "native",
			model: "nomic-embed-text",
			dimensions: 3,
			base_url: "",
			warmNative: false,
		});

		expect(result).toEqual([0.5, 0.6, 0.7]);
		expect(capturedUrl).toContain("/api/embeddings");
		expect(capturedUrl).toContain("localhost");
	});

	it("does not record provider-down telemetry when native embeddings are disabled without a fallback", async () => {
		const telemetry = captureTelemetry();
		setActiveTelemetry(telemetry.collector);
		setNativeFallbackProvider("unavailable");

		await expect(
			fetchEmbedding("test", {
				provider: "native",
				model: "nomic-embed-text",
				dimensions: 3,
				base_url: "",
				warmNative: false,
			}),
		).resolves.toBeNull();

		expect(telemetry.events.filter((event) => event.event === "pipeline.error")).toHaveLength(0);
	});

	it("records provider-down telemetry when native inference fails without a fallback", async () => {
		const telemetry = captureTelemetry();
		setActiveTelemetry(telemetry.collector);
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("unreachable", { status: 503 })),
		) as unknown as typeof fetch;
		setNativeEmbeddingProviderForTest(async () => {
			throw new Error("native unavailable");
		});

		await expect(
			fetchEmbedding("test", {
				provider: "native",
				model: "nomic-embed-text",
				dimensions: 3,
				base_url: "",
			}),
		).resolves.toBeNull();

		expect(telemetry.events).toContainEqual(
			expect.objectContaining({
				event: "pipeline.error",
				properties: { stage: "embedding", code: "EMBEDDING_PROVIDER_DOWN" },
			}),
		);
	});

	it("routes to llama.cpp when nativeFallbackProvider is 'llama-cpp'", async () => {
		let capturedUrl: string | undefined;
		let capturedBody: string | undefined;
		globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url.toString();
			capturedBody = init?.body as string;
			return Promise.resolve(Response.json({ data: [{ embedding: [0.8, 0.9, 1.0] }] }));
		}) as unknown as typeof fetch;

		setNativeFallbackProvider("llama-cpp");
		const result = await fetchEmbedding("test", {
			provider: "native",
			model: "nomic-embed-text",
			dimensions: 3,
			base_url: "",
		});

		expect(result).toEqual([0.8, 0.9, 1.0]);
		expect(capturedUrl).toContain("localhost:8080");
		expect(capturedUrl).toContain("/v1/embeddings");
		expect(capturedBody).toContain("nomic-embed-text");
	});

	it("bounds cached llama.cpp fallback inputs with the configured limit", async () => {
		let capturedInput = "";
		globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
			capturedInput = (JSON.parse(String(init?.body)) as { input: string }).input;
			return Promise.resolve(Response.json({ data: [{ embedding: [0.8, 0.9] }] }));
		}) as unknown as typeof fetch;

		setNativeFallbackProvider("llama-cpp");
		const result = await fetchEmbedding("token ".repeat(1000), {
			provider: "native",
			model: "nomic-embed-text",
			dimensions: 2,
			base_url: "",
			llamaCppMaxInputTokens: 256,
		});

		expect(result).toEqual([0.8, 0.9]);
		expect(countTokens(capturedInput)).toBeLessThanOrEqual(256);
	});

	it("returns null when llama.cpp fallback provider is set but server unreachable", async () => {
		const telemetry = captureTelemetry();
		setActiveTelemetry(telemetry.collector);
		globalThis.fetch = mock(() => {
			return Promise.resolve(new Response("not found", { status: 500 }));
		}) as unknown as typeof fetch;

		setNativeFallbackProvider("llama-cpp");
		const result = await fetchEmbedding("test", {
			provider: "native",
			model: "nomic-embed-text",
			dimensions: 3,
			base_url: "",
		});

		expect(result).toBeNull();
		expect(telemetry.events).toContainEqual(
			expect.objectContaining({
				event: "pipeline.error",
				properties: { stage: "embedding", code: "EMBEDDING_PROVIDER_DOWN" },
			}),
		);
	});

	it("falls back to llama.cpp when native fails, skipping ollama", async () => {
		let capturedUrl: string | undefined;
		let capturedInput = "";
		globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
			const urlStr = url.toString();
			if (urlStr.includes("localhost:8080")) {
				if (urlStr.includes("/v1/models")) {
					return Promise.resolve(Response.json({ data: [{ id: "nomic-embed-text" }] }));
				}
				capturedUrl = urlStr;
				capturedInput = (JSON.parse(String(init?.body)) as { input: string }).input;
				return Promise.resolve(Response.json({ data: [{ embedding: [0.1, 0.2] }] }));
			}
			return Promise.resolve(new Response("unreachable", { status: 503 }));
		}) as unknown as typeof fetch;

		setNativeFallbackProvider(null);
		setNativeEmbeddingProviderForTest(async () => {
			throw new Error("native unavailable");
		});
		const result = await fetchEmbedding("token ".repeat(1000), {
			provider: "native",
			model: "nomic-embed-text-v1.5",
			dimensions: 2,
			base_url: "",
			llamaCppMaxInputTokens: 300,
		});

		expect(result).toEqual([0.1, 0.2]);
		expect(capturedUrl).toContain("localhost:8080");
		expect(countTokens(capturedInput)).toBeLessThanOrEqual(300);
	});

	it("bounds configured llama.cpp inputs while preserving short inputs", async () => {
		const capturedInputs: string[] = [];
		globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
			capturedInputs.push((JSON.parse(String(init?.body)) as { input: string }).input);
			return Promise.resolve(Response.json({ data: [{ embedding: [0.1, 0.2] }] }));
		}) as unknown as typeof fetch;
		const cfg = {
			provider: "llama-cpp" as const,
			model: "nomic-embed-text",
			dimensions: 2,
			base_url: "http://localhost:8080",
			llamaCppMaxInputTokens: 256,
		};

		await fetchEmbedding("short input", cfg);
		await fetchEmbedding("token ".repeat(1000), cfg);

		expect(capturedInputs[0]).toBe("short input");
		expect(countTokens(capturedInputs[1] ?? "")).toBeLessThanOrEqual(256);
	});

	it("falls back to ollama when both native and llama.cpp fail", async () => {
		let capturedUrl: string | undefined;
		globalThis.fetch = mock((url: string | URL | Request) => {
			const urlStr = url.toString();
			if (urlStr.includes("localhost:8080")) {
				return Promise.resolve(new Response("unreachable", { status: 503 }));
			}
			if (urlStr.includes("localhost:11434")) {
				capturedUrl = urlStr;
				return Promise.resolve(Response.json({ embedding: [0.5, 0.6] }));
			}
			return Promise.resolve(new Response("unreachable", { status: 503 }));
		}) as unknown as typeof fetch;

		setNativeFallbackProvider(null);
		setNativeEmbeddingProviderForTest(async () => {
			throw new Error("native unavailable");
		});
		const result = await fetchEmbedding("test", {
			provider: "native",
			model: "nomic-embed-text-v1.5",
			dimensions: 2,
			base_url: "",
		});

		expect(result).toEqual([0.5, 0.6]);
		expect(capturedUrl).toContain("localhost:11434");
	});

	it("probes the configured llama.cpp base_url, not the compiled default (#1159)", async () => {
		const llamaUrls: string[] = [];
		globalThis.fetch = mock((url: string | URL | Request) => {
			const urlStr = url.toString();
			llamaUrls.push(urlStr);
			if (urlStr.includes(":8081")) {
				if (urlStr.endsWith("/v1/models")) {
					return Promise.resolve(Response.json({ data: [{ id: "nomic-embed-text" }] }));
				}
				return Promise.resolve(Response.json({ data: [{ embedding: [0.5, 0.6] }] }));
			}
			if (urlStr.includes(":11434")) {
				return Promise.resolve(Response.json({ embedding: [0.7, 0.8] }));
			}
			return Promise.resolve(new Response("unreachable", { status: 503 }));
		}) as unknown as typeof fetch;

		setNativeFallbackProvider(null);
		setNativeEmbeddingProviderForTest(async () => {
			throw new Error("native unavailable");
		});
		const result = await fetchEmbedding("test", {
			provider: "native",
			model: "nomic-embed-text-v1.5",
			dimensions: 2,
			base_url: "http://localhost:8081",
		});

		expect(result).toEqual([0.5, 0.6]);
		expect(llamaUrls.some((u) => u.includes(":8081"))).toBe(true);
		expect(llamaUrls.some((u) => u.includes(":8080"))).toBe(false);
	});

	it("single-flights failed local fallback discovery and negative-caches the result", async () => {
		let nativeCalls = 0;
		let llamaModelProbes = 0;
		let ollamaProbes = 0;
		globalThis.fetch = mock((url: string | URL | Request) => {
			const value = url.toString();
			if (value.includes("/v1/models")) llamaModelProbes++;
			if (value.includes("/api/embeddings")) ollamaProbes++;
			return Promise.resolve(new Response("unreachable", { status: 503 }));
		}) as unknown as typeof fetch;

		setNativeEmbeddingProviderForTest(async () => {
			nativeCalls++;
			throw new Error("native worker timed out");
		});
		const cfg = {
			provider: "native" as const,
			model: "nomic-embed-text-v1.5",
			dimensions: 768,
			base_url: "",
		};

		const results = await Promise.all(Array.from({ length: 20 }, (_, index) => fetchEmbedding(`text-${index}`, cfg)));
		expect(results.every((result) => result === null)).toBe(true);
		expect(nativeCalls).toBe(20);
		expect(llamaModelProbes).toBe(1);
		expect(ollamaProbes).toBe(1);

		await expect(fetchEmbedding("after-negative-cache", cfg)).resolves.toBeNull();
		expect(nativeCalls).toBe(20);
		expect(llamaModelProbes).toBe(1);
		expect(ollamaProbes).toBe(1);
	});

	it("returns null when native provider is 'none'", async () => {
		const result = await fetchEmbedding("test", {
			provider: "none",
			model: "",
			dimensions: 0,
			base_url: "",
		});
		expect(result).toBeNull();
	});

	it("does not cross-contaminate: llama-cpp fallback does not route to ollama", async () => {
		let ollamaCalled = false;
		globalThis.fetch = mock((url: string | URL | Request) => {
			if (url.toString().includes("localhost:11434")) {
				ollamaCalled = true;
				return Promise.resolve(Response.json({ embedding: [0.9, 0.9] }));
			}
			return Promise.resolve(new Response("unreachable", { status: 503 }));
		}) as unknown as typeof fetch;

		setNativeFallbackProvider("llama-cpp");
		const result = await fetchEmbedding("test", {
			provider: "native",
			model: "nomic-embed-text",
			dimensions: 2,
			base_url: "",
		});

		expect(result).toBeNull();
		expect(ollamaCalled).toBe(false);
	});
});
