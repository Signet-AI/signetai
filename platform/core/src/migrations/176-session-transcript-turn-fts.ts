import type { MigrationDb } from "./contract";

export const SESSION_TRANSCRIPT_TURN_TRIGGERS = [
	"session_transcript_turns_fts_ai",
	"session_transcript_turns_fts_ad",
	"session_transcript_turns_ai",
	"session_transcript_turns_ad",
	"session_transcript_turns_au",
] as const;

const OLD_BYTES = "CAST(old.content AS BLOB)";
const NEW_BYTES = "CAST(new.content AS BLOB)";
const WHITESPACE = "(x'0A', x'0D', x'09', x'20')";
const OLD_SESSION = "agent_id = old.agent_id AND session_key = old.session_key";
const NEW_SESSION = "agent_id = new.agent_id AND session_key = new.session_key";
const RENAMED = "(new.agent_id IS NOT old.agent_id OR new.session_key IS NOT old.session_key)";
const TURN_BYTES = "length(CAST(text AS BLOB))";
const SESSION_END = (session: string): string =>
	`COALESCE((SELECT byte_offset + ${TURN_BYTES} FROM session_transcript_turns WHERE ${session} ORDER BY seq DESC LIMIT 1), 0)`;
const AFTER_LAST = `(SELECT COALESCE(MAX(seq), 0) + 1 FROM session_transcript_turns WHERE ${OLD_SESSION})`;
const FIRST_CHANGED = `CASE WHEN length(${OLD_BYTES}) > 0
	AND ${SESSION_END(OLD_SESSION)} = length(${OLD_BYTES})
	AND substr(${NEW_BYTES}, 1, length(${OLD_BYTES})) = ${OLD_BYTES}
THEN ${AFTER_LAST} ELSE COALESCE(
	(SELECT seq FROM session_transcript_turns WHERE ${OLD_SESSION}
		AND (${TURN_BYTES} = 0 OR substr(${NEW_BYTES}, byte_offset + 1, ${TURN_BYTES}) IS NOT CAST(text AS BLOB))
		ORDER BY seq LIMIT 1),
	${AFTER_LAST}) END`;
const CUT = `(
	SELECT CASE
		WHEN cut.b = 0 OR cut.b >= length(${NEW_BYTES})
			OR substr(${NEW_BYTES}, cut.b, 1) IN ${WHITESPACE} OR substr(${NEW_BYTES}, cut.b + 1, 1) IN ${WHITESPACE}
		THEN cut.seq ELSE cut.seq - 1 END
	FROM (SELECT changed.seq AS seq, COALESCE(
		(SELECT byte_offset FROM session_transcript_turns WHERE ${OLD_SESSION} AND seq = changed.seq),
		${SESSION_END(OLD_SESSION)}) AS b
		FROM (SELECT ${FIRST_CHANGED} AS seq) changed) cut)`;

export function up(db: MigrationDb): void {
	db.exec(`
		DROP TRIGGER IF EXISTS session_transcripts_fts_ai;
		DROP TRIGGER IF EXISTS session_transcripts_fts_ad;
		DROP TRIGGER IF EXISTS session_transcripts_fts_au;
		DROP TABLE IF EXISTS session_transcripts_fts;
		${SESSION_TRANSCRIPT_TURN_TRIGGERS.map((name) => `DROP TRIGGER IF EXISTS ${name};`).join("\n")}
		DROP TABLE IF EXISTS session_transcript_turns_fts;
		DROP TABLE IF EXISTS session_transcript_turns;
		DROP TABLE IF EXISTS session_transcript_turns_backfill;

		CREATE TABLE session_transcript_turns (
			id INTEGER PRIMARY KEY,
			agent_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			seq INTEGER NOT NULL,
			byte_offset INTEGER NOT NULL,
			text TEXT NOT NULL
		);
		CREATE UNIQUE INDEX idx_session_transcript_turns_seq
			ON session_transcript_turns(agent_id, session_key, seq);
		CREATE VIRTUAL TABLE session_transcript_turns_fts
			USING fts5(text, content='session_transcript_turns', content_rowid='id');

		CREATE TABLE session_transcript_turns_backfill (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			cursor INTEGER,
			end_rowid INTEGER NOT NULL
		);
		INSERT INTO session_transcript_turns_backfill (id, cursor, end_rowid)
		SELECT 1, CASE WHEN MAX(rowid) IS NULL THEN 0 END, COALESCE(MAX(rowid), 0) FROM session_transcripts;

		CREATE TRIGGER session_transcript_turns_fts_ai AFTER INSERT ON session_transcript_turns BEGIN
			INSERT INTO session_transcript_turns_fts(rowid, text) VALUES (new.id, new.text);
		END;

		CREATE TRIGGER session_transcript_turns_fts_ad AFTER DELETE ON session_transcript_turns BEGIN
			INSERT INTO session_transcript_turns_fts(session_transcript_turns_fts, rowid, text)
			VALUES ('delete', old.id, old.text);
		END;

		CREATE TRIGGER session_transcript_turns_ai AFTER INSERT ON session_transcripts BEGIN
			DELETE FROM session_transcript_turns WHERE ${NEW_SESSION};
			INSERT INTO session_transcript_turns(agent_id, session_key, seq, byte_offset, text)
			VALUES (new.agent_id, new.session_key, 1, 0, new.content);
		END;

		CREATE TRIGGER session_transcript_turns_ad AFTER DELETE ON session_transcripts BEGIN
			DELETE FROM session_transcript_turns WHERE ${OLD_SESSION};
		END;

		CREATE TRIGGER session_transcript_turns_au AFTER UPDATE OF content, agent_id, session_key ON session_transcripts
		WHEN length(${NEW_BYTES}) != length(${OLD_BYTES}) OR new.content IS NOT old.content
			OR new.agent_id IS NOT old.agent_id OR new.session_key IS NOT old.session_key BEGIN
			DELETE FROM session_transcript_turns WHERE ${NEW_SESSION} AND ${RENAMED};
			DELETE FROM session_transcript_turns WHERE ${OLD_SESSION} AND (${RENAMED} OR seq >= ${CUT});
			INSERT INTO session_transcript_turns(agent_id, session_key, seq, byte_offset, text)
			SELECT new.agent_id, new.session_key, tail.seq, tail.b,
				CASE WHEN tail.b = 0 THEN new.content ELSE CAST(substr(${NEW_BYTES}, tail.b + 1) AS TEXT) END
			FROM (SELECT COALESCE(MAX(seq), 0) + 1 AS seq, ${SESSION_END(NEW_SESSION)} AS b
				FROM session_transcript_turns WHERE ${NEW_SESSION}) tail
			WHERE length(${NEW_BYTES}) > tail.b OR tail.seq = 1;
		END;
	`);
}
