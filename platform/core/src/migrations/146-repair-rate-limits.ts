import type { MigrationDb } from "./contract";

const TABLE = "repair_rate_limits";
const LEGACY_TABLE = "repair_rate_limits_legacy";
const REQUIRED_COLUMNS = [
	"action",
	"scope_key",
	"last_run_at",
	"window_started_at",
	"hourly_count",
	"updated_at",
	"lease_id",
	"lease_expires_at",
	"last_error",
	"semantic_cursor",
] as const;

const CREATE_TABLE = `
	CREATE TABLE repair_rate_limits (
		action TEXT NOT NULL,
		scope_key TEXT NOT NULL,
		last_run_at TEXT,
		window_started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		hourly_count INTEGER NOT NULL DEFAULT 0 CHECK (hourly_count >= 0),
		updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		lease_id TEXT,
		lease_expires_at TEXT,
		last_error TEXT,
		semantic_cursor TEXT,
		PRIMARY KEY (action, scope_key)
	);
`;

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function readTableInfo(db: MigrationDb): Array<{ name: string; pk: number }> {
	return db
		.prepare(`PRAGMA table_info(${quoteIdentifier(TABLE)})`)
		.all()
		.flatMap((row) =>
			typeof row.name === "string" && typeof row.pk === "number" ? [{ name: row.name, pk: row.pk }] : [],
		);
}

function createIndex(db: MigrationDb): void {
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_repair_rate_limits_updated
			ON ${quoteIdentifier(TABLE)}(updated_at);
	`);
}

/**
 * Rebuild an incomplete or pre-lease table while preserving any compatible
 * admission history. A stamped-but-partial table must be repaired before the
 * index is created; otherwise startup fails while preparing `updated_at`.
 */
function rebuildIncompleteTable(db: MigrationDb, columns: ReadonlySet<string>): void {
	db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(LEGACY_TABLE)}`);
	db.exec(`ALTER TABLE ${quoteIdentifier(TABLE)} RENAME TO ${quoteIdentifier(LEGACY_TABLE)}`);
	db.exec(CREATE_TABLE);

	const copyable = REQUIRED_COLUMNS.filter((column) => columns.has(column));
	if (columns.has("action") && columns.has("scope_key")) {
		const names = copyable.map(quoteIdentifier).join(", ");
		db.exec(`
			INSERT OR IGNORE INTO ${quoteIdentifier(TABLE)} (${names})
			SELECT ${names} FROM ${quoteIdentifier(LEGACY_TABLE)};
		`);
	}

	db.exec(`DROP TABLE ${quoteIdentifier(LEGACY_TABLE)}`);
}

/**
 * Durable admission history and in-flight claims for repair actions. This
 * migration is deliberately self-healing: released builds may encounter a
 * table created by an interrupted/partial migration, not only a missing table.
 */
export function up(db: MigrationDb): void {
	const tableInfo = readTableInfo(db);
	if (tableInfo.length === 0) {
		db.exec(CREATE_TABLE);
	} else {
		const columns = new Set(tableInfo.map((row) => row.name));
		const primaryKey = tableInfo
			.filter((row) => row.pk > 0)
			.sort((left, right) => left.pk - right.pk)
			.map((row) => row.name);
		const complete =
			REQUIRED_COLUMNS.every((column) => columns.has(column)) &&
			primaryKey.length === 2 &&
			primaryKey[0] === "action" &&
			primaryKey[1] === "scope_key";
		if (!complete) rebuildIncompleteTable(db, columns);
	}
	createIndex(db);
}
