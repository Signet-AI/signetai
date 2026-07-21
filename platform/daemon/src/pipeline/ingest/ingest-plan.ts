/**
 * IngestPlan — the strict handoff object between the runner-owned `plan`
 * phase and the deterministic `validate/apply` phase of unified ingest (#913).
 *
 * Dreaming is one activity with interchangeable inference executors (daemon
 * 24/7, agentic harness on cron, future cloud). Whatever fills the reasoning
 * slot emits an IngestPlan; the deterministic apply layer consumes it. That is
 * the parity contract: any executor that produces a valid IngestPlan, apply
 * accepts.
 *
 * An IngestPlan carries three output classes — the full surface the dreaming
 * skill already reaches, made structural:
 *
 *   1. memories     → source-backed recall rows (txIngestEnvelope)
 *   2. graphOps     → the full 19-op ontology vocabulary (applyOntologyOperationBatch,
 *                     direct apply / no proposal queue; versioned + provenance-bearing)
 *   3. filePatches  → authored edits to identity/behavior files (AGENTS.md, SOUL.md,
 *                     skills, literature notes) — file writes under a per-file lock,
 *                     never silent SQLite edits
 *
 * Security/seam rules (the model never self-certifies):
 *   - `agentId` / `jobId` are ECHOED from the lease context for traceability; the
 *     apply phase verifies them against the leased job and rejects mismatches.
 *   - There is NO model-authored idempotency or authorization field. The
 *     idempotency key (queue item id + planHash) is computed by apply from the
 *     plan contents; `planHash` is therefore not in the model-authored body.
 *   - The deterministic guards (schema validation, normalized-content dedup,
 *     durability gate, write gate, entity-label quality, forgotten-memory) run
 *     in apply, outside the model.
 */

import { z } from "zod";

/**
 * The full ontology operation vocabulary. This is exactly the dreaming skill's
 * capability surface (what `signet ontology stream apply` drives) and exactly
 * what `applyOntologyOperationBatch` dispatches. Keep this in lockstep with
 * ONTOLOGY_PROPOSAL_OPERATIONS in platform/core/src/types.ts — if the two ever
 * diverge, apply will reject ops the skill can express (or accept ops it can't).
 */
export const INGEST_GRAPH_OPERATIONS = [
	"create_entity",
	"rename_entity",
	"archive_entity",
	"merge_entities",
	"create_aspect",
	"rename_aspect",
	"archive_aspect",
	"add_claim_value",
	"set_claim_value",
	"supersede_claim_value",
	"archive_claim_value",
	"restore_claim_version",
	"create_link",
	"update_link",
	"archive_link",
	"create_policy",
	"create_action_type",
	"create_interface",
	"attach_interface",
] as const;

export type IngestGraphOperation = (typeof INGEST_GRAPH_OPERATIONS)[number];

/**
 * A graph op. Structurally compatible with OntologyOperationInput (the shape
 * applyOntologyOperationBatch consumes). Payload is op-specific and validated
 * inside each apply* handler; here we only validate the envelope and that the
 * op kind is in the closed vocabulary.
 *
 * `id` is an optional executor-supplied handle for per-op apply-status tracking
 * (applied/skipped/failed). It is NOT the idempotency key — that is computed
 * from the op's resolved content at apply.
 */
export const GraphOpSchema = z.object({
	id: z.string().min(1).optional(),
	operation: z.enum(INGEST_GRAPH_OPERATIONS),
	payload: z.record(z.string(), z.unknown()),
	reason: z.string().optional(),
	evidence: z.array(z.unknown()).optional(),
	confidence: z.number().min(0).max(1).optional(),
	risk: z.string().nullable().optional(),
	sourceKind: z.string().nullable().optional(),
	sourceId: z.string().nullable().optional(),
	sourcePath: z.string().nullable().optional(),
	sourceRoot: z.string().nullable().optional(),
});
export type GraphOp = z.infer<typeof GraphOpSchema>;

/**
 * A memory op → a source-backed recall row via txIngestEnvelope. The executor
 * authors the meaningful fields; the deterministic apply phase fills the rest
 * (id, contentHash, normalizedContent, createdAt, agentId, sourceType/sourceId
 * from the leased batch, idempotencyKey) and runs the dedup/durability/write
 * gates. `sourceSpan` carries provenance back into the batch source so a memory
 * can cite where in the transcript it came from.
 */
export const MemoryOpSchema = z.object({
	id: z.string().min(1).optional(),
	content: z.string().min(1),
	why: z.string().nullable().optional(),
	project: z.string().nullable().optional(),
	importance: z.number().min(0).max(1).optional(),
	type: z.string().optional(),
	tags: z.array(z.string()).optional(),
	scope: z.string().nullable().optional(),
	visibility: z.enum(["global", "private", "archived"]).optional(),
	sourceSpan: z
		.object({
			itemId: z.string().min(1),
			start: z.number().int().min(0).optional(),
			end: z.number().int().min(0).optional(),
		})
		.optional(),
});
export type MemoryOp = z.infer<typeof MemoryOpSchema>;

/**
 * Identity/behavior files a file-patch may target. Skills and literature notes
 * live at paths rather than fixed names, so the apply phase also accepts a
 * relative path under the workspace; the closed list below covers the named
 * identity files the runbook and identity machinery already manage.
 */
export const IDENTITY_FILE_NAMES = [
	"AGENTS.md",
	"SOUL.md",
	"IDENTITY.md",
	"USER.md",
	"MEMORY.md",
	"HEARTBEAT.md",
	"DREAMING.md",
] as const;

/**
 * A file-patch op → an authored edit to an identity/behavior file. The first-cut
 * shape is an append of a rendered markdown block (optionally under a section
 * anchor), which minimizes collision surface vs full-rewrite diffs. Apply takes
 * a per-file lock, captures before-state for one-call revert, writes the block
 * with a patch marker, and records the patch id so a re-apply is a no-op.
 *
 * `id` is REQUIRED on file patches: unlike memory/graph writes (upsert/insert-
 * or-ignore by construction), two plans appending to the same file collide, so
 * the patch id is the dedup handle.
 */
export const FilePatchOpSchema = z.object({
	id: z.string().min(1),
	file: z.string().min(1),
	append: z.string().min(1),
	section: z.string().optional(),
	reason: z.string().optional(),
	evidence: z.array(z.unknown()).optional(),
	confidence: z.number().min(0).max(1).optional(),
});
export type FilePatchOp = z.infer<typeof FilePatchOpSchema>;

/**
 * The model-authored plan body — what an executor (daemon provider call,
 * harness turn, command provider) produces. Contains NO authorization or
 * idempotency fields; those live in the apply-side envelope below.
 */
export const IngestPlanBodySchema = z.object({
	memories: z.array(MemoryOpSchema),
	graphOps: z.array(GraphOpSchema),
	filePatches: z.array(FilePatchOpSchema),
	notes: z
		.object({
			skipped: z
				.array(
					z.object({
						itemId: z.string().min(1).optional(),
						reason: z.string(),
					}),
				)
				.optional(),
			uncertain: z.array(z.string()).optional(),
		})
		.optional(),
	executorModel: z.string().optional(),
});
export type IngestPlanBody = z.infer<typeof IngestPlanBodySchema>;

/**
 * The full handoff object posted to apply. The envelope (schemaVersion, jobId,
 * agentId, sourceHash, createdAt) is attached by the runner from the leased
 * context; the apply phase verifies jobId/agentId against the lease token and
 * recomputes planHash from the body. `planHash` is therefore intentionally
 * absent from the posted shape — it is derived, never trusted.
 */
export const INGEST_PLAN_SCHEMA_VERSION = 1;

export const IngestPlanSchema = IngestPlanBodySchema.extend({
	schemaVersion: z.literal(INGEST_PLAN_SCHEMA_VERSION),
	jobId: z.string().min(1),
	agentId: z.string().min(1),
	sourceHash: z.string().min(1),
	createdAt: z.string().optional(),
});
export type IngestPlan = z.infer<typeof IngestPlanSchema>;

export type IngestPlanParseError = {
	ok: false;
	errors: readonly string[];
};

export type IngestPlanParseOk = {
	ok: true;
	plan: IngestPlan;
};

/**
 * Validate an unknown input as a strict IngestPlan. Fails closed — a malformed
 * plan never reaches apply. Used by both the daemon in-process path and the
 * /api/ingest/apply endpoint.
 */
export function parseIngestPlan(input: unknown): IngestPlanParseOk | IngestPlanParseError {
	const parsed = IngestPlanSchema.safeParse(input);
	if (parsed.success) return { ok: true, plan: parsed.data };
	const errors = parsed.error.issues.map(
		(i) => `${i.path.join(".")}: ${i.message}`,
	);
	return { ok: false, errors };
}
