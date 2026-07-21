/**
 * Migration 088: Unified ingest queue consolidation (#913)
 *
 * Turns `memory_jobs` into the single durable queue drained by both the
 * daemon (Dreaming, 24/7) and an external harness (Agentic Dreaming, cron),
 * with agent-scoped fenced leasing, priority lanes, and the planning
 * lifecycle the agentic two-phase protocol needs.
 *
 * Adds:
 *   - agent_id           data ownership (backfilled from documents/memories)
 *   - lease_owner        which executor currently holds the attempt
 *   - lease_token        fencing proof — CAS target on apply (prevents double-apply)
 *   - lease_expires_at   per-row TTL (supports per-item planning cooldown)
 *   - priority           lane ordering: live > recent/import > backfill > maintenance
 *   - planning_attempts  separate ceiling from apply attempts (agentic lifecycle)
 *   - planning_started_at cumulative wall-clock ceiling basis
 *   - last_planning_at   per-item cooldown basis
 *   - plan_hash          idempotency key component (item id + plan_hash)
 *
 * Drops the legacy daemon dreaming worker's tables (#913 cutover). The worker
 * itself is deleted in the same PR; nothing else reads these tables in the
 * daemon runtime. Production drops require a backup-first CLI step — never
 * delete production data without backup.
 *
 * NOTE: `summary_jobs` is intentionally NOT touched (#913 §7 is out of scope;
 * the summary worker and the session_summaries DAG survive this refactor).
 */

import type { MigrationDb } from "./index";

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	if (cols.some((col) => col.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function up(db: MigrationDb): void {
	// --- Agent-scoped fenced lease + priority + planning lifecycle ---
	addColumnIfMissing(db, "memory_jobs", "agent_id", "TEXT");
	addColumnIfMissing(db, "memory_jobs", "lease_owner", "TEXT");
	addColumnIfMissing(db, "memory_jobs", "lease_token", "TEXT");
	addColumnIfMissing(db, "memory_jobs", "lease_expires_at", "TEXT");
	addColumnIfMissing(db, "memory_jobs", "priority", "INTEGER NOT NULL DEFAULT 0");
	addColumnIfMissing(db, "memory_jobs", "planning_attempts", "INTEGER NOT NULL DEFAULT 0");
	addColumnIfMissing(db, "memory_jobs", "planning_started_at", "TEXT");
	addColumnIfMissing(db, "memory_jobs", "last_planning_at", "TEXT");
	addColumnIfMissing(db, "memory_jobs", "plan_hash", "TEXT");

	// Backfill data ownership: documents.agent_id (migration 080, DEFAULT 'default')
	// -> memories.agent_id -> 'default'. Ownership is inferred today through the
	// linked document/memory; make it explicit on the queue row.
	db.exec(`
		UPDATE memory_jobs
		   SET agent_id = COALESCE(
		     (SELECT agent_id FROM documents WHERE id = memory_jobs.document_id),
		     (SELECT agent_id FROM memories  WHERE id = memory_jobs.memory_id),
		     'default')
		 WHERE agent_id IS NULL
	`);

	// Lease lookup: agent-scoped, by status, highest priority first, oldest first.
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_lease
		ON memory_jobs(agent_id, status, priority DESC, created_at)
	`);

	// Reaper lookup: leased/planning/applying rows past their per-row TTL.
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_stale
		ON memory_jobs(status, lease_expires_at)
		WHERE status IN ('leased','planning','applying')
	`);

	// --- Retire the legacy daemon dreaming worker's tables (cutover) ---
	// Only dreaming-worker.ts / dreaming.ts / the constellation summary reference
	// these; all three are deleted in the same PR. IF EXISTS keeps the migration
	// idempotent and safe on DBs that never had a dreaming pass.
	db.exec(`DROP INDEX IF EXISTS idx_dreaming_passes_agent`);
	db.exec(`DROP TABLE IF EXISTS dreaming_passes`);
	db.exec(`DROP TABLE IF EXISTS dreaming_state`);
}
