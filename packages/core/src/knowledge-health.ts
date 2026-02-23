/**
 * Knowledge Health Dashboard — Phase 3 Task 3.6
 *
 * Computes a comprehensive health report across the entire memory store:
 * type diversity, signing completeness, provenance coverage, graph
 * connectivity, freshness, contradiction resolution, and session
 * continuity. Produces a 0–100 composite score.
 *
 * Scoring breakdown (100 pts total):
 *   10 pts — Memory type diversity (mix of different types)
 *   15 pts — Signing completeness (% of memories signed)
 *   15 pts — Provenance coverage (% with source info)
 *   15 pts — Graph connectivity (entities with relations / total entities)
 *   15 pts — Freshness (% accessed in last 30 days)
 *   15 pts — Contradiction resolution (% resolved / total)
 *   15 pts — Session continuity trend (average score × 15)
 */

import type { MigrationDb } from "./migrations/index";
import { MEMORY_TYPES } from "./types";
import { getSessionTrend } from "./session-metrics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TypeBreakdown {
	type: string;
	count: number;
}

export interface SourceBreakdown {
	source: string;
	count: number;
}

export interface TopicSummary {
	name: string;
	count: number;
}

export interface HealthScoreBreakdown {
	typeDiversity: number;       // 0–10
	signingCompleteness: number; // 0–15
	provenanceCoverage: number;  // 0–15
	graphConnectivity: number;   // 0–15
	freshness: number;           // 0–15
	contradictionResolution: number; // 0–15
	sessionContinuity: number;   // 0–15
}

export interface KnowledgeHealthReport {
	// Counts
	totalMemories: number;
	activeMemories: number; // non-deleted
	typeBreakdown: TypeBreakdown[];
	signedCount: number;
	unsignedCount: number;
	withProvenanceCount: number;
	withoutProvenanceCount: number;

	// Graph
	totalEntities: number;
	totalRelations: number;
	connectedEntities: number; // entities that appear in at least one relation

	// Quality
	contradictionsPending: number;
	contradictionsResolved: number;
	staleMemoryCount: number; // >90 days, never accessed

	// Sources
	sourceBreakdown: SourceBreakdown[];

	// Topics
	topTopics: TopicSummary[];
	weakestAreas: TopicSummary[];

	// Scoring
	scoreBreakdown: HealthScoreBreakdown;
	overallScore: number; // 0–100

	// Suggestions
	suggestions: string[];

	computedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely query — returns 0 if table/column missing. */
function safeCount(db: MigrationDb, sql: string, ...args: unknown[]): number {
	try {
		const row = db.prepare(sql).get(...args) as
			| Record<string, unknown>
			| undefined;
		if (!row) return 0;
		const val = Object.values(row)[0];
		return typeof val === "number" ? val : 0;
	} catch {
		return 0;
	}
}

/** Safely query all rows. */
function safeAll(
	db: MigrationDb,
	sql: string,
	...args: unknown[]
): Array<Record<string, unknown>> {
	try {
		return db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
	} catch {
		return [];
	}
}

/** Check if a table exists */
function tableExists(db: MigrationDb, table: string): boolean {
	try {
		const row = db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
			)
			.get(table) as Record<string, unknown> | undefined;
		return !!row;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export function getKnowledgeHealth(db: MigrationDb): KnowledgeHealthReport {
	const now = new Date();
	const nowIso = now.toISOString();

	// 30 days ago for freshness check
	const thirtyDaysAgo = new Date(
		now.getTime() - 30 * 24 * 60 * 60 * 1000,
	).toISOString();

	// 90 days ago for staleness check
	const ninetyDaysAgo = new Date(
		now.getTime() - 90 * 24 * 60 * 60 * 1000,
	).toISOString();

	// -- Total / active memories ------------------------------------------------
	const totalMemories = safeCount(
		db,
		`SELECT COUNT(*) as n FROM memories`,
	);
	const activeMemories = safeCount(
		db,
		`SELECT COUNT(*) as n FROM memories WHERE COALESCE(is_deleted, 0) = 0`,
	);

	// -- Type breakdown ----------------------------------------------------------
	const typeRows = safeAll(
		db,
		`SELECT type, COUNT(*) as cnt FROM memories
		 WHERE COALESCE(is_deleted, 0) = 0
		 GROUP BY type ORDER BY cnt DESC`,
	);
	const typeBreakdown: TypeBreakdown[] = typeRows.map((r) => ({
		type: r.type as string,
		count: r.cnt as number,
	}));

	// -- Signing ------------------------------------------------------------------
	const signedCount = safeCount(
		db,
		`SELECT COUNT(*) as n FROM memories
		 WHERE COALESCE(is_deleted, 0) = 0
		   AND signature IS NOT NULL AND signature != ''`,
	);
	const unsignedCount = activeMemories - signedCount;

	// -- Provenance ---------------------------------------------------------------
	const withProvenanceCount = safeCount(
		db,
		`SELECT COUNT(*) as n FROM memories
		 WHERE COALESCE(is_deleted, 0) = 0
		   AND (source_type IS NOT NULL AND source_type != '')`,
	);
	const withoutProvenanceCount = activeMemories - withProvenanceCount;

	// -- Graph stats --------------------------------------------------------------
	const totalEntities = safeCount(
		db,
		`SELECT COUNT(*) as n FROM entities`,
	);
	const totalRelations = safeCount(
		db,
		`SELECT COUNT(*) as n FROM relations`,
	);

	// Entities that participate in at least one relation (as source or target)
	const connectedEntities = safeCount(
		db,
		`SELECT COUNT(DISTINCT id) as n FROM (
			SELECT source_entity_id as id FROM relations
			UNION
			SELECT target_entity_id as id FROM relations
		)`,
	);

	// -- Contradictions -----------------------------------------------------------
	const hasContradictions = tableExists(db, "contradictions");
	const contradictionsResolved = hasContradictions
		? safeCount(
				db,
				`SELECT COUNT(*) as n FROM contradictions WHERE resolution IS NOT NULL AND resolution != ''`,
		  )
		: 0;
	const contradictionsTotal = hasContradictions
		? safeCount(db, `SELECT COUNT(*) as n FROM contradictions`)
		: 0;
	const contradictionsPending = contradictionsTotal - contradictionsResolved;

	// -- Stale memories (>90 days, access_count = 0 or never accessed) -----------
	const staleMemoryCount = safeCount(
		db,
		`SELECT COUNT(*) as n FROM memories
		 WHERE COALESCE(is_deleted, 0) = 0
		   AND created_at < ?
		   AND (last_accessed IS NULL OR last_accessed = '')
		   AND COALESCE(access_count, 0) = 0`,
		ninetyDaysAgo,
	);

	// -- Source breakdown ----------------------------------------------------------
	const sourceRows = safeAll(
		db,
		`SELECT COALESCE(source_type, 'unknown') as src, COUNT(*) as cnt
		 FROM memories
		 WHERE COALESCE(is_deleted, 0) = 0
		 GROUP BY src ORDER BY cnt DESC`,
	);
	const sourceBreakdown: SourceBreakdown[] = sourceRows.map((r) => ({
		source: r.src as string,
		count: r.cnt as number,
	}));

	// -- Top topics (most common entities) ----------------------------------------
	const topTopicRows = safeAll(
		db,
		`SELECT e.name, COUNT(m.memory_id) as cnt
		 FROM entities e
		 LEFT JOIN memory_entity_mentions m ON m.entity_id = e.id
		 GROUP BY e.id
		 ORDER BY cnt DESC
		 LIMIT 10`,
	);
	const topTopics: TopicSummary[] = topTopicRows.map((r) => ({
		name: r.name as string,
		count: r.cnt as number,
	}));

	// -- Weakest areas (entities with fewest mentions) ----------------------------
	const weakestRows = safeAll(
		db,
		`SELECT e.name, COUNT(m.memory_id) as cnt
		 FROM entities e
		 LEFT JOIN memory_entity_mentions m ON m.entity_id = e.id
		 GROUP BY e.id
		 HAVING cnt > 0
		 ORDER BY cnt ASC
		 LIMIT 10`,
	);
	const weakestAreas: TopicSummary[] = weakestRows.map((r) => ({
		name: r.name as string,
		count: r.cnt as number,
	}));

	// -- Freshness (% of active memories accessed in last 30 days) ----------------
	const freshCount = safeCount(
		db,
		`SELECT COUNT(*) as n FROM memories
		 WHERE COALESCE(is_deleted, 0) = 0
		   AND last_accessed IS NOT NULL
		   AND last_accessed >= ?`,
		thirtyDaysAgo,
	);

	// =========================================================================
	// Scoring
	// =========================================================================

	// 1. Type diversity (10 pts)
	// Full marks for having 5+ distinct types
	const distinctTypes = typeBreakdown.length;
	const maxDiversityTypes = Math.min(distinctTypes, MEMORY_TYPES.length);
	const typeDiversity = Math.min(
		10,
		(maxDiversityTypes / Math.min(5, MEMORY_TYPES.length)) * 10,
	);

	// 2. Signing completeness (15 pts)
	const signingCompleteness =
		activeMemories > 0
			? (signedCount / activeMemories) * 15
			: 0;

	// 3. Provenance coverage (15 pts)
	const provenanceCoverage =
		activeMemories > 0
			? (withProvenanceCount / activeMemories) * 15
			: 0;

	// 4. Graph connectivity (15 pts)
	const graphConnectivity =
		totalEntities > 0
			? (connectedEntities / totalEntities) * 15
			: 0;

	// 5. Freshness (15 pts)
	const freshness =
		activeMemories > 0
			? (freshCount / activeMemories) * 15
			: 0;

	// 6. Contradiction resolution (15 pts)
	const contradictionResolution =
		contradictionsTotal > 0
			? (contradictionsResolved / contradictionsTotal) * 15
			: 15; // No contradictions = full marks

	// 7. Session continuity trend (15 pts)
	let sessionContinuity = 0;
	try {
		const trend = getSessionTrend(db, 20);
		sessionContinuity = trend.averageScore * 15;
	} catch {
		// session_metrics table might not exist yet — 0 pts
	}

	const scoreBreakdown: HealthScoreBreakdown = {
		typeDiversity: round2(typeDiversity),
		signingCompleteness: round2(signingCompleteness),
		provenanceCoverage: round2(provenanceCoverage),
		graphConnectivity: round2(graphConnectivity),
		freshness: round2(freshness),
		contradictionResolution: round2(contradictionResolution),
		sessionContinuity: round2(sessionContinuity),
	};

	const overallScore = round2(
		typeDiversity +
			signingCompleteness +
			provenanceCoverage +
			graphConnectivity +
			freshness +
			contradictionResolution +
			sessionContinuity,
	);

	// -- Suggestions ---------------------------------------------------------------
	const suggestions: string[] = [];

	if (contradictionsPending > 0) {
		suggestions.push(
			`${contradictionsPending} contradiction${contradictionsPending === 1 ? "" : "s"} need${contradictionsPending === 1 ? "s" : ""} review`,
		);
	}
	if (staleMemoryCount > 0) {
		suggestions.push(
			`${staleMemoryCount} memor${staleMemoryCount === 1 ? "y is" : "ies are"} stale (>90 days, never accessed)`,
		);
	}
	if (unsignedCount > 0 && activeMemories > 0) {
		const pct = Math.round((unsignedCount / activeMemories) * 100);
		if (pct > 20) {
			suggestions.push(
				`${pct}% of memories are unsigned — run \`signet sign --all\` to improve integrity`,
			);
		}
	}
	if (withoutProvenanceCount > 0 && activeMemories > 0) {
		const pct = Math.round(
			(withoutProvenanceCount / activeMemories) * 100,
		);
		if (pct > 30) {
			suggestions.push(
				`${pct}% of memories lack source provenance`,
			);
		}
	}
	if (distinctTypes < 3 && activeMemories > 5) {
		suggestions.push(
			`Low type diversity — only ${distinctTypes} type${distinctTypes === 1 ? "" : "s"} in use. Consider categorizing memories.`,
		);
	}
	if (totalEntities > 0 && connectedEntities / totalEntities < 0.5) {
		suggestions.push(
			`${totalEntities - connectedEntities} orphan entities have no relations — consider enriching the knowledge graph`,
		);
	}

	return {
		totalMemories,
		activeMemories,
		typeBreakdown,
		signedCount,
		unsignedCount,
		withProvenanceCount,
		withoutProvenanceCount,
		totalEntities,
		totalRelations,
		connectedEntities,
		contradictionsPending,
		contradictionsResolved,
		staleMemoryCount,
		sourceBreakdown,
		topTopics,
		weakestAreas,
		scoreBreakdown,
		overallScore,
		suggestions,
		computedAt: nowIso,
	};
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
