import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@signet/core";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { loadMemoryConfig } from "../memory-config";
import {
	SUMMARY_WORKER_UPDATED_BY,
	clearCommandStageRunning,
	getCommandStageStatus,
	hasCommandStageCompleted,
	insertSummaryFacts,
	markCommandStageCompleted,
	markCommandStageRunning,
	recoverSummaryJobs,
	resolveSummaryProvider,
	runSummaryCommandProvider,
	shouldRunSignificanceGateForJob,
	startSummaryWorker,
} from "./summary-worker";

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

const tmpDirs: string[] = [];
const originalWhich = Bun.which;

afterEach(() => {
	Bun.which = originalWhich;
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (!dir) continue;
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeAgentsDir(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-summary-worker-"));
	tmpDirs.push(dir);
	writeFileSync(join(dir, "agent.yaml"), content);
	return dir;
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

	it("populates content_hash so the embedding tracker can index summary facts", () => {
		// Regression: summary-worker previously inserted facts without content_hash,
		// making them invisible to the embedding tracker (which skips NULL-hash rows)
		// and causing the embed backfill to cycle indefinitely on duplicate content.
		insertSummaryFacts(
			accessor,
			{ harness: "claude-code", project: null, session_key: "sess-hash-test", agent_id: "test-agent" },
			[{ content: "Summary fact that needs a hash for embedding.", importance: 0.4, type: "fact" }],
		);

		const row = db.prepare("SELECT content_hash FROM memories WHERE source_id = 'sess-hash-test'").get() as
			| { content_hash: string | null }
			| undefined;

		expect(row).toBeDefined();
		expect(typeof row?.content_hash).toBe("string");
		expect((row?.content_hash ?? "").length).toBeGreaterThan(0);
	});
});

describe("recoverSummaryJobs", () => {
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

	it("recovers stuck summary jobs in bounded batches", () => {
		const now = new Date().toISOString();
		const stmt = db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, harness, project, transcript, status, attempts, max_attempts, created_at)
			 VALUES (?, NULL, 'codex', NULL, 'transcript', ?, ?, ?, ?)`,
		);

		for (let i = 0; i < 205; i++) {
			const attempts = i % 3;
			const max = 2;
			const status = i % 2 === 0 ? "processing" : "leased";
			stmt.run(`job-${i}`, status, attempts, max, now);
		}

		expect(recoverSummaryJobs(accessor, 100)).toEqual({ selected: 100, updated: 100 });
		expect(recoverSummaryJobs(accessor, 100)).toEqual({ selected: 100, updated: 100 });
		expect(recoverSummaryJobs(accessor, 100)).toEqual({ selected: 5, updated: 5 });
		expect(recoverSummaryJobs(accessor, 100)).toEqual({ selected: 0, updated: 0 });

		const left = db
			.prepare("SELECT COUNT(*) as n FROM summary_jobs WHERE status IN ('processing', 'leased')")
			.get() as { n: number };
		expect(left.n).toBe(0);

		const dead = db.prepare("SELECT COUNT(*) as n FROM summary_jobs WHERE status = 'dead'").get() as { n: number };
		expect(dead.n).toBeGreaterThan(0);
	});

	it("clamps invalid recovery limits to a sane positive range", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, harness, project, transcript, status, attempts, max_attempts, created_at)
			 VALUES ('job-limit', NULL, 'codex', NULL, 'transcript', 'processing', 0, 3, ?)`,
		).run(now);
		db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, harness, project, transcript, status, attempts, max_attempts, created_at)
			 VALUES ('job-limit-2', NULL, 'codex', NULL, 'transcript', 'processing', 0, 3, ?)`,
		).run(now);

		expect(recoverSummaryJobs(accessor, 0)).toEqual({ selected: 1, updated: 1 });
		expect(recoverSummaryJobs(accessor, Number.POSITIVE_INFINITY)).toEqual({ selected: 1, updated: 1 });
	});

	it("recovers both js and rust persisted in-flight status variants", () => {
		const now = new Date().toISOString();
		const stmt = db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, harness, project, transcript, status, attempts, max_attempts, created_at)
			 VALUES (?, NULL, 'codex', NULL, 'transcript', ?, 0, 3, ?)`,
		);

		stmt.run("job-processing", "processing", now);
		stmt.run("job-leased", "leased", now);

		expect(recoverSummaryJobs(accessor, 10)).toEqual({ selected: 2, updated: 2 });

		const rows = db.prepare("SELECT id, status FROM summary_jobs ORDER BY id ASC").all() as Array<{
			id: string;
			status: string;
		}>;
		expect(rows).toEqual([
			{ id: "job-leased", status: "pending" },
			{ id: "job-processing", status: "pending" },
		]);
	});

	it("clears in-flight command-stage-running marker during crash recovery but preserves completed checkpoint", () => {
		const now = new Date().toISOString();
		const stmt = db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, harness, project, transcript, status, result, attempts, max_attempts, created_at)
			 VALUES (?, NULL, 'codex', NULL, 'transcript', 'processing', ?, 0, 3, ?)`,
		);
		stmt.run("job-running", "command-stage-running", now);
		stmt.run("job-complete", "command-stage-complete", now);

		expect(recoverSummaryJobs(accessor, 10)).toEqual({ selected: 2, updated: 2 });

		expect(getCommandStageStatus(accessor, "job-running")).toBe("none");
		expect(getCommandStageStatus(accessor, "job-complete")).toBe("complete");
	});

	it("defers crash recovery off the synchronous startup path", async () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, harness, project, transcript, status, attempts, max_attempts, created_at)
			 VALUES ('job-startup', NULL, 'codex', NULL, 'transcript', 'processing', 0, 3, ?)`,
		).run(now);

		const handle = startSummaryWorker(accessor);
		const before = db.prepare("SELECT status FROM summary_jobs WHERE id = 'job-startup'").get() as { status: string };
		expect(before.status).toBe("processing");

		await new Promise((resolve) => setTimeout(resolve, 10));
		handle.stop();

		const after = db.prepare("SELECT status FROM summary_jobs WHERE id = 'job-startup'").get() as { status: string };
		expect(after.status).toBe("pending");
	});
});

describe("shouldRunSignificanceGateForJob", () => {
	it("runs significance gate for non-command extraction jobs", () => {
		expect(shouldRunSignificanceGateForJob(false, "none")).toBe(true);
		expect(shouldRunSignificanceGateForJob(false, "running")).toBe(true);
		expect(shouldRunSignificanceGateForJob(false, "complete")).toBe(true);
	});

	it("runs significance gate before command stage has completed", () => {
		expect(shouldRunSignificanceGateForJob(true, "none")).toBe(true);
	});

	it("skips significance gate for command retries once a stage checkpoint exists", () => {
		expect(shouldRunSignificanceGateForJob(true, "running")).toBe(false);
		expect(shouldRunSignificanceGateForJob(true, "complete")).toBe(false);
	});
});

describe("command stage completion marker", () => {
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

	it("tracks running and completed stage checkpoints for command-mode retries", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, harness, project, transcript, status, attempts, max_attempts, created_at, result)
			 VALUES ('job-cmd-marker', NULL, 'codex', NULL, 'transcript', 'processing', 1, 3, ?, NULL)`,
		).run(now);

		expect(getCommandStageStatus(accessor, "job-cmd-marker")).toBe("none");
		expect(hasCommandStageCompleted(accessor, "job-cmd-marker")).toBe(false);

		markCommandStageRunning(accessor, "job-cmd-marker");
		expect(getCommandStageStatus(accessor, "job-cmd-marker")).toBe("running");
		expect(hasCommandStageCompleted(accessor, "job-cmd-marker")).toBe(false);

		markCommandStageCompleted(accessor, "job-cmd-marker");

		expect(getCommandStageStatus(accessor, "job-cmd-marker")).toBe("complete");
		expect(hasCommandStageCompleted(accessor, "job-cmd-marker")).toBe(true);
	});

	it("does not mutate stage checkpoints when the job is not in processing state", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, harness, project, transcript, status, attempts, max_attempts, created_at, result)
			 VALUES ('job-cmd-pending', NULL, 'codex', NULL, 'transcript', 'pending', 0, 3, ?, NULL)`,
		).run(now);

		markCommandStageRunning(accessor, "job-cmd-pending");
		markCommandStageCompleted(accessor, "job-cmd-pending");
		clearCommandStageRunning(accessor, "job-cmd-pending");

		expect(getCommandStageStatus(accessor, "job-cmd-pending")).toBe("none");
		expect(hasCommandStageCompleted(accessor, "job-cmd-pending")).toBe(false);
	});

	it("clears the running checkpoint when command execution fails", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, harness, project, transcript, status, attempts, max_attempts, created_at, result)
			 VALUES ('job-cmd-fail-reset', NULL, 'codex', NULL, 'transcript', 'processing', 1, 3, ?, NULL)`,
		).run(now);

		markCommandStageRunning(accessor, "job-cmd-fail-reset");
		expect(getCommandStageStatus(accessor, "job-cmd-fail-reset")).toBe("running");

		clearCommandStageRunning(accessor, "job-cmd-fail-reset");
		expect(getCommandStageStatus(accessor, "job-cmd-fail-reset")).toBe("none");
	});
});

describe("runSummaryCommandProvider", () => {
	it("executes argv-safe command mode with token substitution and temp cleanup", async () => {
		const marker = join(tmpdir(), `signet-summary-marker-${Date.now()}-${Math.random()}.txt`);
		const dir = makeAgentsDir("memory:\n  pipelineV2:\n    extraction:\n      provider: ollama\n");
		const scriptPath = join(dir, "summary-command-success.mjs");
		writeFileSync(
			scriptPath,
			`import { existsSync, readFileSync, writeFileSync } from "node:fs";
const [transcriptPath, sessionKey, project, agentId, markerPath] = process.argv.slice(2);
if (!existsSync(transcriptPath)) process.exit(11);
const text = readFileSync(transcriptPath, "utf8");
if (!text.includes("hello command provider")) process.exit(12);
if (sessionKey !== "session-123") process.exit(13);
if (project !== "/tmp/project") process.exit(14);
if (agentId !== "agent-abc") process.exit(15);
writeFileSync(markerPath, transcriptPath, "utf8");
`,
			"utf8",
		);

		const cfg = loadMemoryConfig(dir);
		const commandCfg = {
			...cfg,
			pipelineV2: {
				...cfg.pipelineV2,
				extraction: {
					...cfg.pipelineV2.extraction,
					provider: "command",
					command: {
						bin: "node",
						args: [scriptPath, "$TRANSCRIPT", "$SESSION_KEY", "$PROJECT", "$AGENT_ID", marker],
					},
				},
			},
		};
		await runSummaryCommandProvider(
			{
				id: "job-1",
				session_key: "session-123",
				harness: "codex",
				project: "/tmp/project",
				agent_id: "agent-abc",
				transcript: "hello command provider",
				attempts: 1,
				max_attempts: 3,
				created_at: new Date().toISOString(),
			},
			commandCfg,
		);

		const transcriptPath = readFileSync(marker, "utf8").trim();
		expect(transcriptPath.length).toBeGreaterThan(0);
		expect(existsSync(transcriptPath)).toBe(false);
		rmSync(marker, { force: true });
	});

	it("throws when command exits non-zero", async () => {
		const dir = makeAgentsDir("memory:\n  pipelineV2:\n    extraction:\n      provider: ollama\n");
		const scriptPath = join(dir, "summary-command-fail.mjs");
		writeFileSync(scriptPath, "process.exit(7);\n", "utf8");

		const cfg = loadMemoryConfig(dir);
		const commandCfg = {
			...cfg,
			pipelineV2: {
				...cfg.pipelineV2,
				extraction: {
					...cfg.pipelineV2.extraction,
					provider: "command",
					command: {
						bin: "node",
						args: [scriptPath],
					},
				},
			},
		};
		await expect(
			runSummaryCommandProvider(
				{
					id: "job-2",
					session_key: "session-xyz",
					harness: "codex",
					project: "/tmp/project",
					agent_id: "default",
					transcript: "test",
					attempts: 1,
					max_attempts: 3,
					created_at: new Date().toISOString(),
				},
				commandCfg,
			),
		).rejects.toThrow("summary command exited with code 7");
	});

	it("waits for process exit after timeout before rejecting", async () => {
		const marker = join(tmpdir(), `signet-summary-timeout-${Date.now()}-${Math.random()}.txt`);
		const dir = makeAgentsDir("memory:\n  pipelineV2:\n    extraction:\n      provider: ollama\n");
		const scriptPath = join(dir, "summary-command-timeout.mjs");
		writeFileSync(
			scriptPath,
			`import { writeFileSync } from "node:fs";
const marker = process.argv[2];
process.on("SIGTERM", () => {
  setTimeout(() => {
    writeFileSync(marker, "terminated", "utf8");
    process.exit(0);
  }, 150);
});
setInterval(() => {}, 1000);
`,
			"utf8",
		);

		const cfg = loadMemoryConfig(dir);
		const commandCfg = {
			...cfg,
			pipelineV2: {
				...cfg.pipelineV2,
				extraction: {
					...cfg.pipelineV2.extraction,
					timeout: 5000,
					provider: "command",
					command: {
						bin: "node",
						args: [scriptPath, marker],
					},
				},
			},
		};

		await expect(
			runSummaryCommandProvider(
				{
					id: "job-timeout",
					session_key: "session-timeout",
					harness: "codex",
					project: "/tmp/project",
					agent_id: "default",
					transcript: "test",
					attempts: 1,
					max_attempts: 3,
					created_at: new Date().toISOString(),
				},
				commandCfg,
			),
		).rejects.toThrow("summary command timed out after 5000ms");

		expect(existsSync(marker)).toBe(true);
		rmSync(marker, { force: true });
	}, 15_000);
});

describe("resolveSummaryProvider", () => {
	it("uses explicit synthesis codex config", async () => {
		const dir = makeAgentsDir(`memory:
  pipelineV2:
    extractionProvider: ollama
    extractionModel: qwen3.5:4b
    synthesis:
      provider: codex
      model: gpt-5-codex-mini
`);

		const provider = await resolveSummaryProvider(loadMemoryConfig(dir));
		expect(provider.name).toBe("codex:gpt-5-codex-mini");
	});

	it("falls back to ollama when synthesis codex is configured but CLI is unavailable", async () => {
		Bun.which = (() => null) as typeof Bun.which;
		const dir = makeAgentsDir(`memory:
  pipelineV2:
    synthesis:
      provider: codex
      model: gpt-5-codex-mini
`);

		const provider = await resolveSummaryProvider(loadMemoryConfig(dir));
		expect(provider.name.startsWith("ollama:")).toBe(true);
	});

	it("falls back to resolved extraction config when synthesis is absent", async () => {
		const dir = makeAgentsDir(`memory:
  pipelineV2:
    extractionProvider: ollama
    extractionModel: qwen3.5:4b
    extractionEndpoint: http://127.0.0.1:11434
`);

		const provider = await resolveSummaryProvider(loadMemoryConfig(dir));
		expect(provider.name).toBe("ollama:qwen3.5:4b");
	});
});
