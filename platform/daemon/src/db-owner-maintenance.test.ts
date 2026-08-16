import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbOwnerMaintenance } from "./db-owner-maintenance";
import { createDbOwnerClient } from "./db-owner-client";
import { isFtsIndexIncomplete, setFtsIndexIncomplete } from "./fts-index-state";

function makeDatabase(): { readonly directory: string; readonly path: string } {
	const directory = mkdtempSync(join(tmpdir(), "signet-fts-owner-"));
	const path = join(directory, "memory.db");
	const db = new Database(path);
	db.exec(`
		CREATE TABLE memories (content TEXT NOT NULL);
		CREATE TABLE memory_jobs (status TEXT NOT NULL, job_type TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
		CREATE TABLE memory_history (
			id TEXT PRIMARY KEY,
			memory_id TEXT NOT NULL,
			event TEXT NOT NULL,
			old_content TEXT,
			new_content TEXT,
			changed_by TEXT NOT NULL,
			reason TEXT,
			metadata TEXT,
			created_at TEXT NOT NULL,
			actor_type TEXT,
			session_id TEXT,
			request_id TEXT
		);
		CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='rowid', tokenize='unicode61');
	`);
	const insert = db.prepare("INSERT INTO memories (content) VALUES (?)");
	for (let index = 0; index < 7; index += 1) insert.run(`owner backfill memory ${index}`);
	db.close();
	return { directory, path };
}

function countFts(path: string): number {
	const db = new Database(path, { readonly: true });
	const row = db.prepare("SELECT COUNT(*) AS count FROM memories_fts WHERE memories_fts MATCH 'memory'").get() as {
		count: number;
	};
	db.close();
	return row.count;
}

describe("DB owner FTS maintenance", () => {
	let maintenance: ReturnType<typeof createDbOwnerMaintenance> | null = null;
	let directory: string | null = null;

	afterEach(async () => {
		await maintenance?.close();
		maintenance = null;
		if (directory !== null) rmSync(directory, { recursive: true, force: true });
		directory = null;
	});

	test("backfills in bounded owner transactions and persists completion", async () => {
		const database = makeDatabase();
		directory = database.directory;
		maintenance = createDbOwnerMaintenance({ dbPath: database.path });

		const progress: number[] = [];
		const result = await maintenance.backfillFts({
			chunkSize: 2,
			onChunk: (chunk) => progress.push(chunk.inserted),
		});

		expect(result.status).toBe("complete");
		expect(result.chunks).toBe(4);
		expect(result.processed).toBe(7);
		expect(progress).toEqual([2, 2, 2, 1]);
		expect(countFts(database.path)).toBe(7);
		expect(maintenance.health().pid).not.toBe(process.pid);
	});

	test("updates the cached completeness signal as backfill completes", async () => {
		const database = makeDatabase();
		directory = database.directory;
		maintenance = createDbOwnerMaintenance({ dbPath: database.path });
		setFtsIndexIncomplete(false);

		const partial = await maintenance.backfillFts({ checkpointKey: "fts.cache", chunkSize: 2, maxChunks: 1 });
		expect(partial.status).toBe("running");
		expect(isFtsIndexIncomplete()).toBe(true);

		const complete = await maintenance.backfillFts({ checkpointKey: "fts.cache", chunkSize: 2 });
		expect(complete.status).toBe("complete");
		expect(isFtsIndexIncomplete()).toBe(false);
	});

	test("invalidates a completed checkpoint after the FTS index is lost", async () => {
		const database = makeDatabase();
		directory = database.directory;
		maintenance = createDbOwnerMaintenance({ dbPath: database.path });

		await maintenance.backfillFts({ checkpointKey: "fts.checkpoint-poisoning", chunkSize: 2 });
		const db = new Database(database.path);
		db.exec("DROP TABLE memories_fts");
		db.exec(
			"CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='rowid', tokenize='unicode61')",
		);
		db.close();

		const recovered = await maintenance.backfillFts({ checkpointKey: "fts.checkpoint-poisoning", chunkSize: 2 });

		expect(recovered).toMatchObject({ status: "complete", processed: 7 });
		expect(countFts(database.path)).toBe(7);
	});

	test("stops a backfill at the run-level work budget and resumes later", async () => {
		const database = makeDatabase();
		directory = database.directory;
		maintenance = createDbOwnerMaintenance({ dbPath: database.path });

		const bounded = await maintenance.backfillFts({
			checkpointKey: "fts.run-budget",
			chunkSize: 2,
			maxWorkUnits: 1,
		});
		expect(bounded).toMatchObject({ status: "running", chunks: 0, processed: 0 });

		const resumed = await maintenance.backfillFts({
			checkpointKey: "fts.run-budget",
			chunkSize: 2,
			maxWorkUnits: 10,
		});
		expect(resumed).toMatchObject({ status: "complete", processed: 7 });

		const cancelled = new AbortController();
		cancelled.abort();
		const cancelledRun = await maintenance.backfillFts({
			checkpointKey: "fts.cancelled",
			chunkSize: 2,
			signal: cancelled.signal,
		});
		expect(cancelledRun).toMatchObject({ status: "running", chunks: 0, processed: 0 });
	});
	test("reads queue pressure through the owner with age and liveness thresholds", async () => {
		const database = makeDatabase();
		directory = database.directory;
		maintenance = createDbOwnerMaintenance({ dbPath: database.path });
		const db = new Database(database.path);
		const old = new Date(Date.now() - 301_000).toISOString();
		db.prepare("INSERT INTO memory_jobs (status, job_type, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
			"pending",
			"remember",
			old,
			old,
		);
		db.close();

		expect(await maintenance.queueIsHealthy()).toBe(false);
	});

	test("resumes from the durable checkpoint after an owner crash", async () => {
		const database = makeDatabase();
		directory = database.directory;
		const owner = createDbOwnerClient({ dbPath: database.path });
		maintenance = createDbOwnerMaintenance({ dbPath: database.path, owner });
		let killed = false;

		await expect(
			maintenance.backfillFts({
				checkpointKey: "fts.crash-resume",
				chunkSize: 2,
				maxChunks: 1,
				onChunk: () => {
					if (killed) return;
					killed = true;
					const pid = owner.health().pid;
					if (pid === null) throw new Error("owner did not publish a pid");
					process.kill(pid, "SIGKILL");
				},
			}),
		).resolves.toMatchObject({ status: "running", processed: 2 });

		await expect(maintenance.backfillFts({ checkpointKey: "fts.crash-resume", chunkSize: 2 })).resolves.toMatchObject({
			status: "complete",
			processed: 7,
		});
		expect(countFts(database.path)).toBe(7);
	});

	test("rebuilds tokenizer state through the owner before chunking", async () => {
		const database = makeDatabase();
		directory = database.directory;
		maintenance = createDbOwnerMaintenance({ dbPath: database.path });

		const result = await maintenance.rebuildFts({
			chunkSize: 3,
			audit: {
				action: "fts-rebuild",
				actor: "daemon",
				reason: "test repair",
				actorType: "daemon",
				requestId: "request-test",
				message: "rebuild completed",
			},
		});

		expect(result.status).toBe("complete");
		expect(result.processed).toBe(7);
		expect(countFts(database.path)).toBe(7);
		const db = new Database(database.path, { readonly: true });
		const audit = db.prepare("SELECT changed_by, reason, actor_type, request_id FROM memory_history").get() as {
			changed_by: string;
			reason: string;
			actor_type: string;
			request_id: string;
		};
		db.close();
		expect(audit).toEqual({
			changed_by: "daemon",
			reason: "test repair",
			actor_type: "daemon",
			request_id: "request-test",
		});
	});
});
