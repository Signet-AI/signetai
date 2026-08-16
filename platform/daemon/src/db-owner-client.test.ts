import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDbOwnerClient,
	DbOwnerAdmissionError,
	DbOwnerCancelledError,
	DbOwnerDeadlineError,
	DbOwnerDiedError,
	MAX_DB_OWNER_PENDING_JOBS,
	MAX_DB_OWNER_WORK_UNITS,
} from "./db-owner-client";
import { findSqliteVecExtension } from "@signet/core";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { recallThroughDbOwner } from "./db-owner-recall";

function makeDb(): { readonly directory: string; readonly path: string } {
	const directory = mkdtempSync(join(tmpdir(), "signet-db-owner-"));
	const path = join(directory, "memory.db");
	const db = new Database(path);
	db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL)");
	db.prepare("INSERT INTO memories (id, content) VALUES (?, ?)").run("m1", "owner-routed recall");
	db.close();
	return { directory, path };
}

function makeMigratedDb(): { readonly directory: string; readonly path: string } {
	const directory = mkdtempSync(join(tmpdir(), "signet-db-owner-migrated-"));
	const path = join(directory, "memory.db");
	const previousPath = process.env.SIGNET_PATH;
	process.env.SIGNET_PATH = directory;
	mkdirSync(join(directory, "memory"), { recursive: true });
	closeDbAccessor();
	initDbAccessor(path);
	closeDbAccessor();
	if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousPath;
	return { directory, path };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error("condition did not become true");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("DB owner client", () => {
	let client: ReturnType<typeof createDbOwnerClient> | null = null;
	let directory: string | null = null;

	afterEach(async () => {
		await client?.close();
		client = null;
		if (directory !== null) rmSync(directory, { recursive: true, force: true });
		directory = null;
	});

	test("loads sqlite-vec for legacy snapshot import and preserves KNN rows", async () => {
		const extension = findSqliteVecExtension();
		if (extension === null) throw new Error("sqlite-vec extension is required for this regression");
		const database = makeMigratedDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		const vectorValues = new Float32Array(768);
		vectorValues[0] = 1;
		const vector = Buffer.from(vectorValues.buffer);
		await client.submit(
			{
				kind: "batch",
				statements: [
					{ sql: "CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(embedding float[3])", result: "run" },
					{
						sql: "INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
						params: [
							"vec-import-test",
							"hash-import-test",
							{ type: "bytes", base64: vector.toString("base64") },
							3,
							"source_chunk",
							"other-source:note#1",
							"knn import test",
							"2026-01-01T00:00:00.000Z",
							"import-agent",
						],
						result: "run",
					},
					{
						sql: "INSERT OR REPLACE INTO vec_embeddings (id, embedding) VALUES (?, ?)",
						params: ["vec-import-test", { type: "bytes", base64: vector.toString("base64") }],
						result: "run",
					},
				],
			},
			{ operation: "source-snapshot-vec-setup", lane: "write", deadlineMs: 5_000 },
		).result;
		const before = await client.submit<readonly { readonly id: string }[]>(
			{
				kind: "query",
				statement: {
					sql: "SELECT id FROM vec_embeddings WHERE embedding MATCH ? AND k = 1",
					params: [{ type: "bytes", base64: vector.toString("base64") }],
					result: "all",
				},
			},
			{ operation: "source-snapshot-vec-knn-before", lane: "read", deadlineMs: 5_000 },
		).result;
		expect(before).toEqual([{ id: "vec-import-test" }]);
		await client.submit(
			{
				kind: "source_snapshot_import",
				input: {
					agentId: "import-agent",
					sourceId: "import-source",
					sourceRoot: "/tmp/import",
					includeLocalDiscord: true,
					artifacts: [],
				},
			},
			{ operation: "source-snapshot-vec-import", lane: "write", deadlineMs: 5_000 },
		).result;
		const after = await client.submit<readonly { readonly id: string }[]>(
			{
				kind: "query",
				statement: {
					sql: "SELECT id FROM vec_embeddings WHERE embedding MATCH ? AND k = 1",
					params: [{ type: "bytes", base64: vector.toString("base64") }],
					result: "all",
				},
			},
			{ operation: "source-snapshot-vec-knn-after", lane: "read", deadlineMs: 5_000 },
		).result;
		expect(after).toEqual([{ id: "vec-import-test" }]);
	});

	test("routes a recall read through a separate owner process", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		const rows = await recallThroughDbOwner<{ id: string; content: string }>(
			client,
			"SELECT id, content FROM memories WHERE content = ?",
			["owner-routed recall"],
			{ deadlineMs: 1_000 },
		);
		expect(rows).toEqual([{ id: "m1", content: "owner-routed recall" }]);
		expect(client.health().state).toBe("ready");
		expect(client.health().pid).not.toBe(process.pid);
	});

	test("recall lane completes while maintenance lane is saturated", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		const maintenance = client.submit(
			{ kind: "sleep", durationMs: 250 },
			{ operation: "maintenance.saturation", lane: "maintenance", deadlineMs: 1_000 },
		);
		const startedAt = performance.now();
		const recall = client.submit<unknown[]>(
			{ kind: "query", statement: { sql: "SELECT 1 AS value", result: "all" } },
			{ operation: "recall.concurrent", lane: "read", deadlineMs: 1_000 },
		);
		await expect(recall.result).resolves.toEqual([{ value: 1 }]);
		const recallDurationMs = performance.now() - startedAt;
		await maintenance.result;
		expect(recallDurationMs).toBeLessThan(200);
	});

	test("keeps recall reads independent from maintenance work", async () => {
		const database = makeDb();
		directory = database.directory;
		const maintenanceClient = createDbOwnerClient({ dbPath: database.path });
		client = createDbOwnerClient({ dbPath: database.path, workerRole: "recall" });
		try {
			await Promise.all([maintenanceClient.start(), client.start()]);
			const slow = maintenanceClient.submit(
				{ kind: "sleep", durationMs: 300 },
				{ operation: "maintenance.blocking-test", lane: "maintenance", deadlineMs: 1_000 },
			);
			const startedAt = Date.now();
			const rows = await recallThroughDbOwner<{ id: string }>(client, "SELECT id FROM memories", [], {
				deadlineMs: 1_000,
			});
			expect(rows).toEqual([{ id: "m1" }]);
			expect(Date.now() - startedAt).toBeLessThan(250);
			await slow.result;
		} finally {
			await maintenanceClient.close();
		}
	});

	test("applies a hard deadline to a slow recall read and recovers", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path, workerRole: "recall" });
		const slow = client.submit(
			{ kind: "sleep", durationMs: 250 },
			{ operation: "recall.slow-read-deadline", lane: "read", deadlineMs: 40 },
		);
		await expect(slow.result).rejects.toBeInstanceOf(DbOwnerDeadlineError);
		const fast = recallThroughDbOwner<{ id: string }>(client, "SELECT id FROM memories", [], {
			deadlineMs: 1_000,
		});
		expect(await fast).toEqual([{ id: "m1" }]);
		expect(client.health().generation).toBe(2);
	});

	test("executes a transactional write on the owner before a read lane job", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		const write = client.submit<{ readonly changes: number }>(
			{
				kind: "query",
				statement: {
					sql: "INSERT INTO memories (id, content) VALUES (?, ?)",
					params: ["m2", "written by owner"],
					result: "run",
				},
			},
			{ operation: "memory.write", lane: "write", deadlineMs: 1_000 },
		);
		expect((await write.result).changes).toBe(1);
		const rows = await recallThroughDbOwner<{ id: string }>(client, "SELECT id FROM memories ORDER BY id");
		expect(rows).toEqual([{ id: "m1" }, { id: "m2" }]);
	});

	test("waits through a busy writer instead of failing the owner transaction", async () => {
		const database = makeDb();
		directory = database.directory;
		const blocker = new Database(database.path);
		blocker.exec("BEGIN IMMEDIATE");
		client = createDbOwnerClient({ dbPath: database.path });
		const write = client.submit<{ readonly changes: number }>(
			{
				kind: "query",
				statement: {
					sql: "INSERT INTO memories (id, content) VALUES (?, ?)",
					params: ["busy-writer", "waited for the writer"],
					result: "run",
				},
			},
			{ operation: "integrity.busy-writer", lane: "maintenance", deadlineMs: 2_000 },
		);
		await new Promise((resolve) => setTimeout(resolve, 150));
		blocker.exec("ROLLBACK");
		blocker.close();
		expect((await write.result).changes).toBe(1);
	});

	test("rolls back a batch when a required precondition changes zero rows", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		const batch = client.submit(
			{
				kind: "batch",
				statements: [
					{
						sql: "INSERT INTO memories (id, content) VALUES (?, ?)",
						params: ["m2", "rolled back"],
						result: "run",
					},
					{
						sql: "UPDATE memories SET content = ? WHERE id = ?",
						params: ["must not persist", "missing"],
						result: "run",
						requireChanges: true,
					},
				],
			},
			{ operation: "memory.batch-precondition", lane: "write", deadlineMs: 1_000 },
		);
		await expect(batch.result).rejects.toThrow("DB owner batch precondition changed zero rows");
		const rows = await recallThroughDbOwner<{ id: string }>(client, "SELECT id FROM memories ORDER BY id");
		expect(rows).toEqual([{ id: "m1" }]);
	});

	test("detects an owner crash and recovers with a fresh owner", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		await client.start();
		const pid = client.health().pid;
		if (pid === null) throw new Error("owner did not publish a pid");
		process.kill(pid, "SIGKILL");
		await waitFor(() => client?.health().state === "dead");
		const handle = client.submit<unknown[]>(
			{ kind: "query", statement: { sql: "SELECT id FROM memories", result: "all" } },
			{ operation: "recall.read", lane: "read", deadlineMs: 1_000 },
		);
		expect(await handle.result).toEqual([{ id: "m1" }]);
		expect(client.health().generation).toBe(2);
	});

	test("kills the owner at a hard deadline and leaves the daemon responsive", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		const slow = client.submit(
			{ kind: "sleep", durationMs: 250 },
			{ operation: "maintenance.deadline-test", lane: "maintenance", deadlineMs: 40 },
		);
		await expect(slow.result).rejects.toBeInstanceOf(DbOwnerDeadlineError);
		await waitFor(() => client?.health().state === "dead");
		expect(client.health().deadlineKills).toBe(1);
		const fast = client.submit<unknown[]>(
			{ kind: "query", statement: { sql: "SELECT 1 AS value", result: "all" } },
			{ operation: "recall.read", lane: "read", deadlineMs: 1_000 },
		);
		expect(await fast.result).toEqual([{ value: 1 }]);
	});

	test("recovers immediately after a deadline kills the owner", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		const slow = client.submit(
			{ kind: "sleep", durationMs: 250 },
			{ operation: "maintenance.immediate-deadline-test", lane: "maintenance", deadlineMs: 40 },
		);
		await expect(slow.result).rejects.toBeInstanceOf(DbOwnerDeadlineError);
		const fast = client.submit<unknown[]>(
			{ kind: "query", statement: { sql: "SELECT 1 AS value", result: "all" } },
			{ operation: "recall.immediate-recovery", lane: "read", deadlineMs: 1_000 },
		);
		expect(await fast.result).toEqual([{ value: 1 }]);
		expect(client.health().generation).toBe(1);
	});

	test("recovers on the immediate submission after an external SIGABRT", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		await client.start();
		const pid = client.health().pid;
		if (pid === null) throw new Error("owner did not publish a pid");
		process.kill(pid, "SIGABRT");
		const fast = client.submit<unknown[]>(
			{ kind: "query", statement: { sql: "SELECT 1 AS value", result: "all" } },
			{ operation: "recall.immediate-sigabrt-recovery", lane: "read", deadlineMs: 1_000 },
		);
		expect(await fast.result).toEqual([{ value: 1 }]);
		expect(client.health().generation).toBe(2);
	});

	test("fails closed when the owner cannot construct its database", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: join(database.directory, "missing", "database.db") });
		const handle = client.submit(
			{ kind: "query", statement: { sql: "SELECT 1", result: "all" } },
			{ operation: "recall.read", lane: "read", deadlineMs: 1_000 },
		);
		await expect(handle.result).rejects.toBeInstanceOf(DbOwnerDiedError);
		expect(client.health().state).toBe("failed");
	});

	test("cancels a queued job without touching the owner connection", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		const first = client.submit(
			{ kind: "sleep", durationMs: 100 },
			{ operation: "maintenance.sleep", lane: "maintenance", deadlineMs: 1_000 },
		);
		const second = client.submit(
			{ kind: "query", statement: { sql: "SELECT 1", result: "all" } },
			{ operation: "maintenance.queued-read", lane: "maintenance", deadlineMs: 1_000 },
		);
		await waitFor(() => client?.health().activeJobId === first.job.id);
		second.cancel();
		await expect(second.result).rejects.toBeInstanceOf(DbOwnerCancelledError);
		expect(client.health().queuedJobs).toBe(1);
		expect(client.health().activeJobId).toBe(first.job.id);
		await first.result;
		expect(client.health().queuedJobs).toBe(0);
		expect(client.health().activeJobId).toBeNull();
	});

	test("rejects owner work beyond the bounded queue admission cap", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		const owner = client;
		if (owner === null) throw new Error("owner client not created");
		expect(() =>
			owner.submit(
				{ kind: "sleep", durationMs: 1 },
				{
					operation: "maintenance.work-budget-overflow",
					lane: "maintenance",
					deadlineMs: 2_000,
					estimatedWorkUnits: MAX_DB_OWNER_WORK_UNITS + 1,
				},
			),
		).toThrow(DbOwnerAdmissionError);
		const handles: ReturnType<typeof owner.submit>[] = [];
		let rejected = 0;
		for (let index = 0; index < 1_000; index += 1) {
			try {
				handles.push(
					owner.submit(
						{ kind: "sleep", durationMs: 50 },
						{ operation: "maintenance.admission-test", lane: "maintenance", deadlineMs: 2_000 },
					),
				);
			} catch (error) {
				if (!(error instanceof DbOwnerAdmissionError)) throw error;
				rejected += 1;
			}
		}
		expect(handles).toHaveLength(MAX_DB_OWNER_PENDING_JOBS);
		expect(rejected).toBe(1_000 - MAX_DB_OWNER_PENDING_JOBS);

		for (const handle of handles) handle.cancel();
		await Promise.allSettled(handles.map((handle) => handle.result));
	});

	test("rejects a result that exceeds the bounded wire payload", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		const handle = client.submit(
			{
				kind: "query",
				statement: {
					sql: "SELECT ? AS content",
					params: ["x".repeat(1_100_000)],
					result: "all",
				},
			},
			{ operation: "recall.result-limit-test", lane: "read", deadlineMs: 2_000 },
		);
		await expect(handle.result).rejects.toMatchObject({ code: "DB_OWNER_RESULT_TOO_LARGE" });
	});
});
