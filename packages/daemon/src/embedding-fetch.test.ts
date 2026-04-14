import { afterEach, describe, expect, it, mock } from "bun:test";
import { fetchEmbedding, requiresOpenAiApiKey, setNativeFallbackProvider } from "./embedding-fetch";

const originalFetch = globalThis.fetch;

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
		setNativeFallbackProvider(null);
		delete process.env.OPENAI_API_KEY;
	});

	it("allows keyless requests for custom OpenAI-compatible endpoints", async () => {
		let capturedHeaders: HeadersInit | undefined;
		globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = init?.headers;
			return Promise.resolve(Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
		}) as typeof fetch;

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

	it("routes to ollama when nativeFallbackProvider is 'ollama'", async () => {
		let capturedUrl: string | undefined;
		globalThis.fetch = mock((url: string | URL | Request) => {
			capturedUrl = url.toString();
			return Promise.resolve(Response.json({ embedding: [0.5, 0.6, 0.7] }));
		}) as typeof fetch;

		setNativeFallbackProvider("ollama");
		const result = await fetchEmbedding("test", {
			provider: "native",
			model: "nomic-embed-text",
			dimensions: 3,
		});

		expect(result).toEqual([0.5, 0.6, 0.7]);
		expect(capturedUrl).toContain("/api/embeddings");
	});

	it("routes to llama.cpp when nativeFallbackProvider is 'llama-cpp'", async () => {
		let capturedUrl: string | undefined;
		let capturedBody: string | undefined;
		globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url.toString();
			capturedBody = init?.body as string;
			return Promise.resolve(Response.json({ data: [{ embedding: [0.8, 0.9, 1.0] }] }));
		}) as typeof fetch;

		setNativeFallbackProvider("llama-cpp");
		const result = await fetchEmbedding("test", {
			provider: "native",
			model: "nomic-embed-text",
			dimensions: 3,
		});

		expect(result).toEqual([0.8, 0.9, 1.0]);
		expect(capturedUrl).toContain("localhost:8080");
		expect(capturedUrl).toContain("/v1/embeddings");
		expect(capturedBody).toContain("nomic-embed-text");
	});

	it("returns null when llama.cpp fallback provider is set but server unreachable", async () => {
		globalThis.fetch = mock(() => {
			return Promise.resolve(new Response("not found", { status: 500 }));
		}) as typeof fetch;

		setNativeFallbackProvider("llama-cpp");
		const result = await fetchEmbedding("test", {
			provider: "native",
			model: "nomic-embed-text",
			dimensions: 3,
		});

		expect(result).toBeNull();
	});

	it("falls back to llama.cpp when native fails, skipping ollama", async () => {
		let capturedUrl: string | undefined;
		globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
			const urlStr = url.toString();
			if (urlStr.includes("localhost:8080")) {
				if (urlStr.includes("/v1/models")) {
					return Promise.resolve(Response.json({ data: [{ id: "nomic-embed-text" }] }));
				}
				capturedUrl = urlStr;
				return Promise.resolve(Response.json({ data: [{ embedding: [0.1, 0.2] }] }));
			}
			return Promise.resolve(new Response("unreachable", { status: 503 }));
		}) as typeof fetch;

		setNativeFallbackProvider(null);
		const result = await fetchEmbedding("test", {
			provider: "native",
			model: "nomic-embed-text-v1.5",
			dimensions: 2,
		});

		expect(result).toEqual([0.1, 0.2]);
		expect(capturedUrl).toContain("localhost:8080");
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
		}) as typeof fetch;

		setNativeFallbackProvider(null);
		const result = await fetchEmbedding("test", {
			provider: "native",
			model: "nomic-embed-text-v1.5",
			dimensions: 2,
		});

		expect(result).toEqual([0.5, 0.6]);
		expect(capturedUrl).toContain("localhost:11434");
	});

	it("returns null when native provider is 'none'", async () => {
		const result = await fetchEmbedding("test", {
			provider: "none",
			model: "",
			dimensions: 0,
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
		}) as typeof fetch;

		setNativeFallbackProvider("llama-cpp");
		const result = await fetchEmbedding("test", {
			provider: "native",
			model: "nomic-embed-text",
			dimensions: 2,
		});

		expect(result).toBeNull();
		expect(ollamaCalled).toBe(false);
	});
});
