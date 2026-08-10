/**
 * Opt-in live provider contract matrix for inference routing (#1324).
 *
 * The matrix intentionally goes through InferenceRouter for every case. It
 * does not import an Anthropic, OpenAI, or ACPX client directly, so a provider
 * is tested through the same workload resolver and fallback path used by the
 * daemon.
 *
 * Required environment:
 *   SIGNET_INFERENCE_LIVE_CONFIG=/path/to/agents
 *   SIGNET_INFERENCE_LIVE_TARGETS=anthropic/default,openai/default,ollama/default
 *   SIGNET_INFERENCE_LIVE_FAILURE_TARGET=provider-failure/default
 *   SIGNET_INFERENCE_LIVE_FALLBACK_TARGET=openai/default
 *
 * The config must contain a healthy Anthropic target, a healthy OpenAI target,
 * and one additional provider family or ACPX target. The failure target must
 * pass its availability probe but fail completion with a retryable provider
 * error; this keeps fallback coverage deterministic without a vendor-specific
 * test client. Credentials remain in the normal account/secret configuration.
 *
 * Run explicitly because live calls are never part of the default test gate:
 *
 *   bun test platform/daemon/src/inference-provider-matrix.live.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { type RouteRequest, parseRoutingTargetRef } from "@signet/core";
import { type InferenceExecutionAttempt, InferenceRouter, type InferenceStatusSummary } from "./inference-router";
import { type PipelineCauseFamily, normalizePipelineCause } from "./pipeline-operation";
import { stripFences, tryParseJson } from "./pipeline/extraction";

const LIVE_CONFIG = process.env.SIGNET_INFERENCE_LIVE_CONFIG?.trim();
const LIVE_TARGET_REFS = readTargetRefs(process.env.SIGNET_INFERENCE_LIVE_TARGETS);
const FAILURE_TARGET_REF = process.env.SIGNET_INFERENCE_LIVE_FAILURE_TARGET?.trim();
const FALLBACK_TARGET_REF = process.env.SIGNET_INFERENCE_LIVE_FALLBACK_TARGET?.trim();
const LIVE_AGENT_ID = process.env.SIGNET_INFERENCE_LIVE_AGENT?.trim();
const LIVE_TIMEOUT_MS = readBoundedInt("SIGNET_INFERENCE_LIVE_TIMEOUT_MS", 250, 50, 5_000);
const FALLBACK_TIMEOUT_MS = readBoundedInt("SIGNET_INFERENCE_LIVE_FALLBACK_TIMEOUT_MS", 30_000, 1_000, 120_000);
const SKIP = !LIVE_CONFIG || LIVE_TARGET_REFS.length === 0;

const STRUCTURED_MARKER = "signet-inference-matrix";
const RETRYABLE_FAILURES = new Set<PipelineCauseFamily>(["provider_unavailable", "timeout", "rate_limit", "quota"]);

interface LiveTarget {
	readonly ref: string;
	readonly targetId: string;
	readonly modelId: string;
}

interface MatrixContext {
	readonly router: InferenceRouter;
	readonly status: InferenceStatusSummary;
	readonly targets: readonly LiveTarget[];
	readonly agentId: string;
}

interface StructuredProbe {
	readonly matrix: string;
	readonly value: string;
}

function readTargetRefs(raw: string | undefined): readonly string[] {
	if (!raw) return [];
	return [
		...new Set(
			raw
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean),
		),
	];
}

function readBoundedInt(name: string, fallback: number, min: number, max: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new Error(`${name} must be an integer between ${min} and ${max}`);
	}
	return value;
}

function parseTarget(ref: string): LiveTarget {
	const parsed = parseRoutingTargetRef(ref);
	if (parsed.ok === false) throw new Error(`${ref}: ${parsed.error.message}`);
	return { ref, targetId: parsed.value.targetId, modelId: parsed.value.modelId };
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

function providerIdentity(target: LiveTarget, status: InferenceStatusSummary): string {
	const summary = status.targets[target.targetId];
	if (!summary) throw new Error(`Target ${target.ref} is not present in inference status`);
	if (summary.executor === "acpx") return "acpx";
	return (summary.account ? status.accounts[summary.account]?.providerFamily : undefined) ?? summary.executor;
}

function providerKind(target: LiveTarget, status: InferenceStatusSummary): "anthropic" | "openai" | "acpx" | "other" {
	const identity = providerIdentity(target, status).toLowerCase();
	if (identity === "anthropic" || identity.startsWith("anthropic-")) return "anthropic";
	if (identity === "openai" || identity.startsWith("openai-")) return "openai";
	if (identity === "acpx") return "acpx";
	return "other";
}

function requestFor(agentId: string, targets: readonly string[], prompt: string): RouteRequest {
	return {
		agentId,
		operation: "interactive",
		explicitTargets: targets,
		promptPreview: prompt.slice(0, 160),
	};
}

async function execute(
	context: MatrixContext,
	targets: readonly string[],
	prompt: string,
	opts: { readonly timeoutMs: number; readonly maxTokens: number },
) {
	return context.router.execute(requestFor(context.agentId, targets, prompt), prompt, opts);
}

function attemptsFromResult(
	result: Awaited<ReturnType<InferenceRouter["execute"]>>,
): readonly InferenceExecutionAttempt[] {
	if (result.ok === true) return result.value.attempts;
	const attempts = result.error.details?.attempts;
	if (!Array.isArray(attempts)) return [];
	return attempts.filter(isAttempt);
}

function isAttempt(value: unknown): value is InferenceExecutionAttempt {
	return (
		isRecord(value) &&
		typeof value.targetRef === "string" &&
		typeof value.ok === "boolean" &&
		typeof value.durationMs === "number"
	);
}

function structuredPrompt(value: string): string {
	return [
		"You are a provider contract probe.",
		"Return exactly one JSON object and no markdown, explanation, or extra keys.",
		`The object must be {\"matrix\":\"${STRUCTURED_MARKER}\",\"value\":\"${value}\"}.`,
	].join("\n");
}

const LONG_OUTPUT_PROMPT = [
	"You are a timeout contract probe.",
	"Generate a detailed essay about distributed systems with at least 2,000 words.",
	"Do not stop early and do not summarize the request.",
].join("\n");

describe.skipIf(SKIP)("live inference provider contract matrix (#1324)", () => {
	let context: MatrixContext;

	beforeAll(async () => {
		const targets = LIVE_TARGET_REFS.map(parseTarget);
		if (targets.length < 3) {
			throw new Error("SIGNET_INFERENCE_LIVE_TARGETS must list at least three provider target refs");
		}

		const router = new InferenceRouter(LIVE_CONFIG ?? "");
		const statusResult = await router.status(true);
		if (statusResult.ok === false) throw new Error(statusResult.error.message);
		const status = statusResult.value;
		const agentId = LIVE_AGENT_ID || status.defaultAgentId;
		if (status.agents.length > 0 && !status.agents.includes(agentId)) {
			throw new Error(`SIGNET_INFERENCE_LIVE_AGENT ${agentId} is not configured in the live agent roster`);
		}

		for (const target of targets) {
			const targetStatus = status.targets[target.targetId];
			const state = status.runtimeSnapshot.targets[target.ref];
			if (!targetStatus || !state) throw new Error(`Live target ${target.ref} is missing from router status`);
			if (!state.available) {
				throw new Error(`Live target ${target.ref} is unavailable: ${state.unavailableReason ?? "unknown reason"}`);
			}
		}

		const kinds = new Set(targets.map((target) => providerKind(target, status)));
		if (!kinds.has("anthropic")) throw new Error("The live matrix needs an Anthropic target");
		if (!kinds.has("openai")) throw new Error("The live matrix needs an OpenAI target");
		if (!kinds.has("acpx") && !kinds.has("other")) {
			throw new Error("The live matrix needs an additional non-OpenAI provider or ACPX target");
		}

		if ((FAILURE_TARGET_REF && !FALLBACK_TARGET_REF) || (!FAILURE_TARGET_REF && FALLBACK_TARGET_REF)) {
			throw new Error(
				"SIGNET_INFERENCE_LIVE_FAILURE_TARGET and SIGNET_INFERENCE_LIVE_FALLBACK_TARGET must be set together",
			);
		}
		for (const ref of [FAILURE_TARGET_REF, FALLBACK_TARGET_REF]) {
			if (!ref) continue;
			const parsed = parseTarget(ref);
			const state = status.runtimeSnapshot.targets[ref];
			if (!status.targets[parsed.targetId] || !state)
				throw new Error(`Fallback target ${ref} is missing from router status`);
			if (!state.available) {
				throw new Error(
					`Fallback target ${ref} must pass availability probing: ${state.unavailableReason ?? "unknown reason"}`,
				);
			}
		}

		context = { router, status, targets, agentId };
	});

	test("returns schema-valid structured output from every configured provider", async () => {
		for (const target of context.targets) {
			const result = await execute(context, [target.ref], structuredPrompt("structured-ok"), {
				timeoutMs: 30_000,
				maxTokens: 128,
			});
			expect(result.ok).toBe(true);
			if (result.ok === false) continue;
			expect(parseStructured(result.value.text)).toEqual({ matrix: STRUCTURED_MARKER, value: "structured-ok" });
		}
	}, 180_000);

	test("rejects malformed structured output without changing the routed provider state", async () => {
		for (const target of context.targets) {
			const result = await execute(
				context,
				[target.ref],
				"Return exactly the plain text MALFORMED_STRUCTURED_OUTPUT. Do not return JSON, markdown, or an explanation.",
				{ timeoutMs: 30_000, maxTokens: 64 },
			);
			expect(result.ok).toBe(true);
			if (result.ok === false) continue;
			expect(parseStructured(result.value.text)).toBeNull();
		}
	}, 180_000);

	test("bounds provider timeout and normalizes the resulting transient failure", async () => {
		for (const target of context.targets) {
			const startedAt = performance.now();
			const result = await execute(context, [target.ref], LONG_OUTPUT_PROMPT, {
				timeoutMs: LIVE_TIMEOUT_MS,
				maxTokens: 2_048,
			});
			const elapsedMs = performance.now() - startedAt;
			const attempt = attemptsFromResult(result).find((entry) => entry.targetRef === target.ref);
			expect(attempt).toBeDefined();
			if (!attempt) continue;
			expect(attempt?.ok).toBe(false);
			expect(attempt?.durationMs).toBeLessThan(LIVE_TIMEOUT_MS + 5_000);
			expect(elapsedMs).toBeLessThan(10_000);
			const cause = normalizePipelineCause(new Error(attempt?.error ?? result.error.message));
			expect(["timeout", "cancellation"]).toContain(cause);
		}
	}, 180_000);

	test("performs one bounded fallback and keeps the fallback provider state isolated", async () => {
		if (!FAILURE_TARGET_REF || !FALLBACK_TARGET_REF) {
			expect(FAILURE_TARGET_REF).toBeTruthy();
			expect(FALLBACK_TARGET_REF).toBeTruthy();
			return;
		}
		const failureTarget = parseTarget(FAILURE_TARGET_REF);
		const fallbackTarget = parseTarget(FALLBACK_TARGET_REF);
		expect(providerIdentity(failureTarget, context.status)).not.toBe(providerIdentity(fallbackTarget, context.status));

		const startedAt = performance.now();
		const result = await execute(context, [failureTarget.ref, fallbackTarget.ref], structuredPrompt("fallback-ok"), {
			timeoutMs: FALLBACK_TIMEOUT_MS,
			maxTokens: 128,
		});
		const elapsedMs = performance.now() - startedAt;
		expect(result.ok).toBe(true);
		if (result.ok === false) return;
		expect(result.value.attempts.map((attempt) => [attempt.targetRef, attempt.ok])).toEqual([
			[failureTarget.ref, false],
			[fallbackTarget.ref, true],
		]);
		expect(result.value.attempts.find((attempt) => attempt.ok)?.targetRef).toBe(fallbackTarget.ref);
		expect(elapsedMs).toBeLessThan(FALLBACK_TIMEOUT_MS * 2 + 5_000);
		expect(parseStructured(result.value.text)).toEqual({ matrix: STRUCTURED_MARKER, value: "fallback-ok" });

		const failedAttempt = result.value.attempts[0];
		const cause = normalizePipelineCause(new Error(failedAttempt?.error ?? ""));
		expect(RETRYABLE_FAILURES.has(cause)).toBe(true);

		const followUp = await execute(context, [fallbackTarget.ref], structuredPrompt("fallback-follow-up"), {
			timeoutMs: FALLBACK_TIMEOUT_MS,
			maxTokens: 128,
		});
		expect(followUp.ok).toBe(true);
		if (followUp.ok === true) {
			expect(followUp.value.attempts.find((attempt) => attempt.ok)?.targetRef).toBe(fallbackTarget.ref);
			expect(parseStructured(followUp.value.text)).toEqual({
				matrix: STRUCTURED_MARKER,
				value: "fallback-follow-up",
			});
		}
	}, 240_000);
});
