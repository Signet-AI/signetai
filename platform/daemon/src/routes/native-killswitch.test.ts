import { afterEach, describe, expect, it, mock } from "bun:test";
import { setNativeFallbackProvider } from "../embedding-fetch";
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
});
