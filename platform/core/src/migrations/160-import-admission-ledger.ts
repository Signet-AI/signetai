import type { MigrationDb } from "./contract";

/** Durable admission ledger for dashboard uploads and the workspace inbox. */
const ledgerColumns = [
	"key",
	"agent_id",
	"workspace_id",
	"file_name",
	"status",
	"original_path",
	"sha256",
	"size_bytes",
	"request_fingerprint",
	"source_id",
	"lease_token",
	"lease_expires_at",
	"attempt_count",
	"error",
	"created_at",
	"updated_at",
] as const;

function columns(db: MigrationDb, table: string): Set<string> {
	return new Set(
		db
			.prepare(`PRAGMA table_info(${table})`)
			.all()
			.map((row) => String(row.name)),
	);
}

function addMissingColumns(db: MigrationDb, table: string, definitions: readonly string[]): void {
	const present = columns(db, table);
	for (const definition of definitions) {
		const name = definition.split(" ", 1)[0];
		if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
	}
}

function rebuildLedgerWithoutGlobalKeyPrimaryKey(db: MigrationDb): void {
	const keyInfo = db
		.prepare("PRAGMA table_info(import_admission_ledger)")
		.all()
		.find((row) => row.name === "key");
	if (!keyInfo || Number(keyInfo.pk) === 0) return;
	const savepoint = "migration_158_rebuild_ledger";
	db.exec(`SAVEPOINT ${savepoint}`);
	try {
		db.exec(`
			CREATE TABLE import_admission_ledger_v158 (
				key TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '', workspace_id TEXT NOT NULL DEFAULT '',
				file_name TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','processing','imported','duplicate','failed','quarantined','original_unavailable')),
				original_path TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
				request_fingerprint TEXT NOT NULL DEFAULT '', source_id TEXT, lease_token TEXT, lease_expires_at TEXT,
				attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
			);
			INSERT INTO import_admission_ledger_v158 (${ledgerColumns.join(",")})
			SELECT ${ledgerColumns.join(",")} FROM import_admission_ledger;
			DROP TABLE import_admission_ledger;
			ALTER TABLE import_admission_ledger_v158 RENAME TO import_admission_ledger;
		`);
		db.exec(`RELEASE ${savepoint}`);
	} catch (error) {
		try {
			db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
		} finally {
			try {
				db.exec(`RELEASE ${savepoint}`);
			} catch {}
		}
		throw error;
	}
}

/** Durable admission ledger for dashboard uploads and the workspace inbox. */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS import_admission_ledger (
			key TEXT NOT NULL, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT '', file_name TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('pending','processing','imported','duplicate','failed','quarantined','original_unavailable')),
			original_path TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
			request_fingerprint TEXT NOT NULL DEFAULT '', source_id TEXT, lease_token TEXT, lease_expires_at TEXT,
			attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS import_admission_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT, admission_key TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '',
			workspace_id TEXT NOT NULL DEFAULT '', event TEXT NOT NULL, created_at TEXT NOT NULL
		);
	`);
	addMissingColumns(db, "import_admission_ledger", [
		"agent_id TEXT NOT NULL DEFAULT ''",
		"workspace_id TEXT NOT NULL DEFAULT ''",
		"request_fingerprint TEXT NOT NULL DEFAULT ''",
		"source_id TEXT",
		"lease_token TEXT",
		"lease_expires_at TEXT",
		"attempt_count INTEGER NOT NULL DEFAULT 0",
		"error TEXT",
	]);
	addMissingColumns(db, "import_admission_events", [
		"agent_id TEXT NOT NULL DEFAULT ''",
		"workspace_id TEXT NOT NULL DEFAULT ''",
	]);
	rebuildLedgerWithoutGlobalKeyPrimaryKey(db);
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS uq_import_admission_scope_key ON import_admission_ledger(key, agent_id, workspace_id);
		CREATE INDEX IF NOT EXISTS idx_import_admission_status ON import_admission_ledger(agent_id, workspace_id, status, updated_at);
		CREATE INDEX IF NOT EXISTS idx_import_admission_events_key ON import_admission_events(admission_key, agent_id, workspace_id, id);
	`);
}
