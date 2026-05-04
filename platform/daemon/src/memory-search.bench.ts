/**
 * Benchmark: hybrid recall search latency.
 *
 * Measures the shared hot path used by explicit recall and
 * user-prompt-submit. By default the benchmark uses a synthetic local
 * workspace so it can be run before and after search changes without touching
 * real memory data.
 *
 * Run:
 *   bun run build:core
 *   bun run platform/daemon/src/memory-search.bench.ts
 *
 * Synthetic knobs:
 *   SIGNET_RECALL_BENCH_MEMORIES=2000
 *   SIGNET_RECALL_BENCH_ITERS=60
 *   SIGNET_RECALL_BENCH_EMBED_MS=40
 *
 * Copied real-workspace mode:
 *   SIGNET_RECALL_BENCH_SOURCE_PATH=~/.agents
 *   SIGNET_RECALL_BENCH_QUERY="what do you remember about Signet recall slowness"
 *   SIGNET_RECALL_BENCH_EMBED=real
 *   bun run platform/daemon/src/memory-search.bench.ts
 *
 * The source workspace is copied into /tmp first. The benchmark never opens
 * the live memory database directly.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { fetchEmbedding } from "./embedding-fetch";
import { loadMemoryConfig } from "./memory-config";
import { type RecallStageTiming, hybridRecall } from "./memory-search";

const TEST_DIR = join(tmpdir(), `signet-recall-bench-${Date.now()}`);
const MEMORY_COUNT = parseEnvInt("SIGNET_RECALL_BENCH_MEMORIES", 2000);
const ITERS = parseEnvInt("SIGNET_RECALL_BENCH_ITERS", 60);
const EMBED_MS = parseEnvInt("SIGNET_RECALL_BENCH_EMBED_MS", 40);
const SOURCE_PATH = parsePath(process.env.SIGNET_RECALL_BENCH_SOURCE_PATH);
const QUERY =
	process.env.SIGNET_RECALL_BENCH_QUERY?.trim() ||
	(SOURCE_PATH
		? "what do you remember about Signet memory search performance and recall slowness"
		: "signet memory search performance prompt submit recall");
const EMBED_MODE = process.env.SIGNET_RECALL_BENCH_EMBED === "real" ? "real" : "fake";
let fakeEmbeddingDimensions = 768;

process.env.SIGNET_PATH = TEST_DIR;

function parseEnvInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePath(raw: string | undefined): string | null {
	const path = raw?.trim();
	if (!path) return null;
	return resolve(path.startsWith("~") ? join(homedir(), path.slice(1)) : path);
}

function copyIfExists(from: string, to: string): void {
	if (existsSync(from)) copyFileSync(from, to);
}

function setupWorkspace(): void {
	mkdirSync(join(TEST_DIR, "memory"), { recursive: true });
	if (SOURCE_PATH) {
		const dbPath = join(SOURCE_PATH, "memory", "memories.db");
		const cfgPath = join(SOURCE_PATH, "agent.yaml");
		if (!existsSync(dbPath)) throw new Error(`Source memory DB not found: ${dbPath}`);
		if (!existsSync(cfgPath)) throw new Error(`Source agent.yaml not found: ${cfgPath}`);
		copyFileSync(cfgPath, join(TEST_DIR, "agent.yaml"));
		copyFileSync(dbPath, join(TEST_DIR, "memory", "memories.db"));
		copyIfExists(`${dbPath}-wal`, join(TEST_DIR, "memory", "memories.db-wal"));
		copyIfExists(`${dbPath}-shm`, join(TEST_DIR, "memory", "memories.db-shm"));
		initDbAccessor(join(TEST_DIR, "memory", "memories.db"));
		return;
	}

	writeFileSync(
		join(TEST_DIR, "agent.yaml"),
		[
			"name: RecallBench",
			"search:",
			"  top_k: 20",
			"  min_score: 0.1",
			"embedding:",
			"  provider: none",
			"  model: bench",
			"  dimensions: 768",
			"memory:",
			"  pipelineV2:",
			"    graph:",
			"      enabled: true",
			"    traversal:",
			"      enabled: true",
			"      primary: true",
			"    hints:",
			"      enabled: true",
			"    reranker:",
			"      enabled: true",
			"",
		].join("\n"),
	);

	const dbPath = join(TEST_DIR, "memory", "memories.db");
	if (existsSync(dbPath)) rmSync(dbPath);
	initDbAccessor(dbPath);

	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		const memoryStmt = db.prepare(
			`INSERT INTO memories (
				id, content, type, agent_id, importance, created_at, updated_at, updated_by
			) VALUES (?, ?, 'fact', 'default', ?, ?, ?, 'bench')`,
		);
		const hintStmt = db.prepare(
			`INSERT INTO memory_hints (id, memory_id, agent_id, hint, created_at)
			 VALUES (?, ?, 'default', ?, ?)`,
		);
		const mentionStmt = db.prepare("INSERT INTO memory_entity_mentions (memory_id, entity_id) VALUES (?, ?)");

		db.prepare(
			`INSERT INTO entities (
				id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at
			) VALUES (?, ?, ?, 'project', 'default', ?, ?, ?)`,
		).run("ent-signet", "Signet", "signet", MEMORY_COUNT, now, now);

		for (let i = 0; i < MEMORY_COUNT; i++) {
			const id = `bench-mem-${String(i).padStart(5, "0")}`;
			const topic =
				i % 3 === 0
					? "prompt submit recall latency"
					: i % 3 === 1
						? "memory search performance"
						: "agent context retrieval";
			memoryStmt.run(
				id,
				`Signet ${topic} benchmark memory ${i}. This record keeps recall behavior measurable under lexical, hint, and traversal search.`,
				0.3 + (i % 7) * 0.08,
				now,
				now,
			);
			if (i < 200) {
				hintStmt.run(`hint-${id}`, id, `How fast is Signet ${topic}?`, now);
				mentionStmt.run(id, "ent-signet");
			}
		}
	});
}

async function fakeEmbedding(): Promise<number[]> {
	await Bun.sleep(EMBED_MS);
	return Array.from({ length: fakeEmbeddingDimensions }, (_, index) => (index % 17) / 17);
}

interface Stats {
	readonly avg: number;
	readonly p50: number;
	readonly p95: number;
	readonly min: number;
	readonly max: number;
}

function stats(times: readonly number[]): Stats {
	const sorted = [...times].sort((a, b) => a - b);
	const sum = sorted.reduce((acc, value) => acc + value, 0);
	return {
		avg: sum / sorted.length,
		p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
		p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
		min: sorted[0] ?? 0,
		max: sorted[sorted.length - 1] ?? 0,
	};
}

function printStats(label: string, result: Stats): void {
	console.log(`\n${label}`);
	console.log("=".repeat(64));
	console.log(
		`avg ${result.avg.toFixed(2)}ms | p50 ${result.p50.toFixed(2)}ms | p95 ${result.p95.toFixed(2)}ms | min ${result.min.toFixed(2)}ms | max ${result.max.toFixed(2)}ms`,
	);
}

function summarizeStages(samples: readonly (readonly RecallStageTiming[])[]): RecallStageTiming[] {
	const totals = new Map<string, { total: number; count: number }>();
	for (const sample of samples) {
		for (const stage of sample) {
			const prev = totals.get(stage.name) ?? { total: 0, count: 0 };
			prev.total += stage.durationMs;
			prev.count += 1;
			totals.set(stage.name, prev);
		}
	}
	return [...totals.entries()]
		.map(([name, value]) => ({ name, durationMs: Math.round((value.total / value.count) * 100) / 100 }))
		.sort((a, b) => b.durationMs - a.durationMs);
}

setupWorkspace();
const cfg = loadMemoryConfig(TEST_DIR);
fakeEmbeddingDimensions = cfg.embedding.dimensions;
const params = {
	query: QUERY,
	keywordQuery: QUERY,
	limit: 10,
	agentId: "default",
	readPolicy: "isolated",
} as const;
const embed = EMBED_MODE === "real" ? fetchEmbedding : fakeEmbedding;

console.log("\nHybrid recall latency benchmark");
console.log("=".repeat(64));
console.log(`workspace: ${TEST_DIR}`);
if (SOURCE_PATH) console.log(`source workspace: ${SOURCE_PATH}`);
else console.log(`memories: ${MEMORY_COUNT}`);
console.log(`query: ${QUERY}`);
console.log(`iterations: ${ITERS}`);
console.log(`embedding: ${EMBED_MODE}${EMBED_MODE === "fake" ? ` (${EMBED_MS}ms synthetic delay)` : ""}`);

for (let i = 0; i < 5; i++) {
	await hybridRecall(params, cfg, embed);
}

const times: number[] = [];
const stageSamples: RecallStageTiming[][] = [];
let ids = "";
for (let i = 0; i < ITERS; i++) {
	const start = performance.now();
	const result = await hybridRecall(params, cfg, embed);
	times.push(performance.now() - start);
	stageSamples.push(result.meta.timings.stages);
	if (i === 0) ids = result.results.map((row) => row.id).join(", ");
}

printStats("hybridRecall", stats(times));
console.log(`first result ids: ${ids}`);
console.log("\nSlowest recall stages (avg)");
console.log("=".repeat(64));
for (const stage of summarizeStages(stageSamples).slice(0, 12)) {
	console.log(`${stage.name.padEnd(32)} ${stage.durationMs.toFixed(2)}ms`);
}

closeDbAccessor();
if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
process.exit(0);
