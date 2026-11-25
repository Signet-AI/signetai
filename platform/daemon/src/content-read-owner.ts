import { ftsShardTables } from "@signet/core";
import type { MigrationDb } from "@signet/core";
import type { ContentReadRequest } from "./content-read";
import { readScopeSql } from "./read-scope";

export function executeContentRead(db: MigrationDb, request: ContentReadRequest): unknown {
	if (request.op === "shards") return ftsShardTables(request.base, request.scope.compartments, db);
	const transcript = request.table === "session_transcripts";
	const memory = request.table === "memories";
	const predicate = readScopeSql("r", request.scope, {
		visibility: memory ? "visibility" : null,
		memory: memory ? "id" : null,
		session: memory ? "source_id" : "session_key",
		source: "source_id",
	});
	const author = transcript ? "speaker_user_id" : "author_user_id";
	return db
		.prepare(
			`SELECT r.*, r.${author} AS authorUserId${transcript ? ", r.speaker_user_id AS speakerUserId" : ""} FROM ${request.table} r WHERE r.${author}=? AND r.id>?${memory || request.table === "memory_artifacts" ? " AND COALESCE(r.is_deleted,0)=0" : ""}${predicate.sql} ORDER BY r.id LIMIT ?`,
		)
		.all(request.author, request.cursor, ...predicate.args, Math.max(1, Math.min(request.limit, 200)));
}
