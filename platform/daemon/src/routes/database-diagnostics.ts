import type { Hono } from "hono";
import { requirePermission } from "../auth";
import { type DbAccessor, type ReadDb, getDbAccessor } from "../db-accessor";
import { authConfig } from "./state";
import { parseBoundedInt } from "./utils";

export type DatabaseSchemaGroup = "core" | "provenance" | "runtime" | "internal" | "other";

export interface DatabaseColumnInfo {
	readonly cid: number;
	readonly name: string;
	readonly type: string;
	readonly notNull: boolean;
	readonly defaultValue: unknown;
	readonly primaryKey: boolean;
}

export interface DatabaseIndexColumnInfo {
	readonly seqno: number;
	readonly cid: number;
	readonly name: string;
}

export interface DatabaseIndexInfo {
	readonly name: string;
	readonly unique: boolean;
	readonly origin: string;
	readonly partial: boolean;
	readonly columns: readonly DatabaseIndexColumnInfo[];
}

export interface DatabaseForeignKeyInfo {
	readonly id: number;
	readonly seq: number;
	readonly table: string;
	readonly from: string;
	readonly to: string;
	readonly onUpdate: string;
	readonly onDelete: string;
	readonly match: string;
}

export interface DatabaseTableInfo {
	readonly name: string;
	readonly group: DatabaseSchemaGroup;
	readonly kind: string;
	readonly rowCount: number | null;
	readonly sampleAllowed: boolean;
	readonly sampleBlockedReason?: string;
	readonly columns: readonly DatabaseColumnInfo[];
	readonly indexes: readonly DatabaseIndexInfo[];
	readonly foreignKeys: readonly DatabaseForeignKeyInfo[];
	readonly sql: string | null;
}

export interface DatabaseSchemaResponse {
	readonly generatedAt: string;
	readonly tables: readonly DatabaseTableInfo[];
	readonly groups: Record<DatabaseSchemaGroup, number>;
}

export interface DatabaseTableSampleResponse {
	readonly table: string;
	readonly columns: readonly string[];
	readonly rows: readonly Record<string, unknown>[];
	readonly limit: number;
	readonly offset: number;
	readonly rowCount: number | null;
	readonly hasMore: boolean;
}

interface SqliteMasterRow {
	readonly name: string;
	readonly type: string;
	readonly sql: string | null;
}

interface RowCount {
	readonly count: number;
}

const KNOWN_GROUPS: Readonly<Record<string, DatabaseSchemaGroup>> = {
	entities: "core",
	memories: "core",
	memory_entity_mentions: "core",
	relations: "core",
	entity_aspects: "core",
	entity_attributes: "core",
	entity_dependencies: "core",
	entity_dependency_history: "core",
	entity_communities: "core",
	ontology_proposals: "core",
	documents: "provenance",
	document_memories: "provenance",
	memory_artifacts: "provenance",
	memory_artifact_chunks: "provenance",
	conversations: "provenance",
	session_transcripts: "provenance",
	session_summaries: "provenance",
	session_summary_memories: "provenance",
	embeddings: "runtime",
	vec_embeddings: "internal",
	memory_hints: "runtime",
	session_memories: "runtime",
	session_scores: "runtime",
	umap_cache: "runtime",
	predictor_training_runs: "runtime",
	path_feedback_events: "runtime",
	path_feedback_stats: "runtime",
	session_checkpoints: "runtime",
	memories_cold: "runtime",
	schema_migrations: "runtime",
	schema_migrations_audit: "runtime",
	memory_jobs: "runtime",
	summary_jobs: "runtime",
	telemetry_events: "runtime",
	connectors: "runtime",
	connector_documents: "runtime",
	skill_meta: "runtime",
	skill_invocations: "runtime",
	daily_reflections: "runtime",
	entities_fts: "internal",
	memories_fts: "internal",
	memory_hints_fts: "internal",
};

const UNSAMPLED_TABLES = new Set(["vec_embeddings", "entities_fts", "memories_fts", "memory_hints_fts"]);

function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

function groupForTable(name: string): DatabaseSchemaGroup {
	const known = KNOWN_GROUPS[name];
	if (known) return known;
	if (name.includes("_fts") || name.startsWith("fts_") || name.startsWith("vec_")) return "internal";
	if (name.includes("job") || name.includes("telemetry") || name.includes("cache")) return "runtime";
	if (name.includes("session") || name.includes("document") || name.includes("artifact")) return "provenance";
	return "other";
}

function isVirtualTable(sql: string | null): boolean {
	return typeof sql === "string" && /\bCREATE\s+VIRTUAL\s+TABLE\b/i.test(sql);
}

function sampleBlockedReason(row: SqliteMasterRow): string | undefined {
	if (UNSAMPLED_TABLES.has(row.name)) return "internal index table";
	if (isVirtualTable(row.sql)) return "virtual table";
	return undefined;
}

function safeCount(db: ReadDb, table: string): number | null {
	try {
		const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as RowCount | undefined;
		return typeof row?.count === "number" ? row.count : null;
	} catch {
		return null;
	}
}

function serializeCell(value: unknown): unknown {
	if (value instanceof Uint8Array) return `[blob ${value.byteLength} bytes]`;
	if (typeof value === "bigint") return value.toString();
	return value;
}

function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, serializeCell(value)]));
}

function listTables(db: ReadDb): readonly SqliteMasterRow[] {
	return db
		.prepare(
			`SELECT name, type, sql
			 FROM sqlite_master
			 WHERE type IN ('table', 'view')
			   AND name NOT LIKE 'sqlite_%'
			   AND name NOT LIKE '%_fts_data'
			   AND name NOT LIKE '%_fts_idx'
			   AND name NOT LIKE '%_fts_docsize'
			   AND name NOT LIKE '%_fts_config'
			 ORDER BY name ASC`,
		)
		.all() as SqliteMasterRow[];
}

function readColumns(db: ReadDb, table: string): readonly DatabaseColumnInfo[] {
	return (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<Record<string, unknown>>).map(
		(row) => ({
			cid: typeof row.cid === "number" ? row.cid : 0,
			name: typeof row.name === "string" ? row.name : "",
			type: typeof row.type === "string" ? row.type : "",
			notNull: typeof row.notnull === "number" && row.notnull > 0,
			defaultValue: row.dflt_value ?? null,
			primaryKey: typeof row.pk === "number" && row.pk > 0,
		}),
	);
}

function readIndexes(db: ReadDb, table: string): readonly DatabaseIndexInfo[] {
	const indexes = db.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all() as Array<Record<string, unknown>>;
	return indexes.map((row) => {
		const name = typeof row.name === "string" ? row.name : "";
		const columns = name
			? (db.prepare(`PRAGMA index_info(${quoteIdentifier(name)})`).all() as Array<Record<string, unknown>>).map(
					(col) => ({
						seqno: typeof col.seqno === "number" ? col.seqno : 0,
						cid: typeof col.cid === "number" ? col.cid : -1,
						name: typeof col.name === "string" ? col.name : "",
					}),
				)
			: [];
		return {
			name,
			unique: typeof row.unique === "number" && row.unique > 0,
			origin: typeof row.origin === "string" ? row.origin : "",
			partial: typeof row.partial === "number" && row.partial > 0,
			columns,
		};
	});
}

function readForeignKeys(db: ReadDb, table: string): readonly DatabaseForeignKeyInfo[] {
	return (db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as Array<Record<string, unknown>>).map(
		(row) => ({
			id: typeof row.id === "number" ? row.id : 0,
			seq: typeof row.seq === "number" ? row.seq : 0,
			table: typeof row.table === "string" ? row.table : "",
			from: typeof row.from === "string" ? row.from : "",
			to: typeof row.to === "string" ? row.to : "",
			onUpdate: typeof row.on_update === "string" ? row.on_update : "",
			onDelete: typeof row.on_delete === "string" ? row.on_delete : "",
			match: typeof row.match === "string" ? row.match : "",
		}),
	);
}

export function readDatabaseSchema(accessor: DbAccessor): DatabaseSchemaResponse {
	return accessor.withReadDb((db) => {
		const tables = listTables(db).map((row) => {
			const blocked = sampleBlockedReason(row);
			return {
				name: row.name,
				group: groupForTable(row.name),
				kind: row.type,
				rowCount: safeCount(db, row.name),
				sampleAllowed: blocked === undefined,
				...(blocked ? { sampleBlockedReason: blocked } : {}),
				columns: readColumns(db, row.name),
				indexes: readIndexes(db, row.name),
				foreignKeys: readForeignKeys(db, row.name),
				sql: row.sql,
			};
		});
		const groups = {
			core: 0,
			provenance: 0,
			runtime: 0,
			internal: 0,
			other: 0,
		} satisfies Record<DatabaseSchemaGroup, number>;
		for (const table of tables) groups[table.group] += 1;
		return { generatedAt: new Date().toISOString(), tables, groups };
	});
}

export function readTableSample(
	accessor: DbAccessor,
	table: string,
	limit: number,
	offset: number,
): DatabaseTableSampleResponse | { readonly error: string; readonly status: 400 | 404 } {
	return accessor.withReadDb((db) => {
		const match = listTables(db).find((row) => row.name === table);
		if (!match) return { error: "unknown table", status: 404 };
		const blocked = sampleBlockedReason(match);
		if (blocked) return { error: `sample unavailable: ${blocked}`, status: 400 };
		const columns = readColumns(db, table).map((col) => col.name);
		const rows = (
			db.prepare(`SELECT * FROM ${quoteIdentifier(table)} LIMIT ? OFFSET ?`).all(limit + 1, offset) as Array<
				Record<string, unknown>
			>
		).map(serializeRow);
		return {
			table,
			columns,
			rows: rows.slice(0, limit),
			limit,
			offset,
			rowCount: safeCount(db, table),
			hasMore: rows.length > limit,
		};
	});
}

export function registerDatabaseDiagnosticsRoutes(app: Hono, deps?: { readonly accessor?: DbAccessor }): void {
	const accessor = (): DbAccessor => deps?.accessor ?? getDbAccessor();

	app.use("/api/diagnostics/database", async (c, next) => requirePermission("diagnostics", authConfig)(c, next));
	app.use("/api/diagnostics/database/*", async (c, next) => requirePermission("diagnostics", authConfig)(c, next));

	app.get("/api/diagnostics/database/schema", (c) => c.json(readDatabaseSchema(accessor())));

	app.get("/api/diagnostics/database/tables/:table/sample", (c) => {
		const result = readTableSample(
			accessor(),
			c.req.param("table"),
			parseBoundedInt(c.req.query("limit"), 25, 1, 100),
			parseBoundedInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
		);
		if ("status" in result) return c.json({ error: result.error }, result.status);
		return c.json(result);
	});
}
