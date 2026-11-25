import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ReadScope, vectorSearchWithMetadata } from "@signet/core";
import { getSyncDbAccessor } from "../legacy-sync/db-accessor-sync";
import { type ReadDb, closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { fetchEmbedding } from "./embedding-fetch";
import { ensureEmbeddingIndexState } from "./embedding-index-state";
import { loadMemoryConfig } from "./memory-config";
import { buildSourceChunkVectorHits, hybridRecall } from "./memory-search";
import { checkNativeProvider, shutdownNativeProvider } from "./native-embedding";

type CoreVectorSearch = (
	db: ReadDb,
	query: Float32Array,
	options: Record<string, unknown>,
) => { readonly results: ReadonlyArray<{ readonly id: string }> };

const FIXTURE_ROWS = 20_000;
const DIMENSIONS = 768;
const QUERIES = [
	"how did we roll back the canary deployment",
	"database transaction isolation for the release pipeline",
	"which project owns the atlas design review",
	"incident notes about the embedding provider outage",
] as const;
const BASES = [
	"Rolled back the canary deployment after error rates rose in the release pipeline.",
	"The release pipeline runs database migrations inside a single transaction.",
	"Atlas design review notes: the project owns the shared component library.",
	"Embedding provider outage caused recall to degrade to keyword search.",
	"Weekly planning meeting moved to Thursday afternoons for the platform team.",
	"Customer asked for an export of their memory data as JSON.",
	"Benchmark results for the vector index after re-embedding the corpus.",
	"Notes on onboarding a new contributor to the daemon codebase.",
] as const;
const OWN: ReadScope = { reach: { kind: "own", agentId: "default" }, compartments: [], projects: null };

function isCoreVectorSearch(value: unknown): value is CoreVectorSearch {
	return typeof value === "function";
}

async function importBaseline(envName: string): Promise<CoreVectorSearch> {
	const path = process.env[envName];
	if (!path) throw new Error(`${envName} must name a baseline core search module`);
	const module: unknown = await import(path);
	const candidate =
		typeof module === "object" && module !== null && "vectorSearchWithMetadata" in module
			? module.vectorSearchWithMetadata
			: undefined;
	if (!isCoreVectorSearch(candidate)) throw new Error(`${path} does not export vectorSearchWithMetadata`);
	return candidate;
}

function positiveInteger(name: string, fallback: number): number {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
	return value;
}

function seededNoise(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296 - 0.5;
	};
}

function normalized(values: Float32Array): Float32Array {
	let norm = 0;
	for (const value of values) norm += value * value;
	const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0;
	return values.map((value) => value * scale);
}

function derivedVector(base: Float32Array, seed: number): Float32Array {
	const noise = seededNoise(seed);
	return normalized(base.map((value) => value + noise() * 0.08));
}

function percentiles(samples: readonly number[]): { readonly p50: number; readonly p95: number } {
	const sorted = [...samples].sort((left, right) => left - right);
	const at = (fraction: number): number =>
		sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
	return { p50: at(0.5), p95: at(0.95) };
}

(process.env.SIGNET_RECALL_BENCHMARK === "1" ? test : test.skip)(
	"measures 20000-row sqlite-vec recall with the real native query embedding provider",
	async () => {
		const modelCache = process.env.SIGNET_RECALL_BENCH_MODEL_CACHE;
		if (!modelCache || !existsSync(modelCache))
			throw new Error("SIGNET_RECALL_BENCH_MODEL_CACHE must name a model cache");
		const oldPostfilter = await importBaseline("SIGNET_RECALL_BENCH_OLD_POSTFILTER_CORE");
		const scopedBeforeReview = await importBaseline("SIGNET_RECALL_BENCH_SCOPED_BEFORE_REVIEW_CORE");
		const finalCore: CoreVectorSearch = (db, query, options) =>
			vectorSearchWithMetadata(db, query, { ...options, readScope: OWN });
		const warmups = positiveInteger("SIGNET_RECALL_BENCH_WARMUPS", 10);
		const samples = positiveInteger("SIGNET_RECALL_BENCH_SAMPLES", 100);
		const coreSamples = positiveInteger("SIGNET_RECALL_BENCH_CORE_SAMPLES", samples);
		const sourceChunks = positiveInteger("SIGNET_RECALL_BENCH_SOURCE_CHUNKS", 2_000);
		const output = process.env.SIGNET_RECALL_BENCH_OUTPUT;
		if (output && existsSync(output)) throw new Error(`${output} already exists`);

		const dir = mkdtempSync(join(tmpdir(), "signet-recall-vector-benchmark-"));
		const previous = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		try {
			mkdirSync(join(dir, "memory"), { recursive: true });
			mkdirSync(join(dir, ".daemon", "logs"), { recursive: true });
			cpSync(modelCache, join(dir, ".models"), { recursive: true });
			writeFileSync(
				join(dir, "agent.yaml"),
				[
					"name: VectorRecallBenchmark",
					"embedding:",
					"  provider: native",
					"  model: nomic-ai/nomic-embed-text-v1.5",
					`  dimensions: ${DIMENSIONS}`,
					"",
				].join("\n"),
			);
			initDbAccessor(join(dir, "memory", "memories.db"));
			const raw = loadMemoryConfig(dir);
			const config = {
				...raw,
				search: { ...raw.search, rehearsal_enabled: false, min_score: 0 },
				pipelineV2: { ...raw.pipelineV2, reranker: { ...raw.pipelineV2.reranker, enabled: false } },
			};
			const provider = await checkNativeProvider();
			expect(provider).toMatchObject({ available: true, dimensions: DIMENSIONS });
			await getDbAccessor().withWriteTxAsync((db) => ensureEmbeddingIndexState(db, config.embedding));

			const embed = async (text: string, role: "query" | "document"): Promise<Float32Array> => {
				const vector = await fetchEmbedding(text, config.embedding, role);
				if (vector?.length !== DIMENSIONS)
					throw new Error(`native provider returned no ${DIMENSIONS}-dimension vector`);
				return new Float32Array(vector);
			};
			const bases: Float32Array[] = [];
			for (const base of BASES) bases.push(await embed(base, "document"));
			const queryVectors: Float32Array[] = [];
			for (const query of QUERIES) queryVectors.push(await embed(query, "query"));

			const seedRows = (offset: number, count: number, sourceType: "memory" | "source_chunk"): void =>
				getSyncDbAccessor().withWriteTx((db) => {
					const memory = db.prepare(
						"INSERT INTO memories(id,content,type,agent_id,created_at,updated_at,updated_by) VALUES (?,?,'fact','default','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z','benchmark')",
					);
					const embedding = db.prepare(
						`INSERT INTO embeddings(id,content_hash,vector,dimensions,source_type,source_id,chunk_text,created_at,agent_id)
						 VALUES (?,?,?,?,?,?,?,'2026-11-01T00:00:00.000Z','default')`,
					);
					const projection = db.prepare("INSERT INTO vec_embeddings(id,embedding) VALUES (?,?)");
					for (let index = offset; index < offset + count; index++) {
						const base = bases[index % bases.length] ?? bases[0];
						const text = `${BASES[index % BASES.length]} Record ${index}.`;
						if (!base) throw new Error("missing provider base vector");
						const vector = derivedVector(base, index + 1);
						const sourceId = sourceType === "memory" ? `bench-${index}` : `obsidian:bench:${index}.md#section:1-1:0`;
						if (sourceType === "memory") memory.run(sourceId, text);
						embedding.run(
							`emb-${index}`,
							`hash-${index}`,
							Buffer.from(vector.buffer),
							DIMENSIONS,
							sourceType,
							sourceId,
							sourceType === "memory" ? text : `source_path: /bench/${index}.md\n${text}`,
						);
						projection.run(`emb-${index}`, vector);
					}
				});
			seedRows(0, FIXTURE_ROWS, "memory");

			const coreCases: ReadonlyArray<readonly [string, CoreVectorSearch]> = [
				["oldPostfilter", oldPostfilter],
				["scopedBeforeReview", (db, query, options) => scopedBeforeReview(db, query, { ...options, readScope: OWN })],
				["finalCore", finalCore],
			];
			const coreDurations = new Map<string, number[]>(coreCases.map(([name]) => [name, []]));
			for (let index = 0; index < warmups + coreSamples; index++) {
				const query = queryVectors[index % queryVectors.length] ?? queryVectors[0];
				if (!query) throw new Error("missing query vector");
				for (const [name, search] of coreCases) {
					const start = performance.now();
					const response = getSyncDbAccessor().withReadDb((db) => search(db, query, { limit: 10 }));
					const elapsed = performance.now() - start;
					expect(response.results.length).toBe(10);
					if (index >= warmups) coreDurations.get(name)?.push(elapsed);
				}
			}

			const recallDurations: number[] = [];
			const sourceStageDurations: number[] = [];
			for (let index = 0; index < warmups + samples; index++) {
				const start = performance.now();
				const response = await hybridRecall(
					{
						query: QUERIES[index % QUERIES.length] ?? QUERIES[0],
						agentId: "default",
						limit: 10,
						readScope: OWN,
						trackRecallAccess: false,
					},
					config,
					fetchEmbedding,
				);
				const elapsed = performance.now() - start;
				expect(response.results.length).toBe(10);
				if (index >= warmups) {
					recallDurations.push(elapsed);
					const sourceStage = response.meta.timings.stages.find((stage) =>
						stage.name.startsWith("source_chunk_vector"),
					);
					if (sourceStage) sourceStageDurations.push(sourceStage.durationMs);
				}
			}

			seedRows(FIXTURE_ROWS, sourceChunks, "source_chunk");
			const sourceDurations: number[] = [];
			let sourceDiagnostics: unknown = null;
			for (let index = 0; index < warmups + coreSamples && sourceChunks > 0; index++) {
				const query = queryVectors[index % queryVectors.length] ?? queryVectors[0];
				if (!query) throw new Error("missing query vector");
				const start = performance.now();
				const outcome = await buildSourceChunkVectorHits(
					query,
					new Set(),
					10,
					"default",
					config.embedding,
					undefined,
					undefined,
					OWN,
				);
				const elapsed = performance.now() - start;
				expect(outcome.hits.length).toBe(10);
				expect(outcome.completeness).toBe("complete");
				sourceDiagnostics = outcome.diagnostics;
				if (index >= warmups) sourceDurations.push(elapsed);
			}

			const report = {
				fixture: {
					rows: FIXTURE_ROWS,
					dimensions: DIMENSIONS,
					vectors: "deterministic noise around native-provider embeddings of 8 base documents",
					sourceChunksAddedAfterRecall: sourceChunks,
				},
				provider: { name: "native", model: "nomic-ai/nomic-embed-text-v1.5", status: provider },
				runtime: `bun ${Bun.version}`,
				warmups,
				samples,
				coreSamples,
				core: Object.fromEntries([...coreDurations].map(([name, values]) => [name, percentiles(values)])),
				hybridRecall: percentiles(recallDurations),
				hybridRecallSourceChunkStageSamples: sourceStageDurations.length,
				sourceChunkVector:
					sourceDurations.length === 0 ? null : { ...percentiles(sourceDurations), diagnostics: sourceDiagnostics },
				durations: {
					core: Object.fromEntries(coreDurations),
					hybridRecall: recallDurations,
					sourceChunkVector: sourceDurations,
				},
			};
			console.log("RECALL_VECTOR_BENCHMARK", JSON.stringify({ ...report, durations: undefined }));
			if (output) writeFileSync(output, JSON.stringify(report, null, 2), { flag: "wx" });
		} finally {
			await shutdownNativeProvider();
			await closeDbAccessor();
			if (previous === undefined) delete process.env.SIGNET_PATH;
			else process.env.SIGNET_PATH = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	},
	1_800_000,
);
