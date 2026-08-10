import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmProvider } from "@signet/core";
import { Hono } from "hono";
import { getOrCreateInferenceRouter, resetInferenceRouterForTests } from "../inference-router";
import { closeInferenceProviderResolver, initInferenceProviderResolver } from "../llm";
import { mountOsChatRoutes } from "./os-chat";

const originalFetch = globalThis.fetch;
const originalSignetPath = process.env.SIGNET_PATH;
const TEST_TIMEOUT_MS = 250;
const TOOLS = [
	{
		serverId: "test-server",
		serverName: "Test server",
		toolName: "fetch_test_data",
		description: "Fetch test data",
	},
] as const;

let tempDir: string | undefined;

function app(timeoutMs: number): Hono {
	const next = new Hono();
	mountOsChatRoutes(next, { timeoutMs, tools: TOOLS });
	return next;
}

function hangingProvider(
	onAbort: () => void,
	onOptions: (options: Parameters<LlmProvider["generate"]>[1]) => void,
): LlmProvider {
	return {
		name: "test-interactive",
		async available(): Promise<boolean> {
			return true;
		},
		async generate(_prompt, options): Promise<string> {
			onOptions(options);
			const signal = options?.signal;
			return new Promise<string>(() => {
				if (signal?.aborted) {
					onAbort();
					return;
				}
				signal?.addEventListener(
					"abort",
					() => {
						onAbort();
					},
					{ once: true },
				);
			});
		},
	};
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	closeInferenceProviderResolver();
	resetInferenceRouterForTests();
	if (originalSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = originalSignetPath;
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

beforeEach(() => {
	closeInferenceProviderResolver();
	resetInferenceRouterForTests();
});

describe("OS Chat request deadlines", () => {
	it("#1347 passes a bounded timeout and abort signal through the legacy provider fallback", async () => {
		let aborted = false;
		let seenTimeout: number | undefined;
		let seenSignal: AbortSignal | undefined;
		initInferenceProviderResolver(() =>
			hangingProvider(
				() => {
					aborted = true;
				},
				(options) => {
					seenTimeout = options?.timeoutMs;
					seenSignal = options?.signal;
				},
			),
		);

		const response = await app(TEST_TIMEOUT_MS).request("/api/os/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "wait for the provider" }),
		});
		const body = (await response.json()) as { error?: string; code?: string; timeoutMs?: number };

		expect(response.status).toBe(504);
		expect(body).toMatchObject({ code: "TIMEOUT", timeoutMs: TEST_TIMEOUT_MS });
		expect(body.error).toContain(`${TEST_TIMEOUT_MS}ms`);
		expect(seenTimeout).toBe(TEST_TIMEOUT_MS);
		expect(seenSignal).toBeDefined();
		expect(aborted).toBe(true);
		expect(seenSignal?.aborted).toBe(true);
	});

	it("#1347 aborts routed inference and returns a terminal error", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "signet-os-chat-deadline-"));
		mkdirSync(join(tempDir, "memory"), { recursive: true });
		writeFileSync(
			join(tempDir, "agent.yaml"),
			`inference:
  defaultPolicy: interactive
  targets:
    local:
      executor: openai-compatible
      endpoint: http://127.0.0.1:9999/v1
      models:
        default:
          model: test-model
          toolUse: true
  policies:
    interactive:
      mode: strict
      defaultTargets:
        - local/default
  workloads:
    interactive:
      policy: interactive
`,
		);
		process.env.SIGNET_PATH = tempDir;

		let sawChatRequest = false;
		let sawAbort = false;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			if (String(input).endsWith("/models")) return Response.json({ data: [] });
			sawChatRequest = true;
			return new Promise<Response>(() => {
				const signal = init?.signal;
				const abort = (): void => {
					sawAbort = true;
				};
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			});
		}) as typeof fetch;

		getOrCreateInferenceRouter(tempDir);
		const response = await app(TEST_TIMEOUT_MS).request("/api/os/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "wait for the routed provider" }),
		});
		const body = (await response.json()) as { error?: string; code?: string; timeoutMs?: number };

		expect(response.status).toBe(504);
		expect(body).toMatchObject({ code: "TIMEOUT", timeoutMs: TEST_TIMEOUT_MS });
		expect(sawChatRequest).toBe(true);
		expect(sawAbort).toBe(true);
	});
});
