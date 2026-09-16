import { afterEach, describe, expect, it } from "bun:test";
import { Database as SqliteDatabase } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./database";
import { chunkContent, chunkMarkdownHierarchically, importMemoryLogs } from "./import";

describe("memory import chunking", () => {
	it("rejects invalid token limits instead of hanging", () => {
		for (const maxTokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => chunkContent("content", { maxTokens })).toThrow(RangeError);
			expect(() => chunkMarkdownHierarchically("# Header\n\ncontent", { maxTokens })).toThrow(RangeError);
		}
	});

	it("keeps sentences before oversized sentence chunks", () => {
		const long = "L".repeat(40);
		const chunks = chunkContent(`before. ${long}. after.`, { maxTokens: 5 });

		expect(chunks[0]?.text).toBe("before.");
		expect(chunks.at(-1)?.text).toBe(" after.");
		expect(chunks.map((chunk) => chunk.text).join("")).toBe(`before. ${long}. after.`);
	});

	it("preserves whitespace at oversized sentence boundaries", () => {
		const source = `${"a".repeat(2047)} ${"b".repeat(2048)}`;
		const chunks = chunkContent(source, { maxTokens: 512 });

		expect(chunks.map((chunk) => chunk.text).join("")).toBe(source);
		expect(chunks.every((chunk) => chunk.tokenCount <= 512)).toBe(true);
	});

	it("keeps headerless hierarchical chunks within the requested limit", () => {
		const chunks = chunkMarkdownHierarchically("x".repeat(100), { maxTokens: 10 });

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.tokenCount <= 10)).toBe(true);
		expect(chunks.every((chunk) => chunk.header === "")).toBe(true);
	});

	it("budgets hierarchical paragraph chunks after header context", () => {
		const header = `# ${"H".repeat(400)}`;
		const chunks = chunkMarkdownHierarchically(`${header}\n\n${"x".repeat(2400)}`, { maxTokens: 512 });

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.tokenCount <= 512)).toBe(true);
		expect(chunks.every((chunk) => chunk.text.startsWith(`${header}\n\n`))).toBe(true);
	});
});

describe("memory log import", () => {
	let root: string | null = null;
	let db: Database | null = null;

	afterEach(() => {
		db?.close();
		db = null;
		if (root !== null) rmSync(root, { recursive: true, force: true });
		root = null;
	});

	it("does not import the same content twice", async () => {
		root = mkdtempSync(join(tmpdir(), "signet-import-test-"));
		mkdirSync(join(root, "memory"));
		writeFileSync(join(root, "memory", "2026-01-01.md"), "Imported memory content.\n");
		db = new Database(join(root, "memory", "memories.db"));
		await db.init();

		const first = importMemoryLogs(root, db);
		const second = importMemoryLogs(root, db);

		expect(first).toEqual({ imported: 1, skipped: 0, errors: [] });
		expect(second).toEqual({ imported: 0, skipped: 1, errors: [] });
		expect(db.getMemories("daily-log")).toHaveLength(1);
	});

	it("does not let another agent's import suppress the default scope", async () => {
		root = mkdtempSync(join(tmpdir(), "signet-import-scope-"));
		mkdirSync(join(root, "memory"));
		const content = "Scoped memory content.";
		const file = "2026-01-01.md";
		const dbPath = join(root, "memory", "memories.db");
		writeFileSync(join(root, "memory", file), `${content}\n`);
		db = new Database(dbPath);
		await db.init();

		const first = importMemoryLogs(root, db);
		db.close();
		db = null;

		const key = `signet-import:${file}:0:${createHash("sha256").update(content).digest("hex")}`;
		const raw = new SqliteDatabase(dbPath);
		try {
			raw.prepare("UPDATE memories SET agent_id = ? WHERE idempotency_key = ?").run("agent-a", key);
		} finally {
			raw.close();
		}

		db = new Database(dbPath);
		await db.init();
		const second = importMemoryLogs(root, db);

		expect(first).toEqual({ imported: 1, skipped: 0, errors: [] });
		expect(second).toEqual({ imported: 1, skipped: 0, errors: [] });
	});

	it("skips filenames with impossible calendar dates", async () => {
		root = mkdtempSync(join(tmpdir(), "signet-import-invalid-date-"));
		mkdirSync(join(root, "memory"));
		writeFileSync(join(root, "memory", "2026-02-31.md"), "Invalid date content.\n");
		db = new Database(join(root, "memory", "memories.db"));
		await db.init();

		const result = importMemoryLogs(root, db);

		expect(result).toEqual({
			imported: 0,
			skipped: 1,
			errors: ["Invalid filename format (expected YYYY-MM-DD.md): 2026-02-31.md"],
		});
		expect(db.getMemories("daily-log")).toHaveLength(0);
	});
});
