import type { ReadDb } from "../db-accessor";

export interface TraversalPath {
	readonly entityIds: ReadonlyArray<string>;
	readonly aspectIds: ReadonlyArray<string>;
	readonly dependencyIds: ReadonlyArray<string>;
}

export interface TraversalResult {
	/** Memory IDs collected from entity_attributes.memory_id */
	readonly memoryIds: Set<string>;
	/** Structural importance score per memory (max importance across aspects) */
	readonly memoryScores: ReadonlyMap<string, number>;
	/** Provenance path per memory (for DP-9 feedback propagation). */
	readonly memoryPaths: ReadonlyMap<string, TraversalPath>;
	/** Constraint content that must always be surfaced */
	readonly constraints: ReadonlyArray<{
		readonly entityName: string;
		readonly content: string;
		readonly importance: number;
	}>;
	/** Entities traversed (for telemetry) */
	readonly entityCount: number;
	/** Whether traversal hit the timeout */
	readonly timedOut: boolean;
	/** Aspect IDs walked during traversal */
	readonly activeAspectIds: ReadonlyArray<string>;
	/** Entity IDs that seeded the walk (needed by context-construction, DP-7) */
	readonly focalEntityIds: ReadonlyArray<string>;
}

export interface TraversalConfig {
	/** Scope filter — when set, only collect attributes from in-scope memories */
	readonly scope?: string | null;
	/** Max aspects per entity, ordered by weight DESC (default 10) */
	readonly maxAspectsPerEntity: number;
	/** Max attributes per aspect (default 20) */
	readonly maxAttributesPerAspect: number;
	/** Max one-hop dependency expansions (default 10) */
	readonly maxDependencyHops: number;
	/** Minimum dependency strength to traverse (default 0.3) */
	readonly minDependencyStrength: number;
	/** Max outgoing edges per entity node (default 4) */
	readonly maxBranching: number;
	/** Total memory ID budget — early exit when reached (default 50) */
	readonly maxTraversalPaths: number;
	/** Minimum edge confidence to traverse (default 0.5) */
	readonly minConfidence: number;
	/** Timeout in ms (default 500) */
	readonly timeoutMs: number;
	/** Filter aspects by canonical_name substring (on-demand expansion) */
	readonly aspectFilter?: string;
}

export interface FocalEntityResult {
	readonly entityIds: string[];
	readonly entityNames: string[];
	readonly pinnedEntityIds: string[];
	readonly source: "project" | "checkpoint" | "query" | "session_key";
}

export interface TraversalStatusSnapshot {
	readonly phase: "session_start" | "recall";
	readonly at: string;
	readonly source: FocalEntityResult["source"] | null;
	readonly focalEntityNames: ReadonlyArray<string>;
	readonly focalEntities: number;
	readonly traversedEntities: number;
	readonly memoryCount: number;
	readonly constraintCount: number;
	readonly timedOut: boolean;
}

let lastTraversalStatus: TraversalStatusSnapshot | null = null;
let traversalTablesAvailableCache: boolean | null = null;

export function setTraversalStatus(snapshot: TraversalStatusSnapshot): void {
	lastTraversalStatus = snapshot;
}

export function getTraversalStatus(): TraversalStatusSnapshot | null {
	return lastTraversalStatus;
}

/**
 * Reset cached traversal state after migrations.
 * Also clears the last status snapshot so callers do not read stale telemetry
 * after traversal tables are recreated or invalidated.
 */
export function invalidateTraversalCache(): void {
	traversalTablesAvailableCache = null;
	lastTraversalStatus = null;
}

function normalizeToken(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "")
		.trim();
}

function sanitizeEntityIds(ids: ReadonlyArray<string>): string[] {
	const unique = new Set<string>();
	for (const id of ids) {
		if (typeof id === "string" && id.length > 0) unique.add(id);
	}
	return [...unique];
}

function getEntityNames(db: ReadDb, ids: ReadonlyArray<string>): string[] {
	const entityIds = sanitizeEntityIds(ids);
	if (entityIds.length === 0) return [];
	const placeholders = entityIds.map(() => "?").join(", ");
	// Keep entities_fts first; broad query tokens can otherwise make
	// SQLite scan all agent entities before applying the FTS rowid match.
	const rows = db
		.prepare(
			`SELECT id, name
			 FROM entities
			 WHERE id IN (${placeholders})`,
		)
		.all(...entityIds) as Array<{ id: string; name: string }>;
	const nameById = new Map(rows.map((row) => [row.id, row.name]));
	return entityIds.flatMap((id) => {
		const name = nameById.get(id);
		return typeof name === "string" && name.length > 0 ? [name] : [];
	});
}

function getPinnedEntityIds(db: ReadDb, agentId: string): string[] {
	const rows = db
		.prepare(
			`SELECT id FROM entities
			 WHERE agent_id = ?
			   AND pinned = 1
			 ORDER BY pinned_at DESC, updated_at DESC`,
		)
		.all(agentId) as Array<{ id: string }>;
	return sanitizeEntityIds(rows.map((row) => row.id));
}

function extractProjectTokens(projectPath: string): string[] {
	const parts = projectPath
		.split(/[\\/]+/)
		.map((part) => normalizeToken(part))
		.filter((part) => part.length >= 2);
	if (parts.length === 0) return [];
	const tail = parts.slice(-2);
	return [...new Set(tail)];
}

function sanitizeQueryTokens(tokens: ReadonlyArray<string>): string[] {
	return [...new Set(tokens.map((token) => normalizeToken(token)).filter((token) => token.length >= 2))];
}

function hasTraversalTables(db: ReadDb): boolean {
	if (traversalTablesAvailableCache !== null) {
		return traversalTablesAvailableCache;
	}

	const rows = db
		.prepare(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table'
			   AND name IN ('entities', 'entity_aspects', 'entity_attributes', 'entity_dependencies')`,
		)
		.all() as Array<{ name: string }>;

	const names = new Set(rows.map((row) => row.name));
	const available =
		names.has("entities") &&
		names.has("entity_aspects") &&
		names.has("entity_attributes") &&
		names.has("entity_dependencies");

	traversalTablesAvailableCache = available;
	return available;
}

function resolveByProject(db: ReadDb, agentId: string, projectPath: string): string[] {
	const tokens = extractProjectTokens(projectPath);
	if (tokens.length === 0) return [];

	const clauses = tokens.map(() => "(canonical_name LIKE ? OR name LIKE ?)").join(" OR ");
	const args: string[] = [];
	for (const token of tokens) {
		const pattern = `%${token}%`;
		args.push(pattern, pattern);
	}

	const rows = db
		.prepare(
			`SELECT id FROM entities
			 WHERE agent_id = ?
			   AND entity_type = 'project'
			   AND (${clauses})
			 ORDER BY mentions DESC
			 LIMIT 5`,
		)
		.all(agentId, ...args) as Array<{ id: string }>;
	return sanitizeEntityIds(rows.map((row) => row.id));
}

function resolveByQueryTokens(db: ReadDb, agentId: string, queryTokens: ReadonlyArray<string>): string[] {
	const tokens = sanitizeQueryTokens(queryTokens);
	if (tokens.length === 0) return [];

	// Try FTS5 first — proper token-boundary matching with BM25 ranking
	try {
		const fts = tokens.join(" OR ");
		const rows = db
			.prepare(
				`SELECT e.id FROM entities_fts
					 CROSS JOIN entities e ON e.rowid = entities_fts.rowid
				 WHERE entities_fts MATCH ?
				   AND e.agent_id = ?
				 ORDER BY rank
				 LIMIT 20`,
			)
			.all(fts, agentId) as Array<{ id: string }>;
		if (rows.length > 0) return sanitizeEntityIds(rows.map((r) => r.id));
	} catch {
		// FTS table doesn't exist — fall through to LIKE
	}

	// LIKE fallback for pre-migration databases
	const clauses = tokens.map(() => "(canonical_name LIKE ? OR name LIKE ?)").join(" OR ");
	const args: string[] = [];
	for (const token of tokens) {
		const pattern = `%${token}%`;
		args.push(pattern, pattern);
	}

	const rows = db
		.prepare(
			`SELECT id FROM entities
			 WHERE agent_id = ?
			   AND (${clauses})
			 ORDER BY mentions DESC
			 LIMIT 20`,
		)
		.all(agentId, ...args) as Array<{ id: string }>;
	return sanitizeEntityIds(rows.map((row) => row.id));
}

export function resolveFocalEntities(
	db: ReadDb,
	agentId: string,
	signals: {
		project?: string;
		sessionKey?: string;
		checkpointEntityIds?: string[];
		queryTokens?: string[];
		includePinned?: boolean;
	},
): FocalEntityResult {
	try {
		if (!hasTraversalTables(db)) {
			return {
				entityIds: [],
				entityNames: [],
				pinnedEntityIds: [],
				source: "query",
			};
		}

		const pinnedEntityIds = signals.includePinned === false ? [] : getPinnedEntityIds(db, agentId);
		let resolvedEntityIds: string[] = [];
		let source: FocalEntityResult["source"] = signals.project ? "project" : "query";

		if (signals.checkpointEntityIds && signals.checkpointEntityIds.length > 0) {
			resolvedEntityIds = sanitizeEntityIds(signals.checkpointEntityIds);
			source = "checkpoint";
		} else if (signals.project) {
			const projectIds = resolveByProject(db, agentId, signals.project);
			if (projectIds.length > 0) {
				resolvedEntityIds = projectIds;
				source = "project";
			}
		}

		if (resolvedEntityIds.length === 0 && signals.queryTokens && signals.queryTokens.length > 0) {
			const queryIds = resolveByQueryTokens(db, agentId, signals.queryTokens);
			if (queryIds.length > 0) {
				resolvedEntityIds = queryIds;
				source = "query";
			}
		}

		if (resolvedEntityIds.length === 0 && signals.sessionKey) {
			source = "session_key";
		}

		const entityIds = sanitizeEntityIds([...pinnedEntityIds, ...resolvedEntityIds]);
		return {
			entityIds,
			entityNames: getEntityNames(db, entityIds),
			pinnedEntityIds,
			source,
		};
	} catch {
		return {
			entityIds: [],
			entityNames: [],
			pinnedEntityIds: [],
			source: "query",
		};
	}
}

// ---------------------------------------------------------------------------
// Shared path helpers (used by both old and batched traversal paths)
// ---------------------------------------------------------------------------

function toPathStatic(
	entityId: string,
	sourceEntityId?: string,
	aspectId?: string,
	dependencyId?: string,
): TraversalPath {
	const eIds =
		typeof sourceEntityId === "string" && sourceEntityId.length > 0 && sourceEntityId !== entityId
			? [sourceEntityId, entityId]
			: [entityId];
	const aIds = typeof aspectId === "string" && aspectId.length > 0 ? [aspectId] : [];
	const dIds = typeof dependencyId === "string" && dependencyId.length > 0 ? [dependencyId] : [];
	return { entityIds: eIds, aspectIds: aIds, dependencyIds: dIds };
}

function pathSize(path: TraversalPath): number {
	return path.entityIds.length + path.aspectIds.length + path.dependencyIds.length;
}

// ---------------------------------------------------------------------------
// Batched traversal
// ---------------------------------------------------------------------------

/**
 * Batch-collect memories, constraints, and paths for a set of entity IDs.
 *
 * Replaces the old per-entity loop (N×4 queries) with 4 batched queries total:
 *   1. constraints for all entities
 *   2. aspects for all entities (grouped per entity for budget)
 *   3. attributes for all aspects
 *   4. mentions for all entities (fallback)
 *
 * Produces identical output to the old collectForEntity loop, but collapses
 * up to 60+ sequential SQLite queries into 4 regardless of entity count.
 */
function batchCollectForEntities(
	db: ReadDb,
	entityIds: ReadonlyArray<string>,
	agentId: string,
	config: TraversalConfig,
	budget: number,
): {
	readonly memoryIds: Set<string>;
	readonly memoryScores: Map<string, number>;
	readonly memoryPaths: Map<string, TraversalPath>;
	readonly constraints: Array<{ readonly entityName: string; readonly content: string; readonly importance: number }>;
	readonly activeAspectIds: Set<string>;
	readonly visitedEntities: Set<string>;
} {
	const memoryIds = new Set<string>();
	const memoryScores = new Map<string, number>();
	const memoryPaths = new Map<string, TraversalPath>();
	const constraints: Array<{
		entityName: string;
		content: string;
		importance: number;
	}> = [];
	const activeAspectIds = new Set<string>();
	const constraintKeys = new Set<string>();
	const visitedEntities = new Set<string>(entityIds);

	const entityPh = entityIds.map(() => "?").join(", ");

	// --- 1. Batch constraints for all entities ---
	const constraintRows = db
		.prepare(
			`SELECT asp.entity_id, e.name as entity_name, ea.content, ea.importance
				 FROM entity_aspects asp INDEXED BY idx_entity_aspects_entity
				 CROSS JOIN entity_attributes ea INDEXED BY idx_entity_attributes_aspect
				   ON ea.aspect_id = asp.id
				 JOIN entities e ON e.id = asp.entity_id
				 WHERE asp.entity_id IN (${entityPh})
				   AND asp.agent_id = ?
				   AND ea.agent_id = ?
				   AND ea.kind = 'constraint'
				   AND ea.status = 'active'
				 ORDER BY ea.importance DESC`,
		)
		.all(...entityIds, agentId, agentId) as Array<{
		entity_id: string;
		entity_name: string;
		content: string;
		importance: number;
	}>;

	for (const row of constraintRows) {
		const key = `${row.entity_name}::${row.content}`;
		if (constraintKeys.has(key)) continue;
		constraintKeys.add(key);
		constraints.push({
			entityName: row.entity_name,
			content: row.content,
			importance: row.importance,
		});
	}

	// --- 2. Batch aspects for all entities ---
	let aspectQuery: string;
	let aspectArgs: unknown[];
	if (config.aspectFilter) {
		aspectQuery = `SELECT id, entity_id FROM entity_aspects INDEXED BY idx_entity_aspects_entity
					 WHERE entity_id IN (${entityPh}) AND agent_id = ?
					   AND canonical_name LIKE ?
					 ORDER BY weight DESC`;
		aspectArgs = [...entityIds, agentId, `%${config.aspectFilter}%`];
	} else {
		aspectQuery = `SELECT id, entity_id FROM entity_aspects INDEXED BY idx_entity_aspects_entity
					 WHERE entity_id IN (${entityPh}) AND agent_id = ?
					 ORDER BY weight DESC`;
		aspectArgs = [...entityIds, agentId];
	}

	const allAspectRows = db.prepare(aspectQuery).all(...aspectArgs) as Array<{
		id: string;
		entity_id: string;
	}>;

	// Apply maxAspectsPerEntity budget by grouping and slicing
	const aspectsByEntity = new Map<string, Array<{ id: string }>>();
	for (const row of allAspectRows) {
		let list = aspectsByEntity.get(row.entity_id);
		if (!list) {
			list = [];
			aspectsByEntity.set(row.entity_id, list);
		}
		if (list.length < config.maxAspectsPerEntity) {
			list.push({ id: row.id });
		}
	}

	// Collect the budgeted aspect IDs
	const budgetedAspectIds: string[] = [];
	const aspectEntityMap = new Map<string, string>();
	for (const [eid, aspects] of aspectsByEntity) {
		for (const a of aspects) {
			budgetedAspectIds.push(a.id);
			aspectEntityMap.set(a.id, eid);
		}
	}

	// --- 3. Batch attributes for all budgeted aspects ---
	if (budgetedAspectIds.length > 0) {
		const aspectPh = budgetedAspectIds.map(() => "?").join(", ");
		let attributeRows: Array<{
			memory_id: string | null;
			importance: number;
			aspect_id: string;
		}>;

		if (config.scope !== undefined) {
			const scopeClause = config.scope === null ? "AND m.scope IS NULL" : "AND m.scope = ?";
			const scopeArgs: unknown[] = config.scope === null ? [] : [config.scope];
			attributeRows = db
				.prepare(
					`SELECT ea.memory_id, ea.importance, ea.aspect_id
						 FROM entity_attributes ea INDEXED BY idx_entity_attributes_aspect
						 JOIN memories m ON m.id = ea.memory_id
						 WHERE ea.aspect_id IN (${aspectPh})
						   AND ea.agent_id = ?
						   AND ea.status = 'active'
						   AND m.is_deleted = 0 ${scopeClause}
						 ORDER BY ea.importance DESC`,
				)
				.all(...budgetedAspectIds, agentId, ...scopeArgs) as Array<{
				memory_id: string | null;
				importance: number;
				aspect_id: string;
			}>;
		} else {
			attributeRows = db
				.prepare(
					`SELECT memory_id, importance, aspect_id FROM entity_attributes INDEXED BY idx_entity_attributes_aspect
						 WHERE aspect_id IN (${aspectPh})
						   AND agent_id = ?
						   AND status = 'active'
						 ORDER BY importance DESC`,
				)
				.all(...budgetedAspectIds, agentId) as Array<{
				memory_id: string | null;
				importance: number;
				aspect_id: string;
			}>;
		}

		// Apply maxAttributesPerAspect budget and collect memories
		const attrCountByAspect = new Map<string, number>();
		for (const row of attributeRows) {
			if (!row.memory_id) continue;
			if (memoryIds.size >= budget) break;
			const count = attrCountByAspect.get(row.aspect_id) ?? 0;
			if (count >= config.maxAttributesPerAspect) continue;
			attrCountByAspect.set(row.aspect_id, count + 1);
			activeAspectIds.add(row.aspect_id);
			memoryIds.add(row.memory_id);
			const entityId = aspectEntityMap.get(row.aspect_id) ?? "";
			const next = toPathStatic(entityId, undefined, row.aspect_id, undefined);
			const prev = memoryPaths.get(row.memory_id);
			if (!prev || pathSize(next) > pathSize(prev)) {
				memoryPaths.set(row.memory_id, next);
			}
			const current = memoryScores.get(row.memory_id);
			if (current === undefined || row.importance > current) {
				memoryScores.set(row.memory_id, row.importance);
			}
		}
	}

	// --- 4. Batch mentions for all entities (fallback) ---
	if (memoryIds.size < budget) {
		const mentionBudget = budget - memoryIds.size;
		let mentionRows: Array<{ memory_id: string; importance: number; entity_id: string }>;
		if (config.scope !== undefined) {
			const scopeClause = config.scope === null ? "AND m.scope IS NULL" : "AND m.scope = ?";
			const scopeArgs: unknown[] = config.scope === null ? [] : [config.scope];
			mentionRows = db
				.prepare(
					`SELECT mem.memory_id, COALESCE(m.importance, 0.5) AS importance, mem.entity_id
						 FROM memory_entity_mentions mem
						 JOIN memories m ON m.id = mem.memory_id
						 WHERE mem.entity_id IN (${entityPh})
						   AND m.is_deleted = 0 ${scopeClause}
						 ORDER BY mem.confidence DESC, m.importance DESC
						 LIMIT ?`,
				)
				.all(...entityIds, ...scopeArgs, mentionBudget) as Array<{
				memory_id: string;
				importance: number;
				entity_id: string;
			}>;
		} else {
			mentionRows = db
				.prepare(
					`SELECT mem.memory_id, COALESCE(m.importance, 0.5) AS importance, mem.entity_id
						 FROM memory_entity_mentions mem
						 JOIN memories m ON m.id = mem.memory_id
						 WHERE mem.entity_id IN (${entityPh})
						   AND m.is_deleted = 0
						 ORDER BY mem.confidence DESC, m.importance DESC
						 LIMIT ?`,
				)
				.all(...entityIds, mentionBudget) as Array<{
				memory_id: string;
				importance: number;
				entity_id: string;
			}>;
		}

		for (const row of mentionRows) {
			if (memoryIds.size >= budget) break;
			memoryIds.add(row.memory_id);
			const next = toPathStatic(row.entity_id, undefined, undefined, undefined);
			const prev = memoryPaths.get(row.memory_id);
			if (!prev || pathSize(next) > pathSize(prev)) {
				memoryPaths.set(row.memory_id, next);
			}
			const current = memoryScores.get(row.memory_id);
			if (current === undefined || row.importance > current) {
				memoryScores.set(row.memory_id, row.importance);
			}
		}
	}

	return { memoryIds, memoryScores, memoryPaths, constraints, activeAspectIds, visitedEntities };
}

export function traverseKnowledgeGraph(
	focalEntityIds: ReadonlyArray<string>,
	db: ReadDb,
	agentId: string,
	config: TraversalConfig,
): TraversalResult {
	const empty: TraversalResult = {
		memoryIds: new Set<string>(),
		memoryScores: new Map<string, number>(),
		memoryPaths: new Map<string, TraversalPath>(),
		constraints: [],
		entityCount: 0,
		timedOut: false,
		activeAspectIds: [],
		focalEntityIds: [],
	};

	try {
		if (!hasTraversalTables(db)) return empty;

		const focalIds = sanitizeEntityIds(focalEntityIds);
		if (focalIds.length === 0) return empty;

		const deadline = Date.now() + config.timeoutMs;
		const budget = config.maxTraversalPaths;

		// --- Phase 1: Batch-collect for focal entities ---
		const phase1 = batchCollectForEntities(db, focalIds, agentId, config, budget);
		let timedOut = Date.now() > deadline;

		// --- Phase 2: Dependency expansion + batch collect for hops ---
		if (!timedOut && phase1.memoryIds.size < budget) {
			const focalPh = focalIds.map(() => "?").join(", ");
			const dependencyRows = db
				.prepare(
					`SELECT id, source_entity_id, target_entity_id FROM entity_dependencies
						 INDEXED BY idx_entity_dependencies_source
						 WHERE agent_id = ?
						   AND source_entity_id IN (${focalPh})
						   AND (COALESCE(confidence, 0.7) * strength) >= ?
						   AND COALESCE(confidence, 0.7) >= ?
						 ORDER BY (COALESCE(confidence, 0.7) * strength) DESC
						 LIMIT ?`,
				)
				.all(
					agentId,
					...focalIds,
					config.minDependencyStrength,
					config.minConfidence,
					config.maxBranching * focalIds.length,
				) as Array<{ id: string; source_entity_id: string; target_entity_id: string }>;

			// Filter to hop targets not already visited
			const hopTargetIds = dependencyRows
				.map((r) => r.target_entity_id)
				.filter((id) => !phase1.visitedEntities.has(id));

			if (hopTargetIds.length > 0) {
				const remainingBudget = budget - phase1.memoryIds.size;
				const phase2 = batchCollectForEntities(db, hopTargetIds, agentId, config, remainingBudget);

				// Merge phase2 results into phase1
				for (const mid of phase2.memoryIds) {
					if (phase1.memoryIds.size >= budget) break;
					phase1.memoryIds.add(mid);
				}
				for (const [mid, score] of phase2.memoryScores) {
					const current = phase1.memoryScores.get(mid);
					if (current === undefined || score > current) {
						phase1.memoryScores.set(mid, score);
					}
				}
				for (const [mid, path] of phase2.memoryPaths) {
					const prev = phase1.memoryPaths.get(mid);
					if (!prev || pathSize(path) > pathSize(prev)) {
						phase1.memoryPaths.set(mid, path);
					}
				}
				// Rebuild paths for hop entities with source/dependency provenance
				const sourceByTarget = new Map<string, { sourceEntityId: string; dependencyId: string }>();
				for (const dep of dependencyRows) {
					sourceByTarget.set(dep.target_entity_id, {
						sourceEntityId: dep.source_entity_id,
						dependencyId: dep.id,
					});
				}
				for (const [mid, existingPath] of phase1.memoryPaths) {
					// If this memory came from a hop entity and doesn't already have source info, upgrade it
					for (const hopId of hopTargetIds) {
						const source = sourceByTarget.get(hopId);
						if (!source) continue;
						// Check if the memory path involves this hop entity
						if (existingPath.entityIds.includes(hopId) && !existingPath.dependencyIds.length) {
							const upgraded = toPathStatic(hopId, source.sourceEntityId, existingPath.aspectIds[0], source.dependencyId);
							if (pathSize(upgraded) > pathSize(existingPath)) {
								phase1.memoryPaths.set(mid, upgraded);
							}
						}
					}
				}
				phase1.constraints.push(...phase2.constraints);
				// Deduplicate across phase1/phase2 boundary (in-place to respect readonly)
				const seen = new Set<string>();
				let write = 0;
				for (let read = 0; read < phase1.constraints.length; read++) {
					const c = phase1.constraints[read]!;
					const key = `${c.entityName}::${c.content}`;
					if (!seen.has(key)) {
						seen.add(key);
						phase1.constraints[write++] = c;
					}
				}
				phase1.constraints.length = write;
				for (const aid of phase2.activeAspectIds) {
					phase1.activeAspectIds.add(aid);
				}
				for (const eid of phase2.visitedEntities) {
					phase1.visitedEntities.add(eid);
				}
			}

			timedOut = timedOut || Date.now() > deadline;
		}

		phase1.constraints.sort((a, b) => b.importance - a.importance);

		return {
			memoryIds: phase1.memoryIds,
			memoryScores: phase1.memoryScores,
			memoryPaths: phase1.memoryPaths,
			constraints: phase1.constraints,
			entityCount: phase1.visitedEntities.size,
			timedOut,
			activeAspectIds: [...phase1.activeAspectIds],
			focalEntityIds: focalIds,
		};
	} catch {
		return empty;
	}
}
