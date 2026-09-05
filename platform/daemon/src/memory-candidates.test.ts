import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	MAX_TRAVERSAL_CANDIDATE_IDS,
	fetchTraversalCandidates,
	getAllScoredCandidates,
	getPredictedContextMemories,
} from "./memory-candidates";

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

function insertTranscript(sessionKey: string, project: string, agentId: string, content: string): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO session_transcripts
				(session_key, content, harness, project, agent_id, created_at, updated_at, completed_at)
			 VALUES (?, ?, 'test', ?, ?, ?, ?, ?)`,
		).run(sessionKey, content, project, agentId, now, now, now);
	});
}

function insertProjectMemory(id: string, agentId: string, project: string, content: string): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memories
				(id, content, type, importance, is_deleted, agent_id, visibility, project, created_at, updated_at, updated_by)
			 VALUES (?, ?, 'fact', 0.9, 0, ?, 'global', ?, ?, ?, 'test')`,
		).run(id, content, agentId, project, now, now);
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

	afterEach(async () => {
		await closeDbAccessor();
		rmSync(directory, { recursive: true, force: true });
	});

	test("hydrates scoped, non-deleted rows with the maximum active attribute score", async () => {
		insertMemory("memory-active", "agent-a", 0.2);
		insertMemory("memory-other-agent", "agent-a", 0.3);
		insertMemory("memory-deleted", "agent-a", 0.9, 1);
		insertMemory("memory-no-attribute", "agent-a", 0.4);
		insertMemory("memory-superseded", "agent-a", 0.95);
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memories SET superseded_by = 'memory-active' WHERE id = 'memory-superseded'").run();
		});
		insertAttribute("attribute-a-1", "memory-active", "agent-a", 0.4);
		insertAttribute("attribute-a-2", "memory-active", "agent-a", 0.9);
		insertAttribute("attribute-b", "memory-active", "agent-b", 1.0);
		insertAttribute("attribute-other-agent", "memory-other-agent", "agent-b", 1.0);

		const rows = await fetchTraversalCandidates(
			dbPath,
			["memory-active", "memory-other-agent", "memory-deleted", "memory-no-attribute", "memory-superseded"],
			"agent-a",
		);
		const byId = new Map(rows.map((row) => [row.id, row]));

		expect(rows).toHaveLength(3);
		expect(byId.get("memory-active")?.effScore).toBe(0.9);
		expect(byId.get("memory-other-agent")?.effScore).toBe(0.3);
		expect(byId.get("memory-no-attribute")?.effScore).toBe(0.4);
		expect(byId.has("memory-deleted")).toBe(false);
		expect(byId.has("memory-superseded")).toBe(false);
	});

	test("excludes superseded memories from the ordinary candidate pool", async () => {
		insertMemory("memory-current", "agent-a", 0.5);
		insertMemory("memory-old", "agent-a", 0.95);
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memories SET superseded_by = 'memory-current' WHERE id = 'memory-old'").run();
		});

		const rows = await getAllScoredCandidates(dbPath, undefined, 10, "agent-a");
		expect(rows.map((row) => row.id)).toEqual(["memory-current"]);
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

	test("routes traversal hydration through the DB owner, not the parent DB seams", async () => {
		insertMemory("memory-traversal-owner", "agent-a", 0.9);
		const accessor = getDbAccessor() as unknown as {
			withReadDb: (...args: never[]) => unknown;
			withReadDbAsync: (...args: never[]) => Promise<unknown>;
		};
		const originalWithReadDb = accessor.withReadDb;
		const originalWithReadDbAsync = accessor.withReadDbAsync;
		accessor.withReadDb = () => {
			throw new Error("traversal hydration crossed the parent sync DB seam");
		};
		accessor.withReadDbAsync = async () => {
			throw new Error("traversal hydration crossed the parent async DB seam");
		};
		try {
			const rows = await fetchTraversalCandidates(dbPath, ["memory-traversal-owner"], "agent-a");
			expect(rows.map((row) => row.id)).toEqual(["memory-traversal-owner"]);
		} finally {
			accessor.withReadDb = originalWithReadDb;
			accessor.withReadDbAsync = originalWithReadDbAsync;
		}
	});

	test("routes the candidate pool through the DB owner, not the parent DB seams", async () => {
		insertMemory("memory-owner", "agent-a", 0.9);
		const accessor = getDbAccessor() as unknown as {
			withReadDb: (...args: never[]) => unknown;
			withReadDbAsync: (...args: never[]) => Promise<unknown>;
		};
		const originalWithReadDb = accessor.withReadDb;
		const originalWithReadDbAsync = accessor.withReadDbAsync;
		accessor.withReadDb = () => {
			throw new Error("candidate pool crossed the parent sync DB seam");
		};
		accessor.withReadDbAsync = async () => {
			throw new Error("candidate pool crossed the parent async DB seam");
		};
		try {
			const rows = await getAllScoredCandidates(dbPath, undefined, 30, "agent-a");
			expect(rows.map((row) => row.id)).toEqual(["memory-owner"]);
		} finally {
			accessor.withReadDb = originalWithReadDb;
			accessor.withReadDbAsync = originalWithReadDbAsync;
		}
	});
	test("returns predicted context through the DB owner, not the parent sync DB seam", async () => {
		insertTranscript(
			"session-predicted-a",
			"/repo",
			"agent-a",
			"The phoenix deployment uses a stable editor workflow.",
		);
		insertTranscript(
			"session-predicted-b",
			"/repo",
			"agent-a",
			"The phoenix deployment requires careful editor workflow.",
		);
		insertProjectMemory("memory-predicted", "agent-a", "/repo", "The phoenix deployment needs the editor workflow.");

		const accessor = getDbAccessor() as unknown as {
			withReadDb: (...args: never[]) => unknown;
			withReadDbAsync: (...args: never[]) => Promise<unknown>;
		};
		const originalWithReadDb = accessor.withReadDb;
		const originalWithReadDbAsync = accessor.withReadDbAsync;
		accessor.withReadDb = () => {
			throw new Error("predicted context crossed the parent sync DB seam");
		};
		accessor.withReadDbAsync = async () => {
			throw new Error("predicted context crossed the parent async DB seam");
		};
		try {
			const rows = await getPredictedContextMemories(dbPath, "/repo", 10, 600, new Set(), "agent-a");
			expect(rows.map((row) => row.id)).toEqual(["memory-predicted"]);
		} finally {
			accessor.withReadDb = originalWithReadDb;
			accessor.withReadDbAsync = originalWithReadDbAsync;
		}
	});
});
