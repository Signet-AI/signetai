/**
 * Query-time graph boost for recall.
 *
 * Resolves entities mentioned in the query, expands one hop through
 * the relation graph, and collects linked memory IDs. Fully
 * synchronous — all bun:sqlite calls are sync, deadline checks
 * use Date.now().
 */

import type { ReadDb } from "../db-accessor";
import type { DbOwnerClient } from "../db-owner-client";
import { ownerReadAll } from "../db-owner-sql";
import { FTS_STOP } from "./stop-words";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphBoostResult {
	readonly graphLinkedIds: Set<string>;
	readonly entityHits: number;
	readonly timedOut: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function tokenizeGraphQuery(query: string): string[] {
	return query
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length >= 3 && !FTS_STOP.has(t));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Find memory IDs linked to entities matching the query via the
 * knowledge graph. Returns an empty set on any error (no degradation).
 */
export function getGraphBoostIds(query: string, db: ReadDb, timeoutMs: number, agentId?: string): GraphBoostResult {
	const empty: GraphBoostResult = {
		graphLinkedIds: new Set(),
		entityHits: 0,
		timedOut: false,
	};

	try {
		const deadline = Date.now() + timeoutMs;
		const tokens = tokenizeGraphQuery(query);
		if (tokens.length === 0) return empty;

		// Step 1: Resolve entities matching query tokens via FTS5
		let entityRows: Array<{ id: string }> = [];
		const agentFilter = agentId ?? "default";
		try {
			const fts = tokens.join(" OR ");
			entityRows = db
				.prepare(
					`SELECT e.id FROM entities_fts
					 JOIN entities e ON e.rowid = entities_fts.rowid
					 WHERE entities_fts MATCH ?
					   AND e.agent_id = ?
					 ORDER BY rank
					 LIMIT 20`,
				)
				.all(fts, agentFilter) as Array<{ id: string }>;
		} catch {
			// FTS table doesn't exist — fall back to LIKE
			const likePatterns = tokens.map((t) => `%${t}%`);
			const likeClauses = likePatterns.map(() => "canonical_name LIKE ?").join(" OR ");
			entityRows = db
				.prepare(
					`SELECT id FROM entities
					 WHERE agent_id = ?
					   AND (${likeClauses})
					 ORDER BY mentions DESC
					 LIMIT 20`,
				)
				.all(agentFilter, ...likePatterns) as Array<{ id: string }>;
		}

		if (entityRows.length === 0) return empty;
		if (Date.now() > deadline) return { ...empty, timedOut: true };

		const entityIds = new Set(entityRows.map((r) => r.id));

		// Step 2: One-hop expansion through relations (both directions)
		const placeholders = entityRows.map(() => "?").join(", ");
		const ids = entityRows.map((r) => r.id);

		const neighbors = db
			.prepare(
				`SELECT target_entity_id AS neighbor FROM relations
				 WHERE source_entity_id IN (${placeholders})
				 UNION
				 SELECT source_entity_id AS neighbor FROM relations
				 WHERE target_entity_id IN (${placeholders})
				 LIMIT 50`,
			)
			.all(...ids, ...ids) as Array<{ neighbor: string }>;

		for (const n of neighbors) {
			entityIds.add(n.neighbor);
		}

		if (Date.now() > deadline) return { ...empty, entityHits: entityRows.length, timedOut: true };

		// Step 3: Collect memory IDs linked to the expanded entity set
		const expandedPlaceholders = [...entityIds].map(() => "?").join(", ");
		const expandedIds = [...entityIds];

		const memoryRows = db
			.prepare(
				`SELECT DISTINCT mem.memory_id
				 FROM memory_entity_mentions mem
				 JOIN memories m ON m.id = mem.memory_id
				 WHERE mem.entity_id IN (${expandedPlaceholders})
				   AND m.is_deleted = 0
				 LIMIT 200`,
			)
			.all(...expandedIds) as Array<{ memory_id: string }>;

		if (Date.now() > deadline) {
			return {
				graphLinkedIds: new Set(memoryRows.map((r) => r.memory_id)),
				entityHits: entityRows.length,
				timedOut: true,
			};
		}

		return {
			graphLinkedIds: new Set(memoryRows.map((r) => r.memory_id)),
			entityHits: entityRows.length,
			timedOut: false,
		};
	} catch {
		return empty;
	}
}

/** Owner-bound equivalent used by recall paths that must not touch parent SQLite. */
export async function getGraphBoostIdsViaOwner(
	query: string,
	owner: DbOwnerClient,
	timeoutMs: number,
	agentId?: string,
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
		const agentFilter = agentId ?? "default";
		const remaining = () => Math.max(1, deadline - Date.now());
		const options = (operation: string) => ({
			operation,
			lane: "read" as const,
			workloadClass: "foreground" as const,
			deadlineMs: remaining(),
			estimatedWorkUnits: 200,
		});

		let entityRows: ReadonlyArray<{ id: string }> = [];
		try {
			entityRows = await ownerReadAll<{ id: string }>(
				owner,
				`SELECT e.id FROM entities_fts
				 JOIN entities e ON e.rowid = entities_fts.rowid
				 WHERE entities_fts MATCH ?
				   AND e.agent_id = ?
				 ORDER BY rank
				 LIMIT 20`,
				[tokens.join(" OR "), agentFilter],
				options("memory-search.graph-boost.entities-fts"),
			);
		} catch {
			const likePatterns = tokens.map((token) => `%${token}%`);
			const likeClauses = likePatterns.map(() => "canonical_name LIKE ?").join(" OR ");
			entityRows = await ownerReadAll<{ id: string }>(
				owner,
				`SELECT id FROM entities
				 WHERE agent_id = ?
				   AND (${likeClauses})
				 ORDER BY mentions DESC
				 LIMIT 20`,
				[agentFilter, ...likePatterns],
				options("memory-search.graph-boost.entities-like"),
			);
		}

		if (entityRows.length === 0) return empty;
		if (Date.now() > deadline) return { ...empty, entityHits: entityRows.length, timedOut: true };

		const entityIds = new Set(entityRows.map((row) => row.id));
		const placeholders = entityRows.map(() => "?").join(", ");
		const ids = entityRows.map((row) => row.id);
		const neighbors = await ownerReadAll<{ neighbor: string }>(
			owner,
			`SELECT target_entity_id AS neighbor FROM relations
			 WHERE source_entity_id IN (${placeholders})
			 UNION
			 SELECT source_entity_id AS neighbor FROM relations
			 WHERE target_entity_id IN (${placeholders})
			 LIMIT 50`,
			[...ids, ...ids],
			options("memory-search.graph-boost.neighbors"),
		);
		for (const neighbor of neighbors) entityIds.add(neighbor.neighbor);
		if (Date.now() > deadline) return { ...empty, entityHits: entityRows.length, timedOut: true };

		const expandedIds = [...entityIds];
		const memoryRows = await ownerReadAll<{ memory_id: string }>(
			owner,
			`SELECT DISTINCT mem.memory_id
			 FROM memory_entity_mentions mem
			 JOIN memories m ON m.id = mem.memory_id
			 WHERE mem.entity_id IN (${expandedIds.map(() => "?").join(", ")})
			   AND m.is_deleted = 0
			 LIMIT 200`,
			expandedIds,
			options("memory-search.graph-boost.memories"),
		);
		return {
			graphLinkedIds: new Set(memoryRows.map((row) => row.memory_id)),
			entityHits: entityRows.length,
			timedOut: Date.now() > deadline,
		};
	} catch {
		return empty;
	}
}
