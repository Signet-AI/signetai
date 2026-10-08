import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectExportData, importBundle, serializeExportData } from "./export";
import { runMigrations } from "./migrations/index";

function open(): Database {
	const db = new Database(":memory:");
	runMigrations(db);
	return db;
}

function insert(
	db: Database,
	id: string,
	content: string,
	agent: string,
	scope: string | null,
	visibility: string,
): void {
	db.prepare(
		`INSERT INTO memories (id, content, agent_id, scope, visibility, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
	).run(id, content, agent, scope, visibility);
}

function exported(db: Database): ReadonlyMap<string, string> {
	const dir = mkdtempSync(join(tmpdir(), "signet-export-"));
	try {
		return serializeExportData(collectExportData(dir, db, { includeSkills: false }));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("portable bundle identity", () => {
	test("round-trips agent, scope, and visibility for memories and entities", () => {
		const source = open();
		insert(source, "m1", "alice private note", "alice", "project-x", "private");
		insert(source, "m2", "shared fact", "default", null, "global");
		source
			.prepare(
				"INSERT INTO entities (id, name, entity_type, agent_id, created_at, updated_at) VALUES ('e1', 'Thing', 'concept', 'alice', '2026-01-01', '2026-01-01')",
			)
			.run();
		const files = exported(source);

		const target = open();
		const result = importBundle(target, {
			memories: files.get("memories.jsonl"),
			entities: files.get("entities.jsonl"),
			relations: files.get("relations.jsonl"),
		});

		expect(result).toEqual({ memoriesImported: 2, memoriesSkipped: 0, entitiesImported: 1, relationsImported: 0 });
		expect(target.prepare("SELECT id, agent_id, scope, visibility FROM memories ORDER BY id").all()).toEqual([
			{ id: "m1", agent_id: "alice", scope: "project-x", visibility: "private" },
			{ id: "m2", agent_id: "default", scope: null, visibility: "global" },
		]);
		expect(target.prepare("SELECT agent_id FROM entities WHERE id = 'e1'").get()).toEqual({ agent_id: "alice" });
	});

	test("fails closed on a row without identity and writes nothing", () => {
		const db = open();
		const memories = [
			JSON.stringify({ id: "m1", content: "ok", agent_id: "alice", visibility: "global" }),
			JSON.stringify({ id: "m2", content: "legacy" }),
		].join("\n");

		expect(() => importBundle(db, { memories })).toThrow("memories.jsonl line 2 has no agent_id");
		expect(db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 0 });
	});

	test("fails closed on an entity without identity", () => {
		const db = open();
		expect(() => importBundle(db, { entities: JSON.stringify({ id: "e1", name: "Thing" }) })).toThrow(
			"entities.jsonl line 1 has no agent_id",
		);
	});

	test("never rewrites an existing memory", () => {
		const db = open();
		insert(db, "m1", "original", "alice", null, "private");

		const result = importBundle(db, {
			memories: JSON.stringify({ id: "m1", content: "replacement", agent_id: "mallory", visibility: "global" }),
		});

		expect(result.memoriesSkipped).toBe(1);
		expect(db.prepare("SELECT content, agent_id, visibility, version FROM memories WHERE id = 'm1'").get()).toEqual({
			content: "original",
			agent_id: "alice",
			visibility: "private",
			version: 1,
		});
	});

	test("rejects unsupported visibility values", () => {
		const db = open();
		expect(() =>
			importBundle(db, { memories: JSON.stringify({ id: "m1", content: "x", agent_id: "a", visibility: "public" }) }),
		).toThrow("unsupported visibility");
	});
});
