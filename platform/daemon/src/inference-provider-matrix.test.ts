import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateInferenceRouter, resetInferenceRouterForTests } from "./inference-router";
import { stripFences, tryParseJson } from "./pipeline/extraction";

const originalFetch = globalThis.fetch;
const originalStructuredApiKey = process.env.SIGNET_MATRIX_STRUCTURED_API_KEY;
const originalPrimaryApiKey = process.env.SIGNET_MATRIX_PRIMARY_API_KEY;
const originalFallbackApiKey = process.env.SIGNET_MATRIX_FALLBACK_API_KEY;
const originalAbortApiKey = process.env.SIGNET_MATRIX_ABORT_API_KEY;
const STRUCTURED_MARKER = "signet-inference-matrix";

interface StructuredProbe {
	readonly matrix: string;
	readonly value: string;
}

interface CapturedTransportRequest {
	readonly url: string;
	readonly authorization: string | null;
	readonly model: string;
	readonly outputTokenBound: unknown;
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

function captureTransportRequest(input: string | URL | Request, init?: RequestInit): CapturedTransportRequest {
	return {
		url: String(input),
		authorization: new Headers(init?.headers).get("authorization"),
		model: requestModel(init),
		outputTokenBound: requestOutputTokenBound(init),
	};
}

function setMatrixCredentials(): void {
	process.env.SIGNET_MATRIX_STRUCTURED_API_KEY = "matrix-structured-key";
	process.env.SIGNET_MATRIX_PRIMARY_API_KEY = "matrix-primary-key";
	process.env.SIGNET_MATRIX_FALLBACK_API_KEY = "matrix-fallback-key";
	process.env.SIGNET_MATRIX_ABORT_API_KEY = "matrix-abort-key";
}

function restoreCredential(key: string, value: string | undefined): void {
	if (value === undefined) Reflect.deleteProperty(process.env, key);
	else process.env[key] = value;
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
      credentialRef: SIGNET_MATRIX_STRUCTURED_API_KEY
    primary-account:
      kind: api
      providerFamily: openrouter
      credentialRef: SIGNET_MATRIX_PRIMARY_API_KEY
    fallback-account:
      kind: api
      providerFamily: openrouter
      credentialRef: SIGNET_MATRIX_FALLBACK_API_KEY
    abort-account:
      kind: api
      providerFamily: openrouter
      credentialRef: SIGNET_MATRIX_ABORT_API_KEY
  targets:
    structured:
      executor: openrouter
      account: structured-account
      endpoint: https://structured.matrix.test/v1
      models:
        default:
          model: openai/gpt-4o-mini
    primary:
      executor: openrouter
      account: primary-account
      endpoint: https://primary.matrix.test/v1
      models:
        default:
          model: deepseek/deepseek-v4-flash
    fallback:
      executor: openrouter
      account: fallback-account
      endpoint: https://fallback.matrix.test/v1
      models:
        default:
          model: inception/mercury-2
    abort:
      executor: openrouter
      account: abort-account
      endpoint: https://abort.matrix.test/v1
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
	restoreCredential("SIGNET_MATRIX_STRUCTURED_API_KEY", originalStructuredApiKey);
	restoreCredential("SIGNET_MATRIX_PRIMARY_API_KEY", originalPrimaryApiKey);
	restoreCredential("SIGNET_MATRIX_FALLBACK_API_KEY", originalFallbackApiKey);
	restoreCredential("SIGNET_MATRIX_ABORT_API_KEY", originalAbortApiKey);
	resetInferenceRouterForTests();
});

describe("InferenceRouter hermetic provider matrix (#1324)", () => {
	test("uses workload-selected targets, forwards output bounds, and parses structured output", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-provider-matrix-structured-"));
		try {
			writeMatrixConfig(dir);
			setMatrixCredentials();
			const requests: CapturedTransportRequest[] = [];
			globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
				if (String(input).endsWith("/models"))
					return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
				const request = captureTransportRequest(input, init);
				requests.push(request);
				if (request.model === "openai/gpt-4o-mini" && String(init?.body).includes("MALFORMED")) {
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
			expect(requests).toEqual([
				{
					url: "https://structured.matrix.test/v1/chat/completions",
					authorization: "Bearer matrix-structured-key",
					model: "openai/gpt-4o-mini",
					outputTokenBound: 32,
				},
				{
					url: "https://structured.matrix.test/v1/chat/completions",
					authorization: "Bearer matrix-structured-key",
					model: "openai/gpt-4o-mini",
					outputTokenBound: 32,
				},
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reroutes an upstream HTTP 503 timeout without crossing provider accounts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-provider-matrix-fallback-"));
		try {
			writeMatrixConfig(dir);
			setMatrixCredentials();
			const requests: CapturedTransportRequest[] = [];
			globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
				if (String(input).endsWith("/models"))
					return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
				const request = captureTransportRequest(input, init);
				requests.push(request);
				if (request.model === "deepseek/deepseek-v4-flash") {
					return Promise.resolve(
						new Response(JSON.stringify({ error: { message: "upstream request timeout" } }), { status: 503 }),
					);
				}
				if (request.model === "inception/mercury-2") return Promise.resolve(openAiSseResponse("fallback response"));
				return Promise.resolve(openAiSseResponse("structured response"));
			}) as unknown as typeof fetch;

			const router = getOrCreateInferenceRouter(dir);
			const rerouted = await router.execute(
				{ operation: "memory_extraction", promptPreview: "matrix upstream timeout" },
				"Use the workload route.",
				{ maxTokens: 32, timeoutMs: 1_000 },
			);
			expect(rerouted.ok).toBe(true);
			if (!rerouted.ok) return;
			expect(rerouted.value.decision.targetRef).toBe("primary/default");
			expect(rerouted.value.attempts.map((attempt) => [attempt.targetRef, attempt.ok])).toEqual([
				["primary/default", false],
				["fallback/default", true],
			]);
			expect(rerouted.value.attempts[0]?.error).toContain("503");

			const isolated = await router.execute(
				{ operation: "aggregate_recall", promptPreview: "matrix target isolation" },
				"Use the isolated workload route.",
				{ maxTokens: 32, timeoutMs: 1_000 },
			);
			expect(isolated.ok).toBe(true);
			if (!isolated.ok) return;
			expect(isolated.value.decision.targetRef).toBe("structured/default");
			expect(isolated.value.attempts).toEqual([expect.objectContaining({ targetRef: "structured/default", ok: true })]);
			expect(requests).toEqual([
				{
					url: "https://primary.matrix.test/v1/chat/completions",
					authorization: "Bearer matrix-primary-key",
					model: "deepseek/deepseek-v4-flash",
					outputTokenBound: 32,
				},
				{
					url: "https://fallback.matrix.test/v1/chat/completions",
					authorization: "Bearer matrix-fallback-key",
					model: "inception/mercury-2",
					outputTokenBound: 32,
				},
				{
					url: "https://structured.matrix.test/v1/chat/completions",
					authorization: "Bearer matrix-structured-key",
					model: "openai/gpt-4o-mini",
					outputTokenBound: 32,
				},
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("aborts an expired deadline and returns a normalized timeout without fallback", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-provider-matrix-deadline-"));
		try {
			writeMatrixConfig(dir);
			setMatrixCredentials();
			let markStarted: (() => void) | undefined;
			const started = new Promise<void>((resolve) => {
				markStarted = resolve;
			});
			let deadlineAborted = false;
			const requests: CapturedTransportRequest[] = [];
			globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
				if (String(input).endsWith("/models"))
					return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
				const request = captureTransportRequest(input, init);
				requests.push(request);
				if (request.model !== "openai/gpt-4o-mini") return Promise.resolve(openAiSseResponse("unexpected fallback"));
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
			expect(requests).toEqual([
				{
					url: "https://abort.matrix.test/v1/chat/completions",
					authorization: "Bearer matrix-abort-key",
					model: "openai/gpt-4o-mini",
					outputTokenBound: 32,
				},
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
