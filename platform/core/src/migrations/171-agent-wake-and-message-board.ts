import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS cross_agent_message_wakes (
			message_id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			harness TEXT NOT NULL,
			woken_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_cross_agent_message_wakes_session
			ON cross_agent_message_wakes(session_key, woken_at);

		CREATE TABLE IF NOT EXISTS board_topics (
			slug TEXT PRIMARY KEY,
			title TEXT,
			description TEXT,
			created_by_agent_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS board_threads (
			id TEXT PRIMARY KEY,
			topic_slug TEXT NOT NULL,
			title TEXT NOT NULL,
			author_agent_id TEXT NOT NULL,
			author_session_key TEXT,
			author_harness TEXT,
			status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'archived')),
			pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
			source_message_id TEXT,
			post_count INTEGER NOT NULL DEFAULT 0 CHECK (post_count >= 0),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_post_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_board_threads_topic_activity
			ON board_threads(topic_slug, last_post_at DESC, id);
		CREATE INDEX IF NOT EXISTS idx_board_threads_activity
			ON board_threads(last_post_at DESC, id);
		CREATE INDEX IF NOT EXISTS idx_board_threads_author
			ON board_threads(author_agent_id, last_post_at DESC);

		CREATE TABLE IF NOT EXISTS board_thread_tags (
			thread_id TEXT NOT NULL,
			tag TEXT NOT NULL,
			PRIMARY KEY (thread_id, tag)
		);
		CREATE INDEX IF NOT EXISTS idx_board_thread_tags_tag
			ON board_thread_tags(tag, thread_id);

		CREATE TABLE IF NOT EXISTS board_posts (
			id TEXT PRIMARY KEY,
			thread_id TEXT NOT NULL,
			author_agent_id TEXT NOT NULL,
			author_session_key TEXT,
			author_harness TEXT,
			body TEXT NOT NULL,
			reply_to_post_id TEXT,
			created_at TEXT NOT NULL,
			projected_at TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_board_posts_thread
			ON board_posts(thread_id, created_at, id);
		CREATE INDEX IF NOT EXISTS idx_board_posts_author
			ON board_posts(author_agent_id, thread_id);
		CREATE INDEX IF NOT EXISTS idx_board_posts_unprojected
			ON board_posts(created_at, id) WHERE projected_at IS NULL;

		CREATE TABLE IF NOT EXISTS board_reads (
			agent_id TEXT NOT NULL,
			thread_id TEXT NOT NULL,
			last_read_at TEXT,
			notified_at TEXT,
			PRIMARY KEY (agent_id, thread_id)
		);
		CREATE INDEX IF NOT EXISTS idx_board_reads_thread
			ON board_reads(thread_id);
	`);
}
