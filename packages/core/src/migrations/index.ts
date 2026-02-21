/**
 * Migration runner for Signet's SQLite database
 *
 * Reads the current schema version from `schema_migrations`, runs
 * any pending migrations in order (each inside a transaction), and
 * records execution in `schema_migrations_audit`.
 */

import { up as baseline } from "./001-baseline";
import { up as pipelineV2 } from "./002-pipeline-v2";
import { up as uniqueContentHash } from "./003-unique-content-hash";
import { up as historyActorAndRetention } from "./004-history-actor-and-retention";
import { up as graphExtended } from "./005-graph-extended";
import { up as idempotencyKey } from "./006-idempotency-key";
import { up as documentsAndConnectors } from "./007-documents-and-connectors";
import { up as embeddingsUniqueHash } from "./008-embeddings-unique-hash";

// -- Public interface consumed by Database.init() --

export interface MigrationDb {
	exec(sql: string): void;
	prepare(sql: string): {
		run(...args: unknown[]): void;
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
}

export interface Migration {
	readonly version: number;
	readonly name: string;
	readonly up: (db: MigrationDb) => void;
}

/** Ordered list of all migrations. New migrations go at the end. */
export const MIGRATIONS: readonly Migration[] = [
	{ version: 1, name: "baseline", up: baseline },
	{ version: 2, name: "pipeline-v2", up: pipelineV2 },
	{ version: 3, name: "unique-content-hash", up: uniqueContentHash },
	{
		version: 4,
		name: "history-actor-and-retention",
		up: historyActorAndRetention,
	},
	{ version: 5, name: "graph-extended", up: graphExtended },
	{ version: 6, name: "idempotency-key", up: idempotencyKey },
	{
		version: 7,
		name: "documents-and-connectors",
		up: documentsAndConnectors,
	},
	{
		version: 8,
		name: "embeddings-unique-hash",
		up: embeddingsUniqueHash,
	},
];

/** Simple checksum for audit trail (hash of migration name + version). */
function checksum(m: Migration): string {
	let h = 0;
	const s = `${m.version}:${m.name}`;
	for (let i = 0; i < s.length; i++) {
		h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	}
	return h.toString(16);
}

/**
 * Ensure schema_migrations and schema_migrations_audit tables exist.
 * Called before reading current version so the queries don't fail
 * on a brand-new database.
 */
function ensureMetaTables(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL,
			checksum TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS schema_migrations_audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			version INTEGER NOT NULL,
			applied_at TEXT NOT NULL,
			duration_ms INTEGER,
			checksum TEXT
		);
	`);
}

/** Read the highest applied version, or 0 if none. */
function currentVersion(db: MigrationDb): number {
	const row = db
		.prepare("SELECT MAX(version) as version FROM schema_migrations")
		.get();
	if (row === undefined) return 0;
	const v = row.version;
	return typeof v === "number" ? v : 0;
}

/**
 * Detect and repair the v0.1.65 CLI bug where schema_migrations was
 * stamped at version 2 without actually running migration 002.
 *
 * If version >= 2 but the memories table lacks the `content_hash`
 * column (added by 002), the version rows are bogus. Delete them
 * and return 0 so all migrations re-run. This is safe because every
 * migration uses CREATE IF NOT EXISTS / addColumnIfMissing.
 */
function repairBogusVersion(db: MigrationDb, current: number): number {
	if (current < 2) return current;
	const cols = db.prepare("PRAGMA table_info(memories)").all() as ReadonlyArray<
		Record<string, unknown>
	>;
	const hasContentHash = cols.some((r) => r.name === "content_hash");
	if (hasContentHash) return current;
	// Version was stamped by old CLI without running actual migrations
	db.exec("DELETE FROM schema_migrations WHERE version > 0");
	return 0;
}

/**
 * Run all pending migrations against `db`.
 *
 * Idempotent — safe to call on every startup. Migrations that have
 * already been applied (tracked in `schema_migrations`) are skipped.
 * Each migration runs inside a SAVEPOINT so a failure rolls back
 * only that migration.
 */
export function runMigrations(db: MigrationDb): void {
	ensureMetaTables(db);

	const current = repairBogusVersion(db, currentVersion(db));

	for (const migration of MIGRATIONS) {
		if (migration.version <= current) continue;

		const start = Date.now();
		const cs = checksum(migration);

		// Use SAVEPOINT for nested-transaction safety
		db.exec(`SAVEPOINT migration_${migration.version}`);
		try {
			migration.up(db);

			db.prepare(
				`INSERT OR REPLACE INTO schema_migrations
				 (version, applied_at, checksum)
				 VALUES (?, ?, ?)`,
			).run(migration.version, new Date().toISOString(), cs);

			db.prepare(
				`INSERT INTO schema_migrations_audit
				 (version, applied_at, duration_ms, checksum)
				 VALUES (?, ?, ?, ?)`,
			).run(
				migration.version,
				new Date().toISOString(),
				Date.now() - start,
				cs,
			);

			db.exec(`RELEASE migration_${migration.version}`);
		} catch (err) {
			db.exec(`ROLLBACK TO SAVEPOINT migration_${migration.version}`);
			db.exec(`RELEASE migration_${migration.version}`);
			throw new Error(
				`Migration ${migration.version} (${migration.name}) failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
}
