/**
 * Pass 2b: Dependency extraction worker.
 *
 * Leases structural_dependency jobs, calls the LLM to identify
 * dependencies between entities, and creates entity_dependencies rows.
 * Also provides bonus aspect/kind classification when available.
 */

import { DEPENDENCY_TYPES, type DependencyType } from "@signet/core";
import type { DbAccessor, WriteDb, ReadDb } from "../db-accessor";
import type { PipelineV2Config } from "../memory-config";
import type { LlmProvider } from "./provider";
import { stripFences, tryParseJson } from "./extraction";
import { upsertAspect, upsertDependency } from "../knowledge-graph";
import { invalidateTraversalCache } from "./graph-traversal";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StructuralDependencyHandle {
	stop(): Promise<void>;
	readonly running: boolean;
}

interface StructuralDependencyDeps {
	readonly accessor: DbAccessor;
	readonly provider: LlmProvider;
	readonly pipelineCfg: PipelineV2Config;
}

interface DependencyJobRow {
	readonly id: string;
	readonly memory_id: string;
	readonly payload: string;
	readonly attempts: number;
	readonly max_attempts: number;
}

interface DependencyPayload {
	readonly memory_id: string;
	readonly entity_id: string;
	readonly entity_name: string;
	readonly fact_content: string;
	readonly target_entity_name: string;
}

interface DependencyResult {
	readonly i: number;
	readonly aspect: string;
	readonly kind: "attribute" | "constraint";
	readonly dep_target: string | null;
	readonly dep_type: string | null;
	readonly reason: string | null;
}

const VALID_DEP_TYPES = new Set<string>(DEPENDENCY_TYPES);

// One-line descriptions to steer the LLM toward consistent type selection.
// Included in the extraction prompt so the model disambiguates similar pairs
// (e.g. uses vs depends_on, informs vs teaches, precedes vs follows).
export const DEP_DESCRIPTIONS: Record<DependencyType, string> = {
	uses: "actively calls or consumes at runtime",
	requires: "cannot function without (hard prerequisite)",
	owned_by: "maintained or governed by",
	blocks: "prevents progress of",
	informs: "sends data or signals to",
	built: "was created or constructed by",
	depends_on: "needs but does not directly call (soft dependency)",
	related_to: "associated loosely, no directional dependency",
	learned_from: "acquired knowledge from",
	teaches: "transfers knowledge to",
	knows: "is aware of or references",
	assumes: "presupposes as true without verifying",
	contradicts: "conflicts with or negates",
	supersedes: "replaces or obsoletes",
	part_of: "is a component or subset of",
	precedes: "must happen before (temporal)",
	follows: "happens after (temporal)",
	triggers: "causes to start or execute",
	impacts: "change here affects (blast radius)",
	produces: "generates as output",
	consumes: "takes as input",
};

// ---------------------------------------------------------------------------
// Job leasing
// ---------------------------------------------------------------------------

function leaseDependencyBatch(
	db: WriteDb,
	maxBatch: number,
	maxAttempts: number,
): readonly DependencyJobRow[] {
	const now = new Date().toISOString();
	const nowEpoch = Math.floor(Date.now() / 1000);

	const rows = db
		.prepare(
			`SELECT id, memory_id, payload, attempts, max_attempts
			 FROM memory_jobs
			 WHERE job_type = 'structural_dependency'
			   AND status = 'pending'
			   AND attempts < ?
			   AND (failed_at IS NULL
			        OR (? - CAST(strftime('%s', failed_at) AS INTEGER))
			           > MIN((1 << attempts) * 5, 120))
			 ORDER BY created_at ASC
			 LIMIT ?`,
		)
		.all(maxAttempts, nowEpoch, maxBatch) as DependencyJobRow[];

	for (const row of rows) {
		db.prepare(
			`UPDATE memory_jobs
			 SET status = 'leased', leased_at = ?, attempts = attempts + 1,
			     updated_at = ?
			 WHERE id = ?`,
		).run(now, now, row.id);
	}

	return rows;
}

// ---------------------------------------------------------------------------
// Job completion / failure
// ---------------------------------------------------------------------------

function completeJob(db: WriteDb, jobId: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE memory_jobs
		 SET status = 'completed', completed_at = ?, updated_at = ?
		 WHERE id = ?`,
	).run(now, now, jobId);
}

function failJob(
	db: WriteDb,
	jobId: string,
	error: string,
	attempts: number,
	maxAttempts: number,
): void {
	const now = new Date().toISOString();
	const status = attempts >= maxAttempts ? "dead" : "pending";
	db.prepare(
		`UPDATE memory_jobs
		 SET status = ?, error = ?, failed_at = ?, updated_at = ?
		 WHERE id = ?`,
	).run(status, error, now, now, jobId);
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

export function buildDependencyPrompt(
	entityName: string,
	entityType: string,
	existingAspects: readonly string[],
	facts: readonly string[],
): string {
	const aspectList = existingAspects.length > 0
		? existingAspects.join(", ")
		: "[none yet]";

	const factList = facts
		.map((f, i) => `${i + 1}. ${f}`)
		.join("\n");

	return `Task: classify each fact and decide whether it states a dependency.

Entity: ${entityName} (${entityType})
Aspects: ${aspectList}

Dependency types:
${DEPENDENCY_TYPES.map((t) => `- ${t}: ${DEP_DESCRIPTIONS[t]}`).join("\n")}

Rules:
- Return exactly ${facts.length} JSON objects, one for each numbered fact.
- Keep the same fact number in "i".
- Use dep_target = null and dep_type = null when no dependency is stated.
- Only use dependency types from the list above.
- Use a short aspect name.
- "constraint" is only for rules or must/never style requirements.
- For "uses", "requires", "owned_by", "blocks", and "informs", prefer the most direct interpretation.
- Do not skip facts.
- Do not add markdown.

Examples:
- "auth service uses JWT tokens" -> {"i": 1, "aspect": "auth", "kind": "attribute", "dep_target": "JWT tokens", "dep_type": "uses", "reason": "service actively uses JWT tokens"}
- "auth service requires redis" -> {"i": 2, "aspect": "runtime", "kind": "attribute", "dep_target": "redis", "dep_type": "requires", "reason": "service cannot function without redis"}
- "auth service is owned by the platform team" -> {"i": 3, "aspect": "ownership", "kind": "attribute", "dep_target": "platform team", "dep_type": "owned_by", "reason": "platform team maintains the service"}
- "auth service blocks deployment when health check fails" -> {"i": 4, "aspect": "deployment", "kind": "attribute", "dep_target": "deployment", "dep_type": "blocks", "reason": "failed health check prevents deployment"}
- "auth service informs the audit log" -> {"i": 5, "aspect": "observability", "kind": "attribute", "dep_target": "audit log", "dep_type": "informs", "reason": "service sends signals or data to the audit log"}

${factList}

Return one JSON array with exactly ${facts.length} objects.
Schema for each object:
{"i": N, "aspect": "...", "kind": "attribute"|"constraint", "dep_target": "entity name or null", "dep_type": "dependency type or null", "reason": "short explanation or null"}
/no_think`;
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

function validateDependencyResults(
	parsed: unknown,
	factCount: number,
): readonly DependencyResult[] {
	if (!Array.isArray(parsed)) return [];

	const valid: DependencyResult[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const obj = item as Record<string, unknown>;

		const i = typeof obj.i === "number" ? obj.i : -1;
		if (i < 1 || i > factCount) continue;

		const aspect = typeof obj.aspect === "string" ? obj.aspect.trim().slice(0, 200) : "";
		if (aspect.length === 0) continue;

		const kind = obj.kind === "constraint" ? "constraint" as const : "attribute" as const;

		const depTarget = typeof obj.dep_target === "string" && obj.dep_target.trim().length > 0
			? obj.dep_target.trim()
			: null;
		const depType = typeof obj.dep_type === "string" && VALID_DEP_TYPES.has(obj.dep_type)
			? obj.dep_type
			: null;
		const reason = typeof obj.reason === "string" && obj.reason.trim().length > 0
			? obj.reason.trim().slice(0, 300)
			: null;

		valid.push({ i, aspect, kind, dep_target: depTarget, dep_type: depType, reason });
	}

	return valid;
}

// ---------------------------------------------------------------------------
// Core processing
// ---------------------------------------------------------------------------

async function processDependencyBatch(
	deps: StructuralDependencyDeps,
	jobs: readonly DependencyJobRow[],
): Promise<void> {
	if (jobs.length === 0) return;

	// Parse payloads — keep arrays parallel with jobs so indices stay aligned.
	// Invalid payloads get null; their jobs are failed after the batch.
	const payloads: Array<DependencyPayload | null> = [];
	for (const job of jobs) {
		try {
			payloads.push(JSON.parse(job.payload) as DependencyPayload);
		} catch {
			payloads.push(null);
		}
	}

	// Fail jobs with invalid payloads upfront
	deps.accessor.withWriteTx((db) => {
		for (let i = 0; i < jobs.length; i++) {
			if (payloads[i] === null) {
				failJob(db, jobs[i].id, "invalid_payload", jobs[i].attempts + 1, jobs[i].max_attempts);
			}
		}
	});

	// Build the valid subset for LLM processing (preserving original indices)
	const validIndices: number[] = [];
	const validPayloads: DependencyPayload[] = [];
	for (let i = 0; i < payloads.length; i++) {
		if (payloads[i] !== null) {
			validIndices.push(i);
			validPayloads.push(payloads[i]);
		}
	}
	if (validPayloads.length === 0) return;

	const entityName = validPayloads[0].entity_name;

	// Load entity type for prompt context
	const entityRow = deps.accessor.withReadDb((db) =>
		db
			.prepare("SELECT entity_type FROM entities WHERE id = ? LIMIT 1")
			.get(validPayloads[0].entity_id) as { entity_type: string } | undefined,
	);
	const entityType = entityRow?.entity_type ?? "unknown";

	// Load existing aspects
	const existingAspects = deps.accessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT name FROM entity_aspects
				 WHERE entity_id = ? AND agent_id = 'default'`,
			)
			.all(validPayloads[0].entity_id) as readonly { name: string }[];
		return rows.map((r) => r.name);
	});

	// Build prompt
	const factContents = validPayloads.map((p) => p.fact_content);
	const prompt = buildDependencyPrompt(
		entityName,
		entityType,
		existingAspects,
		factContents,
	);

	// Call LLM — retry once if parsing fails (qwen3 sometimes emits
	// verbose reasoning instead of JSON on the first attempt)
	let results: readonly DependencyResult[] = [];
	for (let attempt = 0; attempt < 2; attempt++) {
		let raw: string;
		try {
			raw = await deps.provider.generate(prompt, { temperature: 0.1 });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			logger.warn("structural-dependency", "LLM call failed", { error: msg });
			if (attempt === 1) {
				deps.accessor.withWriteTx((db) => {
					for (const idx of validIndices) {
						failJob(db, jobs[idx].id, msg, jobs[idx].attempts + 1, jobs[idx].max_attempts);
					}
				});
				return;
			}
			continue;
		}

		const stripped = stripFences(raw);
		const parsed = tryParseJson(stripped);
		results = validateDependencyResults(parsed, validPayloads.length);
		if (results.length > 0) break;

		logger.info("structural-dependency", "Empty parse, retrying", {
			entityName,
			attempt,
		});
	}

	// Apply results — LLM indices (1-based) map into validPayloads,
	// which maps back to jobs via validIndices.
	const processedJobIndices = new Set<number>();
	let depsCreated = 0;

	for (const result of results) {
		const vpIdx = result.i - 1;
		if (vpIdx < 0 || vpIdx >= validPayloads.length) continue;
		const payload = validPayloads[vpIdx];
		const jobIdx = validIndices[vpIdx];

		// If dependency detected, resolve target entity and create it
		if (result.dep_target !== null && result.dep_type !== null) {
			const targetCanonical = result.dep_target.trim().toLowerCase().replace(/\s+/g, " ");
			const targetEntity = deps.accessor.withReadDb((db) =>
				db
					.prepare("SELECT id FROM entities WHERE canonical_name = ? LIMIT 1")
					.get(targetCanonical) as { id: string } | undefined,
			);

			if (targetEntity) {
				// Not wrapped in withWriteTx — both upsertAspect and upsertDependency
				// acquire their own write tx internally, and DbAccessor uses
				// BEGIN IMMEDIATE (no savepoints), so nesting throws.
				// Orphaned aspects from a upsertDependency failure are benign —
				// the job retries on next tick and upsertAspect is idempotent.
				try {
					const aspect = upsertAspect(deps.accessor, {
						entityId: payload.entity_id,
						agentId: "default",
						name: result.aspect,
					});
					const normalized = result.reason?.trim() ?? "";
					const reason =
						result.dep_type === "related_to" && !normalized
							? `llm marked a loose association from fact: ${payload.fact_content.slice(0, 180)}`
							: normalized || null;
					upsertDependency(deps.accessor, {
						sourceEntityId: payload.entity_id,
						targetEntityId: targetEntity.id,
						agentId: "default",
						aspectId: aspect.id,
						dependencyType: result.dep_type as DependencyType,
						strength: 0.5,
						confidence: 0.7,
						reason,
					});
					depsCreated++;
				} catch (e) {
					logger.warn("structural-dependency", "upsert failed", {
						error: String(e),
						entity: payload.entity_id,
						target: targetEntity.id,
					});
					// Skip processedJobIndices — job retries on next tick
					continue;
				}
			}
		}

		processedJobIndices.add(jobIdx);
	}

	// Complete processed jobs, fail unprocessed valid ones
	deps.accessor.withWriteTx((db) => {
		for (const idx of validIndices) {
			if (processedJobIndices.has(idx)) {
				completeJob(db, jobs[idx].id);
			} else {
				failJob(
					db,
					jobs[idx].id,
					"dropped_from_llm_output",
					jobs[idx].attempts + 1,
					jobs[idx].max_attempts,
				);
			}
		}
	});

	if (depsCreated > 0) {
		invalidateTraversalCache();
	}

	logger.info("structural-dependency", "Batch processed", {
		entityName,
		total: jobs.length,
		valid: validPayloads.length,
		processed: processedJobIndices.size,
		dependenciesCreated: depsCreated,
	});
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

export function startStructuralDependencyWorker(
	deps: StructuralDependencyDeps,
): StructuralDependencyHandle {
	let running = true;
	let timer: ReturnType<typeof setInterval> | null = null;

	async function tick(): Promise<void> {
		if (!running) return;

		const jobs = deps.accessor.withWriteTx((db) =>
			leaseDependencyBatch(
				db,
				deps.pipelineCfg.structural.dependencyBatchSize,
				deps.pipelineCfg.worker.maxRetries,
			),
		);
		if (jobs.length === 0) return;

		await processDependencyBatch(deps, jobs);
	}

	timer = setInterval(() => {
		if (!running) return;
		tick().catch((e) => {
			logger.warn("structural-dependency", "Tick error", {
				error: String(e),
			});
		});
	}, deps.pipelineCfg.structural.pollIntervalMs);

	logger.info("structural-dependency", "Worker started", {
		pollIntervalMs: deps.pipelineCfg.structural.pollIntervalMs,
		dependencyBatchSize: deps.pipelineCfg.structural.dependencyBatchSize,
	});

	return {
		async stop() {
			running = false;
			if (timer) clearInterval(timer);
			logger.info("structural-dependency", "Worker stopped");
		},
		get running() {
			return running;
		},
	};
}
