import { afterEach, describe, expect, it, mock } from "bun:test";
import { fetchEmbedding, setNativeFallbackProvider } from "../embedding-fetch";
import { checkEmbeddingProvider } from "./utils";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	setNativeFallbackProvider(null);
});

describe("checkEmbeddingProvider native kill-switch (#1073)", () => {
	it("reports the local fallback as available without touching native", async () => {
		const urls: string[] = [];
		globalThis.fetch = mock((url: string | URL | Request) => {
			const value = url.toString();
			urls.push(value);
			if (value.includes("localhost:8080")) return Promise.resolve(new Response("unavailable", { status: 503 }));
			return Promise.resolve(Response.json({ embedding: [0.1, 0.2, 0.3] }));
		}) as unknown as typeof fetch;

		const status = await checkEmbeddingProvider({
			provider: "native",
			model: "nomic-embed-text-v1.5",
			dimensions: 768,
			base_url: "",
			warmNative: false,
		});
		expect(status.available).toBe(true);
		expect(status.dimensions).toBe(3);
		expect(status.error).toContain("warmNative: false");
		expect(status.error).toContain("local fallback");
		expect(urls.some((url) => url.includes("localhost:8080/v1/models"))).toBe(true);
		expect(urls.some((url) => url.includes("localhost:11434/api/embeddings"))).toBe(true);
	});

	it("probes the configured llama.cpp base_url when native is unavailable (#1159)", async () => {
		mock.module("../native-embedding", () => ({
			checkNativeProvider: () =>
				Promise.resolve({ available: false, error: "native unavailable (mocked)", modelCached: false }),
		}));

		const urls: string[] = [];
		globalThis.fetch = mock((url: string | URL | Request) => {
			const value = url.toString();
			urls.push(value);
			if (value.includes(":8080")) return Promise.resolve(new Response("unreachable", { status: 503 }));
			if (value.includes(":8081")) {
				if (value.endsWith("/v1/models")) {
					return Promise.resolve(Response.json({ data: [{ id: "nomic-embed-text" }] }));
				}
				return Promise.resolve(Response.json({ data: [{ embedding: [0.5, 0.6] }] }));
			}
			if (value.includes(":11434")) {
				if (value.endsWith("/api/tags")) {
					return Promise.resolve(Response.json({ models: [{ name: "nomic-embed-text:latest" }] }));
				}
				return Promise.resolve(Response.json({ embedding: [0.7, 0.8] }));
			}
			return Promise.resolve(new Response("unreachable", { status: 503 }));
		}) as unknown as typeof fetch;

		const cfg = {
			provider: "native" as const,
			model: "nomic-embed-text-v1.5",
			dimensions: 768,
			base_url: "http://localhost:8081",
		};

		// Startup status check pins the fallback provider; a fetch after it
		// must use the configured llama.cpp server, not the default-port probe.
		const status = await checkEmbeddingProvider(cfg);
		const result = await fetchEmbedding("test", cfg);

		expect(status.error).toContain("llama.cpp fallback");
		expect(urls.some((url) => url.includes(":8081/v1/models"))).toBe(true);
		expect(urls.some((url) => url.includes(":8081/v1/embeddings"))).toBe(true);
		expect(urls.some((url) => url.includes(":8080"))).toBe(false);
		expect(urls.some((url) => url.includes(":11434/api/embeddings"))).toBe(false);
		expect(result).toEqual([0.5, 0.6]);
	});
});
