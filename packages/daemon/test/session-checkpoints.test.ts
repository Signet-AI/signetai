import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "@signet/core";
import {
	writeCheckpoint,
	getLatestCheckpoint,
	getLatestCheckpointBySession,
	getCheckpointsBySession,
	getCheckpointsByProject,
	pruneCheckpoints,
	redactSecrets,
	redactCheckpointRow,
	formatPeriodicDigest,
	queueCheckpointWrite,
	flushPendingCheckpoints,
	initCheckpointFlush,
	type WriteCheckpointParams,
	type CheckpointRow,
} from "../src/session-checkpoints";
import type { DbAccessor, WriteDb, ReadDb } from "../src/db-accessor";
import type { ContinuityState } from "../src/continuity-state";

// Minimal DbAccessor wrapping a real bun:sqlite Database
function createTestDbAccessor(dbPath: string): DbAccessor {
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA busy_timeout = 5000");
	runMigrations(db);

	return {
		withWriteTx<T>(fn: (wdb: WriteDb) => T): T {
			db.run("BEGIN IMMEDIATE");
			try {
				const result = fn(db);
				db.run("COMMIT");
				return result;
			} catch (err) {
				db.run("ROLLBACK");
				throw err;
			}
		},
		withReadDb<T>(fn: (rdb: ReadDb) => T): T {
			return fn(db);
		},
		close() {
			db.close();
		},
	};
}

describe("session-checkpoints", () => {
	let tmpDir: string;
	let dbAcc: DbAccessor;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "signet-checkpoints-test-"));
		dbAcc = createTestDbAccessor(join(tmpDir, "test.db"));
	});

	afterEach(() => {
		dbAcc.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeParams(overrides?: Partial<WriteCheckpointParams>): WriteCheckpointParams {
		return {
			sessionKey: "sess-1",
			harness: "claude-code",
			project: "/tmp/project",
			projectNormalized: "/tmp/project",
			trigger: "periodic",
			digest: "## Checkpoint\nSome work happened",
			promptCount: 5,
			memoryQueries: ["typescript", "database"],
			recentRemembers: ["User prefers dark mode"],
			...overrides,
		};
	}

	test("writeCheckpoint and getCheckpointsBySession", () => {
		writeCheckpoint(dbAcc, makeParams(), 50);
		const rows = getCheckpointsBySession(dbAcc, "sess-1");
		expect(rows.length).toBe(1);
		expect(rows[0].session_key).toBe("sess-1");
		expect(rows[0].harness).toBe("claude-code");
		expect(rows[0].prompt_count).toBe(5);
		expect(JSON.parse(rows[0].memory_queries!)).toEqual(["typescript", "database"]);
	});

	test("writeCheckpoint enforces maxPerSession", () => {
		for (let i = 0; i < 5; i++) {
			writeCheckpoint(dbAcc, makeParams({ promptCount: i }), 3);
		}
		const rows = getCheckpointsBySession(dbAcc, "sess-1");
		expect(rows.length).toBe(3);
		// newest first
		expect(rows[0].prompt_count).toBe(4);
	});

	test("getLatestCheckpoint filters by project and time", () => {
		writeCheckpoint(dbAcc, makeParams({ projectNormalized: "/tmp/project" }), 50);
		writeCheckpoint(dbAcc, makeParams({ projectNormalized: "/tmp/other" }), 50);

		const result = getLatestCheckpoint(dbAcc, "/tmp/project", 60_000);
		expect(result).toBeDefined();
		expect(result?.project_normalized).toBe("/tmp/project");

		// No match for different project
		const noMatch = getLatestCheckpoint(dbAcc, "/tmp/missing", 60_000);
		expect(noMatch).toBeUndefined();
	});

	test("getLatestCheckpoint returns undefined for expired checkpoints", () => {
		writeCheckpoint(dbAcc, makeParams(), 50);
		// Query with 0ms window — everything is "expired"
		const result = getLatestCheckpoint(dbAcc, "/tmp/project", 0);
		expect(result).toBeUndefined();
	});

	test("getLatestCheckpointBySession returns newest for session", () => {
		writeCheckpoint(dbAcc, makeParams({ digest: "first" }), 50);
		writeCheckpoint(dbAcc, makeParams({ digest: "second" }), 50);

		const result = getLatestCheckpointBySession(dbAcc, "sess-1");
		expect(result?.digest).toBe("second");
	});

	test("getCheckpointsByProject returns rows for project", () => {
		writeCheckpoint(dbAcc, makeParams({ sessionKey: "s1" }), 50);
		writeCheckpoint(dbAcc, makeParams({ sessionKey: "s2" }), 50);

		const rows = getCheckpointsByProject(dbAcc, "/tmp/project", 10);
		expect(rows.length).toBe(2);
	});

	test("pruneCheckpoints deletes all old rows strictly", () => {
		writeCheckpoint(dbAcc, makeParams(), 50);
		dbAcc.withWriteTx((wdb) => {
			wdb.prepare(
				"UPDATE session_checkpoints SET created_at = datetime('now', '-30 days')",
			).run();
		});

		const deleted = pruneCheckpoints(dbAcc, 7);
		expect(deleted).toBe(1);

		const remaining = getCheckpointsBySession(dbAcc, "sess-1");
		expect(remaining.length).toBe(0);
	});

	test("pruneCheckpoints does not delete recent rows", () => {
		writeCheckpoint(dbAcc, makeParams(), 50);
		const deleted = pruneCheckpoints(dbAcc, 7);
		expect(deleted).toBe(0);
	});
});

describe("redaction", () => {
	test("redactSecrets catches Bearer tokens", () => {
		const input = "Using Bearer eyJhbGciOiJIUzI1NiJ9.test for auth";
		const result = redactSecrets(input);
		expect(result).not.toContain("eyJhbGci");
		expect(result).toContain("[REDACTED]");
	});

	test("redactSecrets catches API key patterns", () => {
		const input = "Set api_key=sk-1234567890abcdef in config";
		const result = redactSecrets(input);
		expect(result).toContain("[REDACTED]");
	});

	test("redactSecrets catches env var assignments", () => {
		const input = "Export $OPENAI_API_KEY=sk-abc123xyz";
		const result = redactSecrets(input);
		expect(result).toContain("[REDACTED]");
	});

	test("redactSecrets preserves normal text", () => {
		const input = "User prefers dark mode and vim keybindings";
		expect(redactSecrets(input)).toBe(input);
	});

	test("redactCheckpointRow redacts digest and remembers", () => {
		const row: CheckpointRow = {
			id: "test-id",
			session_key: "s1",
			harness: "claude-code",
			project: "/tmp/p",
			project_normalized: "/tmp/p",
			trigger: "periodic",
			digest: "Used Bearer eyJtoken1234567890abcdef for API call",
			prompt_count: 5,
			memory_queries: null,
			recent_remembers: JSON.stringify(["api_key=sk-secret1234567890"]),
			created_at: new Date().toISOString(),
		};

		const redacted = redactCheckpointRow(row);
		expect(redacted.digest).not.toContain("eyJtoken");
		expect(redacted.digest).toContain("[REDACTED]");
		const remembers = JSON.parse(redacted.recent_remembers!);
		expect(remembers[0]).toContain("[REDACTED]");
	});
});

describe("formatPeriodicDigest", () => {
	test("formats a checkpoint digest with queries and remembers", () => {
		const state: ContinuityState = {
			sessionKey: "s1",
			harness: "test",
			project: "/tmp/project",
			projectNormalized: "/tmp/project",
			promptCount: 15,
			totalPromptCount: 15,
			lastCheckpointAt: Date.now(),
			pendingQueries: ["typescript", "auth"],
			pendingRemembers: ["User likes dark mode"],
			pendingPromptSnippets: [],
			startedAt: Date.now() - 600_000, // 10 min ago
		};

		const digest = formatPeriodicDigest(state);
		expect(digest).toContain("## Session Checkpoint");
		expect(digest).toContain("Project: /tmp/project");
		expect(digest).toContain("Prompts: 15");
		expect(digest).toContain("10m");
		expect(digest).toContain("typescript, auth");
		expect(digest).toContain("User likes dark mode");
	});

	test("omits activity section when empty", () => {
		const state: ContinuityState = {
			sessionKey: "s1",
			harness: "test",
			project: undefined,
			projectNormalized: undefined,
			promptCount: 3,
			totalPromptCount: 3,
			lastCheckpointAt: Date.now(),
			pendingQueries: [],
			pendingRemembers: [],
			pendingPromptSnippets: [],
			startedAt: Date.now() - 120_000,
		};

		const digest = formatPeriodicDigest(state);
		expect(digest).toContain("Project: unknown");
		expect(digest).not.toContain("Memory Activity");
	});
});

describe("debounce merge", () => {
	let tmpDir: string;
	let dbAcc: DbAccessor;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "signet-debounce-test-"));
		dbAcc = createTestDbAccessor(join(tmpDir, "test.db"));
		initCheckpointFlush(dbAcc);
	});

	afterEach(() => {
		flushPendingCheckpoints();
		dbAcc.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("queuing two writes for same session merges data", () => {
		const base: WriteCheckpointParams = {
			sessionKey: "merge-test",
			harness: "test",
			project: "/tmp/p",
			projectNormalized: "/tmp/p",
			trigger: "periodic",
			digest: "first digest",
			promptCount: 5,
			memoryQueries: ["query-a"],
			recentRemembers: ["rem-a"],
		};

		queueCheckpointWrite(base, 50);
		queueCheckpointWrite(
			{
				...base,
				digest: "second digest",
				promptCount: 3,
				memoryQueries: ["query-b"],
				recentRemembers: ["rem-b"],
			},
			50,
		);

		flushPendingCheckpoints();
		const rows = getCheckpointsBySession(dbAcc, "merge-test");
		expect(rows.length).toBe(1);
		// Prompt counts summed
		expect(rows[0].prompt_count).toBe(8);
		// Digest takes latest
		expect(rows[0].digest).toBe("second digest");
		// Queries merged
		const queries = JSON.parse(rows[0].memory_queries!);
		expect(queries).toEqual(["query-a", "query-b"]);
		// Remembers merged
		const remembers = JSON.parse(rows[0].recent_remembers!);
		expect(remembers).toEqual(["rem-a", "rem-b"]);
	});
});
