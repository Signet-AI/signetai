import type { MigrationArtifacts, MigrationDb } from "./contract";
import { compartmentForWrite } from "../compartment-shards";
import { installWriteGuards, installEvidencePurgeLifecycle } from "./177-classifications";

const columns = {
	session_checkpoints: { author_user_id: "TEXT" },
	cross_agent_messages: { author_user_id: "TEXT", compartment_id: "INTEGER" },
} as const;
export const artifacts: MigrationArtifacts = {
	columns: Object.entries(columns).flatMap(([table, fields]) =>
		Object.keys(fields).map((column) => ({ table, column })),
	),
	indexes: [
		"idx_session_checkpoints_author",
		"idx_cross_agent_messages_compartment",
		"idx_memories_dedupe_scope",
		"idx_memories_idempotency_scope",
	],
};
export function up(db: MigrationDb): void {
	for (const table of ["embeddings", "embeddings_staging", "evidence_citations", "embedding_index_failures"]) {
		const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
		if (typeof schema !== "string") continue;
		const rewritten =
			table === "evidence_citations"
				? schema.includes("'community'")
					? schema
					: schema.replace("'telemetry'", "'telemetry','community'")
				: table === "embedding_index_failures"
					? schema.replace(
							/UNIQUE\s*\(content_hash,\s*target_fingerprint\)/i,
							"UNIQUE(agent_id,source_type,source_id,content_hash,target_fingerprint)",
						)
					: schema.replace(/(content_hash\s+TEXT\s+NOT NULL)\s+UNIQUE/i, "$1");
		if (rewritten === schema) continue;
		const objects = db
			.prepare(
				"SELECT type,name,sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL",
			)
			.all(table);
		const references = db
			.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name<>? AND instr(sql,?)>0")
			.all(table, table);
		for (const trigger of references) {
			if (typeof trigger.name === "string") db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
		}
		const temporary = `${table}_write_inheritance`;
		db.exec(
			rewritten.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|[^\s(]+)/i, `CREATE TABLE ${temporary}`),
		);
		const names = db
			.prepare(`PRAGMA table_info(${table})`)
			.all()
			.map((row) => String(row.name))
			.join(",");
		db.exec(`INSERT INTO ${temporary}(${names}) SELECT ${names} FROM ${table}`);
		db.exec(`DROP TABLE ${table}`);
		db.exec(`ALTER TABLE ${temporary} RENAME TO ${table}`);
		for (const object of objects) {
			if (typeof object.sql !== "string" || object.name === "idx_embeddings_content_hash_unique") continue;
			db.exec(object.sql);
		}
		for (const trigger of references) if (typeof trigger.sql === "string") db.exec(trigger.sql);
		if (table === "embeddings" || table === "embeddings_staging")
			db.exec(`CREATE INDEX ${table}_parent_content_hash ON ${table}(agent_id,source_type,source_id,content_hash)`);
	}

	db.exec("DROP INDEX IF EXISTS idx_embeddings_content_hash_unique");
	for (const table of ["embeddings", "embeddings_staging"])
		if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
			db.exec(
				`CREATE INDEX IF NOT EXISTS ${table}_parent_content_hash ON ${table}(agent_id,source_type,source_id,content_hash)`,
			);
	if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_jobs'").get())
		db.exec(
			"CREATE INDEX IF NOT EXISTS idx_pending_classification_write_scope ON org_jobs(kind,status,json_extract(params_json,'$.target.agentId'),json_extract(params_json,'$.target.kind'),json_extract(params_json,'$.target.id')) WHERE json_valid(params_json)",
		);
	if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='classification_assignments'").get())
		db.exec(
			"CREATE INDEX IF NOT EXISTS idx_classification_assignments_write_scope ON classification_assignments(agent_id,target_kind,target_id,classification_id)",
		);
	for (const table of [
		"memories",
		"embeddings",
		"embeddings_staging",
		"session_transcripts",
		"memory_artifacts",
		"documents",
	]) {
		const indexes = db
			.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL")
			.all(table);
		for (const index of indexes) {
			if (
				typeof index.sql !== "string" ||
				typeof index.name !== "string" ||
				!/^CREATE\s+UNIQUE\s+INDEX/i.test(index.sql) ||
				!/\b(content_hash|idempotency_key)\b/i.test(index.sql)
			)
				continue;
			db.exec(`DROP INDEX "${index.name.replaceAll('"', '""')}"`);
			db.exec(index.sql.replace(/^CREATE\s+UNIQUE\s+INDEX/i, "CREATE INDEX"));
		}
	}
	if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories'").get()) {
		db.exec(
			"CREATE INDEX IF NOT EXISTS idx_memories_dedupe_scope ON memories(agent_id,project,visibility,compartment_id,content_hash) WHERE is_deleted=0",
		);
		db.exec(
			"CREATE INDEX IF NOT EXISTS idx_memories_idempotency_scope ON memories(agent_id,project,visibility,compartment_id,idempotency_key) WHERE is_deleted=0",
		);
	}

	for (const [table, fields] of Object.entries(columns)) {
		if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
		const present = new Set(
			db
				.prepare(`PRAGMA table_info(${table})`)
				.all()
				.map((row) => row.name),
		);
		for (const [name, definition] of Object.entries(fields)) {
			if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
		}
	}
	if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_checkpoints'").get())
		db.exec("CREATE INDEX IF NOT EXISTS idx_session_checkpoints_author ON session_checkpoints(author_user_id)");
	if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cross_agent_messages'").get())
		db.exec(
			"CREATE INDEX IF NOT EXISTS idx_cross_agent_messages_compartment ON cross_agent_messages(from_agent_id,compartment_id)",
		);
	installWriteGuards(db);
	if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cross_agent_messages'").get()) {
		let cursor = "";
		for (;;) {
			const rows = db
				.prepare("SELECT id,from_agent_id,from_session_key FROM cross_agent_messages WHERE id>? ORDER BY id LIMIT 2000")
				.all(cursor);
			if (!rows.length) break;
			for (const row of rows) {
				if (typeof row.id !== "string" || typeof row.from_agent_id !== "string")
					throw new Error("invalid_message_owner");
				const compartment = compartmentForWrite(db, {
					agentId: row.from_agent_id,
					sessionKey: typeof row.from_session_key === "string" ? row.from_session_key : null,
				});
				db.prepare("UPDATE cross_agent_messages SET compartment_id=? WHERE id=?").run(compartment, row.id);
				cursor = row.id;
			}
		}
	}
	installEvidencePurgeLifecycle(db);
}
