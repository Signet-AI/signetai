import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
		const fast = client.submit<unknown[]>(
			{ kind: "query", statement: { sql: "SELECT 1 AS value", result: "all" } },
			{ operation: "recall.read", lane: "read", deadlineMs: 1_000 },
		);
		expect(await fast.result).toEqual([{ value: 1 }]);
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
			{ operation: "recall.read", lane: "read", deadlineMs: 1_000 },
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
