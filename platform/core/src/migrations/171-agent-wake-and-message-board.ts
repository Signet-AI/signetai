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
		DROP INDEX IF EXISTS idx_board_threads_author;
		CREATE INDEX idx_board_threads_author
			ON board_threads(author_agent_id, author_session_key);

		CREATE TABLE IF NOT EXISTS board_thread_tags (
			thread_id TEXT NOT NULL,
			tag TEXT NOT NULL,
			PRIMARY KEY (thread_id, tag)
		);
		CREATE INDEX IF NOT EXISTS idx_board_thread_tags_tag
			ON board_thread_tags(tag, thread_id);

		CREATE TABLE IF NOT EXISTS board_posts (
			id TEXT PRIMARY KEY,
			seq INTEGER NOT NULL,
			thread_id TEXT NOT NULL,
			author_agent_id TEXT NOT NULL,
			author_session_key TEXT,
			author_harness TEXT,
			body TEXT NOT NULL,
			reply_to_post_id TEXT,
			created_at TEXT NOT NULL,
			projected_at TEXT
		);
	`);
	repairBoardPosts(db);
	db.exec(`
		CREATE TABLE IF NOT EXISTS board_reads (
			agent_id TEXT NOT NULL,
			thread_id TEXT NOT NULL,
			last_read_at TEXT NOT NULL,
			last_read_post_seq INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (agent_id, thread_id)
		);
		CREATE INDEX IF NOT EXISTS idx_board_reads_thread
			ON board_reads(thread_id);

	`);
	repairBoardReads(db);
	repairBoardNotices(db);
	db.exec(`
		CREATE TABLE IF NOT EXISTS board_notices (
			agent_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			thread_id TEXT NOT NULL,
			notified_post_seq INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (agent_id, session_key, thread_id)
		);
		DROP INDEX IF EXISTS idx_board_posts_thread;
		CREATE UNIQUE INDEX IF NOT EXISTS idx_board_posts_seq
			ON board_posts(seq);
		CREATE INDEX IF NOT EXISTS idx_board_posts_thread
			ON board_posts(thread_id, seq);
		CREATE INDEX IF NOT EXISTS idx_board_posts_author
			ON board_posts(author_agent_id, author_session_key, thread_id);
		CREATE INDEX IF NOT EXISTS idx_board_posts_unprojected
			ON board_posts(created_at, id) WHERE projected_at IS NULL;

		CREATE INDEX IF NOT EXISTS idx_board_reads_thread
			ON board_reads(thread_id);
		CREATE INDEX IF NOT EXISTS idx_board_notices_thread
			ON board_notices(thread_id);
	`);
}

function columnNames(db: MigrationDb, table: string): Set<string> {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all();
	return new Set(rows.map((row) => String(row.name)));
}

function repairBoardPosts(db: MigrationDb): void {
	if (!columnNames(db, "board_posts").has("seq")) {
		db.exec("ALTER TABLE board_posts ADD COLUMN seq INTEGER");
	}
	const rows = db.prepare("SELECT rowid AS rid, seq FROM board_posts ORDER BY rowid ASC").all();
	const used = new Set<number>();
	let max = 0;
	for (const row of rows) {
		const seq = typeof row.seq === "number" ? row.seq : Number.NaN;
		if (Number.isInteger(seq) && seq > 0 && !used.has(seq)) {
			used.add(seq);
			max = Math.max(max, seq);
		}
	}
	const seen = new Set<number>();
	const update = db.prepare("UPDATE board_posts SET seq = ? WHERE rowid = ?");
	for (const row of rows) {
		const seq = typeof row.seq === "number" ? row.seq : Number.NaN;
		if (Number.isInteger(seq) && seq > 0 && !seen.has(seq)) {
			seen.add(seq);
			continue;
		}
		max += 1;
		update.run(max, row.rid);
	}
}

function repairBoardReads(db: MigrationDb): void {
	if (columnNames(db, "board_reads").has("last_read_post_seq")) return;
	db.exec("ALTER TABLE board_reads ADD COLUMN last_read_post_seq INTEGER NOT NULL DEFAULT 0");
	db.exec(`
		UPDATE board_reads SET last_read_post_seq = COALESCE((
			SELECT MAX(p.seq) FROM board_posts p
			WHERE p.thread_id = board_reads.thread_id AND p.created_at <= board_reads.last_read_at
		), 0)
	`);
}

function repairBoardNotices(db: MigrationDb): void {
	const columns = columnNames(db, "board_notices");
	if (columns.size === 0) return;
	if (columns.has("notified_post_seq") && !columns.has("notified_at")) return;
	db.exec("SAVEPOINT repair_board_notices");
	try {
		db.exec("DROP TABLE IF EXISTS board_notices_repair");
		db.exec(`
			CREATE TABLE board_notices_repair (
				agent_id TEXT NOT NULL,
				session_key TEXT NOT NULL,
				thread_id TEXT NOT NULL,
				notified_post_seq INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (agent_id, session_key, thread_id)
			)
		`);
		const seqExpr = columns.has("notified_post_seq") ? "COALESCE(n.notified_post_seq, 0)" : "0";
		const atExpr = columns.has("notified_at")
			? `COALESCE((SELECT MAX(p.seq) FROM board_posts p WHERE p.thread_id = n.thread_id AND p.created_at <= n.notified_at), 0)`
			: "0";
		db.exec(`
			INSERT INTO board_notices_repair (agent_id, session_key, thread_id, notified_post_seq)
			SELECT n.agent_id, n.session_key, n.thread_id, MAX(${seqExpr}, ${atExpr})
			FROM board_notices n
		`);
		db.exec("DROP TABLE board_notices");
		db.exec("ALTER TABLE board_notices_repair RENAME TO board_notices");
		db.exec("RELEASE repair_board_notices");
	} catch (error) {
		db.exec("ROLLBACK TO repair_board_notices");
		db.exec("RELEASE repair_board_notices");
		throw error;
	}
}
