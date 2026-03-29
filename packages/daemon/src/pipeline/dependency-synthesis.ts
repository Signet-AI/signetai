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
import type { PipelineV2Config } from "../memory-config";
import type { LlmProvider } from "./provider";
import { stripFences, tryParseJson } from "./extraction";
import { DEP_DESCRIPTIONS } from "./structural-dependency";
import { upsertDependency } from "../knowledge-graph";
import { invalidateTraversalCache } from "./graph-traversal";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DependencySynthesisHandle {
	stop(): Promise<void>;
	readonly running: boolean;
}

interface DependencySynthesisDeps {
	readonly accessor: DbAccessor;
	readonly provider: LlmProvider;
	readonly pipelineCfg: PipelineV2Config;
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

// TODO: thread agentId from DependencySynthesisDeps when multi-agent lands
const AGENT_ID = "default";

function findStaleEntities(db: ReadDb, limit: number): readonly StaleEntity[] {
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
		.all(AGENT_ID, limit) as StaleEntity[];
}

function loadFacts(db: ReadDb, entityId: string, limit: number): readonly string[] {
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
		.all(entityId, AGENT_ID, limit) as Array<{ content: string }>;
	return rows.map((r) => r.content);
}

function loadTopEntities(db: ReadDb, excludeId: string, limit: number): readonly GraphEntity[] {
	return db
		.prepare(
			`SELECT id, name, entity_type, mentions
			 FROM entities
			 WHERE id != ? AND agent_id = ? AND mentions > 0
			 ORDER BY mentions DESC
			 LIMIT ?`,
		)
		.all(excludeId, AGENT_ID, limit) as GraphEntity[];
}

function loadExistingTargets(db: ReadDb, entityId: string): ReadonlySet<string> {
	const rows = db
		.prepare(
			`SELECT dst.name AS target_name
			 FROM entity_dependencies dep
			 JOIN entities dst ON dst.id = dep.target_entity_id
			   AND dst.agent_id = ?
			 WHERE dep.source_entity_id = ? AND dep.agent_id = ?`,
		)
		.all(AGENT_ID, entityId, AGENT_ID) as Array<{ target_name: string }>;
	return new Set(rows.map((r) => r.target_name));
}

function markSynthesized(accessor: DbAccessor, entityId: string): void {
	const now = new Date().toISOString();
	accessor.withWriteTx((db) => {
		db.prepare(
			"UPDATE entities SET last_synthesized_at = ? WHERE id = ? AND agent_id = ?",
		).run(now, entityId, AGENT_ID);
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

	const entityList = candidates
		.map((e) => `- ${e.name} (${e.entityType}, ${e.mentions} mentions)`)
		.join("\n");

	const alreadyConnected = existing.size > 0
		? `Already connected to: ${[...existing].join(", ")}`
		: "No existing connections.";

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

		const reason = typeof obj.reason === "string"
			? obj.reason.trim().slice(0, 300)
			: "";

		valid.push({ target, dep_type: depType, reason });
	}

	return valid;
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

async function tick(deps: DependencySynthesisDeps): Promise<void> {
	const cfg = deps.pipelineCfg.structural;

	const stale = deps.accessor.withReadDb((db) =>
		findStaleEntities(db, cfg.dependencyBatchSize),
	);
	if (stale.length === 0) return;

	for (const entity of stale) {
		const facts = deps.accessor.withReadDb((db) =>
			loadFacts(db, entity.id, cfg.synthesisMaxFacts),
		);

		if (facts.length === 0) {
			markSynthesized(deps.accessor, entity.id);
			continue;
		}

		const candidates = deps.accessor.withReadDb((db) =>
			loadTopEntities(db, entity.id, cfg.synthesisTopEntities),
		);

		if (candidates.length === 0) {
			markSynthesized(deps.accessor, entity.id);
			continue;
		}

		const existing = deps.accessor.withReadDb((db) =>
			loadExistingTargets(db, entity.id),
		);

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
			const target = deps.accessor.withReadDb((db) =>
				db
					.prepare("SELECT id FROM entities WHERE canonical_name = ? LIMIT 1")
					.get(canonical) as { id: string } | undefined,
			);

			if (!target || target.id === entity.id) continue;

			try {
				const normalized = result.reason.trim();
				const reason =
					result.dep_type === "related_to" && !normalized
						? `llm synthesized a loose association from ${entity.name} to ${result.target}`
						: normalized || null;
				upsertDependency(deps.accessor, {
					sourceEntityId: entity.id,
					targetEntityId: target.id,
					agentId: AGENT_ID,
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
			markSynthesized(deps.accessor, entity.id);
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

export function startDependencySynthesisWorker(
	deps: DependencySynthesisDeps,
): DependencySynthesisHandle {
	let running = true;
	let ticking = false;
	let tickDone: (() => void) | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	const interval = deps.pipelineCfg.structural.synthesisIntervalMs;

	timer = setInterval(() => {
		if (!running || ticking) return;
		ticking = true;
		tick(deps)
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
	});

	return {
		async stop() {
			running = false;
			if (timer) clearInterval(timer);
			// Drain in-flight tick before returning
			if (ticking) {
				await new Promise<void>((resolve) => { tickDone = resolve; });
			}
			logger.info("dependency-synthesis", "Worker stopped");
		},
		get running() {
			return running;
		},
	};
}
