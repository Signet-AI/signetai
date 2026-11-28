import { compartmentFor } from "../compartment-shards";
import type { MigrationDb } from "./contract";

export const artifacts = {
	columns: ["compartment_id", "author_user_id", "provenance_resolved"].map((column) => ({
		table: "memories_cold",
		column,
	})),
	indexes: ["idx_cold_author_compartment", "idx_transcript_conversation_identity"],
};

export function up(db: MigrationDb): void {
	const coldColumns = new Set(
		db
			.prepare("PRAGMA table_info(memories_cold)")
			.all()
			.map((row) => row.name),
	);
	for (const [name, definition] of [
		["compartment_id", "INTEGER REFERENCES compartments(id)"],
		["author_user_id", "TEXT"],
		["provenance_resolved", "INTEGER NOT NULL DEFAULT 0"],
	]) {
		if (!coldColumns.has(name)) db.exec(`ALTER TABLE memories_cold ADD COLUMN ${name} ${definition}`);
	}
	let cursor = 0;
	for (;;) {
		const rows = db
			.prepare(
				"SELECT rowid AS cursor,memory_id,agent_id,original_row_json FROM memories_cold WHERE rowid>? AND provenance_resolved=0 ORDER BY rowid LIMIT 256",
			)
			.all(cursor);
		if (rows.length === 0) break;
		for (const row of rows) {
			if (typeof row.cursor !== "number") throw new Error("cold_provenance_cursor_invalid");
			cursor = row.cursor;
			const parent = db
				.prepare("SELECT agent_id,compartment_id,author_user_id FROM memories WHERE id=? LIMIT 2")
				.all(row.memory_id);
			const snapshot =
				typeof row.original_row_json === "string"
					? db
							.prepare(
								"SELECT json_extract(?,'$.agent_id') AS agent_id,json_extract(?,'$.compartment_id') AS compartment_id,json_extract(?,'$.author_user_id') AS author_user_id WHERE json_valid(?)",
							)
							.get(row.original_row_json, row.original_row_json, row.original_row_json, row.original_row_json)
					: undefined;
			const provenance = parent.length === 1 ? parent[0] : snapshot;
			if (
				!provenance ||
				typeof provenance.agent_id !== "string" ||
				!provenance.agent_id ||
				row.agent_id !== provenance.agent_id
			)
				continue;
			if (
				provenance.compartment_id !== null &&
				(typeof provenance.compartment_id !== "number" ||
					!db.prepare("SELECT 1 FROM compartments WHERE id=?").get(provenance.compartment_id))
			)
				continue;
			if (snapshot && typeof snapshot.agent_id === "string" && snapshot.agent_id !== provenance.agent_id) continue;
			const labels: string[] = [];
			let valid = true;
			for (const source of [provenance, snapshot]) {
				if (!source || source.compartment_id === null) continue;
				if (
					typeof source.compartment_id !== "number" ||
					!db.prepare("SELECT 1 FROM compartments WHERE id=?").get(source.compartment_id)
				) {
					valid = false;
					break;
				}
				for (const member of db
					.prepare("SELECT classification_id FROM compartment_members WHERE compartment_id=?")
					.all(source.compartment_id)) {
					if (typeof member.classification_id !== "string") throw new Error("cold_provenance_label_invalid");
					labels.push(member.classification_id);
				}
			}
			if (!valid) continue;
			db.prepare(
				"UPDATE memories_cold SET agent_id=?,compartment_id=?,author_user_id=?,provenance_resolved=1 WHERE rowid=?",
			).run(provenance.agent_id, compartmentFor(db, labels), provenance.author_user_id, cursor);
		}
	}
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_cold_author_compartment ON memories_cold(author_user_id,agent_id,compartment_id)",
	);
	const conversationColumns = new Set(
		db
			.prepare("PRAGMA table_info(transcript_import_conversations)")
			.all()
			.map((row) => row.name),
	);
	if (!conversationColumns.has("compartment_id")) {
		db.exec(`ALTER TABLE transcript_import_conversations RENAME TO transcript_import_conversations_legacy;
		CREATE TABLE transcript_import_conversations (
			agent_id TEXT NOT NULL, external_identity TEXT NOT NULL, canonical_key TEXT NOT NULL,
			conversation_fingerprint TEXT NOT NULL, canonical_id TEXT NOT NULL, owner_source_id TEXT NOT NULL,
			owner_record_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('committing','committed','removed')),
			content_hash TEXT NOT NULL,harness TEXT NOT NULL,timestamp TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			compartment_id INTEGER REFERENCES compartments(id), PRIMARY KEY(agent_id,canonical_key)
		);
		INSERT INTO transcript_import_conversations SELECT c.*,COALESCE((SELECT t.compartment_id FROM session_transcripts t WHERE t.agent_id=c.agent_id AND t.session_key=c.canonical_key),(SELECT r.compartment_id FROM import_content_registry r WHERE r.agent_id=c.agent_id AND r.source_id=c.owner_source_id)) FROM transcript_import_conversations_legacy c;
		DROP TABLE transcript_import_conversations_legacy;
		CREATE INDEX idx_transcript_import_conversations_source ON transcript_import_conversations(agent_id,owner_source_id);
		CREATE INDEX idx_transcript_import_harness ON transcript_import_conversations(agent_id,harness);`);
	}
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_transcript_conversation_identity ON transcript_import_conversations(agent_id,external_identity,COALESCE(compartment_id,0))",
	);
	db.exec(`CREATE TRIGGER IF NOT EXISTS transcript_import_compartment_update AFTER UPDATE OF compartment_id ON session_transcripts BEGIN
		UPDATE transcript_import_conversations SET compartment_id=NEW.compartment_id WHERE agent_id=NEW.agent_id AND canonical_key=NEW.session_key;
	END;`);
}
