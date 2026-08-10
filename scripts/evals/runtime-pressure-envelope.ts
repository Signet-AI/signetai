#!/usr/bin/env bun
/**
 * Runtime-pressure liveness/load eval (#1282).
 *
 * Exercises the envelope builder and the heartbeat's bounded queue probe with
 * deterministic synthetic load. It fails if envelope construction or queue
 * observation becomes slow, queue depth escapes its bucket cap, the query plan
 * falls back to a table scan, or pressure data starts carrying forbidden
 * process/user data.
 */

import { Database } from "bun:sqlite";
import { performance } from "node:perf_hooks";
import { runMigrations } from "../../platform/core/src/migrations";
import type { ReadDb } from "../../platform/daemon/src/db-accessor";
import { getQueuePressureSnapshot } from "../../platform/daemon/src/diagnostics-queue";
import {
	buildRuntimePressureEnvelope,
	getRuntimePressureEnvelope,
	setRuntimePressureEnvelope,
} from "../../platform/daemon/src/runtime-pressure";

const SAMPLE_COUNT = 2_000;
const QUEUE_SAMPLE_COUNT = 100;
const QUEUE_ROWS_PER_SOURCE = 50_000;
const MAX_P95_BUILD_MS = 1;
const MAX_P95_QUEUE_SNAPSHOT_MS = 50;
const FORBIDDEN_KEYS = ["pid", "path", "source", "stack", "payload", "processId"];

function percentile(values: readonly number[], ratio: number): number {
	const ordered = [...values].sort((left, right) => left - right);
	const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1);
	return ordered[Math.max(0, index)] ?? 0;
}

function makePressureDb(): Database {
	const db = new Database(":memory:");
	db.exec("PRAGMA journal_mode = WAL");
	runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);

	const memoryJob = db.prepare(
		`INSERT INTO memory_jobs
			(id, memory_id, job_type, status, created_at, updated_at)
			VALUES (?, NULL, 'document_ingest', 'pending', ?, ?)`,
	);
	const summaryJob = db.prepare(
		`INSERT INTO summary_jobs
			(id, harness, transcript, status, created_at)
			VALUES (?, 'eval', 'bounded-pressure-fixture', 'pending', ?)`,
	);
	const now = Date.now();
	db.exec("BEGIN");
	for (let index = 0; index < QUEUE_ROWS_PER_SOURCE; index += 1) {
		const createdAt = new Date(now - (index % 10_000) * 1_000).toISOString();
		memoryJob.run(`memory-pressure-${index}`, createdAt, createdAt);
		summaryJob.run(`summary-pressure-${index}`, createdAt);
	}
	db.exec("COMMIT");
	return db;
}

function planDetails(db: Database, sql: string): readonly string[] {
	const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as unknown as ReadonlyArray<{ readonly detail: string }>;
	return rows.map((row) => row.detail);
}

const durations: number[] = [];
let lastEnvelope = buildRuntimePressureEnvelope();
for (let index = 0; index < SAMPLE_COUNT; index += 1) {
	const startedAt = performance.now();
	lastEnvelope = buildRuntimePressureEnvelope({
		memoryQueueDepth: index % 1_001,
		summaryQueueDepth: (index * 3) % 257,
		oldestJobAgeSec: index % 1_200,
		activeWorkers: index % 17,
		batchSize: 8,
		memoryRssMb: 512,
		cpuPercent: 42,
		recoveryOutcome: index % 2 === 0 ? "still_degraded" : "recovered",
	});
	durations.push(performance.now() - startedAt);
}

setRuntimePressureEnvelope(lastEnvelope);
const cached = getRuntimePressureEnvelope();
const keys = Object.keys(cached);
const forbidden = keys.filter((key) => FORBIDDEN_KEYS.some((term) => key.toLowerCase().includes(term.toLowerCase())));

const pressureDb = makePressureDb();
const queueDurations: number[] = [];
let lastQueueSnapshot = getQueuePressureSnapshot(pressureDb as unknown as ReadDb);
for (let index = 0; index < QUEUE_SAMPLE_COUNT; index += 1) {
	const startedAt = performance.now();
	lastQueueSnapshot = getQueuePressureSnapshot(pressureDb as unknown as ReadDb);
	queueDurations.push(performance.now() - startedAt);
}
const memoryStatusPlan = planDetails(
	pressureDb,
	`SELECT 1 FROM memory_jobs INDEXED BY idx_memory_jobs_pressure_status
	 WHERE status IN ('pending', 'leased') AND job_type <> 'extract' LIMIT 1001`,
);
const memoryCreatedPlan = planDetails(
	pressureDb,
	`SELECT created_at FROM memory_jobs INDEXED BY idx_memory_jobs_pressure_created_at
	 WHERE status IN ('pending', 'leased') AND job_type <> 'extract'
	 ORDER BY created_at ASC LIMIT 1`,
);
const summaryStatusPlan = planDetails(
	pressureDb,
	`SELECT 1 FROM summary_jobs INDEXED BY idx_summary_jobs_pressure_status
	 WHERE status IN ('pending', 'leased') LIMIT 1001`,
);
const summaryCreatedPlan = planDetails(
	pressureDb,
	`SELECT created_at FROM summary_jobs INDEXED BY idx_summary_jobs_pressure_created_at
	 WHERE status IN ('pending', 'leased')
	 ORDER BY created_at ASC LIMIT 1`,
);
pressureDb.close();

const queuePlan = [...memoryStatusPlan, ...memoryCreatedPlan, ...summaryStatusPlan, ...summaryCreatedPlan];
const unindexedPlans = queuePlan.filter((detail) => !detail.includes("USING") || !detail.includes("INDEX"));
const queueSnapshotBounded =
	lastQueueSnapshot.memoryQueueDepth === 1_001 &&
	lastQueueSnapshot.summaryQueueDepth === 1_001 &&
	lastQueueSnapshot.oldestJobAgeSec !== undefined;
const buildP95Ms = percentile(durations, 0.95);
const queueP95Ms = percentile(queueDurations, 0.95);
const report = {
	verdict:
		cached.runtimePressureVersion === 1 &&
		forbidden.length === 0 &&
		buildP95Ms <= MAX_P95_BUILD_MS &&
		queueSnapshotBounded &&
		unindexedPlans.length === 0 &&
		queueP95Ms <= MAX_P95_QUEUE_SNAPSHOT_MS
			? "pass"
			: "fail",
	samples: SAMPLE_COUNT,
	queueSamples: QUEUE_SAMPLE_COUNT,
	queueRowsPerSource: QUEUE_ROWS_PER_SOURCE,
	keyCount: keys.length,
	p95BuildMs: Number(buildP95Ms.toFixed(3)),
	maxP95BuildMs: MAX_P95_BUILD_MS,
	p95QueueSnapshotMs: Number(queueP95Ms.toFixed(3)),
	maxP95QueueSnapshotMs: MAX_P95_QUEUE_SNAPSHOT_MS,
	queueDepthCaps: {
		memory: lastQueueSnapshot.memoryQueueDepth,
		summary: lastQueueSnapshot.summaryQueueDepth,
	},
	queuePlan,
	unindexedPlans,
	forbiddenKeys: forbidden,
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.verdict === "pass" ? 0 : 1);
