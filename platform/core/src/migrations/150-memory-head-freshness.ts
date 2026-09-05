import type { MigrationDb } from "./contract";

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	if (!columns.some((row) => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** Migration 150: fence generated memory heads against source changes. */
export function up(db: MigrationDb): void {
	addColumnIfMissing(db, "memory_md_heads", "is_current", "INTEGER NOT NULL DEFAULT 0");
	addColumnIfMissing(db, "dreaming_passes", "head_base_revision", "INTEGER");
	db.exec("CREATE INDEX IF NOT EXISTS idx_memory_head_revisions_content_hash ON memory_head_revisions(content_hash)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_memory_md_heads_content_hash ON memory_md_heads(content_hash)");

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS dreaming_passes_head_fence_ai
		AFTER INSERT ON dreaming_passes
		WHEN NEW.mode = 'incremental-content'
		BEGIN
			INSERT OR IGNORE INTO memory_md_heads (agent_id, content, content_hash, revision, updated_at, is_current)
			VALUES (NEW.agent_id, '', '', 0, datetime('now'), 0);
			UPDATE dreaming_passes
			SET head_base_revision = (SELECT revision FROM memory_md_heads WHERE agent_id = NEW.agent_id)
			WHERE id = NEW.id;
		END;

		CREATE TRIGGER IF NOT EXISTS memories_head_freshness_au
		AFTER UPDATE OF content, superseded_by, stale_at, is_deleted, agent_id, visibility, scope, memory_kind ON memories
		WHEN OLD.content IS NOT NEW.content OR OLD.superseded_by IS NOT NEW.superseded_by
		  OR OLD.stale_at IS NOT NEW.stale_at OR OLD.is_deleted IS NOT NEW.is_deleted
		  OR OLD.agent_id IS NOT NEW.agent_id OR OLD.visibility IS NOT NEW.visibility OR OLD.scope IS NOT NEW.scope OR OLD.memory_kind IS NOT NEW.memory_kind
		BEGIN
			UPDATE memory_md_heads SET revision = revision + 1, is_current = 0
			WHERE agent_id IN (OLD.agent_id, NEW.agent_id)
			   OR (COALESCE(OLD.visibility, 'global') = 'global' OR COALESCE(NEW.visibility, 'global') = 'global')
			      AND (agent_id IN (SELECT id FROM agents WHERE read_policy = 'shared')
			        OR agent_id IN (SELECT id FROM agents WHERE read_policy = 'group' AND policy_group IN
			          (SELECT policy_group FROM agents WHERE id IN (OLD.agent_id, NEW.agent_id))));
		END;

		CREATE TRIGGER IF NOT EXISTS memories_head_freshness_ad
		AFTER DELETE ON memories
		BEGIN
			UPDATE memory_md_heads SET revision = revision + 1, is_current = 0
			WHERE agent_id = OLD.agent_id
			   OR (COALESCE(OLD.visibility, 'global') = 'global'
			      AND (agent_id IN (SELECT id FROM agents WHERE read_policy = 'shared')
			        OR agent_id IN (SELECT id FROM agents WHERE read_policy = 'group' AND policy_group IN
			          (SELECT policy_group FROM agents WHERE id = OLD.agent_id))));
		END;

  CREATE TRIGGER IF NOT EXISTS agents_head_freshness_ad
  AFTER DELETE ON agents
  BEGIN
   UPDATE memory_md_heads SET revision = revision + 1, is_current = 0
   WHERE agent_id = OLD.id OR agent_id IN (SELECT id FROM agents WHERE read_policy='group' AND policy_group=OLD.policy_group);
  END;

		CREATE TRIGGER IF NOT EXISTS agents_head_freshness_au
		AFTER UPDATE OF read_policy, policy_group ON agents
		WHEN OLD.read_policy IS NOT NEW.read_policy OR OLD.policy_group IS NOT NEW.policy_group
		BEGIN
			UPDATE memory_md_heads SET revision = revision + 1, is_current = 0
			WHERE agent_id IN (OLD.id, NEW.id)
			   OR agent_id IN (SELECT id FROM agents WHERE read_policy = 'shared')
			   OR agent_id IN (SELECT id FROM agents WHERE read_policy = 'group' AND policy_group IN (OLD.policy_group, NEW.policy_group));
		END;
	`);

	for (const table of ["memory_artifacts", "session_transcripts"]) {
		const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
		if (!exists) continue;
		const hasIsDeleted = (
			db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>
		).some((row) => row.name === "is_deleted");
		const updateColumns =
			table === "session_transcripts"
				? "content, agent_id, completed_at"
				: hasIsDeleted
					? "content, agent_id, is_deleted"
					: "content, agent_id";
		const contentChanged =
			table === "session_transcripts"
				? "OLD.completed_at IS NOT NULL AND (OLD.content IS NOT NEW.content OR NEW.completed_at IS NULL)"
				: `OLD.content IS NOT NEW.content${hasIsDeleted ? " OR OLD.is_deleted IS NOT NEW.is_deleted" : ""}`;
		db.exec(`
			CREATE TRIGGER IF NOT EXISTS ${table}_head_freshness_au
			AFTER UPDATE OF ${updateColumns} ON ${table}
			WHEN OLD.agent_id IS NOT NEW.agent_id OR ${contentChanged}
			BEGIN
				UPDATE memory_md_heads SET revision = revision + 1, is_current = 0
				WHERE agent_id IN (OLD.agent_id, NEW.agent_id);
			END;
			CREATE TRIGGER IF NOT EXISTS ${table}_head_freshness_ad
			AFTER DELETE ON ${table}
			BEGIN
				UPDATE memory_md_heads SET revision = revision + 1, is_current = 0 WHERE agent_id = OLD.agent_id;
			END;
		`);
	}
	if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_summaries'").get()) {
		db.exec(`
		CREATE TRIGGER IF NOT EXISTS session_summaries_head_freshness_au
		AFTER UPDATE OF content, source_ref, source_type, depth, agent_id ON session_summaries
		WHEN OLD.depth = 0 AND (OLD.content IS NOT NEW.content OR OLD.source_ref IS NOT NEW.source_ref OR OLD.source_type IS NOT NEW.source_type OR OLD.depth IS NOT NEW.depth OR OLD.agent_id IS NOT NEW.agent_id)
			BEGIN
				UPDATE memory_md_heads SET revision = revision + 1, is_current = 0 WHERE agent_id IN (OLD.agent_id, NEW.agent_id);
			END;
			CREATE TRIGGER IF NOT EXISTS session_summaries_head_freshness_ad
			AFTER DELETE ON session_summaries
			WHEN OLD.depth = 0
			BEGIN
				UPDATE memory_md_heads SET revision = revision + 1, is_current = 0 WHERE agent_id = OLD.agent_id;
			END;
		`);
	}
	const safetyExists = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_content_safety'")
		.get();
	if (safetyExists) {
		db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_content_safety_head_freshness_ai
		AFTER INSERT ON memory_content_safety
		WHEN NEW.status IS NOT 'clean' OR NEW.context_eligible IS NOT 1
			BEGIN
				UPDATE memory_md_heads SET revision = revision + 1, is_current = 0
				WHERE agent_id IN (NEW.agent_id)
				   OR agent_id IN (SELECT id FROM agents WHERE read_policy IN ('shared', 'group'));
			END;

		CREATE TRIGGER IF NOT EXISTS memory_content_safety_head_freshness_au
		AFTER UPDATE OF context_eligible, agent_id, status ON memory_content_safety
		WHEN (OLD.context_eligible IS NOT NEW.context_eligible OR OLD.agent_id IS NOT NEW.agent_id OR OLD.status IS NOT NEW.status)
		  AND (OLD.status IS NOT 'clean' OR NEW.status IS NOT 'clean' OR OLD.context_eligible IS NOT 1 OR NEW.context_eligible IS NOT 1)
			BEGIN
				UPDATE memory_md_heads SET revision = revision + 1, is_current = 0
				WHERE agent_id IN (OLD.agent_id, NEW.agent_id)
				   OR agent_id IN (SELECT id FROM agents WHERE read_policy = 'shared')
				   OR agent_id IN (SELECT id FROM agents WHERE read_policy = 'group');
			END;
		`);
	}
	for (const table of ["memory_artifact_tombstones", "imported_source_lifecycle"]) {
		const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
		if (!exists) continue;
		const lifecycleClause = table === "imported_source_lifecycle" ? " WHEN NEW.status = 'unsupported'" : "";
		const updateColumns = table === "imported_source_lifecycle" ? "agent_id, status" : "agent_id";
		const lifecycleUpdateClause = table === "imported_source_lifecycle" ? " AND NEW.status = 'unsupported'" : "";
		const lifecycleWhen =
			table === "imported_source_lifecycle"
				? `(OLD.agent_id IS NOT NEW.agent_id OR OLD.status IS NOT NEW.status)${lifecycleUpdateClause}`
				: "OLD.agent_id IS NOT NEW.agent_id";
		db.exec(`
			CREATE TRIGGER IF NOT EXISTS ${table}_head_freshness_ai
			AFTER INSERT ON ${table}${lifecycleClause}
			BEGIN
				UPDATE memory_md_heads SET revision = revision + 1, is_current = 0 WHERE agent_id = NEW.agent_id;
			END;
			CREATE TRIGGER IF NOT EXISTS ${table}_head_freshness_au
			AFTER UPDATE OF ${updateColumns} ON ${table}
			WHEN ${lifecycleWhen}
			BEGIN
				UPDATE memory_md_heads SET revision = revision + 1, is_current = 0
				WHERE agent_id IN (OLD.agent_id, NEW.agent_id);
			END;
			CREATE TRIGGER IF NOT EXISTS ${table}_head_freshness_ad
			AFTER DELETE ON ${table}
			BEGIN
				UPDATE memory_md_heads SET revision = revision + 1, is_current = 0 WHERE agent_id = OLD.agent_id;
			END;
		`);
	}
}
