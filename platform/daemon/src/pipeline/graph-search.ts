import { cachedRecallShardNames } from "../recall-shard-catalogue";
import type { DbOwnerClient } from "../db-owner-client";
import { ownerReadAll } from "../db-owner-sql";
import { type ReadScope, readScopeSql } from "../read-scope";
import {
	type ScopeSql,
	type TraversalReadDb,
	derivedReadScopeSql,
	entityFtsTablesFromDb,
	entityFtsTablesFromNames,
	mergeEntityFtsRows,
	rankedEntityCandidatesSql,
	requireReadScope,
} from "./graph-traversal";
import { FTS_STOP } from "./stop-words";

export interface GraphBoostResult {
	readonly graphLinkedIds: Set<string>;
	readonly entityHits: number;
	readonly timedOut: boolean;
}

export function tokenizeGraphQuery(query: string): string[] {
	return query
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length >= 3 && !FTS_STOP.has(t));
}
function expansionStatement(
	ids: readonly string[],
	entity: ScopeSql,
	memory: ScopeSql,
): { readonly sql: string; readonly args: readonly unknown[] } {
	const placeholders = ids.map(() => "?").join(", ");
	return {
		sql: `WITH neighbors AS (
			 SELECT n.neighbor FROM (
			   SELECT target_entity_id AS neighbor FROM relations WHERE source_entity_id IN (${placeholders})
			   UNION
			   SELECT source_entity_id AS neighbor FROM relations WHERE target_entity_id IN (${placeholders})
			 ) n
			 JOIN entities e ON e.id = n.neighbor
			 WHERE 1 = 1${entity.sql}
			 ORDER BY n.neighbor
			 LIMIT 50
			)
			SELECT DISTINCT mem.memory_id
			 FROM memory_entity_mentions mem
			 JOIN memories m ON m.id = mem.memory_id
			 WHERE (mem.entity_id IN (${placeholders}) OR mem.entity_id IN (SELECT neighbor FROM neighbors))
			   AND m.is_deleted = 0${memory.sql}
			 ORDER BY mem.memory_id
			 LIMIT 200`,
		args: [...ids, ...ids, ...entity.args, ...ids, ...memory.args],
	};
}

function graphScopes(readScope: ReadScope) {
	const scope = requireReadScope(readScope);
	const entity = derivedReadScopeSql("e", scope, { source: "source_id" });
	return { scope, entity, memory: readScopeSql("m", scope) };
}

function entityLike(tokens: readonly string[], entity: ScopeSql, scope: ReadScope): ScopeSql {
	const likePatterns = tokens.map((token) => `%${token}%`);
	return rankedEntityCandidatesSql(
		{ sql: `(${likePatterns.map(() => "e.canonical_name LIKE ?").join(" OR ")})`, args: likePatterns },
		entity,
		scope,
		20,
	);
}

function entityFts(table: string, entity: ScopeSql): string {
	return `SELECT e.id, bm25(${table}) AS raw FROM ${table}
			 JOIN entities e ON e.rowid = ${table}.rowid
			 WHERE ${table} MATCH ?${entity.sql}
			 ORDER BY raw, e.id
			 LIMIT 20`;
}

export function getGraphBoostIds(
	query: string,
	db: TraversalReadDb,
	timeoutMs: number,
	_agentId: string | undefined,
	readScope: ReadScope,
): GraphBoostResult {
	const empty: GraphBoostResult = {
		graphLinkedIds: new Set(),
		entityHits: 0,
		timedOut: false,
	};

	try {
		const deadline = Date.now() + timeoutMs;
		const tokens = tokenizeGraphQuery(query);
		if (tokens.length === 0) return empty;
		const { scope, entity, memory } = graphScopes(readScope);
		let entityIds: string[] = [];
		try {
			const fts = tokens.join(" OR ");
			const tables = entityFtsTablesFromDb(db, scope);
			if (tables.length === 0) throw new Error("Entity FTS unavailable");
			entityIds = mergeEntityFtsRows(
				tables.flatMap((table) => db.prepare(entityFts(table, entity)).all(fts, ...entity.args)),
				20,
			);
		} catch {
			const like = entityLike(tokens, entity, scope);
			entityIds = (db.prepare(like.sql).all(...like.args) as Array<{ id: string }>).map((row) => row.id);
		}

		if (entityIds.length === 0) return empty;
		if (Date.now() > deadline) return { ...empty, timedOut: true };

		const expansion = expansionStatement(entityIds, entity, memory);
		const memoryRows = db.prepare(expansion.sql).all(...expansion.args) as Array<{ memory_id: string }>;
		return {
			graphLinkedIds: new Set(memoryRows.map((r) => r.memory_id)),
			entityHits: entityIds.length,
			timedOut: Date.now() > deadline,
		};
	} catch {
		return empty;
	}
}
export async function getGraphBoostIdsViaOwner(
	query: string,
	owner: DbOwnerClient,
	timeoutMs: number,
	_agentId: string | undefined,
	readScope: ReadScope,
): Promise<GraphBoostResult> {
	const empty: GraphBoostResult = {
		graphLinkedIds: new Set(),
		entityHits: 0,
		timedOut: false,
	};

	try {
		const deadline = Date.now() + timeoutMs;
		const tokens = tokenizeGraphQuery(query);
		if (tokens.length === 0) return empty;
		const { scope, entity, memory } = graphScopes(readScope);
		const remaining = () => Math.max(1, deadline - Date.now());
		const options = (operation: string) => ({
			operation,
			lane: "read" as const,
			workloadClass: "foreground" as const,
			deadlineMs: remaining(),
			estimatedWorkUnits: 200,
		});

		let entityIds: string[] = [];
		try {
			const shards =
				scope.compartments !== "all" && scope.compartments.length === 0
					? ["entities_fts"]
					: await cachedRecallShardNames(async () =>
							(
								await ownerReadAll<{ name: string }>(
									owner,
									"SELECT name FROM sqlite_master WHERE type='table'",
									[],
									options("memory-search.graph-boost.entity-shards"),
								)
							).map((row) => row.name),
						);
			const fts = tokens.join(" OR ");
			const rows: object[] = [];
			const tables = entityFtsTablesFromNames(shards, scope);
			if (tables.length === 0) throw new Error("Entity FTS unavailable");
			for (const table of tables) {
				rows.push(
					...(await ownerReadAll<object>(
						owner,
						entityFts(table, entity),
						[fts, ...entity.args],
						options("memory-search.graph-boost.entities-fts"),
					)),
				);
			}
			entityIds = mergeEntityFtsRows(rows, 20);
		} catch {
			const like = entityLike(tokens, entity, scope);
			entityIds = (
				await ownerReadAll<{ id: string }>(
					owner,
					like.sql,
					like.args,
					options("memory-search.graph-boost.entities-like"),
				)
			).map((row) => row.id);
		}

		if (entityIds.length === 0) return empty;
		if (Date.now() > deadline) return { ...empty, entityHits: entityIds.length, timedOut: true };

		const expansion = expansionStatement(entityIds, entity, memory);
		const memoryRows = await ownerReadAll<{ memory_id: string }>(
			owner,
			expansion.sql,
			expansion.args,
			options("memory-search.graph-boost.memories"),
		);
		return {
			graphLinkedIds: new Set(memoryRows.map((row) => row.memory_id)),
			entityHits: entityIds.length,
			timedOut: Date.now() > deadline,
		};
	} catch {
		return empty;
	}
}
