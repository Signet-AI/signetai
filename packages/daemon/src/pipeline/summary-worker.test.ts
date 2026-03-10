import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@signet/core";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { SUMMARY_WORKER_UPDATED_BY, insertSummaryFacts } from "./summary-worker";

function makeAccessor(db: Database): DbAccessor {
	return {
		withWriteTx<T>(fn: (db: WriteDb) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db as unknown as WriteDb);
				db.exec("COMMIT");
				return result;
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

describe("insertSummaryFacts", () => {
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

	it("writes summary facts with updated_by metadata", () => {
		const saved = insertSummaryFacts(
			accessor,
			{
				harness: "codex",
				project: "/tmp/project",
				session_key: "session-1",
			},
			[
				{
					content: "The daemon summary worker now writes updated_by for inserted facts.",
					importance: 0.4,
					type: "fact",
					tags: "codex,summary",
				},
			],
		);

		expect(saved).toBe(1);

		const row = db.prepare("SELECT who, source_id, source_type, project, updated_by FROM memories").get() as
			| {
					who: string;
					source_id: string | null;
					source_type: string;
					project: string | null;
					updated_by: string;
			  }
			| undefined;

		expect(row).toBeDefined();
		expect(row?.who).toBe("codex");
		expect(row?.source_id).toBe("session-1");
		expect(row?.source_type).toBe("session_end");
		expect(row?.project).toBe("/tmp/project");
		expect(row?.updated_by).toBe(SUMMARY_WORKER_UPDATED_BY);
	});
});
