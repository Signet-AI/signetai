/**
 * Regression coverage for #1670 (wedge 1): /api/status transcript capture
 * status and diagnostics duplicate health must read bounded projections
 * (migration 138), never aggregate the payload tables on the HTTP isolate.
 *
 * Each test compares the projection-backed readers against the exact legacy
 * SQL so the response shape and values are provably unchanged, and one test
 * asserts the read path never touches the payload table at all.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { createProviderTracker, getDiagnostics, getDuplicateHealth } from "./diagnostics";
import {
	enqueueTranscriptCaptureJob,
	getTranscriptCaptureStatus,
	runTranscriptCaptureOnce,
	type TranscriptCaptureStatusSummary,
} from "./transcript-capture-worker";

let dir = "";
let prevSignetPath: string | undefined;

/** The exact pre-#1670 status derivation, kept as the oracle for the projection. */
async function legacyStatusOracle(agentId: string | null): Promise<TranscriptCaptureStatusSummary> {
	return getDbAccessor().withReadDbAsync((db) => {
		const where = agentId ? "WHERE agent_id = ?" : "";
		const params = agentId ? [agentId] : [];
		const rows = db
			.prepare(
				`SELECT status, COUNT(*) AS count, MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending
				 FROM transcript_capture_jobs ${where}
				 GROUP BY status`,
			)
			.all(...params) as Array<{ status: string; count: number; oldest_pending?: string | null }>;
		const latestError = db
			.prepare(
				`SELECT error FROM transcript_capture_jobs ${where}${where ? " AND" : "WHERE"} error IS NOT NULL
				 ORDER BY updated_at DESC LIMIT 1`,
			)
			.get(...params) as { error?: string | null } | undefined;
		const summary = {
			pending: 0,
			processing: 0,
			completed: 0,
			failed: 0,
			dead: 0,
			oldestPendingAt: null as string | null,
			lastError: latestError?.error ?? null,
		};
		for (const row of rows) {
			const key = row.status as keyof Pick<
				TranscriptCaptureStatusSummary,
				"pending" | "processing" | "completed" | "failed" | "dead"
			>;
			if (key in summary) summary[key] = row.count;
			if (row.oldest_pending) summary.oldestPendingAt = row.oldest_pending;
		}
		return summary;
	});
}

/** The exact pre-#1670 duplicate derivation. */
async function legacyDuplicateOracle(): Promise<{
	exactDuplicates: number;
	exactClusters: number;
	totalActive: number;
	duplicateRatio: number;
}> {
	return getDbAccessor().withReadDbAsync((db) => {
		const dupRow = db
			.prepare(
				`SELECT
					COALESCE(SUM(excess), 0) AS exact_dupes,
					COUNT(*) AS exact_clusters
				 FROM (
					SELECT content_hash, COUNT(*) - 1 AS excess
					FROM memories
					WHERE is_deleted = 0 AND content_hash IS NOT NULL
					  AND pinned = 0 AND manual_override = 0
					GROUP BY content_hash
					HAVING COUNT(*) > 1
				 )`,
			)
			.get() as { exact_dupes: number; exact_clusters: number } | undefined;
		const totalRow = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE is_deleted = 0").get() as {
			n: number;
		};
		const totalActive = totalRow.n;
		const exactDuplicates = dupRow?.exact_dupes ?? 0;
		const exactClusters = dupRow?.exact_clusters ?? 0;
		return {
			exactDuplicates,
			exactClusters,
			totalActive,
			duplicateRatio: totalActive > 0 ? exactDuplicates / totalActive : 0,
		};
	});
}

interface MemorySeed {
	readonly id: string;
	readonly contentHash: string | null;
	readonly pinned?: number;
	readonly manualOverride?: number;
	readonly isDeleted?: number;
	readonly project?: string;
}

async function seedMemories(seeds: readonly MemorySeed[]): Promise<void> {
	await getDbAccessor().withWriteTxAsync((db) => {
		const insert = db.prepare(
			`INSERT INTO memories
				(id, content, content_hash, pinned, manual_override, is_deleted, type, agent_id,
				 project, scope, visibility, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, 'fact', 'default', ?, 'global', 'global', ?, ?, 'test')`,
		);
		const now = new Date().toISOString();
		for (const seed of seeds) {
			insert.run(
				seed.id,
				`content ${seed.id}`,
				seed.contentHash,
				seed.pinned ?? 0,
				seed.manualOverride ?? 0,
				seed.isDeleted ?? 0,
				seed.project ?? null,
				now,
				now,
			);
		}
	});
}

function enqueue(
	agentId: string,
	sessionId: string,
	capturedAt: string,
	transcript = "User: turn\nAssistant: reply",
): Promise<string | null> {
	return enqueueTranscriptCaptureJob(getDbAccessor(), {
		agentId,
		harness: "pi",
		sessionKey: `session-${sessionId}`,
		sessionId: `snapshot-${sessionId}`,
		project: "/repo",
		transcript,
		rawTranscript: transcript,
		capturedAt,
		endedAt: capturedAt,
	});
}

beforeEach(() => {
	prevSignetPath = process.env.SIGNET_PATH;
	dir = mkdtempSync(join(tmpdir(), "signet-status-projection-"));
	process.env.SIGNET_PATH = dir;
	initDbAccessor(join(dir, "memory", "memories.db"));
});

afterEach(() => {
	closeDbAccessor();
	if (prevSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = prevSignetPath;
	rmSync(dir, { recursive: true, force: true });
});

describe("transcript capture status projection (#1670)", () => {
	it("returns an all-zero summary for an agent with no projection row", async () => {
		expect(await getTranscriptCaptureStatus(getDbAccessor(), "agent-none")).toEqual({
			pending: 0,
			processing: 0,
			completed: 0,
			failed: 0,
			dead: 0,
			oldestPendingAt: null,
			lastError: null,
		});
	});

	it("matches the legacy aggregate across a real enqueue/complete/fail workload", async () => {
		await enqueue("agent-a", "s1", "2026-08-19T10:00:00.000Z");
		await enqueue("agent-a", "s2", "2026-08-19T10:01:00.000Z");
		await enqueue("agent-b", "s3", "2026-08-19T10:02:00.000Z");
		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);
		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);
		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);

		// Terminal transition: agent-b's job exhausts its attempts.
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				"UPDATE transcript_capture_jobs SET status = 'failed', attempts = max_attempts, error = 'boom' WHERE agent_id = 'agent-b'",
			).run();
		});

		for (const agentId of ["agent-a", "agent-b", null]) {
			expect(await getTranscriptCaptureStatus(getDbAccessor(), agentId)).toEqual(await legacyStatusOracle(agentId));
		}
		expect(await getTranscriptCaptureStatus(getDbAccessor(), "agent-a")).toMatchObject({
			completed: 2,
			pending: 0,
			lastError: null,
		});
	});

	it("keeps oldest pending and latest error aligned with the legacy query through state churn", async () => {
		await enqueue("agent-a", "older", "2026-08-19T09:00:00.000Z");
		await enqueue("agent-a", "newer", "2026-08-19T11:00:00.000Z");
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				"UPDATE transcript_capture_jobs SET status = 'failed', error = 'later failure', updated_at = '2026-08-19T12:00:00.000Z' WHERE session_key = 'session-newer'",
			).run();
			db.prepare(
				"UPDATE transcript_capture_jobs SET status = 'failed', error = 'earlier failure', updated_at = '2026-08-19T08:00:00.000Z' WHERE session_key = 'session-older'",
			).run();
		});

		const projected = await getTranscriptCaptureStatus(getDbAccessor(), "agent-a");
		expect(projected).toEqual(await legacyStatusOracle("agent-a"));
		expect(projected.lastError).toBe("later failure");
		expect(projected.oldestPendingAt).toBeNull();

		// Retention-style purge of terminal rows must decrement the projection.
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare("DELETE FROM transcript_capture_jobs WHERE status = 'failed'").run();
		});
		const afterPurge = await getTranscriptCaptureStatus(getDbAccessor(), "agent-a");
		expect(afterPurge).toEqual(await legacyStatusOracle("agent-a"));
		expect(afterPurge).toMatchObject({ failed: 0, lastError: null });
	});

	it("aggregates across agents for the daemon-wide summary", async () => {
		await enqueue("agent-a", "s1", "2026-08-19T10:00:00.000Z");
		await enqueue("agent-b", "s2", "2026-08-19T09:30:00.000Z");
		const projected = await getTranscriptCaptureStatus(getDbAccessor());
		expect(projected).toEqual(await legacyStatusOracle(null));
		expect(projected.pending).toBe(2);
		// enqueue stamps created_at at delivery time; the daemon-wide summary
		// must surface the earliest of those per-agent projection values.
		const earliest = await getDbAccessor().withReadDbAsync((db) =>
			db.prepare("SELECT MIN(created_at) AS oldest FROM transcript_capture_jobs WHERE status = 'pending'").get(),
		);
		expect(projected.oldestPendingAt).toBe((earliest as { oldest: string | null }).oldest);
	});

	it("revives dead jobs through the enqueue upsert without corrupting counters", async () => {
		const input = {
			agentId: "agent-a",
			harness: "pi",
			sessionKey: "session-revive",
			sessionId: "snapshot-revive",
			project: "/repo",
			transcript: "User: revive",
			rawTranscript: "revive",
			capturedAt: "2026-08-19T10:00:00.000Z",
			endedAt: "2026-08-19T10:00:00.000Z",
		} as const;
		const id = await enqueueTranscriptCaptureJob(getDbAccessor(), input);
		expect(id).toBeTruthy();
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				"UPDATE transcript_capture_jobs SET status = 'dead', attempts = max_attempts, error = 'gave up' WHERE id = ?",
			).run(id);
		});
		expect((await getTranscriptCaptureStatus(getDbAccessor(), "agent-a")).dead).toBe(1);
		// The production revive path reuses the same INSERT ... ON CONFLICT.
		expect(await enqueueTranscriptCaptureJob(getDbAccessor(), input)).toBe(id);
		const revived = await getTranscriptCaptureStatus(getDbAccessor(), "agent-a");
		expect(revived).toEqual(await legacyStatusOracle("agent-a"));
		expect(revived).toMatchObject({ dead: 0, pending: 1, lastError: null });
	});

	it("reads no payload column on the status path", async () => {
		await enqueue("agent-a", "s1", "2026-08-19T10:00:00.000Z");
		// Proxy the ReadDb so every executed SQL string is observable. The
		// bounded path must never touch transcript_capture_jobs. Implement both
		// get() and all() so the reverted implementation fails the intentional
		// table-access assertion rather than a mock-shape TypeError.
		let touchedJobsTable = false;
		const sqlRecorder = {
			prepare(sql: string): {
				get(...args: unknown[]): unknown;
				all(...args: unknown[]): unknown[];
			} {
				if (sql.includes("transcript_capture_jobs")) touchedJobsTable = true;
				return { get: () => null, all: () => [] };
			},
		};
		const accessor = getDbAccessor();
		const recordingAccessor = {
			...accessor,
			withReadDbAsync: (fn: (db: unknown) => unknown): Promise<unknown> => Promise.resolve(fn(sqlRecorder)),
		} as unknown as Parameters<typeof getTranscriptCaptureStatus>[0];
		await getTranscriptCaptureStatus(recordingAccessor, "agent-a");
		expect(touchedJobsTable).toBe(false);
	});
});

describe("bounded status and diagnostics scale (#1670)", () => {
	it("keeps the route readers under 50ms with large inline payloads", async () => {
		const accessor = getDbAccessor();
		const rowCount = 2_500;
		const transcriptPayload = "transcript payload ".repeat(512);
		const memoryPayload = "memory payload ".repeat(512);
		await accessor.withWriteTxAsync((db) => {
			const insertJob = db.prepare(
				`INSERT INTO transcript_capture_jobs
					(id, agent_id, harness, session_key, session_id, project, transcript, raw_transcript,
					 captured_at, ended_at, summary_status, status, attempts, max_attempts, created_at, updated_at, error)
				 VALUES (?, 'scale-agent', 'pi', ?, ?, '/scale', ?, ?, ?, ?, 'not_requested', ?, 0, 5, ?, ?, ?)`,
			);
			const insertMemory = db.prepare(
				`INSERT INTO memories
					(id, content, content_hash, pinned, manual_override, is_deleted, type, agent_id,
					 project, scope, visibility, created_at, updated_at, updated_by)
				 VALUES (?, ?, ?, 0, 0, 0, 'fact', 'scale-agent', ?, 'global', 'global', ?, ?, 'test')`,
			);
			for (let index = 0; index < rowCount; index += 1) {
				const timestamp = `2026-08-19T00:${String(index % 60).padStart(2, "0")}:00.000Z`;
				const status = index % 5 === 0 ? "failed" : index % 5 === 1 ? "completed" : "pending";
				insertJob.run(
					`scale-job-${index}`,
					`scale-session-${index}`,
					`scale-snapshot-${index}`,
					transcriptPayload,
					transcriptPayload,
					timestamp,
					timestamp,
					status,
					timestamp,
					timestamp,
					status === "failed" ? `failure-${index}` : null,
				);
				insertMemory.run(
					`scale-memory-${index}`,
					memoryPayload,
					`scale-hash-${index}`,
					`/scale/${index}`,
					timestamp,
					timestamp,
				);
			}
		});

		const median = (values: readonly number[]): number => {
			const sorted = [...values].sort((left, right) => left - right);
			return sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
		};
		const measure = async <T>(operation: () => Promise<T>): Promise<{ value: T; elapsed: number }> => {
			const started = performance.now();
			const value = await operation();
			return { value, elapsed: performance.now() - started };
		};

		// Keep a calibrated copy of the pre-#1670 aggregate in this same
		// payload-heavy database. A timing-only assertion is too weak on a warm
		// CI runner: the legacy scan can happen to finish under 50ms at this
		// scale. The ratio assertion below makes the red/green discriminator
		// explicit while the hard budget still protects the route contract.
		const legacyStatusLatencies: number[] = [];
		const statusLatencies: number[] = [];
		let status = await getTranscriptCaptureStatus(accessor, "scale-agent");
		for (let attempt = 0; attempt < 6; attempt += 1) {
			const legacy = await measure(() => legacyStatusOracle("scale-agent"));
			const projected = await measure(() => getTranscriptCaptureStatus(accessor, "scale-agent"));
			legacyStatusLatencies.push(legacy.elapsed);
			statusLatencies.push(projected.elapsed);
			status = projected.value;
		}
		expect(status.pending).toBe(1_500);
		expect(status.completed).toBe(500);
		expect(status.failed).toBe(500);
		expect(Math.max(...statusLatencies)).toBeLessThan(50);
		expect(median(legacyStatusLatencies)).toBeGreaterThan(median(statusLatencies) * 2);

		const { Hono } = await import("hono");
		const { registerPipelineRoutes } = await import("./routes/pipeline-routes");
		const app = new Hono();
		registerPipelineRoutes(app);
		expect((await app.request("http://localhost/api/status")).status).toBe(200);
		const httpStatusLatencies: number[] = [];
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const started = performance.now();
			expect((await app.request("http://localhost/api/status")).status).toBe(200);
			httpStatusLatencies.push(performance.now() - started);
		}
		expect(Math.max(...httpStatusLatencies)).toBeLessThan(50);

		const legacyDuplicateLatencies: number[] = [];
		const duplicateLatencies: number[] = [];
		for (let attempt = 0; attempt < 6; attempt += 1) {
			const legacy = await measure(legacyDuplicateOracle);
			const projected = await measure(() => accessor.withReadDbAsync((db) => getDuplicateHealth(db)));
			legacyDuplicateLatencies.push(legacy.elapsed);
			duplicateLatencies.push(projected.elapsed);
		}
		expect(median(legacyDuplicateLatencies)).toBeGreaterThan(median(duplicateLatencies) * 2);

		const diagnosticsLatencies: number[] = [];
		let diagnostics = await accessor.withReadDbAsync((db) =>
			getDiagnostics(db, createProviderTracker(), undefined, undefined, { graphEnabled: false }),
		);
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const started = performance.now();
			diagnostics = await accessor.withReadDbAsync((db) =>
				getDiagnostics(db, createProviderTracker(), undefined, undefined, { graphEnabled: false }),
			);
			diagnosticsLatencies.push(performance.now() - started);
		}
		expect(diagnostics.duplicate.totalActive).toBe(rowCount);
		expect(diagnostics.duplicate.exactDuplicates).toBe(0);
		expect(diagnostics.duplicate.exactClusters).toBe(0);
		expect(Math.max(...diagnosticsLatencies)).toBeLessThan(50);
	});
});

describe("duplicate health projection (#1670)", () => {
	it("matches the legacy duplicate aggregate across pin/delete/rehash churn", async () => {
		// Distinct (agent, scope, project) tuples so the unique content-hash
		// index permits duplicate hashes across scope boundaries.
		await seedMemories([
			{ id: "m1", contentHash: "h1", project: "p1" },
			{ id: "m2", contentHash: "h1", project: "p2" },
			{ id: "m3", contentHash: "h1", project: "p3" },
			{ id: "m4", contentHash: "h2", project: "p1" },
			{ id: "m5", contentHash: null, project: "p1" },
			{ id: "m6", contentHash: "h3", pinned: 1, project: "p1" },
			{ id: "m7", contentHash: "h3", project: "p2" },
			{ id: "m8", contentHash: "h4", isDeleted: 1, project: "p1" },
			{ id: "m9", contentHash: "h4", manualOverride: 1, project: "p1" },
			{ id: "m10", contentHash: "h4", project: "p2" },
		]);
		const accessor = getDbAccessor();
		const read = async (): Promise<ReturnType<typeof getDuplicateHealth>> =>
			await accessor.withReadDbAsync((db) => getDuplicateHealth(db));

		const baseline = await read();
		expect(baseline).toMatchObject(await legacyDuplicateOracle());

		// Pin one duplicate: h1 drops from 3 eligible to 2.
		await accessor.withWriteTxAsync((db) => {
			db.prepare("UPDATE memories SET pinned = 1 WHERE id = 'm2'").run();
		});
		expect(await read()).toMatchObject(await legacyDuplicateOracle());

		// Soft-delete another: h1 leaves the duplicate set entirely.
		await accessor.withWriteTxAsync((db) => {
			db.prepare("UPDATE memories SET is_deleted = 1 WHERE id = 'm3'").run();
		});
		expect(await read()).toMatchObject(await legacyDuplicateOracle());

		// Rehash: m1 moves from h1 to h9.
		await accessor.withWriteTxAsync((db) => {
			db.prepare("UPDATE memories SET content_hash = 'h9' WHERE id = 'm1'").run();
		});
		expect(await read()).toMatchObject(await legacyDuplicateOracle());

		// Hard delete (retention purge).
		await accessor.withWriteTxAsync((db) => {
			db.prepare("DELETE FROM memories WHERE id = 'm4'").run();
		});
		expect(await read()).toMatchObject(await legacyDuplicateOracle());

		// New duplicate pair on h5.
		await seedMemories([
			{ id: "m11", contentHash: "h5", project: "p1" },
			{ id: "m12", contentHash: "h5", project: "p2" },
		]);
		const finalHealth = await read();
		const oracle = await legacyDuplicateOracle();
		expect(finalHealth.exactDuplicates).toBe(oracle.exactDuplicates);
		expect(finalHealth.exactClusters).toBe(oracle.exactClusters);
		expect(finalHealth.totalActive).toBe(oracle.totalActive);
		expect(finalHealth.duplicateRatio).toBe(oracle.duplicateRatio);
	});

	it("reads no memories payload row on the duplicate-health path", async () => {
		await seedMemories([
			{ id: "m1", contentHash: "h1", project: "p1" },
			{ id: "m2", contentHash: "h1", project: "p2" },
		]);
		let touchedMemoriesTable = false;
		const sqlRecorder = {
			prepare(sql: string): {
				get(...args: unknown[]): unknown;
				all(...args: unknown[]): unknown[];
			} {
				if (/FROM\s+memories\b/.test(sql) && !sql.includes("memories_")) {
					touchedMemoriesTable = true;
				}
				// Keep both statement methods implemented so reverting the fix
				// reports the forbidden payload-table read, not a fake TypeError.
				return { get: () => ({ totalActive: 0, exactDuplicates: 0, exactClusters: 0 }), all: () => [] };
			},
		};
		getDuplicateHealth(sqlRecorder as unknown as Parameters<typeof getDuplicateHealth>[0]);
		expect(touchedMemoriesTable).toBe(false);
	});
});
