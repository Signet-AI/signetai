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
		"in_flight_jobs",
		"row_count",
		"recall_indexed_count",
		"recall_eligible_count",
		"recall_kind",
		"retired_generation",
	],
	vector_shard_recall_rows: ["partition_id", "embedding_id", "memory_id", "memory_scope", "is_current", "is_aggregate"],
	vector_shard_repair_partitions: ["projection", "generation", "partition_id"],
	vector_shard_singletons: ["partition_id", "vector"],
	vector_shard_members: ["projection", "generation", "embedding_id", "partition_id"],
	vector_shard_dirty: ["projection", "generation", "embedding_id"],
	vector_shard_unresolved: ["projection", "generation", "embedding_id"],
	vector_shard_repairs: [
		"projection",
		"store",
		"phase",
		"active_slot",
		"active_generation",
		"last_generation",
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
	indexes: [
		"idx_vector_shard_keys_admission",
		"idx_vector_shard_members_partition",
		"idx_vector_shard_members_embedding",
		"idx_vector_shard_recall_scope",
	],
};
export function up(db: MigrationDb): void {
	const recallIndexMissing = !db.prepare("SELECT 1 FROM sqlite_master WHERE name='vector_shard_recall_rows'").get();
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
		in_flight_jobs TEXT NOT NULL CHECK(json_valid(in_flight_jobs)),
		row_count INTEGER NOT NULL DEFAULT 0 CHECK(row_count>=0),
		retired_generation INTEGER,
		UNIQUE(projection,generation,fingerprint))`);
	db.exec(`CREATE TABLE IF NOT EXISTS vector_shard_members (
		projection TEXT NOT NULL,
		generation INTEGER NOT NULL,
		embedding_id TEXT NOT NULL,
		partition_id INTEGER NOT NULL REFERENCES vector_shard_keys(id),
		PRIMARY KEY(projection,generation,embedding_id)) WITHOUT ROWID`);
	if (
		!db
			.prepare("PRAGMA table_info(vector_shard_keys)")
			.all()
			.some((row) => row.name === "retired_generation")
	)
		db.exec("ALTER TABLE vector_shard_keys ADD COLUMN retired_generation INTEGER");
	db.exec(
		"CREATE TABLE IF NOT EXISTS vector_shard_repair_partitions(projection TEXT NOT NULL,generation INTEGER NOT NULL,partition_id INTEGER NOT NULL,PRIMARY KEY(projection,generation,partition_id)) WITHOUT ROWID",
	);
	db.exec(
		"CREATE TABLE IF NOT EXISTS vector_shard_singletons(partition_id INTEGER PRIMARY KEY REFERENCES vector_shard_keys(id) ON DELETE CASCADE,vector BLOB NOT NULL)",
	);
	for (const table of ["vector_shard_dirty", "vector_shard_unresolved"] as const)
		db.exec(
			`CREATE TABLE IF NOT EXISTS ${table}(projection TEXT NOT NULL,generation INTEGER NOT NULL,embedding_id TEXT NOT NULL,PRIMARY KEY(projection,generation,embedding_id)) WITHOUT ROWID`,
		);
	db.exec(`CREATE TABLE IF NOT EXISTS vector_shard_repairs (
		projection TEXT PRIMARY KEY,
		store TEXT NOT NULL,
		phase TEXT NOT NULL CHECK(phase IN ('pending','copying','verify','prepared','ready')),
		active_slot INTEGER NOT NULL DEFAULT 0 CHECK(active_slot IN (0,1)),
		active_generation INTEGER NOT NULL DEFAULT 1,
		last_generation INTEGER NOT NULL DEFAULT 1,
		building_generation INTEGER,
		cursor TEXT NOT NULL DEFAULT '',
		job_id TEXT,
		source_root INTEGER,
		projection_root INTEGER)`);
	if (
		!db
			.prepare("PRAGMA table_info(vector_shard_repairs)")
			.all()
			.some((row) => row.name === "last_generation")
	)
		db.exec("ALTER TABLE vector_shard_repairs ADD COLUMN last_generation INTEGER NOT NULL DEFAULT 1");
	db.exec(
		"UPDATE vector_shard_repairs SET last_generation=MAX(last_generation,active_generation,COALESCE(building_generation,0)) WHERE projection IN ('vec_embeddings','vec_embeddings_staging')",
	);
	if (!db.prepare("SELECT 1 FROM pragma_table_info('vector_shard_keys') WHERE name='recall_kind'").get())
		db.exec("ALTER TABLE vector_shard_keys ADD COLUMN recall_kind INTEGER");
	for (const column of ["recall_indexed_count", "recall_eligible_count"] as const)
		if (!db.prepare("SELECT 1 FROM pragma_table_info('vector_shard_keys') WHERE name=?").get(column))
			db.exec(`ALTER TABLE vector_shard_keys ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0 CHECK(${column}>=0)`);
	db.exec(
		"CREATE TABLE IF NOT EXISTS vector_shard_recall_rows(partition_id INTEGER NOT NULL REFERENCES vector_shard_keys(id) ON DELETE CASCADE,embedding_id TEXT NOT NULL,memory_id TEXT,memory_scope TEXT,is_current INTEGER NOT NULL,is_aggregate INTEGER NOT NULL,PRIMARY KEY(partition_id,embedding_id)) WITHOUT ROWID",
	);
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_vector_shard_members_embedding ON vector_shard_members(projection,embedding_id,partition_id)",
	);
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_vector_shard_recall_scope ON vector_shard_recall_rows(partition_id,is_current,memory_scope,is_aggregate,memory_id)",
	);
	for (const event of ["ai", "ad"] as const) {
		const row = event === "ai" ? "new" : "old";
		const delta = event === "ai" ? "+1" : "-1";
		db.exec(
			`CREATE TRIGGER IF NOT EXISTS vector_shard_recall_${event} AFTER ${event === "ai" ? "INSERT" : "DELETE"} ON vector_shard_recall_rows BEGIN UPDATE vector_shard_keys SET recall_indexed_count=recall_indexed_count${delta},recall_eligible_count=recall_eligible_count+CASE WHEN ${row}.is_current=1 AND ${row}.memory_scope IS NULL AND ${row}.is_aggregate=0 THEN ${delta} ELSE 0 END WHERE id=${row}.partition_id; END`,
		);
	}
	if (recallIndexMissing)
		db.exec(
			"UPDATE vector_shard_repairs SET phase='pending' WHERE EXISTS(SELECT 1 FROM vector_shard_members m WHERE m.projection=vector_shard_repairs.projection)",
		);
	db.exec(
		"UPDATE vector_shard_repairs SET phase='pending' WHERE EXISTS(SELECT 1 FROM vector_shard_keys k WHERE k.projection=vector_shard_repairs.projection AND k.retired_generation IS NULL AND k.row_count>0 AND (k.recall_indexed_count!=k.row_count OR k.recall_kind IS NULL OR CASE WHEN json_valid(k.fingerprint) THEN json_array_length(k.fingerprint)!=7 ELSE 1 END))",
	);
	db.exec("DROP INDEX IF EXISTS idx_vector_shard_keys_admission");
	db.exec(
		"CREATE INDEX idx_vector_shard_keys_admission ON vector_shard_keys(projection,compartment_id,embedding_compartment_id,retired_generation,generation,agent_id,visibility,project,in_flight_jobs,row_count)",
	);
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_vector_shard_members_partition ON vector_shard_members(partition_id,embedding_id)",
	);
	db.exec("DROP TRIGGER IF EXISTS vector_shard_members_ai;DROP TRIGGER IF EXISTS vector_shard_members_ad");
	db.exec(
		"CREATE TRIGGER IF NOT EXISTS vector_shard_members_ai AFTER INSERT ON vector_shard_members BEGIN UPDATE vector_shard_keys SET row_count=row_count+1 WHERE id=new.partition_id; DELETE FROM vector_shard_singletons WHERE partition_id=new.partition_id; END",
	);
	db.exec(
		"CREATE TRIGGER IF NOT EXISTS vector_shard_members_ad AFTER DELETE ON vector_shard_members BEGIN UPDATE vector_shard_keys SET row_count=row_count-1 WHERE id=old.partition_id; DELETE FROM vector_shard_singletons WHERE partition_id=old.partition_id; DELETE FROM vector_shard_recall_rows WHERE partition_id=old.partition_id AND embedding_id=old.embedding_id; END",
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
