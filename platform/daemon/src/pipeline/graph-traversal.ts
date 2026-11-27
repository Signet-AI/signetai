import { selectShardTables } from "@signet/core";
import { yieldEvery } from "../async-yield";
import type { DbOwnerClient } from "../db-owner-client";
import { ownerReadAll } from "../db-owner-sql";
import { cachedRecallShardNames } from "../recall-shard-catalogue";
import { type ReadScope, readScopeSql } from "../read-scope";
export interface TraversalReadDb {
	prepare(sql: string): { all(...args: unknown[]): unknown[] };
}

const ROW_YIELD_BATCH = 500;

export interface ScopeSql {
	readonly sql: string;
	readonly args: readonly unknown[];
}

const LIKE_CANDIDATE_ROWS = 200;

function isReadScope(value: unknown): value is ReadScope {
	return (
		typeof value === "object" &&
		value !== null &&
		"reach" in value &&
		typeof value.reach === "object" &&
		value.reach !== null &&
		"compartments" in value &&
		"projects" in value
	);
}

export function requireReadScope(value: unknown): ReadScope {
	if (!isReadScope(value)) throw new Error("readScope is required");
	return value;
}

export function usesGlobalMentionCounter(scope: ReadScope): boolean {
	return (
		scope.reach.kind === "all" &&
		scope.compartments === "all" &&
		scope.projects === null &&
		scope.inFlightUserId === undefined
	);
}

export function readableMentionCountSql(entityAlias: "e" | "c", scope: ReadScope): ScopeSql {
	const memory = readScopeSql("rm_m", scope);
	return {
		sql: `(SELECT COUNT(*) FROM memory_entity_mentions rm
			 CROSS JOIN memories rm_m ON rm_m.id = rm.memory_id
			 WHERE rm.entity_id = ${entityAlias}.id AND rm_m.is_deleted = 0${memory.sql})`,
		args: memory.args,
	};
}

export function rankedEntityCandidatesSql(
	match: ScopeSql,
	entity: ScopeSql,
	scope: ReadScope,
	limit: number,
): ScopeSql {
	if (usesGlobalMentionCounter(scope)) {
		return {
			sql: `SELECT e.id FROM entities e
				 WHERE ${match.sql}${entity.sql}
				 ORDER BY e.mentions DESC, e.id
				 LIMIT ${limit}`,
			args: [...match.args, ...entity.args],
		};
	}
	const rank = readableMentionCountSql("c", scope);
	return {
		sql: `WITH c AS (
				 SELECT e.id FROM entities e
				 WHERE ${match.sql}${entity.sql}
				 ORDER BY e.id
				 LIMIT ${LIKE_CANDIDATE_ROWS}
				)
				SELECT c.id FROM c
				 ORDER BY ${rank.sql} DESC, c.id
				 LIMIT ${limit}`,
		args: [...match.args, ...entity.args, ...rank.args],
	};
}

export function derivedReadScopeSql(
	alias: string,
	scope: ReadScope,
	cols: {
		readonly project?: string;
		readonly memory?: string;
		readonly session?: string;
		readonly source?: string;
		readonly group?: "keep" | "own";
	} = {},
): ScopeSql {
	const reach = scope.reach;
	const narrowed =
		reach.kind === "shared" || (reach.kind === "group" && cols.group !== "keep")
			? { kind: "own" as const, agentId: reach.agentId }
			: reach;
	const projectless = cols.project === undefined && scope.projects !== null;
	const result = readScopeSql(
		alias,
		{ ...scope, reach: narrowed, projects: projectless ? null : scope.projects },
		{
			visibility: null,
			project: cols.project,
			memory: cols.memory ?? null,
			session: cols.session ?? null,
			source: cols.source ?? null,
		},
	);
	return projectless ? { sql: `${result.sql} AND 0`, args: result.args } : result;
}

export function memoryReadScopeSql(alias: string, scope: ReadScope): ScopeSql {
	return readScopeSql(alias, requireReadScope(scope));
}

export function entityFtsTablesFromNames(names: readonly string[], scope: ReadScope): string[] {
	return selectShardTables(
		names.filter((name) => name === "entities_fts" || name.startsWith("entities_fts__c")),
		scope.compartments,
	);
}

export function entityFtsTablesFromDb(db: TraversalReadDb, scope: ReadScope): string[] {
	if (scope.compartments !== "all" && scope.compartments.length === 0) return ["entities_fts"];
	const rows = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND (name = 'entities_fts' OR name GLOB 'entities_fts__c[0-9]*')",
		)
		.all();
	return entityFtsTablesFromNames(
		rows.flatMap((row) =>
			typeof row === "object" && row !== null && "name" in row && typeof row.name === "string" ? [row.name] : [],
		),
		scope,
	);
}

function ftsRows(rows: ReadonlyArray<unknown>): Array<{ readonly id: string; readonly raw: number }> {
	return rows.flatMap((row) =>
		typeof row === "object" &&
		row !== null &&
		"id" in row &&
		"raw" in row &&
		typeof row.id === "string" &&
		typeof row.raw === "number"
			? [{ id: row.id, raw: row.raw }]
			: [],
	);
}

export function mergeEntityFtsRows(rows: ReadonlyArray<unknown>, limit: number): string[] {
	return ftsRows(rows)
		.sort((a, b) => a.raw - b.raw || a.id.localeCompare(b.id))
		.slice(0, limit)
		.map((row) => row.id);
}

export interface TraversalPath {
	readonly entityIds: ReadonlyArray<string>;
	readonly aspectIds: ReadonlyArray<string>;
	readonly dependencyIds: ReadonlyArray<string>;
}

export interface TraversalResult {
	readonly memoryIds: Set<string>;
	readonly memoryScores: ReadonlyMap<string, number>;
	readonly memoryPaths: ReadonlyMap<string, TraversalPath>;
	readonly constraints: ReadonlyArray<{
		readonly entityName: string;
		readonly content: string;
		readonly importance: number;
	}>;
	readonly entityCount: number;
	readonly timedOut: boolean;
	readonly activeAspectIds: ReadonlyArray<string>;
	readonly focalEntityIds: ReadonlyArray<string>;
	readonly error?: TraversalError;
}

export interface TraversalError {
	readonly code: string | number | null;
	readonly message: string;
}

export interface TraversalConfig {
	readonly scope?: string | null;
	readonly maxAspectsPerEntity: number;
	readonly maxAttributesPerAspect: number;
	readonly maxDependencyHops: number;
	readonly minDependencyStrength: number;
	readonly maxBranching: number;
	readonly maxTraversalPaths: number;
	readonly minConfidence: number;
	readonly timeoutMs: number;
	readonly deadlineAt?: number;
	readonly aspectFilter?: string;
	readonly readScope: ReadScope;
}
type ReadDbSource =
	| TraversalReadDb
	| (<T>(fn: (db: TraversalReadDb) => T) => T)
	| (<T>(fn: (db: TraversalReadDb) => T) => Promise<T>);
type ReadAll = <Row extends object>(
	sql: string,
	params: readonly unknown[],
	operation: string,
	estimatedWorkUnits: number,
	deadlineAt?: number,
) => Promise<ReadonlyArray<Row>>;

async function withReadDbAsync<T>(source: ReadDbSource, fn: (db: TraversalReadDb) => T): Promise<T> {
	if (typeof source !== "function") return fn(source);
	return await source(fn);
}

function readAllFromSource(source: ReadDbSource): ReadAll {
	return async <Row extends object>(
		sql: string,
		params: readonly unknown[],
		_operation: string,
		_estimatedWorkUnits: number,
		_deadlineAt?: number,
	): Promise<ReadonlyArray<Row>> =>
		await withReadDbAsync(source, (db) => db.prepare(sql).all(...params) as ReadonlyArray<Row>);
}

function readAllFromOwner(owner: DbOwnerClient): ReadAll {
	return async <Row extends object>(
		sql: string,
		params: readonly unknown[],
		operation: string,
		estimatedWorkUnits: number,
		deadlineAt?: number,
	): Promise<ReadonlyArray<Row>> => {
		const deadlineMs = deadlineAt === undefined ? 5_000 : Math.max(1, deadlineAt - Date.now());
		return await ownerReadAll<Row>(owner, sql, params, {
			operation,
			lane: "read",
			workloadClass: "foreground",
			deadlineMs,
			estimatedWorkUnits: Math.max(1, Math.min(1_200, estimatedWorkUnits)),
		});
	};
}

export interface FocalEntityResult {
	readonly entityIds: string[];
	readonly entityNames: string[];
	readonly pinnedEntityIds: string[];
	readonly source: "project" | "checkpoint" | "query" | "session_key";
	readonly error?: TraversalError;
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

function traversalErrorCode(error: unknown): string | number | null {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(typeof error.code === "string" || typeof error.code === "number")
		? error.code
		: null;
}

function isTraversalDeadlineError(error: unknown): boolean {
	const code = traversalErrorCode(error);
	return code === "DB_OWNER_DEADLINE" || code === "DB_OWNER_CANCELLED";
}

function describeTraversalError(error: unknown): TraversalError {
	return {
		code: traversalErrorCode(error),
		message: error instanceof Error ? error.message : String(error),
	};
}
let traversalTablesAvailableCache: boolean | null = null;

export function setTraversalStatus(snapshot: TraversalStatusSnapshot): void {
	lastTraversalStatus = snapshot;
}

export function getTraversalStatus(): TraversalStatusSnapshot | null {
	return lastTraversalStatus;
}
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

function entityReadScope(scope: ReadScope, alias = "e"): ScopeSql {
	return derivedReadScopeSql(alias, scope, { source: "source_id" });
}

function focalNames(
	entityIds: ReadonlyArray<string>,
	rows: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): { readonly entityIds: string[]; readonly entityNames: string[] } {
	const nameById = new Map(rows.map((row) => [row.id, row.name]));
	const ids = entityIds.filter((id) => nameById.has(id));
	return {
		entityIds: ids,
		entityNames: ids.flatMap((id) => {
			const name = nameById.get(id);
			return typeof name === "string" && name.length > 0 ? [name] : [];
		}),
	};
}

function getEntityNames(
	db: TraversalReadDb,
	ids: ReadonlyArray<string>,
	entity: ScopeSql,
): ReadonlyArray<{ readonly id: string; readonly name: string }> {
	const entityIds = sanitizeEntityIds(ids);
	if (entityIds.length === 0) return [];
	const placeholders = entityIds.map(() => "?").join(", ");
	return db
		.prepare(
			`SELECT e.id, e.name
			 FROM entities e
			 WHERE e.id IN (${placeholders})${entity.sql}`,
		)
		.all(...entityIds, ...entity.args) as Array<{ id: string; name: string }>;
}

function getPinnedEntityIds(db: TraversalReadDb, entity: ScopeSql): string[] {
	const rows = db
		.prepare(
			`SELECT e.id FROM entities e
			 WHERE e.pinned = 1${entity.sql}
			 ORDER BY e.pinned_at DESC, e.updated_at DESC, e.id`,
		)
		.all(...entity.args) as Array<{ id: string }>;
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

function hasTraversalTables(db: TraversalReadDb): boolean {
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

function entityLikeStatement(
	tokens: ReadonlyArray<string>,
	entity: ScopeSql,
	scope: ReadScope,
	project: boolean,
): {
	readonly sql: string;
	readonly params: readonly unknown[];
} {
	const clauses = tokens.map(() => "(e.canonical_name LIKE ? OR e.name LIKE ?)").join(" OR ");
	const args: string[] = [];
	for (const token of tokens) {
		const pattern = `%${token}%`;
		args.push(pattern, pattern);
	}
	const statement = rankedEntityCandidatesSql(
		{ sql: `(${clauses})${project ? " AND e.entity_type = 'project'" : ""}`, args },
		entity,
		scope,
		project ? 5 : 20,
	);
	return { sql: statement.sql, params: statement.args };
}

function entityFtsStatement(table: string, entity: ScopeSql): string {
	return `SELECT e.id, bm25(${table}) AS raw FROM ${table}
			 CROSS JOIN entities e ON e.rowid = ${table}.rowid
			 WHERE ${table} MATCH ?${entity.sql}
			 ORDER BY raw, e.id
			 LIMIT 20`;
}

function resolveByProject(db: TraversalReadDb, scope: ReadScope, entity: ScopeSql, projectPath: string): string[] {
	const tokens = extractProjectTokens(projectPath);
	if (tokens.length === 0) return [];
	const query = entityLikeStatement(tokens, entity, scope, true);
	const rows = db.prepare(query.sql).all(...query.params) as Array<{ id: string }>;
	return sanitizeEntityIds(rows.map((row) => row.id));
}

function resolveByQueryTokens(
	db: TraversalReadDb,
	scope: ReadScope,
	entity: ScopeSql,
	queryTokens: ReadonlyArray<string>,
): string[] {
	const tokens = sanitizeQueryTokens(queryTokens);
	if (tokens.length === 0) return [];
	try {
		const fts = tokens.join(" OR ");
		const rows = entityFtsTablesFromDb(db, scope).flatMap((table) =>
			db.prepare(entityFtsStatement(table, entity)).all(fts, ...entity.args),
		);
		const ids = mergeEntityFtsRows(rows, 20);
		if (ids.length > 0) return sanitizeEntityIds(ids);
	} catch {}

	const query = entityLikeStatement(tokens, entity, scope, false);
	const rows = db.prepare(query.sql).all(...query.params) as Array<{ id: string }>;
	return sanitizeEntityIds(rows.map((row) => row.id));
}

export function resolveFocalEntities(
	db: TraversalReadDb,
	_agentId: string,
	signals: {
		project?: string;
		sessionKey?: string;
		checkpointEntityIds?: string[];
		queryTokens?: string[];
		includePinned?: boolean;
		readScope: ReadScope;
	},
): FocalEntityResult {
	try {
		const scope = requireReadScope(signals.readScope);
		const entity = entityReadScope(scope);
		if (!hasTraversalTables(db)) {
			return {
				entityIds: [],
				entityNames: [],
				pinnedEntityIds: [],
				source: "query",
			};
		}

		const pinnedEntityIds = signals.includePinned === false ? [] : getPinnedEntityIds(db, entity);
		let resolvedEntityIds: string[] = [];
		let source: FocalEntityResult["source"] = signals.project ? "project" : "query";

		if (signals.checkpointEntityIds && signals.checkpointEntityIds.length > 0) {
			resolvedEntityIds = sanitizeEntityIds(signals.checkpointEntityIds);
			source = "checkpoint";
		} else if (signals.project) {
			const projectIds = resolveByProject(db, scope, entity, signals.project);
			if (projectIds.length > 0) {
				resolvedEntityIds = projectIds;
				source = "project";
			}
		}

		if (resolvedEntityIds.length === 0 && signals.queryTokens && signals.queryTokens.length > 0) {
			const queryIds = resolveByQueryTokens(db, scope, entity, signals.queryTokens);
			if (queryIds.length > 0) {
				resolvedEntityIds = queryIds;
				source = "query";
			}
		}

		if (resolvedEntityIds.length === 0 && signals.sessionKey) {
			source = "session_key";
		}

		const candidates = sanitizeEntityIds([...pinnedEntityIds, ...resolvedEntityIds]).slice(0, 200);
		return {
			...focalNames(candidates, getEntityNames(db, candidates, entity)),
			pinnedEntityIds,
			source,
		};
	} catch (error) {
		return {
			entityIds: [],
			entityNames: [],
			pinnedEntityIds: [],
			source: "query",
			error: describeTraversalError(error),
		};
	}
}
export async function resolveFocalEntitiesViaOwner(
	owner: DbOwnerClient,
	_agentId: string,
	signals: {
		project?: string;
		sessionKey?: string;
		checkpointEntityIds?: string[];
		queryTokens?: string[];
		includePinned?: boolean;
		deadlineAt?: number;
		readScope: ReadScope;
	},
): Promise<FocalEntityResult> {
	const readAll = readAllFromOwner(owner);
	try {
		const scope = requireReadScope(signals.readScope);
		const entity = entityReadScope(scope);
		const names =
			scope.compartments !== "all" && scope.compartments.length === 0
				? (
						await readAll<{ readonly name: string }>(
							"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('entities','entity_aspects','entity_attributes','entity_dependencies','entities_fts')",
							[],
							"session-start.graph-focal.table-check",
							5,
							signals.deadlineAt,
						)
					).map((row) => row.name)
				: await cachedRecallShardNames(async () =>
						(
							await readAll<{ readonly name: string }>(
								"SELECT name FROM sqlite_master WHERE type='table'",
								[],
								"session-start.graph-focal.table-check",
								5,
								signals.deadlineAt,
							)
						).map((row) => row.name),
					);
		const tableNames = new Set(names);
		if (
			["entities", "entity_aspects", "entity_attributes", "entity_dependencies"].some((name) => !tableNames.has(name))
		) {
			return { entityIds: [], entityNames: [], pinnedEntityIds: [], source: "query" };
		}

		const pinnedEntityIds =
			signals.includePinned === false
				? []
				: sanitizeEntityIds(
						(
							await readAll<{ readonly id: string }>(
								`SELECT e.id FROM entities e
								 WHERE e.pinned = 1${entity.sql}
								 ORDER BY e.pinned_at DESC, e.updated_at DESC, e.id
								 LIMIT 200`,
								entity.args,
								"session-start.graph-focal.pinned",
								200,
								signals.deadlineAt,
							)
						).map((row) => row.id),
					);
		let resolvedEntityIds: string[] = [];
		let source: FocalEntityResult["source"] = signals.project ? "project" : "query";

		if (signals.checkpointEntityIds && signals.checkpointEntityIds.length > 0) {
			resolvedEntityIds = sanitizeEntityIds(signals.checkpointEntityIds);
			source = "checkpoint";
		} else if (signals.project) {
			const tokens = extractProjectTokens(signals.project);
			if (tokens.length > 0) {
				const projectStatement = entityLikeStatement(tokens, entity, scope, true);
				const projectRows = await readAll<{ readonly id: string }>(
					projectStatement.sql,
					projectStatement.params,
					"session-start.graph-focal.project",
					Math.max(1, tokens.length * 5),
					signals.deadlineAt,
				);
				resolvedEntityIds = sanitizeEntityIds(projectRows.map((row) => row.id));
			}
		}

		if (resolvedEntityIds.length === 0 && signals.queryTokens && signals.queryTokens.length > 0) {
			const tokens = sanitizeQueryTokens(signals.queryTokens);
			if (tokens.length > 0) {
				let queryIds: string[] = [];
				try {
					const fts = tokens.join(" OR ");
					const queryRows: unknown[] = [];
					for (const table of entityFtsTablesFromNames([...tableNames], scope)) {
						queryRows.push(
							...(await readAll<object>(
								entityFtsStatement(table, entity),
								[fts, ...entity.args],
								"session-start.graph-focal.query-fts",
								20,
								signals.deadlineAt,
							)),
						);
					}
					queryIds = sanitizeEntityIds(mergeEntityFtsRows(queryRows, 20));
				} catch (error) {
					if (isTraversalDeadlineError(error)) throw error;
				}
				if (queryIds.length === 0) {
					const likeStatement = entityLikeStatement(tokens, entity, scope, false);
					const likeRows = await readAll<{ readonly id: string }>(
						likeStatement.sql,
						likeStatement.params,
						"session-start.graph-focal.query-like",
						20,
						signals.deadlineAt,
					);
					queryIds = sanitizeEntityIds(likeRows.map((row) => row.id));
				}
				resolvedEntityIds = queryIds;
				if (resolvedEntityIds.length > 0) source = "query";
			}
		}

		if (resolvedEntityIds.length === 0 && signals.sessionKey) source = "session_key";
		const candidates = sanitizeEntityIds([...pinnedEntityIds, ...resolvedEntityIds]).slice(0, 200);
		const entityNameRows =
			candidates.length === 0
				? []
				: await readAll<{ readonly id: string; readonly name: string }>(
						`SELECT e.id, e.name FROM entities e
						 WHERE e.id IN (${candidates.map(() => "?").join(", ")})${entity.sql}`,
						[...candidates, ...entity.args],
						"session-start.graph-focal.names",
						candidates.length,
						signals.deadlineAt,
					);
		return {
			...focalNames(candidates, entityNameRows),
			pinnedEntityIds,
			source,
		};
	} catch (error) {
		return {
			entityIds: [],
			entityNames: [],
			pinnedEntityIds: [],
			source: "query",
			error: describeTraversalError(error),
		};
	}
}

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
async function batchCollectForEntities(
	readAll: ReadAll,
	entityIds: ReadonlyArray<string>,
	scope: ReadScope,
	config: TraversalConfig,
	budget: number,
	deadlineAt?: number,
): Promise<{
	readonly memoryIds: Set<string>;
	readonly memoryScores: Map<string, number>;
	readonly memoryPaths: Map<string, TraversalPath>;
	readonly constraints: Array<{ readonly entityName: string; readonly content: string; readonly importance: number }>;
	readonly activeAspectIds: Set<string>;
	readonly visitedEntities: Set<string>;
}> {
	const stageYield = yieldEvery(1);
	const rowYield = yieldEvery(ROW_YIELD_BATCH);
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

	const entity = entityReadScope(scope);
	const aspect = derivedReadScopeSql("asp", scope);
	const attribute = derivedReadScopeSql("ea", scope, { memory: "memory_id", source: "source_id" });
	const memory = readScopeSql("m", scope);
	const memoryScope =
		config.scope === undefined
			? { sql: "", args: [] }
			: config.scope === null
				? { sql: " AND m.scope IS NULL", args: [] }
				: { sql: " AND m.scope = ?", args: [config.scope] };
	const entityPh = entityIds.map(() => "?").join(", ");
	const constraintRows = await readAll<{
		entity_id: string;
		entity_name: string;
		content: string;
		importance: number;
	}>(
		`SELECT asp.entity_id, e.name as entity_name, ea.content, ea.importance
		 FROM entity_aspects asp INDEXED BY idx_entity_aspects_entity
		 CROSS JOIN entity_attributes ea INDEXED BY idx_entity_attributes_aspect
		   ON ea.aspect_id = asp.id
		 JOIN entities e ON e.id = asp.entity_id
		 WHERE asp.entity_id IN (${entityPh})${aspect.sql}${attribute.sql}${entity.sql}
		   AND ea.kind = 'constraint'
		   AND ea.status = 'active'
		 ORDER BY ea.importance DESC`,
		[...entityIds, ...aspect.args, ...attribute.args, ...entity.args],
		"session-start.graph-traversal.constraints",
		Math.max(1, entityIds.length * config.maxAttributesPerAspect),
		deadlineAt,
	);

	for (const row of constraintRows) {
		const key = `${row.entity_name}::${row.content}`;
		if (constraintKeys.has(key)) continue;
		constraintKeys.add(key);
		constraints.push({
			entityName: row.entity_name,
			content: row.content,
			importance: row.importance,
		});
		await rowYield();
	}

	await stageYield();
	const aspectFilter = config.aspectFilter ? " AND asp.canonical_name LIKE ?" : "";
	const allAspectRows = await readAll<{ id: string; entity_id: string }>(
		`SELECT asp.id, asp.entity_id FROM entity_aspects asp INDEXED BY idx_entity_aspects_entity
		 JOIN entities e ON e.id = asp.entity_id
		 WHERE asp.entity_id IN (${entityPh})${aspect.sql}${entity.sql}${aspectFilter}
		 ORDER BY asp.weight DESC`,
		[...entityIds, ...aspect.args, ...entity.args, ...(config.aspectFilter ? [`%${config.aspectFilter}%`] : [])],
		"session-start.graph-traversal.aspects",
		Math.max(1, entityIds.length * config.maxAspectsPerEntity),
		deadlineAt,
	);
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
		await rowYield();
	}

	await stageYield();
	const budgetedAspectIds: string[] = [];
	const aspectEntityMap = new Map<string, string>();
	for (const [eid, aspects] of aspectsByEntity) {
		for (const a of aspects) {
			budgetedAspectIds.push(a.id);
			aspectEntityMap.set(a.id, eid);
		}
	}
	if (budgetedAspectIds.length > 0) {
		const aspectPh = budgetedAspectIds.map(() => "?").join(", ");
		const attributeRows = await readAll<{
			memory_id: string | null;
			importance: number;
			aspect_id: string;
		}>(
			`SELECT ea.memory_id, ea.importance, ea.aspect_id
			 FROM entity_attributes ea INDEXED BY idx_entity_attributes_aspect JOIN memories m ON m.id = ea.memory_id
			 WHERE ea.aspect_id IN (${aspectPh})${attribute.sql}
			   AND ea.status = 'active' AND m.is_deleted = 0${memoryScope.sql}${memory.sql}
			 ORDER BY ea.importance DESC`,
			[...budgetedAspectIds, ...attribute.args, ...memoryScope.args, ...memory.args],
			"session-start.graph-traversal.attributes",
			Math.max(1, budgetedAspectIds.length * config.maxAttributesPerAspect),
			deadlineAt,
		);
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
			await rowYield();
		}
	}

	await stageYield();
	if (memoryIds.size < budget) {
		const mentionBudget = budget - memoryIds.size;
		const mentionRows = await readAll<{
			memory_id: string;
			importance: number;
			entity_id: string;
		}>(
			`SELECT mem.memory_id, COALESCE(m.importance, 0.5) AS importance, mem.entity_id
			 FROM memory_entity_mentions mem
			 JOIN memories m ON m.id = mem.memory_id
			 JOIN entities e ON e.id = mem.entity_id
			 WHERE mem.entity_id IN (${entityPh})
			   AND m.is_deleted = 0${memoryScope.sql}${memory.sql}${entity.sql}
			 ORDER BY mem.confidence DESC, m.importance DESC, m.rowid, mem.entity_id
			 LIMIT ?`,
			[...entityIds, ...memoryScope.args, ...memory.args, ...entity.args, mentionBudget],
			"session-start.graph-traversal.mentions",
			mentionBudget,
			deadlineAt,
		);

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
			await rowYield();
		}
	}

	return { memoryIds, memoryScores, memoryPaths, constraints, activeAspectIds, visitedEntities };
}
async function traverseKnowledgeGraphWithReadAll(
	focalEntityIds: ReadonlyArray<string>,
	readAll: ReadAll,
	config: TraversalConfig,
): Promise<TraversalResult> {
	const empty = (): TraversalResult => ({
		memoryIds: new Set<string>(),
		memoryScores: new Map<string, number>(),
		memoryPaths: new Map<string, TraversalPath>(),
		constraints: [],
		entityCount: 0,
		timedOut: false,
		activeAspectIds: [],
		focalEntityIds: [],
	});

	const deadline = config.deadlineAt ?? Date.now() + config.timeoutMs;
	let phase1: Awaited<ReturnType<typeof batchCollectForEntities>> | undefined;
	try {
		const scope = requireReadScope(config.readScope);
		const tableRows = await readAll<{ readonly name: string }>(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table'
			   AND name IN ('entities', 'entity_aspects', 'entity_attributes', 'entity_dependencies')`,
			[],
			"session-start.graph-traversal.table-check",
			4,
			deadline,
		);
		const tableNames = new Set(tableRows.map((row) => row.name));
		if (
			tableRows.length < 4 ||
			!["entities", "entity_aspects", "entity_attributes", "entity_dependencies"].every((name) => tableNames.has(name))
		)
			return empty();

		const focalIds = sanitizeEntityIds(focalEntityIds);
		if (focalIds.length === 0) return empty();

		const stageYield = yieldEvery(1);
		const rowYield = yieldEvery(ROW_YIELD_BATCH);
		const budget = config.maxTraversalPaths;
		const collected = await batchCollectForEntities(readAll, focalIds, scope, config, budget, deadline);
		phase1 = collected;
		let timedOut = Date.now() >= deadline;

		await stageYield();
		if (!timedOut && collected.memoryIds.size < budget) {
			const focalPh = focalIds.map(() => "?").join(", ");
			const dependency = derivedReadScopeSql("d", scope, { source: "source_id" });
			const sourceEntity = entityReadScope(scope, "s");
			const targetEntity = entityReadScope(scope, "t");
			const dependencyRows = await readAll<{ id: string; source_entity_id: string; target_entity_id: string }>(
				`SELECT d.id, d.source_entity_id, d.target_entity_id FROM entity_dependencies d
				 INDEXED BY idx_entity_dependencies_source
				 JOIN entities s ON s.id = d.source_entity_id
				 JOIN entities t ON t.id = d.target_entity_id
				 WHERE d.source_entity_id IN (${focalPh})${dependency.sql}${sourceEntity.sql}${targetEntity.sql}
				   AND (COALESCE(d.confidence, 0.7) * d.strength) >= ?
				   AND COALESCE(d.confidence, 0.7) >= ?
				 ORDER BY (COALESCE(d.confidence, 0.7) * d.strength) DESC, d.id
				 LIMIT ?`,
				[
					...focalIds,
					...dependency.args,
					...sourceEntity.args,
					...targetEntity.args,
					config.minDependencyStrength,
					config.minConfidence,
					config.maxBranching * focalIds.length,
				],
				"session-start.graph-traversal.dependencies",
				Math.max(1, config.maxBranching * focalIds.length),
				deadline,
			);
			const hopTargetIds = dependencyRows
				.map((r) => r.target_entity_id)
				.filter((id) => !collected.visitedEntities.has(id));

			if (hopTargetIds.length > 0) {
				const remainingBudget = budget - collected.memoryIds.size;
				const phase2 = await batchCollectForEntities(readAll, hopTargetIds, scope, config, remainingBudget, deadline);
				for (const mid of phase2.memoryIds) {
					if (collected.memoryIds.size >= budget) break;
					collected.memoryIds.add(mid);
				}
				for (const [mid, score] of phase2.memoryScores) {
					const current = collected.memoryScores.get(mid);
					if (current === undefined || score > current) {
						collected.memoryScores.set(mid, score);
					}
					await rowYield();
				}
				for (const [mid, path] of phase2.memoryPaths) {
					const prev = collected.memoryPaths.get(mid);
					if (!prev || pathSize(path) > pathSize(prev)) {
						collected.memoryPaths.set(mid, path);
					}
					await rowYield();
				}
				const sourceByTarget = new Map<string, { sourceEntityId: string; dependencyId: string }>();
				for (const dep of dependencyRows) {
					sourceByTarget.set(dep.target_entity_id, {
						sourceEntityId: dep.source_entity_id,
						dependencyId: dep.id,
					});
				}
				for (const [mid, existingPath] of collected.memoryPaths) {
					for (const hopId of hopTargetIds) {
						const source = sourceByTarget.get(hopId);
						if (!source) continue;
						if (existingPath.entityIds.includes(hopId) && !existingPath.dependencyIds.length) {
							const upgraded = toPathStatic(
								hopId,
								source.sourceEntityId,
								existingPath.aspectIds[0],
								source.dependencyId,
							);
							if (pathSize(upgraded) > pathSize(existingPath)) {
								collected.memoryPaths.set(mid, upgraded);
							}
						}
					}
					await rowYield();
				}
				collected.constraints.push(...phase2.constraints);
				const seen = new Set<string>();
				let write = 0;
				for (let read = 0; read < collected.constraints.length; read++) {
					const c = collected.constraints[read];
					const key = `${c.entityName}::${c.content}`;
					if (!seen.has(key)) {
						seen.add(key);
						collected.constraints[write++] = c;
					}
				}
				collected.constraints.length = write;
				for (const aid of phase2.activeAspectIds) {
					collected.activeAspectIds.add(aid);
				}
				for (const eid of phase2.visitedEntities) {
					collected.visitedEntities.add(eid);
				}
			}

			timedOut = timedOut || Date.now() >= deadline;
		}

		collected.constraints.sort((a, b) => b.importance - a.importance);

		return {
			memoryIds: collected.memoryIds,
			memoryScores: collected.memoryScores,
			memoryPaths: collected.memoryPaths,
			constraints: collected.constraints,
			entityCount: collected.visitedEntities.size,
			timedOut,
			activeAspectIds: [...collected.activeAspectIds],
			focalEntityIds: focalIds,
		};
	} catch (error) {
		const partial =
			phase1 === undefined
				? empty()
				: {
						memoryIds: phase1.memoryIds,
						memoryScores: phase1.memoryScores,
						memoryPaths: phase1.memoryPaths,
						constraints: phase1.constraints,
						entityCount: phase1.visitedEntities.size,
						timedOut: false,
						activeAspectIds: [...phase1.activeAspectIds],
						focalEntityIds: sanitizeEntityIds(focalEntityIds),
					};
		if (isTraversalDeadlineError(error)) return { ...partial, timedOut: true };
		return { ...partial, error: describeTraversalError(error) };
	}
}

export async function traverseKnowledgeGraph(
	focalEntityIds: ReadonlyArray<string>,
	db: ReadDbSource,
	_agentId: string,
	config: TraversalConfig,
): Promise<TraversalResult> {
	return await traverseKnowledgeGraphWithReadAll(focalEntityIds, readAllFromSource(db), config);
}
export async function traverseKnowledgeGraphViaOwner(
	focalEntityIds: ReadonlyArray<string>,
	owner: DbOwnerClient,
	_agentId: string,
	config: TraversalConfig,
): Promise<TraversalResult> {
	return await traverseKnowledgeGraphWithReadAll(focalEntityIds, readAllFromOwner(owner), config);
}
