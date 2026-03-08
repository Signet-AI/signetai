/**
 * Pass 2a: Structural classification worker.
 *
 * Leases structural_classify jobs, batches by entity_id, calls the LLM
 * to classify facts into aspects/kinds, and updates entity_attributes.
 * Same transaction discipline as other workers: no LLM calls inside
 * write locks.
 */

import type { DbAccessor, WriteDb, ReadDb } from "../db-accessor";
import type { PipelineV2Config } from "../memory-config";
import type { LlmProvider } from "./provider";
import { ENTITY_TYPES } from "@signet/core";
import { stripFences, tryParseJson } from "./extraction";
import { getAspectsForEntity } from "../knowledge-graph";
import { ASPECT_SUGGESTIONS } from "./aspect-suggestions";
import { logger } from "../logger";

const VALID_ENTITY_TYPES = new Set<string>(ENTITY_TYPES);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StructuralClassifyHandle {
	stop(): Promise<void>;
	readonly running: boolean;
}

interface StructuralClassifyDeps {
	readonly accessor: DbAccessor;
	readonly provider: LlmProvider;
	readonly pipelineCfg: PipelineV2Config;
}

interface ClassifyJobRow {
	readonly id: string;
	readonly memory_id: string;
	readonly payload: string;
	readonly attempts: number;
	readonly max_attempts: number;
}

interface ClassifyPayload {
	readonly memory_id: string;
	readonly entity_id: string;
	readonly entity_name: string;
	readonly entity_type: string;
	readonly fact_content: string;
	readonly attribute_id: string;
}

interface ClassifyResult {
	readonly i: number;
	readonly aspect: string;
	readonly kind: "attribute" | "constraint";
	readonly new: boolean;
}

// ---------------------------------------------------------------------------
// Job leasing
// ---------------------------------------------------------------------------

function leaseClassifyBatch(
	db: WriteDb,
	entityId: string,
	maxBatch: number,
	maxAttempts: number,
): readonly ClassifyJobRow[] {
	const now = new Date().toISOString();
	const nowEpoch = Math.floor(Date.now() / 1000);

	const rows = db
		.prepare(
			`SELECT id, memory_id, payload, attempts, max_attempts
			 FROM memory_jobs
			 WHERE job_type = 'structural_classify'
			   AND status = 'pending'
			   AND attempts < ?
			   AND (failed_at IS NULL
			        OR (? - CAST(strftime('%s', failed_at) AS INTEGER))
			           > MIN((1 << attempts) * 5, 120))
			   AND json_extract(payload, '$.entity_id') = ?
			 ORDER BY created_at ASC
			 LIMIT ?`,
		)
		.all(maxAttempts, nowEpoch, entityId, maxBatch) as ClassifyJobRow[];

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

/**
 * Find the next entity_id with pending structural_classify jobs
 * that are ready to run (respects exponential backoff on failed_at).
 */
function findNextEntity(db: ReadDb, maxAttempts: number): string | null {
	const nowEpoch = Math.floor(Date.now() / 1000);
	const row = db
		.prepare(
			`SELECT json_extract(payload, '$.entity_id') AS entity_id
			 FROM memory_jobs
			 WHERE job_type = 'structural_classify'
			   AND status = 'pending'
			   AND attempts < ?
			   AND (failed_at IS NULL
			        OR (? - CAST(strftime('%s', failed_at) AS INTEGER))
			           > MIN((1 << attempts) * 5, 120))
			 ORDER BY created_at ASC
			 LIMIT 1`,
		)
		.get(maxAttempts, nowEpoch) as { entity_id: string } | undefined;
	return row?.entity_id ?? null;
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

function buildClassifyPrompt(
	entityName: string,
	entityType: string,
	existingAspects: readonly string[],
	facts: readonly string[],
): string {
	const suggestions = ASPECT_SUGGESTIONS[entityType] ?? ASPECT_SUGGESTIONS.unknown;
	const aspectList = existingAspects.length > 0
		? existingAspects.join(", ")
		: "[none yet]";

	const factList = facts
		.map((f, i) => `${i + 1}. ${f}`)
		.join("\n");

	const entityTypeInstruction = entityType === "extracted"
		? `\nAlso determine the entity type. Add to your response object: "entity_type": "person"|"project"|"system"|"tool"|"concept"|"skill"|"task"`
		: "";

	return `Classify each fact into an aspect and kind for the given entity.

Entity: ${entityName} (${entityType})
Existing aspects: ${aspectList}
Suggested: ${suggestions.join(", ")}

Facts:
${factList}
${entityTypeInstruction}
Return a JSON object: {"results": [{"i": number, "aspect": string, "kind": "attribute"|"constraint", "new": boolean}, ...]${entityType === "extracted" ? ', "entity_type": string' : ""}}
/no_think`;
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

function validateClassifyResults(
	parsed: unknown,
	factCount: number,
): readonly ClassifyResult[] {
	if (!Array.isArray(parsed)) return [];

	const valid: ClassifyResult[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const obj = item as Record<string, unknown>;

		const i = typeof obj.i === "number" ? obj.i : -1;
		if (i < 1 || i > factCount) continue;

		const aspect = typeof obj.aspect === "string" ? obj.aspect.trim() : "";
		if (aspect.length === 0) continue;

		const kind = obj.kind === "constraint" ? "constraint" as const : "attribute" as const;
		const isNew = typeof obj.new === "boolean" ? obj.new : true;

		valid.push({ i, aspect, kind, new: isNew });
	}

	return valid;
}

// ---------------------------------------------------------------------------
// Core processing
// ---------------------------------------------------------------------------

async function processClassifyBatch(
	deps: StructuralClassifyDeps,
	jobs: readonly ClassifyJobRow[],
): Promise<void> {
	if (jobs.length === 0) return;

	// Parse payloads
	const payloads: ClassifyPayload[] = [];
	for (const job of jobs) {
		try {
			payloads.push(JSON.parse(job.payload) as ClassifyPayload);
		} catch {
			deps.accessor.withWriteTx((db) =>
				failJob(db, job.id, "invalid_payload", job.attempts + 1, job.max_attempts),
			);
		}
	}
	if (payloads.length === 0) return;

	const entityId = payloads[0].entity_id;
	const entityName = payloads[0].entity_name;
	const entityType = payloads[0].entity_type;

	// Load existing aspects
	const existingAspects = getAspectsForEntity(
		deps.accessor,
		entityId,
		"default",
	);
	const existingAspectNames = existingAspects.map((a) => a.name);

	// Build prompt
	const factContents = payloads.map((p) => p.fact_content);
	const prompt = buildClassifyPrompt(
		entityName,
		entityType,
		existingAspectNames,
		factContents,
	);

	// Call LLM
	let raw: string;
	try {
		raw = await deps.provider.generate(prompt, { temperature: 0.1 });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		logger.warn("structural-classify", "LLM call failed", { error: msg });
		deps.accessor.withWriteTx((db) => {
			for (const job of jobs) {
				failJob(db, job.id, msg, job.attempts + 1, job.max_attempts);
			}
		});
		return;
	}

	// Parse response — supports both array and {results, entity_type} object
	const stripped = stripFences(raw);
	const parsed = tryParseJson(stripped);

	let resultsSource: unknown = parsed;
	let inferredEntityType: string | undefined;

	if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
		const obj = parsed as Record<string, unknown>;
		if (Array.isArray(obj.results)) {
			resultsSource = obj.results;
		}
		if (typeof obj.entity_type === "string" && VALID_ENTITY_TYPES.has(obj.entity_type)) {
			inferredEntityType = obj.entity_type;
		}
	}

	const results = validateClassifyResults(resultsSource, payloads.length);

	// Apply all results + complete/fail jobs in a single transaction
	const processedIndices = new Set<number>();

	deps.accessor.withWriteTx((db) => {
		const now = new Date().toISOString();

		// Upgrade entity_type if currently "extracted" and the LLM inferred a real type
		if (inferredEntityType && entityType === "extracted") {
			db.prepare(
				`UPDATE entities SET entity_type = ? WHERE id = ? AND entity_type = 'extracted'`,
			).run(inferredEntityType, entityId);
		}

		for (const result of results) {
			const idx = result.i - 1; // 1-indexed to 0-indexed
			if (idx < 0 || idx >= payloads.length) continue;
			const payload = payloads[idx];

			// Inline aspect upsert (avoids separate tx per result)
			const canonical = result.aspect.trim().toLowerCase().replace(/\s+/g, " ");
			const aspectId = crypto.randomUUID();
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES (?, ?, 'default', ?, ?, 0.5, ?, ?)
				 ON CONFLICT(entity_id, canonical_name) DO UPDATE SET
				   name = excluded.name,
				   updated_at = excluded.updated_at`,
			).run(aspectId, entityId, result.aspect, canonical, now, now);

			// Read back the actual aspect id (may differ on conflict)
			const aspectRow = db
				.prepare(
					`SELECT id FROM entity_aspects
					 WHERE entity_id = ? AND canonical_name = ?`,
				)
				.get(entityId, canonical) as { id: string };

			// Update the entity_attributes row
			db.prepare(
				`UPDATE entity_attributes
				 SET aspect_id = ?, kind = ?, updated_at = ?
				 WHERE id = ?`,
			).run(aspectRow.id, result.kind, now, payload.attribute_id);

			processedIndices.add(idx);
		}

		// Complete processed jobs, fail unprocessed ones
		for (let i = 0; i < jobs.length; i++) {
			if (processedIndices.has(i)) {
				completeJob(db, jobs[i].id);
			} else {
				failJob(
					db,
					jobs[i].id,
					"dropped_from_llm_output",
					jobs[i].attempts + 1,
					jobs[i].max_attempts,
				);
			}
		}
	});

	logger.info("structural-classify", "Batch processed", {
		entityId,
		entityName,
		total: jobs.length,
		classified: processedIndices.size,
		dropped: jobs.length - processedIndices.size,
	});
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

export function startStructuralClassifyWorker(
	deps: StructuralClassifyDeps,
): StructuralClassifyHandle {
	let running = true;
	let timer: ReturnType<typeof setInterval> | null = null;

	async function tick(): Promise<void> {
		if (!running) return;

		// Find the next entity with pending jobs
		const entityId = deps.accessor.withReadDb((db) =>
			findNextEntity(db, deps.pipelineCfg.worker.maxRetries),
		);
		if (!entityId) return;

		// Lease a batch for that entity
		const jobs = deps.accessor.withWriteTx((db) =>
			leaseClassifyBatch(
				db,
				entityId,
				deps.pipelineCfg.structural.classifyBatchSize,
				deps.pipelineCfg.worker.maxRetries,
			),
		);
		if (jobs.length === 0) return;

		await processClassifyBatch(deps, jobs);
	}

	timer = setInterval(() => {
		if (!running) return;
		tick().catch((e) => {
			logger.warn("structural-classify", "Tick error", {
				error: String(e),
			});
		});
	}, deps.pipelineCfg.structural.pollIntervalMs);

	logger.info("structural-classify", "Worker started", {
		pollIntervalMs: deps.pipelineCfg.structural.pollIntervalMs,
		classifyBatchSize: deps.pipelineCfg.structural.classifyBatchSize,
	});

	return {
		async stop() {
			running = false;
			if (timer) clearInterval(timer);
			logger.info("structural-classify", "Worker stopped");
		},
		get running() {
			return running;
		},
	};
}
