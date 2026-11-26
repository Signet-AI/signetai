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
const APPENDED = [
	"new.agent_id IS old.agent_id",
	"new.session_key IS old.session_key",
	`length(${OLD_BYTES}) > 0`,
	`length(${NEW_BYTES}) > length(${OLD_BYTES})`,
	`substr(${NEW_BYTES}, 1, length(${OLD_BYTES})) = ${OLD_BYTES}`,
	`(substr(${NEW_BYTES}, length(${OLD_BYTES}) + 1, 1) IN ${WHITESPACE} OR substr(${OLD_BYTES}, length(${OLD_BYTES}), 1) IN ${WHITESPACE})`,
].join(" AND ");
const OLD_SESSION = "agent_id = old.agent_id AND session_key = old.session_key";
const NEW_SESSION = "agent_id = new.agent_id AND session_key = new.session_key";

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
			text TEXT NOT NULL
		);
		CREATE INDEX idx_session_transcript_turns_session
			ON session_transcript_turns(agent_id, session_key);
		CREATE VIRTUAL TABLE session_transcript_turns_fts
			USING fts5(text, content='session_transcript_turns', content_rowid='id');

		CREATE TABLE session_transcript_turns_backfill (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			cursor INTEGER NOT NULL,
			end_rowid INTEGER NOT NULL
		);
		INSERT INTO session_transcript_turns_backfill (id, cursor, end_rowid)
		VALUES (1, 0, COALESCE((SELECT MAX(rowid) FROM session_transcripts), 0));

		CREATE TRIGGER session_transcript_turns_fts_ai AFTER INSERT ON session_transcript_turns BEGIN
			INSERT INTO session_transcript_turns_fts(rowid, text) VALUES (new.id, new.text);
		END;

		CREATE TRIGGER session_transcript_turns_fts_ad AFTER DELETE ON session_transcript_turns BEGIN
			INSERT INTO session_transcript_turns_fts(session_transcript_turns_fts, rowid, text)
			VALUES ('delete', old.id, old.text);
		END;

		CREATE TRIGGER session_transcript_turns_ai AFTER INSERT ON session_transcripts BEGIN
			DELETE FROM session_transcript_turns WHERE ${NEW_SESSION};
			INSERT INTO session_transcript_turns(agent_id, session_key, text)
			VALUES (new.agent_id, new.session_key, new.content);
		END;

		CREATE TRIGGER session_transcript_turns_ad AFTER DELETE ON session_transcripts BEGIN
			DELETE FROM session_transcript_turns WHERE ${OLD_SESSION};
		END;

		CREATE TRIGGER session_transcript_turns_au AFTER UPDATE OF content, agent_id, session_key ON session_transcripts
		WHEN length(${NEW_BYTES}) != length(${OLD_BYTES}) OR new.content IS NOT old.content
			OR new.agent_id IS NOT old.agent_id OR new.session_key IS NOT old.session_key BEGIN
			DELETE FROM session_transcript_turns
			WHERE ${OLD_SESSION} AND (SELECT NOT (${APPENDED}));
			INSERT INTO session_transcript_turns(agent_id, session_key, text)
			SELECT new.agent_id, new.session_key, CASE
				WHEN EXISTS (SELECT 1 FROM session_transcript_turns WHERE ${OLD_SESSION})
				THEN CAST(substr(${NEW_BYTES}, length(${OLD_BYTES}) + 1) AS TEXT)
				ELSE new.content
			END;
		END;
	`);
}
