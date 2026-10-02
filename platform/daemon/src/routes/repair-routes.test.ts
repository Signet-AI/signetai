import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { spawnHidden } from "@signet/core";
import { parseAuthConfig } from "../auth";
import type { DbAccessor, ReadAdmissionOptions, ReadDb, WriteDb } from "../db-accessor";
import { resetPressureState } from "../system-pressure";
import { registerRepairRoutes } from "./repair-routes";

let db: Database;
let accessor: DbAccessor;

function makeAccessor(database: Database): DbAccessor {
	return {
		withReadDb<T>(fn: (readDb: ReadDb) => T): T {
			return fn(database as unknown as ReadDb);
		},
		withReadDbAsync<T>(fn: (readDb: ReadDb) => T | Promise<T>, _options?: ReadAdmissionOptions): Promise<T> {
			return Promise.resolve(fn(database as unknown as ReadDb));
		},
		withWriteTx<T>(fn: (writeDb: WriteDb) => T): T {
			database.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(database as unknown as WriteDb);
				database.exec("COMMIT");
				return result;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
		close(): void {},
	};
}

type RepairRouteDeps = NonNullable<Parameters<typeof registerRepairRoutes>[1]>;

function makeApp(deps: Partial<RepairRouteDeps> = {}): Hono {
	const app = new Hono();
	registerRepairRoutes(app, {
		authConfig: parseAuthConfig(undefined, "/tmp/signet-repair-routes-test"),
		getDbAccessor: () => accessor,
		...deps,
	});
	return app;
}

function requestHeaders(): Record<string, string> {
	return { "Content-Type": "application/json" };
}

function seedRelinkCandidate(): void {
	const now = new Date().toISOString();
	accessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memories (id, content, type, agent_id, created_at, updated_at, updated_by)
			 VALUES (?, ?, 'fact', ?, ?, ?, 'test')`,
		).run("memory-relink", "Nicholai maintains Signet.", "agent-relink", now, now);
		db.prepare(
			`INSERT INTO entities (
				id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at
			) VALUES (?, ?, ?, 'person', ?, 0, ?, ?)`,
		).run("entity-nicholai", "Nicholai", "nicholai", "agent-relink", now, now);
	});
}

function readMutationState(): { mentions: number; entityMentions: number } {
	return accessor.withReadDb((db) => {
		const mentionRow = db.prepare("SELECT COUNT(*) AS count FROM memory_entity_mentions").get() as { count: number };
		const entityRow = db.prepare("SELECT mentions FROM entities WHERE id = ?").get("entity-nicholai") as {
			mentions: number;
		};
		return { mentions: mentionRow.count, entityMentions: entityRow.mentions };
	});
}

beforeEach(() => {
	resetPressureState();
	db = new Database(":memory:");
	db.exec(`
		CREATE TABLE memories (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			type TEXT,
			agent_id TEXT,
			is_deleted INTEGER DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			updated_by TEXT
		);
		CREATE TABLE entities (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			canonical_name TEXT,
			entity_type TEXT,
			agent_id TEXT NOT NULL,
			mentions INTEGER DEFAULT 0,
			pinned INTEGER DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE skill_meta (entity_id TEXT PRIMARY KEY);
		CREATE TABLE generic_entity_prune_scan_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			generation INTEGER NOT NULL DEFAULT 0
		);
		INSERT INTO generic_entity_prune_scan_state (id, generation) VALUES (1, 0);
		CREATE TABLE memory_entity_mentions (
			memory_id TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			mention_text TEXT,
			confidence REAL,
			created_at TEXT,
			PRIMARY KEY (memory_id, entity_id)
		);
	`);
	accessor = makeAccessor(db);
	seedRelinkCandidate();
});

afterEach(() => {
	resetPressureState();
	db.close();
});

describe("POST /api/repair/relink-entities", () => {
	it("previews relinking without persisting mentions when dryRun is true", async () => {
		const before = readMutationState();
		const response = await makeApp().request("/api/repair/relink-entities", {
			method: "POST",
			headers: requestHeaders(),
			body: JSON.stringify({ agentId: "agent-relink", batchSize: 1, dryRun: true }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			action: "relink-entities",
			dryRun: true,
			processed: 1,
			linked: 1,
			entities: 1,
			remaining: 1,
			projectedRemaining: 0,
		});
		expect(readMutationState()).toEqual(before);
	});

	it("still persists the same links when dryRun is false", async () => {
		const response = await makeApp().request("/api/repair/relink-entities", {
			method: "POST",
			headers: requestHeaders(),
			body: JSON.stringify({ agentId: "agent-relink", batchSize: 1, dryRun: false }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			action: "relink-entities",
			dryRun: false,
			processed: 1,
			linked: 1,
			entities: 1,
			remaining: 0,
		});
		expect(readMutationState()).toEqual({ mentions: 1, entityMentions: 1 });
	});
});

describe("POST /api/repair/prune-generic-entities", () => {
	it("forwards limits and a keyset cursor to the bounded scan", async () => {
		const now = new Date().toISOString();
		accessor.withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities (
					id, name, canonical_name, entity_type, agent_id, mentions, pinned, created_at, updated_at
				) VALUES (?, ?, ?, 'project', ?, 1, 0, ?, ?)`,
			).run("entity-prune-cursor", "Project Phoenix", "project phoenix", "agent-relink", now, now);
		});

		const cursor = { updatedAt: "0000-01-01T00:00:00.000Z", id: "zzzz", agentId: "agent-relink", scanGeneration: 0 };
		const response = await makeApp().request("/api/repair/prune-generic-entities", {
			method: "POST",
			headers: requestHeaders(),
			body: JSON.stringify({
				agentId: "agent-relink",
				candidateLimit: 7,
				inspectionLimit: 3,
				cursor,
				dryRun: true,
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			action: "pruneGenericEntities",
			details: {
				candidateLimit: 7,
				inspectionLimit: 3,
				complete: true,
				cursor,
			},
		});
	});
	it("restarts from the beginning for a legacy cursor without a scan generation", async () => {
		const response = await makeApp().request("/api/repair/prune-generic-entities", {
			method: "POST",
			headers: requestHeaders(),
			body: JSON.stringify({
				agentId: "agent-relink",
				candidateLimit: 7,
				inspectionLimit: 3,
				cursor: { updatedAt: "0000-01-01T00:00:00.000Z", id: "zzzz" },
				dryRun: true,
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ action: "pruneGenericEntities", success: true });
	});
});

describe("retired semantic repair routes", () => {
	it("does not expose structural-backfill after the Dreaming cutover", async () => {
		const response = await makeApp().request("/api/repair/structural-backfill", {
			method: "POST",
			headers: requestHeaders(),
		});

		expect(response.status).toBe(404);
	});

	it("does not expose the legacy LLM entity reclassification route", async () => {
		const response = await makeApp().request("/api/repair/reclassify-entities", {
			method: "POST",
			headers: requestHeaders(),
		});

		expect(response.status).toBe(404);
	});
});

describe("POST /api/troubleshoot/exec", () => {
	it("pauses child output for slow consumers and terminates it when the client disconnects", async () => {
		const script = [
			"const chunk = 'x'.repeat(64 * 1024);",
			"(async () => { for (let i = 0; i < 256; i++) if (!process.stdout.write(chunk)) await new Promise((resolve) => process.stdout.once('drain', resolve)); })();",
		].join("\n");
		let child: ReturnType<typeof spawnHidden> | undefined;
		const response = await makeApp({
			resolveExecutable: () => process.execPath,
			spawnCommand: (_command, _args, options) => {
				child = spawnHidden(process.execPath, ["-e", script], options);
				return child;
			},
		}).request("/api/troubleshoot/exec", {
			method: "POST",
			headers: requestHeaders(),
			body: JSON.stringify({ key: "status" }),
		});
		const spawnedChild = child;
		if (!spawnedChild) throw new Error("Troubleshoot route did not spawn a child process");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Troubleshoot response did not expose a stream");

		try {
			const pauseDeadline = Date.now() + 2_000;
			while (!spawnedChild.stdout?.isPaused() && Date.now() < pauseDeadline) {
				await new Promise<void>((resolve) => setTimeout(resolve, 5));
			}
			expect(spawnedChild.stdout?.isPaused()).toBe(true);

			const resumeDeadline = Date.now() + 2_000;
			while (spawnedChild.stdout?.isPaused() && Date.now() < resumeDeadline) {
				const next = await reader.read();
				if (next.done) break;
			}
			expect(spawnedChild.stdout?.isPaused()).toBe(false);

			await reader.cancel("client disconnected");
			if (spawnedChild.exitCode === null && spawnedChild.signalCode === null) {
				await new Promise<void>((resolve, reject) => {
					const timeout = setTimeout(
						() => reject(new Error("Troubleshoot child did not stop after cancellation")),
						2_000,
					);
					spawnedChild.once("close", () => {
						clearTimeout(timeout);
						resolve();
					});
				});
			}
			expect(spawnedChild.exitCode !== null || spawnedChild.signalCode !== null).toBe(true);
			expect(spawnedChild.killed).toBe(true);
		} finally {
			await reader.cancel().catch(() => undefined);
			if (spawnedChild.exitCode === null && !spawnedChild.killed) spawnedChild.kill("SIGTERM");
		}
	});
});

describe("POST /api/repair/re-embed", () => {
	it("rejects a zero batch size before opening the repair database", async () => {
		const response = await makeApp().request("/api/repair/re-embed", {
			method: "POST",
			headers: requestHeaders(),
			body: JSON.stringify({ agentId: "agent-relink", batchSize: 0 }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "batchSize must be a positive integer" });
	});
});
