import type { ReadDb } from "../db-accessor";
import type { DbOwnerClient } from "../db-owner-client";
import { ownerReadAll } from "../db-owner-sql";
import type { ReadScope } from "../read-scope";
import {
	type ScopeSql,
	derivedReadScopeSql,
	entityFtsTablesFromDb,
	entityFtsTablesFromNames,
	localReadScope,
	memoryReadScopeSql,
	mergeEntityFtsRows,
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

function graphScopes(agentId: string | undefined, readScope: ReadScope | undefined) {
	const scope = readScope ?? localReadScope(agentId ?? "default");
	const entity = derivedReadScopeSql("e", scope, { source: "source_id" });
	return { scope, entity, memory: memoryReadScopeSql("m", readScope) };
}

function entityLike(tokens: readonly string[], entity: ScopeSql): { readonly sql: string; readonly args: unknown[] } {
	const likePatterns = tokens.map((token) => `%${token}%`);
	return {
		sql: `SELECT e.id FROM entities e
			 WHERE (${likePatterns.map(() => "e.canonical_name LIKE ?").join(" OR ")})${entity.sql}
			 ORDER BY e.mentions DESC, e.id
			 LIMIT 20`,
		args: [...likePatterns, ...entity.args],
	};
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
	db: ReadDb,
	timeoutMs: number,
	agentId?: string,
	readScope?: ReadScope,
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
		const { scope, entity, memory } = graphScopes(agentId, readScope);
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
			const like = entityLike(tokens, entity);
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
	agentId?: string,
	readScope?: ReadScope,
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
		const { scope, entity, memory } = graphScopes(agentId, readScope);
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
			const shards = await ownerReadAll<{ name: string }>(
				owner,
				"SELECT name FROM sqlite_master WHERE type = 'table' AND (name = 'entities_fts' OR name GLOB 'entities_fts__c[0-9]*')",
				[],
				options("memory-search.graph-boost.entity-shards"),
			);
			const fts = tokens.join(" OR ");
			const rows: object[] = [];
			const tables = entityFtsTablesFromNames(
				shards.map((row) => row.name),
				scope,
			);
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
			const like = entityLike(tokens, entity);
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
