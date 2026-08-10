#!/usr/bin/env bun

/**
 * Compare the prompt-submit hot path with and without the low-signal gate.
 *
 * The "before gate" sample uses a substantive prompt and exercises the
 * entity-context recall path. The "after gate" sample uses a greeting and
 * proves that the same hook preserves stable prompt context without embedding
 * work. Both prompt-submit latency and recall-stage timing are reported.
 *
 * Run with:
 *   bun run build:core
 *   bun scripts/bench-prompt-submit.ts
 *
 * Set SIGNET_PROMPT_SUBMIT_BENCH_ITERS or SIGNET_PROMPT_SUBMIT_BENCH_EMBED_MS
 * to adjust sample count or the synthetic embedding delay.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../platform/daemon/src/db-accessor";
import { handleUserPromptSubmit } from "../platform/daemon/src/hooks";
import { loadMemoryConfig } from "../platform/daemon/src/memory-config";
import { buildEntityPromptContext } from "../platform/daemon/src/prompt-entity-context";

const iterations = positiveEnvInt("SIGNET_PROMPT_SUBMIT_BENCH_ITERS", 20);
const embeddingDelayMs = positiveEnvInt("SIGNET_PROMPT_SUBMIT_BENCH_EMBED_MS", 10);
const workspace = mkdtempSync(join(tmpdir(), "signet-prompt-submit-bench-"));
const memoryDir = join(workspace, "memory");
const dbPath = join(memoryDir, "memories.db");
const previousSignetPath = process.env.SIGNET_PATH;

type Stats = {
	readonly avg: number;
	readonly p50: number;
	readonly p95: number;
	readonly min: number;
	readonly max: number;
};

type BenchCase = {
	readonly label: string;
	readonly prompt: string;
	readonly engine: string;
	readonly submit: Stats;
	readonly recall: Stats;
	readonly embeddingCalls: number;
};

function positiveEnvInt(name: string, fallback: number): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stats(values: readonly number[]): Stats {
	const sorted = [...values].sort((a, b) => a - b);
	const sum = sorted.reduce((total, value) => total + value, 0);
	return {
		avg: sum / sorted.length,
		p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
		p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
		min: sorted[0] ?? 0,
		max: sorted[sorted.length - 1] ?? 0,
	};
}

function printStats(label: string, value: Stats): void {
	console.log(
		`${label}: avg ${value.avg.toFixed(2)}ms | p50 ${value.p50.toFixed(2)}ms | p95 ${value.p95.toFixed(2)}ms | min ${value.min.toFixed(2)}ms | max ${value.max.toFixed(2)}ms`,
	);
}

function seedWorkspace(): void {
	mkdirSync(memoryDir, { recursive: true });
	writeFileSync(
		join(workspace, "agent.yaml"),
		[
			"embedding:",
			"  provider: none",
			"  model: bench",
			"  dimensions: 2",
			"memory:",
			"  pipelineV2:",
			"    enabled: false",
			"",
		].join("\n"),
	);
	initDbAccessor(dbPath, { agentsDir: workspace });

	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memories (id, content, type, agent_id, importance, created_at, updated_at, updated_by)
			 VALUES ('bench-memory', 'Signet architecture benchmark context', 'fact', 'default', 0.9, ?, ?, 'bench')`,
		).run(now, now);
		db.prepare(
			`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES ('bench-entity', 'Signet', 'signet', 'project', 'default', 10, ?, ?)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
			 VALUES ('bench-aspect', 'bench-entity', 'default', 'architecture', 'architecture', 0.9, ?, ?)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO entity_attributes
			 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, group_key, claim_key,
			  confidence, importance, status, source_kind, source_id, created_at, updated_at)
			 VALUES ('bench-attribute', 'bench-aspect', 'default', 'bench-memory', 'attribute',
			  'Signet architecture benchmark context', 'signet architecture benchmark context',
			  'runtime', 'architecture', 0.95, 0.9, 'active', 'memory', 'bench-memory', ?, ?)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO embeddings
			 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
			 VALUES ('bench-embedding', 'bench-hash', ?, 2, 'memory', 'bench-memory', ?, ?, 'default')`,
		).run(Buffer.from(new Float32Array([1, 0]).buffer), "Signet architecture benchmark context", now);
	});
}

async function runCase(label: string, prompt: string): Promise<BenchCase> {
	const config = loadMemoryConfig(workspace);
	const submitTimes: number[] = [];
	const recallTimes: number[] = [];
	let embeddingCalls = 0;
	const fetchEmbedding = async (): Promise<number[]> => {
		embeddingCalls++;
		await Bun.sleep(embeddingDelayMs);
		return [1, 0];
	};
	const quietLogger = { debug() {}, info() {}, warn() {}, error() {} } as never;

	for (let i = 0; i < 2; i++) {
		await buildEntityPromptContext({
			userMessage: prompt,
			agentId: "default",
			minScore: 0.8,
			injectBudget: 4000,
			memoryDbPath: dbPath,
			fetchEmbedding,
			embedding: config.embedding,
		});
		await handleUserPromptSubmit({ harness: "bench", userMessage: prompt }, { fetchEmbedding, logger: quietLogger });
	}
	embeddingCalls = 0;

	let engine = "unknown";
	for (let i = 0; i < iterations; i++) {
		const recallStart = performance.now();
		const recall = await buildEntityPromptContext({
			userMessage: prompt,
			agentId: "default",
			minScore: 0.8,
			injectBudget: 4000,
			memoryDbPath: dbPath,
			fetchEmbedding,
			embedding: config.embedding,
		});
		recallTimes.push(performance.now() - recallStart);
		engine = recall.engine;

		const submitStart = performance.now();
		await handleUserPromptSubmit({ harness: "bench", userMessage: prompt }, { fetchEmbedding, logger: quietLogger });
		submitTimes.push(performance.now() - submitStart);
	}

	return {
		label,
		prompt,
		engine,
		submit: stats(submitTimes),
		recall: stats(recallTimes),
		embeddingCalls,
	};
}

function printCase(value: BenchCase): void {
	console.log(`\n${value.label}`);
	console.log(`prompt: ${value.prompt}`);
	console.log(`engine: ${value.engine} | embedding calls: ${value.embeddingCalls}`);
	printStats("prompt-submit latency", value.submit);
	printStats(`recall-stage timing (${value.engine})`, value.recall);
}

async function main(): Promise<void> {
	process.env.SIGNET_PATH = workspace;
	seedWorkspace();
	console.log("Prompt-submit low-signal gate benchmark");
	console.log("=".repeat(64));
	console.log(`iterations: ${iterations} | synthetic embedding delay: ${embeddingDelayMs}ms`);
	console.log("before gate = substantive prompt recall path; after gate = low-signal admission path");

	const beforeGate = await runCase("before gate / substantive", "How should Signet architecture work?");
	const afterGate = await runCase("after gate / low-signal", "hi");
	printCase(beforeGate);
	printCase(afterGate);
}

try {
	await main();
} finally {
	closeDbAccessor();
	if (previousSignetPath === undefined) {
		Reflect.deleteProperty(process.env, "SIGNET_PATH");
	} else {
		process.env.SIGNET_PATH = previousSignetPath;
	}
	rmSync(workspace, { recursive: true, force: true });
}

// The daemon modules may leave optional native/runtime handles alive after
// their one-shot benchmark work. Exit only after the cleanup above completes.
process.exit(0);
