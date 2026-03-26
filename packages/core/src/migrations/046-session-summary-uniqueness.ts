import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		DROP INDEX IF EXISTS idx_summaries_session_depth;

		CREATE TEMP TABLE IF NOT EXISTS session_summary_duplicate_map AS
		WITH ranked AS (
			SELECT
				id,
				agent_id,
				session_key,
				depth,
				ROW_NUMBER() OVER (
					PARTITION BY agent_id, session_key, depth
					ORDER BY latest_at DESC, created_at DESC, id ASC
				) AS rn
			FROM session_summaries
			WHERE session_key IS NOT NULL
			  AND COALESCE(source_type, 'summary') = 'summary'
		)
		SELECT dup.id AS drop_id, keep.id AS keep_id
		FROM ranked dup
		JOIN ranked keep
		  ON keep.agent_id = dup.agent_id
		 AND keep.session_key = dup.session_key
		 AND keep.depth = dup.depth
		 AND keep.rn = 1
		WHERE dup.rn > 1;

		INSERT OR IGNORE INTO session_summary_memories (summary_id, memory_id)
		SELECT map.keep_id, link.memory_id
		FROM session_summary_duplicate_map map
		JOIN session_summary_memories link ON link.summary_id = map.drop_id;

		INSERT OR IGNORE INTO session_summary_children (parent_id, child_id, ordinal)
		SELECT
			COALESCE(parent_map.keep_id, rel.parent_id),
			COALESCE(child_map.keep_id, rel.child_id),
			rel.ordinal
		FROM session_summary_children rel
		LEFT JOIN session_summary_duplicate_map parent_map ON parent_map.drop_id = rel.parent_id
		LEFT JOIN session_summary_duplicate_map child_map ON child_map.drop_id = rel.child_id
		WHERE parent_map.drop_id IS NOT NULL OR child_map.drop_id IS NOT NULL;

		DELETE FROM session_summary_children
		WHERE parent_id IN (SELECT drop_id FROM session_summary_duplicate_map)
		   OR child_id IN (SELECT drop_id FROM session_summary_duplicate_map);

		DELETE FROM session_summary_memories
		WHERE summary_id IN (SELECT drop_id FROM session_summary_duplicate_map);

		DELETE FROM session_summaries
		WHERE id IN (SELECT drop_id FROM session_summary_duplicate_map);

		DROP TABLE session_summary_duplicate_map;

		CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_session_depth_summary
			ON session_summaries(agent_id, session_key, depth)
			WHERE session_key IS NOT NULL
			  AND COALESCE(source_type, 'summary') = 'summary';
	`);
}
