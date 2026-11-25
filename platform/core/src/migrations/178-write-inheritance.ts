import type { MigrationArtifacts, MigrationDb } from "./contract";

const columns = {
	session_checkpoints: { author_user_id: "TEXT" },
	cross_agent_messages: { author_user_id: "TEXT", compartment_id: "INTEGER" },
} as const;
export const artifacts: MigrationArtifacts = {
	columns: Object.entries(columns).flatMap(([table, fields]) =>
		Object.keys(fields).map((column) => ({ table, column })),
	),
	indexes: ["idx_session_checkpoints_author", "idx_cross_agent_messages_compartment"],
};
export function up(db: MigrationDb): void {
	for (const table of ["embeddings", "embeddings_staging", "evidence_citations"]) {
		const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
		if (typeof schema !== "string") continue;
		const rewritten =
			table === "evidence_citations"
				? schema.includes("'community'")
					? schema
					: schema.replace("'telemetry'", "'telemetry','community'")
				: schema.replace(/(content_hash\s+TEXT\s+NOT NULL)\s+UNIQUE/i, "$1");
		if (rewritten === schema) continue;
		const objects = db
			.prepare(
				"SELECT type,name,sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL",
			)
			.all(table);
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
		if (table !== "evidence_citations")
			db.exec(
				`CREATE UNIQUE INDEX ${table}_parent_content_hash ON ${table}(agent_id,source_type,source_id,content_hash)`,
			);
	}

	db.exec("DROP INDEX IF EXISTS idx_embeddings_content_hash_unique");
	for (const table of ["embeddings", "embeddings_staging"])
		if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
			db.exec(
				`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_parent_content_hash ON ${table}(agent_id,source_type,source_id,content_hash)`,
			);
	if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_jobs'").get())
		db.exec(
			"CREATE INDEX IF NOT EXISTS idx_pending_classification_write_scope ON org_jobs(kind,status,json_extract(params_json,'$.target.agentId')) WHERE json_valid(params_json)",
		);
	for (const name of ["idx_memories_content_hash_unique", "idx_memories_idempotency_key"]) {
		const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name)?.sql;
		if (typeof sql !== "string" || /COALESCE\s*\(\s*compartment_id\s*,\s*0\s*\)/i.test(sql)) continue;
		const where = sql.toUpperCase().lastIndexOf("WHERE");
		const end = sql.lastIndexOf(")", where < 0 ? sql.length : where);
		if (end < 0) throw new Error("Invalid memory dedupe index schema");
		const scoped = `${sql.slice(0, end)},COALESCE(compartment_id,0)${sql.slice(end)}`.replace(
			/^CREATE\s+(?:UNIQUE\s+)?INDEX/i,
			"CREATE UNIQUE INDEX",
		);
		db.exec(`DROP INDEX ${name}`);
		db.exec(scoped);
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
}
