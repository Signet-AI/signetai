import type { MigrationDb } from "./contract";

function partitionDreamingHistory(db: MigrationDb): void {
	if (
		db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_dreaming_history_nodes_partition'")
			.get()
	)
		return;
	db.exec(`
		CREATE TABLE dreaming_history_nodes_v179 (
			agent_id TEXT NOT NULL, scope_key TEXT NOT NULL, level INTEGER NOT NULL, idx INTEGER NOT NULL,
			pass_id TEXT, text TEXT NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER,
			created_at TEXT NOT NULL DEFAULT (datetime('now')), compartment_id INTEGER
		);
		INSERT INTO dreaming_history_nodes_v179
			(agent_id,scope_key,level,idx,pass_id,text,tokens_input,tokens_output,tokens_cache_read,created_at,compartment_id)
		SELECT h.agent_id,h.scope_key,0,
			ROW_NUMBER() OVER (PARTITION BY h.agent_id,h.scope_key,h.compartment_id ORDER BY h.idx) - 1,
			h.pass_id,h.text,h.tokens_input,h.tokens_output,h.tokens_cache_read,h.created_at,h.compartment_id
		FROM dreaming_history_nodes h JOIN dreaming_passes p ON p.id = h.pass_id
		WHERE h.level = 0 AND p.agent_id = h.agent_id AND p.compartment_id IS h.compartment_id
		AND COALESCE(NULLIF(p.scope_key, ''), p.agent_id) = h.scope_key AND p.status != 'running'
		AND p.classification_epoch = (SELECT epoch FROM dreaming_classification_epoch WHERE id = 1)
		AND NOT EXISTS (SELECT 1 FROM dreaming_tool_calls call WHERE call.pass_id = p.id
			AND (call.agent_id != p.agent_id OR call.compartment_id IS NOT p.compartment_id));
		DROP TABLE dreaming_history_nodes;
		ALTER TABLE dreaming_history_nodes_v179 RENAME TO dreaming_history_nodes;
		CREATE UNIQUE INDEX idx_dreaming_history_nodes_partition
		ON dreaming_history_nodes(agent_id,scope_key,COALESCE(compartment_id,0),level,idx);
		CREATE UNIQUE INDEX idx_dreaming_history_nodes_pass ON dreaming_history_nodes(pass_id) WHERE pass_id IS NOT NULL;
		CREATE INDEX idx_dreaming_history_nodes_compartment ON dreaming_history_nodes(agent_id,compartment_id);
	`);
}

export function up(db: MigrationDb): void {
	for (const [table, column, declaration] of [
		["ontology_proposals", "dreaming_pass_id", "TEXT"],
		["entities", "dreaming_pass_id", "TEXT"],
		["dreaming_attention", "dreaming_pass_id", "TEXT"],
		["memory_head_revisions", "compartment_id", "INTEGER"],
		["memory_head_publications", "compartment_id", "INTEGER"],
		["dreaming_passes", "classification_epoch", "INTEGER NOT NULL DEFAULT 0"],
	]) {
		if (!table || !column || !declaration) throw new Error("Invalid migration column");
		const columns = db.prepare(`PRAGMA table_info(${table})`).all();
		if (!columns.some((row) => row.name === column))
			db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
	}
	db.exec(`
		CREATE TABLE IF NOT EXISTS dreaming_classification_epoch (
			id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL
		);
		INSERT OR IGNORE INTO dreaming_classification_epoch (id, epoch) VALUES (1, 0);
		CREATE TRIGGER IF NOT EXISTS dreaming_pass_classification_epoch AFTER INSERT ON dreaming_passes BEGIN
			UPDATE dreaming_passes SET classification_epoch = (SELECT epoch FROM dreaming_classification_epoch WHERE id = 1)
			WHERE id = NEW.id;
		END;
		CREATE TRIGGER IF NOT EXISTS dreaming_pass_completion_epoch BEFORE UPDATE OF status ON dreaming_passes
		WHEN OLD.status='running' AND NEW.status='completed' AND NEW.classification_epoch != (SELECT epoch FROM dreaming_classification_epoch WHERE id=1)
		BEGIN SELECT RAISE(ABORT,'compartment_mismatch'); END;
		CREATE TABLE IF NOT EXISTS dreaming_evidence_leases (
			agent_id TEXT NOT NULL,
			compartment_id INTEGER CHECK (compartment_id IS NULL OR compartment_id > 0),
			source_kind TEXT NOT NULL CHECK (source_kind IN ('memory', 'artifact', 'transcript', 'summary')),
			source_id TEXT NOT NULL,
			pass_id TEXT NOT NULL,
			leased_at TEXT NOT NULL,
			expires_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_dreaming_evidence_lease_partition
		ON dreaming_evidence_leases (agent_id, COALESCE(compartment_id, 0), source_kind, source_id);
		CREATE INDEX IF NOT EXISTS idx_dreaming_evidence_leases_pass ON dreaming_evidence_leases (pass_id);
	`);
	for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
		db.exec(`CREATE TRIGGER IF NOT EXISTS dreaming_classification_epoch_${operation.toLowerCase()}
		AFTER ${operation} ON classification_assignments BEGIN
			UPDATE dreaming_classification_epoch SET epoch = epoch + 1 WHERE id = 1;
		END;`);
	}
	partitionMemoryHeads(db);
	partitionDreamingHistory(db);
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_memory_artifacts_dreaming_partition_path ON memory_artifacts(agent_id,compartment_id,source_path)",
	);
	partitionDreamingState(db);
	extendDreamingCitations(db);
	for (const operation of ["INSERT", "UPDATE"]) {
		db.exec(`CREATE TRIGGER IF NOT EXISTS dreaming_evidence_lease_${operation.toLowerCase()}
		BEFORE ${operation} ON dreaming_evidence_leases BEGIN
			SELECT CASE WHEN NOT EXISTS (
				SELECT 1 FROM dreaming_passes p JOIN dreaming_classification_epoch e ON e.id = 1
				WHERE p.id = NEW.pass_id AND p.status = 'running'
				AND p.compartment_id IS NEW.compartment_id AND p.classification_epoch = e.epoch
				AND NOT EXISTS(SELECT 1 FROM org_jobs WHERE kind IN ('classify','unclassify') AND status IN ('pending','running'))
				AND instr(',' || COALESCE(NULLIF(p.scope_key, ''), p.agent_id) || ',', ',' || NEW.agent_id || ',') > 0
			) THEN RAISE(ABORT, 'compartment_mismatch') END;
			SELECT CASE WHEN EXISTS (
				SELECT 1 FROM agents a WHERE a.id = NEW.agent_id AND (a.archived_at IS NOT NULL OR
				(a.kind = 'organization' AND EXISTS (SELECT 1 FROM organization o
				WHERE o.id = 1 AND o.claimed_at IS NOT NULL AND o.agent_model = 'personal')))
			) THEN RAISE(ABORT, 'org_policy') END;
			SELECT CASE WHEN NOT EXISTS (
				SELECT 1 FROM memories WHERE NEW.source_kind = 'memory' AND id = NEW.source_id
				AND agent_id = NEW.agent_id AND compartment_id IS NEW.compartment_id AND is_deleted = 0
				UNION ALL SELECT 1 FROM memory_artifacts WHERE NEW.source_kind = 'artifact' AND source_path = NEW.source_id
				AND agent_id = NEW.agent_id AND compartment_id IS NEW.compartment_id AND is_deleted = 0
				UNION ALL SELECT 1 FROM session_transcripts WHERE NEW.source_kind = 'transcript' AND session_key = NEW.source_id
				AND agent_id = NEW.agent_id AND compartment_id IS NEW.compartment_id
				UNION ALL SELECT 1 FROM session_summaries WHERE NEW.source_kind = 'summary' AND id = NEW.source_id
				AND agent_id = NEW.agent_id AND compartment_id IS NEW.compartment_id
			) THEN RAISE(ABORT, 'compartment_mismatch') END;
		END;`);
	}
}

function partitionMemoryHeads(db: MigrationDb): void {
	const installed = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_memory_head_revisions_partition'").get();
	if (!installed) {
		db.exec(`
			CREATE TABLE memory_head_revisions_v179 (
				id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, revision INTEGER NOT NULL,
				content TEXT NOT NULL, content_hash TEXT NOT NULL, rendered_token_count INTEGER NOT NULL,
				pass_id TEXT NOT NULL, base_revision INTEGER NOT NULL, base_hash TEXT NOT NULL, created_at TEXT NOT NULL,
				entry_id TEXT, entry_text TEXT, operation TEXT, source_refs_json TEXT, supporting_quotes_json TEXT,
				compartment_id INTEGER, is_current INTEGER NOT NULL DEFAULT 1
			);
			INSERT INTO memory_head_revisions_v179 SELECT id,agent_id,revision,content,content_hash,rendered_token_count,
				pass_id,base_revision,base_hash,created_at,entry_id,entry_text,operation,source_refs_json,supporting_quotes_json,compartment_id,1
				FROM memory_head_revisions;
			DROP TABLE memory_head_revisions;
			ALTER TABLE memory_head_revisions_v179 RENAME TO memory_head_revisions;
			CREATE UNIQUE INDEX idx_memory_head_revisions_partition ON memory_head_revisions(agent_id,COALESCE(compartment_id,0),revision);
			CREATE INDEX idx_memory_head_revisions_agent ON memory_head_revisions(agent_id,compartment_id,revision DESC);
			CREATE INDEX idx_memory_head_revisions_content_hash ON memory_head_revisions(content_hash);
			CREATE UNIQUE INDEX idx_memory_head_revisions_entry ON memory_head_revisions(agent_id,COALESCE(compartment_id,0),revision,entry_id);
			CREATE TABLE memory_head_revision_entries_v179 (
				agent_id TEXT NOT NULL, revision INTEGER NOT NULL, entry_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
				operation TEXT NOT NULL CHECK(operation IN ('add','update','remove','retain')), provenance_json TEXT NOT NULL,
				compartment_id INTEGER, pass_id TEXT, revision_id TEXT
			);
			INSERT INTO memory_head_revision_entries_v179 SELECT e.agent_id,e.revision,e.entry_id,e.ordinal,e.operation,e.provenance_json,e.compartment_id,r.pass_id,r.id
				FROM memory_head_revision_entries e LEFT JOIN memory_head_revisions r ON r.agent_id=e.agent_id AND r.revision=e.revision AND r.compartment_id IS e.compartment_id;
			DROP TABLE memory_head_revision_entries;
			ALTER TABLE memory_head_revision_entries_v179 RENAME TO memory_head_revision_entries;
			CREATE UNIQUE INDEX idx_memory_head_revision_entries_partition ON memory_head_revision_entries(agent_id,COALESCE(compartment_id,0),revision,entry_id);
			CREATE UNIQUE INDEX idx_memory_head_revision_entries_ordinal ON memory_head_revision_entries(agent_id,COALESCE(compartment_id,0),revision,ordinal);
			CREATE INDEX idx_memory_head_revision_entries_entry ON memory_head_revision_entries(agent_id,entry_id,compartment_id,revision DESC);
			CREATE TABLE memory_head_publications_v179 (
				agent_id TEXT NOT NULL, revision INTEGER NOT NULL, revision_id TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('pending','completed')), created_at TEXT NOT NULL, completed_at TEXT, compartment_id INTEGER,
				UNIQUE(agent_id,revision_id)
			);
			INSERT INTO memory_head_publications_v179 SELECT agent_id,revision,revision_id,status,created_at,completed_at,compartment_id FROM memory_head_publications;
			DROP TABLE memory_head_publications;
			ALTER TABLE memory_head_publications_v179 RENAME TO memory_head_publications;
			CREATE UNIQUE INDEX idx_memory_head_publications_partition ON memory_head_publications(agent_id,COALESCE(compartment_id,0),revision);
			CREATE INDEX idx_memory_head_publications_pending ON memory_head_publications(agent_id,compartment_id,status,revision DESC);
		`);
	}
	const entryColumns = db.prepare("PRAGMA table_info(memory_head_entries)").all();
	if (!entryColumns.some((row) => row.name === "pass_id"))
		db.exec("ALTER TABLE memory_head_entries ADD COLUMN pass_id TEXT");
	db.exec(`
		DROP TRIGGER IF EXISTS dreaming_passes_head_fence_ai;
		CREATE TRIGGER dreaming_passes_head_fence_ai AFTER INSERT ON dreaming_passes WHEN NEW.mode = 'incremental-content' BEGIN
			INSERT OR IGNORE INTO memory_md_heads(agent_id,content,content_hash,revision,updated_at,is_current)
				SELECT NEW.agent_id,'','',0,datetime('now'),0 WHERE NEW.compartment_id IS NULL;
			UPDATE dreaming_passes SET head_base_revision = CASE WHEN NEW.compartment_id IS NULL
				THEN (SELECT revision FROM memory_md_heads WHERE agent_id=NEW.agent_id)
				ELSE COALESCE((SELECT MAX(revision) FROM memory_head_revisions WHERE agent_id=NEW.agent_id AND compartment_id IS NEW.compartment_id),0) END WHERE id=NEW.id;
		END;
	`);
	for (const table of ["memories", "memory_artifacts", "session_transcripts", "session_summaries"]) {
		const subset = (
			row: string,
			label: string,
		) => `(${row}.compartment_id IS NULL OR (${label} IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM compartment_members evidence WHERE evidence.compartment_id=${row}.compartment_id AND NOT EXISTS (
				SELECT 1 FROM compartment_members audience WHERE audience.compartment_id=${label} AND audience.classification_id=evidence.classification_id))))`;
		for (const operation of ["UPDATE", "DELETE"]) {
			const suffix = operation === "UPDATE" ? "au" : "ad";
			const agents = operation === "UPDATE" ? "(OLD.agent_id,NEW.agent_id)" : "(OLD.agent_id)";
			const globalMemory =
				operation === "UPDATE"
					? "(COALESCE(OLD.visibility,'global')='global' OR COALESCE(NEW.visibility,'global')='global')"
					: "COALESCE(OLD.visibility,'global')='global'";
			const publicAgents =
				table === "memories"
					? `(agent_id IN ${agents} OR (${globalMemory} AND (agent_id IN (SELECT id FROM agents WHERE read_policy='shared') OR agent_id IN (SELECT id FROM agents WHERE read_policy='group' AND policy_group IN (SELECT policy_group FROM agents WHERE id IN ${agents})))) )`
					: `agent_id IN ${agents}`;
			const visible =
				operation === "UPDATE"
					? "(OLD.compartment_id IS NULL OR NEW.compartment_id IS NULL)"
					: "OLD.compartment_id IS NULL";
			const revisionVisible =
				operation === "UPDATE"
					? `(${subset("OLD", "memory_head_revisions.compartment_id")} OR ${subset("NEW", "memory_head_revisions.compartment_id")})`
					: subset("OLD", "memory_head_revisions.compartment_id");
			const passVisible =
				operation === "UPDATE"
					? `(${subset("OLD", "dreaming_passes.compartment_id")} OR ${subset("NEW", "dreaming_passes.compartment_id")})`
					: subset("OLD", "dreaming_passes.compartment_id");
			const contentChanged =
				table === "memories"
					? "OLD.content IS NOT NEW.content OR OLD.superseded_by IS NOT NEW.superseded_by OR OLD.stale_at IS NOT NEW.stale_at OR OLD.is_deleted IS NOT NEW.is_deleted OR OLD.visibility IS NOT NEW.visibility OR OLD.scope IS NOT NEW.scope OR OLD.memory_kind IS NOT NEW.memory_kind"
					: table === "memory_artifacts"
						? "OLD.content IS NOT NEW.content OR OLD.is_deleted IS NOT NEW.is_deleted"
						: table === "session_transcripts"
							? "(OLD.completed_at IS NOT NULL AND (OLD.content IS NOT NEW.content OR NEW.completed_at IS NULL))"
							: "(OLD.content IS NOT NEW.content OR OLD.source_ref IS NOT NEW.source_ref OR OLD.source_type IS NOT NEW.source_type OR OLD.depth IS NOT NEW.depth)";
			const changed =
				operation === "UPDATE"
					? ` WHEN ${table === "session_summaries" ? "(OLD.depth=0 OR NEW.depth=0) AND" : ""} (OLD.agent_id IS NOT NEW.agent_id OR OLD.compartment_id IS NOT NEW.compartment_id OR ${contentChanged})`
					: table === "session_summaries"
						? " WHEN OLD.depth=0"
						: "";
			db.exec(`DROP TRIGGER IF EXISTS ${table}_head_freshness_${suffix};
				CREATE TRIGGER ${table}_head_freshness_${suffix} AFTER ${operation} ON ${table}${changed} BEGIN
					UPDATE memory_md_heads SET revision=revision+1,is_current=0 WHERE ${publicAgents} AND ${visible};
					UPDATE memory_head_revisions SET is_current=0 WHERE agent_id IN ${agents} AND ${revisionVisible};
					UPDATE dreaming_passes SET head_base_revision=-1 WHERE status='running' AND mode='incremental-content' AND agent_id IN ${agents} AND ${passVisible};
				END;`);
		}
	}
}

function partitionDreamingState(db: MigrationDb): void {
	if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_dreaming_state_partition'").get()) return;
	db.exec(`
		CREATE TABLE dreaming_state_v179 (
			agent_id TEXT NOT NULL, compartment_id INTEGER,
			tokens_since_last_pass INTEGER NOT NULL DEFAULT 0,
			consecutive_failures INTEGER NOT NULL DEFAULT 0,
			last_pass_at TEXT, last_pass_id TEXT, last_pass_mode TEXT, evidence_cursor TEXT, last_failure_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		INSERT INTO dreaming_state_v179(agent_id,tokens_since_last_pass,consecutive_failures,last_pass_at,last_pass_id,last_pass_mode,evidence_cursor,last_failure_at,created_at,updated_at)
			SELECT agent_id,tokens_since_last_pass,consecutive_failures,last_pass_at,last_pass_id,last_pass_mode,evidence_cursor,last_failure_at,created_at,updated_at FROM dreaming_state;
		DROP TABLE dreaming_state;
		ALTER TABLE dreaming_state_v179 RENAME TO dreaming_state;
		CREATE UNIQUE INDEX idx_dreaming_state_partition ON dreaming_state(agent_id,COALESCE(compartment_id,0));
	`);
}

function extendDreamingCitations(db: MigrationDb): void {
	const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='evidence_citations'").get();
	if (typeof definition?.sql === "string" && definition.sql.includes("'attention'")) return;
	db.exec(`
		CREATE TABLE evidence_citations_v179 (
			derived_kind TEXT NOT NULL CHECK(derived_kind IN ('attribute','memory','dependency','entity','aspect','assertion','head_entry','reflection','contradiction','head_revision','proposal','telemetry','temporal_edge','attention')),
			derived_id TEXT NOT NULL, agent_id TEXT NOT NULL,
			evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('memory','transcript','artifact','summary','attribute')),
			evidence_id TEXT NOT NULL,
			PRIMARY KEY(derived_kind,derived_id,evidence_kind,evidence_id)
		);
		INSERT INTO evidence_citations_v179 SELECT derived_kind,derived_id,agent_id,evidence_kind,evidence_id FROM evidence_citations;
		DROP TABLE evidence_citations;
		ALTER TABLE evidence_citations_v179 RENAME TO evidence_citations;
		CREATE INDEX idx_evidence_citations_reverse ON evidence_citations(agent_id,evidence_kind,evidence_id);
	`);
}
