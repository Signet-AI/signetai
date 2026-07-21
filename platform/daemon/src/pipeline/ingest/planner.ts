/**
 * Unified ingest plan phase (#913) — the daemon's in-process reasoning engine.
 *
 * One consolidated reasoning call per context bundle. This is the fusion of the
 * legacy 5-stage chain (extraction + decision + structural-classify + structural-
 * dependency + escalation-L2) into a single holistic pass: the model sees the
 * source, the DREAMING.md runbook, and the existing graph slice together, and
 * emits one IngestPlan. Long context + prompt caching make this better-informed
 * AND frequently cheaper than the fragmented narrow calls it replaces — the
 * narrow chain was the failure mode (each stage reasoned over a sliver and
 * couldn't self-correct, which is how duplicate entities and contradictory
 * claims slipped in).
 *
 * The agentic runner does NOT call this — it reasons in its own harness turn and
 * posts an IngestPlan back directly. Only the inference source differs; both
 * emit the same strict handoff.
 *
 * The LLM call routes through the configured provider's `generate`, which
 * engages the #918 broker (the daemon-global LlmConcurrencySemaphore is acquired
 * inside the provider path). The AbortSignal propagates end-to-end so pause/
 * cancel reaches inference. Structured output uses responseFormat:"json" where
 * supported; the parser defends against reasoning-wrapped output from local
 * models. `planHash` and `sourceHash` are computed here from the inputs, never
 * trusted from the model.
 */

import { createHash } from "node:crypto";
import type { LlmProvider } from "../provider";
import { logger } from "../../logger";
import type { IngestContext } from "./context";
import { INGEST_GRAPH_OPERATIONS, parseIngestPlan, type IngestPlan } from "./ingest-plan";

export interface PlanIngestOptions {
	readonly provider: LlmProvider;
	readonly model?: string;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly maxTokens?: number;
	/** "daemon" (in-process) | "command" (external bin provider). */
	readonly executorKind?: "daemon" | "command";
}

export type PlanIngestResult =
	| { readonly ok: true; readonly plan: IngestPlan }
	| { readonly ok: false; readonly reason: "empty" | "malformed" | "provider-error"; readonly message: string };

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Defensively extract the JSON object from a model response. Local models
 * sometimes wrap output in reasoning prose or fenced blocks. Find the first
 * balanced `{...}` and return it; if that fails, fall back to the substring
 * between the first and last brace. Never converts malformed output into an
 * empty success — returns null when no JSON object can be isolated.
 */
function extractJsonObject(raw: string): string | null {
	const trimmed = raw.trim();
	// Strip a fenced code block if present.
	const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;

	// Balanced-brace scan from the first '{'.
	const start = candidate.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < candidate.length; i++) {
		const ch = candidate[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return candidate.slice(start, i + 1);
		}
	}
	// Unbalanced — fall back to first..last brace substring.
	const last = candidate.lastIndexOf("}");
	if (last > start) return candidate.slice(start, last + 1);
	return null;
}

/**
 * The consolidated prompt. Merges the 5 stages into one holistic pass: extract
 * durable memories, decide add/dedup against the existing graph, propose graph
 * ops from the full vocabulary, and propose file patches when the source reveals
 * a durable behavioral lesson. The output is the strict IngestPlan body.
 */
function buildPlanPrompt(ctx: IngestContext): string {
	const graphVocab = INGEST_GRAPH_OPERATIONS.join(", ");
	return [
		"You are Signet's dreaming pass: memory maintenance over the source below.",
		"Reason holistically over the SOURCE, the RUNBOOK, and the EXISTING GRAPH, then emit ONE strict JSON plan.",
		"",
		"## What to produce",
		"- memories: durable facts, preferences, decisions, and identity-bearing observations distilled from the source.",
		"  Skip transient operational content (task progress, run/test status, momentary state) — those are rejected downstream anyway.",
		"  Set importance 0..1 from real significance. Each memory needs content; why/project/tags are optional.",
		"- graphOps: entities + their aspects/claims + links, using ONLY these operations:",
		`  ${graphVocab}`,
		"  Dedup against EXISTING GRAPH: prefer set_claim_value / supersede_claim_value / rename over create_entity when the entity already exists.",
		"  Each op carries a payload appropriate to its kind (e.g. create_entity:{name,entity_type}; set_claim_value:{entity,aspect,group,claim,value}; create_link:{source,target,type}).",
		"- filePatches: ONLY when the source reveals a durable behavioral lesson or preference that belongs in an identity/behavior file",
		"  (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md, or a skill). Each needs a unique id, the file, and the markdown block to append.",
		"  If nothing rises to that bar, emit an empty array.",
		"",
		"## Output shape (return ONLY the JSON object, no prose, no code fence)",
		"{",
		'  "memories": [ { "content": "...", "importance": 0.8, "type": "preference", "why": "...", "tags": ["..."], "scope": null, "visibility": "global" } ],',
		'  "graphOps": [ { "operation": "create_entity", "payload": { "name": "...", "entity_type": "..." }, "reason": "...", "confidence": 0.9 } ],',
		'  "filePatches": [ { "id": "fp1", "file": "AGENTS.md", "append": "## ...\\n...", "reason": "..." } ],',
		'  "notes": { "skipped": [], "uncertain": [] }',
		"}",
		"",
		"## RUNBOOK (DREAMING.md — your guidance for this pass)",
		ctx.dreamingMd || "(no runbook configured)",
		"",
		"## EXISTING GRAPH (dedup context — do not duplicate these)",
		ctx.graphSlice || "(empty — fresh territory)",
		"",
		"## SOURCE",
		ctx.source.content || "(empty source)",
		"",
		"Emit the JSON plan now.",
	].join("\n");
}

/**
 * Run the consolidated plan phase. Produces a full IngestPlan (body from the
 * model; jobId/agentId/sourceHash/executor attached + verified by the caller at
 * apply). sourceHash is computed here from the source so the model cannot
 * misattribute it. planHash is computed at apply.
 */
export async function planIngest(ctx: IngestContext, opts: PlanIngestOptions): Promise<PlanIngestResult> {
	const prompt = buildPlanPrompt(ctx);

	let raw: string;
	try {
		raw = await opts.provider.generate(prompt, {
			signal: opts.signal,
			responseFormat: "json",
			timeoutMs: opts.timeoutMs,
			maxTokens: opts.maxTokens,
			think: false,
		});
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		logger.warn("pipeline", "planner provider call failed", { message, jobId: ctx.jobId });
		return { ok: false, reason: "provider-error", message };
	}

	const jsonText = extractJsonObject(raw);
	if (!jsonText) {
		return { ok: false, reason: "malformed", message: "No JSON object found in planner response" };
	}

	let body: unknown;
	try {
		body = JSON.parse(jsonText);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return { ok: false, reason: "malformed", message: `Planner JSON parse failed: ${message}` };
	}

	// Attach the envelope (computed from the context, never model-authored) and
	// validate the full plan against the strict schema. parseIngestPlan fails
	// closed on any shape violation.
	const sourceHash = `sha256:${sha256(ctx.source.content).slice(0, 16)}`;
	const planInput = {
		...(body as Record<string, unknown>),
		schemaVersion: 1,
		jobId: ctx.jobId,
		agentId: ctx.agentId,
		sourceHash,
		createdAt: new Date().toISOString(),
		executorModel: opts.model,
	};
	const parsed = parseIngestPlan(planInput);
	if (!parsed.ok) {
		return {
			ok: false,
			reason: "malformed",
			message: `Planner output failed schema validation: ${parsed.errors.join("; ")}`,
		};
	}

	// An empty plan (no memories, no graph ops, no patches) is a legitimate
	// "nothing durable here" outcome — surface it so the caller completes the
	// lease rather than retrying.
	const plan = parsed.plan;
	const isEmpty = plan.memories.length === 0 && plan.graphOps.length === 0 && plan.filePatches.length === 0;
	if (isEmpty) {
		return { ok: true, plan };
	}

	return { ok: true, plan };
}
