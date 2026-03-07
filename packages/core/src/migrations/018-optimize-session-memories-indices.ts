/**
 * Migration 018: Optimize Session Memories Indices
 *
 * Removes redundant index on session_memories(session_key) which is already
 * covered by the UNIQUE(session_key, memory_id) constraint's implicit index.
 * This reduces write overhead for every session-start candidate recording.
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	// SQLite's UNIQUE(a, b) creates an index on (a, b) which can be used
	// for queries on (a). The separate index on (session_key) is redundant.
	db.exec(`
		DROP INDEX IF EXISTS idx_session_memories_session;
	`);
}
