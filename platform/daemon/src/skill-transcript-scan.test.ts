import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../core/src/migrations";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { MAX_TRANSCRIPT_SCAN_BYTES, recordSkillsFromTranscript } from "./skill-transcript-scan";

// Each JSONL line: { sessionId, timestamp, cwd, message: { content: [...] } }
// Two resolved Skill uses (toolu_AAA=web-search, toolu_BBB=tavily-cli),
// one unresolved use (toolu_CCC=web-search, no matching tool_result).
const FIXTURE_JSONL = [
	JSON.stringify({
		sessionId: "sess-scan-1",
		timestamp: "2024-01-01T00:00:00.000Z",
		cwd: "/test",
		message: { content: [{ type: "tool_use", name: "Skill", id: "toolu_AAA", input: { skill: "web-search" } }] },
	}),
	JSON.stringify({
		sessionId: "sess-scan-1",
		timestamp: "2024-01-01T00:00:01.000Z",
		cwd: "/test",
		message: { content: [{ type: "tool_result", tool_use_id: "toolu_AAA", is_error: false }] },
	}),
	JSON.stringify({
		sessionId: "sess-scan-1",
		timestamp: "2024-01-01T00:00:02.000Z",
		cwd: "/test",
		message: { content: [{ type: "tool_use", name: "Skill", id: "toolu_BBB", input: { skill: "tavily-cli" } }] },
	}),
	JSON.stringify({
		sessionId: "sess-scan-1",
		timestamp: "2024-01-01T00:00:03.000Z",
		cwd: "/test",
		message: { content: [{ type: "tool_result", tool_use_id: "toolu_BBB", is_error: false }] },
	}),
	// toolu_CCC has NO matching tool_result — must be skipped
	JSON.stringify({
		sessionId: "sess-scan-1",
		timestamp: "2024-01-01T00:00:04.000Z",
		cwd: "/test",
		message: { content: [{ type: "tool_use", name: "Skill", id: "toolu_CCC", input: { skill: "web-search" } }] },
	}),
].join("\n");

describe("recordSkillsFromTranscript", () => {
	let db: Database;
	let dbPath: string;
	let fixturePath: string;

	beforeEach(() => {
		dbPath = join(tmpdir(), `signet-transcript-scan-${crypto.randomUUID()}.db`);
		initDbAccessor(dbPath);
		db = new Database(dbPath);
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);

		fixturePath = join(tmpdir(), `transcript-fixture-${crypto.randomUUID()}.jsonl`);
		writeFileSync(fixturePath, FIXTURE_JSONL);
	});

	afterEach(() => {
		db.close();
		closeDbAccessor();
		rmSync(dbPath, { force: true });
		rmSync(fixturePath, { force: true });
	});

	it("inserts exactly 2 resolved invocations and skips the unresolved one", () => {
		recordSkillsFromTranscript({
			transcriptPath: fixturePath,
			harness: "claude-code",
			agentId: "default",
			origin: "scan",
		});

		type Row = { source: string; origin: string; tool_use_id: string };
		const rows = db
			.prepare("SELECT source, origin, tool_use_id FROM skill_invocations WHERE source = 'agent'")
			.all() as Row[];

		expect(rows).toHaveLength(2);

		for (const row of rows) {
			expect(row.source).toBe("agent");
			expect(row.origin).toBe("scan");
			expect(row.tool_use_id).not.toBeNull();
		}

		const ids = rows.map((r) => r.tool_use_id);
		expect(ids).toContain("toolu_AAA");
		expect(ids).toContain("toolu_BBB");
		expect(ids).not.toContain("toolu_CCC");
	});

	it("skips records from transcripts that do not match the expected session", () => {
		recordSkillsFromTranscript({
			transcriptPath: fixturePath,
			harness: "claude-code",
			agentId: "default",
			origin: "scan",
			expectedSessionId: "different-session",
		});

		const { n } = db.prepare("SELECT COUNT(*) AS n FROM skill_invocations").get() as { n: number };
		expect(n).toBe(0);
	});

	it("skips records missing session ids when a session is expected", () => {
		const missingSessionPath = join(tmpdir(), `transcript-missing-session-${crypto.randomUUID()}.jsonl`);
		try {
			writeFileSync(
				missingSessionPath,
				[
					JSON.stringify({
						timestamp: "2024-01-01T00:00:00.000Z",
						message: {
							content: [
								{ type: "tool_use", name: "Skill", id: "toolu_missing_session", input: { skill: "web-search" } },
							],
						},
					}),
					JSON.stringify({
						timestamp: "2024-01-01T00:00:01.000Z",
						message: { content: [{ type: "tool_result", tool_use_id: "toolu_missing_session", is_error: false }] },
					}),
				].join("\n"),
			);
			recordSkillsFromTranscript({
				transcriptPath: missingSessionPath,
				harness: "claude-code",
				agentId: "default",
				origin: "scan",
				expectedSessionId: "sess-scan-1",
			});

			const { n } = db.prepare("SELECT COUNT(*) AS n FROM skill_invocations").get() as { n: number };
			expect(n).toBe(0);
		} finally {
			rmSync(missingSessionPath, { force: true });
		}
	});

	it("skips non-file transcript paths", () => {
		const dirPath = join(tmpdir(), `transcript-dir-${crypto.randomUUID()}`);
		mkdirSync(dirPath);
		try {
			recordSkillsFromTranscript({
				transcriptPath: dirPath,
				harness: "claude-code",
				agentId: "default",
				origin: "scan",
			});
			const { n } = db.prepare("SELECT COUNT(*) AS n FROM skill_invocations").get() as { n: number };
			expect(n).toBe(0);
		} finally {
			rmSync(dirPath, { recursive: true, force: true });
		}
	});

	it("skips oversized transcript files", () => {
		const oversizedPath = join(tmpdir(), `transcript-oversized-${crypto.randomUUID()}.jsonl`);
		try {
			writeFileSync(oversizedPath, "");
			truncateSync(oversizedPath, MAX_TRANSCRIPT_SCAN_BYTES + 1);
			recordSkillsFromTranscript({
				transcriptPath: oversizedPath,
				harness: "claude-code",
				agentId: "default",
				origin: "scan",
			});
			const { n } = db.prepare("SELECT COUNT(*) AS n FROM skill_invocations").get() as { n: number };
			expect(n).toBe(0);
		} finally {
			rmSync(oversizedPath, { force: true });
		}
	});

	it("deduplicates on second scan: row count stays 2", () => {
		recordSkillsFromTranscript({
			transcriptPath: fixturePath,
			harness: "claude-code",
			agentId: "default",
			origin: "scan",
		});

		// Second call with identical args — INSERT OR IGNORE must hold
		recordSkillsFromTranscript({
			transcriptPath: fixturePath,
			harness: "claude-code",
			agentId: "default",
			origin: "scan",
		});

		const { n } = db.prepare("SELECT COUNT(*) AS n FROM skill_invocations WHERE source = 'agent'").get() as {
			n: number;
		};
		expect(n).toBe(2);
	});
});
