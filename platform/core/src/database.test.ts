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
	});
});
