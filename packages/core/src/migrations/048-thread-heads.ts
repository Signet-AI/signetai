import type { MigrationDb } from "./index";

/**
 * Migration 048: Persistent thread heads
 *
 * Adds agent-scoped thread head storage used by three-tier memory rendering
 * and temporal fallback retrieval.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_thread_heads (
			agent_id TEXT NOT NULL DEFAULT 'default',
			thread_key TEXT NOT NULL,
			label TEXT NOT NULL,
			project TEXT,
			session_key TEXT,
			source_type TEXT NOT NULL DEFAULT 'summary',
			source_ref TEXT,
			harness TEXT,
			node_id TEXT NOT NULL,
			latest_at TEXT NOT NULL,
			sample TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, thread_key)
		);

		CREATE INDEX IF NOT EXISTS idx_thread_heads_agent_latest
			ON memory_thread_heads(agent_id, latest_at DESC);
		CREATE INDEX IF NOT EXISTS idx_thread_heads_agent_project
			ON memory_thread_heads(agent_id, project);

		INSERT INTO memory_thread_heads (
			agent_id, thread_key, label, project, session_key, source_type,
			source_ref, harness, node_id, latest_at, sample, updated_at
		)
		SELECT
			ss.agent_id,
			CASE
				WHEN ss.harness IS NOT NULL AND TRIM(ss.harness) != ''
						AND (ss.project IS NULL OR TRIM(ss.project) = '')
						AND (ss.source_ref IS NULL OR TRIM(ss.source_ref) = '')
						AND (ss.session_key IS NULL OR TRIM(ss.session_key) = '')
					THEN 'harness:' || TRIM(ss.harness)
				ELSE
					CASE
						WHEN ss.source_ref IS NOT NULL AND TRIM(ss.source_ref) != '' AND ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN
							'project:' || TRIM(ss.project) || '|source:' || TRIM(ss.source_ref)
						WHEN ss.source_ref IS NOT NULL AND TRIM(ss.source_ref) != '' THEN 'source:' || TRIM(ss.source_ref)
						WHEN ss.session_key IS NOT NULL AND TRIM(ss.session_key) != '' AND ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN
							'project:' || TRIM(ss.project) || '|session:' || TRIM(ss.session_key)
						WHEN ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN 'project:' || TRIM(ss.project)
						WHEN ss.session_key IS NOT NULL AND TRIM(ss.session_key) != '' THEN 'session:' || TRIM(ss.session_key)
						ELSE 'thread:unscoped'
					END ||
					CASE
						WHEN ss.harness IS NOT NULL AND TRIM(ss.harness) != '' THEN '|harness:' || TRIM(ss.harness)
						ELSE ''
					END
			END AS thread_key,
			CASE
				WHEN ss.source_ref IS NOT NULL AND TRIM(ss.source_ref) != '' AND ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN
					'project:' || TRIM(ss.project) || '#source:' || TRIM(ss.source_ref)
				WHEN ss.source_ref IS NOT NULL AND TRIM(ss.source_ref) != '' THEN 'source:' || TRIM(ss.source_ref)
				WHEN ss.session_key IS NOT NULL AND TRIM(ss.session_key) != '' AND ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN
					'project:' || TRIM(ss.project) || '#session:' || TRIM(ss.session_key)
				WHEN ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN 'project:' || TRIM(ss.project)
				WHEN ss.session_key IS NOT NULL AND TRIM(ss.session_key) != '' THEN 'session:' || TRIM(ss.session_key)
				WHEN ss.harness IS NOT NULL AND TRIM(ss.harness) != '' THEN 'harness:' || TRIM(ss.harness)
				ELSE 'thread:unscoped'
			END AS label,
			ss.project,
			ss.session_key,
			COALESCE(ss.source_type, ss.kind, 'summary') AS source_type,
			ss.source_ref,
			ss.harness,
			ss.id AS node_id,
			ss.latest_at,
			SUBSTR(REPLACE(REPLACE(TRIM(ss.content), CHAR(10), ' '), CHAR(13), ' '), 1, 240) AS sample,
			ss.latest_at AS updated_at
		FROM (
			SELECT
				s0.*,
				ROW_NUMBER() OVER (
					PARTITION BY s0.agent_id,
					CASE
						WHEN s0.harness IS NOT NULL AND TRIM(s0.harness) != ''
								AND (s0.project IS NULL OR TRIM(s0.project) = '')
								AND (s0.source_ref IS NULL OR TRIM(s0.source_ref) = '')
								AND (s0.session_key IS NULL OR TRIM(s0.session_key) = '')
							THEN 'harness:' || TRIM(s0.harness)
						ELSE
							CASE
								WHEN s0.source_ref IS NOT NULL AND TRIM(s0.source_ref) != '' AND s0.project IS NOT NULL AND TRIM(s0.project) != '' THEN
									'project:' || TRIM(s0.project) || '|source:' || TRIM(s0.source_ref)
								WHEN s0.source_ref IS NOT NULL AND TRIM(s0.source_ref) != '' THEN 'source:' || TRIM(s0.source_ref)
								WHEN s0.session_key IS NOT NULL AND TRIM(s0.session_key) != '' AND s0.project IS NOT NULL AND TRIM(s0.project) != '' THEN
									'project:' || TRIM(s0.project) || '|session:' || TRIM(s0.session_key)
								WHEN s0.project IS NOT NULL AND TRIM(s0.project) != '' THEN 'project:' || TRIM(s0.project)
								WHEN s0.session_key IS NOT NULL AND TRIM(s0.session_key) != '' THEN 'session:' || TRIM(s0.session_key)
								ELSE 'thread:unscoped'
							END ||
							CASE
								WHEN s0.harness IS NOT NULL AND TRIM(s0.harness) != '' THEN '|harness:' || TRIM(s0.harness)
								ELSE ''
							END
					END
					ORDER BY s0.latest_at DESC, s0.created_at DESC
				) AS rn
			FROM session_summaries s0
			WHERE COALESCE(s0.source_type, s0.kind) != 'chunk'
		) ss
		WHERE ss.rn = 1
		ON CONFLICT(agent_id, thread_key) DO UPDATE SET
			label = excluded.label,
			project = excluded.project,
			session_key = excluded.session_key,
			source_type = excluded.source_type,
			source_ref = excluded.source_ref,
			harness = excluded.harness,
			node_id = excluded.node_id,
			latest_at = excluded.latest_at,
			sample = excluded.sample,
			updated_at = excluded.updated_at
		WHERE excluded.latest_at >= memory_thread_heads.latest_at;
	`);
}
