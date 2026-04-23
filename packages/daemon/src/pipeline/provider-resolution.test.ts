import { describe, expect, it } from "bun:test";
import { createRuntimeProvider, isSupportedRuntimeProvider, resolveRuntimeModel } from "./provider-resolution";

describe("resolveRuntimeModel", () => {
	it("drops the configured model when a non-ollama provider falls back to ollama", () => {
		expect(resolveRuntimeModel("ollama", "codex", "gpt-5-codex-mini")).toBeUndefined();
	});

	it("drops the configured model when a non-llama-cpp provider falls back to llama-cpp", () => {
		expect(resolveRuntimeModel("llama-cpp", "codex", "gpt-5-codex-mini")).toBeUndefined();
	});

	it("keeps the model when ollama was explicitly configured", () => {
		expect(resolveRuntimeModel("ollama", "ollama", "qwen3.5:4b")).toBe("qwen3.5:4b");
	});

	it("keeps the model when llama-cpp was explicitly configured", () => {
		expect(resolveRuntimeModel("llama-cpp", "llama-cpp", "qwen3.5:4b")).toBe("qwen3.5:4b");
	});

	it("keeps the model when the effective provider still matches the configured provider", () => {
		expect(resolveRuntimeModel("codex", "codex", "gpt-5-codex-mini")).toBe("gpt-5-codex-mini");
	});
});

describe("isSupportedRuntimeProvider", () => {
	it("allows command for extraction only", () => {
		expect(isSupportedRuntimeProvider("extraction", "command")).toBe(true);
		expect(isSupportedRuntimeProvider("synthesis", "command")).toBe(false);
	});
});

describe("createRuntimeProvider", () => {
	it("returns null when a remote provider is missing required credentials", () => {
		const provider = createRuntimeProvider({
			role: "synthesis",
			effectiveProvider: "anthropic",
			configuredProvider: "anthropic",
			configuredModel: "haiku",
			timeoutMs: 1000,
			ollamaBaseUrl: "http://127.0.0.1:11434",
			ollamaFallbackBaseUrl: "http://127.0.0.1:11434",
			ollamaFallbackMaxContextTokens: 4096,
			openCodeBaseUrl: "http://127.0.0.1:4096",
			openRouterBaseUrl: "https://openrouter.ai/api/v1",
		});
		expect(provider).toBeNull();
	});

	it("creates an ollama provider when falling back from another backend", () => {
		const provider = createRuntimeProvider({
			role: "synthesis",
			effectiveProvider: "ollama",
			configuredProvider: "openrouter",
			configuredModel: "openai/gpt-4o-mini",
			timeoutMs: 1000,
			ollamaBaseUrl: "http://127.0.0.1:11434",
			ollamaFallbackBaseUrl: "http://127.0.0.1:11434",
			ollamaFallbackMaxContextTokens: 4096,
			openCodeBaseUrl: "http://127.0.0.1:4096",
			openRouterBaseUrl: "https://openrouter.ai/api/v1",
		});
		expect(provider?.name.startsWith("ollama:")).toBe(true);
	});
});
