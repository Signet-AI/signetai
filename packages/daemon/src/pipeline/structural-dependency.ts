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
import { upsertDependency } from "../knowledge-graph";
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
}

const VALID_DEP_TYPES = new Set<string>(DEPENDENCY_TYPES);

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

function buildDependencyPrompt(
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

	return `Classify each fact. Also identify if the fact implies a dependency between entities.

Entity: ${entityName} (${entityType})
Aspects: ${aspectList}

Dependency types: uses, requires, owned_by, blocks, informs

${factList}

For each fact return: {"i": N, "aspect": "...", "kind": "attribute"|"constraint", "dep_target": "entity or null", "dep_type": "type or null"}
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

		const aspect = typeof obj.aspect === "string" ? obj.aspect.trim() : "";
		if (aspect.length === 0) continue;

		const kind = obj.kind === "constraint" ? "constraint" as const : "attribute" as const;

		const depTarget = typeof obj.dep_target === "string" && obj.dep_target.trim().length > 0
			? obj.dep_target.trim()
			: null;
		const depType = typeof obj.dep_type === "string" && VALID_DEP_TYPES.has(obj.dep_type)
			? obj.dep_type
			: null;

		valid.push({ i, aspect, kind, dep_target: depTarget, dep_type: depType });
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

	// Call LLM
	let raw: string;
	try {
		raw = await deps.provider.generate(prompt, { temperature: 0.1 });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		logger.warn("structural-dependency", "LLM call failed", { error: msg });
		deps.accessor.withWriteTx((db) => {
			for (const idx of validIndices) {
				failJob(db, jobs[idx].id, msg, jobs[idx].attempts + 1, jobs[idx].max_attempts);
			}
		});
		return;
	}

	// Parse response
	const stripped = stripFences(raw);
	const parsed = tryParseJson(stripped);
	const results = validateDependencyResults(parsed, validPayloads.length);

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
				upsertDependency(deps.accessor, {
					sourceEntityId: payload.entity_id,
					targetEntityId: targetEntity.id,
					agentId: "default",
					dependencyType: result.dep_type as DependencyType,
					strength: 0.5,
				});
				depsCreated++;
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
