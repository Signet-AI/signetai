/**
 * Cross-entity dependency synthesis worker.
 *
 * Polling worker that discovers connections between entities by
 * presenting the LLM with an entity's facts alongside the top
 * entities from the graph. Separate from structural-dependency
 * which only sees facts from a single memory at a time.
 */

import { DEPENDENCY_TYPES, type DependencyType } from "@signet/core";
import type { DbAccessor, ReadDb } from "../db-accessor";
import { upsertDependency } from "../knowledge-graph";
import { logger } from "../logger";
import type { PipelineV2Config } from "../memory-config";
import { stripFences, tryParseJson } from "./extraction";
import { invalidateTraversalCache } from "./graph-traversal";
import type { LlmProvider } from "./provider";
import { DEP_DESCRIPTIONS } from "./structural-dependency";
import type { WorkerProgressStats } from "./worker";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DependencySynthesisHandle {
	stop(): Promise<void>;
	readonly running: boolean;
}

export interface DependencySynthesisDeps {
	readonly accessor: DbAccessor;
	readonly agentId: string;
	readonly provider: LlmProvider;
	readonly pipelineCfg: PipelineV2Config;
	readonly getExtractionStats?: () => WorkerProgressStats | undefined;
}

interface StaleEntity {
	readonly id: string;
	readonly name: string;
	readonly entityType: string;
}

interface GraphEntity {
	readonly id: string;
	readonly name: string;
	readonly entityType: string;
	readonly mentions: number;
}

interface SynthesisResult {
	readonly target: string;
	readonly dep_type: string;
	readonly reason: string;
}

const VALID_DEP_TYPES = new Set<string>(DEPENDENCY_TYPES);

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function findStaleEntities(db: ReadDb, agentId: string, limit: number): readonly StaleEntity[] {
	return db
		.prepare(
			`SELECT id, name, entity_type
			 FROM entities
			 WHERE agent_id = ?
			   AND (last_synthesized_at IS NULL
			        OR last_synthesized_at < updated_at)
			 ORDER BY updated_at DESC
			 LIMIT ?`,
		)
		.all(agentId, limit) as StaleEntity[];
}

function loadFacts(db: ReadDb, agentId: string, entityId: string, limit: number): readonly string[] {
	const rows = db
		.prepare(
			`SELECT ea.content
			 FROM entity_attributes ea
			 JOIN entity_aspects asp ON asp.id = ea.aspect_id
			 WHERE asp.entity_id = ? AND ea.agent_id = ?
			   AND ea.status = 'active'
			 ORDER BY ea.updated_at DESC
			 LIMIT ?`,
		)
		.all(entityId, agentId, limit) as Array<{ content: string }>;
	return rows.map((r) => r.content);
}

function loadTopEntities(db: ReadDb, agentId: string, excludeId: string, limit: number): readonly GraphEntity[] {
	return db
		.prepare(
			`SELECT id, name, entity_type, mentions
			 FROM entities
			 WHERE id != ? AND agent_id = ? AND mentions > 0
			 ORDER BY mentions DESC
			 LIMIT ?`,
		)
		.all(excludeId, agentId, limit) as GraphEntity[];
}

function loadExistingTargets(db: ReadDb, agentId: string, entityId: string): ReadonlySet<string> {
	const rows = db
		.prepare(
			`SELECT dst.name AS target_name
			 FROM entity_dependencies dep
			 JOIN entities dst ON dst.id = dep.target_entity_id
			   AND dst.agent_id = ?
			 WHERE dep.source_entity_id = ? AND dep.agent_id = ?`,
		)
		.all(agentId, entityId, agentId) as Array<{ target_name: string }>;
	return new Set(rows.map((r) => r.target_name));
}

function loadLatestExtractionProgressAt(accessor: DbAccessor, agentId: string): number | undefined {
	return accessor.withReadDb((db) => {
		const row = db
			.prepare(
				`SELECT MAX(CAST(strftime('%s', j.completed_at) AS INTEGER) * 1000) AS last_progress_at
				 FROM memory_jobs j
				 JOIN memories m ON m.id = j.memory_id
				 WHERE j.status = 'completed'
				   AND j.job_type IN ('extract', 'extraction')
				   AND j.completed_at IS NOT NULL
				   AND m.agent_id = ?`,
			)
			// NOTE: strftime('%s') truncates to 1-second resolution.
			// At the default 30-minute stall window this is negligible (<0.1%).
			// For very small stall windows (≤10 s), the rounding may cause
			// ±1 tick of jitter near the boundary.
			// Bun bundles SQLite ≥ 3.39 (2022), which parses +HH:MM offsets
			// in strftime correctly. Older SQLite returns NULL — the guard
			// below handles this by falling back to undefined (no stall).
			.get(agentId) as unknown;
		if (typeof row !== "object" || row === null) return undefined;
		const raw = (row as Record<string, unknown>).last_progress_at;
		const value = typeof raw === "number" ? raw : null;
		return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
	});
}

function markSynthesized(accessor: DbAccessor, agentId: string, entityId: string): void {
	const now = new Date().toISOString();
	accessor.withWriteTx((db) => {
		db.prepare("UPDATE entities SET last_synthesized_at = ? WHERE id = ? AND agent_id = ?").run(now, entityId, agentId);
	});
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export function buildSynthesisPrompt(
	entity: StaleEntity,
	facts: readonly string[],
	candidates: readonly GraphEntity[],
	existing: ReadonlySet<string>,
): string {
	const factList = facts.map((f, i) => `${i + 1}. ${f}`).join("\n");

	const entityList = candidates.map((e) => `- ${e.name} (${e.entityType}, ${e.mentions} mentions)`).join("\n");

	const alreadyConnected =
		existing.size > 0 ? `Already connected to: ${[...existing].join(", ")}` : "No existing connections.";

	return `Task: identify new dependency edges between the focal entity and known graph entities.

Entity: ${entity.name} (${entity.entityType})
Facts:
${factList}

Known entities in the knowledge graph:
${entityList}

${alreadyConnected}

Dependency types:
${DEPENDENCY_TYPES.map((t) => `- ${t}: ${DEP_DESCRIPTIONS[t]}`).join("\n")}

Rules:
- Only connect ${entity.name} to entities from the known entity list above.
- Only return edges supported by the facts.
- Do not repeat already-connected entities unless the dependency type differs.
- Prefer the most direct dependency type.
- Keep reason short and concrete.
- Do not add markdown.

Examples:
- If facts say a service uses Redis, return {"target": "Redis", "dep_type": "uses", "reason": "service actively uses Redis"}
- If facts say a service is owned by the platform team, return {"target": "platform team", "dep_type": "owned_by", "reason": "team maintains the service"}
- If no supported connection is stated, return []

Return one JSON array.
Each item: {"target": "entity name", "dep_type": "type", "reason": "why"}
If no new connections exist, return [].
/no_think`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateResults(parsed: unknown): readonly SynthesisResult[] {
	if (!Array.isArray(parsed)) return [];

	const valid: SynthesisResult[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const obj = item as Record<string, unknown>;

		const target = typeof obj.target === "string" ? obj.target.trim() : "";
		if (target.length === 0) continue;

		const depType = typeof obj.dep_type === "string" ? obj.dep_type.trim() : "";
		if (!VALID_DEP_TYPES.has(depType)) continue;

		const reason = typeof obj.reason === "string" ? obj.reason.trim().slice(0, 300) : "";

		valid.push({ target, dep_type: depType, reason });
	}

	return valid;
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

export function shouldRunDependencySynthesis(
	now: number,
	lastExtractionProgressAt: number | undefined,
	maxStallMs: number | undefined,
): boolean {
	if (maxStallMs === undefined || maxStallMs <= 0) return true;
	// Missing, never-ran, or epoch timestamps are not treated as stalls.
	if (lastExtractionProgressAt === undefined || lastExtractionProgressAt <= 0) return true;
	return now - lastExtractionProgressAt <= maxStallMs;
}

export function resolveExtractionProgressAt(
	workerProgressAt: number | undefined,
	durableProgressAt: number | undefined,
): number | undefined {
	const worker = typeof workerProgressAt === "number" && workerProgressAt > 0 ? workerProgressAt : undefined;
	const durable = typeof durableProgressAt === "number" && durableProgressAt > 0 ? durableProgressAt : undefined;
	if (worker == null) return durable;
	if (durable == null) return worker;
	return Math.max(worker, durable);
}

export function shouldLoadDurableExtractionProgress(
	now: number,
	workerProgressAt: number | undefined,
	freshnessMs: number,
): boolean {
	if (typeof workerProgressAt !== "number" || !Number.isFinite(workerProgressAt) || workerProgressAt <= 0) return true;
	return now - workerProgressAt > freshnessMs;
}

export function durableExtractionProgressFreshnessMs(synthesisIntervalMs: number, maxStallMs: number): number {
	return Math.min(synthesisIntervalMs, Math.max(1, Math.floor(maxStallMs / 2)));
}

export async function runDependencySynthesisTick(deps: DependencySynthesisDeps): Promise<void> {
	const cfg = deps.pipelineCfg.structural;
	const maxStallMs = cfg.synthesisMaxStallMs;
	const extractionStats = deps.getExtractionStats?.();
	const now = Date.now();
	const workerProgressAt = extractionStats?.lastProgressAt;
	const durableProgressAt =
		maxStallMs > 0 &&
		shouldLoadDurableExtractionProgress(
			now,
			workerProgressAt,
			durableExtractionProgressFreshnessMs(cfg.synthesisIntervalMs, maxStallMs),
		)
			? loadLatestExtractionProgressAt(deps.accessor, deps.agentId)
			: undefined;
	const lastProgressAt = maxStallMs > 0 ? resolveExtractionProgressAt(workerProgressAt, durableProgressAt) : undefined;
	if (!shouldRunDependencySynthesis(now, lastProgressAt, maxStallMs)) {
		logger.debug("dependency-synthesis", "Skipping tick while extraction pipeline is stalled", {
			stalledMs: now - (lastProgressAt ?? 0),
			maxStallMs,
			pending: extractionStats?.pending,
		});
		return;
	}

	const stale = deps.accessor.withReadDb((db) => findStaleEntities(db, deps.agentId, cfg.dependencyBatchSize));
	if (stale.length === 0) return;

	for (const entity of stale) {
		const facts = deps.accessor.withReadDb((db) => loadFacts(db, deps.agentId, entity.id, cfg.synthesisMaxFacts));

		if (facts.length === 0) {
			markSynthesized(deps.accessor, deps.agentId, entity.id);
			continue;
		}

		const candidates = deps.accessor.withReadDb((db) =>
			loadTopEntities(db, deps.agentId, entity.id, cfg.synthesisTopEntities),
		);

		if (candidates.length === 0) {
			markSynthesized(deps.accessor, deps.agentId, entity.id);
			continue;
		}

		const existing = deps.accessor.withReadDb((db) => loadExistingTargets(db, deps.agentId, entity.id));

		const prompt = buildSynthesisPrompt(entity, facts, candidates, existing);

		let raw: string;
		try {
			raw = await deps.provider.generate(prompt, { temperature: 0.1 });
		} catch (e) {
			logger.warn("dependency-synthesis", "LLM call failed", {
				entity: entity.name,
				error: e instanceof Error ? e.message : String(e),
			});
			continue;
		}

		const stripped = stripFences(raw);
		const parsed = tryParseJson(stripped);
		const results = validateResults(parsed);

		let created = 0;
		for (const result of results) {
			const canonical = result.target.trim().toLowerCase().replace(/\s+/g, " ");
			const target = deps.accessor.withReadDb(
				(db) =>
					db
						.prepare("SELECT id FROM entities WHERE canonical_name = ? AND agent_id = ? AND id != ? LIMIT 1")
						.get(canonical, deps.agentId, entity.id) as { id: string } | undefined,
			);

			if (!target) continue;

			try {
				const normalized = result.reason.trim();
				const reason =
					result.dep_type === "related_to" && !normalized
						? `llm synthesized a loose association from ${entity.name} to ${result.target}`
						: normalized || undefined;
				upsertDependency(deps.accessor, {
					sourceEntityId: entity.id,
					targetEntityId: target.id,
					agentId: deps.agentId,
					dependencyType: result.dep_type as DependencyType,
					strength: 0.5,
					confidence: 0.5,
					reason,
				});
				created++;
			} catch (e) {
				logger.warn("dependency-synthesis", "Upsert failed", {
					entity: entity.name,
					target: result.target,
					error: String(e),
				});
			}
		}

		// Only mark synthesized if there was nothing to do or at least one
		// upsert succeeded — otherwise the entity retries on the next tick.
		if (results.length === 0 || created > 0) {
			markSynthesized(deps.accessor, deps.agentId, entity.id);
		}

		if (created > 0) {
			invalidateTraversalCache();
		}

		logger.info("dependency-synthesis", "Entity synthesized", {
			entity: entity.name,
			candidates: candidates.length,
			results: results.length,
			created,
		});
	}
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

export function startDependencySynthesisWorker(deps: DependencySynthesisDeps): DependencySynthesisHandle {
	let running = true;
	let ticking = false;
	let tickDone: (() => void) | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	const interval = deps.pipelineCfg.structural.synthesisIntervalMs;

	timer = setInterval(() => {
		if (!running || ticking) return;
		ticking = true;
		runDependencySynthesisTick(deps)
			.catch((e) => {
				logger.warn("dependency-synthesis", "Tick error", {
					error: String(e),
				});
			})
			.finally(() => {
				ticking = false;
				if (tickDone) tickDone();
			});
	}, interval);

	logger.info("dependency-synthesis", "Worker started", {
		intervalMs: interval,
		topEntities: deps.pipelineCfg.structural.synthesisTopEntities,
		maxFacts: deps.pipelineCfg.structural.synthesisMaxFacts,
		maxStallMs: deps.pipelineCfg.structural.synthesisMaxStallMs,
	});

	return {
		async stop() {
			running = false;
			if (timer) clearInterval(timer);
			// Drain in-flight tick before returning
			if (ticking) {
				await new Promise<void>((resolve) => {
					tickDone = resolve;
				});
			}
			logger.info("dependency-synthesis", "Worker stopped");
		},
		get running() {
			return running;
		},
	};
}
