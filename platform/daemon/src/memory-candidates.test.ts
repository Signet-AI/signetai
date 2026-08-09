import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { MAX_TRAVERSAL_CANDIDATE_IDS, fetchTraversalCandidates } from "./memory-candidates";

function temporaryDbPath(): { readonly directory: string; readonly path: string } {
	const directory = join(tmpdir(), `signet-memory-candidates-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(directory, { recursive: true });
	return { directory, path: join(directory, "memories.db") };
}

function insertMemory(id: string, agentId: string, importance: number, isDeleted = 0): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memories
				(id, content, type, importance, is_deleted, agent_id, visibility, created_at, updated_at, updated_by)
			 VALUES (?, ?, 'fact', ?, ?, ?, 'global', ?, ?, 'test')`,
		).run(id, `Memory ${id}`, importance, isDeleted, agentId, now, now);
	});
}

function insertAttribute(id: string, memoryId: string, agentId: string, importance: number): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entity_attributes
				(id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
				 confidence, importance, status, created_at, updated_at)
			 VALUES (?, NULL, ?, ?, 'attribute', ?, ?, 1, ?, 'active', ?, ?)`,
		).run(id, agentId, memoryId, `Attribute ${id}`, `attribute ${id}`, importance, now, now);
	});
}

describe("fetchTraversalCandidates (#1250)", () => {
	let directory: string;
	let dbPath: string;

	beforeEach(() => {
		const temporary = temporaryDbPath();
		directory = temporary.directory;
		dbPath = temporary.path;
		initDbAccessor(dbPath);
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(directory, { recursive: true, force: true });
	});

	test("hydrates scoped, non-deleted rows with the maximum active attribute score", async () => {
		insertMemory("memory-active", "agent-a", 0.2);
		insertMemory("memory-other-agent", "agent-a", 0.3);
		insertMemory("memory-deleted", "agent-a", 0.9, 1);
		insertMemory("memory-no-attribute", "agent-a", 0.4);
		insertAttribute("attribute-a-1", "memory-active", "agent-a", 0.4);
		insertAttribute("attribute-a-2", "memory-active", "agent-a", 0.9);
		insertAttribute("attribute-b", "memory-active", "agent-b", 1.0);
		insertAttribute("attribute-other-agent", "memory-other-agent", "agent-b", 1.0);

		const rows = await fetchTraversalCandidates(
			dbPath,
			["memory-active", "memory-other-agent", "memory-deleted", "memory-no-attribute"],
			"agent-a",
		);
		const byId = new Map(rows.map((row) => [row.id, row]));

		expect(rows).toHaveLength(3);
		expect(byId.get("memory-active")?.effScore).toBe(0.9);
		expect(byId.get("memory-other-agent")?.effScore).toBe(0.3);
		expect(byId.get("memory-no-attribute")?.effScore).toBe(0.4);
		expect(byId.has("memory-deleted")).toBe(false);
	});

	test("caps the hydration IN list and yields between batches", async () => {
		const ids = Array.from({ length: MAX_TRAVERSAL_CANDIDATE_IDS + 1 }, (_, index) => `memory-cap-${index}`);
		getDbAccessor().withWriteTx((db) => {
			const memory = db.prepare(
				`INSERT INTO memories
					(id, content, type, importance, is_deleted, agent_id, visibility, created_at, updated_at, updated_by)
				 VALUES (?, ?, 'fact', 0.5, 0, 'agent-a', 'global', ?, ?, 'test')`,
			);
			const attribute = db.prepare(
				`INSERT INTO entity_attributes
					(id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
					 confidence, importance, status, created_at, updated_at)
				 VALUES (?, NULL, 'agent-a', ?, 'attribute', ?, ?, 1, 0.5, 'active', ?, ?)`,
			);
			const now = new Date().toISOString();
			for (const id of ids) {
				memory.run(id, `Memory ${id}`, now, now);
				attribute.run(`attribute-${id}`, id, `Attribute ${id}`, `attribute ${id}`, now, now);
			}
		});

		let loopBreaths = 0;
		let running = true;
		const breathe = (): void => {
			if (!running) return;
			loopBreaths++;
			setImmediate(breathe);
		};
		setImmediate(breathe);

		const rows = await fetchTraversalCandidates(dbPath, ids, "agent-a");
		running = false;

		expect(rows).toHaveLength(MAX_TRAVERSAL_CANDIDATE_IDS);
		expect(rows.some((row) => row.id === ids[MAX_TRAVERSAL_CANDIDATE_IDS])).toBe(false);
		expect(loopBreaths).toBeGreaterThan(0);
	});
});
