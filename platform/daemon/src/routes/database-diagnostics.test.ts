import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { readDatabaseSchema, readTableSample, registerDatabaseDiagnosticsRoutes } from "./database-diagnostics";

function makeAccessor(db: Database): DbAccessor {
	return {
		withReadDb<T>(fn: (readDb: ReadDb) => T): T {
			return fn(db);
		},
		withWriteTx<T>(fn: (writeDb: WriteDb) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db);
				db.exec("COMMIT");
				return result;
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		},
		close(): void {},
	};
}

describe("database diagnostics", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE entities (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				entity_type TEXT DEFAULT 'concept'
			);
			CREATE TABLE entity_attributes (
				id TEXT PRIMARY KEY,
				entity_id TEXT NOT NULL,
				content TEXT NOT NULL,
				importance REAL NOT NULL DEFAULT 0,
				FOREIGN KEY(entity_id) REFERENCES entities(id)
			);
			CREATE INDEX idx_entity_attributes_entity_id ON entity_attributes(entity_id);
			CREATE VIRTUAL TABLE memories_fts USING fts5(content);
			INSERT INTO entities (id, name) VALUES ('ent-1', 'Signet');
			INSERT INTO entity_attributes (id, entity_id, content, importance)
				VALUES ('attr-1', 'ent-1', 'Schema explorer', 0.9);
			INSERT INTO memories_fts (content) VALUES ('internal search text');
		`);
		accessor = makeAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns live schema metadata with row counts, columns, indexes, and foreign keys", () => {
		const schema = readDatabaseSchema(accessor);
		const entities = schema.tables.find((table) => table.name === "entities");
		const attrs = schema.tables.find((table) => table.name === "entity_attributes");

		expect(entities?.group).toBe("core");
		expect(entities?.rowCount).toBe(1);
		expect(entities?.columns.map((column) => column.name)).toContain("name");
		expect(attrs?.indexes.map((index) => index.name)).toContain("idx_entity_attributes_entity_id");
		expect(attrs?.foreignKeys[0]?.table).toBe("entities");
		expect(schema.groups.core).toBeGreaterThanOrEqual(2);
	});

	it("returns bounded table samples for validated table names", () => {
		const sample = readTableSample(accessor, "entity_attributes", 1, 0);

		expect("error" in sample).toBe(false);
		if ("error" in sample) return;
		expect(sample.columns).toContain("content");
		expect(sample.rows).toHaveLength(1);
		expect(sample.rows[0]?.content).toBe("Schema explorer");
		expect(sample.hasMore).toBe(false);
	});

	it("rejects unknown table names before building sample SQL", () => {
		const sample = readTableSample(accessor, 'entities"; DROP TABLE entities; --', 25, 0);

		expect(sample).toEqual({ error: "unknown table", status: 404 });
		const stillThere = db.prepare("SELECT COUNT(*) AS count FROM entities").get() as { count: number };
		expect(stillThere.count).toBe(1);
	});

	it("blocks samples for internal virtual tables", () => {
		const sample = readTableSample(accessor, "memories_fts", 25, 0);

		expect(sample).toEqual({ error: "sample unavailable: internal index table", status: 400 });
	});

	it("clamps sample pagination through the route", async () => {
		const app = new Hono();
		const state = await import("./state");
		const { createAuthMiddleware, createToken } = await import("../auth");
		app.use("*", createAuthMiddleware(state.authConfig, state.authSecret));
		registerDatabaseDiagnosticsRoutes(app, { accessor });
		const headers: Record<string, string> = {};
		if (state.authConfig.mode !== "local") {
			if (!state.authSecret) throw new Error("expected auth secret for non-local route test");
			headers.Authorization = `Bearer ${createToken(
				state.authSecret,
				{ sub: "database-diagnostics-test", role: "operator", scope: {} },
				60,
			)}`;
		}

		const res = await app.request("/api/diagnostics/database/tables/entities/sample?limit=500&offset=-20", { headers });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { limit: number; offset: number; rows: unknown[] };
		expect(body.limit).toBe(100);
		expect(body.offset).toBe(0);
		expect(body.rows).toHaveLength(1);
	});
});
