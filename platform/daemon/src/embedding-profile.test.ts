import { describe, expect, it } from "bun:test";
import { embeddingProfileFingerprint, formatEmbeddingInput, resolveEmbeddingProfile } from "./embedding-profile";
import type { EmbeddingConfig } from "./memory-config";

function config(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
	return {
		provider: "ollama",
		model: "nomic-embed-text",
		dimensions: 768,
		base_url: "http://127.0.0.1:11434",
		profile: "nomic-embed-text-v1.5",
		...overrides,
	};
}

describe("embedding profiles", () => {
	it("uses Nomic's documented asymmetric retrieval prefixes", () => {
		const cfg = config();
		expect(resolveEmbeddingProfile(cfg).id).toBe("nomic-embed-text-v1.5");
		expect(formatEmbeddingInput("a note", cfg, "document")).toBe("search_document: a note");
		expect(formatEmbeddingInput("find it", cfg, "query")).toBe("search_query: find it");
	});

	it("formats Qwen retrieval queries but not passages", () => {
		const cfg = config({ model: "qwen3-embedding:0.6b", dimensions: 1024, profile: "qwen3-embedding" });
		expect(resolveEmbeddingProfile(cfg).id).toBe("qwen3-embedding");
		expect(formatEmbeddingInput("passage", cfg, "document")).toBe("passage");
		expect(formatEmbeddingInput("question", cfg, "query")).toBe(
			"Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: question",
		);
	});

	it("does not include secrets in the vector-space fingerprint", () => {
		const cfg = config({ api_key: "secret" });
		const withoutSecret = config();
		expect(embeddingProfileFingerprint(cfg)).toBe(embeddingProfileFingerprint(withoutSecret));
	});

	it("keeps legacy vectors raw until their generation is migrated", () => {
		const cfg = config({ profile: undefined });
		expect(formatEmbeddingInput("existing text", cfg, "document")).toBe("existing text");
		expect(formatEmbeddingInput("existing text", cfg, "query")).toBe("existing text");
	});
});
