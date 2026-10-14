import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbOwnerClient, DbOwnerDeadlineError, type DbOwnerClient } from "./db-owner-client";
import {
	nextIncrementalIntegrityRetryDelay,
	runIncrementalDatabaseIntegrityCheck,
	readMigrationVerifyCheckpoint,
	type IncrementalIntegrityProgress,
} from "./incremental-database-integrity";
import {
	getDatabaseIntegrityStatus,
	publishDatabaseIntegrityStatus,
	resetGlobalIntegrityLatch,
	updateDatabaseIntegrityStatus,
} from "./database-integrity";

const resources: Array<{ readonly directory: string; readonly owner: ReturnType<typeof createDbOwnerClient> }> = [];

afterEach(async () => {
	for (const resource of resources.splice(0)) {
		await resource.owner.close();
		rmSync(resource.directory, { recursive: true, force: true });
	}
});

function makeDatabase(): {
	readonly directory: string;
	readonly path: string;
	readonly owner: ReturnType<typeof createDbOwnerClient>;
} {
	const directory = mkdtempSync(join(tmpdir(), "incremental-integrity-"));
	const path = join(directory, "memory.db");
	const database = new Database(path);
	database.exec("CREATE TABLE alpha (value TEXT); CREATE TABLE beta (value TEXT); CREATE TABLE gamma (value TEXT);");
	database.close();
	const owner = createDbOwnerClient({ dbPath: path });
	resources.push({ directory, owner });
	return { directory, path, owner };
}

function recordingOwner(
	owner: DbOwnerClient,
	statements: Array<{ readonly sql: string; readonly params: readonly unknown[] }>,
): DbOwnerClient {
	return new Proxy(owner, {
		get(target, property) {
			if (property === "submit") {
				return (request: Parameters<DbOwnerClient["submit"]>[0], options: Parameters<DbOwnerClient["submit"]>[1]) => {
					if (request.kind === "query")
						statements.push({ sql: request.statement.sql, params: request.statement.params });
					return target.submit(request, options);
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

describe("incremental database integrity maintenance (#1683)", () => {
	it("backs off abandoned slices and resets after progress", () => {
		expect(nextIncrementalIntegrityRetryDelay("timed_out", 0)).toBe(1_000);
		expect(nextIncrementalIntegrityRetryDelay("timed_out", 1_000)).toBe(2_000);
		expect(nextIncrementalIntegrityRetryDelay("unavailable", 16_000)).toBe(30_000);
		expect(nextIncrementalIntegrityRetryDelay("timed_out", 30_000)).toBe(30_000);
		expect(nextIncrementalIntegrityRetryDelay("running", 0)).toBe(1_000);
		expect(nextIncrementalIntegrityRetryDelay("running", 8_000)).toBe(1_000);
		expect(nextIncrementalIntegrityRetryDelay("complete", 8_000)).toBe(0);
	});

	it("tolerates concurrent legacy checkpoint upgrades", async () => {
		const database = makeDatabase();
		const legacy = new Database(database.path);
		legacy.exec(`
			CREATE TABLE db_integrity_checkpoints (
				checkpoint_key TEXT PRIMARY KEY,
				cursor TEXT NOT NULL DEFAULT '',
				checked_tables INTEGER NOT NULL DEFAULT 0,
				failed_tables INTEGER NOT NULL DEFAULT 0,
				pages_checked INTEGER NOT NULL DEFAULT 0,
				bytes_checked INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'running',
				updated_at TEXT NOT NULL
			)
		`);
		legacy.close();
		await database.owner.start();

		const checkpoints = await Promise.all([
			readMigrationVerifyCheckpoint(database.owner, "test.integrity.concurrent-legacy"),
			readMigrationVerifyCheckpoint(database.owner, "test.integrity.concurrent-legacy"),
		]);
		expect(checkpoints).toEqual([
			{ attemptCount: 0, status: "running" },
			{ attemptCount: 0, status: "running" },
		]);

		const verification = new Database(database.path, { readonly: true });
		const columns = verification.prepare("PRAGMA table_info(db_integrity_checkpoints)").all() as Array<{
			name: string;
		}>;
		verification.close();
		expect(columns.some((column) => column.name === "attempt_count")).toBe(true);
		expect(columns.some((column) => column.name === "skipped_objects")).toBe(true);
		expect(columns.some((column) => column.name === "schema_version")).toBe(true);
	});

	it("does not multiply the database-wide page count by the object frontier", async () => {
		const database = makeDatabase();
		await database.owner.start();

		const result = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.database-page-count-math",
			tablesPerRun: 3,
			maxWorkUnits: 3,
			runBudgetMs: 5_000,
		});
		const verification = new Database(database.path, { readonly: true });
		const pageCount = (verification.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
		const pageSize = (verification.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
		verification.close();

		expect(result.phase).toBe("complete");
		expect(result.databasePagesObserved).toBe(pageCount);
		expect(result.databaseBytesObserved).toBe(pageCount * pageSize);
	});

	it("skips FTS objects and continues checking later objects", async () => {
		const database = makeDatabase();
		const db = new Database(database.path);
		db.exec(`
			CREATE TABLE session_transcripts (content TEXT NOT NULL);
			CREATE VIRTUAL TABLE session_transcripts_fts USING fts5(content, content='session_transcripts', content_rowid='rowid');
			CREATE TABLE z_after (value TEXT);
		`);
		db.close();
		await database.owner.start();
		const scans: string[] = [];

		const first = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.stuck-frontier-fts-object",
			tablesPerRun: 64,
			maxWorkUnits: 64,
			runBudgetMs: 5_000,
			onObjectScan: (object) => {
				scans.push(`${object.type}:${object.name}`);
			},
		});

		expect(first.phase).toBe("complete");
		expect(first.degradationReason).toBeNull();
		expect(first.skippedObjects).toBeGreaterThan(0);
		expect(first.remainingObjects).toBe(0);
		expect(scans).toContain("table:z_after");
		expect(getDatabaseIntegrityStatus()).toMatchObject({
			state: "healthy",
			phase: "complete",
			ftsVerification: "unverifiable",
		});
		expect(scans.filter((object) => object === "table:session_transcripts_fts")).toHaveLength(1);
	});

	it("restarts the sweep when the schema changes behind the saved cursor", async () => {
		const database = makeDatabase();
		await database.owner.start();
		const scans: string[] = [];
		const first = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.schema-change",
			tablesPerRun: 2,
			runBudgetMs: 5_000,
			onObjectScan: (object) => {
				scans.push(`${object.type}:${object.name}`);
			},
		});
		expect(first.phase).toBe("running");

		const db = new Database(database.path);
		db.exec("CREATE VIRTUAL TABLE a_new_fts USING fts5(value)");
		db.close();

		const resumed = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.schema-change",
			tablesPerRun: 64,
			maxWorkUnits: 64,
			runBudgetMs: 5_000,
			onObjectScan: (object) => {
				scans.push(`${object.type}:${object.name}`);
			},
		});
		expect(resumed.phase).toBe("complete");
		expect(resumed.skippedObjects).toBeGreaterThan(0);
		expect(scans).toContain("table:a_new_fts");
	});

	it("commits one table frontier per bounded slice and resumes", async () => {
		const database = makeDatabase();
		await database.owner.start();

		const first = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.resume",
			tablesPerRun: 1,
			runBudgetMs: 5_000,
		});
		expect(first.phase).toBe("running");
		expect(first.checkedObjects).toBe(1);
		expect(first.remainingObjects).toBe(2);
		expect(first.lastObject).toBe("table:alpha");
		expect(first.databasePagesObserved).toBeGreaterThan(0);
		expect(first.databaseBytesObserved).toBeGreaterThan(0);
		expect(first.ownerQueueAdmissionMs).toBeGreaterThanOrEqual(0);
		expect(first.ownerExecutionMs).toBeGreaterThanOrEqual(0);

		const second = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.resume",
			tablesPerRun: 2,
			runBudgetMs: 5_000,
		});
		expect(second.phase).toBe("complete");
		expect(second.checkedObjects).toBe(3);
		expect(second.remainingObjects).toBe(0);
		expect(second.failedObjects).toBe(0);
		expect(getDatabaseIntegrityStatus()).toMatchObject({
			state: "healthy",
			phase: "complete",
			ftsVerification: "complete",
		});
		expect(getDatabaseIntegrityStatus().incrementalProgress?.phase).toBe("complete");
	});

	it("stops at a checkpoint when cancelled before the next owner job", async () => {
		const database = makeDatabase();
		await database.owner.start();
		const controller = new AbortController();
		controller.abort();

		const result = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.cancel",
			signal: controller.signal,
		});

		expect(result.phase).toBe("cancelled");
		expect(result.checkedObjects).toBe(0);
		expect(result.cancellationReason).toContain("next table checkpoint");
	});

	it("uses the maintenance lane and records a bounded work estimate", async () => {
		const database = makeDatabase();
		await database.owner.start();
		const result = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.lane",
			tablesPerRun: 1,
			maxWorkUnits: 1,
		});

		expect(result.checkedObjects).toBe(1);
		expect(database.owner.health().activeJobId).toBeNull();
	});

	it("publishes the committed checkpoint without probing after an owner deadline", async () => {
		const operations: string[] = [];
		let releaseMetrics: (() => void) | undefined;
		let metricsSettled = false;
		const owner = {
			health: () => ({ state: "ready" }),
			submit: (_request: unknown, options: { readonly operation: string }) => {
				operations.push(options.operation);
				return {
					job: { enqueuedAt: Date.now() } as never,
					result: Promise.reject(new DbOwnerDeadlineError("test.integrity.deadline")),
					metrics: new Promise<undefined>((resolve) => {
						releaseMetrics = () => {
							metricsSettled = true;
							resolve(undefined);
						};
					}),
					cancel: (): void => {},
				};
			},
		} as unknown as DbOwnerClient;

		const resultPromise = runIncrementalDatabaseIntegrityCheck({
			owner,
			checkpointKey: "test.integrity.deadline",
			runBudgetMs: 5_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(metricsSettled).toBe(false);
		releaseMetrics?.();

		const result = await resultPromise;
		expect(result.phase).toBe("timed_out");
		expect(result.remainingObjects).toBe(0);
		expect(metricsSettled).toBe(true);
		expect(operations).toEqual(["integrity.checkpoint.ensure"]);
	});

	it("preserves the checkpoint across a hard 100ms run budget and resumes", async () => {
		const database = makeDatabase();
		const extraTables = new Database(database.path);
		for (let index = 0; index < 40; index += 1) extraTables.exec(`CREATE TABLE budget_${index} (value TEXT)`);
		extraTables.close();
		await database.owner.start();

		const timedOut = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.hard-budget",
			tablesPerRun: 64,
			maxWorkUnits: 64,
			runBudgetMs: 100,
			ownerDeadlineMs: 100,
		});
		expect(timedOut.phase).toBe("timed_out");
		expect(getDatabaseIntegrityStatus()).toMatchObject({ state: "unavailable", phase: "timed_out" });

		const resumed = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.hard-budget",
			tablesPerRun: 64,
			maxWorkUnits: 64,
			runBudgetMs: 5_000,
		});
		expect(resumed.phase).toBe("complete");
		expect(resumed.checkedObjects).toBeGreaterThan(timedOut.checkedObjects);
	});

	it("enumerates indexes, views, triggers, and runs the targeted telemetry integrity phase", async () => {
		const database = makeDatabase();
		const db = new Database(database.path);
		db.exec(
			"CREATE TABLE telemetry_events (event TEXT); CREATE INDEX telemetry_event_idx ON telemetry_events(event); CREATE VIEW alpha_view AS SELECT value FROM alpha; CREATE TRIGGER alpha_trigger AFTER INSERT ON alpha BEGIN SELECT 1; END",
		);
		db.close();
		await database.owner.start();
		const scans: string[] = [];

		const result = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.schema-objects",
			tablesPerRun: 64,
			maxWorkUnits: 64,
			runBudgetMs: 5_000,
			onObjectScan: (object) => {
				scans.push(`${object.type}:${object.name}`);
			},
		});
		expect(result.phase).toBe("complete");
		expect(result.checkedObjects).toBeGreaterThanOrEqual(7);
		expect(scans.filter((object) => object === "table:telemetry_events")).toHaveLength(1);
	});

	it("resumes from the committed frontier without re-querying it after interruption", async () => {
		const database = makeDatabase();
		await database.owner.start();
		const controller = new AbortController();
		const scans: string[] = [];
		let firstFrontierCommitted = false;
		const first = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.owner-interruption",
			tablesPerRun: 3,
			onObjectScan: (object) => {
				scans.push(`${object.type}:${object.name}`);
			},
			onProgress: async (progress) => {
				if (progress.checkedObjects === 1 && !firstFrontierCommitted) {
					firstFrontierCommitted = true;
					controller.abort();
					await database.owner.close();
				}
			},
			signal: controller.signal,
		});
		expect(first.phase).toBe("cancelled");
		expect(first.checkedObjects).toBe(1);
		expect(first.lastObject).toBe("table:alpha");

		const freshOwner = createDbOwnerClient({ dbPath: database.path });
		resources.push({ directory: database.directory, owner: freshOwner });
		await freshOwner.start();
		const resumedProgress: IncrementalIntegrityProgress[] = [];
		const resumed = await runIncrementalDatabaseIntegrityCheck({
			owner: freshOwner,
			checkpointKey: "test.integrity.owner-interruption",
			tablesPerRun: 3,
			onObjectScan: (object) => {
				scans.push(`${object.type}:${object.name}`);
			},
			onProgress: (progress) => {
				resumedProgress.push(progress);
			},
		});
		expect(resumedProgress[0]?.lastObject).toBe("table:alpha");
		expect(resumedProgress[0]?.checkedObjects).toBe(1);
		expect(resumed.phase).toBe("complete");
		expect(resumed.checkedObjects).toBe(3);
		expect(scans.filter((object) => object === "table:alpha")).toHaveLength(1);
	});

	it("checks a table too large for one owner job in bounded rowid chunks that resume across runs (#2126)", async () => {
		resetGlobalIntegrityLatch();
		const database = makeDatabase();
		const db = new Database(database.path);
		db.exec("CREATE TABLE history (id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
		db.exec("CREATE INDEX history_payload ON history(payload)");
		db.exec(`
			WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4798)
			INSERT INTO history SELECT printf('%032d', i), printf('payload-%d', i) FROM n
		`);
		db.exec(`
			INSERT INTO history (rowid, id, payload) VALUES
				(-7, 'negative', 'payload-negative'),
				(9007199254740993, 'past-safe-integer-1', 'payload-past-1'),
				(9007199254740995, 'past-safe-integer-2', 'payload-past-2')
		`);
		db.close();
		await database.owner.start();
		const statements: Array<{ readonly sql: string; readonly params: readonly unknown[] }> = [];
		const owner = recordingOwner(database.owner, statements);
		const options = {
			owner,
			checkpointKey: "test.integrity.large-table",
			tablesPerRun: 4,
			maxWorkUnits: 4,
			runBudgetMs: 60_000,
			ownerDeadlineMs: 5_000,
			largeTableRows: 1_000,
			scanChunkRows: 400,
		};

		const results = [];
		for (let run = 0; run < 40; run += 1) {
			const result = await runIncrementalDatabaseIntegrityCheck(options);
			results.push(result);
			expect(result.phase === "running" || result.phase === "complete").toBe(true);
			if (result.phase === "complete") break;
		}

		const midTable = results.find((result) => result.phase === "running" && result.lastObject === "table:history");
		expect(midTable?.remainingObjects).toBeGreaterThan(0);
		expect(midTable?.scannedObjects).toBe(0);
		const final = results.at(-1);
		expect(final).toMatchObject({ phase: "complete", failedObjects: 0, scannedObjects: 1, remainingObjects: 0 });
		expect(statements.some((statement) => /(quick|integrity)_check\("history"\)/.test(statement.sql))).toBe(false);
		const scans = statements.filter((statement) => /FROM "history"\s.*ORDER BY rowid LIMIT \?/s.test(statement.sql));
		expect(scans.length).toBe(Math.ceil(4801 / 400));
		expect(scans[0]?.sql).not.toContain("WHERE rowid >");
		const resumeAfter = scans.slice(1).map((statement) => BigInt(String(statement.params[0])));
		for (let index = 1; index < resumeAfter.length; index += 1) {
			expect(resumeAfter[index] ?? 0n).toBeGreaterThan(resumeAfter[index - 1] ?? 0n);
		}
		expect(resumeAfter.at(-1)).toBe(9007199254740993n);
		expect(getDatabaseIntegrityStatus()).toMatchObject({ state: "healthy", phase: "complete" });
		expect(getDatabaseIntegrityStatus().quickCheck).toMatchObject({
			ok: true,
			messages: [expect.stringContaining("1 large table was read in bounded rowid chunks instead of quick_check")],
		});
	});

	it("records an unreadable chunk of a large table as a failed object and finishes the sweep", async () => {
		resetGlobalIntegrityLatch();
		const database = makeDatabase();
		const db = new Database(database.path);
		db.exec("CREATE TABLE history (payload TEXT)");
		db.exec(`
			WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
			INSERT INTO history SELECT printf('%0100d', i) FROM n
		`);
		db.exec("CREATE TABLE z_after (value TEXT)");
		const pageSize = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
		const lastLeaf = (
			db.prepare("SELECT max(pageno) AS page FROM dbstat WHERE name = 'history' AND pagetype = 'leaf'").get() as {
				page: number;
			}
		).page;
		db.close();
		const file = openSync(database.path, "r+");
		writeSync(file, Buffer.from([0xff]), 0, 1, (lastLeaf - 1) * pageSize);
		closeSync(file);
		await database.owner.start();
		const scans: string[] = [];

		const errors: string[] = [];
		let result: Awaited<ReturnType<typeof runIncrementalDatabaseIntegrityCheck>> | undefined;
		for (let run = 0; run < 40; run += 1) {
			result = await runIncrementalDatabaseIntegrityCheck({
				owner: database.owner,
				checkpointKey: "test.integrity.large-table-corrupt",
				tablesPerRun: 64,
				maxWorkUnits: 64,
				runBudgetMs: 60_000,
				ownerDeadlineMs: 5_000,
				largeTableRows: 10,
				scanChunkRows: 100,
				onObjectScan: (object) => {
					scans.push(`${object.type}:${object.name}`);
				},
			});
			errors.push(...result.errors);
			expect(result.phase === "running" || result.phase === "complete").toBe(true);
			if (result.phase === "complete") break;
		}

		expect(result?.phase).toBe("complete");
		expect(result?.failedObjects).toBe(1);
		expect(errors.join(" ")).toContain("history");
		expect(scans).toContain("table:z_after");
		expect(getDatabaseIntegrityStatus().state).toBe("corrupt");
		resetGlobalIntegrityLatch();
	});

	it("does not let an incremental healthy publication mask global corruption", () => {
		const quickCheckBefore = getDatabaseIntegrityStatus().quickCheck;
		publishDatabaseIntegrityStatus("corrupt", ["global integrity failure"]);
		updateDatabaseIntegrityStatus({
			checkpointKey: "database.quick-check",
			phase: "complete",
			checkedObjects: 3,
			skippedObjects: 0,
			failedObjects: 0,
			remainingObjects: 0,
			lastObject: "table:gamma",
			databasePagesObserved: 3,
			databaseBytesObserved: 12_288,
			elapsedMs: 4,
			ownerQueueAdmissionMs: 0,
			ownerExecutionMs: 1,
			cancellationReason: null,
			degradationReason: null,
		});

		expect(getDatabaseIntegrityStatus()).toMatchObject({
			state: "corrupt",
			integrity: "global integrity failure",
			quickCheck: quickCheckBefore,
		});
		publishDatabaseIntegrityStatus("healthy");
	});
});
