import Database from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { retireLegacyExtractionJobsAsync } from "./extraction-fallback";

function makeAccessor(db: Database): DbAccessor {
	return {
		withWriteTxAsync<T>(fn: (wdb: WriteDb) => T): Promise<T> {
			return Promise.resolve(fn(db as unknown as WriteDb));
		},
		withReadDbAsync<T>(fn: (rdb: ReadDb) => T | Promise<T>): Promise<T> {
			return Promise.resolve(fn(db as unknown as ReadDb));
		},
		close() {
			db.close();
		},
	};
}

describe("legacy extraction retirement", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec(`
			CREATE TABLE memories (
				id TEXT PRIMARY KEY,
				extraction_status TEXT,
				memory_kind TEXT,
				source_type TEXT,
				is_deleted INTEGER DEFAULT 0
			);
			CREATE TABLE memory_jobs (
				id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, job_type TEXT NOT NULL,
				status TEXT NOT NULL, error TEXT, failed_at TEXT, updated_at TEXT NOT NULL
			);
		`);
		accessor = makeAccessor(db);
	});

	it("terminalizes every unfinished retired extraction job without creating replacement work", async () => {
		const now = new Date().toISOString();
		db.prepare("INSERT INTO memories (id, extraction_status, memory_kind, source_type) VALUES (?, ?, ?, ?)").run(
			"pending-memory",
			"queued",
			"episodic",
			"manual",
		);
		db.prepare("INSERT INTO memories (id, extraction_status, memory_kind) VALUES (?, ?, ?)").run(
			"leased-memory",
			"queued",
			"episodic",
		);
		db.prepare("INSERT INTO memories (id, extraction_status) VALUES (?, ?)").run("failed-memory", "failed");
		db.prepare("INSERT INTO memories (id, extraction_status) VALUES (?, ?)").run("summary-projection", "queued");
		db.prepare("INSERT INTO memories (id, extraction_status, memory_kind, is_deleted) VALUES (?, ?, ?, 1)").run(
			"deleted-memory",
			"queued",
			"episodic",
		);
		for (const sourceType of ["aggregate-recall", "session_end", "checkpoint", "extract"]) {
			db.prepare("INSERT INTO memories (id, extraction_status, memory_kind, source_type) VALUES (?, ?, ?, ?)").run(
				`derived-${sourceType}`,
				"queued",
				null,
				sourceType,
			);
		}
		db.prepare("INSERT INTO memory_jobs (id, memory_id, job_type, status, updated_at) VALUES (?, ?, ?, ?, ?)").run(
			"pending-job",
			"pending-memory",
			"extract",
			"pending",
			now,
		);
		db.prepare("INSERT INTO memory_jobs (id, memory_id, job_type, status, updated_at) VALUES (?, ?, ?, ?, ?)").run(
			"leased-job",
			"leased-memory",
			"extract",
			"leased",
			now,
		);
		db.prepare("INSERT INTO memory_jobs (id, memory_id, job_type, status, updated_at) VALUES (?, ?, ?, ?, ?)").run(
			"summary-job",
			"summary-projection",
			"extract",
			"pending",
			now,
		);
		db.prepare("INSERT INTO memory_jobs (id, memory_id, job_type, status, updated_at) VALUES (?, ?, ?, ?, ?)").run(
			"failed-job",
			"failed-memory",
			"extract",
			"failed",
			now,
		);
		db.prepare("INSERT INTO memory_jobs (id, memory_id, job_type, status, updated_at) VALUES (?, ?, ?, ?, ?)").run(
			"deleted-job",
			"deleted-memory",
			"extract",
			"pending",
			now,
		);
		for (const sourceType of ["aggregate-recall", "session_end", "checkpoint", "extract"]) {
			db.prepare("INSERT INTO memory_jobs (id, memory_id, job_type, status, updated_at) VALUES (?, ?, ?, ?, ?)").run(
				`derived-${sourceType}-job`,
				`derived-${sourceType}`,
				"extract",
				"pending",
				now,
			);
		}

		expect(await retireLegacyExtractionJobsAsync(accessor, { reason: "Dreaming owns semantic writes" })).toBe(8);

		const jobs = db.prepare("SELECT id, status FROM memory_jobs ORDER BY id").all();
		expect(jobs).toEqual([
			{ id: "deleted-job", status: "dead" },
			{ id: "derived-aggregate-recall-job", status: "dead" },
			{ id: "derived-checkpoint-job", status: "dead" },
			{ id: "derived-extract-job", status: "dead" },
			{ id: "derived-session_end-job", status: "dead" },
			{ id: "failed-job", status: "failed" },
			{ id: "leased-job", status: "dead" },
			{ id: "pending-job", status: "dead" },
			{ id: "summary-job", status: "dead" },
		]);
		expect(db.prepare("SELECT extraction_status FROM memories WHERE id = ?").get("pending-memory")).toEqual({
			extraction_status: "retired",
		});
		expect(db.prepare("SELECT extraction_status FROM memories WHERE id = ?").get("leased-memory")).toEqual({
			extraction_status: "retired",
		});
		expect(db.prepare("SELECT memory_kind FROM memories WHERE id = ?").get("pending-memory")).toEqual({
			memory_kind: "episodic",
		});
		expect(db.prepare("SELECT memory_kind FROM memories WHERE id = ?").get("leased-memory")).toEqual({
			memory_kind: "episodic",
		});
		expect(db.prepare("SELECT memory_kind FROM memories WHERE id = ?").get("deleted-memory")).toEqual({
			memory_kind: "episodic",
		});
		expect(db.prepare("SELECT memory_kind FROM memories WHERE id = ?").get("summary-projection")).toEqual({
			memory_kind: null,
		});
		for (const sourceType of ["aggregate-recall", "session_end", "checkpoint", "extract"]) {
			expect(
				db.prepare("SELECT memory_kind, extraction_status FROM memories WHERE id = ?").get(`derived-${sourceType}`),
			).toEqual({
				memory_kind: null,
				extraction_status: "retired",
			});
		}
	});
});
