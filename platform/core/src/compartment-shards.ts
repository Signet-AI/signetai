import type { MigrationDb } from "./migrations/contract";
import {
	inFlightClassificationJobsSql,
	classificationLabelsForJobsSql,
	readScopeSql,
	type ReadScope,
} from "./read-scope";
import { ClassifiedDestinationError, currentWritePrincipal } from "./write-principal";

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
export function selectShardTables(names: readonly string[], readable: readonly number[] | "all"): string[] {
	const allowed = readable === "all" ? null : new Set(readable.map(compartment));
	const bases = new Set<string>([...FTS_BASES, "vec_embeddings", "vec_embeddings_staging"]);
	return [...new Set(names)]
		.filter((name) => {
			if (bases.has(name)) return true;
			const match = /^(.*)__c([1-9][0-9]*)$/.exec(name);
			if (!match || !bases.has(match[1] ?? "")) return false;
			const value = Number(match[2]);
			return Number.isSafeInteger(value) && (allowed === null || allowed.has(value));
		})
		.sort((left, right) => {
			const l = left.split("__c"),
				r = right.split("__c");
			return (l[0] ?? "").localeCompare(r[0] ?? "") || Number(l[1] ?? 0) - Number(r[1] ?? 0);
		});
}

interface ShardCatalogueDb {
	prepare(sql: string): { all(...args: unknown[]): readonly Record<string, unknown>[] };
}

function physicalShardTables(db: ShardCatalogueDb, base: string, readable: readonly number[] | "all"): string[] {
	const names = db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name=? OR name GLOB ?) ORDER BY name")
		.all(base, `${base}__c[0-9]*`)
		.flatMap((row) => (typeof row.name === "string" ? [row.name] : []));
	return selectShardTables(names, readable);
}
export function ftsShardTables(base: FtsBase, compartments: readonly number[] | "all", db: ShardCatalogueDb): string[] {
	if (!FTS_BASES.includes(base)) throw new Error("Invalid FTS base");
	return physicalShardTables(db, base, compartments);
}
export function vecShardTables(
	compartments: readonly number[] | "all",
	db: ShardCatalogueDb,
	base: "vec_embeddings" | "vec_embeddings_staging" = "vec_embeddings",
): string[] {
	return physicalShardTables(db, base, compartments);
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
 CREATE TRIGGER ${name}_au AFTER UPDATE OF ${names},compartment_id ON ${table} BEGIN
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
export function compartmentFor(db: MigrationDb, classificationIds: readonly string[]): number | null {
	const ids = [...new Set(classificationIds)].sort();
	if (ids.length === 0) return null;
	if (ids.some((id) => !/^cls_[a-zA-Z0-9_-]+$/.test(id))) throw new Error("Invalid classification id");
	const key = ids.join(",");
	const existing = db.prepare("SELECT id FROM compartments WHERE key=?").get(key);
	if (typeof existing?.id === "number") return existing.id;
	db.prepare("INSERT OR IGNORE INTO compartments(key,created_at) VALUES (?,?)").run(key, new Date().toISOString());
	const row = db.prepare("SELECT id FROM compartments WHERE key=?").get(key);
	if (typeof row?.id !== "number") throw new Error("Compartment not created");
	for (const id of ids)
		db.prepare("INSERT OR IGNORE INTO compartment_members(compartment_id,classification_id) VALUES (?,?)").run(
			row.id,
			id,
		);
	ensureCompartmentShards(db, row.id, 0);
	return row.id;
}

export interface CompartmentWriteScope {
	readonly agentId: string;
	readonly sessionKey?: string | null;
	readonly sourceId?: string | null;
	readonly memoryId?: string | null;
	readonly parentCompartment?: number | null;
}
export function classificationsForWrite(
	db: Pick<MigrationDb, "prepare">,
	input: CompartmentWriteScope,
): readonly string[] {
	if (!input.agentId) throw new Error("agent_required");
	const labels = new Set<string>();
	const schema = shardSchema(db);
	const add = (rows: readonly Record<string, unknown>[]) => {
		for (const row of rows) if (typeof row.classification_id === "string") labels.add(row.classification_id);
	};
	if (input.parentCompartment !== undefined && input.parentCompartment !== null)
		add(
			db
				.prepare("SELECT classification_id FROM compartment_members WHERE compartment_id=?")
				.all(input.parentCompartment),
		);
	const assignments = (session: unknown, source: unknown, memory: unknown) => {
		const sessions =
			typeof session === "string"
				? [...new Set([session, `session:${session}`, ...(session.startsWith("session:") ? [session.slice(8)] : [])])]
				: [];
		const sources: string[] = [];
		if (typeof source === "string") {
			sources.push(source);
			for (let i = source.indexOf(":"); i >= 0; i = source.indexOf(":", i + 1)) sources.push(source.slice(0, i));
		}
		add(
			db
				.prepare(
					"SELECT classification_id FROM classification_assignments WHERE target_kind='agent' AND agent_id=? UNION ALL SELECT classification_id FROM classification_assignments WHERE target_kind='session' AND target_id IN (SELECT value FROM json_each(?)) AND agent_id=? UNION ALL SELECT classification_id FROM classification_assignments WHERE target_kind='source' AND target_id IN (SELECT value FROM json_each(?)) AND agent_id=? UNION ALL SELECT classification_id FROM classification_assignments WHERE target_kind='memory' AND target_id=? AND agent_id=?",
				)
				.all(
					input.agentId,
					JSON.stringify(sessions),
					input.agentId,
					JSON.stringify(sources),
					input.agentId,
					memory,
					input.agentId,
				),
		);
		if (schema.tables.has("org_jobs")) {
			const targets = [
				["agent", [input.agentId]],
				["session", sessions],
				["source", sources],
				["memory", typeof memory === "string" ? [memory] : []],
			] as const;
			const arms: string[] = [];
			const args: string[] = [];
			for (const [kind, ids] of targets) {
				if (ids.length === 0) continue;
				arms.push(
					"SELECT json_extract(params_json,'$.id') AS classification_id FROM org_jobs WHERE json_valid(params_json) AND kind='classify' AND status IN ('pending','running') AND json_extract(params_json,'$.target.agentId')=? AND json_extract(params_json,'$.target.kind')=? " +
						(kind === "agent"
							? ""
							: " AND json_extract(params_json,'$.target.id') IN (SELECT value FROM json_each(?))"),
				);
				args.push(input.agentId, kind);
				if (kind !== "agent") args.push(JSON.stringify(ids));
			}
			add(db.prepare(arms.join(" UNION ALL ")).all(...args));
		}
	};
	assignments(input.sessionKey ?? null, input.sourceId ?? null, input.memoryId ?? null);
	if (input.memoryId && schema.tables.has("memories")) {
		const columns = tableColumns(db, "memories");
		const parent = db
			.prepare(
				`SELECT compartment_id,${columns.has("source_id") ? "source_id" : "NULL AS source_id"} FROM memories WHERE id=? AND agent_id=?`,
			)
			.get(input.memoryId, input.agentId);
		if (typeof parent?.compartment_id === "number")
			add(
				db
					.prepare("SELECT classification_id FROM compartment_members WHERE compartment_id=?")
					.all(parent.compartment_id),
			);
		if (parent) assignments(parent.source_id, parent.source_id, input.memoryId);
	}
	if (input.sourceId)
		for (const [table, key] of [
			["memory_artifacts", "source_path"],
			["session_transcripts", "session_key"],
		]) {
			if (!table || !key || !schema.tables.has(table)) continue;
			for (const parent of db
				.prepare(`SELECT compartment_id,source_id,session_key FROM ${table} WHERE agent_id=? AND ${key}=?`)
				.all(input.agentId, input.sourceId)) {
				if (typeof parent.compartment_id === "number")
					add(
						db
							.prepare("SELECT classification_id FROM compartment_members WHERE compartment_id=?")
							.all(parent.compartment_id),
					);
				assignments(parent.session_key, parent.source_id, null);
			}
		}
	const principal = currentWritePrincipal();
	if (
		principal &&
		labels.size > 0 &&
		db
			.prepare(
				"SELECT 1 FROM json_each(?) label WHERE NOT EXISTS(SELECT 1 FROM classification_audience a WHERE a.classification_id=label.value AND ((a.principal_kind='user' AND a.principal_id=?) OR (a.principal_kind='group' AND a.principal_id IN (SELECT group_id FROM group_members WHERE user_id=?)))) LIMIT 1",
			)
			.get(JSON.stringify([...labels]), principal.userId, principal.userId)
	)
		throw new ClassifiedDestinationError();
	return [...labels].sort();
}
export function compartmentForWrite(db: MigrationDb, input: CompartmentWriteScope): number | null {
	return compartmentFor(db, classificationsForWrite(db, input));
}

interface ShardSchema {
	version: unknown;
	tables: Map<string, string>;
	columns: Map<string, ReadonlySet<string>>;
}
const shardSchemas = new WeakMap<Pick<MigrationDb, "prepare">, ShardSchema>();
function shardSchema(db: Pick<MigrationDb, "prepare">): ShardSchema {
	const version = db.prepare("PRAGMA schema_version").get()?.schema_version;
	const hit = shardSchemas.get(db);
	if (hit?.version === version) return hit;
	const tables = new Map<string, string>();
	for (const row of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all())
		if (typeof row.name === "string" && typeof row.sql === "string") tables.set(row.name, row.sql);
	const schema = { version, tables, columns: new Map<string, ReadonlySet<string>>() };
	shardSchemas.set(db, schema);
	return schema;
}
function tableColumns(db: Pick<MigrationDb, "prepare">, table: string): ReadonlySet<string> {
	const schema = shardSchema(db);
	const hit = schema.columns.get(table);
	if (hit) return hit;
	if (!/^\w+$/.test(table)) throw new Error("invalid_table");
	const columns = new Set(
		db
			.prepare(`PRAGMA table_info(${table})`)
			.all()
			.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
	);
	schema.columns.set(table, columns);
	return columns;
}
export function syncEmbeddingCompartment(
	db: MigrationDb,
	store: "embeddings" | "embeddings_staging",
	id: string,
	projection?: "vec_embeddings" | "vec_embeddings_staging",
	vector?: Float32Array,
): number {
	inheritEmbeddingCompartment(db, store, id);
	const columns = tableColumns(db, store);
	const row = db
		.prepare(
			`SELECT id,vector,dimensions,${columns.has("compartment_id") ? "compartment_id" : "NULL AS compartment_id"}${columns.has("projection_compartment_id") ? ",projection_compartment_id" : ""} FROM ${store} WHERE id=?`,
		)
		.get(id);
	let base = projection ?? (store === "embeddings" ? "vec_embeddings" : "vec_embeddings_staging");
	let schema = shardSchema(db);
	if (projection === undefined && schema.tables.has("embedding_index_state")) {
		const profile = store === "embeddings" ? "active_profile_json" : "staging_profile_json";
		const fallback =
			store === "embeddings_staging"
				? "CASE WHEN json_valid(active_profile_json) AND json_extract(active_profile_json,'$.projectionSlot')='staging' THEN 'active' ELSE 'staging' END"
				: "'active'";
		const state = db
			.prepare(
				`SELECT COALESCE(CASE WHEN json_valid(${profile}) THEN json_extract(${profile},'$.projectionSlot') END,${fallback}) slot,CASE WHEN json_valid(${profile}) THEN json_extract(${profile},'$.dimensions') END dimensions FROM embedding_index_state WHERE id=1`,
			)
			.get();
		if (
			store === "embeddings_staging" &&
			typeof state?.dimensions === "number" &&
			row &&
			row.dimensions !== state.dimensions
		)
			return 0;
		if (state?.slot === "staging") base = "vec_embeddings_staging";
		else if (state?.slot === "active") base = "vec_embeddings";
	}
	if (!row || !schema.tables.has(base)) return 0;
	const c = typeof row.compartment_id === "number" ? compartment(row.compartment_id) : null;
	const previous = columns.has("projection_compartment_id") ? row.projection_compartment_id : row.compartment_id;
	const old = typeof previous === "number" ? `${base}__c${compartment(previous)}` : base;
	if (schema.tables.has(old)) db.prepare(`DELETE FROM ${old} WHERE id=?`).run(id);
	if (row.vector === null && vector === undefined) return 0;
	const target = c === null ? base : `${base}__c${c}`;
	if (!schema.tables.has(target)) {
		const definition = schema.tables.get(base);
		if (!definition) throw new Error("vector_index_missing");
		db.exec(
			/USING\s+vec0/i.test(definition)
				? definition.replace(
						/CREATE VIRTUAL TABLE\s+(?:IF NOT EXISTS\s+)?["`[]?\w+["`\]]?/i,
						`CREATE VIRTUAL TABLE ${target}`,
					)
				: `CREATE TABLE ${target}(id TEXT PRIMARY KEY,embedding BLOB)`,
		);
		schema = shardSchema(db);
		if (!schema.tables.has(target)) throw new Error("vector_shard_missing");
	}
	db.prepare(`INSERT INTO ${target}(id,embedding) VALUES (?,?)`).run(id, vector ?? row.vector);
	const changes = db.prepare("SELECT changes() n").get();
	if (typeof changes?.n !== "number") throw new Error("vector_projection_count_missing");
	if (columns.has("projection_compartment_id"))
		db.prepare(`UPDATE ${store} SET projection_compartment_id=? WHERE id=?`).run(c, id);
	syncVectorAdmission(db, base, store, id, vector);
	return changes.n;
}
export function inheritEmbeddingCompartment(
	db: MigrationDb,
	store: "embeddings" | "embeddings_staging",
	id: string,
): void {
	const columns = tableColumns(db, store);
	if (!columns.has("source_id") || !columns.has("compartment_id")) return;
	const row = db.prepare(`SELECT agent_id,source_type,source_id,compartment_id FROM ${store} WHERE id=?`).get(id);
	if (!row) return;
	let agent = typeof row.agent_id === "string" ? row.agent_id : null;
	let parent: number | null = null;
	const sources =
		row.source_type === "memory"
			? [["memories", "id"]]
			: row.source_type === "skill"
				? [["entities", "id"]]
				: [
						["memory_artifacts", "source_path"],
						["session_transcripts", "session_key"],
					];
	for (const [table, key] of sources) {
		if (!table || !key || !shardSchema(db).tables.has(table)) continue;
		const source = db
			.prepare(`SELECT agent_id,compartment_id FROM ${table} WHERE ${key}=?${agent === null ? "" : " AND agent_id=?"}`)
			.get(...(agent === null ? [row.source_id] : [row.source_id, agent]));
		if (typeof source?.agent_id === "string") agent = source.agent_id;
		if (typeof source?.compartment_id === "number")
			parent = compartmentFor(db, [
				...db
					.prepare("SELECT classification_id FROM compartment_members WHERE compartment_id IN (?,?)")
					.all(parent, source.compartment_id)
					.flatMap((r) => (typeof r.classification_id === "string" ? [r.classification_id] : [])),
			]);
	}
	if (agent === null) return;
	const c = compartmentForWrite(db, {
		agentId: agent,
		sourceId: typeof row.source_id === "string" ? row.source_id : null,
		memoryId: row.source_type === "memory" && typeof row.source_id === "string" ? row.source_id : null,
		parentCompartment: parent,
	});
	if (c !== row.compartment_id || agent !== row.agent_id)
		db.prepare(`UPDATE ${store} SET compartment_id=?,agent_id=? WHERE id=?`).run(c, agent, id);
}

export function resetVectorAdmissionProjection(db: MigrationDb, base: VectorProjectionBase): void {
	if (!shardSchema(db).tables.has("vector_shard_repairs")) return;
	const state = db.prepare("SELECT job_id FROM vector_shard_repairs WHERE projection=?").get(base);
	if (state?.job_id != null) throw new Error("vector_projection_repair_busy");
	db.prepare(
		"UPDATE vector_shard_repairs SET phase='pending',building_generation=NULL,cursor='',job_id=NULL WHERE projection=?",
	).run(base);
}
export function resetCompartmentVectorShards(db: MigrationDb, base: string): void {
	if (base !== "vec_embeddings" && base !== "vec_embeddings_staging") throw new Error("Invalid vector base");
	resetVectorAdmissionProjection(db, base);
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
		if (
			typeof row.name !== "string" ||
			!/^vec_embeddings(?:_staging)?(?:(?:__c[1-9][0-9]*)|(?:__admission_[01]))?$/.test(row.name)
		)
			continue;
		if (/__admission_[01]$/.test(row.name)) {
			const projection = row.name.replace(/__admission_[01]$/, "");
			const remove = db.prepare(
				`DELETE FROM ${row.name} WHERE id IN(SELECT json_array(embedding_id,generation) FROM vector_shard_members WHERE projection=? AND embedding_id=?)`,
			);
			for (const id of ids) remove.run(projection, id);
		} else {
			const remove = db.prepare(`DELETE FROM ${row.name} WHERE id=?`);
			for (const id of ids) remove.run(id);
		}
	}
	if (shardSchema(db).tables.has("vector_shard_members"))
		for (const id of ids) db.prepare("DELETE FROM vector_shard_members WHERE embedding_id=?").run(id);
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

export function vectorShardSwapStatements(names: readonly string[], active: string, staging: string): string[] {
	if (
		!["vec_embeddings", "vec_embeddings_staging"].includes(active) ||
		!["vec_embeddings", "vec_embeddings_staging"].includes(staging) ||
		active === staging
	)
		throw new Error("invalid_projection_slots");
	const existing = new Set(names.filter((n) => /^vec_embeddings(?:_staging)?__c[1-9][0-9]*$/.test(n)));
	const ids = [...new Set([...existing].map((n) => Number(n.split("__c")[1])))].sort((a, b) => a - b);
	const statements: string[] = [];
	for (const c of ids) {
		const old = `${active}__c${c}`,
			next = `${staging}__c${c}`,
			temp = `vec_embeddings_swap__c${c}`;
		if (existing.has(old)) statements.push(`ALTER TABLE ${old} RENAME TO ${temp}`);
		if (existing.has(next) && next !== `vec_embeddings__c${c}`)
			statements.push(`ALTER TABLE ${next} RENAME TO vec_embeddings__c${c}`);
		if (existing.has(old)) statements.push(`ALTER TABLE ${temp} RENAME TO vec_embeddings_staging__c${c}`);
	}
	return statements;
}

export type VectorProjectionBase = "vec_embeddings" | "vec_embeddings_staging";
function vectorAdmissionRowsSql(
	store: "embeddings" | "embeddings_staging",
	wanted: string,
	preparingBase?: VectorProjectionBase,
): string {
	const preparingJob = preparingBase ? "_vector_build.job_id" : undefined;
	const memoryLabels = inFlightClassificationJobsSql("m", undefined, preparingJob);
	const embeddingLabels = inFlightClassificationJobsSql(
		"e",
		{
			memory: "source_id",
			source: "source_id",
			session: null,
		},
		preparingJob,
	);
	const preparation = preparingBase
		? ` JOIN vector_shard_repairs _vector_build ON _vector_build.projection='${preparingBase}'`
		: "";
	return `SELECT e.id,e.agent_id,CASE WHEN m.id IS NULL OR m.visibility='global' THEN 'global' WHEN m.visibility='archived' THEN 'archived' ELSE 'private' END visibility,m.project,CASE WHEN m.id IS NOT NULL THEN m.compartment_id ELSE e.compartment_id END compartment_id,e.compartment_id embedding_compartment_id,(SELECT json_group_array(value) FROM (SELECT value FROM json_each(${memoryLabels}) UNION SELECT value FROM json_each(${embeddingLabels}) ORDER BY value)) in_flight_jobs FROM ${store} e${preparation} LEFT JOIN memories m ON m.id=e.source_id AND e.source_type='memory' WHERE e.id=${wanted} AND e.agent_id IS NOT NULL AND length(e.agent_id)>0 AND (e.source_type!='memory' OR (m.id IS NOT NULL AND m.agent_id=e.agent_id))`;
}
function vectorAdmissionFingerprint(alias: string): string {
	return `json_array(${alias}.agent_id,${alias}.visibility,${alias}.project,${alias}.compartment_id,${alias}.embedding_compartment_id,json(${alias}.in_flight_jobs))`;
}
function vectorAdmissionMoveSql(
	base: VectorProjectionBase,
	store: "embeddings" | "embeddings_staging",
	table: string,
	wanted: string,
	generation: number,
	preparing = false,
	fallbackTable: string = base,
	vectorBytes?: number,
): string {
	const rows = vectorAdmissionRowsSql(store, wanted, preparing ? base : undefined);
	const fingerprint = vectorAdmissionFingerprint("r");
	const live = `SELECT m.generation FROM vector_shard_members m JOIN vector_shard_keys k ON k.id=m.partition_id WHERE m.projection='${base}' AND m.embedding_id=${wanted} AND k.retired_generation IS NULL AND k.generation<=(SELECT active_generation FROM vector_shard_repairs WHERE projection='${base}')`;
	const fallbackId = fallbackTable === base ? "e.id" : `(SELECT json_array(e.id,generation) FROM (${live}) LIMIT 1)`;
	const removal = preparing
		? `DELETE FROM ${table} WHERE id=json_array(${wanted},${generation}); DELETE FROM vector_shard_members WHERE projection='${base}' AND generation=${generation} AND embedding_id=${wanted};`
		: `DELETE FROM ${table} WHERE id IN(SELECT json_array(${wanted},generation) FROM (${live})); DELETE FROM vector_shard_members WHERE projection='${base}' AND embedding_id=${wanted} AND partition_id IN(SELECT id FROM vector_shard_keys WHERE projection='${base}' AND retired_generation IS NULL AND generation<=${generation});`;
	return `
	DELETE FROM _vector_admission_transfer;
	INSERT INTO _vector_admission_transfer(id,vector) SELECT e.id,COALESCE((SELECT vector FROM _vector_admission_override WHERE id=e.id),e.vector,(SELECT embedding FROM ${fallbackTable} WHERE id=${fallbackId}),(SELECT embedding FROM ${base} WHERE id=e.id)) FROM ${store} e WHERE e.id=${wanted};
	${removal}
	INSERT OR IGNORE INTO vector_shard_keys(projection,generation,fingerprint,agent_id,visibility,project,compartment_id,embedding_compartment_id,in_flight_jobs) SELECT '${base}',${generation},${fingerprint},r.agent_id,r.visibility,r.project,r.compartment_id,r.embedding_compartment_id,r.in_flight_jobs FROM (${rows}) r;
	INSERT INTO ${table}(id,admission,embedding) SELECT json_array(r.id,${generation}),k.id,t.vector FROM (${rows}) r JOIN vector_shard_keys k ON k.projection='${base}' AND k.generation=${generation} AND k.fingerprint=${fingerprint} JOIN _vector_admission_transfer t ON t.id=r.id WHERE t.vector IS NOT NULL${vectorBytes === undefined ? "" : ` AND length(t.vector)=${vectorBytes}`};
	INSERT INTO vector_shard_members(projection,generation,embedding_id,partition_id) SELECT '${base}',${generation},json_extract(v.id,'$[0]'),v.admission FROM ${table} v WHERE v.id=json_array(${wanted},${generation});
	DELETE FROM _vector_admission_transfer;`;
}
const vectorAdmissionWriters = new WeakMap<MigrationDb, Map<string, unknown>>();
export function prepareVectorAdmissionWriter(
	db: MigrationDb,
	base: VectorProjectionBase,
	store: "embeddings" | "embeddings_staging",
	initialize = true,
): boolean {
	if (!shardSchema(db).tables.has("vector_shard_repairs")) return false;
	let state = db
		.prepare(
			"SELECT phase,store,source_root,job_id,active_slot,active_generation,building_generation FROM vector_shard_repairs WHERE projection=?",
		)
		.get(base);
	if (typeof state?.active_generation !== "number") return false;
	const sourceRoot = db
		.prepare("SELECT rootpage FROM sqlite_master WHERE name=? AND type='table'")
		.get(store)?.rootpage;
	if (typeof sourceRoot !== "number") return false;
	if (state.store !== store || state.source_root !== sourceRoot) {
		if (!initialize) return false;
		resetVectorAdmissionProjection(db, base);
		db.prepare("UPDATE vector_shard_repairs SET store=?,source_root=? WHERE projection=?").run(store, sourceRoot, base);
		state = db
			.prepare(
				"SELECT phase,store,source_root,job_id,active_slot,active_generation,building_generation FROM vector_shard_repairs WHERE projection=?",
			)
			.get(base);
		if (typeof state?.active_generation !== "number") throw new Error("vector_repair_marker_missing");
	}
	const definition = shardSchema(db).tables.get(base);
	const dimensions = definition ? /embedding\s+FLOAT\[(\d+)\]/i.exec(definition)?.[1] : undefined;
	if (!dimensions) return false;
	const slot = state.active_slot === 1 ? 1 : 0;
	const table = `${base}__admission_${slot}`;
	if (
		initialize &&
		state.phase === "ready" &&
		!shardSchema(db).tables.has(table) &&
		db.prepare(`SELECT 1 FROM ${store} LIMIT 1`).get()
	) {
		resetVectorAdmissionProjection(db, base);
		return prepareVectorAdmissionWriter(db, base, store, initialize);
	}
	if (initialize && state.phase === "ready" && !shardSchema(db).tables.has(table))
		db.exec(
			`CREATE VIRTUAL TABLE ${table} USING vec0(id TEXT PRIMARY KEY,admission INTEGER partition key,embedding FLOAT[${dimensions}] distance_metric=cosine,chunk_size=64)`,
		);
	let nativeDimensions = shardSchema(db)
		.tables.get(table)
		?.match(/embedding\s+FLOAT\[(\d+)\]/i)?.[1];
	if (initialize && state.phase === "copying" && state.job_id === null && nativeDimensions !== dimensions) {
		db.exec(`DROP TABLE IF EXISTS ${table}`);
		db.exec(
			`CREATE VIRTUAL TABLE ${table} USING vec0(id TEXT PRIMARY KEY,admission INTEGER partition key,embedding FLOAT[${dimensions}] distance_metric=cosine,chunk_size=64)`,
		);
		nativeDimensions = dimensions;
	}
	const available = nativeDimensions === dimensions && state.active_generation > 0 && state.phase !== "pending";
	const version = () =>
		JSON.stringify([
			db.prepare("PRAGMA schema_version").get()?.schema_version,
			db.prepare("PRAGMA temp.schema_version").get()?.schema_version,
			state.phase,
			state.active_slot,
			state.active_generation,
			state.building_generation,
		]);
	let cache = vectorAdmissionWriters.get(db);
	if (!cache) {
		cache = new Map();
		vectorAdmissionWriters.set(db, cache);
	}
	if (cache.get(base) === version()) return available;
	db.exec(
		"CREATE TEMP TABLE IF NOT EXISTS _vector_admission_transfer(id TEXT PRIMARY KEY,vector BLOB);CREATE TEMP TABLE IF NOT EXISTS _vector_admission_override(id TEXT PRIMARY KEY,vector BLOB)",
	);
	for (const event of ["ai", "au", "ad", "parent_au", "parent_ad", "job_ai"] as const)
		db.exec(`DROP TRIGGER IF EXISTS temp.${base}_admission_${event}`);
	const journal = (wanted: string) => {
		const rows = vectorAdmissionRowsSql(store, wanted, base);
		return `INSERT OR IGNORE INTO vector_shard_repair_partitions SELECT b.projection,b.building_generation,m.partition_id FROM vector_shard_repairs b JOIN org_jobs j ON j.id=b.job_id JOIN ${store} candidate ON candidate.id=${wanted} AND candidate.agent_id=json_extract(j.params_json,'$.target.agentId') JOIN vector_shard_members m ON m.projection=b.projection AND m.embedding_id=candidate.id JOIN vector_shard_keys k ON k.id=m.partition_id AND k.retired_generation IS NULL AND k.generation<=b.active_generation WHERE b.projection='${base}' AND b.building_generation IS NOT NULL AND EXISTS(SELECT 1 FROM (${rows}) r,json_each(r.in_flight_jobs) labels WHERE labels.value=b.job_id);
		UPDATE vector_shard_repairs SET phase='copying',cursor='' WHERE projection='${base}' AND job_id IS NOT NULL AND changes()>0;
		INSERT OR IGNORE INTO vector_shard_dirty(projection,generation,embedding_id) SELECT b.projection,b.building_generation,${wanted} FROM vector_shard_repairs b WHERE b.projection='${base}' AND b.building_generation IS NOT NULL AND (b.job_id IS NULL OR EXISTS(SELECT 1 FROM vector_shard_members m JOIN vector_shard_repair_partitions p ON p.partition_id=m.partition_id AND p.projection=b.projection AND p.generation=b.building_generation WHERE m.projection=b.projection AND m.embedding_id=${wanted}));`;
	};
	const move = available
		? vectorAdmissionMoveSql(
				base,
				store,
				table,
				"new.id",
				state.active_generation,
				false,
				table,
				Number(dimensions) * 4,
			)
		: "";
	const remove = available
		? `DELETE FROM ${table} WHERE id IN(SELECT json_array(embedding_id,generation) FROM vector_shard_members WHERE projection='${base}' AND embedding_id=old.id); DELETE FROM vector_shard_members WHERE projection='${base}' AND embedding_id=old.id;`
		: "";
	db.exec(`CREATE TEMP TRIGGER ${base}_admission_ai AFTER INSERT ON ${store} BEGIN ${move} ${journal("new.id")} END`);
	db.exec(
		`CREATE TEMP TRIGGER ${base}_admission_au AFTER UPDATE OF id,vector,agent_id,compartment_id,source_id,source_type,dimensions ON ${store} BEGIN ${journal("old.id")} ${move} ${journal("new.id")} END`,
	);
	db.exec(`CREATE TEMP TRIGGER ${base}_admission_ad AFTER DELETE ON ${store} BEGIN ${journal("old.id")} ${remove} END`);
	for (const event of ["UPDATE OF id,agent_id,visibility,project,compartment_id,source_id", "DELETE"] as const) {
		const suffix = event === "DELETE" ? "parent_ad" : "parent_au";
		db.exec(
			`CREATE TEMP TRIGGER ${base}_admission_${suffix} AFTER ${event} ON memories BEGIN UPDATE ${store} SET id=id WHERE source_type='memory' AND source_id=old.id; END`,
		);
	}
	db.exec(
		`CREATE TEMP TRIGGER ${base}_admission_job_ai AFTER INSERT ON org_jobs WHEN new.kind='classify' AND new.status IN ('pending','running') AND json_extract(new.params_json,'$.target.kind')='memory' BEGIN UPDATE ${store} SET id=id WHERE source_type='memory' AND source_id=json_extract(new.params_json,'$.target.id') AND agent_id=json_extract(new.params_json,'$.target.agentId'); END`,
	);
	cache.set(base, version());
	return available;
}
function syncVectorAdmission(
	db: MigrationDb,
	base: VectorProjectionBase,
	store: "embeddings" | "embeddings_staging",
	id: string,
	vector?: Float32Array,
): void {
	if (!prepareVectorAdmissionWriter(db, base, store)) return;
	if (vector !== undefined) db.prepare("INSERT OR REPLACE INTO _vector_admission_override VALUES(?,?)").run(id, vector);
	try {
		db.prepare(`UPDATE ${store} SET id=id WHERE id=?`).run(id);
	} finally {
		db.prepare("DELETE FROM _vector_admission_override WHERE id=?").run(id);
	}
}
export function bindVectorAdmissionWriters(
	db: MigrationDb,
	selection?: { readonly projection: VectorProjectionBase; readonly embeddings: "embeddings" | "embeddings_staging" },
	initialize = true,
): void {
	if (!shardSchema(db).tables.has("vector_shard_repairs")) return;
	for (const row of db.prepare("SELECT projection,store FROM vector_shard_repairs ORDER BY projection LIMIT 3").all()) {
		if (
			(row.projection !== "vec_embeddings" && row.projection !== "vec_embeddings_staging") ||
			(row.store !== "embeddings" && row.store !== "embeddings_staging")
		)
			throw new Error("vector_projection_binding_invalid");
		const store =
			selection === undefined
				? row.store
				: row.projection === selection.projection
					? selection.embeddings
					: selection.embeddings === "embeddings"
						? "embeddings_staging"
						: "embeddings";
		prepareVectorAdmissionWriter(db, row.projection, store, initialize);
	}
}

export class VectorAdmissionLimitError extends Error {}
export function admittedVectorPartitions(
	db: Pick<MigrationDb, "prepare">,
	base: VectorProjectionBase,
	scope: ReadScope,
	store?: "embeddings" | "embeddings_staging",
): { table: string; ids: number[]; groups: number[][]; sizes: ReadonlyMap<number, number> } | undefined {
	if (!shardSchema(db).tables.has("vector_shard_repairs")) return undefined;
	const state = db
		.prepare(
			"SELECT phase,store,source_root,job_id,active_slot,active_generation FROM vector_shard_repairs WHERE projection=?",
		)
		.get(base);
	if (
		!state ||
		typeof state.active_generation !== "number" ||
		state.active_generation < 1 ||
		state.phase === "pending" ||
		(state.phase !== "ready" && state.job_id === null)
	)
		throw new VectorAdmissionLimitError("vector_shard_repair_pending");
	if (
		store !== undefined &&
		(state.store !== store ||
			state.source_root !==
				db.prepare("SELECT rootpage FROM sqlite_master WHERE name=? AND type='table'").get(store)?.rootpage)
	)
		throw new VectorAdmissionLimitError("vector_shard_repair_pending");
	const table = `${base}__admission_${state.active_slot === 1 ? 1 : 0}`;
	if (!shardSchema(db).tables.has(table)) throw new VectorAdmissionLimitError("vector_shard_repair_pending");
	const parent = readScopeSql("k", scope, { inFlightJobs: "in_flight_jobs" });
	const child = readScopeSql(
		"k",
		{ ...scope, projects: null, reach: scope.reach.kind === "own" ? scope.reach : { kind: "all" } },
		{ visibility: null, compartment: "embedding_compartment_id", inFlightJobs: "in_flight_jobs" },
	);
	const rows = db
		.prepare(
			`SELECT k.id,k.row_count,json_array(k.agent_id,k.visibility,k.project,k.compartment_id,k.embedding_compartment_id,json(${classificationLabelsForJobsSql("k", "in_flight_jobs")})) admission_key FROM vector_shard_keys k WHERE k.projection=? AND k.generation<=? AND k.retired_generation IS NULL AND k.row_count>0${parent.sql}${child.sql} ORDER BY k.id LIMIT 4097`,
		)
		.all(base, state.active_generation, ...parent.args, ...child.args);
	if (rows.length > 4096) throw new VectorAdmissionLimitError("vector_shard_fanout_limit");
	const groups = new Map<string, number[]>();
	const sizes = new Map<number, number>();
	for (const row of rows) {
		if (
			typeof row.id !== "number" ||
			!Number.isSafeInteger(row.id) ||
			typeof row.row_count !== "number" ||
			!Number.isSafeInteger(row.row_count) ||
			row.row_count < 1 ||
			typeof row.admission_key !== "string"
		)
			throw new Error("invalid_vector_admission_key");
		sizes.set(row.id, row.row_count);
		const group = groups.get(row.admission_key) ?? [];
		group.push(row.id);
		groups.set(row.admission_key, group);
	}
	return {
		table,
		ids: rows.flatMap((row) => (typeof row.id === "number" ? [row.id] : [])),
		groups: [...groups.values()],
		sizes,
	};
}

export function beginVectorAdmissionRepairInTx(
	db: MigrationDb,
	base: VectorProjectionBase,
	store: "embeddings" | "embeddings_staging",
	jobId: string | null = null,
): void {
	const state = db
		.prepare("SELECT phase,active_slot,active_generation,job_id FROM vector_shard_repairs WHERE projection=?")
		.get(base);
	if (!state || typeof state.active_generation !== "number") throw new Error("vector_repair_marker_missing");
	if (state.phase !== "ready" && state.phase !== "pending") {
		if (state.job_id === jobId) return;
		throw new Error("vector_repair_busy");
	}
	const definition = shardSchema(db).tables.get(base);
	const dims = definition ? /embedding\s+FLOAT\[(\d+)\]/i.exec(definition)?.[1] : undefined;
	if (!dims) throw new Error("vector_projection_unavailable");
	if (jobId !== null && (state.phase !== "ready" || state.active_generation < 1)) throw new Error("vector_repair_busy");
	if (jobId !== null) prepareVectorAdmissionWriter(db, base, store);
	const slot = state.active_slot === 1 ? 1 : 0;
	const table = `${base}__admission_${jobId === null ? 1 - slot : slot}`;
	if (jobId === null) {
		db.exec(`DROP TABLE IF EXISTS ${table}`);
		db.exec(
			`CREATE VIRTUAL TABLE ${table} USING vec0(id TEXT PRIMARY KEY,admission INTEGER partition key,embedding FLOAT[${dims}] distance_metric=cosine,chunk_size=64)`,
		);
	}
	db.prepare(
		"UPDATE vector_shard_repairs SET phase='copying',store=?,active_generation=MAX(active_generation,1),building_generation=MAX(active_generation,last_generation)+1,last_generation=MAX(active_generation,last_generation)+1,cursor='',job_id=? WHERE projection=?",
	).run(store, jobId, base);
	if (jobId !== null) {
		const rows = vectorAdmissionRowsSql(store, "candidate.id", base);
		const parts = db
			.prepare(
				`SELECT DISTINCT m.partition_id FROM org_jobs j CROSS JOIN ${store} candidate CROSS JOIN vector_shard_members m CROSS JOIN vector_shard_keys k WHERE j.id=? AND candidate.agent_id=json_extract(j.params_json,'$.target.agentId') AND m.projection=? AND m.embedding_id=candidate.id AND k.id=m.partition_id AND k.retired_generation IS NULL AND k.generation<=? AND EXISTS(SELECT 1 FROM (${rows}) r,json_each(r.in_flight_jobs) labels WHERE labels.value=j.id) LIMIT 4097`,
			)
			.all(jobId, base, state.active_generation);
		if (parts.length > 4096) throw new VectorAdmissionLimitError("vector_shard_fanout_limit");
		for (const part of parts)
			db.prepare(
				"INSERT OR IGNORE INTO vector_shard_repair_partitions SELECT projection,building_generation,? FROM vector_shard_repairs WHERE projection=?",
			).run(part.partition_id, base);
	}
	prepareVectorAdmissionWriter(db, base, store);
}
export function stepVectorAdmissionRepairInTx(
	db: MigrationDb,
	base: VectorProjectionBase,
	limit = 100,
): { phase: string; updated: number } {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("vector_repair_batch_limit");
	const state = db.prepare("SELECT * FROM vector_shard_repairs WHERE projection=?").get(base);
	if (
		!state ||
		(state.store !== "embeddings" && state.store !== "embeddings_staging") ||
		typeof state.building_generation !== "number" ||
		typeof state.cursor !== "string"
	)
		throw new Error("vector_repair_not_started");
	const store = state.store;
	const generation = state.building_generation;
	prepareVectorAdmissionWriter(db, base, store);
	const slot = state.active_slot === 1 ? 1 : 0;
	const table = `${base}__admission_${state.job_id === null ? 1 - slot : slot}`;
	const previous = `${base}__admission_${slot}`;
	const fallback = shardSchema(db).tables.has(previous) ? previous : base;
	db.exec("CREATE TEMP TABLE IF NOT EXISTS _vector_admission_wanted(id TEXT PRIMARY KEY)");
	const move = (id: string) => {
		if (
			state.job_id !== null &&
			!db
				.prepare(
					"SELECT 1 FROM vector_shard_members m JOIN vector_shard_repair_partitions p ON p.partition_id=m.partition_id JOIN vector_shard_keys k ON k.id=m.partition_id WHERE p.projection=? AND p.generation=? AND m.embedding_id=? AND k.retired_generation IS NULL LIMIT 1",
				)
				.get(base, generation, id)
		) {
			db.prepare(`DELETE FROM ${table} WHERE id=json_array(?,?)`).run(id, generation);
			db.prepare("DELETE FROM vector_shard_members WHERE projection=? AND generation=? AND embedding_id=?").run(
				base,
				generation,
				id,
			);
			db.prepare("DELETE FROM vector_shard_unresolved WHERE projection=? AND generation=? AND embedding_id=?").run(
				base,
				generation,
				id,
			);
			return;
		}
		db.exec("DELETE FROM _vector_admission_wanted");
		db.prepare("INSERT INTO _vector_admission_wanted VALUES(?)").run(id);
		db.exec(
			vectorAdmissionMoveSql(
				base,
				store,
				table,
				"(SELECT id FROM _vector_admission_wanted)",
				generation,
				true,
				fallback,
			),
		);
		const member = db
			.prepare("SELECT 1 found FROM vector_shard_members WHERE projection=? AND generation=? AND embedding_id=?")
			.get(base, state.building_generation, id);
		if (!member) {
			const valid = db.prepare(`SELECT 1 found FROM (${vectorAdmissionRowsSql(store, "?", base)})`).get(id);
			if (valid) throw new Error("vector_repair_payload_missing");
			db.prepare("INSERT OR IGNORE INTO vector_shard_unresolved VALUES(?,?,?)").run(
				base,
				state.building_generation,
				id,
			);
		} else
			db.prepare("DELETE FROM vector_shard_unresolved WHERE projection=? AND generation=? AND embedding_id=?").run(
				base,
				state.building_generation,
				id,
			);
	};
	const readPage = () =>
		state.job_id === null
			? db.prepare(`SELECT id FROM ${store} WHERE id>? ORDER BY id LIMIT ?`).all(state.cursor, limit)
			: db
					.prepare(
						`SELECT DISTINCT m.embedding_id id FROM vector_shard_repair_partitions p CROSS JOIN vector_shard_members m JOIN vector_shard_keys k ON k.id=m.partition_id JOIN ${store} e ON e.id=m.embedding_id WHERE p.projection=? AND p.generation=? AND m.partition_id=p.partition_id AND k.retired_generation IS NULL AND m.embedding_id>? ORDER BY m.embedding_id LIMIT ?`,
					)
					.all(base, generation, state.cursor, limit);
	if (state.phase === "copying") {
		const page = readPage();
		for (const row of page) if (typeof row.id === "string") move(row.id);
		const cursor = page.at(-1)?.id;
		const phase = page.length < limit ? "verify" : "copying";
		db.prepare("UPDATE vector_shard_repairs SET phase=?,cursor=? WHERE projection=?").run(
			phase,
			phase === "verify" ? "" : cursor,
			base,
		);
		return { phase, updated: page.length };
	}
	const dirty = db
		.prepare(
			"SELECT embedding_id FROM vector_shard_dirty WHERE projection=? AND generation=? ORDER BY embedding_id LIMIT ?",
		)
		.all(base, state.building_generation, limit);
	if (dirty.length) {
		for (const row of dirty)
			if (typeof row.embedding_id === "string") {
				move(row.embedding_id);
				db.prepare("DELETE FROM vector_shard_dirty WHERE projection=? AND generation=? AND embedding_id=?").run(
					base,
					state.building_generation,
					row.embedding_id,
				);
			}
		db.prepare("UPDATE vector_shard_repairs SET phase='verify',cursor='' WHERE projection=?").run(base);
		return { phase: "verify", updated: dirty.length };
	}
	if (state.phase === "prepared") return { phase: "prepared", updated: 0 };
	if (state.phase !== "verify") throw new Error("vector_repair_invalid_phase");
	const page = readPage();
	for (const row of page)
		if (typeof row.id === "string") {
			const fingerprint = vectorAdmissionFingerprint("r");
			const valid = db
				.prepare(`SELECT ${fingerprint} fingerprint FROM (${vectorAdmissionRowsSql(store, "?", base)}) r`)
				.get(row.id);
			if (!valid) continue;
			const projected = db
				.prepare(
					`SELECT k.fingerprint FROM vector_shard_members m JOIN vector_shard_keys k ON k.id=m.partition_id JOIN ${table}_rowids v ON v.id=json_array(m.embedding_id,m.generation) WHERE m.projection=? AND m.generation=? AND m.embedding_id=?`,
				)
				.get(base, state.building_generation, row.id);
			if (projected?.fingerprint !== valid.fingerprint) throw new Error("vector_repair_verification_failed");
		}
	const phase = page.length < limit ? "prepared" : "verify";
	db.prepare("UPDATE vector_shard_repairs SET phase=?,cursor=? WHERE projection=?").run(
		phase,
		page.at(-1)?.id ?? state.cursor,
		base,
	);
	return { phase, updated: page.length };
}
export function publishVectorAdmissionRepairInTx(
	db: MigrationDb,
	base: VectorProjectionBase,
	jobId: string | null = null,
): void {
	const state = db.prepare("SELECT * FROM vector_shard_repairs WHERE projection=?").get(base);
	if (
		state?.phase !== "prepared" ||
		state.job_id !== jobId ||
		typeof state.building_generation !== "number" ||
		(state.store !== "embeddings" && state.store !== "embeddings_staging")
	)
		throw new Error("vector_repair_not_prepared");
	if (
		db
			.prepare("SELECT 1 FROM vector_shard_dirty WHERE projection=? AND generation=? LIMIT 1")
			.get(base, state.building_generation)
	)
		throw new Error("vector_repair_changed_after_verification");
	db.prepare(
		"UPDATE vector_shard_keys SET retired_generation=? WHERE projection=? AND generation<? AND retired_generation IS NULL AND (? IS NULL OR id IN(SELECT partition_id FROM vector_shard_repair_partitions WHERE projection=? AND generation=?))",
	).run(state.building_generation, base, state.building_generation, jobId, base, state.building_generation);
	if (jobId !== null)
		db.prepare(
			"UPDATE org_jobs SET kind=CASE kind WHEN 'classify-preparing' THEN 'classify' WHEN 'unclassify-preparing' THEN 'unclassify' ELSE kind END WHERE id=?",
		).run(jobId);
	db.prepare(
		"UPDATE vector_shard_repairs SET phase='ready',active_slot=CASE WHEN job_id IS NULL THEN 1-active_slot ELSE active_slot END,active_generation=building_generation,building_generation=NULL,cursor='',job_id=NULL WHERE projection=?",
	).run(base);
	prepareVectorAdmissionWriter(db, base, state.store);
}

export function repairVectorAdmissionStepInTx(
	db: MigrationDb,
	base: VectorProjectionBase,
	store: "embeddings" | "embeddings_staging",
): { phase: string; updated: number } {
	if (!shardSchema(db).tables.has("vector_shard_repairs") || !shardSchema(db).tables.has(base))
		return { phase: "unavailable", updated: 0 };
	prepareVectorAdmissionWriter(db, base, store);
	const state = db.prepare("SELECT phase,job_id FROM vector_shard_repairs WHERE projection=?").get(base);
	if (!state) throw new Error("vector_repair_marker_missing");
	if (state.job_id !== null) return { phase: "busy", updated: 0 };
	if (state.phase === "ready") return { phase: "ready", updated: 0 };
	if (state.phase === "pending") {
		beginVectorAdmissionRepairInTx(db, base, store);
		return { phase: "copying", updated: 0 };
	}
	if (state.phase === "prepared") {
		publishVectorAdmissionRepairInTx(db, base);
		return { phase: "ready", updated: 0 };
	}
	return stepVectorAdmissionRepairInTx(db, base);
}
