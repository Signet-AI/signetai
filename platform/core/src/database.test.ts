import { Database as SqliteDatabase } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./database";

describe("Database memory CRUD", () => {
	let dir: string | null = null;
	let db: Database | null = null;

	afterEach(() => {
		db?.close();
		db = null;
		if (dir) rmSync(dir, { force: true, recursive: true });
		dir = null;
	});

	it("addMemory inherits classified offline scope and explicit author", async () => {
		dir = mkdtempSync(join(tmpdir(), "signet-core-classified-"));
		const path = join(dir, "memories.db");
		db = new Database(path);
		await db.init();
		const raw = new SqliteDatabase(path);
		raw.exec(
			"INSERT INTO classifications(id,name) VALUES('cls_hr','HR'); INSERT INTO classification_assignments VALUES('agent','default','default','cls_hr','carol','now')",
		);
		const id = db.addMemory(
			{
				type: "fact",
				content: "offlinesecret",
				confidence: 1,
				tags: [],
				updatedBy: "local",
				vectorClock: {},
				manualOverride: false,
			},
			{ agentId: "default", authorUserId: "alice" },
		);
		expect(raw.prepare("SELECT agent_id,author_user_id,compartment_id FROM memories WHERE id=?").get(id)).toEqual({
			agent_id: "default",
			author_user_id: "alice",
			compartment_id: expect.any(Number),
		});
		expect(raw.prepare("SELECT count(*) n FROM memories_fts WHERE memories_fts MATCH 'offlinesecret'").get()).toEqual({
			n: 0,
		});
		raw.close();
	});

	it("addMemory persists row provenance fields accepted by the Memory input shape", async () => {
		dir = mkdtempSync(join(tmpdir(), "signet-core-db-"));
		db = new Database(join(dir, "memories.db"));
		await db.init();

		const id = db.addMemory(
			{
				type: "fact",
				content: "Database addMemory keeps row provenance.",
				confidence: 0.94,
				sourceId: "core-db-provenance-source",
				sourceType: "manual",
				sourcePath: "/tmp/signet-core/source.md",
				runtimePath: "memory/source.md",
				idempotencyKey: "core-db-provenance-key",
				tags: ["core", "provenance"],
				updatedBy: "database.test",
				vectorClock: {},
				manualOverride: false,
			},
			{ agentId: "default", authorUserId: null },
		);

		expect(db.getMemoryById(id)).toMatchObject({
			id,
			sourceId: "core-db-provenance-source",
			sourceType: "manual",
			sourcePath: "/tmp/signet-core/source.md",
			runtimePath: "memory/source.md",
			idempotencyKey: "core-db-provenance-key",
		});

		const derivedId = db.addMemory(
			{
				type: "fact",
				content: "Legacy extraction output stays derived.",
				confidence: 0.94,
				sourceType: "extract",
				tags: [],
				updatedBy: "database.test",
				vectorClock: {},
				manualOverride: false,
			},
			{ agentId: "default", authorUserId: null },
		);
		db.close();
		db = null;
		const raw = new SqliteDatabase(join(dir, "memories.db"), { readonly: true });
		try {
			expect(raw.prepare("SELECT memory_kind FROM memories WHERE id = ?").get(id)).toEqual({ memory_kind: "episodic" });
			expect(raw.prepare("SELECT memory_kind FROM memories WHERE id = ?").get(derivedId)).toEqual({
				memory_kind: null,
			});
		} finally {
			raw.close(true);
		}
	});
});
