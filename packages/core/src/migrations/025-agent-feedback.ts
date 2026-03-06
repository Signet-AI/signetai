/**
 * Migration 025: Agent Relevance Feedback
 *
 * Adds columns to session_memories for accumulating per-prompt agent
 * feedback scores. The running mean of feedback across the session
 * becomes the primary training label for the predictive scorer.
 */

import type { MigrationDb } from "./index";

/** Helper: add a column only if it doesn't already exist. */
function addColumnIfMissing(
	db: MigrationDb,
	table: string,
	column: string,
	definition: string,
): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<
		Record<string, unknown>
	>;
	if (!cols.some((c) => c.name === column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}

export function up(db: MigrationDb): void {
	// agent_relevance_score: running mean of per-prompt agent feedback
	// NULL = no feedback received for this memory in this session
	addColumnIfMissing(
		db,
		"session_memories",
		"agent_relevance_score",
		"REAL",
	);

	// agent_feedback_count: number of feedback data points accumulated
	addColumnIfMissing(
		db,
		"session_memories",
		"agent_feedback_count",
		"INTEGER DEFAULT 0",
	);
}
