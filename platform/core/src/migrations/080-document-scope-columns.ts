import type { MigrationDb } from "./index";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	return rows.some((row) => row.name === column);
}

export function up(db: MigrationDb): void {
	if (!hasColumn(db, "documents", "agent_id")) {
		db.exec("ALTER TABLE documents ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'");
	}
	if (!hasColumn(db, "documents", "project")) {
		db.exec("ALTER TABLE documents ADD COLUMN project TEXT");
	}

	db.exec(`
		UPDATE documents
		SET agent_id = NULLIF(TRIM(json_extract(metadata_json, '$.signet.agentId')), '')
		WHERE metadata_json IS NOT NULL
		  AND json_valid(metadata_json)
		  AND json_type(metadata_json, '$.signet.agentId') = 'text'
		  AND NULLIF(TRIM(json_extract(metadata_json, '$.signet.agentId')), '') IS NOT NULL
	`);

	db.exec(`
		UPDATE documents
		SET project = NULLIF(TRIM(json_extract(metadata_json, '$.signet.project')), '')
		WHERE metadata_json IS NOT NULL
		  AND json_valid(metadata_json)
		  AND json_type(metadata_json, '$.signet.project') = 'text'
	`);

	db.exec(`
		WITH linked_scope AS (
			SELECT
				dm.document_id,
				m.agent_id,
				m.project,
				ROW_NUMBER() OVER (
					PARTITION BY dm.document_id
					ORDER BY COUNT(*) DESC, m.agent_id, COALESCE(m.project, '')
				) AS rank
			FROM document_memories dm
			JOIN memories m ON m.id = dm.memory_id
			WHERE m.agent_id IS NOT NULL
			  AND NULLIF(TRIM(m.agent_id), '') IS NOT NULL
			GROUP BY dm.document_id, m.agent_id, m.project
		)
		UPDATE documents
		SET
			agent_id = COALESCE((
				SELECT agent_id FROM linked_scope
				WHERE linked_scope.document_id = documents.id AND rank = 1
			), agent_id),
			project = (
				SELECT project FROM linked_scope
				WHERE linked_scope.document_id = documents.id AND rank = 1
			)
		WHERE EXISTS (
			SELECT 1 FROM linked_scope
			WHERE linked_scope.document_id = documents.id AND rank = 1
		)
		AND NOT (
			metadata_json IS NOT NULL
			AND json_valid(metadata_json)
			AND json_type(metadata_json, '$.signet.agentId') = 'text'
			AND NULLIF(TRIM(json_extract(metadata_json, '$.signet.agentId')), '') IS NOT NULL
		)
	`);

	if (
		hasColumn(db, "memories", "visibility") &&
		hasColumn(db, "memories", "type") &&
		hasColumn(db, "memories", "source_type")
	) {
		db.exec(`
			UPDATE memories
			SET visibility = 'private'
			WHERE id IN (SELECT memory_id FROM document_memories)
			  AND type = 'document_chunk'
			  AND source_type = 'document'
			  AND (visibility IS NULL OR visibility = 'global')
		`);
	}

	if (
		hasColumn(db, "memories", "content_hash") &&
		hasColumn(db, "memories", "agent_id") &&
		hasColumn(db, "memories", "project") &&
		hasColumn(db, "memories", "scope") &&
		hasColumn(db, "memories", "visibility") &&
		hasColumn(db, "memories", "is_deleted")
	) {
		db.exec("DROP INDEX IF EXISTS idx_memories_content_hash_unique");
		db.exec(`
			CREATE UNIQUE INDEX idx_memories_content_hash_unique
			ON memories(
				content_hash,
				COALESCE(NULLIF(agent_id, ''), 'default'),
				COALESCE(project, ''),
				COALESCE(scope, '__NULL__'),
				COALESCE(visibility, 'global')
			)
			WHERE content_hash IS NOT NULL AND is_deleted = 0
		`);
	}
	db.exec("CREATE INDEX IF NOT EXISTS idx_documents_agent_project ON documents(agent_id, project)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_documents_source_scope ON documents(source_url, agent_id, project)");
}
