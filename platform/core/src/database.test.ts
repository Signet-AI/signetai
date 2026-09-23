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

	it("addMemory persists row provenance fields accepted by the Memory input shape", async () => {
		dir = mkdtempSync(join(tmpdir(), "signet-core-db-"));
		db = new Database(join(dir, "memories.db"));
		await db.init();

		const id = db.addMemory({
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
		});

		expect(db.getMemoryById(id)).toMatchObject({
			id,
			sourceId: "core-db-provenance-source",
			sourceType: "manual",
			sourcePath: "/tmp/signet-core/source.md",
			runtimePath: "memory/source.md",
			idempotencyKey: "core-db-provenance-key",
		});

		const derivedId = db.addMemory({
			type: "fact",
			content: "Legacy extraction output stays derived.",
			confidence: 0.94,
			sourceType: "extract",
			tags: [],
			updatedBy: "database.test",
			vectorClock: {},
			manualOverride: false,
		});
		db.close();
		db = null;
		const raw = new SqliteDatabase(join(dir, "memories.db"), { readonly: true });
		try {
			expect(raw.prepare("SELECT memory_kind FROM memories WHERE id = ?").get(id)).toEqual({ memory_kind: "episodic" });
			expect(raw.prepare("SELECT memory_kind FROM memories WHERE id = ?").get(derivedId)).toEqual({
				memory_kind: null,
			});
		} finally {
			raw.close();
		}
	});
});
