import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { runMigrations } from "../../core/src/migrations/index";
import type { ReadDb, WriteDb } from "./db-accessor";

let db: Database;

mock.module("./db-accessor", () => ({
	getDbAccessor: () => ({
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
	}),
}));

const { expandTemporalNode } = await import("./temporal-expand");

describe("expandTemporalNode", () => {
	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
	});

	it("returns lineage, linked memories, and transcript context for a temporal node", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO session_summaries (
				id, project, depth, kind, content, token_count,
				earliest_at, latest_at, session_key, harness,
				agent_id, source_type, source_ref, meta_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"parent-1",
			"proj-a",
			1,
			"arc",
			"Arc summary",
			10,
			now,
			now,
			null,
			null,
			"agent-a",
			"condensation",
			null,
			"{}",
			now,
		);
		db.prepare(
			`INSERT INTO session_summaries (
				id, project, depth, kind, content, token_count,
				earliest_at, latest_at, session_key, harness,
				agent_id, source_type, source_ref, meta_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"node-1",
			"proj-a",
			0,
			"session",
			"Session summary keeps the release blockers and migration plan.",
			20,
			now,
			now,
			"sess-1",
			"opencode",
			"agent-a",
			"summary",
			"sess-1",
			"{}",
			now,
		);
		db.prepare(
			`INSERT INTO session_summaries (
				id, project, depth, kind, content, token_count,
				earliest_at, latest_at, session_key, harness,
				agent_id, source_type, source_ref, meta_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"child-1",
			"proj-a",
			0,
			"session",
			"Chunk leaf with detailed blockers.",
			8,
			now,
			now,
			null,
			"opencode",
			"agent-a",
			"chunk",
			"sess-1",
			'{"ordinal":1}',
			now,
		);
		db.prepare(
			`INSERT INTO session_summary_children (parent_id, child_id, ordinal)
			 VALUES ('parent-1', 'node-1', 0), ('node-1', 'child-1', 0)`,
		).run();
		db.prepare(
			`INSERT INTO memories (
				id, content, type, importance, source_id, source_type,
				who, tags, project, agent_id, created_at, updated_at, updated_by
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"mem-1",
			"The migration plan must land before deploy.",
			"decision",
			0.8,
			"sess-1",
			"session_end",
			"system",
			"release,deploy",
			"proj-a",
			"agent-a",
			now,
			now,
			"test",
		);
		db.prepare(`INSERT INTO session_summary_memories (summary_id, memory_id) VALUES ('node-1', 'mem-1')`).run();
		db.prepare(
			`INSERT INTO session_transcripts (
				session_key, content, harness, project, agent_id, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"sess-1",
			"User: check release blockers and migration plan\nAssistant: the deploy waits on migration 045 and compaction parity",
			"opencode",
			"proj-a",
			"agent-a",
			now,
			now,
		);

		const out = expandTemporalNode("node-1", "agent-a", { transcriptCharLimit: 600 });
		expect(out).not.toBeNull();
		expect(out?.node.id).toBe("node-1");
		expect(out?.parents.map((row) => row.id)).toEqual(["parent-1"]);
		expect(out?.children.map((row) => row.id)).toEqual(["child-1"]);
		expect(out?.linkedMemories[0]).toMatchObject({
			id: "mem-1",
			type: "decision",
			deleted: false,
		});
		expect(out?.transcript).toMatchObject({
			sessionKey: "sess-1",
			harness: "opencode",
			project: "proj-a",
		});
		expect(out?.transcript?.excerpt).toContain("migration plan");
	});

	it("filters nested expansion material to the requested project", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO session_summaries (
				id, project, depth, kind, content, token_count,
				earliest_at, latest_at, session_key, harness,
				agent_id, source_type, source_ref, meta_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"parent-offscope",
			"proj-b",
			1,
			"arc",
			"Off-scope parent",
			10,
			now,
			now,
			null,
			null,
			"agent-a",
			"condensation",
			null,
			"{}",
			now,
		);
		db.prepare(
			`INSERT INTO session_summaries (
				id, project, depth, kind, content, token_count,
				earliest_at, latest_at, session_key, harness,
				agent_id, source_type, source_ref, meta_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"node-scope",
			"proj-a",
			0,
			"session",
			"In-scope node",
			20,
			now,
			now,
			"sess-scope",
			"opencode",
			"agent-a",
			"summary",
			"sess-scope",
			"{}",
			now,
		);
		db.prepare(
			`INSERT INTO session_summaries (
				id, project, depth, kind, content, token_count,
				earliest_at, latest_at, session_key, harness,
				agent_id, source_type, source_ref, meta_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"child-offscope",
			"proj-b",
			0,
			"session",
			"Off-scope child",
			8,
			now,
			now,
			null,
			"opencode",
			"agent-a",
			"chunk",
			"sess-scope",
			"{}",
			now,
		);
		db.prepare(
			`INSERT INTO session_summary_children (parent_id, child_id, ordinal)
			 VALUES ('parent-offscope', 'node-scope', 0), ('node-scope', 'child-offscope', 0)`,
		).run();
		db.prepare(
			`INSERT INTO memories (
				id, content, type, importance, source_id, source_type,
				who, tags, project, agent_id, created_at, updated_at, updated_by
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"mem-offscope",
			"Off-scope linked memory",
			"decision",
			0.8,
			"sess-scope",
			"session_end",
			"system",
			"offscope",
			"proj-b",
			"agent-a",
			now,
			now,
			"test",
		);
		db.prepare(
			`INSERT INTO session_summary_memories (summary_id, memory_id) VALUES ('node-scope', 'mem-offscope')`,
		).run();
		db.prepare(
			`INSERT INTO session_transcripts (
				session_key, content, harness, project, agent_id, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("sess-scope", "Off-scope transcript", "opencode", "proj-b", "agent-a", now, now);

		const out = expandTemporalNode("node-scope", "agent-a", {
			project: "proj-a",
			transcriptCharLimit: 600,
		});
		expect(out).not.toBeNull();
		expect(out?.node.id).toBe("node-scope");
		expect(out?.parents).toEqual([]);
		expect(out?.children).toEqual([]);
		expect(out?.linkedMemories).toEqual([]);
		expect(out?.transcript).toBeUndefined();
	});
});
