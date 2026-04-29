/**
 * Tests for the LlmProvider interface and OllamaProvider implementation.
 *
 * OllamaProvider uses the Ollama HTTP API, so we mock global fetch.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBypassedSessionKeys, resetSessions } from "../session-tracker";
import {
	DEFAULT_OLLAMA_FALLBACK_MAX_CONTEXT_TOKENS,
	LlmConcurrencySemaphore,
	SemaphoreTimeoutError,
	awaitSubprocessWithDeadline,
	createClaudeCodeProvider,
	createCodexProvider,
	createLlamaCppProvider,
	createOllamaProvider,
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
	globalThis.fetch = mock(handler) as unknown as typeof fetch;
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

/**
 * Wraps a fetch mock to silently handle parent session creation and
 * fire-and-forget DELETE cleanup added by the extraction notification
 * suppression feature.  Existing mock logic runs unchanged for child
 * session creation, messages, and all other requests.
 */
function withParentSession(
	handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): (url: string, init?: RequestInit) => Response | Promise<Response> {
	return async (url: string, init?: RequestInit) => {
		// Route cleanup DELETEs to a silent 200
		if (init?.method === "DELETE" && url.includes("/session/")) {
			return new Response(null, { status: 200 });
		}
		// Route parent session creation to a fixed response
		if (
			init?.method === "POST" &&
			url.includes("/session") &&
			!url.includes("/message")
		) {
			const body =
				typeof init.body === "string"
					? (JSON.parse(init.body) as Record<string, unknown>)
					: {};
			if (body.title === "signet-system") {
				return Response.json({
					id: "ses_parent",
					slug: "parent",
					projectID: "p",
					directory: "/tmp",
					title: "signet-system",
					version: "1",
				});
			}
		}
		return handler(url, init);
	};
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
		let capturedEnv: Record<string, string | undefined> | undefined;
		Bun.spawn = mock((args: string[], opts?: { env?: Record<string, string | undefined> }) => {
			capturedArgs = args;
			capturedEnv = opts?.env;
			return {
				stdout: streamFromString(
					'{"type":"thread.started","thread_id":"abc"}\n{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":5,"output_tokens":7}}\n',
				),
				stderr: streamFromString(""),
				exited: Promise.resolve(0),
				kill() {},
			};
		}) as unknown as typeof Bun.spawn;

		const provider = createCodexProvider({ model: "gpt-5.3-codex" });
		if (!provider.generateWithUsage) {
			throw new Error("expected generateWithUsage on Codex provider");
		}
		const result = await provider.generateWithUsage("test");
		expect(result.text).toBe("done");
		expect(result.usage?.inputTokens).toBe(12);
		expect(result.usage?.cacheReadTokens).toBe(5);
		expect(result.usage?.outputTokens).toBe(7);
		expect(capturedArgs).not.toContain("-a");
		expect(capturedArgs).toContain("--ephemeral");
		expect(capturedArgs).not.toContain("mcp_servers.signet.enabled=false");
		expect(typeof capturedEnv?.HOME).toBe("string");
		expect(capturedEnv?.HOME).not.toBe(process.env.HOME);
		expect(typeof capturedEnv?.CODEX_HOME).toBe("string");
	});

	it("does not disable Signet MCP through an incomplete Codex config override", async () => {
		let capturedArgs: string[] = [];
		Bun.spawn = mock((args: string[]) => {
			capturedArgs = args;
			return {
				stdout: streamFromString(
					'{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n',
				),
				stderr: streamFromString(""),
				exited: Promise.resolve(0),
				kill() {},
			};
		}) as unknown as typeof Bun.spawn;

		const provider = createCodexProvider({ model: "gpt-5.3-codex" });
		if (!provider.generateWithUsage) {
			throw new Error("expected generateWithUsage on Codex provider");
		}
		await provider.generateWithUsage("test");

		expect(capturedArgs).not.toContain("mcp_servers.signet.enabled=false");
	});

	it("spawns Codex with a sterile temp home and readonly copied auth", async () => {
		const root = join(tmpdir(), `signet-codex-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const home = join(root, "home");
		const liveCodex = join(root, "live-codex");
		mkdirSync(liveCodex, { recursive: true });
		writeFileSync(join(liveCodex, "auth.json"), '{"provider":"test"}');
		writeFileSync(join(liveCodex, "version.json"), '{"version":"1"}');

		const prevHome = process.env.HOME;
		const prevCodexHome = process.env.CODEX_HOME;
		process.env.HOME = home;
		process.env.CODEX_HOME = liveCodex;

		let capturedEnv: Record<string, string | undefined> | undefined;
		Bun.spawn = mock((args: string[], opts?: { env?: Record<string, string | undefined> }) => {
			capturedEnv = opts?.env;
			const srcAuth = join(liveCodex, "auth.json");
			const srcVersion = join(liveCodex, "version.json");
			const dstAuth = join(capturedEnv?.CODEX_HOME ?? "", "auth.json");
			expect(capturedEnv?.CODEX_HOME).toBe(join(capturedEnv?.HOME ?? "", ".codex"));
			expect(capturedEnv?.HOME?.startsWith(tmpdir())).toBe(true);
			expect(existsSync(dstAuth)).toBe(existsSync(srcAuth));
			if (existsSync(srcAuth)) {
				expect(lstatSync(dstAuth).isSymbolicLink()).toBe(false);
				expect(readFileSync(dstAuth, "utf8")).toBe(readFileSync(srcAuth, "utf8"));
				expect(lstatSync(dstAuth).mode & 0o200).toBe(0);
			}
			expect(existsSync(join(capturedEnv?.CODEX_HOME ?? "", "version.json"))).toBe(existsSync(srcVersion));
			return {
				stdout: streamFromString(
					'{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n',
				),
				stderr: streamFromString(""),
				exited: Promise.resolve(0),
				kill() {},
			};
		}) as unknown as typeof Bun.spawn;

		try {
			const provider = createCodexProvider({ model: "gpt-5.3-codex" });
			if (!provider.generateWithUsage) {
				throw new Error("expected generateWithUsage on Codex provider");
			}

			await provider.generateWithUsage("test");

			expect(capturedEnv?.HOME).toBeDefined();
			expect(capturedEnv?.HOME).not.toBe(home);
			expect(capturedEnv?.CODEX_HOME).toBe(join(capturedEnv?.HOME ?? "", ".codex"));
			expect(capturedEnv?.XDG_CONFIG_HOME).toBe(join(capturedEnv?.HOME ?? "", ".config"));
		} finally {
			if (prevHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = prevHome;
			}
			if (prevCodexHome === undefined) {
				delete process.env.CODEX_HOME;
			} else {
				process.env.CODEX_HOME = prevCodexHome;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not delete sibling sterile homes while Codex is running", async () => {
		const root = join(tmpdir(), "signet-codex-home");
		mkdirSync(root, { recursive: true });
		const sibling = join(root, `home-sibling-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const marker = join(sibling, "marker.txt");
		mkdirSync(sibling, { recursive: true });
		writeFileSync(marker, "keep");

		let capturedEnv: Record<string, string | undefined> | undefined;
		Bun.spawn = mock((args: string[], opts?: { env?: Record<string, string | undefined> }) => {
			capturedEnv = opts?.env;
			expect(existsSync(marker)).toBe(true);
			expect(capturedEnv?.HOME).not.toBe(sibling);
			return {
				stdout: streamFromString(
					'{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n',
				),
				stderr: streamFromString(""),
				exited: Promise.resolve(0),
				kill() {},
			};
		}) as unknown as typeof Bun.spawn;

		try {
			const provider = createCodexProvider({ model: "gpt-5.3-codex" });
			if (!provider.generateWithUsage) {
				throw new Error("expected generateWithUsage on Codex provider");
			}

			await provider.generateWithUsage("test");

			expect(existsSync(marker)).toBe(true);
		} finally {
			rmSync(sibling, { recursive: true, force: true });
		}
	});

	it("generate() throws on non-zero exit", async () => {
		Bun.spawn = mock((_args: string[]) => ({
			stdout: streamFromString(""),
			stderr: streamFromString("boom"),
			exited: Promise.resolve(1),
			kill() {},
		})) as unknown as typeof Bun.spawn;

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
		}) as unknown as typeof Bun.spawn;

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
		mockFetch(withParentSession(async (url) => {
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
		}));

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.generate("test prompt");
		expect(result).toBe("extracted fact");
		expect(callCount).toBe(2); // session create + message
	});

	it("generate() creates a new child session per call after cleanup", async () => {
		let sessionCreations = 0;
		mockFetch(withParentSession(async (url) => {
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
		}));

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		await provider.generate("prompt 1");
		await provider.generate("prompt 2");
		expect(sessionCreations).toBe(2);
	});

	it("generate() passes parentID to child sessions and cleans up via DELETE", async () => {
		const sessionBodies: Record<string, unknown>[] = [];
		const deletedIds: string[] = [];
		let childCount = 0;

		mockFetch(async (url, init) => {
			if (init?.method === "DELETE") {
				const match = url.match(/\/session\/([^/]+)$/);
				if (match) deletedIds.push(match[1]);
				return new Response(null, { status: 200 });
			}
			if (url.includes("/session") && !url.includes("/message")) {
				const body = parseJsonObjectBody(init?.body);
				sessionBodies.push(body);
				if (body.title === "signet-system") {
					return Response.json({
						id: "ses_parent_qa",
						slug: "parent",
						projectID: "p",
						directory: "/tmp",
						title: "signet-system",
						version: "1",
					});
				}
				childCount++;
				return Response.json({
					id: `ses_child_${childCount}`,
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "signet-extraction",
					version: "1",
				});
			}
			return Response.json(openCodeResponse("ok"));
		});

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		await provider.generate("first");
		// Allow fire-and-forget DELETE to settle
		await new Promise((r) => setTimeout(r, 100));

		await provider.generate("second");
		await new Promise((r) => setTimeout(r, 100));

		// Parent session created once, without parentID
		const parentBody = sessionBodies.find(
			(b) => b.title === "signet-system",
		);
		expect(parentBody).toBeDefined();
		expect(parentBody?.parentID).toBeUndefined();

		// Child sessions include parentID pointing to parent
		const childBodies = sessionBodies.filter(
			(b) => b.title === "signet-extraction",
		);
		expect(childBodies).toHaveLength(2);
		for (const b of childBodies) {
			expect(b.parentID).toBe("ses_parent_qa");
		}

		// Both child sessions cleaned up
		expect(deletedIds).toContain("ses_child_1");
		expect(deletedIds).toContain("ses_child_2");
		// Parent session NOT deleted
		expect(deletedIds).not.toContain("ses_parent_qa");
	});

	it("generate() retries without parentID when stale parent causes child creation failure", async () => {
		const sessionBodies: Record<string, unknown>[] = [];
		let parentCreations = 0;
		let childAttempts = 0;

		mockFetch(async (url, init) => {
			if (init?.method === "DELETE" && url.includes("/session/")) {
				return new Response(null, { status: 200 });
			}
			if (
				init?.method === "POST" &&
				url.includes("/session") &&
				!url.includes("/message")
			) {
				const body = parseJsonObjectBody(init?.body);
				sessionBodies.push(body);

				if (body.title === "signet-system") {
					parentCreations++;
					return Response.json({
						id: `ses_parent_${parentCreations}`,
						slug: "parent",
						projectID: "p",
						directory: "/tmp",
						title: "signet-system",
						version: "1",
					});
				}

				// Child session creation
				childAttempts++;
				if (body.parentID && childAttempts === 1) {
					// First child attempt with stale parentID → 400
					return new Response("Bad Request: unknown parent session", {
						status: 400,
					});
				}
				// Retry without parentID (or subsequent calls) → succeed
				return Response.json({
					id: `ses_child_${childAttempts}`,
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "signet-extraction",
					version: "1",
				});
			}
			return Response.json(openCodeResponse("ok"));
		});

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });

		// First call: parent is created and cached, child uses parentID.
		// The mock fails the first child POST (stale parent), so
		// createSession should clear the cache and retry without parentID.
		const result = await provider.generate("hello");
		expect(result).toBe("ok");

		// The retry attempt must NOT carry parentID
		const childBodies = sessionBodies.filter(
			(b) => b.title === "signet-extraction",
		);
		expect(childBodies.length).toBeGreaterThanOrEqual(2);
		// First attempt had parentID
		expect(childBodies[0].parentID).toBeDefined();
		// Retry had no parentID (graceful degradation)
		expect(childBodies[1].parentID).toBeUndefined();
	});

	it("stale-parent retry keeps child session creation within the caller deadline", async () => {
		let childAttempts = 0;

		mockFetch(async (url, init) => {
			if (init?.method === "DELETE" && url.includes("/session/")) {
				return new Response(null, { status: 200 });
			}
			if (
				init?.method === "POST" &&
				url.includes("/session") &&
				!url.includes("/message")
			) {
				const body = parseJsonObjectBody(init?.body);
				if (body.title === "signet-system") {
					return Response.json({
						id: "ses_parent_stale_budget",
						slug: "parent",
						projectID: "p",
						directory: "/tmp",
						title: "signet-system",
						version: "1",
					});
				}

				childAttempts++;
				if (body.parentID) {
					await new Promise((resolve) => setTimeout(resolve, 250));
					return new Response("Bad Request: unknown parent session", {
						status: 400,
					});
				}

				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, 300);
					init?.signal?.addEventListener("abort", () => {
						clearTimeout(timer);
						reject(new DOMException("aborted", "AbortError"));
					});
				});
				return Response.json({
					id: "ses_child_unparented",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "signet-extraction",
					version: "1",
				});
			}
			return Response.json(openCodeResponse("ok"));
		});

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });

		const start = performance.now();
		await expect(provider.generate("hello", { timeoutMs: 400 })).rejects.toThrow(/aborted|timeout/i);
		const elapsed = performance.now() - start;

		expect(elapsed).toBeLessThan(650);
		expect(childAttempts).toBe(2);
	});

	it("generate() retries on 404 (expired session)", async () => {
		let messageAttempts = 0;
		let sessionCreations = 0;
		mockFetch(withParentSession(async (url) => {
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
		}));

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.generate("test");
		expect(result).toBe("recovered");
		expect(sessionCreations).toBe(2); // original + retry
	});

	it("generateWithUsage() maps tokens and cost from response", async () => {
		mockFetch(withParentSession(async (url) => {
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
		}));

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.generateWithUsage!("test");
		expect(result.text).toBe("result");
		expect(result.usage).not.toBeNull();
		expect(result.usage!.inputTokens).toBe(100);
		expect(result.usage!.outputTokens).toBe(25);
		expect(result.usage!.totalCost).toBe(0.0042);
	});

	it("generate() throws on non-200 non-retryable status", async () => {
		mockFetch(withParentSession(async (url) => {
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
		}));

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		await expect(provider.generate("test")).rejects.toThrow(/OpenCode HTTP 500/);
	});

	it("generate() throws a timeout error on slow responses", async () => {
		mockFetch(withParentSession(async (url, init) => {
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
		}));

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			defaultTimeoutMs: 50,
		});
		await expect(provider.generate("test", { timeoutMs: 50 })).rejects.toThrow(/timeout/i);
	});

	it("available() returns true when /global/health responds 200", async () => {
		mockFetch(withParentSession(() => Response.json({ healthy: true, version: "1.2.15" })));

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.available();
		expect(result).toBe(true);
	});

	it("available() returns false when server is unreachable", async () => {
		mockFetch(withParentSession(() => {
			throw new Error("connection refused");
		}));

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.available();
		expect(result).toBe(false);
	});

	it("generate() sends correct request body with parts format", async () => {
		let capturedBody: Record<string, unknown> = {};
		mockFetch(withParentSession(async (url, init) => {
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
		}));

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			model: "google/gemini-2.5-flash",
		});
		await provider.generate("my prompt");

		expect(capturedBody.parts).toEqual([{ type: "text", text: "my prompt" }]);
		expect(capturedBody.model).toEqual({ providerID: "google", modelID: "gemini-2.5-flash" });
		// Structured output fields are included by default
		expect(capturedBody.format).toEqual({
			type: "json_schema",
			schema: { type: "object", additionalProperties: true },
			retryCount: 1,
		});
		expect(typeof capturedBody.system).toBe("string");
	});

	it("generate() sends signet-pipeline agent in request body", async () => {
		let capturedBody: Record<string, unknown> = {};
		mockFetch(withParentSession(async (url, init) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: "ses_agent",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			capturedBody = JSON.parse(init?.body as string);
			return Response.json(openCodeResponse("ok"));
		}));

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			model: "google/gemini-2.5-flash",
		});
		await provider.generate("extract this");

		expect(capturedBody.agent).toBe("signet-pipeline");
	});

	it("generate() omits agent when config.agent is empty", async () => {
		let capturedBody: Record<string, unknown> = {};
		mockFetch(withParentSession(async (url, init) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: "ses_no_agent",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			capturedBody = JSON.parse(init?.body as string);
			return Response.json(openCodeResponse("ok"));
		}));

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			model: "google/gemini-2.5-flash",
			agent: "",
		});
		await provider.generate("extract this");

		expect(capturedBody.agent).toBeUndefined();
	});

	it("generate() retries without agent on agent-not-found 4xx and stays disabled", async () => {
		let sessionCount = 0;
		let lastBody: Record<string, unknown> = {};
		mockFetch(withParentSession(async (url, init) => {
			if (url.includes("/session") && !url.includes("/message")) {
				sessionCount++;
				return Response.json({
					id: `ses_agent_fallback_${sessionCount}`,
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			const parsed = JSON.parse(init?.body as string);
			if (parsed.agent) {
				return new Response(`unknown agent "signet-pipeline"`, { status: 400 });
			}
			lastBody = parsed;
			return Response.json(openCodeResponse("recovered"));
		}));

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			model: "google/gemini-2.5-flash",
		});
		const first = await provider.generate("extract this");
		expect(first).toBe("recovered");
		expect(lastBody.agent).toBeUndefined();

		const second = await provider.generate("extract that");
		expect(second).toBe("recovered");
		expect(lastBody.agent).toBeUndefined();
	});

	it("generate() falls back when agent-rejection 400 arrives after agent already disabled", async () => {
		let sessionCount = 0;
		let agentSeen = false;
		mockFetch(withParentSession(async (url, init) => {
			if (url.includes("/session") && !url.includes("/message")) {
				sessionCount++;
				return Response.json({
					id: `ses_concurrent_${sessionCount}`,
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			const parsed = JSON.parse(init?.body as string);
			if (parsed.agent) {
				agentSeen = true;
				return new Response(`unknown agent "signet-pipeline"`, { status: 400 });
			}
			if (!agentSeen) {
				return new Response(`unknown agent "signet-pipeline"`, { status: 400 });
			}
			return Response.json(openCodeResponse("ok"));
		}));

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			model: "google/gemini-2.5-flash",
		});
		const first = await provider.generate("extract first");
		expect(first).toBe("ok");

		// Agent is now disabled.  Mock returns 400 with agent-rejection
		// text for every message request.  The !agentSupported branch
		// must catch this and fall back instead of throwing.
		sessionCount = 0;
		agentSeen = false;
		let threw = false;
		mockFetch(withParentSession(async (url) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: "ses_sibling",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			return new Response(`unknown agent "signet-pipeline"`, { status: 400 });
		}));
		try {
			await provider.generate("extract sibling");
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
	});

	it("generate() omits format field when enableStructuredOutput is false", async () => {
		let capturedBody: Record<string, unknown> = {};
		mockFetch(withParentSession(async (url, init) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: "ses_no_so",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			capturedBody = JSON.parse(init?.body as string);
			return Response.json(openCodeResponse("ok"));
		}));

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			enableStructuredOutput: false,
		});
		await provider.generate("my prompt");

		expect(capturedBody.parts).toEqual([{ type: "text", text: "my prompt" }]);
		expect(capturedBody.format).toBeUndefined();
		expect(capturedBody.system).toBeUndefined();
	});

	it("generate() joins multiple text parts", async () => {
		mockFetch(withParentSession(async (url) => {
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
		}));

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.generate("test");
		expect(result).toBe("first part\nsecond part");
	});

	it("generate() polls session messages when post response is empty", async () => {
		let postCalls = 0;
		let getCalls = 0;
		mockFetch(withParentSession(async (url, init) => {
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
		}));

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.generate("test");
		expect(result).toBe("recovered");
		expect(postCalls).toBe(1);
		expect(getCalls).toBe(2);
	});

	it("generate() returns fallback JSON when no assistant text appears", async () => {
		let getCalls = 0;
		mockFetch(withParentSession(async (url, init) => {
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
		}));

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.generate("test", { timeoutMs: 200 });
		expect(result).toBe('{"facts":[],"entities":[]}');
		expect(getCalls).toBeGreaterThan(0);
	});

	it("uses configured ollama fallback base URL for OpenCode fallback", async () => {
		const seenUrls: string[] = [];
		let fallbackBody: Record<string, unknown> | null = null;
		let postCount = 0;
		mockFetch(withParentSession(async (url, init) => {
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
					postCount++;
					// First POST returns 404 (session gone) to take the short
					// retry path (line 2370-2385) that reaches tryOllamaFallback
					// after only one poll cycle instead of three.
					if (postCount === 1) {
						return new Response("Not Found", { status: 404 });
					}
					// Retry POST returns empty 200 (malformed) so
					// parsePostResponse → pollForAssistantMessage → null,
					// which triggers the Ollama fallback.
					return new Response("", {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return Response.json([]);
			}
			if (url === "http://172.17.0.1:11434/api/tags") {
				return Response.json({ models: [] });
			}
			if (url === "http://172.17.0.1:11434/api/generate") {
				fallbackBody = parseJsonObjectBody(init?.body);
				return Response.json({ response: '{"facts":[],"entities":[]}' });
			}
			return new Response("unexpected url", { status: 500 });
		}));

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			enableOllamaFallback: true,
			ollamaFallbackBaseUrl: "http://172.17.0.1:11434",
			ollamaFallbackMaxContextTokens: 2048,
		});
		// Poll cycles cap at 20s each. The 404→retry path has one poll
		// cycle, so budget must exceed 20s + some margin for fallback.
		const result = await provider.generate("test", { timeoutMs: 25000 });
		expect(result).toBe('{"facts":[],"entities":[]}');
		expect(seenUrls).toContain("http://172.17.0.1:11434/api/tags");
		expect(seenUrls).toContain("http://172.17.0.1:11434/api/generate");
		const fallbackOptions = fallbackBody ? getObjectField(fallbackBody, "options") : undefined;
		expect(fallbackOptions ? getNumberField(fallbackOptions, "num_ctx") : undefined).toBe(2048);
	}, 35000);

	it("generate() does NOT attempt Ollama fallback when enableOllamaFallback is omitted (safe default)", async () => {
		const seenUrls: string[] = [];
		let postCount = 0;
		mockFetch(withParentSession(async (url, init) => {
			seenUrls.push(url);
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: "ses_no_fallback",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			if (url.includes("/session/ses_no_fallback/message")) {
				if (init?.method === "POST") {
					postCount++;
					if (postCount === 1) {
						return new Response("Not Found", { status: 404 });
					}
					return new Response("", {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return Response.json([]);
			}
			if (url.includes("11434")) {
				return Response.json({ models: [] });
			}
			return new Response("unexpected url", { status: 500 });
		}));

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			ollamaFallbackBaseUrl: "http://127.0.0.1:11434",
		});
		try {
			await provider.generate("test", { timeoutMs: 25000 });
		} catch {
			/* expected */
		}
		expect(seenUrls.some((u) => u.includes("11434"))).toBe(false);
	}, 35000);

	it("generate() prefers info.structured over text parts", async () => {
		mockFetch(withParentSession(async (url) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: "ses_structured",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			return Response.json({
				info: {
					role: "assistant",
					id: "msg_s",
					sessionID: "ses_structured",
					cost: 0,
					tokens: { input: 10, output: 5 },
					structured: { facts: [{ content: "from structured", type: "fact", confidence: 0.9 }], entities: [] },
				},
				parts: [{ type: "text", text: "ignore this text", id: "p1", sessionID: "ses_structured", messageID: "msg_s" }],
			});
		}));

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.generate("test");
		const parsed = JSON.parse(result);
		expect(parsed.facts[0].content).toBe("from structured");
	});

	it("generate() returns info.structured as string when it is a string", async () => {
		mockFetch(withParentSession(async (url) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: "ses_str",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			return Response.json({
				info: {
					role: "assistant",
					id: "msg_str",
					sessionID: "ses_str",
					cost: 0,
					tokens: { input: 0, output: 0 },
					structured: '{"description":"test skill","triggers":["run tests"],"tags":["testing"]}',
				},
				parts: [],
			});
		}));

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const result = await provider.generate("test");
		expect(JSON.parse(result).description).toBe("test skill");
	});

	it("generate() disables structured output on 422 and retries without format", async () => {
		let attempts = 0;
		const bodies: Record<string, unknown>[] = [];
		mockFetch(withParentSession(async (url, init) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: `ses_compat_${attempts}`,
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			attempts++;
			bodies.push(JSON.parse(init?.body as string));
			if (attempts === 1) {
				// 422 with "format" JSON key — signals structured output unsupported
				return new Response('{"issues":[{"path":["format"],"message":"Unrecognized key"}]}', { status: 422 });
			}
			return Response.json(openCodeResponse("fallback works"));
		}));

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		const first = await provider.generate("test");
		expect(first).toBe("fallback works");
		// The retry within the same call should omit format
		expect(bodies[1]?.format).toBeUndefined();

		// A subsequent call should also omit format (structured output stays disabled)
		await provider.generate("second call");
		expect(bodies[2]?.format).toBeUndefined();
	});

	it("generate() disables structured output after consecutive malformed 200 responses", async () => {
		let postCount = 0;
		const postBodies: Record<string, unknown>[] = [];
		mockFetch(withParentSession(async (url, init) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: `ses_200err_${postCount}`,
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			if (init?.method === "POST") {
				postCount++;
				postBodies.push(JSON.parse(init?.body as string));
				if (postCount <= 2) {
					// First two POSTs: 200 with empty body (GitHub Copilot schema rejection pattern)
					return new Response("", {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				// Third POST (after structured output disabled): succeed
				return Response.json(openCodeResponse("recovered without format"));
			}
			// GET polls: return empty array so poll times out quickly
			return Response.json([]);
		}));

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			enableOllamaFallback: false,
			defaultTimeoutMs: 500,
		});
		const result = await provider.generate("test");
		expect(result).toBe("recovered without format");

		// The third POST body should NOT have the format field
		expect(postBodies.length).toBeGreaterThanOrEqual(3);
		expect(postBodies[0]?.format).toBeDefined(); // first: had format
		expect(postBodies[1]?.format).toBeDefined(); // second (retry): still had format
		expect(postBodies[2]?.format).toBeUndefined(); // third: format disabled
	}, 15000);

	it("generate() does not disable structured output on an unrelated 400", async () => {
		let attempts = 0;
		mockFetch(withParentSession(async (url, init) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: `ses_unrelated_${attempts}`,
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			attempts++;
			if (attempts === 1) {
				// 400 with "format" word but not a structured-output rejection
				return new Response('{"error":"Invalid request format: parts array is missing"}', { status: 400 });
			}
			return Response.json(openCodeResponse("ok"));
		}));

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		// Should throw, not silently disable structured output and retry
		await expect(provider.generate("test")).rejects.toThrow(/OpenCode HTTP 400/);
		expect(attempts).toBe(1);
	});

	it("generate() preserves error body on non-format 400", async () => {
		mockFetch(withParentSession(async (url) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: "ses_400",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			return new Response("bad request: missing required field", { status: 400 });
		}));

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		await expect(provider.generate("test")).rejects.toThrow(/bad request: missing required field/);
	});

	it("generate() parses github-copilot provider/model format", () => {
		const provider = createOpenCodeProvider({ model: "github-copilot/gpt-4o" });
		expect(provider.name).toBe("opencode:github-copilot/gpt-4o");
	});
	it("generate() refreshes bypass TTL on reused session", async () => {
		mockFetch(withParentSession(async (url) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: "ses_bypass_refresh",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			return Response.json(openCodeResponse("ok"));
		}));

		const provider = createOpenCodeProvider({ baseUrl: "http://localhost:9999" });
		await provider.generate("prompt 1");

		const expiryAfterFirst = getBypassedSessionKeys().get("ses_bypass_refresh");
		expect(expiryAfterFirst).toBeDefined();
		if (expiryAfterFirst === undefined) return;

		Bun.sleepSync(10);
		await provider.generate("prompt 2");

		const expiryAfterSecond = getBypassedSessionKeys().get("ses_bypass_refresh");
		expect(expiryAfterSecond).toBeDefined();
		if (expiryAfterSecond === undefined) return;
		expect(expiryAfterSecond).toBeGreaterThan(expiryAfterFirst);

		resetSessions();
	});

	it("generate() limits concurrent in-flight requests via LLM semaphore", async () => {
		let peak = 0;
		let inflight = 0;

		mockFetch(withParentSession(async (url) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: `ses_conc_${Date.now()}`,
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			inflight++;
			if (inflight > peak) peak = inflight;
			// Brief delay to allow other semaphore-gated requests to overlap
			await new Promise((resolve) => setTimeout(resolve, 50));
			inflight--;
			return Response.json(openCodeResponse("ok"));
		}));

		const N = 8;
		const providers = Array.from({ length: N }, (_, i) =>
			createOpenCodeProvider({ baseUrl: "http://localhost:9999", model: `m${i}` }),
		);
		const results = await Promise.all(providers.map((p) => p.generate("test")));

		expect(results).toHaveLength(N);
		for (const r of results) expect(r).toBe("ok");
		expect(peak).toBeLessThanOrEqual(4);
		expect(peak).toBeGreaterThan(0);
	});

	it("generate() throws deadline error when semaphore wait exceeds timeout", async () => {
		const blockers: Array<() => void> = [];

		mockFetch(withParentSession(async (url) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: `ses_deadline_${Date.now()}`,
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			await new Promise<void>((resolve) => blockers.push(resolve));
			return Response.json(openCodeResponse("ok"));
		}));

		// Fill all 4 semaphore slots with blocked requests
		const fillers = Array.from({ length: 4 }, (_, i) =>
			createOpenCodeProvider({ baseUrl: "http://localhost:9999", model: `filler${i}` }),
		);
		const fillerPromises = fillers.map((p) => p.generate("block"));
		await new Promise((r) => setTimeout(r, 200));

		// 5th call queues on the semaphore; its deadline expires before a slot opens
		const victim = createOpenCodeProvider({ baseUrl: "http://localhost:9999", model: "victim" });
		const start = Date.now();
		const victimPromise = victim.generate("test", { timeoutMs: 300 });

		await expect(victimPromise).rejects.toThrow(/semaphore acquisition/);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(2000);

		for (const release of blockers) release();
		await Promise.allSettled(fillerPromises);
	});

	it("concurrent generate() calls on the same provider get distinct sessions", async () => {
		const sessionIds: string[] = [];
		let sessionCounter = 0;

		mockFetch(withParentSession(async (url, init) => {
			if (
				init?.method === "POST" &&
				url.includes("/session") &&
				!url.includes("/message")
			) {
				const id = `ses_race_${++sessionCounter}`;
				return Response.json({
					id,
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			const match = url.match(/\/session\/([^/]+)\/message/);
			if (match) sessionIds.push(match[1]);
			await new Promise((resolve) => setTimeout(resolve, 50));
			return Response.json(openCodeResponse("ok"));
		}));

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			model: "race-test",
		});

		const callA = provider.generate("prompt-a");
		const callBC = new Promise<void>((resolve) =>
			setTimeout(resolve, 10),
		).then(() =>
			Promise.all([
				provider.generate("prompt-b"),
				provider.generate("prompt-c"),
			]),
		);

		const [resultA, resultsBC] = await Promise.all([callA, callBC]);

		expect(resultA).toBe("ok");
		expect(resultsBC).toHaveLength(2);
		for (const r of resultsBC) expect(r).toBe("ok");

		expect(sessionIds).toHaveLength(3);
		const unique = new Set(sessionIds);
		expect(unique.size).toBe(3);
	});

	it("format-rejection retry polls the retry session, not the original", async () => {
		// F9 regression: after a 422 format rejection, parsePostResponse
		// was called with the original `sid` instead of the retry session.
		// If the retry POST returns an unparseable body, pollForAssistantMessage
		// would poll the wrong session and miss the assistant message.
		let sessionCounter = 0;
		const sessionIds: string[] = [];
		const pollTargets: string[] = [];

		mockFetch(withParentSession(async (url, init) => {
			// Child session creation — track IDs
			if (
				init?.method === "POST" &&
				url.includes("/session") &&
				!url.includes("/message")
			) {
				const id = `ses_fmt_${++sessionCounter}`;
				sessionIds.push(id);
				return Response.json({
					id,
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}

			// POST message
			if (init?.method === "POST" && url.includes("/message")) {
				const match = url.match(/\/session\/([^/]+)\/message/);
				const sid = match?.[1] ?? "";
				if (sid === "ses_fmt_1") {
					// First session → 422 format rejection
					return new Response(
						'{"issues":[{"path":["format"],"message":"Unrecognized key"}]}',
						{ status: 422 },
					);
				}
				// Retry session → empty body (forces poll fallback)
				return new Response("", {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			// GET poll — record which session is being polled
			if (init?.method === "GET" || (!init?.method && url.includes("/message"))) {
				const match = url.match(/\/session\/([^/]+)\/message/);
				if (match) pollTargets.push(match[1]);

				// Only the retry session has the assistant message
				if (match?.[1] === "ses_fmt_2") {
					return Response.json([openCodeResponse("polled-from-retry")]);
				}
				// Original session returns empty — no message here
				return Response.json([]);
			}

			return new Response(null, { status: 404 });
		}));

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			model: "f9-test",
			enableOllamaFallback: false,
			defaultTimeoutMs: 5000,
		});

		const result = await provider.generate("test prompt");

		// The poll MUST target the retry session (ses_fmt_2), not the original (ses_fmt_1)
		expect(pollTargets.length).toBeGreaterThan(0);
		expect(pollTargets.every((t) => t === "ses_fmt_2")).toBe(true);
		expect(result).toBe("polled-from-retry");
	});

	it("all intermediate retry sessions are deleted in finally", async () => {
		// F8 regression: when sendMessage creates multiple sessions through
		// retries, only sid and activeSid were deleted.  Intermediate
		// sessions (e.g. from retryWithNewSession superseded by fallbackSid)
		// were leaked.
		let sessionCounter = 0;
		let postCount = 0;
		const deletedSessions: string[] = [];

		mockFetch(async (url, init) => {
			// Parent session
			if (
				init?.method === "POST" &&
				url.includes("/session") &&
				!url.includes("/message")
			) {
				const body =
					typeof init.body === "string"
						? (JSON.parse(init.body) as Record<string, unknown>)
						: {};
				if (body.title === "signet-system") {
					return Response.json({
						id: "ses_parent",
						slug: "parent",
						projectID: "p",
						directory: "/tmp",
						title: "signet-system",
						version: "1",
					});
				}
				const id = `ses_leak_${++sessionCounter}`;
				return Response.json({
					id,
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}

			// Track DELETEs
			if (init?.method === "DELETE" && url.includes("/session/")) {
				const match = url.match(/\/session\/([^/]+)/);
				if (match) deletedSessions.push(match[1]);
				return new Response(null, { status: 200 });
			}

			// POST messages — trigger the malformed-200 double-retry path:
			// 1st POST (ses_leak_1): malformed 200 (empty body)
			// 2nd POST (ses_leak_2 via retryWithNewSession): also malformed
			// 3rd POST (ses_leak_3 via fallbackSid): success
			if (init?.method === "POST" && url.includes("/message")) {
				postCount++;
				if (postCount <= 2) {
					return new Response("", {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return Response.json(openCodeResponse("recovered"));
			}

			// GET polls — return empty to trigger retry path
			if (url.includes("/message") && (!init?.method || init.method === "GET")) {
				return Response.json([]);
			}

			return new Response(null, { status: 404 });
		});

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			model: "f8-test",
			enableOllamaFallback: false,
			defaultTimeoutMs: 500,
		});

		const result = await provider.generate("test prompt");
		expect(result).toBe("recovered");

		// Three child sessions were created: ses_leak_1, ses_leak_2, ses_leak_3
		expect(sessionCounter).toBe(3);

		// ALL three must be deleted — not just sid + activeSid
		const uniqueDeleted = new Set(deletedSessions);
		expect(uniqueDeleted).toContain("ses_leak_1");
		expect(uniqueDeleted).toContain("ses_leak_2");
		expect(uniqueDeleted).toContain("ses_leak_3");
	}, 15000);
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

// ---------------------------------------------------------------------------
// LlmConcurrencySemaphore unit tests
// ---------------------------------------------------------------------------

describe("LlmConcurrencySemaphore", () => {
	it("acquireWithTimeout rejects with SemaphoreTimeoutError", async () => {
		const sem = new LlmConcurrencySemaphore(1);
		await sem.acquire();

		try {
			await sem.acquireWithTimeout(50);
			throw new Error("should not reach");
		} catch (err) {
			expect(err).toBeInstanceOf(SemaphoreTimeoutError);
			expect((err as SemaphoreTimeoutError).message).toMatch(/timed out/);
		}

		sem.release();
	});

	it("acquireWithTimeout clears timer on successful acquisition", async () => {
		const sem = new LlmConcurrencySemaphore(1);
		await sem.acquire();

		setTimeout(() => sem.release(), 20);

		const before = Bun.nanoseconds();
		await sem.acquireWithTimeout(200);
		const elapsed = (Bun.nanoseconds() - before) / 1e6;

		expect(elapsed).toBeLessThan(100);
		expect(sem.activeTimers).toBe(0);

		sem.release();
	});

	it("acquireWithTimeout throws on ms <= 0", () => {
		const sem = new LlmConcurrencySemaphore(1);
		expect(sem.acquireWithTimeout(0)).rejects.toThrow(/positive/);
		expect(sem.acquireWithTimeout(-1)).rejects.toThrow(/positive/);
	});

	it("release() throws when active count is already 0", () => {
		const sem = new LlmConcurrencySemaphore(1);
		expect(() => sem.release()).toThrow(/no active/i);
	});

	it("release() does not go negative after guard", () => {
		const sem = new LlmConcurrencySemaphore(2);
		expect(() => sem.release()).toThrow();
		expect(sem.running).toBe(0);
	});

	it("timeout removes queued entry so it does not fire later", async () => {
		const sem = new LlmConcurrencySemaphore(1);
		await sem.acquire();

		await expect(sem.acquireWithTimeout(30)).rejects.toBeInstanceOf(SemaphoreTimeoutError);

		expect(sem.pending).toBe(0);

		sem.release();
		expect(sem.running).toBe(0);
	});

	it("mixed acquire() and acquireWithTimeout() preserve FIFO order", async () => {
		const sem = new LlmConcurrencySemaphore(1);
		await sem.acquire();

		const order: number[] = [];

		const p1 = sem.acquire().then(() => order.push(1));
		const p2 = sem.acquireWithTimeout(5000).then(() => order.push(2));

		sem.release();
		await p1;
		sem.release();
		await p2;

		expect(order).toEqual([1, 2]);

		sem.release();
	});

	it("activeTimers returns 0 after timeout rejection", async () => {
		const sem = new LlmConcurrencySemaphore(1);
		await sem.acquire();

		await expect(sem.acquireWithTimeout(30)).rejects.toBeInstanceOf(SemaphoreTimeoutError);
		expect(sem.activeTimers).toBe(0);

		sem.release();
	});

	it("global cap: concurrent calls beyond max queue and resolve in order", async () => {
		const sem = new LlmConcurrencySemaphore(2);

		await sem.acquire();
		await sem.acquire();
		expect(sem.running).toBe(2);
		expect(sem.pending).toBe(0);

		const order: number[] = [];
		const p1 = sem.acquire().then(() => order.push(1));
		const p2 = sem.acquire().then(() => order.push(2));
		expect(sem.pending).toBe(2);

		sem.release();
		await p1;
		sem.release();
		await p2;

		expect(order).toEqual([1, 2]);
		expect(sem.running).toBe(2);

		sem.release();
		sem.release();
		expect(sem.running).toBe(0);
	});

	it("rejects fractional SIGNET_MAX_LLM_CONCURRENCY", () => {
		const parsed = Number("1.5");
		expect(Number.isSafeInteger(parsed)).toBe(false);
	});
});

describe("awaitSubprocessWithDeadline — success-after-timeout race", () => {
	it("reports timeout even when resultFn resolves successfully after deadline fires", async () => {
		// Race: deadline timer fires (timedOut=true, SIGTERM sent) but resultFn
		// resolves successfully because output was already buffered. Must throw
		// SemaphoreTimeoutError instead of returning the stale result.
		let killed = false;
		const exitPromise = new Promise<number>((resolve) => {
			setTimeout(() => resolve(0), 200);
		});

		const fakeProc = {
			stdout: streamFromString(""),
			stderr: streamFromString(""),
			exited: exitPromise,
			kill() {
				killed = true;
			},
		};

		// resultFn resolves after 80ms — but deadline is 30ms, so timedOut
		// will be true when resultFn settles.
		const resultFn = async () => {
			await new Promise((r) => setTimeout(r, 80));
			return "success-value";
		};

		await expect(
			awaitSubprocessWithDeadline(fakeProc, 30, "test", 30, resultFn),
		).rejects.toBeInstanceOf(SemaphoreTimeoutError);

		expect(killed).toBe(true);
	});
});

describe("createOpenCodeProvider — session creation vs semaphore ordering", () => {
	afterEach(() => restoreFetch());

	it("slow session creation causes timeout when total time exceeds budget", async () => {
		// Session creation takes 300ms, timeout is 400ms. Only 100ms remains
		// for the actual LLM call. If the LLM call takes 200ms, the overall
		// request must abort because session time counts toward the deadline.
		const sessionDelayMs = 300;
		const messageDelayMs = 200;

		mockFetch(withParentSession(async (url, init) => {
			if (url.includes("/session") && !url.includes("/message")) {
				await new Promise((r) => setTimeout(r, sessionDelayMs));
				return Response.json({
					id: "ses_deadline_test",
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			// LLM call takes 200ms — should hit AbortError if only 100ms remains
			return new Promise((_resolve, reject) => {
				const signal = init?.signal;
				const timer = setTimeout(
					() => _resolve(Response.json(openCodeResponse("ok"))),
					messageDelayMs,
				);
				if (signal) {
					signal.addEventListener("abort", () => {
						clearTimeout(timer);
						reject(new DOMException("aborted", "AbortError"));
					});
				}
			});
		}));

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			defaultTimeoutMs: 400,
		});

		const start = performance.now();
		await expect(provider.generate("test", { timeoutMs: 400 })).rejects.toThrow(/timeout/i);
		const elapsed = performance.now() - start;

		// Session (300ms) + partial LLM call aborted at ~100ms remaining = ~400ms total.
		// Must not exceed the 400ms budget by more than scheduling jitter.
		expect(elapsed).toBeLessThan(500);
	});
});

describe("createOpenCodeProvider — retry session creation respects deadline", () => {
	afterEach(() => restoreFetch());

	it("format-rejection retry aborts session creation when deadline is nearly exhausted", async () => {
		// First call: fast session + 422 format rejection.
		// Second call: slow session creation (500ms) should abort because
		// only ~200ms of the 600ms budget remains after the first round-trip.
		let sessionCount = 0;

		mockFetch(withParentSession(async (url, init) => {
			if (url.includes("/session") && !url.includes("/message")) {
				sessionCount++;
				if (sessionCount > 1) {
					// Second session creation is slow
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(() => resolve(), 500);
						const signal = init?.signal;
						if (signal) {
							signal.addEventListener("abort", () => {
								clearTimeout(timer);
								reject(new DOMException("aborted", "AbortError"));
							});
						}
					});
				}
				return Response.json({
					id: `ses_retry_${sessionCount}`,
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			if (url.includes("/message")) {
				// First message: 422 with format rejection (takes ~300ms)
				await new Promise((r) => setTimeout(r, 300));
				return new Response(
					JSON.stringify({ issues: [{ path: ["format"], message: "unsupported" }] }),
					{ status: 422 },
				);
			}
			return new Response("not found", { status: 404 });
		}));

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			defaultTimeoutMs: 600,
		});

		const start = performance.now();
		await expect(provider.generate("test", { timeoutMs: 600 })).rejects.toThrow(/timeout/i);
		const elapsed = performance.now() - start;

		// Must abort within budget (600ms) + jitter, not 300 + 500 = 800ms.
		expect(elapsed).toBeLessThan(750);
		expect(sessionCount).toBe(2);
	});
});

describe("createOllamaProvider — concurrency semaphore enforcement", () => {
	afterEach(() => restoreFetch());

	it("Ollama generate() respects the global LLM concurrency cap", async () => {
		let peak = 0;
		let inflight = 0;

		mockFetch(async (url) => {
			if (url.includes("/api/tags")) {
				return Response.json({ models: [{ name: "test-model" }] });
			}
			inflight++;
			if (inflight > peak) peak = inflight;
			await new Promise((r) => setTimeout(r, 50));
			inflight--;
			return Response.json({
				response: "test result",
				prompt_eval_count: 10,
				eval_count: 5,
				total_duration: 1000000000,
			});
		});

		const N = 8;
		const providers = Array.from({ length: N }, () =>
			createOllamaProvider({ model: "test-model", baseUrl: "http://localhost:11434" }),
		);
		const results = await Promise.all(providers.map((p) => p.generate("test")));

		expect(results).toHaveLength(N);
		for (const r of results) expect(r).toBe("test result");
		expect(peak).toBeLessThanOrEqual(4);
		expect(peak).toBeGreaterThan(0);
	});
});

describe("httpProviderCall — backoff vs deadline", () => {
	afterEach(() => restoreFetch());

	it("retries fail fast when deadline is exhausted instead of sleeping full backoff", async () => {
		mockFetch(async () => {
			return new Response("server error", { status: 500 });
		});

		const provider = createOpenRouterProvider({
			model: "test/model",
			apiKey: "sk-test",
			defaultTimeoutMs: 200,
		});

		const start = performance.now();
		await expect(provider.generate("test", { timeoutMs: 200 })).rejects.toThrow();
		const elapsed = performance.now() - start;

		// First attempt fails with 500 → retry. Backoff = min(1000 * 2^0, 8000) = 1000ms.
		// Without clamping, the backoff sleep alone overshoots the 200ms deadline.
		// With clamping, sleep = min(1000, remaining) ≈ remaining, so total ≈ 200ms.
		// We allow generous margin (500ms) but the unclamped path would take 1000ms+.
		expect(elapsed).toBeLessThan(500);
	});
});

describe("createOpenCodeProvider — nested semaphore deadlock in fallback", () => {
	afterEach(() => restoreFetch());

	it("tryOllamaFallback does not deadlock when all semaphore slots are held by OpenCode callers", async () => {
		// Regression test for Oracle v4 CRITICAL #1:
		// sendMessage() holds a semaphore slot, then calls tryOllamaFallback()
		// which must NOT try to acquire another slot (nested acquire = deadlock
		// when all 4 slots are occupied).
		//
		// Strategy: launch 4 concurrent OpenCode requests that all get malformed
		// 200 responses → triggers tryOllamaFallback. If the inner acquire is
		// still present, the 4th worker (or earlier) will block waiting for a
		// slot that never frees → test times out = FAIL.
		const N = 4; // matches DEFAULT_MAX_LLM_CONCURRENCY
		let postCount = 0;

		mockFetch(withParentSession(async (url, init) => {
			// Session creation
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: `ses_deadlock_${postCount}`,
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			// Ollama availability check
			if (url.includes("/api/tags")) {
				return Response.json({ models: [{ name: "qwen3.5:4b" }] });
			}
			// Ollama fallback generate
			if (url.includes("/api/generate")) {
				await new Promise((r) => setTimeout(r, 20));
				return Response.json({
					response: JSON.stringify({ result: "fallback-ok" }),
					prompt_eval_count: 10,
					eval_count: 5,
				});
			}
			// OpenCode message POST — always return malformed (empty body)
			if (init?.method === "POST" && url.includes("/message")) {
				postCount++;
				return new Response("", {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			// GET polls — empty array to trigger malformed path
			return Response.json([]);
		}));

		const providers = Array.from({ length: N }, () =>
			createOpenCodeProvider({
				baseUrl: "http://localhost:9999",
				enableOllamaFallback: true,
				ollamaFallbackBaseUrl: "http://localhost:11434",
				ollamaFallbackModel: "qwen3.5:4b",
				defaultTimeoutMs: 3000,
			}),
		);

		// If nested acquire is present, this Promise.all will hang until
		// the 3s timeout fires for each worker → total >12s → test timeout.
		// With the fix (no inner acquire), all 4 complete promptly.
		const results = await Promise.all(providers.map((p) => p.generate("test")));
		expect(results).toHaveLength(N);
		// Each should get the fallback response (parsed JSON from Ollama)
		for (const r of results) {
			expect(typeof r).toBe("string");
			expect(r.length).toBeGreaterThan(0);
		}
	}, 8000); // 8s timeout — fails if deadlock causes 4×3s sequential waits
});

describe("createOpenCodeProvider — fallback respects remaining deadline", () => {
	afterEach(() => restoreFetch());

	it("tryOllamaFallback uses remaining time from outer deadline, not a fresh timeout", async () => {
		// Strategy: set 3s timeout, consume ~1.5s on OpenCode retries, then verify
		// the Ollama fallback fetch aborts within ~1.5s (remaining budget), not 5s
		// (which it would sleep if given a fresh 20s budget).
		let ollamaFetchStartedAt = 0;
		let ollamaFetchAbortedAt = 0;
		let postCount = 0;

		mockFetch(withParentSession(async (url, init) => {
			if (url.includes("/session") && !url.includes("/message")) {
				return Response.json({
					id: `ses_deadline_${postCount}`,
					slug: "test",
					projectID: "p",
					directory: "/tmp",
					title: "test",
					version: "1",
				});
			}
			if (url.includes("/api/tags")) {
				return Response.json({ models: [{ name: "qwen3.5:4b" }] });
			}
			if (url.includes("/api/generate")) {
				ollamaFetchStartedAt = performance.now();
				try {
					await new Promise((resolve, reject) => {
						const t = setTimeout(resolve, 10_000);
						if (init?.signal) {
							init.signal.addEventListener("abort", () => {
								clearTimeout(t);
								reject(new DOMException("Aborted", "AbortError"));
							});
						}
					});
				} catch {
					ollamaFetchAbortedAt = performance.now();
					throw new DOMException("Aborted", "AbortError");
				}
				return Response.json({
					response: "should not reach this",
					prompt_eval_count: 10,
					eval_count: 5,
				});
			}
			if (init?.method === "POST" && url.includes("/message")) {
				postCount++;
				await new Promise((r) => setTimeout(r, 300));
				return new Response("", {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return Response.json([]);
		}));

		const provider = createOpenCodeProvider({
			baseUrl: "http://localhost:9999",
			enableOllamaFallback: true,
			ollamaFallbackBaseUrl: "http://localhost:11434",
			ollamaFallbackModel: "qwen3.5:4b",
			defaultTimeoutMs: 3000,
		});

		const start = performance.now();
		try {
			await provider.generate("test");
		} catch {
			// timeout expected
		}
		const elapsed = performance.now() - start;

		// Total must complete near the 3s deadline, NOT 10s+ (fresh fallback budget)
		expect(elapsed).toBeLessThan(6000);

		if (ollamaFetchStartedAt > 0 && ollamaFetchAbortedAt > 0) {
			const ollamaWait = ollamaFetchAbortedAt - ollamaFetchStartedAt;
			// Remaining budget after retries is ~1-2s. Ollama fetch must abort
			// well before its 10s sleep — proving it got the clamped budget.
			expect(ollamaWait).toBeLessThan(4000);
		}
	}, 15000);
});

describe("createLlamaCppProvider — concurrency semaphore enforcement", () => {
	afterEach(() => restoreFetch());

	it("llama.cpp generate() respects the global LLM concurrency cap", async () => {
		let peak = 0;
		let inflight = 0;

		mockFetch(async (url) => {
			if (url.includes("/v1/models")) {
				return Response.json({ data: [{ id: "test-model" }] });
			}
			inflight++;
			if (inflight > peak) peak = inflight;
			await new Promise((r) => setTimeout(r, 50));
			inflight--;
			return Response.json({
				choices: [{ message: { content: "test result" } }],
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			});
		});

		const N = 8;
		const providers = Array.from({ length: N }, () =>
			createLlamaCppProvider({ model: "test-model", baseUrl: "http://localhost:8080" }),
		);
		const results = await Promise.all(providers.map((p) => p.generate("test")));

		expect(results).toHaveLength(N);
		for (const r of results) expect(r).toBe("test result");
		expect(peak).toBeLessThanOrEqual(4);
		expect(peak).toBeGreaterThan(0);
	});
});
