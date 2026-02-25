/**
 * Benchmark: session memory recording hot-path overhead
 *
 * Measures the cost added to handleSessionStart by recording candidates
 * to the session_memories table. This runs in the harness request path
 * so it needs to be fast — any regression here is felt by every session.
 *
 * Run: bun run packages/daemon/src/session-memories.bench.ts
 *
 * Targets:
 *   recordSessionCandidates (30 candidates) < 5ms
 *   recordSessionCandidates (100 candidates) < 15ms
 *   trackFtsHits (10 hits, mixed) < 3ms
 *   Full handleSessionStart overhead < 2ms added
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@signet/core";

const TEST_DIR = join(tmpdir(), `signet-bench-${Date.now()}`);
process.env.SIGNET_PATH = TEST_DIR;

const { initDbAccessor, closeDbAccessor } = await import("./db-accessor");
const { recordSessionCandidates, trackFtsHits } = await import(
	"./session-memories"
);
const { handleSessionStart } = await import("./hooks");

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setupDb(memoryCount: number): void {
	const dbPath = join(TEST_DIR, "memory", "memories.db");
	mkdirSync(join(TEST_DIR, "memory"), { recursive: true });
	if (existsSync(dbPath)) rmSync(dbPath);

	const db = new Database(dbPath);
	db.exec("PRAGMA busy_timeout = 5000");
	runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);

	const now = new Date().toISOString();
	const stmt = db.prepare(
		`INSERT INTO memories
		 (id, type, content, confidence, importance, created_at, updated_at,
		  updated_by, vector_clock, is_deleted)
		 VALUES (?, 'fact', ?, 1.0, ?, ?, ?, 'bench', '{}', 0)`,
	);

	for (let i = 0; i < memoryCount; i++) {
		stmt.run(
			`mem-bench-${String(i).padStart(4, "0")}`,
			`Benchmark memory number ${i}: ${crypto.randomUUID()}`,
			0.3 + Math.random() * 0.7,
			now,
			now,
		);
	}

	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
			content, tags, content=memories, content_rowid=rowid
		)
	`);
	db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");

	db.close();
	closeDbAccessor();
	initDbAccessor(dbPath);
}

function makeCandidates(
	count: number,
): Array<{ id: string; effScore: number; source: "effective" }> {
	return Array.from({ length: count }, (_, i) => ({
		id: `mem-bench-${String(i).padStart(4, "0")}`,
		effScore: 0.9 - i * 0.005,
		source: "effective" as const,
	}));
}

// ---------------------------------------------------------------------------
// Timing harness
// ---------------------------------------------------------------------------

interface BenchResult {
	name: string;
	iterations: number;
	totalMs: number;
	avgMs: number;
	minMs: number;
	maxMs: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
}

function bench(
	name: string,
	fn: () => void,
	iterations: number,
	warmup = 10,
): BenchResult {
	for (let i = 0; i < warmup; i++) fn();

	const times: number[] = [];
	const start = performance.now();

	for (let i = 0; i < iterations; i++) {
		const t0 = performance.now();
		fn();
		times.push(performance.now() - t0);
	}

	const totalMs = performance.now() - start;
	times.sort((a, b) => a - b);

	return {
		name,
		iterations,
		totalMs,
		avgMs: totalMs / iterations,
		minMs: times[0],
		maxMs: times[times.length - 1],
		p50Ms: times[Math.floor(times.length * 0.5)],
		p95Ms: times[Math.floor(times.length * 0.95)],
		p99Ms: times[Math.floor(times.length * 0.99)],
	};
}

function printResult(r: BenchResult): void {
	console.log(`\n  ${r.name}`);
	console.log(`  ${"=".repeat(56)}`);
	console.log(
		`  avg: ${r.avgMs.toFixed(3)}ms | p50: ${r.p50Ms.toFixed(3)}ms | p95: ${r.p95Ms.toFixed(3)}ms | p99: ${r.p99Ms.toFixed(3)}ms`,
	);
	console.log(
		`  min: ${r.minMs.toFixed(3)}ms | max: ${r.maxMs.toFixed(3)}ms | total: ${r.totalMs.toFixed(1)}ms (${r.iterations} iters)`,
	);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log("\n========================================================");
console.log("  Session Memory Recording -- Hot Path Benchmark");
console.log("========================================================");

const ITERS = 200;

// --- recordSessionCandidates: 30 candidates (typical session) ---

setupDb(100);
let sessionCounter = 0;

const r30 = bench(
	"recordSessionCandidates (30 candidates, typical)",
	() => {
		const key = `bench-session-${sessionCounter++}`;
		const candidates = makeCandidates(30);
		const injected = new Set(candidates.slice(0, 15).map((c) => c.id));
		recordSessionCandidates(key, candidates, injected);
	},
	ITERS,
);
printResult(r30);

// --- recordSessionCandidates: 100 candidates (heavy session) ---

closeDbAccessor();
setupDb(200);
sessionCounter = 0;

const r100 = bench(
	"recordSessionCandidates (100 candidates, heavy)",
	() => {
		const key = `bench-heavy-${sessionCounter++}`;
		const candidates = makeCandidates(100);
		const injected = new Set(candidates.slice(0, 30).map((c) => c.id));
		recordSessionCandidates(key, candidates, injected);
	},
	ITERS,
);
printResult(r100);

// --- trackFtsHits: 10 mixed hits ---

closeDbAccessor();
setupDb(100);
sessionCounter = 0;

const preCandidates = makeCandidates(30);
recordSessionCandidates(
	"bench-fts-session",
	preCandidates,
	new Set(preCandidates.slice(0, 15).map((c) => c.id)),
);

const rFts = bench(
	"trackFtsHits (10 mixed: 5 existing + 5 new)",
	() => {
		const existing = preCandidates.slice(0, 5).map((c) => c.id);
		const newOnes = Array.from(
			{ length: 5 },
			(_, i) => `mem-bench-fts-new-${sessionCounter++}-${i}`,
		);
		trackFtsHits("bench-fts-session", [...existing, ...newOnes]);
	},
	ITERS,
);
printResult(rFts);

// --- Full handleSessionStart overhead comparison ---

closeDbAccessor();
setupDb(50);
writeFileSync(join(TEST_DIR, "agent.yaml"), "version: 1\n");

const rBaseline = bench(
	"handleSessionStart (no sessionKey -- baseline)",
	() => {
		handleSessionStart({ harness: "bench" });
	},
	ITERS,
);
printResult(rBaseline);

sessionCounter = 0;
const rWithRecording = bench(
	"handleSessionStart (with sessionKey -- recording active)",
	() => {
		handleSessionStart({
			harness: "bench",
			sessionKey: `bench-full-${sessionCounter++}`,
		});
	},
	ITERS,
);
printResult(rWithRecording);

// --- Interleaved overhead measurement ---

closeDbAccessor();
setupDb(50);
writeFileSync(join(TEST_DIR, "agent.yaml"), "version: 1\n");

const baselineTimes: number[] = [];
const recordingTimes: number[] = [];
sessionCounter = 0;

for (let i = 0; i < 100; i++) {
	const t0 = performance.now();
	handleSessionStart({ harness: "bench" });
	baselineTimes.push(performance.now() - t0);

	const t1 = performance.now();
	handleSessionStart({
		harness: "bench",
		sessionKey: `bench-overhead-${sessionCounter++}`,
	});
	recordingTimes.push(performance.now() - t1);
}

baselineTimes.sort((a, b) => a - b);
recordingTimes.sort((a, b) => a - b);

const baselineP50 = baselineTimes[Math.floor(baselineTimes.length * 0.5)];
const recordingP50 = recordingTimes[Math.floor(recordingTimes.length * 0.5)];
const overheadP50 = recordingP50 - baselineP50;

const baselineP95 = baselineTimes[Math.floor(baselineTimes.length * 0.95)];
const recordingP95 = recordingTimes[Math.floor(recordingTimes.length * 0.95)];
const overheadP95 = recordingP95 - baselineP95;

console.log("\n  Recording overhead (interleaved, 100 pairs)");
console.log(`  ${"=".repeat(56)}`);
console.log(
	`  p50 baseline: ${baselineP50.toFixed(3)}ms | recording: ${recordingP50.toFixed(3)}ms | overhead: ${overheadP50.toFixed(3)}ms`,
);
console.log(
	`  p95 baseline: ${baselineP95.toFixed(3)}ms | recording: ${recordingP95.toFixed(3)}ms | overhead: ${overheadP95.toFixed(3)}ms`,
);

// --- Thresholds ---

const thresholds: Array<{ name: string; actual: number; limit: number }> = [
	{ name: "recordSessionCandidates(30) p95", actual: r30.p95Ms, limit: 5 },
	{ name: "recordSessionCandidates(100) p95", actual: r100.p95Ms, limit: 15 },
	{ name: "trackFtsHits(10 mixed) p95", actual: rFts.p95Ms, limit: 3 },
	{ name: "handleSessionStart overhead p50", actual: overheadP50, limit: 2 },
	{ name: "handleSessionStart overhead p95", actual: overheadP95, limit: 5 },
];

console.log("\n  Thresholds");
console.log(`  ${"=".repeat(56)}`);

let allPassed = true;
for (const t of thresholds) {
	const pass = t.actual <= t.limit;
	if (!pass) allPassed = false;
	const icon = pass ? "PASS" : "FAIL";
	console.log(
		`  [${icon}] ${t.name}: ${t.actual.toFixed(3)}ms (limit: ${t.limit}ms)`,
	);
}

// Cleanup
closeDbAccessor();
if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });

console.log(
	`\n  ${allPassed ? "All thresholds passed." : "THRESHOLD VIOLATIONS DETECTED."}\n`,
);

if (!allPassed) process.exit(1);
