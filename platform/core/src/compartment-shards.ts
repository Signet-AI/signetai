import type { MigrationDb } from "./migrations/contract";

export const FTS_BASES = [
	"memories_fts",
	"memory_hints_fts",
	"session_transcripts_fts",
	"memory_artifacts_fts",
	"entities_fts",
] as const;
export type FtsBase = (typeof FTS_BASES)[number];
const SOURCES: Record<FtsBase, { table: string; columns: readonly string[] }> = {
	memories_fts: { table: "memories", columns: ["content"] },
	memory_hints_fts: { table: "memory_hints", columns: ["hint"] },
	session_transcripts_fts: { table: "session_transcripts", columns: ["content"] },
	memory_artifacts_fts: { table: "memory_artifacts", columns: ["content", "source_path"] },
	entities_fts: { table: "entities", columns: ["name", "canonical_name"] },
};
function compartment(c: number): number {
	if (!Number.isSafeInteger(c) || c < 1) throw new Error("Invalid compartment");
	return c;
}
export function ftsShardTables(base: FtsBase, compartments: readonly number[]): string[] {
	if (!FTS_BASES.includes(base)) throw new Error("Invalid FTS base");
	return [base, ...[...new Set(compartments)].sort((a, b) => a - b).map((c) => `${base}__c${compartment(c)}`)];
}
export function vecShardTables(compartments: readonly number[]): string[] {
	return [
		"vec_embeddings",
		...[...new Set(compartments)].sort((a, b) => a - b).map((c) => `vec_embeddings__c${compartment(c)}`),
	];
}
export function installCompartmentFts(db: MigrationDb, base: FtsBase, c: number | null): void {
	const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='table'").get(base);
	if (typeof schema?.sql !== "string") return;
	const { table, columns } = SOURCES[base];
	const name = c === null ? base : `${base}__c${compartment(c)}`;
	if (c !== null)
		db.exec(
			schema.sql.replace(
				/CREATE VIRTUAL TABLE\s+(?:IF NOT EXISTS\s+)?["`[]?\w+["`\]]?/i,
				`CREATE VIRTUAL TABLE IF NOT EXISTS ${name}`,
			),
		);
	const condition = (row: string) => `${row}.compartment_id IS ${c === null ? "NULL" : compartment(c)}`;
	const names = columns.join(", ");
	const values = (row: string) => columns.map((col) => `${row}.${col}`).join(", ");
	for (const suffix of ["ai", "ad", "au"]) db.exec(`DROP TRIGGER IF EXISTS ${name}_${suffix}`);
	db.exec(`
 CREATE TRIGGER ${name}_ai AFTER INSERT ON ${table} WHEN ${condition("new")} BEGIN
 INSERT INTO ${name}(rowid, ${names}) VALUES(new.rowid, ${values("new")}); END;
 CREATE TRIGGER ${name}_ad AFTER DELETE ON ${table} WHEN ${condition("old")} BEGIN
 INSERT INTO ${name}(${name}, rowid, ${names}) VALUES('delete', old.rowid, ${values("old")}); END;
 CREATE TRIGGER ${name}_au AFTER UPDATE ON ${table} BEGIN
 INSERT INTO ${name}(${name}, rowid, ${names}) SELECT 'delete', old.rowid, ${values("old")} WHERE ${condition("old")};
 INSERT INTO ${name}(rowid, ${names}) SELECT new.rowid, ${values("new")} WHERE ${condition("new")}; END;
 `);
}
export function rebuildBaseCompartmentFts(db: MigrationDb): void {
	for (const base of FTS_BASES) {
		const { table, columns } = SOURCES[base];
		if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(base)) continue;
		for (const row of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table)) {
			if (
				typeof row.name === "string" &&
				typeof row.sql === "string" &&
				new RegExp(`INSERT INTO ${base}\\s*\\(`).test(row.sql)
			) {
				if (!/^\w+$/.test(row.name)) throw new Error("Invalid trigger name");
				db.exec(`DROP TRIGGER ${row.name}`);
			}
		}
		installCompartmentFts(db, base, null);
		db.exec(
			`INSERT INTO ${base}(${base}) VALUES('delete-all'); INSERT INTO ${base}(rowid,${columns.join(",")}) SELECT rowid,${columns.join(",")} FROM ${table} WHERE compartment_id IS NULL`,
		);
	}
	if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='memories_fts_state'").get()) {
		db.exec(
			`UPDATE memories_fts_state SET memory_count=(SELECT COUNT(*) FROM memories WHERE compartment_id IS NULL), indexed_count=(SELECT COUNT(*) FROM memories_fts_docsize)`,
		);
	}
}
export function ensureCompartmentShards(db: MigrationDb, c: number, dims: number): void {
	compartment(c);
	for (const base of FTS_BASES) installCompartmentFts(db, base, c);
	if (dims === 0) {
		for (const base of ["vec_embeddings", "vec_embeddings_staging"]) {
			const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='table'").get(base);
			if (typeof schema?.sql === "string" && /USING\s+vec0/i.test(schema.sql) && /id\s+TEXT/i.test(schema.sql))
				db.exec(
					schema.sql.replace(
						/CREATE VIRTUAL TABLE\s+(?:IF NOT EXISTS\s+)?["`[]?\w+["`\]]?/i,
						`CREATE VIRTUAL TABLE IF NOT EXISTS ${base}__c${c}`,
					),
				);
		}
		return;
	}
	if (!Number.isSafeInteger(dims) || dims < 1 || dims > 65536) throw new Error("Invalid vector dimensions");
	db.exec(
		`CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings__c${c} USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[${dims}] distance_metric=cosine)`,
	);
}
export function dropEmptyCompartmentShards(db: MigrationDb): void {
	for (const row of db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB '*_fts__c[0-9]*' OR name GLOB 'vec_embeddings*__c[0-9]*')",
		)
		.all()) {
		if (
			typeof row.name !== "string" ||
			!/^(?:memories_fts|memory_hints_fts|session_transcripts_fts|memory_artifacts_fts|entities_fts|vec_embeddings(?:_staging)?)__c[1-9][0-9]*$/.test(
				row.name,
			)
		)
			continue;
		const name = row.name;
		const countTable = name.startsWith("vec_") ? name : `${name}_docsize`;
		if (db.prepare(`SELECT 1 FROM ${countTable} LIMIT 1`).get()) continue;
		for (const suffix of ["ai", "ad", "au"]) db.exec(`DROP TRIGGER IF EXISTS ${name}_${suffix}`);
		db.exec(`DROP TABLE ${name}`);
	}
}
export function compartmentFor(db: MigrationDb, classificationIds: readonly string[]): number | null {
	const ids = [...new Set(classificationIds)].sort();
	if (ids.length === 0) return null;
	if (ids.some((id) => !/^cls_[a-zA-Z0-9_-]+$/.test(id))) throw new Error("Invalid classification id");
	const key = ids.join(",");
	const existed = db.prepare("SELECT 1 FROM compartments WHERE key=?").get(key) != null;
	db.prepare("INSERT OR IGNORE INTO compartments(key,created_at) VALUES (?,?)").run(key, new Date().toISOString());
	const row = db.prepare("SELECT id FROM compartments WHERE key=?").get(key);
	if (typeof row?.id !== "number") throw new Error("Compartment not created");
	for (const id of ids)
		db.prepare("INSERT OR IGNORE INTO compartment_members(compartment_id,classification_id) VALUES (?,?)").run(
			row.id,
			id,
		);
	if (!existed) ensureCompartmentShards(db, row.id, 0);
	return row.id;
}

export function syncEmbeddingCompartment(
	db: MigrationDb,
	store: "embeddings" | "embeddings_staging",
	id: string,
	projection?: "vec_embeddings" | "vec_embeddings_staging",
): void {
	inheritEmbeddingCompartment(db, store, id);
	const row = db.prepare(`SELECT id,vector,dimensions,compartment_id FROM ${store} WHERE id=?`).get(id);
	let base = projection ?? (store === "embeddings" ? "vec_embeddings" : "vec_embeddings_staging");
	if (projection === undefined && db.prepare("SELECT 1 FROM sqlite_master WHERE name='embedding_index_state'").get()) {
		const profile = store === "embeddings" ? "active_profile_json" : "staging_profile_json";
		const state = db
			.prepare(
				`SELECT CASE WHEN json_valid(${profile}) THEN json_extract(${profile},'$.projectionSlot') END slot FROM embedding_index_state WHERE id=1`,
			)
			.get();
		if (state?.slot === "staging") base = "vec_embeddings_staging";
		else if (state?.slot === "active") base = "vec_embeddings";
	}
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(base)) return;
	if (row && typeof row.compartment_id === "number" && typeof row.dimensions === "number") {
		compartment(row.compartment_id);
		if (!Number.isSafeInteger(row.dimensions) || row.dimensions < 1 || row.dimensions > 65536)
			throw new Error("Invalid vector dimensions");
		db.exec(
			`CREATE VIRTUAL TABLE IF NOT EXISTS ${base}__c${row.compartment_id} USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[${row.dimensions}] distance_metric=cosine)`,
		);
	}
	for (const table of db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name=? OR name GLOB ?)")
		.all(base, `${base}__c[0-9]*`)) {
		if (
			typeof table.name === "string" &&
			/^(?:vec_embeddings|vec_embeddings_staging)(?:__c[1-9][0-9]*)?$/.test(table.name)
		)
			db.prepare(`DELETE FROM ${table.name} WHERE id=?`).run(id);
	}
	if (!row || row.vector === null) return;
	const target = typeof row.compartment_id === "number" ? `${base}__c${row.compartment_id}` : base;
	db.prepare(`INSERT INTO ${target}(id,embedding) VALUES (?,?)`).run(id, row.vector);
}

export function inheritEmbeddingCompartment(
	db: MigrationDb,
	store: "embeddings" | "embeddings_staging",
	id: string,
): void {
	const columns = db.prepare(`PRAGMA table_info(${store})`).all();
	if (!columns.some((c) => c.name === "source_id") || !columns.some((c) => c.name === "compartment_id")) return;
	const row = db.prepare(`SELECT * FROM ${store} WHERE id=?`).get(id);
	if (!row) return;
	const labels = new Set<string>();
	if (typeof row.compartment_id === "number")
		for (const member of db
			.prepare("SELECT classification_id FROM compartment_members WHERE compartment_id=?")
			.all(row.compartment_id))
			if (typeof member.classification_id === "string") labels.add(member.classification_id);
	for (const a of db
		.prepare(
			"SELECT classification_id FROM classification_assignments WHERE agent_id=? AND (target_kind='agent' OR (target_kind='source' AND (target_id=? OR substr(?,1,length(target_id)+1)=target_id||':')))",
		)
		.all(row.agent_id, row.source_id, row.source_id))
		if (typeof a.classification_id === "string") labels.add(a.classification_id);
	for (const [table, key] of row.source_type === "memory"
		? [["memories", "id"]]
		: [
				["memory_artifacts", "source_path"],
				["session_transcripts", "session_key"],
			]) {
		const source = db
			.prepare(`SELECT compartment_id FROM ${table} WHERE ${key}=? AND agent_id=?`)
			.get(row.source_id, row.agent_id);
		if (typeof source?.compartment_id === "number")
			for (const member of db
				.prepare("SELECT classification_id FROM compartment_members WHERE compartment_id=?")
				.all(source.compartment_id))
				if (typeof member.classification_id === "string") labels.add(member.classification_id);
	}
	const c = compartmentFor(db, [...labels]);
	db.prepare(`UPDATE ${store} SET compartment_id=? WHERE id=?`).run(c, id);
}

export function resetCompartmentVectorShards(db: MigrationDb, base: string): void {
	if (base !== "vec_embeddings" && base !== "vec_embeddings_staging") throw new Error("Invalid vector base");
	for (const row of db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB ?")
		.all(`${base}__c[0-9]*`))
		if (typeof row.name === "string" && /^vec_embeddings(?:_staging)?__c[1-9][0-9]*$/.test(row.name))
			db.exec(`DROP TABLE ${row.name}`);
}
export function deleteCompartmentVectors(db: MigrationDb, ids: readonly string[]): void {
	for (const row of db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'vec_embeddings*'")
		.all()) {
		if (typeof row.name !== "string" || !/^vec_embeddings(?:_staging)?(?:__c[1-9][0-9]*)?$/.test(row.name)) continue;
		const remove = db.prepare(`DELETE FROM ${row.name} WHERE id=?`);
		for (const id of ids) remove.run(id);
	}
}

export function missingCompartmentVectorSql(db: MigrationDb, base: string, alias: string): string {
	if (!/^vec_embeddings(?:_staging)?(?:_rowids)?$/.test(base) || !/^\w+$/.test(alias))
		throw new Error("Invalid vector lookup");
	const missing = `NOT EXISTS(SELECT 1 FROM ${base} WHERE id=${alias}.id)`;
	if (!db.prepare("SELECT 1 FROM pragma_table_info('embeddings') WHERE name='compartment_id'").get()) return missing;
	const root = base.replace(/_rowids$/, "");
	const shards = db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB ?")
		.all(`${root}__c[0-9]*`)
		.flatMap((row) => {
			if (typeof row.name !== "string" || !/^vec_embeddings(?:_staging)?__c[1-9][0-9]*$/.test(row.name)) return [];
			const c = Number(row.name.split("__c")[1]);
			return Number.isSafeInteger(c) ? [{ name: row.name, c }] : [];
		});
	const conditions = [`(${alias}.compartment_id IS NULL AND ${missing})`];
	for (const shard of shards)
		conditions.push(
			`(${alias}.compartment_id=${shard.c} AND NOT EXISTS(SELECT 1 FROM ${shard.name} WHERE id=${alias}.id))`,
		);
	conditions.push(
		`(${alias}.compartment_id IS NOT NULL${shards.length ? ` AND ${alias}.compartment_id NOT IN (${shards.map((s) => s.c).join(",")})` : ""})`,
	);
	return `(${conditions.join(" OR ")})`;
}

export function rebuildCompartmentFtsShards(db: MigrationDb): void {
	for (const base of FTS_BASES) {
		const { table, columns } = SOURCES[base];
		if (
			!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(base) ||
			!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name='compartment_id'`).get()
		)
			continue;
		const ids = new Set(
			db
				.prepare(`SELECT DISTINCT compartment_id id FROM ${table} WHERE compartment_id IS NOT NULL`)
				.all()
				.flatMap((r) => (typeof r.id === "number" ? [r.id] : [])),
		);
		for (const row of db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB ?")
			.all(`${base}__c[0-9]*`))
			if (typeof row.name === "string" && new RegExp(`^${base}__c[1-9][0-9]*$`).test(row.name))
				ids.add(Number(row.name.split("__c")[1]));
		for (const c of ids) {
			installCompartmentFts(db, base, c);
			const shard = `${base}__c${c}`;
			db.exec(
				`INSERT INTO ${shard}(${shard}) VALUES('delete-all');INSERT INTO ${shard}(rowid,${columns.join(",")}) SELECT rowid,${columns.join(",")} FROM ${table} WHERE compartment_id=${compartment(c)}`,
			);
		}
	}
}
