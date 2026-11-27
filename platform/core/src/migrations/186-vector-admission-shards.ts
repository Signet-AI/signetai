import type { MigrationArtifacts, MigrationDb } from "./contract";

const columns = {
	vector_shard_keys: [
		"id",
		"projection",
		"generation",
		"fingerprint",
		"agent_id",
		"visibility",
		"project",
		"compartment_id",
		"embedding_compartment_id",
		"in_flight_labels",
		"row_count",
	],
	vector_shard_members: ["projection", "generation", "embedding_id", "partition_id"],
	vector_shard_repairs: [
		"projection",
		"store",
		"phase",
		"active_slot",
		"active_generation",
		"building_generation",
		"cursor",
		"job_id",
		"source_root",
		"projection_root",
	],
};
export const artifacts: MigrationArtifacts = {
	tables: Object.keys(columns),
	columns: Object.entries(columns).flatMap(([table, names]) => names.map((column) => ({ table, column }))),
	indexes: ["idx_vector_shard_keys_admission", "idx_vector_shard_members_partition"],
};
export function up(db: MigrationDb): void {
	db.exec(`CREATE TABLE IF NOT EXISTS vector_shard_keys (
		id INTEGER PRIMARY KEY,
		projection TEXT NOT NULL,
		generation INTEGER NOT NULL,
		fingerprint TEXT NOT NULL,
		agent_id TEXT NOT NULL CHECK(length(agent_id)>0),
		visibility TEXT NOT NULL,
		project TEXT,
		compartment_id INTEGER,
		embedding_compartment_id INTEGER,
		in_flight_labels TEXT NOT NULL CHECK(json_valid(in_flight_labels)),
		row_count INTEGER NOT NULL DEFAULT 0 CHECK(row_count>=0),
		UNIQUE(projection,generation,fingerprint))`);
	db.exec(`CREATE TABLE IF NOT EXISTS vector_shard_members (
		projection TEXT NOT NULL,
		generation INTEGER NOT NULL,
		embedding_id TEXT NOT NULL,
		partition_id INTEGER NOT NULL REFERENCES vector_shard_keys(id),
		PRIMARY KEY(projection,generation,embedding_id)) WITHOUT ROWID`);
	db.exec(`CREATE TABLE IF NOT EXISTS vector_shard_repairs (
		projection TEXT PRIMARY KEY,
		store TEXT NOT NULL,
		phase TEXT NOT NULL CHECK(phase IN ('pending','copying','verify','prepared','ready')),
		active_slot INTEGER NOT NULL DEFAULT 0 CHECK(active_slot IN (0,1)),
		active_generation INTEGER NOT NULL DEFAULT 1,
		building_generation INTEGER,
		cursor TEXT NOT NULL DEFAULT '',
		job_id TEXT,
		source_root INTEGER,
		projection_root INTEGER)`);
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_vector_shard_keys_admission ON vector_shard_keys(projection,generation,agent_id,compartment_id)",
	);
	db.exec("CREATE INDEX IF NOT EXISTS idx_vector_shard_members_partition ON vector_shard_members(partition_id)");
	db.exec(
		"CREATE TRIGGER IF NOT EXISTS vector_shard_members_ai AFTER INSERT ON vector_shard_members BEGIN UPDATE vector_shard_keys SET row_count=row_count+1 WHERE id=new.partition_id; END",
	);
	db.exec(
		"CREATE TRIGGER IF NOT EXISTS vector_shard_members_ad AFTER DELETE ON vector_shard_members BEGIN UPDATE vector_shard_keys SET row_count=row_count-1 WHERE id=old.partition_id; END",
	);
	for (const [projection, store] of [
		["vec_embeddings", "embeddings"],
		["vec_embeddings_staging", "embeddings_staging"],
	] as const) {
		const exists = db.prepare("SELECT rootpage FROM sqlite_master WHERE name=? AND type='table'").get(store);
		const populated = exists && db.prepare(`SELECT 1 found FROM ${store} LIMIT 1`).get();
		db.prepare("INSERT OR IGNORE INTO vector_shard_repairs(projection,store,phase,source_root) VALUES(?,?,?,?)").run(
			projection,
			store,
			populated ? "pending" : "ready",
			exists?.rootpage ?? null,
		);
	}
}
