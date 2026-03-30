/**
 * Tests for the LlmProvider interface and OllamaProvider implementation.
 *
 * OllamaProvider uses the Ollama HTTP API, so we mock global fetch.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
	DEFAULT_OLLAMA_FALLBACK_MAX_CONTEXT_TOKENS,
	createOllamaProvider,
	createClaudeCodeProvider,
	createCodexProvider,
	createOpenCodeProvider,
	createOpenRouterProvider,
	resolveDefaultOllamaFallbackMaxContextTokens,
	resolveDefaultOllamaFallbackModel,
} from "./provider";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const originalSpawn = Bun.spawn;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
	globalThis.fetch = mock(handler as typeof fetch);
}

function restoreFetch(): void {
	globalThis.fetch = originalFetch;
}

function restoreSpawn(): void {
	Bun.spawn = originalSpawn;
}

function streamFromString(value: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(value));
			controller.close();
		},
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObjectBody(body: BodyInit | null | undefined): Record<string, unknown> {
	if (typeof body !== "string") {
		throw new Error("Expected JSON body to be a string");
	}
	const parsed: unknown = JSON.parse(body);
	if (!isRecord(parsed)) {
		throw new Error("Expected JSON body to parse as an object");
	}
	return parsed;
}

function getObjectField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
	const value = record[key];
	return isRecord(value) ? value : undefined;
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOllamaProvider", () => {
	afterEach(() => restoreFetch());

	function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
		if (typeof value !== "object" || value === null) return false;
		const then = Reflect.get(value, "then");
		return typeof then === "function";
	}

	function withEnvOverride<T>(
		key: "SIGNET_OLLAMA_FALLBACK_MODEL" | "SIGNET_OLLAMA_FALLBACK_MAX_CTX",
		value: string,
		fn: () => T | Promise<T>,
	): T | Promise<T> {
		const prev = process.env[key];
		process.env[key] = value;
		const restore = (): void => {
			if (prev === undefined) {
				delete process.env[key];
				return;
			}
			process.env[key] = prev;
		};

		try {
			const result = fn();
			if (isPromiseLike<T>(result)) {
				return Promise.resolve(result).finally(restore);
			}
			restore();
			return result;
		} catch (error) {
			restore();
			throw error;
		}
	}

	it("returns a provider with the correct name", () => {
		const provider = createOllamaProvider({ model: "llama3" });
		expect(provider.name).toBe("ollama:llama3");
	});

	it("uses the default model name when none is supplied", () => {
		const provider = createOllamaProvider();
		expect(provider.name).toContain("ollama:");
		expect(provider.name.length).toBeGreaterThan("ollama:".length);
	});

	it("resolves fallback model from SIGNET_OLLAMA_FALLBACK_MODEL", () => {
		withEnvOverride("SIGNET_OLLAMA_FALLBACK_MODEL", "mistral:7b", () => {
			expect(resolveDefaultOllamaFallbackModel()).toBe("mistral:7b");
		});
	});

	it("returns default max context when SIGNET_OLLAMA_FALLBACK_MAX_CTX is invalid", () => {
		withEnvOverride("SIGNET_OLLAMA_FALLBACK_MAX_CTX", "abc", () => {
			expect(resolveDefaultOllamaFallbackMaxContextTokens()).toBe(DEFAULT_OLLAMA_FALLBACK_MAX_CONTEXT_TOKENS);
		});
	});

	it("returns default max context when SIGNET_OLLAMA_FALLBACK_MAX_CTX has trailing text", () => {
		withEnvOverride("SIGNET_OLLAMA_FALLBACK_MAX_CTX", "8192foo", () => {
			expect(resolveDefaultOllamaFallbackMaxContextTokens()).toBe(DEFAULT_OLLAMA_FALLBACK_MAX_CONTEXT_TOKENS);
		});
	});

	it("uses SIGNET_OLLAMA_FALLBACK_MODEL when model is not explicitly configured", () => {
		withEnvOverride("SIGNET_OLLAMA_FALLBACK_MODEL", "llama3.1:8b", () => {
			const provider = createOllamaProvider();
			expect(provider.name).toBe("ollama:llama3.1:8b");
		});
	});

	it("withEnvOverride keeps env set for async callbacks", async () => {
		const key = "SIGNET_OLLAMA_FALLBACK_MODEL";
		const prev = process.env[key];
		await withEnvOverride(key, "async-test-model", async () => {
			await Promise.resolve();
			expect(process.env[key]).toBe("async-test-model");
		});
		expect(process.env[key]).toBe(prev);
	});

	it("generate() returns trimmed response on success", async () => {
		mockFetch(() => Response.json({ response: "  hello world  \n" }));

		const provider = createOllamaProvider({ model: "test-model" });
		const result = await provider.generate("test prompt");
		expect(result).toBe("hello world");
	});

	it("generate() throws on non-200 status", async () => {
		mockFetch(() => new Response("model not found", { status: 404 }));

		const provider = createOllamaProvider({ model: "test-model" });
		await expect(provider.generate("test prompt")).rejects.toThrow(/Ollama HTTP 404/);
	});

	it("generate() throws on missing response field", async () => {
		mockFetch(() => Response.json({ done: true }));

		const provider = createOllamaProvider({ model: "test-model" });
		await expect(provider.generate("test prompt")).rejects.toThrow(/no response field/);
	});

	it("generate() throws a timeout error on slow responses", async () => {
		mockFetch((_url, init) => {
			return new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (signal) {
					signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				}
			});
		});

		const provider = createOllamaProvider({
			model: "slow-model",
			defaultTimeoutMs: 50,
		});

		await expect(provider.generate("test prompt", { timeoutMs: 50 })).rejects.toThrow(/timeout/i);
	});

	it("generate() sends maxTokens as num_predict", async () => {
		let capturedBody: Record<string, unknown> = {};
		mockFetch(async (_url, init) => {
			capturedBody = parseJsonObjectBody(init?.body);
			return Response.json({ response: "ok" });
		});

		const provider = createOllamaProvider({ model: "test-model" });
		await provider.generate("test", { maxTokens: 100 });
		const options = getObjectField(capturedBody, "options");
		expect(options ? getNumberField(options, "num_predict") : undefined).toBe(100);
	});

	it("generate() sends maxContextTokens as num_ctx", async () => {
		let capturedBody: Record<string, unknown> = {};
		mockFetch(async (_url, init) => {
			capturedBody = parseJsonObjectBody(init?.body);
			return Response.json({ response: "ok" });
		});

		const provider = createOllamaProvider({
			model: "test-model",
			maxContextTokens: 4096,
		});
		await provider.generate("test");
		const options = getObjectField(capturedBody, "options");
		expect(options ? getNumberField(options, "num_ctx") : undefined).toBe(4096);
	});

	it("generate() omits num_ctx when maxContextTokens is non-finite", async () => {
		let capturedBody: Record<string, unknown> = {};
		mockFetch(async (_url, init) => {
			capturedBody = parseJsonObjectBody(init?.body);
			return Response.json({ response: "ok" });
		});

		const provider = createOllamaProvider({
			model: "test-model",
			maxContextTokens: Number.NaN,
		});
		await provider.generate("test");
		expect(getObjectField(capturedBody, "options")).toBeUndefined();
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

// ---------------------------------------------------------------------------
// Claude Code provider
// ---------------------------------------------------------------------------

describe("createClaudeCodeProvider", () => {
	it("returns a provider with the correct name", () => {
		const provider = createClaudeCodeProvider({ model: "haiku" });
		expect(provider.name).toBe("claude-code:haiku");
	});

	it("uses the default model (haiku) when none is supplied", () => {
		const provider = createClaudeCodeProvider();
		expect(provider.name).toBe("claude-code:haiku");
	});

	it("available() returns true when claude CLI is installed", async () => {
		const provider = createClaudeCodeProvider();
		const result = await provider.available();
		// This will be true in dev environments where claude is installed
		expect(typeof result).toBe("boolean");
	});
});

describe("createCodexProvider", () => {
	afterEach(() => restoreSpawn());

	it("uses the default model (gpt-5-codex-mini) when none is supplied", () => {
		const provider = createCodexProvider();
		expect(provider.name).toBe("codex:gpt-5-codex-mini");
	});

	it("returns a provider with the correct name", () => {
		const provider = createCodexProvider({ model: "gpt-5.3-codex" });
		expect(provider.name).toBe("codex:gpt-5.3-codex");
	});

	it("generateWithUsage() parses JSONL agent output and usage", async () => {
		let capturedArgs: string[] = [];
		Bun.spawn = mock((args: string[]) => {
			capturedArgs = args;
			return {
				stdout: streamFromString(
					'{"type":"thread.started","thread_id":"abc"}\n{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":5,"output_tokens":7}}\n',
				),
				stderr: streamFromString(""),
				exited: Promise.resolve(0),
				kill() {},
			};
		}) as typeof Bun.spawn;

		const provider = createCodexProvider({ model: "gpt-5.3-codex" });
		const result = await provider.generateWithUsage!("test");
		expect(result.text).toBe("done");
		expect(result.usage?.inputTokens).toBe(12);
		expect(result.usage?.cacheReadTokens).toBe(5);
		expect(result.usage?.outputTokens).toBe(7);
		expect(capturedArgs).not.toContain("-a");
	});

	it("generate() throws on non-zero exit", async () => {
		Bun.spawn = mock((_args: string[]) => ({
			stdout: streamFromString(""),
			stderr: streamFromString("boom"),
			exited: Promise.resolve(1),
			kill() {},
		})) as typeof Bun.spawn;

		const provider = createCodexProvider({ model: "gpt-5.3-codex" });
		await expect(provider.generate("test")).rejects.toThrow(/codex exit 1/);
	});

	it("generate() reports timeout when kill triggers a non-zero exit", async () => {
		Bun.spawn = mock((_args: string[]) => {
			let resolveExit!: (code: number) => void;
			const exited = new Promise<number>((resolve) => {
				resolveExit = resolve;
			});

			return {
				stdout: streamFromString(""),
				stderr: streamFromString("timed out"),
				exited,
				kill() {
					resolveExit(143);
				},
			};
		}) as typeof Bun.spawn;

		const provider = createCodexProvider({
			model: "gpt-5.3-codex",
			defaultTimeoutMs: 1,
		});
		await expect(provider.generate("test")).rejects.toThrow(/codex timeout after 1ms/);
	});
});

// ---------------------------------------------------------------------------
// OpenCode provider
// ---------------------------------------------------------------------------

/** Helper: build an OpenCode-shaped message response */
function openCodeResponse(text: string, tokens?: { input?: number; output?: number }, cost?: number) {
	return {
		info: {
			role: "assistant",
			id: "msg_test",
			sessionID: "ses_test",
			cost: cost ?? 0,
			tokens: {
				total: (tokens?.input ?? 0) + (tokens?.output ?? 0),
				input: tokens?.input ?? 0,
				output: tokens?.output ?? 0,
				reasoning: 0,
				cache: { read: 0, write: 0 },
			},
		},
		parts: [
			{ type: "step-start", id: "prt_1", sessionID: "ses_test", messageID: "msg_test" },
			{ type: "text", text, id: "prt_2", sessionID: "ses_test", messageID: "msg_test" },
			{ type: "step-finish", id: "prt_3", sessionID: "ses_test", messageID: "msg_test", reason: "stop" },
		],
	};
}

describe("createOpenCodeProvider", () => {
	afterEach(() => restoreFetch());

	it("returns a provider with the correct name", () => {
		const provider = createOpenCodeProvider({ model: "anthropic/claude-haiku-4-5-20251001" });
		expect(provider.name).toBe("opencode:anthropic/claude-haiku-4-5-20251001");
	});

	it("uses the default model when none is supplied", () => {
		const provider = createOpenCodeProvider();
		expect(provider.name).toContain("opencode:");
		expect(provider.name).toContain("anthropic/");
	});

	it("generate() extracts text from parts array", async () => {
		let callCount = 0;
		mockFetch(async (url) => {
			callCount++;
			if (url.includes("/session") && !url.includes("/message")) {
				// Session creation
				return Response.json({
					id: "ses_test",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			// Message
			return Response.json(openCodeResponse("  extracted fact  "));
		});

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.generate("test prompt");
		expect(result).toBe("extracted fact");
		expect(callCount).toBe(2); // session create + message
	});

	it("generate() reuses session on subsequent calls", async () => {
		let sessionCreations = 0;
		mockFetch(async (url) => {
			if (url.includes("/session") && !url.includes("/message")) {
				sessionCreations++;
				return Response.json({
					id: "ses_reuse",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			return Response.json(openCodeResponse("ok"));
		});

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		await provider.generate("prompt 1");
		await provider.generate("prompt 2");
		expect(sessionCreations).toBe(1);
	});

	it("generate() retries on 404 (expired session)", async () => {
		let messageAttempts = 0;
		let sessionCreations = 0;
		mockFetch(async (url) => {
			if (url.includes("/session") && !url.includes("/message")) {
				sessionCreations++;
				return Response.json({
					id: `ses_${sessionCreations}`,
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			messageAttempts++;
			if (messageAttempts === 1) {
				return new Response("session not found", { status: 404 });
			}
			return Response.json(openCodeResponse("recovered"));
		});

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.generate("test");
		expect(result).toBe("recovered");
		expect(sessionCreations).toBe(2); // original + retry
	});

	it("generateWithUsage() maps tokens and cost from response", async () => {
		mockFetch(async (url) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: "ses_usage",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			return Response.json(openCodeResponse("result", { input: 100, output: 25 }, 0.0042));
		});

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.generateWithUsage!("test");
		expect(result.text).toBe("result");
		expect(result.usage).not.toBeNull();
		expect(result.usage!.inputTokens).toBe(100);
		expect(result.usage!.outputTokens).toBe(25);
		expect(result.usage!.totalCost).toBe(0.0042);
	});

	it("generate() throws on non-200 non-retryable status", async () => {
		mockFetch(async (url) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: "ses_err",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			return new Response("internal server error", { status: 500 });
		});

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		await expect(provider.generate("test")).rejects.toThrow(/OpenCode HTTP 500/);
	});

	it("generate() throws a timeout error on slow responses", async () => {
		mockFetch(async (url, init) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: "ses_slow",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			return new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (signal) {
					signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				}
			});
		});

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			defaultTimeoutMs: 50,
		});
		await expect(provider.generate("test", { timeoutMs: 50 })).rejects.toThrow(/timeout/i);
	});

	it("available() returns true when /global/health responds 200", async () => {
		mockFetch(() => Response.json({ healthy: true, version: "1.2.15" }));

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.available();
		expect(result).toBe(true);
	});

	it("available() returns false when server is unreachable", async () => {
		mockFetch(() => {
			throw new Error("connection refused");
		});

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.available();
		expect(result).toBe(false);
	});

	it("generate() sends correct request body with parts format", async () => {
		let capturedBody: Record<string, unknown> = {};
		mockFetch(async (url, init) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: "ses_body",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			capturedBody = JSON.parse(init?.body as string);
			return Response.json(openCodeResponse("ok"));
		});

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			model: "google/gemini-2.5-flash",
		});
		await provider.generate("my prompt");

		expect(capturedBody.parts).toEqual([{ type: "text", text: "my prompt" }]);
		expect(capturedBody.model).toEqual({ providerID: "google", modelID: "gemini-2.5-flash" });
	});

	it("generate() joins multiple text parts", async () => {
		mockFetch(async (url) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: "ses_multi",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			return Response.json({
				info: { role: "assistant", id: "msg_test", sessionID: "ses_multi", cost: 0, tokens: { input: 0, output: 0 } },
				parts: [
					{ type: "text", text: "first part", id: "p1", sessionID: "ses_multi", messageID: "msg_test" },
					{ type: "tool", id: "p2", sessionID: "ses_multi", messageID: "msg_test" },
					{ type: "text", text: "second part", id: "p3", sessionID: "ses_multi", messageID: "msg_test" },
				],
			});
		});

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.generate("test");
		expect(result).toBe("first part\nsecond part");
	});

	it("generate() polls session messages when post response is empty", async () => {
		let postCalls = 0;
		let getCalls = 0;
		mockFetch(async (url, init) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: "ses_poll",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			if (init?.method === "POST") {
				postCalls++;
				return new Response("", {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			getCalls++;
			if (getCalls === 1) {
				return Response.json([
					{
						info: { role: "user" },
						parts: [{ type: "text", text: "pending" }],
					},
				]);
			}
			return Response.json([
				{
					info: { role: "assistant", tokens: { input: 1, output: 1 } },
					parts: [{ type: "text", text: "recovered" }],
				},
			]);
		});

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.generate("test");
		expect(result).toBe("recovered");
		expect(postCalls).toBe(1);
		expect(getCalls).toBe(2);
	});

	it("generate() returns fallback JSON when no assistant text appears", async () => {
		let getCalls = 0;
		mockFetch(async (url, init) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: "ses_bad",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			if (init?.method === "POST") {
				return new Response("", {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			getCalls++;
			return Response.json([
				{
					info: { role: "user" },
					parts: [{ type: "text", text: "still pending" }],
				},
			]);
		});

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.generate("test", { timeoutMs: 200 });
		expect(result).toBe('{"facts":[],"entities":[]}');
		expect(getCalls).toBeGreaterThan(0);
	});

	it("uses configured ollama fallback base URL for OpenCode fallback", async () => {
		const seenUrls: string[] = [];
		let fallbackBody: Record<string, unknown> | null = null;
		mockFetch(async (url, init) => {
			seenUrls.push(url);
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: "ses_fallback",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			if (url.includes("/session/ses_fallback/message")) {
				if (init?.method === "POST") {
					return new Response("", {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return Response.json([
					{
						info: { role: "user" },
						parts: [{ type: "text", text: "still pending" }],
					},
				]);
			}
			if (url === "http://172.17.0.1:11434/api/tags") {
				return Response.json({ models: [] });
			}
			if (url === "http://172.17.0.1:11434/api/generate") {
				fallbackBody = parseJsonObjectBody(init?.body);
				return Response.json({ response: '{"facts":[],"entities":[]}' });
			}
			return new Response("unexpected url", { status: 500 });
		});

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			enableOllamaFallback: true,
			ollamaFallbackBaseUrl: "http://172.17.0.1:11434",
			ollamaFallbackMaxContextTokens: 2048,
		});
		const result = await provider.generate("test", { timeoutMs: 250 });
		expect(result).toBe('{"facts":[],"entities":[]}');
		expect(seenUrls).toContain("http://172.17.0.1:11434/api/tags");
		expect(seenUrls).toContain("http://172.17.0.1:11434/api/generate");
		const fallbackOptions = fallbackBody ? getObjectField(fallbackBody, "options") : undefined;
		expect(fallbackOptions ? getNumberField(fallbackOptions, "num_ctx") : undefined).toBe(2048);
	});
});

describe("createOpenRouterProvider", () => {
	afterEach(() => restoreFetch());

	it("returns provider name with configured model", () => {
		const provider = createOpenRouterProvider({
			model: "google/gemini-2.5-flash",
			apiKey: "sk-or-test",
		});
		expect(provider.name).toBe("openrouter:google/gemini-2.5-flash");
	});

	it("generate() returns message text on success", async () => {
		mockFetch(async (_url, init) => {
			const body = parseJsonObjectBody(init?.body);
			expect(body.model).toBe("anthropic/claude-3.5-haiku");
			return Response.json({
				choices: [
					{
						message: {
							content: "hello from openrouter",
						},
					},
				],
				usage: {
					prompt_tokens: 12,
					completion_tokens: 7,
				},
			});
		});

		const provider = createOpenRouterProvider({
			model: "anthropic/claude-3.5-haiku",
			apiKey: "sk-or-test",
		});
		const result = await provider.generate("test");
		expect(result).toBe("hello from openrouter");
	});

	it("generateWithUsage() maps usage fields", async () => {
		mockFetch(async () =>
			Response.json({
				choices: [{ message: { content: "ok" } }],
				usage: {
					prompt_tokens: 120,
					completion_tokens: 45,
					cost: 0.00123,
					prompt_tokens_details: { cached_tokens: 30 },
				},
			}),
		);

		const provider = createOpenRouterProvider({
			model: "openai/gpt-4o-mini",
			apiKey: "sk-or-test",
		});
		const result = await provider.generateWithUsage?.("test");
		expect(result?.usage?.inputTokens).toBe(120);
		expect(result?.usage?.outputTokens).toBe(45);
		expect(result?.usage?.cacheReadTokens).toBe(30);
		expect(result?.usage?.totalCost).toBe(0.00123);
	});

	it("sends optional attribution headers", async () => {
		let headers: HeadersInit | undefined;
		mockFetch(async (_url, init) => {
			headers = init?.headers;
			return Response.json({
				choices: [{ message: { content: "ok" } }],
			});
		});

		const provider = createOpenRouterProvider({
			model: "openai/gpt-4o-mini",
			apiKey: "sk-or-test",
			referer: "https://example.com",
			title: "Signet",
		});
		await provider.generate("test");

		const h = new Headers(headers);
		expect(h.get("HTTP-Referer")).toBe("https://example.com");
		expect(h.get("X-OpenRouter-Title")).toBe("Signet");
		expect(h.get("X-Title")).toBe("Signet");
	});

	it("generate() throws timeout on slow responses", async () => {
		mockFetch((_url, init) => {
			return new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (signal) {
					signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				}
			});
		});

		const provider = createOpenRouterProvider({
			model: "openai/gpt-4o-mini",
			apiKey: "sk-or-test",
			defaultTimeoutMs: 50,
			maxRetries: 0,
		});
		await expect(provider.generate("test")).rejects.toThrow(/timeout/i);
	});

	it("available() returns true when /models responds 200", async () => {
		mockFetch(async () => Response.json({ data: [] }));
		const provider = createOpenRouterProvider({
			model: "openai/gpt-4o-mini",
			apiKey: "sk-or-test",
		});
		const ok = await provider.available();
		expect(ok).toBe(true);
	});

	it("throws when apiKey is missing", () => {
		expect(() =>
			createOpenRouterProvider({
				model: "openai/gpt-4o-mini",
				apiKey: "",
			}),
		).toThrow(/requires an API key/);
	});
});
