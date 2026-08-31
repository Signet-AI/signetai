import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDbOwnerClient,
	DB_OWNER_CANCEL_REGISTRY_MAX_AGE_MS,
	DbOwnerAdmissionError,
	DbOwnerCancelledError,
	DbOwnerDeadlineError,
	DbOwnerDiedError,
	DbOwnerWritesBlockedError,
	MAX_DB_OWNER_PENDING_JOBS,
	MAX_DB_OWNER_WORK_UNITS,
} from "./db-owner-client";
import { shouldRecordDbOwnerCancellation } from "./db-owner-worker";
import { findSqliteVecExtension } from "@signet/core";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { createDbOwnerMaintenance, registerDbOwnerMaintenance } from "./db-owner-maintenance";
import { recallThroughDbOwner } from "./db-owner-recall";
import { dbOwnerQuery, startDbOwnerWithRole } from "./db-owner-runtime";

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
		registerDbOwnerMaintenance(null);
		await client?.close();
		client = null;
		if (directory !== null) rmSync(directory, { recursive: true, force: true });
		directory = null;
	});

	function processExists(pid: number): boolean {
		try {
			const status = readFileSync(`/proc/${pid}/status`, "utf8");
			if (/^State:\s+Z/m.test(status)) return false;
			execFileSync("kill", ["-0", String(pid)], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	}

	function assertNoSurvivors(spawnedPids: ReadonlySet<number>): void {
		const survivors = [...spawnedPids].filter(processExists);
		if (survivors.length > 0) {
			throw new Error(`DB owner survivor(s) detected: ${survivors.join(", ")}`);
		}
	}

	test("keeps owner IPC clean while running vector backfill slices", async () => {
		const database = makeDb();
		directory = database.directory;
		const fixture = new Database(database.path);
		fixture.exec(
			"CREATE TABLE embeddings (id TEXT PRIMARY KEY, dimensions INTEGER NOT NULL, vector BLOB); CREATE TABLE vec_embeddings (id TEXT PRIMARY KEY, embedding BLOB NOT NULL); CREATE TABLE vec_embeddings_rowids (id TEXT PRIMARY KEY); CREATE TRIGGER vec_embeddings_rowids_after_insert AFTER INSERT ON vec_embeddings BEGIN INSERT OR REPLACE INTO vec_embeddings_rowids (id) VALUES (NEW.id); END",
		);
		const vector = Buffer.from(new Float32Array([1, 2]).buffer);
		const insert = fixture.prepare("INSERT INTO embeddings (id, dimensions, vector) VALUES (?, 2, ?)");
		for (let index = 0; index < 1_201; index += 1) {
			insert.run(`embedding-${String(index).padStart(4, "0")}`, index === 600 ? Buffer.from([1]) : vector);
		}
		fixture.close();

		client = createDbOwnerClient({ dbPath: database.path });
		await client.start();
		const maintenanceBefore = client.health().lanes?.maintenance;
		if (maintenanceBefore === undefined || maintenanceBefore.pid === null) {
			throw new Error("maintenance owner did not publish a pid");
		}
		for (let iteration = 0; iteration < 4; iteration += 1) {
			await expect(
				client.submit<{ readonly completed: boolean }>(
					{ kind: "vector_backfill", expectedDimensions: 2, maxBatches: 1, batchSize: 500 },
					{ operation: "maintenance.vector-backfill-regression", lane: "maintenance", deadlineMs: 10_000 },
				).result,
			).resolves.toEqual({ completed: true });
			const maintenance = client.health().lanes?.maintenance;
			expect(maintenance).toMatchObject({
				state: "ready",
				generation: 1,
				pid: maintenanceBefore.pid,
				lastError: null,
			});
		}
		const counts = await client.submit<
			readonly { readonly embeddings: number; readonly vectors: number; readonly quarantined: number }[]
		>(
			{
				kind: "query",
				statement: {
					sql: "SELECT (SELECT COUNT(*) FROM embeddings) AS embeddings, (SELECT COUNT(*) FROM vec_embeddings) AS vectors, (SELECT COUNT(*) FROM vec_embeddings_quarantine) AS quarantined",
					result: "all",
				},
			},
			{ operation: "maintenance.vector-backfill-regression-verify", lane: "read", deadlineMs: 5_000 },
		).result;
		expect(counts).toEqual([{ embeddings: 1_201, vectors: 1_200, quarantined: 1 }]);
	});

	test("keeps the owner alive when sqlite-vec cannot be loaded", async () => {
		const database = makeDb();
		directory = database.directory;
		const extensionOverride = join(database.directory, "not-an-extension.txt");
		writeFileSync(extensionOverride, "this is deliberately not a sqlite extension");
		const previousVecPath = process.env.SIGNET_VEC_PATH;
		process.env.SIGNET_VEC_PATH = extensionOverride;
		try {
			client = createDbOwnerClient({ dbPath: database.path, workerPath: join(import.meta.dir, "db-owner-worker.ts") });
			await client.start();
			await expect(
				client.submit<readonly { readonly value: number }[]>(
					{ kind: "query", statement: { sql: "SELECT 1 AS value", result: "all" } },
					{ operation: "vec-degraded-plain-query", lane: "read", deadlineMs: 1_000 },
				).result,
			).resolves.toEqual([{ value: 1 }]);
			expect(client.health().state).toBe("ready");
			expect(client.health().pid).not.toBeNull();
		} finally {
			if (previousVecPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_VEC_PATH");
			else process.env.SIGNET_VEC_PATH = previousVecPath;
		}
	});

	test("publishes protocol readiness before synchronous database startup", async () => {
		const database = makeDb();
		directory = database.directory;
		const startupStarted = join(database.directory, "startup-started");
		const startupRelease = join(database.directory, "startup-release");
		const previousStarted = process.env.SIGNET_DB_OWNER_TEST_STARTUP_STARTED;
		const previousRelease = process.env.SIGNET_DB_OWNER_TEST_STARTUP_RELEASE;
		process.env.SIGNET_DB_OWNER_TEST_STARTUP_STARTED = startupStarted;
		process.env.SIGNET_DB_OWNER_TEST_STARTUP_RELEASE = startupRelease;
		try {
			client = createDbOwnerClient({ dbPath: database.path });
			const start = client.start();
			await waitFor(() => existsSync(startupStarted));
			await expect(start).resolves.toBeUndefined();
			writeFileSync(startupRelease, "release\n");
			await expect(
				client.submit<readonly { readonly value: number }[]>(
					{ kind: "query", statement: { sql: "SELECT 1 AS value", result: "all" } },
					{ operation: "startup-ready-query", lane: "read", deadlineMs: 1_000 },
				).result,
			).resolves.toEqual([{ value: 1 }]);
		} finally {
			writeFileSync(startupRelease, "release\n");
			if (previousStarted === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_TEST_STARTUP_STARTED");
			else process.env.SIGNET_DB_OWNER_TEST_STARTUP_STARTED = previousStarted;
			if (previousRelease === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_TEST_STARTUP_RELEASE");
			else process.env.SIGNET_DB_OWNER_TEST_STARTUP_RELEASE = previousRelease;
		}
	});

	test("reaps a fatal owner before allowing replacement startup", async () => {
		const database = makeDb();
		directory = database.directory;
		const workerPath = join(database.directory, "fatal-owner-worker.js");
		writeFileSync(
			workerPath,
			[
				'process.stdin.setEncoding("utf8");',
				"const newline = String.fromCharCode(10);",
				'process.stdout.write(JSON.stringify({ type: "ready", pid: process.pid }) + newline);',
				'process.stdin.on("data", (chunk) => {',
				"  for (const line of chunk.split(newline)) {",
				"    if (!line) continue;",
				"    const command = JSON.parse(line);",
				'    if (command.type === "submit") process.stdout.write(JSON.stringify({ type: "fatal", error: { name: "TEST_FATAL", message: "owner fatal" } }) + newline);',
				"  }",
				"});",
			].join(String.fromCharCode(10)),
		);
		client = createDbOwnerClient({ dbPath: database.path, workerPath });
		await client.start();
		const firstPid = client.health().pid;
		if (firstPid === null) throw new Error("fatal test owner did not publish a pid");
		const handle = client.submit<readonly { readonly value: number }[]>(
			{ kind: "query", statement: { sql: "SELECT 1 AS value", result: "all" } },
			{ operation: "fatal-owner-regression", lane: "read", deadlineMs: 5_000 },
		);
		await expect(handle.result).rejects.toMatchObject({ message: "owner fatal" });
		await waitFor(() => !processExists(firstPid));
		expect(client.health().lanes?.read).toMatchObject({ state: "failed", pid: null });

		await client.start();
		const replacementPid = client.health().lanes?.read?.pid;
		expect(replacementPid).not.toBeNull();
		expect(replacementPid).not.toBe(firstPid);
	});

	test("serializes replacement startup behind retired owner reaping", async () => {
		const database = makeDb();
		directory = database.directory;
		const workerPath = join(database.directory, "persistent-fatal-owner-worker.js");
		writeFileSync(
			workerPath,
			[
				'process.stdin.setEncoding("utf8");',
				"const newline = String.fromCharCode(10);",
				'process.stdout.write(JSON.stringify({ type: "ready", pid: process.pid }) + newline);',
				'process.stdin.on("data", (chunk) => {',
				"  for (const line of chunk.split(newline)) {",
				"    if (!line) continue;",
				"    const command = JSON.parse(line);",
				'    if (command.type === "submit") process.stdout.write(JSON.stringify({ type: "fatal", error: { name: "TEST_FATAL", message: "owner fatal" } }) + newline);',
				"  }",
				"});",
			].join(String.fromCharCode(10)),
		);

		const first = await startDbOwnerWithRole(database.path, "generic", { workerPath });
		client = first;
		const firstPid = first.health().pid;
		if (firstPid === null) throw new Error("replacement test owner did not publish a pid");
		await expect(
			first.submit(
				{ kind: "query", statement: { sql: "SELECT 1 AS value", result: "all" } },
				{ operation: "replacement-owner-regression", lane: "read", deadlineMs: 5_000 },
			).result,
		).rejects.toMatchObject({ message: "owner fatal" });
		await waitFor(() => first.health().state === "failed");

		const [replacementA, replacementB] = await Promise.all([
			startDbOwnerWithRole(database.path, "generic", { workerPath }),
			startDbOwnerWithRole(database.path, "generic", { workerPath }),
		]);
		expect(replacementA).toBe(replacementB);
		expect(replacementA.health().state).toBe("ready");
		expect(replacementA.health().pid).not.toBe(firstPid);
		expect(processExists(firstPid)).toBe(false);
	});

	test("rejects when an overridden DB owner startup deadline expires", async () => {
		const database = makeDb();
		directory = database.directory;
		const workerPath = join(database.directory, "delayed-ready-worker.js");
		await Bun.write(
			workerPath,
			'setTimeout(() => process.stdout.write(JSON.stringify({ type: "ready", pid: process.pid }) + "\\n"), 100);',
		);
		const previousTimeout = process.env.SIGNET_DB_OWNER_START_TIMEOUT_MS;
		process.env.SIGNET_DB_OWNER_START_TIMEOUT_MS = "50";
		try {
			client = createDbOwnerClient({ dbPath: database.path, workerPath });
			await expect(client.start()).rejects.toMatchObject({ code: "DB_OWNER_START_TIMEOUT" });
		} finally {
			if (previousTimeout === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_START_TIMEOUT_MS");
			else process.env.SIGNET_DB_OWNER_START_TIMEOUT_MS = previousTimeout;
		}
	});

	test("rejects garbage DB owner startup timeout configuration", async () => {
		const database = makeDb();
		directory = database.directory;
		const previousTimeout = process.env.SIGNET_DB_OWNER_START_TIMEOUT_MS;
		process.env.SIGNET_DB_OWNER_START_TIMEOUT_MS = "abc";
		try {
			client = createDbOwnerClient({ dbPath: database.path });
			await expect(client.start()).rejects.toMatchObject({ code: "DB_OWNER_START_TIMEOUT_INVALID" });
		} finally {
			if (previousTimeout === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_START_TIMEOUT_MS");
			else process.env.SIGNET_DB_OWNER_START_TIMEOUT_MS = previousTimeout;
		}
	});

	test("preserves application error codes across the owner boundary", async () => {
		const database = makeDb();
		directory = database.directory;
		const workerPath = join(database.directory, "serialized-error-worker.js");
		await Bun.write(
			workerPath,
			[
				'process.stdout.write(JSON.stringify({ type: "ready", pid: process.pid }) + "\\n");',
				'let input = "";',
				'process.stdin.setEncoding("utf8");',
				'process.stdin.on("data", (chunk) => {',
				"  input += chunk;",
				'  const lines = input.split("\\n");',
				'  input = lines.pop() || "";',
				"  for (const line of lines) {",
				"    if (!line) continue;",
				"    const command = JSON.parse(line);",
				'    if (command.type === "submit") process.stdout.write(JSON.stringify({ type: "result", jobId: command.job.id, outcome: "failed", error: { name: "MigrationBackupAdmissionError", message: "admission refused", code: "DB_MIGRATION_BACKUP_ADMISSION_FAILED" } }) + "\\n");',
				'    if (command.type === "shutdown") process.exit(0);',
				"  }",
				"});",
			].join("\n"),
		);
		client = createDbOwnerClient({ dbPath: database.path, workerPath });
		await client.start();

		await expect(
			client.submit(
				{ kind: "query", statement: { sql: "SELECT 1 AS value", result: "all" } },
				{ operation: "serialized-application-error", lane: "read", deadlineMs: 1_000 },
			).result,
		).rejects.toMatchObject({ code: "DB_MIGRATION_BACKUP_ADMISSION_FAILED", sqliteCode: undefined });
	});

	test("keeps transport readiness distinct from database initialization", async () => {
		const database = makeMigratedDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		await client.start();
		expect(client.health()).toMatchObject({ state: "ready", initialization: "not_started", databaseReady: false });
		await client.initialize(database.directory);
		expect(client.health()).toMatchObject({ state: "ready", initialization: "ready", databaseReady: true });
	});

	test("detects an owner survivor when harness teardown is skipped", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		await client.start();
		const ownerPid = client.health().pid;
		if (ownerPid === null) throw new Error("owner did not publish a pid");
		// Intentionally skip client.close(): this is the leaked-survivor path.
		client = null;
		try {
			const spawnedPids = new Set([ownerPid]);
			expect(() => assertNoSurvivors(spawnedPids)).toThrow(String(ownerPid));
		} finally {
			if (processExists(ownerPid)) process.kill(ownerPid, "SIGKILL");
			await waitFor(() => !processExists(ownerPid));
		}
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
		await client.start();
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

	test("reserves interactive write capacity while maintenance is saturated", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		const maintenance = client.submit(
			{ kind: "sleep", durationMs: 300 },
			{ operation: "maintenance.saturation", lane: "maintenance", deadlineMs: 2_000 },
		);
		await waitFor(() => client?.health().lanes?.maintenance.activeJobId === maintenance.job.id);
		const startedAt = Date.now();
		const foreground = client.submit<unknown[]>(
			{ kind: "query", statement: { sql: "SELECT 1 AS value", result: "all" } },
			{ operation: "memory.interactive-write", lane: "write", deadlineMs: 1_000 },
		);
		expect(await foreground.result).toEqual([{ value: 1 }]);
		expect(Date.now() - startedAt).toBeLessThan(250);
		expect(client.health().lanes?.maintenance.activeJobId).toBe(maintenance.job.id);
		expect(client.health().lanes?.write.activeJobId).toBeNull();
		await maintenance.result;
	});

	test("serves health, dashboard, recall, and writes during maintenance saturation", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		await client.start();
		const maintenance = client.submit(
			{ kind: "sleep", durationMs: 350 },
			{ operation: "sources.native-sync", lane: "maintenance", deadlineMs: 2_000 },
		);
		await waitFor(() => client?.health().lanes?.maintenance.activeJobId === maintenance.job.id);
		const startedAt = Date.now();
		const health = client.submit<unknown[]>(
			{ kind: "query", statement: { sql: "SELECT 1 AS health", result: "all" } },
			{ operation: "health", lane: "read", deadlineMs: 1_000 },
		);
		const dashboard = client.submit<unknown[]>(
			{ kind: "query", statement: { sql: "SELECT 1 AS dashboard", result: "all" } },
			{ operation: "dashboard", lane: "read", deadlineMs: 1_000 },
		);
		const recall = client.submit<unknown[]>(
			{ kind: "query", statement: { sql: "SELECT 1 AS recall", result: "all" } },
			{ operation: "recall", lane: "read", deadlineMs: 1_000 },
		);
		const write = client.submit<unknown[]>(
			{ kind: "query", statement: { sql: "SELECT 1 AS write", result: "all" } },
			{ operation: "memory.interactive-write", lane: "write", deadlineMs: 1_000 },
		);
		expect(await Promise.all([health.result, dashboard.result, recall.result, write.result])).toEqual([
			[{ health: 1 }],
			[{ dashboard: 1 }],
			[{ recall: 1 }],
			[{ write: 1 }],
		]);
		expect(Date.now() - startedAt).toBeLessThan(500);
		await maintenance.result;
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

	test("abandons a slow recall read without replacing its owner", async () => {
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
		expect(client.health().generation).toBe(1);
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

	test("commits a write query that returns its changed row", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		const update = client.submit<{ readonly id: string; readonly content: string }>(
			{
				kind: "query",
				statement: {
					sql: "UPDATE memories SET content = ? WHERE id = ? RETURNING id, content",
					params: ["updated by owner", "m1"],
					result: "get",
					readonly: false,
				},
			},
			{ operation: "memory.update-returning", lane: "write", deadlineMs: 1_000 },
		);
		expect(await update.result).toEqual({ id: "m1", content: "updated by owner" });
		const rows = await recallThroughDbOwner<{ id: string; content: string }>(
			client,
			"SELECT id, content FROM memories",
		);
		expect(rows).toEqual([{ id: "m1", content: "updated by owner" }]);
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

	test("retires a broken stdin without starving the queue in a retry loop", async () => {
		const database = makeDb();
		directory = database.directory;
		const workerPath = join(database.directory, "broken-stdin-worker.js");
		await Bun.write(
			workerPath,
			'process.stdout.write(JSON.stringify({ type: "ready", pid: process.pid }) + "\\n"); setTimeout(() => process.stdin.destroy(), 25);',
		);
		client = createDbOwnerClient({ dbPath: database.path, workerPath });
		await client.start();
		const handle = client.submit(
			{ kind: "query", statement: { sql: "SELECT 1", result: "all" } },
			{ operation: "transport.retry-guard", lane: "read", deadlineMs: 1_000 },
		);
		await expect(handle.result).rejects.toBeInstanceOf(DbOwnerDiedError);
		expect(client.health().state).toBe("dead");
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

	test("abandons a timed-out maintenance job without killing the owner", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		await client.start();
		const slow = client.submit(
			{ kind: "sleep", durationMs: 250 },
			{ operation: "maintenance.deadline-test", lane: "maintenance", deadlineMs: 40 },
		);
		await expect(slow.result).rejects.toBeInstanceOf(DbOwnerDeadlineError);
		expect(client.health().lanes?.maintenance.pid).not.toBeNull();
		const fast = client.submit<unknown[]>(
			{ kind: "query", statement: { sql: "SELECT 1 AS value", result: "all" } },
			{ operation: "memory.interactive-after-maintenance-timeout", lane: "write", deadlineMs: 1_000 },
		);
		expect(await fast.result).toEqual([{ value: 1 }]);
		expect(client.health().state).toBe("ready");
		await waitFor(() => client?.health().lanes?.maintenance.activeJobId === null);
	});

	test("recovers immediately after a maintenance deadline is abandoned", async () => {
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
		expect(client.health().queuedJobs).toBe(0);
		expect(client.health().activeJobId).toBe(first.job.id);
		await first.result;
		expect(client.health().queuedJobs).toBe(0);
		expect(client.health().activeJobId).toBeNull();
	});

	test("does not commit a stale write after aborting an in-flight owner operation", async () => {
		const database = makeDb();
		directory = database.directory;
		const blocker = new Database(database.path);
		let blockerReleased = false;
		blocker.exec("BEGIN IMMEDIATE");
		client = createDbOwnerClient({ dbPath: database.path });
		try {
			const write = client.submit<{ readonly changes: number }>(
				{
					kind: "query",
					statement: {
						sql: "INSERT INTO memories (id, content) VALUES (?, ?)",
						params: ["stale-after-abort", "must not commit"],
						result: "run",
					},
				},
				{ operation: "memory.stale-commit-after-abort", lane: "write", deadlineMs: 5_000 },
			);
			await waitFor(() => client?.health().lanes?.write.activeJobId === write.job.id);
			client.cancel(write.job.id);
			blocker.exec("ROLLBACK");
			blockerReleased = true;
			await expect(write.result).rejects.toBeInstanceOf(DbOwnerCancelledError);
			const rows = await client.submit<readonly { readonly id: string }[]>(
				{ kind: "query", statement: { sql: "SELECT id FROM memories ORDER BY id", result: "all" } },
				{ operation: "memory.verify-no-stale-commit", lane: "read", deadlineMs: 1_000 },
			).result;
			expect(rows).toEqual([{ id: "m1" }]);
		} finally {
			if (!blockerReleased) blocker.exec("ROLLBACK");
			blocker.close();
		}
	});

	test("reports the durable result when cancellation lands inside SQLite COMMIT", async () => {
		const database = makeDb();
		directory = database.directory;
		const blocker = new Database(database.path);
		blocker.exec("BEGIN");
		blocker.prepare("SELECT id FROM memories").all();
		const commitStarted = join(database.directory, "commit-started");
		const previousCommitMarker = process.env.SIGNET_DB_OWNER_TEST_COMMIT_STARTED;
		process.env.SIGNET_DB_OWNER_TEST_COMMIT_STARTED = commitStarted;
		let blockerReleased = false;
		try {
			client = createDbOwnerClient({ dbPath: database.path });
			await client.start();
			const write = client.submit<{ readonly changes: number }>(
				{
					kind: "query",
					statement: {
						sql: "INSERT INTO memories (id, content) VALUES (?, ?)",
						params: ["commit-window-write", "must commit exactly once"],
						result: "run",
					},
				},
				{ operation: "memory.commit-window-cancel", lane: "write", deadlineMs: 5_000 },
			);
			await waitFor(() => client?.health().lanes?.write.activeJobId === write.job.id);
			await waitFor(() => existsSync(commitStarted));
			client.cancel(write.job.id);
			blocker.exec("ROLLBACK");
			blockerReleased = true;
			await expect(write.result).resolves.toMatchObject({ changes: 1 });
			const rows = await client.submit<readonly { readonly id: string }[]>(
				{ kind: "query", statement: { sql: "SELECT id FROM memories ORDER BY id", result: "all" } },
				{ operation: "memory.verify-commit-window-write", lane: "read", deadlineMs: 1_000 },
			).result;
			expect(rows).toContainEqual({ id: "commit-window-write" });
		} finally {
			if (!blockerReleased) blocker.exec("ROLLBACK");
			blocker.close();
			if (previousCommitMarker === undefined)
				Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_TEST_COMMIT_STARTED");
			else process.env.SIGNET_DB_OWNER_TEST_COMMIT_STARTED = previousCommitMarker;
		}
	});

	test("sweeps stale cancellation registries when a client starts", async () => {
		const database = makeDb();
		directory = database.directory;
		const staleRegistry = join(database.directory, ".db-owner-cancel-stale");
		writeFileSync(staleRegistry, "stale-job\n");
		const staleTime = new Date(Date.now() - DB_OWNER_CANCEL_REGISTRY_MAX_AGE_MS * 2);
		utimesSync(staleRegistry, staleTime, staleTime);
		client = createDbOwnerClient({ dbPath: database.path });
		await client.start();
		expect(existsSync(staleRegistry)).toBe(false);
		expect(readdirSync(database.directory).filter((entry) => entry.startsWith(".db-owner-cancel-")).length).toBe(0);
	});

	test("cleans cancellation registries after owner death before the next client starts", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		const originalClient = client;
		await client.start();
		const first = client.submit(
			{ kind: "sleep", durationMs: 500 },
			{ operation: "maintenance.owner-death-active", lane: "maintenance", deadlineMs: 5_000 },
		);
		const queued = client.submit(
			{ kind: "query", statement: { sql: "SELECT 1", result: "all" } },
			{ operation: "maintenance.owner-death-queued", lane: "maintenance", deadlineMs: 5_000 },
		);
		const firstResult = first.result.catch(() => undefined);
		const queuedResult = queued.result.catch(() => undefined);
		await waitFor(() => client?.health().lanes?.maintenance.activeJobId === first.job.id);
		queued.cancel();
		await queuedResult;
		const ownerPid = client.health().lanes?.maintenance.pid;
		if (ownerPid === null || ownerPid === undefined) throw new Error("maintenance owner did not publish a pid");
		expect(readdirSync(database.directory).filter((entry) => entry.startsWith(".db-owner-cancel-")).length).toBe(1);
		process.kill(ownerPid, "SIGKILL");
		await waitFor(() => !processExists(ownerPid));
		await waitFor(() => client?.health().lanes?.maintenance.state === "dead");
		await firstResult;
		const nextClient = createDbOwnerClient({ dbPath: database.path });
		client = nextClient;
		try {
			await nextClient.start();
			expect(readdirSync(database.directory).filter((entry) => entry.startsWith(".db-owner-cancel-")).length).toBe(0);
		} finally {
			await originalClient.close();
		}
	});

	test("reports completion when cancellation lands during vacuum conversion", async () => {
		const database = makeDb();
		directory = database.directory;
		const activeFile = join(database.directory, "vacuum-conversion-active");
		const previousPause = process.env.SIGNET_TEST_DB_OWNER_VACUUM_PAUSE_MS;
		const previousActiveFile = process.env.SIGNET_TEST_DB_OWNER_VACUUM_ACTIVE_FILE;
		process.env.SIGNET_TEST_DB_OWNER_VACUUM_PAUSE_MS = "250";
		process.env.SIGNET_TEST_DB_OWNER_VACUUM_ACTIVE_FILE = activeFile;
		client = createDbOwnerClient({ dbPath: database.path });
		try {
			await client.start();
			const conversion = client.submit<{ readonly converted: boolean }>(
				{ kind: "vacuum_conversion" },
				{ operation: "maintenance.vacuum-conversion-cancel", lane: "maintenance", deadlineMs: 15 * 60_000 },
			);
			await waitFor(() => client?.health().lanes?.maintenance.activeJobId === conversion.job.id);
			await waitFor(() => existsSync(activeFile));
			client.cancel(conversion.job.id);
			expect(await conversion.result).toEqual({ converted: true });

			const verification = new Database(database.path, { readonly: true });
			expect((verification.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum).toBe(2);
			expect(
				verification
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_signet_vacuum_converted'")
					.get(),
			).toBeDefined();
			verification.close();
		} finally {
			if (previousPause === undefined) Reflect.deleteProperty(process.env, "SIGNET_TEST_DB_OWNER_VACUUM_PAUSE_MS");
			else process.env.SIGNET_TEST_DB_OWNER_VACUUM_PAUSE_MS = previousPause;
			if (previousActiveFile === undefined)
				Reflect.deleteProperty(process.env, "SIGNET_TEST_DB_OWNER_VACUUM_ACTIVE_FILE");
			else process.env.SIGNET_TEST_DB_OWNER_VACUUM_ACTIVE_FILE = previousActiveFile;
		}
	});

	test("does not retain cancellation IDs for completed or active jobs", () => {
		const completedJobs = Array.from({ length: 1_000 }, (_, index) => ({ id: `completed-${index}` }));
		const activeJob = { id: "active" };

		for (const job of completedJobs) {
			expect(shouldRecordDbOwnerCancellation(job.id, null, [], [])).toBe(false);
		}
		expect(shouldRecordDbOwnerCancellation(activeJob.id, activeJob.id, [], [])).toBe(false);
		expect(shouldRecordDbOwnerCancellation("queued", null, [{ ...activeJob, id: "queued" }], [])).toBe(true);
	});

	test("classifies a sources operation as maintenance despite a foreground override", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		registerDbOwnerMaintenance(createDbOwnerMaintenance({ dbPath: database.path, owner: client }));
		const slow = client.submit(
			{ kind: "sleep", durationMs: 250 },
			{ operation: "maintenance.classifier-saturation", lane: "maintenance", deadlineMs: 1_000 },
		);
		await waitFor(() => client?.health().lanes?.maintenance.activeJobId === slow.job.id);

		const query = dbOwnerQuery<readonly { readonly value: number }[]>(
			{ sql: "SELECT 1 AS value", result: "all" },
			{
				operation: "sources.foreground-override",
				lane: "write",
				workloadClass: "foreground",
				deadlineMs: 1_000,
			},
		);
		await waitFor(() => client?.health().lanes?.maintenance.queuedJobs === 1);
		expect(client.health().lanes?.write.queuedJobs).toBe(0);
		await expect(query).resolves.toEqual([{ value: 1 }]);
		await slow.result;
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

	test("preserves the named admission error through production initialize", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		const owner = client;
		if (owner === null) throw new Error("owner client not created");
		const handles: ReturnType<typeof owner.submit>[] = [];
		for (let index = 0; index < MAX_DB_OWNER_PENDING_JOBS; index += 1) {
			handles.push(
				owner.submit(
					{ kind: "sleep", durationMs: 50 },
					{ operation: "maintenance.initialize-admission-test", lane: "maintenance", deadlineMs: 2_000 },
				),
			);
		}

		await expect(owner.initialize(database.directory)).rejects.toBeInstanceOf(DbOwnerAdmissionError);
		for (const handle of handles) handle.cancel();
		await Promise.allSettled(handles.map((handle) => handle.result));
	});

	test("keeps verification jobs usable while application writes are blocked", async () => {
		const database = makeDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		await client.start();
		client.setWriteBlocked(true);

		expect(() =>
			client?.submit(
				{ kind: "query", statement: { sql: "SELECT 1 AS value", result: "get" } },
				{ operation: "application.write-block-test", lane: "maintenance", deadlineMs: 1_000 },
			),
		).toThrow(DbOwnerWritesBlockedError);
		await expect(
			client.submit<{ readonly value: number } | undefined>(
				{ kind: "query", statement: { sql: "SELECT 1 AS value", result: "get", readonly: true } },
				{ operation: "integrity.verify-block-test", lane: "verify", deadlineMs: 1_000 },
			).result,
		).resolves.toEqual({ value: 1 });
	});

	test("carries pending vector backfill state through the initialize protocol", async () => {
		const database = makeMigratedDb();
		directory = database.directory;
		client = createDbOwnerClient({ dbPath: database.path });
		await client.start();

		await expect(client.initialize(database.directory)).resolves.toEqual({
			initialized: true,
			pendingVecBackfill: true,
			extensionPath: findSqliteVecExtension(),
		});
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
