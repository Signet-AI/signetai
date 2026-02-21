/**
 * Tests for the LlmProvider interface and OllamaProvider implementation.
 *
 * OllamaProvider uses the Ollama HTTP API, so we mock global fetch.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { createOllamaProvider } from "./provider";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
	globalThis.fetch = mock(handler as typeof fetch);
}

function restoreFetch(): void {
	globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOllamaProvider", () => {
	afterEach(() => restoreFetch());

	it("returns a provider with the correct name", () => {
		const provider = createOllamaProvider({ model: "llama3" });
		expect(provider.name).toBe("ollama:llama3");
	});

	it("uses the default model name when none is supplied", () => {
		const provider = createOllamaProvider();
		expect(provider.name).toContain("ollama:");
		expect(provider.name.length).toBeGreaterThan("ollama:".length);
	});

	it("generate() returns trimmed response on success", async () => {
		mockFetch(() =>
			Response.json({ response: "  hello world  \n" }),
		);

		const provider = createOllamaProvider({ model: "test-model" });
		const result = await provider.generate("test prompt");
		expect(result).toBe("hello world");
	});

	it("generate() throws on non-200 status", async () => {
		mockFetch(() => new Response("model not found", { status: 404 }));

		const provider = createOllamaProvider({ model: "test-model" });
		await expect(provider.generate("test prompt")).rejects.toThrow(
			/Ollama HTTP 404/,
		);
	});

	it("generate() throws on missing response field", async () => {
		mockFetch(() => Response.json({ done: true }));

		const provider = createOllamaProvider({ model: "test-model" });
		await expect(provider.generate("test prompt")).rejects.toThrow(
			/no response field/,
		);
	});

	it("generate() throws a timeout error on slow responses", async () => {
		mockFetch((_url, init) => {
			return new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (signal) {
					signal.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				}
			});
		});

		const provider = createOllamaProvider({
			model: "slow-model",
			defaultTimeoutMs: 50,
		});

		await expect(
			provider.generate("test prompt", { timeoutMs: 50 }),
		).rejects.toThrow(/timeout/i);
	});

	it("generate() sends maxTokens as num_predict", async () => {
		let capturedBody: Record<string, unknown> = {};
		mockFetch(async (_url, init) => {
			capturedBody = JSON.parse(init?.body as string);
			return Response.json({ response: "ok" });
		});

		const provider = createOllamaProvider({ model: "test-model" });
		await provider.generate("test", { maxTokens: 100 });
		expect((capturedBody.options as Record<string, unknown>)?.num_predict).toBe(100);
	});

	it("available() returns true when /api/tags responds 200", async () => {
		mockFetch(() => Response.json({ models: [] }));

		const provider = createOllamaProvider();
		const result = await provider.available();
		expect(result).toBe(true);
	});

	it("available() returns false when fetch throws", async () => {
		mockFetch(() => {
			throw new Error("connection refused");
		});

		const provider = createOllamaProvider();
		const result = await provider.available();
		expect(result).toBe(false);
	});

	it("available() returns false on non-200", async () => {
		mockFetch(() => new Response("error", { status: 500 }));

		const provider = createOllamaProvider();
		const result = await provider.available();
		expect(result).toBe(false);
	});
});
