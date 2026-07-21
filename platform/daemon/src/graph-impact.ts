/**
 * Graph impact analysis — walks entity_dependencies to determine
 * blast radius from a given entity.
 *
 * Used by the /api/graph/impact endpoint to group affected entities
 * by depth: WILL BREAK (1), LIKELY AFFECTED (2), MAY NEED TESTING (3+).
 */

import type { ReadDb } from "./db-accessor";
import { tableExists } from "./db-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const DEPTH_LABELS = {
	1: "WILL BREAK",
	2: "LIKELY AFFECTED",
	3: "MAY NEED TESTING",
} as const;

interface ImpactEntity {
	readonly id: string;
	readonly name: string;
	readonly type: string;
}

interface ImpactLayer {
	readonly depth: number;
	readonly label: string;
	readonly entities: readonly ImpactEntity[];
}

interface ImpactResult {
	readonly entityId: string;
	readonly entityName: string;
	readonly direction: "upstream" | "downstream";
	readonly impact: readonly ImpactLayer[];
}

// ---------------------------------------------------------------------------
// Table detection
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

/**
 * BFS walk of entity_dependencies from the given entity.
 *
 * - downstream: source_entity_id = current → collect target_entity_id
 * - upstream:   target_entity_id = current → collect source_entity_id
 *
 * Groups results by depth with descriptive labels. Respects a wall-clock
 * timeout to prevent runaway walks on dense graphs.
 */
export function walkImpact(
	db: ReadDb,
	params: {
		readonly entityId: string;
		readonly direction: "upstream" | "downstream";
		readonly maxDepth: number;
		readonly timeoutMs?: number;
	},
): ImpactResult {
	const { entityId, direction, maxDepth } = params;
	const timeout = params.timeoutMs ?? 200;
	const deadline = Date.now() + timeout;

	// Resolve entity name for the root
	const root = db.prepare("SELECT name, entity_type FROM entities WHERE id = ?").get(entityId) as
		| { name: string; entity_type: string }
		| undefined;

	const entityName = root?.name ?? entityId;

	if (!tableExists(db, "entity_dependencies")) {
		return { entityId, entityName, direction, impact: [] };
	}

	// Prepare the directional query once
	const sql =
		direction === "downstream"
			? `SELECT e.id, e.name, e.entity_type
			   FROM entity_dependencies d
			   JOIN entities e ON e.id = d.target_entity_id
			   WHERE d.source_entity_id = ?`
			: `SELECT e.id, e.name, e.entity_type
			   FROM entity_dependencies d
			   JOIN entities e ON e.id = d.source_entity_id
			   WHERE d.target_entity_id = ?`;

	const stmt = db.prepare(sql);

	const visited = new Set<string>([entityId]);
	let frontier = [entityId];
	const layers: ImpactLayer[] = [];

	for (let depth = 1; depth <= maxDepth; depth++) {
		if (frontier.length === 0) break;
		if (Date.now() > deadline) break;

		const found: ImpactEntity[] = [];
		const next: string[] = [];

		for (const id of frontier) {
			if (Date.now() > deadline) break;

			const rows = stmt.all(id) as Array<{
				id: string;
				name: string;
				entity_type: string;
			}>;

			for (const row of rows) {
				if (visited.has(row.id)) continue;
				visited.add(row.id);
				found.push({
					id: row.id,
					name: row.name,
					type: row.entity_type,
				});
				next.push(row.id);
			}
		}

		if (found.length > 0) {
			const label = depth <= 3 ? DEPTH_LABELS[depth as 1 | 2 | 3] : "MAY NEED TESTING";
			layers.push({ depth, label, entities: found });
		}

		frontier = next;
	}

	return { entityId, entityName, direction, impact: layers };
}
