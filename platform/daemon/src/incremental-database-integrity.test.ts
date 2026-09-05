import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbOwnerClient } from "./db-owner-client";
import {
	nextIncrementalIntegrityRetryDelay,
	runIncrementalDatabaseIntegrityCheck,
	readMigrationVerifyCheckpoint,
	type IncrementalIntegrityProgress,
} from "./incremental-database-integrity";
import {
	getDatabaseIntegrityStatus,
	publishDatabaseIntegrityStatus,
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

describe("incremental database integrity maintenance (#1683)", () => {
	it("backs off abandoned slices and resets after progress", () => {
		expect(nextIncrementalIntegrityRetryDelay("timed_out", 0)).toBe(1_000);
		expect(nextIncrementalIntegrityRetryDelay("timed_out", 1_000)).toBe(2_000);
		expect(nextIncrementalIntegrityRetryDelay("unavailable", 16_000)).toBe(30_000);
		expect(nextIncrementalIntegrityRetryDelay("timed_out", 30_000)).toBe(30_000);
		expect(nextIncrementalIntegrityRetryDelay("running", 8_000)).toBe(0);
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

	it("parks the stuck-frontier-on-FTS-object class in a named degraded state", async () => {
		const database = makeDatabase();
		const db = new Database(database.path);
		db.exec(`
			CREATE TABLE session_transcripts (content TEXT NOT NULL);
			CREATE VIRTUAL TABLE session_transcripts_fts USING fts5(content, content='session_transcripts', content_rowid='rowid');
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

		expect(first.phase).toBe("degraded");
		expect(first.degradationReason).toBe("degraded:fts-unverifiable");
		expect(first.remainingObjects).toBe(0);
		expect(getDatabaseIntegrityStatus()).toMatchObject({
			state: "degraded",
			phase: "degraded",
			integrity: "degraded:fts-unverifiable",
		});

		const second = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.stuck-frontier-fts-object",
			tablesPerRun: 64,
			maxWorkUnits: 64,
			runBudgetMs: 5_000,
			onObjectScan: (object) => {
				scans.push(`${object.type}:${object.name}`);
			},
		});
		expect(second.phase).toBe("degraded");
		expect(scans.filter((object) => object === "table:session_transcripts_fts")).toHaveLength(1);
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
		expect(getDatabaseIntegrityStatus()).toMatchObject({ state: "healthy", phase: "complete" });
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

		const result = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.schema-objects",
			tablesPerRun: 64,
			maxWorkUnits: 64,
			runBudgetMs: 5_000,
		});
		expect(result.phase).toBe("complete");
		expect(result.checkedObjects).toBeGreaterThanOrEqual(7);
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

	it("does not let an incremental healthy publication mask global corruption", () => {
		const quickCheckBefore = getDatabaseIntegrityStatus().quickCheck;
		publishDatabaseIntegrityStatus("corrupt", ["global integrity failure"]);
		updateDatabaseIntegrityStatus({
			checkpointKey: "database.quick-check",
			phase: "complete",
			checkedObjects: 3,
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
