import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getSyncDbAccessor } from "../legacy-sync/db-accessor-sync";
import { type ReadScope, compartmentFor } from "@signet/core";
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

const own = (agentId: string): ReadScope => ({ reach: { kind: "own", agentId }, compartments: "all", projects: null });

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
			db.prepare(
				"UPDATE memories SET pinned = 1, superseded_by = 'memory-active' WHERE id = 'memory-superseded'",
			).run();
		});
		insertAttribute("attribute-a-1", "memory-active", "agent-a", 0.4);
		insertAttribute("attribute-a-2", "memory-active", "agent-a", 0.9);
		insertAttribute("attribute-b", "memory-active", "agent-b", 1.0);
		insertAttribute("attribute-other-agent", "memory-other-agent", "agent-b", 1.0);

		const rows = await fetchTraversalCandidates(
			dbPath,
			["memory-active", "memory-other-agent", "memory-deleted", "memory-no-attribute", "memory-superseded"],
			own("agent-a"),
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

		const rows = await getAllScoredCandidates(dbPath, undefined, 10, own("agent-a"));
		expect(rows.map((row) => row.id)).toEqual(["memory-current"]);
	});

	test("scores the ordinary pool without reading derived ontology", async () => {
		insertMemory("memory-independent", "agent-a", 0.9);
		getSyncDbAccessor().withWriteTx((db) => db.exec("ALTER TABLE entity_attributes RENAME TO unrelated_attributes"));
		const rows = await getAllScoredCandidates(dbPath, undefined, 10, own("agent-a"));
		expect(rows.map((row) => row.id)).toEqual(["memory-independent"]);
		expect(rows[0]?.importance).toBe(0.9);
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

		const rows = await fetchTraversalCandidates(dbPath, ids, own("agent-a"));
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
			const rows = await fetchTraversalCandidates(dbPath, ["memory-traversal-owner"], own("agent-a"));
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
			const rows = await getAllScoredCandidates(dbPath, undefined, 30, own("agent-a"));
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
			const rows = await getPredictedContextMemories(dbPath, "/repo", 10, 600, new Set(), own("agent-a"));
			expect(rows.map((row) => row.id)).toEqual(["memory-predicted"]);
		} finally {
			accessor.withReadDb = originalWithReadDb;
			accessor.withReadDbAsync = originalWithReadDbAsync;
		}
	});
});

describe("hook candidate read scope", () => {
	let directory: string;
	let dbPath: string;
	let hr = 0;
	const outside = (agentId: string): ReadScope => ({
		reach: { kind: "own", agentId },
		compartments: [],
		projects: null,
	});
	const inside = (agentId: string): ReadScope => ({ ...outside(agentId), compartments: [hr] });

	function hide(table: "memories" | "session_transcripts" | "entity_attributes", key: string, id: string): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(`UPDATE ${table} SET compartment_id = ? WHERE ${key} = ?`).run(hr, id);
		});
	}

	beforeEach(() => {
		const temporary = temporaryDbPath();
		directory = temporary.directory;
		dbPath = temporary.path;
		initDbAccessor(dbPath);
		hr =
			getDbAccessor().withWriteTx((db) => {
				db.prepare(
					"INSERT INTO classifications (id, name, created_at, updated_at) VALUES ('cls_hr', 'HR', datetime('now'), datetime('now'))",
				).run();
				return compartmentFor(db, ["cls_hr"]);
			}) ?? 0;
	});

	afterEach(async () => {
		await closeDbAccessor();
		rmSync(directory, { recursive: true, force: true });
	});

	test("scopes the candidate pool before its window and limit", async () => {
		getDbAccessor().withWriteTx((db) => {
			for (const id of ["agent-a", "agent-b"])
				db.prepare(
					"INSERT OR IGNORE INTO agents (id, name, read_policy, created_at, updated_at) VALUES (?, ?, 'isolated', datetime('now'), datetime('now'))",
				).run(id, id);
		});
		insertMemory("visible", "agent-a", 0.9);
		for (let index = 0; index < 6; index++) {
			insertMemory(`hidden-${index}`, "agent-a", 0.95);
			hide("memories", "id", `hidden-${index}`);
		}
		insertMemory("foreign", "agent-b", 0.99);

		expect((await getAllScoredCandidates(dbPath, undefined, 1, outside("agent-a"))).map((row) => row.id)).toEqual([
			"visible",
		]);
		expect((await getAllScoredCandidates(dbPath, undefined, 10, inside("agent-a"))).map((row) => row.id)).toContain(
			"hidden-0",
		);
		const all = await getAllScoredCandidates(dbPath, undefined, 10, {
			reach: { kind: "all" },
			compartments: [],
			projects: null,
		});
		expect(all.map((row) => row.id).sort()).toEqual(["foreign", "visible"]);
		expect(
			await getAllScoredCandidates(dbPath, undefined, 10, { ...outside("agent-a"), projects: ["/elsewhere"] }),
		).toEqual([]);
	});

	test("hydrates only readable traversal memories and readable attribute scores", async () => {
		insertMemory("visible", "agent-a", 0.2);
		insertMemory("hidden", "agent-a", 0.3);
		hide("memories", "id", "hidden");
		insertAttribute("visible-attribute", "visible", "agent-a", 0.4);
		insertAttribute("hidden-attribute", "visible", "agent-a", 0.9);
		hide("entity_attributes", "id", "hidden-attribute");

		const rows = await fetchTraversalCandidates(dbPath, ["visible", "hidden"], outside("agent-a"));
		expect(rows.map((row) => [row.id, row.effScore])).toEqual([["visible", 0.4]]);
		const audience = await fetchTraversalCandidates(dbPath, ["visible", "hidden"], inside("agent-a"));
		expect(new Map(audience.map((row) => [row.id, row.effScore]))).toEqual(
			new Map([
				["visible", 0.9],
				["hidden", 0.3],
			]),
		);
	});

	test("predicts context from readable transcripts and every readable FTS shard", async () => {
		const project = "/repo";
		insertTranscript("visible-a", project, "agent-a", "The phoenix deployment uses the editor workflow.");
		insertTranscript("visible-b", project, "agent-a", "The phoenix deployment needs the editor workflow.");
		insertTranscript("hidden-a", project, "agent-a", "The zircon payroll ledger is HRSECRET.");
		insertTranscript("hidden-b", project, "agent-a", "The zircon payroll ledger stays HRSECRET.");
		hide("session_transcripts", "session_key", "hidden-a");
		hide("session_transcripts", "session_key", "hidden-b");
		insertProjectMemory("visible-memory", "agent-a", project, "The phoenix deployment uses the editor workflow.");

		const before = await getPredictedContextMemories(dbPath, project, 10, 600, new Set(), outside("agent-a"));
		insertProjectMemory("hidden-phoenix", "agent-a", project, "The phoenix deployment editor workflow HRSECRET.");
		hide("memories", "id", "hidden-phoenix");
		insertProjectMemory("hidden-zircon", "agent-a", project, "The zircon payroll ledger is HRSECRET.");
		hide("memories", "id", "hidden-zircon");

		const after = await getPredictedContextMemories(dbPath, project, 10, 600, new Set(), outside("agent-a"));
		const stable = (rows: typeof after) => rows.map(({ effScore: _, ...row }) => row);
		expect(stable(after)).toEqual(stable(before));
		expect(after.map((row) => row.id)).toEqual(["visible-memory"]);
		const audience = await getPredictedContextMemories(dbPath, project, 10, 600, new Set(), inside("agent-a"));
		expect(audience.map((row) => row.id).sort()).toEqual(["hidden-phoenix", "hidden-zircon", "visible-memory"]);
	});
});
