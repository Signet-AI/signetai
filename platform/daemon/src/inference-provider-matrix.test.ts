import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateInferenceRouter, resetInferenceRouterForTests } from "./inference-router";
import { stripFences, tryParseJson } from "./pipeline/extraction";

const originalFetch = globalThis.fetch;
const originalMatrixApiKey = process.env.SIGNET_MATRIX_API_KEY;
const STRUCTURED_MARKER = "signet-inference-matrix";

interface StructuredProbe {
	readonly matrix: string;
	readonly value: string;
}

function openAiSseResponse(content: string): Response {
	const chunks = [
		`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
		`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
		"data: [DONE]\n\n",
	];
	return new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStructured(raw: string): StructuredProbe | null {
	const parsed = tryParseJson(stripFences(raw));
	if (!isRecord(parsed) || parsed.matrix !== STRUCTURED_MARKER || typeof parsed.value !== "string") return null;
	if (Object.keys(parsed).length !== 2) return null;
	return { matrix: STRUCTURED_MARKER, value: parsed.value };
}

function requestModel(init: RequestInit | undefined): string {
	const parsed = requestBody(init);
	if (typeof parsed.model !== "string") throw new Error("matrix request did not include a model");
	return parsed.model;
}

function requestBody(init: RequestInit | undefined): Readonly<Record<string, unknown>> {
	const parsed: unknown = JSON.parse(String(init?.body));
	if (!isRecord(parsed)) throw new Error("matrix request body was not an object");
	return parsed;
}

function requestOutputTokenBound(init: RequestInit | undefined): unknown {
	const body = requestBody(init);
	return body.max_tokens ?? body.max_completion_tokens;
}

function writeMatrixConfig(dir: string): void {
	mkdirSync(join(dir, "memory"), { recursive: true });
	writeFileSync(
		join(dir, "agent.yaml"),
		`inference:
  defaultPolicy: matrix
  accounts:
    structured-account:
      kind: api
      providerFamily: openrouter
      credentialRef: SIGNET_MATRIX_API_KEY
    primary-account:
      kind: api
      providerFamily: openrouter
      credentialRef: SIGNET_MATRIX_API_KEY
    fallback-account:
      kind: api
      providerFamily: openrouter
      credentialRef: SIGNET_MATRIX_API_KEY
    abort-account:
      kind: api
      providerFamily: openrouter
      credentialRef: SIGNET_MATRIX_API_KEY
  targets:
    structured:
      executor: openrouter
      account: structured-account
      models:
        default:
          model: openai/gpt-4o-mini
    primary:
      executor: openrouter
      account: primary-account
      models:
        default:
          model: deepseek/deepseek-v4-flash
    fallback:
      executor: openrouter
      account: fallback-account
      models:
        default:
          model: inception/mercury-2
    abort:
      executor: openrouter
      account: abort-account
      models:
        default:
          model: openai/gpt-4o-mini
  policies:
    matrix:
      mode: strict
      allow:
        - structured/default
        - primary/default
        - fallback/default
        - abort/default
      defaultTargets:
        - primary/default
      fallbackTargets:
        - fallback/default
  workloads:
    interactive:
      target: abort/default
      taskClass: interactive
    memoryExtraction:
      target: primary/default
      taskClass: memory_extraction
    aggregateRecall:
      target: structured/default
      taskClass: session_synthesis
`,
	);
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalMatrixApiKey === undefined) Reflect.deleteProperty(process.env, "SIGNET_MATRIX_API_KEY");
	else process.env.SIGNET_MATRIX_API_KEY = originalMatrixApiKey;
	resetInferenceRouterForTests();
});

describe("InferenceRouter hermetic provider matrix (#1324)", () => {
	test("uses workload-selected targets, forwards output bounds, and parses structured output", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-provider-matrix-structured-"));
		try {
			writeMatrixConfig(dir);
			process.env.SIGNET_MATRIX_API_KEY = "test-matrix-key";
			const requestedModels: string[] = [];
			const requestedMaxTokens: unknown[] = [];
			globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
				const model = requestModel(init);
				requestedModels.push(model);
				requestedMaxTokens.push(requestOutputTokenBound(init));
				if (model === "openai/gpt-4o-mini" && String(init?.body).includes("MALFORMED")) {
					return Promise.resolve(openAiSseResponse("MALFORMED"));
				}
				return Promise.resolve(openAiSseResponse(`{"matrix":"${STRUCTURED_MARKER}","value":"ok"}`));
			}) as unknown as typeof fetch;

			const router = getOrCreateInferenceRouter(dir);
			const valid = await router.execute(
				{ operation: "aggregate_recall", promptPreview: "matrix structured response" },
				"Return the matrix response.",
				{ maxTokens: 32, timeoutMs: 1_000 },
			);
			expect(valid.ok).toBe(true);
			if (!valid.ok) return;
			expect(valid.value.decision.targetRef).toBe("structured/default");
			expect(valid.value.attempts).toEqual([expect.objectContaining({ targetRef: "structured/default", ok: true })]);
			expect(parseStructured(valid.value.text)).toEqual({ matrix: STRUCTURED_MARKER, value: "ok" });

			const malformed = await router.execute(
				{ operation: "aggregate_recall", promptPreview: "matrix malformed response" },
				"Return MALFORMED and nothing else.",
				{ maxTokens: 32, timeoutMs: 1_000 },
			);
			expect(malformed.ok).toBe(true);
			if (!malformed.ok) return;
			expect(malformed.value.decision.targetRef).toBe("structured/default");
			expect(parseStructured(malformed.value.text)).toBeNull();
			expect(requestedModels).toEqual(["openai/gpt-4o-mini", "openai/gpt-4o-mini"]);
			expect(requestedMaxTokens).toEqual([32, 32]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("classifies a rate-limited workload account without blocking another workload", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-provider-matrix-fallback-"));
		try {
			writeMatrixConfig(dir);
			process.env.SIGNET_MATRIX_API_KEY = "test-matrix-key";
			const requestedModels: string[] = [];
			globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
				const model = requestModel(init);
				requestedModels.push(model);
				if (model === "deepseek/deepseek-v4-flash") {
					return Promise.resolve(
						new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), { status: 429 }),
					);
				}
				if (model === "inception/mercury-2") return Promise.resolve(openAiSseResponse("fallback response"));
				return Promise.resolve(openAiSseResponse("structured response"));
			}) as unknown as typeof fetch;

			const router = getOrCreateInferenceRouter(dir);
			const retried = await router.execute(
				{ operation: "memory_extraction", promptPreview: "matrix fallback" },
				"Use the workload route.",
				{ maxTokens: 32, timeoutMs: 1_000 },
			);
			expect(retried.ok).toBe(true);
			if (!retried.ok) return;
			expect(retried.value.decision.targetRef).toBe("primary/default");
			expect(retried.value.attempts.map((attempt) => [attempt.targetRef, attempt.ok])).toEqual([
				["primary/default", false],
				["fallback/default", true],
			]);
			const failedAttempt = retried.value.attempts[0];
			expect(failedAttempt?.error).toContain("429");

			const observed = await router.status();
			expect(observed.ok).toBe(true);
			if (!observed.ok) return;
			expect(observed.value.runtimeSnapshot.targets["primary/default"]?.accountState).toBe("rate_limited");
			expect(observed.value.runtimeSnapshot.targets["fallback/default"]?.accountState).toBe("ready");
			expect(observed.value.runtimeSnapshot.targets["structured/default"]?.accountState).toBe("ready");

			const rerouted = await router.execute(
				{ operation: "memory_extraction", promptPreview: "matrix blocked primary" },
				"Use the available fallback route.",
				{ maxTokens: 32, timeoutMs: 1_000 },
			);
			expect(rerouted.ok).toBe(true);
			if (!rerouted.ok) return;
			expect(rerouted.value.decision.targetRef).toBe("fallback/default");
			expect(rerouted.value.attempts).toEqual([expect.objectContaining({ targetRef: "fallback/default", ok: true })]);

			const isolated = await router.execute(
				{ operation: "aggregate_recall", promptPreview: "matrix target isolation" },
				"Use the isolated workload route.",
				{ maxTokens: 32, timeoutMs: 1_000 },
			);
			expect(isolated.ok).toBe(true);
			if (!isolated.ok) return;
			expect(isolated.value.decision.targetRef).toBe("structured/default");
			expect(isolated.value.attempts).toEqual([expect.objectContaining({ targetRef: "structured/default", ok: true })]);
			expect(requestedModels).toEqual([
				"deepseek/deepseek-v4-flash",
				"inception/mercury-2",
				"inception/mercury-2",
				"openai/gpt-4o-mini",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("aborts an expired deadline and returns a normalized timeout without fallback", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-provider-matrix-deadline-"));
		try {
			writeMatrixConfig(dir);
			process.env.SIGNET_MATRIX_API_KEY = "test-matrix-key";
			let markStarted: (() => void) | undefined;
			const started = new Promise<void>((resolve) => {
				markStarted = resolve;
			});
			let deadlineAborted = false;
			const requestedModels: string[] = [];
			globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
				const model = requestModel(init);
				requestedModels.push(model);
				if (model !== "openai/gpt-4o-mini") return Promise.resolve(openAiSseResponse("unexpected fallback"));
				markStarted?.();
				return new Promise<Response>((_resolve, reject) => {
					if (init?.signal?.aborted) {
						deadlineAborted = true;
						reject(new DOMException("timeout", "AbortError"));
						return;
					}
					init?.signal?.addEventListener(
						"abort",
						() => {
							deadlineAborted = init.signal?.aborted === true;
							reject(new DOMException("timeout", "AbortError"));
						},
						{ once: true },
					);
				});
			}) as unknown as typeof fetch;

			const router = getOrCreateInferenceRouter(dir);
			const pending = router.execute(
				{ operation: "interactive", promptPreview: "matrix deadline" },
				"Wait for the request deadline.",
				{ maxTokens: 32, timeoutMs: 25 },
			);
			await started;
			const timedOut = await pending;
			expect(deadlineAborted).toBe(true);
			expect(timedOut.ok).toBe(false);
			if (timedOut.ok) return;
			const attempts = timedOut.error.details?.attempts;
			expect(attempts).toEqual([
				expect.objectContaining({ targetRef: "abort/default", ok: false, error: expect.stringMatching(/timed out/i) }),
			]);
			expect(requestedModels).toEqual(["openai/gpt-4o-mini"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
