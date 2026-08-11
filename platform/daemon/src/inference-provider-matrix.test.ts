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
	const parsed = JSON.parse(String(init?.body)) as { readonly model?: unknown };
	if (typeof parsed.model !== "string") throw new Error("matrix request did not include a model");
	return parsed.model;
}

function writeMatrixConfig(dir: string): void {
	mkdirSync(join(dir, "memory"), { recursive: true });
	writeFileSync(
		join(dir, "agent.yaml"),
		`inference:
  defaultPolicy: matrix
  accounts:
    matrix:
      kind: api
      providerFamily: openrouter
      credentialRef: SIGNET_MATRIX_API_KEY
  targets:
    structured:
      executor: openrouter
      account: matrix
      models:
        default:
          model: openai/gpt-4o-mini
    primary:
      executor: openrouter
      account: matrix
      models:
        default:
          model: deepseek/deepseek-v4-flash
    fallback:
      executor: openrouter
      account: matrix
      models:
        default:
          model: inception/mercury-2
    abort:
      executor: openrouter
      account: matrix
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
	test("uses workload-selected targets and parses bounded structured output", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-provider-matrix-structured-"));
		try {
			writeMatrixConfig(dir);
			process.env.SIGNET_MATRIX_API_KEY = "test-matrix-key";
			const requestedModels: string[] = [];
			globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
				const model = requestModel(init);
				requestedModels.push(model);
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
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("retries the workload route once and keeps another workload target usable", async () => {
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
						new Response(JSON.stringify({ error: { message: "temporary upstream failure" } }), { status: 503 }),
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
			expect(failedAttempt?.error).toContain("503");

			const isolated = await router.execute(
				{ operation: "aggregate_recall", promptPreview: "matrix target isolation" },
				"Use the isolated workload route.",
				{ maxTokens: 32, timeoutMs: 1_000 },
			);
			expect(isolated.ok).toBe(true);
			if (!isolated.ok) return;
			expect(isolated.value.decision.targetRef).toBe("structured/default");
			expect(isolated.value.attempts).toEqual([expect.objectContaining({ targetRef: "structured/default", ok: true })]);
			expect(requestedModels).toEqual(["deepseek/deepseek-v4-flash", "inception/mercury-2", "openai/gpt-4o-mini"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("aborts the selected workload request without running a fallback", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-provider-matrix-abort-"));
		try {
			writeMatrixConfig(dir);
			process.env.SIGNET_MATRIX_API_KEY = "test-matrix-key";
			let markStarted: (() => void) | undefined;
			const started = new Promise<void>((resolve) => {
				markStarted = resolve;
			});
			const requestedModels: string[] = [];
			globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
				const model = requestModel(init);
				requestedModels.push(model);
				if (model !== "openai/gpt-4o-mini") return Promise.resolve(openAiSseResponse("unexpected fallback"));
				markStarted?.();
				return new Promise<Response>((_resolve, reject) => {
					if (init?.signal?.aborted) {
						reject(new DOMException("aborted", "AbortError"));
						return;
					}
					init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
						once: true,
					});
				});
			}) as unknown as typeof fetch;

			const router = getOrCreateInferenceRouter(dir);
			const controller = new AbortController();
			const pending = router.execute(
				{ operation: "interactive", promptPreview: "matrix abort" },
				"Wait for cancellation.",
				{ maxTokens: 32, timeoutMs: 1_000, signal: controller.signal },
			);
			await started;
			controller.abort();
			const aborted = await pending;
			expect(aborted.ok).toBe(false);
			if (aborted.ok) return;
			const attempts = aborted.error.details?.attempts;
			expect(attempts).toEqual([expect.objectContaining({ targetRef: "abort/default", ok: false })]);
			expect(requestedModels).toEqual(["openai/gpt-4o-mini"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
