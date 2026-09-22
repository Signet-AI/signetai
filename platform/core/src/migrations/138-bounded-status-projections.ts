import type { MigrationDb } from "./contract";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<{ name?: unknown }>;
	return rows.some((row) => row.name === column);
}

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
export function up(db: MigrationDb): void {
	addColumnIfMissing(db, "memories", "manual_override", "INTEGER DEFAULT 0");

	db.exec(`
		CREATE TABLE IF NOT EXISTS transcript_capture_status (
			agent_id TEXT PRIMARY KEY,
			pending INTEGER NOT NULL DEFAULT 0,
			processing INTEGER NOT NULL DEFAULT 0,
			completed INTEGER NOT NULL DEFAULT 0,
			failed INTEGER NOT NULL DEFAULT 0,
			dead INTEGER NOT NULL DEFAULT 0,
			oldest_pending_at TEXT,
			last_error TEXT,
			last_error_at TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_transcript_capture_jobs_agent_status_created_at
			ON transcript_capture_jobs(agent_id, status, created_at);

		CREATE INDEX IF NOT EXISTS idx_transcript_capture_jobs_error_updated_at
			ON transcript_capture_jobs(agent_id, updated_at DESC)
			WHERE error IS NOT NULL;

		CREATE TABLE IF NOT EXISTS memories_duplicate_hash_counts (
			content_hash TEXT PRIMARY KEY,
			dup_count INTEGER NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_memories_dup_counts_active
			ON memories_duplicate_hash_counts(dup_count)
			WHERE dup_count > 1;

		CREATE TABLE IF NOT EXISTS memories_diagnostics_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			total_active INTEGER NOT NULL DEFAULT 0,
			exact_duplicates INTEGER NOT NULL DEFAULT 0,
			exact_clusters INTEGER NOT NULL DEFAULT 0
		);

		CREATE INDEX IF NOT EXISTS idx_memories_active_hash_diagnostics
			ON memories(content_hash)
			WHERE is_deleted = 0
			  AND content_hash IS NOT NULL
			  AND pinned = 0
			  AND manual_override = 0;
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS transcript_capture_status_ai
		AFTER INSERT ON transcript_capture_jobs
		BEGIN
			INSERT INTO transcript_capture_status (agent_id)
			VALUES (NEW.agent_id)
			ON CONFLICT(agent_id) DO NOTHING;

			UPDATE transcript_capture_status
			 SET pending = pending + (NEW.status = 'pending'),
			     processing = processing + (NEW.status = 'processing'),
			     completed = completed + (NEW.status = 'completed'),
			     failed = failed + (NEW.status = 'failed'),
			     dead = dead + (NEW.status = 'dead')
			 WHERE agent_id = NEW.agent_id;

			UPDATE transcript_capture_status
			 SET oldest_pending_at = (
			     SELECT MIN(created_at) FROM transcript_capture_jobs
			     WHERE agent_id = NEW.agent_id AND status = 'pending'
			 )
			 WHERE agent_id = NEW.agent_id;

			UPDATE transcript_capture_status
			 SET last_error = (
			     SELECT error FROM transcript_capture_jobs
			     WHERE agent_id = NEW.agent_id AND error IS NOT NULL
			     ORDER BY updated_at DESC LIMIT 1
			 ),
			     last_error_at = (
			     SELECT updated_at FROM transcript_capture_jobs
			     WHERE agent_id = NEW.agent_id AND error IS NOT NULL
			     ORDER BY updated_at DESC LIMIT 1
			 )
			 WHERE agent_id = NEW.agent_id
			   AND NEW.error IS NOT NULL;
		END;

		CREATE TRIGGER IF NOT EXISTS transcript_capture_status_au
		AFTER UPDATE OF status, error, updated_at, created_at ON transcript_capture_jobs
		BEGIN
			UPDATE transcript_capture_status
			 SET pending = pending + (NEW.status = 'pending') - (OLD.status = 'pending'),
			     processing = processing + (NEW.status = 'processing') - (OLD.status = 'processing'),
			     completed = completed + (NEW.status = 'completed') - (OLD.status = 'completed'),
			     failed = failed + (NEW.status = 'failed') - (OLD.status = 'failed'),
			     dead = dead + (NEW.status = 'dead') - (OLD.status = 'dead')
			 WHERE agent_id = NEW.agent_id;

			UPDATE transcript_capture_status
			 SET oldest_pending_at = (
			     SELECT MIN(created_at) FROM transcript_capture_jobs
			     WHERE agent_id = NEW.agent_id AND status = 'pending'
			 )
			 WHERE agent_id = NEW.agent_id;

			UPDATE transcript_capture_status
			 SET last_error = (
			     SELECT error FROM transcript_capture_jobs
			     WHERE agent_id = NEW.agent_id AND error IS NOT NULL
			     ORDER BY updated_at DESC LIMIT 1
			 ),
			     last_error_at = (
			     SELECT updated_at FROM transcript_capture_jobs
			     WHERE agent_id = NEW.agent_id AND error IS NOT NULL
			     ORDER BY updated_at DESC LIMIT 1
			 )
			 WHERE agent_id = NEW.agent_id
			   AND (NEW.error IS NOT NULL OR OLD.error IS NOT NULL);
		END;

		CREATE TRIGGER IF NOT EXISTS transcript_capture_status_ad
		AFTER DELETE ON transcript_capture_jobs
		BEGIN
			UPDATE transcript_capture_status
			 SET pending = pending - (OLD.status = 'pending'),
			     processing = processing - (OLD.status = 'processing'),
			     completed = completed - (OLD.status = 'completed'),
			     failed = failed - (OLD.status = 'failed'),
			     dead = dead - (OLD.status = 'dead')
			 WHERE agent_id = OLD.agent_id;

			UPDATE transcript_capture_status
			 SET oldest_pending_at = (
			     SELECT MIN(created_at) FROM transcript_capture_jobs
			     WHERE agent_id = OLD.agent_id AND status = 'pending'
			 )
			 WHERE agent_id = OLD.agent_id;

			UPDATE transcript_capture_status
			 SET last_error = (
			     SELECT error FROM transcript_capture_jobs
			     WHERE agent_id = OLD.agent_id AND error IS NOT NULL
			     ORDER BY updated_at DESC LIMIT 1
			 ),
			     last_error_at = (
			     SELECT updated_at FROM transcript_capture_jobs
			     WHERE agent_id = OLD.agent_id AND error IS NOT NULL
			     ORDER BY updated_at DESC LIMIT 1
			 )
			 WHERE agent_id = OLD.agent_id
			   AND OLD.error IS NOT NULL;
		END;
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_dup_projection_ai
		AFTER INSERT ON memories
		BEGIN
			UPDATE memories_diagnostics_state
			 SET total_active = total_active + CASE WHEN NEW.is_deleted = 0 THEN 1 ELSE 0 END,
			     exact_duplicates = exact_duplicates + CASE
			       WHEN NEW.is_deleted = 0 AND NEW.content_hash IS NOT NULL
			        AND NEW.pinned = 0 AND NEW.manual_override = 0
			        AND COALESCE((SELECT dup_count FROM memories_duplicate_hash_counts WHERE content_hash = NEW.content_hash), 0) >= 1
			       THEN 1 ELSE 0 END,
			     exact_clusters = exact_clusters + CASE
			       WHEN NEW.is_deleted = 0 AND NEW.content_hash IS NOT NULL
			        AND NEW.pinned = 0 AND NEW.manual_override = 0
			        AND COALESCE((SELECT dup_count FROM memories_duplicate_hash_counts WHERE content_hash = NEW.content_hash), 0) = 1
			       THEN 1 ELSE 0 END
			 WHERE id = 1;

			INSERT INTO memories_duplicate_hash_counts (content_hash, dup_count)
			 SELECT NEW.content_hash, 1
			 WHERE NEW.is_deleted = 0
			   AND NEW.content_hash IS NOT NULL
			   AND NEW.pinned = 0
			   AND NEW.manual_override = 0
			 ON CONFLICT(content_hash) DO UPDATE SET dup_count = dup_count + 1;
		END;

		CREATE TRIGGER IF NOT EXISTS memories_dup_projection_au
		AFTER UPDATE OF is_deleted, content_hash, pinned, manual_override ON memories
		BEGIN
			UPDATE memories_diagnostics_state
			 SET total_active = total_active
			       + CASE WHEN NEW.is_deleted = 0 THEN 1 ELSE 0 END
			       - CASE WHEN OLD.is_deleted = 0 THEN 1 ELSE 0 END,
			     exact_duplicates = exact_duplicates - CASE
			       WHEN OLD.is_deleted = 0 AND OLD.content_hash IS NOT NULL
			        AND OLD.pinned = 0 AND OLD.manual_override = 0
			        AND COALESCE((SELECT dup_count FROM memories_duplicate_hash_counts WHERE content_hash = OLD.content_hash), 0) > 1
			       THEN 1 ELSE 0 END,
			     exact_clusters = exact_clusters - CASE
			       WHEN OLD.is_deleted = 0 AND OLD.content_hash IS NOT NULL
			        AND OLD.pinned = 0 AND OLD.manual_override = 0
			        AND COALESCE((SELECT dup_count FROM memories_duplicate_hash_counts WHERE content_hash = OLD.content_hash), 0) = 2
			       THEN 1 ELSE 0 END
			 WHERE id = 1;

			UPDATE memories_duplicate_hash_counts
			 SET dup_count = dup_count - 1
			 WHERE OLD.is_deleted = 0
			   AND OLD.content_hash IS NOT NULL
			   AND OLD.pinned = 0
			   AND OLD.manual_override = 0
			   AND content_hash = OLD.content_hash;

			DELETE FROM memories_duplicate_hash_counts
			 WHERE content_hash = OLD.content_hash
			   AND dup_count <= 0;

			UPDATE memories_diagnostics_state
			 SET exact_duplicates = exact_duplicates + CASE
			       WHEN NEW.is_deleted = 0 AND NEW.content_hash IS NOT NULL
			        AND NEW.pinned = 0 AND NEW.manual_override = 0
			        AND COALESCE((SELECT dup_count FROM memories_duplicate_hash_counts WHERE content_hash = NEW.content_hash), 0) >= 1
			       THEN 1 ELSE 0 END,
			     exact_clusters = exact_clusters + CASE
			       WHEN NEW.is_deleted = 0 AND NEW.content_hash IS NOT NULL
			        AND NEW.pinned = 0 AND NEW.manual_override = 0
			        AND COALESCE((SELECT dup_count FROM memories_duplicate_hash_counts WHERE content_hash = NEW.content_hash), 0) = 1
			       THEN 1 ELSE 0 END
			 WHERE id = 1;

			INSERT INTO memories_duplicate_hash_counts (content_hash, dup_count)
			 SELECT NEW.content_hash, 1
			 WHERE NEW.is_deleted = 0
			   AND NEW.content_hash IS NOT NULL
			   AND NEW.pinned = 0
			   AND NEW.manual_override = 0
			 ON CONFLICT(content_hash) DO UPDATE SET dup_count = dup_count + 1;
		END;

		CREATE TRIGGER IF NOT EXISTS memories_dup_projection_ad
		AFTER DELETE ON memories
		BEGIN
			UPDATE memories_diagnostics_state
			 SET total_active = total_active - CASE WHEN OLD.is_deleted = 0 THEN 1 ELSE 0 END,
			     exact_duplicates = exact_duplicates - CASE
			       WHEN OLD.is_deleted = 0 AND OLD.content_hash IS NOT NULL
			        AND OLD.pinned = 0 AND OLD.manual_override = 0
			        AND COALESCE((SELECT dup_count FROM memories_duplicate_hash_counts WHERE content_hash = OLD.content_hash), 0) > 1
			       THEN 1 ELSE 0 END,
			     exact_clusters = exact_clusters - CASE
			       WHEN OLD.is_deleted = 0 AND OLD.content_hash IS NOT NULL
			        AND OLD.pinned = 0 AND OLD.manual_override = 0
			        AND COALESCE((SELECT dup_count FROM memories_duplicate_hash_counts WHERE content_hash = OLD.content_hash), 0) = 2
			       THEN 1 ELSE 0 END
			 WHERE id = 1;

			UPDATE memories_duplicate_hash_counts
			 SET dup_count = dup_count - 1
			 WHERE OLD.is_deleted = 0
			   AND OLD.content_hash IS NOT NULL
			   AND OLD.pinned = 0
			   AND OLD.manual_override = 0
			   AND content_hash = OLD.content_hash;

			DELETE FROM memories_duplicate_hash_counts
			 WHERE content_hash = OLD.content_hash
			   AND dup_count <= 0;
		END;
	`);
	db.exec(`
		DELETE FROM transcript_capture_status;
		DELETE FROM memories_duplicate_hash_counts;
		INSERT INTO memories_duplicate_hash_counts (content_hash, dup_count)
		SELECT content_hash, COUNT(*)
		 FROM memories
		 WHERE is_deleted = 0
		   AND content_hash IS NOT NULL
		   AND pinned = 0
		   AND manual_override = 0
		 GROUP BY content_hash;

		INSERT INTO memories_diagnostics_state (id, total_active, exact_duplicates, exact_clusters)
		VALUES (
			1,
			(SELECT COUNT(*) FROM memories WHERE is_deleted = 0),
			COALESCE((SELECT SUM(dup_count - 1) FROM memories_duplicate_hash_counts WHERE dup_count > 1), 0),
			(SELECT COUNT(*) FROM memories_duplicate_hash_counts WHERE dup_count > 1)
		)
		ON CONFLICT(id) DO UPDATE SET
			total_active = excluded.total_active,
			exact_duplicates = excluded.exact_duplicates,
			exact_clusters = excluded.exact_clusters;

		INSERT INTO transcript_capture_status (
			agent_id, pending, processing, completed, failed, dead,
			oldest_pending_at, last_error, last_error_at
		)
		SELECT
			j.agent_id,
			SUM(j.status = 'pending'),
			SUM(j.status = 'processing'),
			SUM(j.status = 'completed'),
			SUM(j.status = 'failed'),
			SUM(j.status = 'dead'),
			MIN(CASE WHEN j.status = 'pending' THEN j.created_at END),
			(SELECT e2.error FROM transcript_capture_jobs e2
			 WHERE e2.agent_id = j.agent_id AND e2.error IS NOT NULL
			 ORDER BY e2.updated_at DESC LIMIT 1),
			(SELECT e3.updated_at FROM transcript_capture_jobs e3
			 WHERE e3.agent_id = j.agent_id AND e3.error IS NOT NULL
			 ORDER BY e3.updated_at DESC LIMIT 1)
		FROM transcript_capture_jobs j
		GROUP BY j.agent_id;
	`);
}
