import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	const columns = db.prepare("PRAGMA table_info(dreaming_evidence_exclusions)").all() as Array<{ name: string }>;
	const names = new Set(columns.map((column) => column.name));
	if (!names.has("failure_class")) {
		db.exec(
			"ALTER TABLE dreaming_evidence_exclusions ADD COLUMN failure_class TEXT NOT NULL DEFAULT 'unknown' CHECK (failure_class IN ('incomplete_transcript', 'source_projection', 'scope_mismatch', 'quote_mismatch', 'unknown'))",
		);
	}
	if (!names.has("source_fingerprint")) {
		db.exec("ALTER TABLE dreaming_evidence_exclusions ADD COLUMN source_fingerprint TEXT");
	}
	if (!names.has("retry_count")) {
		db.exec("ALTER TABLE dreaming_evidence_exclusions ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
	}
	if (!names.has("last_requeued_at")) {
		db.exec("ALTER TABLE dreaming_evidence_exclusions ADD COLUMN last_requeued_at TEXT");
	}
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_dreaming_evidence_exclusions_retry ON dreaming_evidence_exclusions (resolved_at, requeue_requested_at, failure_class, retry_count, last_requeued_at)",
	);
}
