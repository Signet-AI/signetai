import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations/index";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { checkAndCondense } from "./summary-condensation";

function makeAccessor(db: Database): DbAccessor {
	return {
		withWriteTx<T>(fn: (db: WriteDb) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const out = fn(db as unknown as WriteDb);
				db.exec("COMMIT");
				return out;
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		},
		withReadDb<T>(fn: (db: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		close() {
			db.close();
		},
	};
}

describe("summary condensation", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = makeAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	it("condenses summary and compaction roots for the same agent without leaking other agents", async () => {
		const now = new Date().toISOString();
		const stmt = db.prepare(
			`INSERT INTO session_summaries (
				id, project, depth, kind, content, token_count,
				earliest_at, latest_at, session_key, harness,
				agent_id, source_type, source_ref, meta_json, created_at
			) VALUES (?, ?, 0, 'session', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);

		stmt.run(
			"sum-a",
			"proj-a",
			"Session summary for agent A",
			10,
			now,
			now,
			"sess-a",
			"codex",
			"agent-a",
			"summary",
			"sess-a",
			"{}",
			now,
		);
		stmt.run(
			"cmp-a",
			"proj-a",
			"Compaction artifact for agent A",
			10,
			now,
			now,
			"sess-a",
			"codex",
			"agent-a",
			"compaction",
			"sess-a",
			"{}",
			now,
		);
		stmt.run(
			"sum-b",
			"proj-a",
			"Session summary for agent B",
			10,
			now,
			now,
			"sess-b",
			"codex",
			"agent-b",
			"summary",
			"sess-b",
			"{}",
			now,
		);

		const provider = {
			generate: async () => "Arc summary",
		};

		await checkAndCondense(accessor, provider, "proj-a", "agent-a", {
			arcThreshold: 2,
			epochThreshold: 99,
		});

		const rows = db
			.prepare(
				`SELECT id, depth, kind, agent_id, source_type
				 FROM session_summaries
				 ORDER BY depth ASC, id ASC`,
			)
			.all() as Array<{
			id: string;
			depth: number;
			kind: string;
			agent_id: string;
			source_type: string | null;
		}>;

		const arc = rows.find((row) => row.depth === 1 && row.agent_id === "agent-a");
		expect(arc).toBeDefined();
		expect(arc?.kind).toBe("arc");
		expect(arc?.source_type).toBe("condensation");

		const links = db
			.prepare(
				`SELECT child_id
				 FROM session_summary_children
				 WHERE parent_id = ?
				 ORDER BY ordinal ASC`,
			)
			.all(arc?.id) as Array<{ child_id: string }>;
		expect(links.map((row) => row.child_id)).toEqual(["sum-a", "cmp-a"]);
		expect(links.map((row) => row.child_id)).not.toContain("sum-b");
	});

	it("allows the same session key to produce summary roots for different agents", () => {
		const now = new Date().toISOString();
		const stmt = db.prepare(
			`INSERT INTO session_summaries (
				id, project, depth, kind, content, token_count,
				earliest_at, latest_at, session_key, harness,
				agent_id, source_type, source_ref, meta_json, created_at
			) VALUES (?, ?, 0, 'session', ?, ?, ?, ?, ?, ?, ?, 'summary', ?, ?, ?)`,
		);

		stmt.run(
			"sum-a",
			"proj-a",
			"Agent A session summary",
			10,
			now,
			now,
			"sess-shared",
			"codex",
			"agent-a",
			"sess-shared",
			"{}",
			now,
		);
		stmt.run(
			"sum-b",
			"proj-a",
			"Agent B session summary",
			10,
			now,
			now,
			"sess-shared",
			"codex",
			"agent-b",
			"sess-shared",
			"{}",
			now,
		);

		const rows = db
			.prepare(
				`SELECT id, agent_id, session_key
				 FROM session_summaries
				 WHERE session_key = ?
				 ORDER BY agent_id ASC`,
			)
			.all("sess-shared") as Array<{
			id: string;
			agent_id: string;
			session_key: string | null;
		}>;

		expect(rows).toEqual([
			{ id: "sum-a", agent_id: "agent-a", session_key: "sess-shared" },
			{ id: "sum-b", agent_id: "agent-b", session_key: "sess-shared" },
		]);
	});
});
