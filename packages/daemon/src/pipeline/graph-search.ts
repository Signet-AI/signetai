/**
 * Query-time graph boost for recall.
 *
 * Resolves entities mentioned in the query, expands one hop through
 * the relation graph, and collects linked memory IDs. Fully
 * synchronous — all bun:sqlite calls are sync, deadline checks
 * use Date.now().
 */

import type { ReadDb } from "../db-accessor";

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

function tokenizeQuery(query: string): string[] {
	return query
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length >= 2);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Find memory IDs linked to entities matching the query via the
 * knowledge graph. Returns an empty set on any error (no degradation).
 */
export function getGraphBoostIds(
	query: string,
	db: ReadDb,
	timeoutMs: number,
): GraphBoostResult {
	const empty: GraphBoostResult = {
		graphLinkedIds: new Set(),
		entityHits: 0,
		timedOut: false,
	};

	try {
		const deadline = Date.now() + timeoutMs;
		const tokens = tokenizeQuery(query);
		if (tokens.length === 0) return empty;

		// Step 1: Resolve entities matching query tokens
		const likePatterns = tokens.map((t) => `%${t}%`);
		const likeClauses = likePatterns.map(() => "canonical_name LIKE ?").join(" OR ");

		const entityRows = db
			.prepare(
				`SELECT id FROM entities
				 WHERE ${likeClauses}
				 ORDER BY mentions DESC
				 LIMIT 20`,
			)
			.all(...likePatterns) as Array<{ id: string }>;

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
