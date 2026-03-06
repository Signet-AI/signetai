import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	fetchEmbedding,
	requiresOpenAiApiKey,
	setNativeFallbackToOllama,
} from "./embedding-fetch";

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
		setNativeFallbackToOllama(false);
		delete process.env.OPENAI_API_KEY;
	});

	it("allows keyless requests for custom OpenAI-compatible endpoints", async () => {
		let capturedHeaders: HeadersInit | undefined;
		globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = init?.headers;
			return Promise.resolve(
				Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
			);
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
});
