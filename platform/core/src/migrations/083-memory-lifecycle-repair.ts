import { up as transcriptCaptureJobs } from "./079-transcript-capture-jobs";
import { up as documentScopeColumns } from "./080-document-scope-columns";
import { up as aggregateEvidenceSources } from "./081-aggregate-evidence-sources";
import type { MigrationDb } from "./index";

const DEPENDENCY_TYPES = new Set([
	"uses",
	"requires",
	"owned_by",
	"owns",
	"blocks",
	"informs",
	"maintains",
	"implements",
	"built",
	"depends_on",
	"related_to",
	"learned_from",
	"teaches",
	"knows",
	"assumes",
	"supports_claim",
	"authored_by",
	"links_to",
	"contains",
	"contains_note",
	"contradicts",
	"supersedes",
	"part_of",
	"produced_artifact",
	"precedes",
	"follows",
	"triggers",
	"may_execute",
	"requires_approval_from",
	"impacts",
	"produces",
	"consumes",
]);

function sqlStringList(values: ReadonlySet<string>): string {
	return [...values].map((value) => `'${value}'`).join(", ");
}

function hasTable(db: MigrationDb, table: string): boolean {
	return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	return rows.some((row) => row.name === column);
}

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function documentScopeColumnsPreservingExisting(db: MigrationDb): void {
	const preserveAgentId = hasColumn(db, "documents", "agent_id");
	const preserveProject = hasColumn(db, "documents", "project");
	if (preserveAgentId) {
		db.exec(`
			CREATE TEMP TABLE __signet_doc_agent_guard AS
			SELECT id, agent_id FROM documents
			WHERE NULLIF(TRIM(agent_id), '') IS NOT NULL
			  AND NULLIF(TRIM(agent_id), '') <> 'default'
		`);
	}
	if (preserveProject) {
		db.exec(`
			CREATE TEMP TABLE __signet_doc_project_guard AS
			SELECT id, project FROM documents
			WHERE NULLIF(TRIM(project), '') IS NOT NULL
		`);
	}
	try {
		documentScopeColumns(db);
		if (preserveAgentId) {
			db.exec(`
				UPDATE documents
				SET agent_id = (SELECT agent_id FROM __signet_doc_agent_guard WHERE __signet_doc_agent_guard.id = documents.id)
				WHERE EXISTS (SELECT 1 FROM __signet_doc_agent_guard WHERE __signet_doc_agent_guard.id = documents.id)
			`);
		}
		if (preserveProject) {
			db.exec(`
				UPDATE documents
				SET project = (SELECT project FROM __signet_doc_project_guard WHERE __signet_doc_project_guard.id = documents.id)
				WHERE EXISTS (SELECT 1 FROM __signet_doc_project_guard WHERE __signet_doc_project_guard.id = documents.id)
			`);
		}
	} finally {
		db.exec("DROP TABLE IF EXISTS temp.__signet_doc_agent_guard");
		db.exec("DROP TABLE IF EXISTS temp.__signet_doc_project_guard");
	}
}

export function up(db: MigrationDb): void {
	// Long-lived mac DBs used versions 79-81 for local memory lifecycle patches
	// before upstream assigned those versions. Re-run upstream's idempotent 79-81
	// migrations here so collided DBs get the upstream artifacts too.
	transcriptCaptureJobs(db);
	if (hasTable(db, "documents")) {
		documentScopeColumnsPreservingExisting(db);
	}
	aggregateEvidenceSources(db);

	addColumnIfMissing(db, "memories", "superseded_by", "TEXT");
	addColumnIfMissing(db, "memories", "superseded_at", "TEXT");
	addColumnIfMissing(db, "memories", "superseded_reason", "TEXT");
	db.exec("CREATE INDEX IF NOT EXISTS idx_memories_superseded_by ON memories(superseded_by)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_memories_active_supersession ON memories(is_deleted, superseded_by)");

	if (!hasTable(db, "relations") || !hasTable(db, "entity_dependencies")) return;

	addColumnIfMissing(db, "entity_dependencies", "confidence", "REAL");
	addColumnIfMissing(db, "entity_dependencies", "reason", "TEXT");
	addColumnIfMissing(db, "entity_dependencies", "source_id", "TEXT");
	addColumnIfMissing(db, "entity_dependencies", "source_kind", "TEXT");
	addColumnIfMissing(db, "entity_dependencies", "proposal_evidence", "TEXT NOT NULL DEFAULT '[]'");
	addColumnIfMissing(db, "entity_dependencies", "status", "TEXT NOT NULL DEFAULT 'active'");

	const relationConfidence = hasColumn(db, "relations", "confidence") ? "r.confidence" : "NULL";
	const relationUpdatedAt = hasColumn(db, "relations", "updated_at") ? "r.updated_at" : "r.created_at";
	const sourceAgentId = hasColumn(db, "entities", "agent_id")
		? "COALESCE(NULLIF(TRIM(src.agent_id), ''), 'default')"
		: "'default'";
	const targetAgentId = hasColumn(db, "entities", "agent_id")
		? "COALESCE(NULLIF(TRIM(dst.agent_id), ''), 'default')"
		: "'default'";

	db.exec(`
		INSERT OR IGNORE INTO entity_dependencies (
			id,
			source_entity_id,
			target_entity_id,
			agent_id,
			dependency_type,
			strength,
			confidence,
			reason,
			created_at,
			updated_at,
			source_id,
			source_kind,
			proposal_evidence,
			status
		)
		SELECT
			'relation:' || r.id,
			r.source_entity_id,
			r.target_entity_id,
			COALESCE(${sourceAgentId}, ${targetAgentId}, 'default'),
			CASE WHEN r.relation_type IN (${sqlStringList(DEPENDENCY_TYPES)}) THEN r.relation_type ELSE 'related_to' END,
			MAX(0.1, MIN(1.0, COALESCE(r.strength, 0.5))),
			MAX(0.1, MIN(1.0, COALESCE(${relationConfidence}, 0.7))),
			'legacy relation backfill: ' || r.relation_type,
			COALESCE(r.created_at, datetime('now')),
			COALESCE(${relationUpdatedAt}, r.created_at, datetime('now')),
			r.id,
			'relation',
			'[]',
			'active'
		FROM relations r
		JOIN entities src ON src.id = r.source_entity_id
		JOIN entities dst ON dst.id = r.target_entity_id
		WHERE r.source_entity_id <> r.target_entity_id
		  AND ${sourceAgentId} = ${targetAgentId}
	`);
}
