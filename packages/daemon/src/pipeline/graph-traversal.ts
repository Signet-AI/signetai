import type { ReadDb } from "../db-accessor";

export interface TraversalResult {
	/** Memory IDs collected from entity_attributes.memory_id */
	readonly memoryIds: Set<string>;
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
}

export interface TraversalConfig {
	/** Max aspects per entity, ordered by weight DESC (default 10) */
	readonly maxAspectsPerEntity: number;
	/** Max attributes per aspect (default 20) */
	readonly maxAttributesPerAspect: number;
	/** Max one-hop dependency expansions (default 30) */
	readonly maxDependencyHops: number;
	/** Minimum dependency strength to traverse (default 0.3) */
	readonly minDependencyStrength: number;
	/** Timeout in ms (default 500) */
	readonly timeoutMs: number;
}

export interface FocalEntityResult {
	readonly entityIds: string[];
	readonly entityNames: string[];
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

function normalizeToken(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9_-]/g, "").trim();
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

function resolveByProject(
	db: ReadDb,
	agentId: string,
	projectPath: string,
): string[] {
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

function resolveByQueryTokens(
	db: ReadDb,
	agentId: string,
	queryTokens: ReadonlyArray<string>,
): string[] {
	const tokens = sanitizeQueryTokens(queryTokens);
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
	},
): FocalEntityResult {
	try {
		if (!hasTraversalTables(db)) {
			return { entityIds: [], entityNames: [], source: "query" };
		}

		if (signals.checkpointEntityIds && signals.checkpointEntityIds.length > 0) {
			const entityIds = sanitizeEntityIds(signals.checkpointEntityIds);
			return {
				entityIds,
				entityNames: getEntityNames(db, entityIds),
				source: "checkpoint",
			};
		}

		if (signals.project) {
			const projectIds = resolveByProject(db, agentId, signals.project);
			if (projectIds.length > 0) {
				return {
					entityIds: projectIds,
					entityNames: getEntityNames(db, projectIds),
					source: "project",
				};
			}
		}

		if (signals.queryTokens && signals.queryTokens.length > 0) {
			const queryIds = resolveByQueryTokens(db, agentId, signals.queryTokens);
			if (queryIds.length > 0) {
				return {
					entityIds: queryIds,
					entityNames: getEntityNames(db, queryIds),
					source: "query",
				};
			}
		}

		if (signals.sessionKey) {
			return { entityIds: [], entityNames: [], source: "session_key" };
		}

		return {
			entityIds: [],
			entityNames: [],
			source: signals.project ? "project" : "query",
		};
	} catch {
		return { entityIds: [], entityNames: [], source: "query" };
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
		constraints: [],
		entityCount: 0,
		timedOut: false,
		activeAspectIds: [],
	};

	try {
		if (!hasTraversalTables(db)) return empty;

		const focalIds = sanitizeEntityIds(focalEntityIds);
		if (focalIds.length === 0) return empty;

		const memoryIds = new Set<string>();
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

		const collectForEntity = (entityId: string): void => {
			if (timedOut || visitedEntities.has(entityId)) return;
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

			const aspectRows = db
				.prepare(
					`SELECT id FROM entity_aspects
					 WHERE entity_id = ? AND agent_id = ?
					 ORDER BY weight DESC
					 LIMIT ?`,
				)
				.all(entityId, agentId, config.maxAspectsPerEntity) as Array<{ id: string }>;

			for (const aspect of aspectRows) {
				if (checkDeadline()) break;
				activeAspectIds.add(aspect.id);
				const attributeRows = db
					.prepare(
						`SELECT memory_id FROM entity_attributes
						 WHERE aspect_id = ?
						   AND agent_id = ?
						   AND status = 'active'
						 ORDER BY importance DESC
						 LIMIT ?`,
					)
					.all(
						aspect.id,
						agentId,
						config.maxAttributesPerAspect,
					) as Array<{ memory_id: string | null }>;

				for (const row of attributeRows) {
					if (!row.memory_id) continue;
					memoryIds.add(row.memory_id);
				}
			}
		};

		for (const entityId of focalIds) {
			if (checkDeadline()) break;
			collectForEntity(entityId);
		}

		if (!timedOut) {
			const dependencyPlaceholders = focalIds.map(() => "?").join(", ");
			const dependencyRows = db
				.prepare(
					`SELECT target_entity_id FROM entity_dependencies
					 WHERE agent_id = ?
					   AND source_entity_id IN (${dependencyPlaceholders})
					   AND strength >= ?
					 ORDER BY strength DESC
					 LIMIT ?`,
				)
				.all(
					agentId,
					...focalIds,
					config.minDependencyStrength,
					config.maxDependencyHops,
				) as Array<{ target_entity_id: string }>;

			for (const row of dependencyRows) {
				if (checkDeadline()) break;
				collectForEntity(row.target_entity_id);
			}
		}

		constraints.sort((a, b) => b.importance - a.importance);

		return {
			memoryIds,
			constraints,
			entityCount: visitedEntities.size,
			timedOut,
			activeAspectIds: [...activeAspectIds],
		};
	} catch {
		return empty;
	}
}
