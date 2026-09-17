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

	it("returns null when a memory id does not exist", async () => {
		dir = mkdtempSync(join(tmpdir(), "signet-core-db-missing-"));
		db = new Database(join(dir, "memories.db"));
		await db.init();

		expect(db.getMemoryById("missing-memory-id")).toBeNull();
	});

	it("handles missing jobs without throwing under Bun SQLite", async () => {
		dir = mkdtempSync(join(tmpdir(), "signet-core-db-missing-job-"));
		db = new Database(join(dir, "memories.db"));
		await db.init();

		expect(db.leaseJob("missing-job-type")).toBeNull();
		expect(() => db.failJob("missing-job-id", "missing")).not.toThrow();
	});

	it("atomically skips a duplicate idempotency key across connections", async () => {
		dir = mkdtempSync(join(tmpdir(), "signet-core-db-idempotency-"));
		db = new Database(join(dir, "memories.db"));
		await db.init();
		const other = new Database(join(dir, "memories.db"));
		await other.init();

		try {
			const memory = {
				type: "fact" as const,
				content: "Atomic idempotency test.",
				confidence: 1,
				idempotencyKey: "atomic-idempotency-key",
				tags: [],
				updatedBy: "database.test",
				vectorClock: {},
				manualOverride: false,
			};
			const first = db.addMemoryIfAbsent(memory);
			const second = other.addMemoryIfAbsent(memory);

			expect(typeof first).toBe("string");
			expect(second).toBeNull();
		} finally {
			other.close();
		}
	});

	it("does not hide invalid idempotent memory writes", async () => {
		dir = mkdtempSync(join(tmpdir(), "signet-core-db-invalid-idempotency-"));
		db = new Database(join(dir, "memories.db"));
		await db.init();

		const memory = {
			type: "fact" as const,
			content: "Invalid idempotency test.",
			confidence: 1,
			idempotencyKey: "invalid-idempotency-key",
			tags: [],
			updatedBy: "database.test",
			vectorClock: {},
			manualOverride: false,
		};
		Object.defineProperty(memory, "type", { value: null });

		expect(() => db.addMemoryIfAbsent(memory)).toThrow();
	});
});
