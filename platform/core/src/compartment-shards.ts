import type { MigrationDb } from "./migrations/contract";
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
