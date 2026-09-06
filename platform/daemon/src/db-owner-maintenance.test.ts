import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	closeRegisteredDbOwnerMaintenance,
	createDbOwnerMaintenance,
	getDbOwnerHealth,
	registerDbOwnerMaintenance,
	runOwnerMaintenanceWithRetry,
} from "./db-owner-maintenance";
import { createDbOwnerClient, DbOwnerDiedError, type DbOwnerClient, type DbOwnerHealth } from "./db-owner-client";
import type { DbOwnerMaintenance } from "./db-owner-maintenance";
import { isFtsIndexIncomplete, setFtsIndexIncomplete } from "./fts-index-state";
import { completeFtsStartupRecovery } from "./fts-startup-recovery";

function makeDatabase(memoryCount = 7): { readonly directory: string; readonly path: string } {
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
	for (let index = 0; index < memoryCount; index++) insert.run(`owner backfill memory ${index}`);
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

function readFtsState(path: string): {
	readonly memoryCount: number;
	readonly indexedCount: number;
	readonly physicalCount: number;
} {
	const db = new Database(path, { readonly: true });
	const state = db
		.prepare("SELECT memory_count AS memoryCount, indexed_count AS indexedCount FROM memories_fts_state")
		.get() as {
		memoryCount: number;
		indexedCount: number;
	};
	const physical = db.prepare("SELECT COUNT(*) AS count FROM memories_fts_docsize").get() as { count: number };
	db.close();
	return { memoryCount: state.memoryCount, indexedCount: state.indexedCount, physicalCount: physical.count };
}

function countFtsMatches(path: string, query: string): number {
	const db = new Database(path, { readonly: true });
	const row = db.prepare("SELECT COUNT(*) AS count FROM memories_fts WHERE memories_fts MATCH ?").get(query) as {
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

	test("recomputes the remaining run budget after an owner retry", async () => {
		const deadlines: number[] = [];
		let attempt = 0;
		const owner = {
			start: async (): Promise<void> => {},
			submit: (_request: unknown, options: { readonly deadlineMs: number }) => {
				deadlines.push(options.deadlineMs);
				const currentAttempt = attempt++;
				const delayMs = currentAttempt === 0 ? 20 : Math.min(250, options.deadlineMs + 10);
				return {
					job: {} as never,
					result: new Promise<unknown>((resolve, reject) => {
						setTimeout(() => {
							if (currentAttempt === 0) reject(new DbOwnerDiedError());
							else resolve("ok");
						}, delayMs);
					}),
					cancel: (): void => {},
				};
			},
		} as unknown as DbOwnerClient;

		const startedAt = Date.now();
		await expect(
			runOwnerMaintenanceWithRetry(owner, { kind: "sleep", durationMs: 0 }, "test.owner-retry", {
				deadlineMs: 100,
			}),
		).resolves.toBe("ok");

		expect(deadlines).toHaveLength(2);
		expect(deadlines[1]).toBeLessThan(deadlines[0]);
		expect(Date.now() - startedAt).toBeLessThan(125);
	});

	test("rejects a replacement until the registered owner resource is closed", async () => {
		const health = {
			state: "ready",
			initialization: "ready",
			databaseReady: true,
			pid: null,
			generation: 1,
			queuedJobs: 0,
			foregroundQueuedJobs: 0,
			maintenanceQueuedJobs: 0,
			activeJobId: null,
			activeWorkloadClass: null,
			foregroundOldestAgeMs: null,
			maintenanceOldestAgeMs: null,
			lastError: null,
		} as DbOwnerHealth;
		const first = { health: () => health, close: async (): Promise<void> => {} } as unknown as DbOwnerMaintenance;
		const replacement = { health: () => health } as unknown as DbOwnerMaintenance;
		registerDbOwnerMaintenance(first);
		try {
			expect(() => registerDbOwnerMaintenance(replacement)).toThrow(
				"DB owner maintenance is already registered; close it before registering a replacement",
			);
		} finally {
			await closeRegisteredDbOwnerMaintenance();
		}
	});

	test("clears owner health before asynchronous resource cleanup completes", async () => {
		let release: (() => void) | undefined;
		let closeStarted: (() => void) | undefined;
		const closeGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			closeStarted = resolve;
		});
		const health = {
			state: "ready",
			initialization: "ready",
			databaseReady: true,
			pid: null,
			generation: 1,
			queuedJobs: 0,
			foregroundQueuedJobs: 0,
			maintenanceQueuedJobs: 0,
			activeJobId: null,
			activeWorkloadClass: null,
			foregroundOldestAgeMs: null,
			maintenanceOldestAgeMs: null,
			lastError: null,
		} as DbOwnerHealth;
		const resource = {
			health: () => health,
			close: async (): Promise<void> => {
				closeStarted?.();
				await closeGate;
			},
		} as unknown as DbOwnerMaintenance;
		const replacement = { health: () => health } as unknown as DbOwnerMaintenance;
		registerDbOwnerMaintenance(resource);
		expect(getDbOwnerHealth()).toBe(health);

		const closing = closeRegisteredDbOwnerMaintenance();
		await started;
		expect(getDbOwnerHealth()).toBeNull();
		expect(() => registerDbOwnerMaintenance(replacement)).toThrow(
			"DB owner maintenance is closing; wait before registering a replacement",
		);
		release?.();
		await closing;
	});

	test("reports queue admission separately from owner execution time", async () => {
		const reported: Array<{ readonly queueAdmissionMs: number; readonly ownerExecutionMs: number }> = [];
		const owner = {
			start: async (): Promise<void> => {},
			submit: () => ({
				job: { enqueuedAt: 100 } as never,
				result: Promise.resolve("ok"),
				metrics: Promise.resolve({ startedAt: 130, finishedAt: 190 }),
				cancel: (): void => {},
			}),
		} as unknown as DbOwnerClient;

		await expect(
			runOwnerMaintenanceWithRetry(owner, { kind: "sleep", durationMs: 0 }, "test.owner-metrics", {
				deadlineMs: 1_000,
				onOwnerMetrics: (metrics) => {
					reported.push(metrics);
				},
			}),
		).resolves.toBe("ok");
		expect(reported).toEqual([{ queueAdmissionMs: 30, ownerExecutionMs: 60 }]);
	});

	test("backfills in bounded owner transactions and persists completion", async () => {
		const database = makeDatabase();
		directory = database.directory;
		maintenance = createDbOwnerMaintenance({ dbPath: database.path });

		const progress: number[] = [];
		const result = await maintenance.backfillFts({
			chunkSize: 2,
			onChunk: (chunk): void => {
				progress.push(chunk.inserted);
			},
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

	test("resumes startup FTS recovery after the 10,000-unit cap (#1631)", async () => {
		const database = makeDatabase(10_001);
		directory = database.directory;
		maintenance = createDbOwnerMaintenance({ dbPath: database.path });
		setFtsIndexIncomplete(false);
		const passes: Array<{ readonly status: string; readonly processed: number; readonly incomplete: boolean }> = [];

		const result = await completeFtsStartupRecovery({
			backfill: maintenance.backfillFts,
			backfillOptions: { checkpointKey: "fts.memories.startup" },
			scheduleContinuation: (callback): void => {
				const timer = setTimeout(callback, 0);
				timer.unref?.();
			},
			onPass: (pass) =>
				passes.push({ status: pass.status, processed: pass.processed, incomplete: isFtsIndexIncomplete() }),
		});

		expect(passes[0]).toMatchObject({ status: "running", processed: 10_000, incomplete: true });
		expect(result).toMatchObject({ status: "complete", processed: 10_001 });
		expect(isFtsIndexIncomplete()).toBe(false);
		expect(readFtsState(database.path)).toEqual({ memoryCount: 10_001, indexedCount: 10_001, physicalCount: 10_001 });
		expect(countFtsMatches(database.path, "10000")).toBe(1);
	});

	test("converges after deleting a row below the active backfill cursor", async () => {
		const database = makeDatabase();
		directory = database.directory;
		maintenance = createDbOwnerMaintenance({ dbPath: database.path });

		await maintenance.backfillFts({ checkpointKey: "fts.delete-unindexed", chunkSize: 2, maxChunks: 1 });
		const db = new Database(database.path);
		db.prepare("DELETE FROM memories WHERE rowid = ?").run(7);
		db.close();

		const result = await maintenance.backfillFts({ checkpointKey: "fts.delete-unindexed", chunkSize: 2 });

		expect(result.status).toBe("complete");
		expect(readFtsState(database.path)).toEqual({ memoryCount: 6, indexedCount: 6, physicalCount: 6 });
	});

	test("indexes new content and converges after updating a row below the active backfill cursor", async () => {
		const database = makeDatabase();
		directory = database.directory;
		maintenance = createDbOwnerMaintenance({ dbPath: database.path });

		await maintenance.backfillFts({ checkpointKey: "fts.update-unindexed", chunkSize: 2, maxChunks: 1 });
		const db = new Database(database.path);
		db.prepare("UPDATE memories SET content = ? WHERE rowid = ?").run("updated unindexed content", 7);
		db.close();

		const result = await maintenance.backfillFts({ checkpointKey: "fts.update-unindexed", chunkSize: 2 });

		expect(result.status).toBe("complete");
		expect(readFtsState(database.path)).toEqual({ memoryCount: 7, indexedCount: 7, physicalCount: 7 });
		expect(countFtsMatches(database.path, "updated")).toBe(1);
		expect(countFtsMatches(database.path, "old")).toBe(0);
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

	test("resets a running checkpoint after the index is recreated", async () => {
		const database = makeDatabase();
		directory = database.directory;
		maintenance = createDbOwnerMaintenance({ dbPath: database.path });

		await expect(
			maintenance.backfillFts({ checkpointKey: "fts.running-reset", chunkSize: 2, maxChunks: 1 }),
		).resolves.toMatchObject({ status: "running", cursor: 2, processed: 2 });

		const db = new Database(database.path);
		db.exec("DROP TABLE memories_fts");
		db.exec(
			"CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='rowid', tokenize='unicode61')",
		);
		db.close();

		const recovered = await maintenance.backfillFts({ checkpointKey: "fts.running-reset", chunkSize: 2 });

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
