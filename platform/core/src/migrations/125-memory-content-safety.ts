/**
 * Migration 125: derived memory-content safety ledger.
 *
 * The ledger is deliberately separate from source rows. Raw memories,
 * artifacts, transcripts, and summaries remain immutable and inspectable;
 * this table records only the policy decision used by prompt-facing readers.
 */
import { MEMORY_CONTENT_SAFETY_POLICY_VERSION, scanMemoryContent } from "../memory-content-safety";
import type { MigrationDb } from "./index";

type SafetyRow = {
	readonly agent_id: string | null;
	readonly source_id: string | null;
	readonly content: string | null;
};

function tableExists(db: MigrationDb, table: string): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null;
}

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name?: unknown }>).some(
		(row) => row.name === column,
	);
}

function backfill(
	db: MigrationDb,
	rows: readonly SafetyRow[],
	sourceKind: "memory" | "artifact" | "transcript" | "summary" | "source_chunk",
	scannedAt: string,
): void {
	const statement = db.prepare(
		`INSERT INTO memory_content_safety
		 (agent_id, source_kind, source_id, status, context_eligible, reasons_json, policy_version, scanned_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(agent_id, source_kind, source_id) DO UPDATE SET
		   status = excluded.status,
		   context_eligible = excluded.context_eligible,
		   reasons_json = excluded.reasons_json,
		   policy_version = excluded.policy_version,
		   scanned_at = excluded.scanned_at`,
	);
	for (const row of rows) {
		const sourceId = row.source_id?.trim();
		if (!sourceId) continue;
		const assessment = scanMemoryContent(row.content ?? "");
		statement.run(
			row.agent_id?.trim() || "default",
			sourceKind,
			sourceId,
			assessment.status,
			assessment.contextEligible ? 1 : 0,
			JSON.stringify(assessment.reasons),
			MEMORY_CONTENT_SAFETY_POLICY_VERSION,
			scannedAt,
		);
	}
}

function backfillTable(
	db: MigrationDb,
	params: {
		readonly table: string;
		readonly sourceKind: "memory" | "artifact" | "transcript" | "summary" | "source_chunk";
		readonly sourceIdColumn: string;
		readonly contentColumn: string;
		readonly where?: string;
		readonly scannedAt: string;
	},
): void {
	if (
		!tableExists(db, params.table) ||
		!hasColumn(db, params.table, params.sourceIdColumn) ||
		!hasColumn(db, params.table, params.contentColumn)
	)
		return;
	const agentColumn = hasColumn(db, params.table, "agent_id")
		? "COALESCE(NULLIF(TRIM(agent_id), ''), 'default')"
		: "'default'";
	const rows = db
		.prepare(
			`SELECT ${agentColumn} AS agent_id, ${params.sourceIdColumn} AS source_id, ${params.contentColumn} AS content
			 FROM ${params.table}${params.where ? ` WHERE ${params.where}` : ""}`,
		)
		.all() as SafetyRow[];
	backfill(db, rows, params.sourceKind, params.scannedAt);
}

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_content_safety (
			agent_id TEXT NOT NULL,
			source_kind TEXT NOT NULL CHECK (source_kind IN ('memory', 'artifact', 'transcript', 'summary', 'source_chunk')),
			source_id TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('clean', 'tainted', 'blocked')),
			context_eligible INTEGER NOT NULL CHECK (context_eligible IN (0, 1)),
			reasons_json TEXT NOT NULL DEFAULT '[]',
			policy_version TEXT NOT NULL,
			scanned_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, source_kind, source_id)
		);

		CREATE INDEX IF NOT EXISTS idx_memory_content_safety_status
			ON memory_content_safety(agent_id, status, source_kind);
		CREATE INDEX IF NOT EXISTS idx_memory_content_safety_eligibility
			ON memory_content_safety(agent_id, source_kind, context_eligible);
	`);

	const scannedAt = new Date().toISOString();
	backfillTable(db, {
		table: "memories",
		sourceKind: "memory",
		sourceIdColumn: "id",
		contentColumn: "content",
		scannedAt,
	});
	backfillTable(db, {
		table: "memory_artifacts",
		sourceKind: "artifact",
		sourceIdColumn: "source_path",
		contentColumn: "content",
		scannedAt,
	});
	backfillTable(db, {
		table: "session_transcripts",
		sourceKind: "transcript",
		sourceIdColumn: "session_key",
		contentColumn: "content",
		scannedAt,
	});
	backfillTable(db, {
		table: "session_summaries",
		sourceKind: "summary",
		sourceIdColumn: "id",
		contentColumn: "content",
		scannedAt,
	});
	backfillTable(db, {
		table: "embeddings",
		sourceKind: "source_chunk",
		sourceIdColumn: "id",
		contentColumn: "chunk_text",
		where: "source_type IN ('source_chunk', 'source_obsidian_chunk')",
		scannedAt,
	});
}
