import { classificationsForWrite, compartmentFor } from "../compartment-shards";
import type { MigrationDb } from "./contract";

export const artifacts = {
	tables: ["import_content_registry"],
	indexes: ["idx_import_content_registry_lookup", "idx_import_content_registry_author"],
};

export function up(db: MigrationDb): void {
	db.exec(`CREATE TABLE IF NOT EXISTS import_content_registry (
		agent_id TEXT NOT NULL,
		source_id TEXT NOT NULL,
		content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
		compartment_id INTEGER REFERENCES compartments(id),
		author_user_id TEXT,
		author_credential TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		PRIMARY KEY(agent_id,source_id)
	);
	CREATE INDEX IF NOT EXISTS idx_import_content_registry_lookup ON import_content_registry(agent_id,content_hash,compartment_id);
	CREATE INDEX IF NOT EXISTS idx_import_content_registry_author ON import_content_registry(author_user_id,agent_id,content_hash);`);
	const rows = db
		.prepare(`SELECT f.agent_id,f.source_id,f.content_hash,j.author_user_id,j.author_credential,j.created_at FROM source_import_files f JOIN source_import_jobs j ON j.id=f.job_id AND j.agent_id=f.agent_id WHERE f.source_id NOT LIKE 'reserved:%' AND length(f.content_hash)=64 AND f.content_hash NOT GLOB '*[^0-9a-f]*'
		UNION ALL SELECT a.agent_id,a.source_id,a.source_external_id AS content_hash,a.author_user_id,COALESCE((SELECT j.author_credential FROM document_import_jobs j WHERE j.source_id=a.source_id AND j.agent_id=a.agent_id),'system') AS author_credential,a.captured_at AS created_at FROM memory_artifacts a WHERE a.source_kind LIKE 'source_import_%' AND a.source_id IS NOT NULL AND length(a.source_external_id)=64 AND a.source_external_id NOT GLOB '*[^0-9a-f]*' ORDER BY created_at ASC`)
		.all();
	for (const row of rows) {
		if (typeof row.agent_id !== "string" || typeof row.source_id !== "string" || typeof row.content_hash !== "string")
			throw new Error("Invalid imported source identity");
		const compartment = compartmentFor(
			db,
			classificationsForWrite(db, { agentId: row.agent_id, sourceId: row.source_id }),
		);
		db.prepare(
			"INSERT OR IGNORE INTO import_content_registry(agent_id,source_id,content_hash,compartment_id,author_user_id,author_credential,created_at) VALUES(?,?,?,?,?,?,?)",
		).run(
			row.agent_id,
			row.source_id,
			row.content_hash,
			compartment,
			row.author_user_id,
			typeof row.author_credential === "string" ? row.author_credential : "system",
			row.created_at,
		);
	}
}
