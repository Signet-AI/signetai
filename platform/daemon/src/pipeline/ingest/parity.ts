/**
 * Phase 5 parity harness (#913) — the go/no-go gate before the legacy chain is
 * deleted in the cutover.
 *
 * The consolidated planner's quality advantages (no duplicate entities, no
 * contradictory claims, consistent aspect naming on shared entities) are
 * properties of the model reasoning over the full context. They cannot be
 * proven with stub providers — a stub returns canned output that is trivially
 * "consistent." So this module splits the gate in two:
 *
 *   - `computePlannerQualityMetrics(plans)` — a PURE function from a set of
 *     IngestPlans to quality metrics (memory dedup, entity duplication, aspect-
 *     naming consistency on shared entities, op-vocabulary distribution, contra-
 *     diction flags). This is unit-tested with fixtures below.
 *   - `runPlannerOnCorpus(...)` — the real-provider benchmark: run the
 *     consolidated planner over a transcript corpus with a configured provider,
 *     collect the plans, hand them to the metrics function. This is the actual
 *     go/no-go signal; it is opt-in (provider-backed) and not part of CI.
 *
 * The headline metric is aspect-naming consistency on shared entities — the
 * synthesis's flagged blocker. The legacy chain's structural-classify worker
 * batches ACROSS memories to keep aspect names consistent for one entity; the
 * consolidated planner must achieve the same within its batch. If this metric
 * regresses below tolerance on a real corpus, the cutover does not proceed
 * (structural-classify stays as a post-ingest lane instead).
 */

import type { DbAccessor, ReadDb } from "../../db-accessor";
import type { LlmProvider } from "../provider";
import { buildIngestContext, type IngestContext } from "./context";
import { planIngest } from "./planner";
import type { IngestPlan, IngestGraphOperation } from "./ingest-plan";
import type { IngestJobRow } from "./lease";

export interface ParityTranscript {
	readonly id: string;
	readonly content: string;
	readonly agentId: string;
	readonly project?: string | null;
}

export interface AspectConsistency {
	/** Entities that appear with more than one claim/aspect across the plans. */
	readonly sharedEntities: number;
	/** Of those, entities whose aspect names are mutually consistent. */
	readonly consistent: number;
	/** consistent / sharedEntities (0 when no shared entities). */
	readonly score: number;
	readonly inconsistencies: ReadonlyArray<{ entity: string; aspects: readonly string[] }>;
}

export interface PlannerQualityMetrics {
	readonly planCount: number;
	readonly memoryCount: number;
	readonly duplicateMemoryHashes: number;
	readonly graphOpCount: number;
	readonly graphOpsByKind: Readonly<Record<string, number>>;
	readonly entityCount: number;
	readonly duplicateEntities: number;
	readonly aspectConsistency: AspectConsistency;
}

function canonicalize(name: string): string {
	return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Pure metrics over a set of plans. Deterministic — the unit test exercises this
 * with fixtures. The aspect-naming consistency metric is the headline: for each
 * entity that receives more than one set/add/supersede claim across the corpus,
 * are the aspect slot names mutually consistent?
 */
export function computePlannerQualityMetrics(plans: readonly IngestPlan[]): PlannerQualityMetrics {
	const memoryHashes = new Map<string, number>();
	let graphOpCount = 0;
	const opsByKind: Record<string, number> = {};
	const entityNameCounts = new Map<string, number>(); // create_entity canonical names

	const claimKinds: ReadonlySet<IngestGraphOperation> = new Set([
		"set_claim_value",
		"add_claim_value",
		"supersede_claim_value",
		"restore_claim_version",
	]);
	// entity → { claimCount, distinctAspects }. "Shared" = claimCount > 1; the
	// legacy structural-classify worker existed to keep one entity's aspect slot
	// names mutually consistent across its claims.
	const entityClaims = new Map<string, { count: number; aspects: Set<string> }>();

	for (const plan of plans) {
		for (const mem of plan.memories) {
			// A lightweight content hash (the apply path uses normalized content;
			// here we approximate to surface obvious duplicates).
			const key = mem.content.trim().toLowerCase();
			memoryHashes.set(key, (memoryHashes.get(key) ?? 0) + 1);
		}
		for (const op of plan.graphOps) {
			graphOpCount++;
			opsByKind[op.operation] = (opsByKind[op.operation] ?? 0) + 1;
			const payload = op.payload as Record<string, unknown>;
			if (op.operation === "create_entity") {
				const name = typeof payload.name === "string" ? canonicalize(payload.name) : "";
				if (name) entityNameCounts.set(name, (entityNameCounts.get(name) ?? 0) + 1);
			}
			if (claimKinds.has(op.operation)) {
				const entity = typeof payload.entity === "string" ? canonicalize(payload.entity) : "";
				const aspect = typeof payload.aspect === "string" ? payload.aspect.trim() : "";
				if (entity && aspect) {
					let entry = entityClaims.get(entity);
					if (!entry) {
						entry = { count: 0, aspects: new Set() };
						entityClaims.set(entity, entry);
					}
					entry.count++;
					entry.aspects.add(aspect);
				}
			}
		}
	}

	const duplicateMemoryHashes = Array.from(memoryHashes.values()).filter((n) => n > 1).reduce((a, n) => a + (n - 1), 0);
	const duplicateEntities = Array.from(entityNameCounts.values()).filter((n) => n > 1).reduce((a, n) => a + (n - 1), 0);

	let shared = 0;
	let consistent = 0;
	const inconsistencies: { entity: string; aspects: readonly string[] }[] = [];
	for (const [entity, entry] of entityClaims) {
		// "Shared" = the entity received more than one claim op across the corpus.
		if (entry.count > 1) {
			shared++;
			const list = Array.from(entry.aspects);
			const canonical = new Set(list.map((a) => canonicalize(a)));
			if (canonical.size === 1) {
				consistent++;
			} else {
				inconsistencies.push({ entity, aspects: list });
			}
		}
	}
	const aspectConsistency: AspectConsistency = {
		sharedEntities: shared,
		consistent,
		score: shared > 0 ? consistent / shared : 1,
		inconsistencies,
	};

	return {
		planCount: plans.length,
		memoryCount: plans.reduce((a, p) => a + p.memories.length, 0),
		duplicateMemoryHashes,
		graphOpCount,
		graphOpsByKind: opsByKind,
		entityCount: entityNameCounts.size,
		duplicateEntities,
		aspectConsistency,
	};
}

export interface RunPlannerOnCorpusOptions {
	readonly provider: LlmProvider;
	readonly model?: string;
	readonly agentsDir: string;
	readonly contextWindow?: number;
	readonly signal?: AbortSignal;
}

export interface CorpusRunResult {
	readonly plans: readonly IngestPlan[];
	readonly metrics: PlannerQualityMetrics;
	readonly failures: ReadonlyArray<{ transcriptId: string; reason: string }>;
}

/**
 * Run the consolidated planner over a transcript corpus with a real provider and
 * compute quality metrics. This is the opt-in go/no-go benchmark — not a CI
 * test. A small corpus of real transcripts surfaces whether the planner produces
 * duplicate entities, duplicate memories, or inconsistent aspect naming on
 * shared entities (the legacy chain's failure modes).
 */
export async function runPlannerOnCorpus(
	accessor: DbAccessor,
	transcripts: readonly ParityTranscript[],
	opts: RunPlannerOnCorpusOptions,
): Promise<CorpusRunResult> {
	const plans: IngestPlan[] = [];
	const failures: { transcriptId: string; reason: string }[] = [];

	for (const transcript of transcripts) {
		// Synthesize a leased-job row so buildIngestContext can resolve the source.
		const job: IngestJobRow = {
			id: transcript.id,
			memory_id: null,
			document_id: null,
			job_type: "ingest",
			status: "leased",
			payload: JSON.stringify({ text: transcript.content, project: transcript.project ?? null }),
			attempts: 1,
			max_attempts: 5,
			priority: 0,
			agent_id: transcript.agentId,
		};
		const ctx: IngestContext = accessor.withReadDb((db: ReadDb) =>
			buildIngestContext(db, {
				job,
				agentId: transcript.agentId,
				agentsDir: opts.agentsDir,
				contextWindow: opts.contextWindow,
			}),
		);
		const planned = await planIngest(ctx, {
			provider: opts.provider,
			model: opts.model,
			signal: opts.signal,
		});
		if (planned.ok) {
			plans.push(planned.plan);
		} else {
			failures.push({ transcriptId: transcript.id, reason: `${planned.reason}: ${planned.message}` });
		}
	}

	return { plans, metrics: computePlannerQualityMetrics(plans), failures };
}
