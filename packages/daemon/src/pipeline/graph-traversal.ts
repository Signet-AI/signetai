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
				 JOIN entities e ON e.rowid = entities_fts.rowid
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
		const visitedEntities = new Set<string>();
		const deadline = Date.now() + config.timeoutMs;
		let timedOut = false;

		const checkDeadline = (): boolean => {
			if (Date.now() > deadline) {
				timedOut = true;
				return true;
			}
			return false;
		};

		const budget = config.maxTraversalPaths;

		const toPath = (
			entityId: string,
			sourceEntityId?: string,
			aspectId?: string,
			dependencyId?: string,
		): TraversalPath => {
			const entityIds =
				typeof sourceEntityId === "string" && sourceEntityId.length > 0 && sourceEntityId !== entityId
					? [sourceEntityId, entityId]
					: [entityId];
			const aspectIds = typeof aspectId === "string" && aspectId.length > 0 ? [aspectId] : [];
			const dependencyIds = typeof dependencyId === "string" && dependencyId.length > 0 ? [dependencyId] : [];
			return { entityIds, aspectIds, dependencyIds };
		};

		const pathSize = (path: TraversalPath): number =>
			path.entityIds.length + path.aspectIds.length + path.dependencyIds.length;

		const recordPath = (
			memoryId: string,
			entityId: string,
			sourceEntityId?: string,
			aspectId?: string,
			dependencyId?: string,
		): void => {
			const next = toPath(entityId, sourceEntityId, aspectId, dependencyId);
			const prev = memoryPaths.get(memoryId);
			if (!prev || pathSize(next) > pathSize(prev)) {
				memoryPaths.set(memoryId, next);
			}
		};

		const collectForEntity = (entityId: string, sourceEntityId?: string, dependencyId?: string): void => {
			if (timedOut || visitedEntities.has(entityId)) return;
			if (memoryIds.size >= budget) return;
			visitedEntities.add(entityId);

			if (checkDeadline()) return;

			const constraintRows = db
				.prepare(
					`SELECT e.name as entity_name, ea.content, ea.importance
					 FROM entity_attributes ea
					 JOIN entity_aspects asp ON asp.id = ea.aspect_id
					 JOIN entities e ON e.id = asp.entity_id
					 WHERE asp.entity_id = ?
					   AND asp.agent_id = ?
					   AND ea.agent_id = ?
					   AND ea.kind = 'constraint'
					   AND ea.status = 'active'
					 ORDER BY ea.importance DESC`,
				)
				.all(entityId, agentId, agentId) as Array<{
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

			if (checkDeadline()) return;

			// Apply optional aspect name filter for on-demand expansion
			const aspectQuery = config.aspectFilter
				? `SELECT id FROM entity_aspects
					 WHERE entity_id = ? AND agent_id = ?
					   AND canonical_name LIKE ?
					 ORDER BY weight DESC
					 LIMIT ?`
				: `SELECT id FROM entity_aspects
					 WHERE entity_id = ? AND agent_id = ?
					 ORDER BY weight DESC
					 LIMIT ?`;

			const aspectArgs = config.aspectFilter
				? [entityId, agentId, `%${config.aspectFilter}%`, config.maxAspectsPerEntity]
				: [entityId, agentId, config.maxAspectsPerEntity];

			const aspectRows = db.prepare(aspectQuery).all(...aspectArgs) as Array<{ id: string }>;

			for (const aspect of aspectRows) {
				if (checkDeadline() || memoryIds.size >= budget) break;
				activeAspectIds.add(aspect.id);
				let attributeRows: Array<{ memory_id: string | null; importance: number }>;

				if (config.scope !== undefined) {
					const scopeClause = config.scope === null ? "AND m.scope IS NULL" : "AND m.scope = ?";
					const scopeArgs: unknown[] = config.scope === null ? [] : [config.scope];
					attributeRows = db
						.prepare(
							`SELECT ea.memory_id, ea.importance FROM entity_attributes ea
							 JOIN memories m ON m.id = ea.memory_id
							 WHERE ea.aspect_id = ?
							   AND ea.agent_id = ?
							   AND ea.status = 'active'
							   AND m.is_deleted = 0 ${scopeClause}
							 ORDER BY ea.importance DESC
							 LIMIT ?`,
						)
						.all(aspect.id, agentId, ...scopeArgs, config.maxAttributesPerAspect) as Array<{
						memory_id: string | null;
						importance: number;
					}>;
				} else {
					attributeRows = db
						.prepare(
							`SELECT memory_id, importance FROM entity_attributes
							 WHERE aspect_id = ?
							   AND agent_id = ?
							   AND status = 'active'
							 ORDER BY importance DESC
							 LIMIT ?`,
						)
						.all(aspect.id, agentId, config.maxAttributesPerAspect) as Array<{
						memory_id: string | null;
						importance: number;
					}>;
				}

				for (const row of attributeRows) {
					if (!row.memory_id) continue;
					memoryIds.add(row.memory_id);
					recordPath(row.memory_id, entityId, sourceEntityId, aspect.id, dependencyId);
					const current = memoryScores.get(row.memory_id);
					if (current === undefined || row.importance > current) {
						memoryScores.set(row.memory_id, row.importance);
					}
				}
			}

			// Fallback: when entity_attributes yielded no memories for this
			// entity (e.g. inline-linked memories without full pipeline
			// extraction), collect via memory_entity_mentions instead.
			if (checkDeadline() || memoryIds.size >= budget) return;
			const mentionBudget = Math.min(config.maxAttributesPerAspect, budget - memoryIds.size);
			if (mentionBudget <= 0) return;

			let mentionRows: Array<{ memory_id: string; importance: number }>;
			if (config.scope !== undefined) {
				const scopeClause = config.scope === null ? "AND m.scope IS NULL" : "AND m.scope = ?";
				const scopeArgs: unknown[] = config.scope === null ? [] : [config.scope];
				mentionRows = db
					.prepare(
						`SELECT mem.memory_id, COALESCE(m.importance, 0.5) AS importance
						 FROM memory_entity_mentions mem
						 JOIN memories m ON m.id = mem.memory_id
						 WHERE mem.entity_id = ?
						   AND m.is_deleted = 0 ${scopeClause}
						 ORDER BY mem.confidence DESC, m.importance DESC
						 LIMIT ?`,
					)
					.all(entityId, ...scopeArgs, mentionBudget) as Array<{ memory_id: string; importance: number }>;
			} else {
				mentionRows = db
					.prepare(
						`SELECT mem.memory_id, COALESCE(m.importance, 0.5) AS importance
						 FROM memory_entity_mentions mem
						 JOIN memories m ON m.id = mem.memory_id
						 WHERE mem.entity_id = ?
						   AND m.is_deleted = 0
						 ORDER BY mem.confidence DESC, m.importance DESC
						 LIMIT ?`,
					)
					.all(entityId, mentionBudget) as Array<{ memory_id: string; importance: number }>;
			}

			for (const row of mentionRows) {
				memoryIds.add(row.memory_id);
				recordPath(row.memory_id, entityId, sourceEntityId, undefined, dependencyId);
				const current = memoryScores.get(row.memory_id);
				if (current === undefined || row.importance > current) {
					memoryScores.set(row.memory_id, row.importance);
				}
			}
		};

		for (const entityId of focalIds) {
			if (checkDeadline() || memoryIds.size >= budget) break;
			collectForEntity(entityId);
		}

		if (!timedOut && memoryIds.size < budget) {
			const dependencyPlaceholders = focalIds.map(() => "?").join(", ");
			const dependencyRows = db
				.prepare(
					`SELECT id, source_entity_id, target_entity_id FROM entity_dependencies
					 WHERE agent_id = ?
					   AND source_entity_id IN (${dependencyPlaceholders})
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

			for (const row of dependencyRows) {
				if (checkDeadline() || memoryIds.size >= budget) break;
				collectForEntity(row.target_entity_id, row.source_entity_id, row.id);
			}
		}

		constraints.sort((a, b) => b.importance - a.importance);

		return {
			memoryIds,
			memoryScores,
			memoryPaths,
			constraints,
			entityCount: visitedEntities.size,
			timedOut,
			activeAspectIds: [...activeAspectIds],
			focalEntityIds: focalIds,
		};
	} catch {
		return empty;
	}
}
