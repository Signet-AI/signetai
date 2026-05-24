import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateInferenceRouter, resetInferenceRouterForTests } from "./inference-router";

const originalFetch = globalThis.fetch;
const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalOpenRouterApiKey === undefined) {
		process.env.OPENROUTER_API_KEY = undefined;
	} else {
		process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
	}
	if (originalOpenAiApiKey === undefined) {
		process.env.OPENAI_API_KEY = undefined;
	} else {
		process.env.OPENAI_API_KEY = originalOpenAiApiKey;
	}
	resetInferenceRouterForTests();
});

describe("InferenceRouter legacy API credentials", () => {
	it("uses OPENROUTER_API_KEY for legacy pipeline OpenRouter synthesis targets", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-router-openrouter-"));
		try {
			mkdirSync(join(dir, "memory"), { recursive: true });
			writeFileSync(
				join(dir, "agent.yaml"),
				`memory:
  pipelineV2:
    extraction:
      provider: none
    synthesis:
      enabled: true
      provider: openrouter
      model: openai/gpt-4o-mini
      endpoint: https://openrouter.ai/api/v1
`,
			);

			process.env.OPENROUTER_API_KEY = "test-openrouter-key";
			const seen: Array<{ readonly url: string; readonly authorization: string | null }> = [];
			globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const headers = new Headers(init?.headers);
				seen.push({ url, authorization: headers.get("authorization") });
				if (url.endsWith("/models")) {
					return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
				}
				return Promise.resolve(
					new Response(
						JSON.stringify({
							choices: [{ message: { content: "aggregate recall answer" } }],
							usage: { prompt_tokens: 3, completion_tokens: 4 },
						}),
						{ status: 200 },
					),
				);
			}) as unknown as typeof fetch;

			const router = getOrCreateInferenceRouter(dir);
			const result = await router.execute(
				{
					operation: "tool_planning",
					promptPreview: "aggregate recall",
					expectedOutputTokens: 64,
				},
				"Summarize evidence",
				{ maxTokens: 64, timeoutMs: 1000 },
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.text).toBe("aggregate recall answer");
			expect(result.value.decision.targetRef).toBe("legacy-synthesis/default");
			expect(seen.every((entry) => entry.authorization === "Bearer test-openrouter-key")).toBe(true);
			expect(seen.map((entry) => entry.url)).toContain("https://openrouter.ai/api/v1/models");
			expect(seen.map((entry) => entry.url)).toContain("https://openrouter.ai/api/v1/chat/completions");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("uses OPENAI_API_KEY for legacy pipeline OpenAI-compatible targets", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-router-openai-compatible-"));
		try {
			mkdirSync(join(dir, "memory"), { recursive: true });
			writeFileSync(
				join(dir, "agent.yaml"),
				`memory:
  pipelineV2:
    extraction:
      provider: openai-compatible
      model: gpt-4o-mini
      endpoint: https://gateway.example.test/v1
    synthesis:
      enabled: false
`,
			);

			process.env.OPENAI_API_KEY = "test-openai-compatible-key";
			const seen: Array<{ readonly url: string; readonly authorization: string | null }> = [];
			globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const headers = new Headers(init?.headers);
				seen.push({ url, authorization: headers.get("authorization") });
				if (url.endsWith("/models")) {
					return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
				}
				return Promise.resolve(
					new Response(
						JSON.stringify({
							choices: [{ message: { content: "compatible gateway answer" } }],
							usage: { prompt_tokens: 5, completion_tokens: 6 },
						}),
						{ status: 200 },
					),
				);
			}) as unknown as typeof fetch;

			const router = getOrCreateInferenceRouter(dir);
			const result = await router.execute(
				{
					operation: "tool_planning",
					promptPreview: "aggregate recall",
					expectedOutputTokens: 64,
				},
				"Summarize evidence",
				{ maxTokens: 64, timeoutMs: 1000 },
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.text).toBe("compatible gateway answer");
			expect(result.value.decision.targetRef).toBe("legacy-extraction/default");
			expect(
				seen
					.filter((entry) => entry.url.startsWith("https://gateway.example.test/v1"))
					.every((entry) => entry.authorization === "Bearer test-openai-compatible-key"),
			).toBe(true);
			expect(seen.map((entry) => entry.url)).toContain("https://gateway.example.test/v1/models");
			expect(seen.map((entry) => entry.url)).toContain("https://gateway.example.test/v1/chat/completions");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not require OPENAI_API_KEY for local legacy OpenAI-compatible targets", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-router-local-openai-compatible-"));
		try {
			mkdirSync(join(dir, "memory"), { recursive: true });
			writeFileSync(
				join(dir, "agent.yaml"),
				`memory:
  pipelineV2:
    extraction:
      provider: openai-compatible
      model: openai/gpt-oss-20b
      endpoint: http://127.0.0.1:1234/v1
    synthesis:
      enabled: false
`,
			);

			Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
			const seen: Array<{ readonly url: string; readonly authorization: string | null }> = [];
			globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const headers = new Headers(init?.headers);
				seen.push({ url, authorization: headers.get("authorization") });
				if (url.endsWith("/models")) {
					return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
				}
				return Promise.resolve(
					new Response(
						JSON.stringify({
							choices: [{ message: { content: "local compatible answer" } }],
							usage: { prompt_tokens: 7, completion_tokens: 8 },
						}),
						{ status: 200 },
					),
				);
			}) as unknown as typeof fetch;

			const router = getOrCreateInferenceRouter(dir);
			const result = await router.execute(
				{
					operation: "tool_planning",
					promptPreview: "aggregate recall",
					expectedOutputTokens: 64,
				},
				"Summarize evidence",
				{ maxTokens: 64, timeoutMs: 1000 },
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.text).toBe("local compatible answer");
			expect(result.value.decision.targetRef).toBe("legacy-extraction/default");
			expect(seen.every((entry) => entry.authorization === null)).toBe(true);
			expect(seen.map((entry) => entry.url)).toContain("http://127.0.0.1:1234/v1/models");
			expect(seen.map((entry) => entry.url)).toContain("http://127.0.0.1:1234/v1/chat/completions");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("executes a legacy extraction fallback target when the configured provider is blocked", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-router-legacy-fallback-"));
		try {
			mkdirSync(join(dir, "memory"), { recursive: true });
			writeFileSync(
				join(dir, "agent.yaml"),
				`memory:
  pipelineV2:
    extraction:
      provider: openai-compatible
      model: gpt-4o-mini
      endpoint: https://gateway.example.test/v1
      fallbackProvider: llama-cpp
    synthesis:
      enabled: false
`,
			);

			process.env.OPENAI_API_KEY = undefined;
			globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url === "http://127.0.0.1:8080/v1/models") {
					return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
				}
				if (url === "http://127.0.0.1:8080/v1/chat/completions" && typeof init?.body === "string") {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								choices: [{ message: { content: "local fallback answer" } }],
								usage: { prompt_tokens: 9, completion_tokens: 10 },
							}),
							{ status: 200 },
						),
					);
				}
				return Promise.resolve(new Response("unexpected fetch", { status: 500 }));
			}) as unknown as typeof fetch;

			const router = getOrCreateInferenceRouter(dir);
			const result = await router.execute(
				{
					operation: "memory_extraction",
					promptPreview: "extract",
					expectedOutputTokens: 64,
				},
				"Extract durable facts",
				{ maxTokens: 64, timeoutMs: 1000 },
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.text).toBe("local fallback answer");
			expect(result.value.decision.targetRef).toBe("legacy-extraction-fallback/default");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("passes explicit OpenRouter reasoning controls through routed targets", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-router-openrouter-reasoning-"));
		try {
			mkdirSync(join(dir, "memory"), { recursive: true });
			writeFileSync(
				join(dir, "agent.yaml"),
				`inference:
  defaultPolicy: mercury
  accounts:
    openrouter-api:
      kind: api
      providerFamily: openrouter
      credentialRef: OPENROUTER_API_KEY
  targets:
    mercury:
      executor: openrouter
      account: openrouter-api
      openrouter:
        reasoning:
          enabled: false
          max_tokens: 0
      models:
        default:
          model: inception/mercury-2
          reasoning: medium
  policies:
    mercury:
      mode: automatic
      allow:
        - mercury/default
      defaultTargets:
        - mercury/default
  workloads:
    sessionSynthesis:
      target: mercury/default
      taskClass: session_synthesis
`,
			);

			process.env.OPENROUTER_API_KEY = "test-openrouter-key";
			let requestBody: Record<string, unknown> | null = null;
			globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/chat/completions") && typeof init?.body === "string") {
					const parsed: unknown = JSON.parse(init.body);
					if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
						requestBody = parsed as Record<string, unknown>;
					}
				}
				if (url.endsWith("/models")) {
					return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
				}
				return Promise.resolve(
					new Response(JSON.stringify({ choices: [{ message: { content: "mercury answer" } }] }), {
						status: 200,
					}),
				);
			}) as unknown as typeof fetch;

			const router = getOrCreateInferenceRouter(dir);
			const result = await router.execute(
				{
					operation: "session_synthesis",
					promptPreview: "aggregate recall",
					expectedOutputTokens: 64,
				},
				"Summarize evidence",
				{ maxTokens: 64, timeoutMs: 1000 },
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.text).toBe("mercury answer");
			expect(result.value.decision.targetRef).toBe("mercury/default");
			expect(requestBody?.reasoning).toEqual({ enabled: false, max_tokens: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
