import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { createDbOwnerClient } from "./db-owner-client";
import { vectorSearchThroughDbOwner, hybridRecallThroughDbOwner } from "./db-owner-recall";
import { getDbRecallOwner } from "./db-owner-runtime";
import { type ResolvedMemoryConfig, loadMemoryConfig } from "./memory-config";
import { hybridRecall, type RecallResponse } from "./memory-search";

let directory: string | null = null;
let previousSignetPath: string | undefined;
let stopInferenceServer: (() => void) | null = null;

function testConfig(path: string): ResolvedMemoryConfig {
	const raw = loadMemoryConfig(path);
	return {
		...raw,
		embedding: { ...raw.embedding, provider: "none" },
		search: { ...raw.search, rehearsal_enabled: false, min_score: 0 },
		pipelineV2: {
			...raw.pipelineV2,
			graph: { ...raw.pipelineV2.graph, enabled: false },
		},
	};
}

function seedFacts(): void {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memories (
				id, content, type, agent_id, visibility, created_at, updated_at, updated_by
			) VALUES (?, ?, 'fact', 'agent-a', 'global', datetime('now'), datetime('now'), 'test')`,
		).run("owner-fact-a", "owner recall fixture alpha");
		db.prepare(
			`INSERT INTO memories (
				id, content, type, agent_id, visibility, created_at, updated_at, updated_by
			) VALUES (?, ?, 'fact', 'agent-b', 'global', datetime('now'), datetime('now'), 'test')`,
		).run("owner-fact-other-agent", "owner recall fixture alpha");
		db.prepare(
			`INSERT INTO memories (
				id, content, type, agent_id, visibility, created_at, updated_at, updated_by
			) VALUES (?, ?, 'fact', 'agent-a', 'global', datetime('now'), datetime('now'), 'test')`,
		).run("owner-fact-a-second", "owner recall fixture beta");
	});
}

function comparable(response: RecallResponse): unknown {
	return {
		results: response.results,
		query: response.query,
		method: response.method,
		meta: {
			totalReturned: response.meta.totalReturned,
			hasSupplementary: response.meta.hasSupplementary,
			noHits: response.meta.noHits,
		},
	};
}

afterEach(() => {
	stopInferenceServer?.();
	stopInferenceServer = null;
	closeDbAccessor();
	if (directory !== null) rmSync(directory, { recursive: true, force: true });
	directory = null;
	if (previousSignetPath === undefined) process.env.SIGNET_PATH = undefined;
	else process.env.SIGNET_PATH = previousSignetPath;
	previousSignetPath = undefined;
});

describe("DB owner recall lane", () => {
	test("returns the same scoped recall result as the direct pipeline", async () => {
		directory = mkdtempSync(join(tmpdir(), "signet-db-owner-recall-"));
		previousSignetPath = process.env.SIGNET_PATH;
		mkdirSync(join(directory, "memory"), { recursive: true });
		writeFileSync(join(directory, "agent.yaml"), "name: DbOwnerRecallTest\n");
		process.env.SIGNET_PATH = directory;
		const databasePath = join(directory, "memory", "memories.db");
		initDbAccessor(databasePath);
		seedFacts();
		const cfg = testConfig(directory);
		const params = {
			query: "owner recall fixture",
			keywordQuery: "owner recall fixture",
			limit: 5,
			agentId: "agent-a",
			readPolicy: "isolated" as const,
			trackRecallAccess: false,
			claimRecallResults: false,
		};
		const direct = await hybridRecall(params, cfg, async () => null);
		closeDbAccessor();

		const client = createDbOwnerClient({ dbPath: databasePath, workerRole: "recall" });
		try {
			const routed = await hybridRecallThroughDbOwner(client, params, cfg, { queryEmbedding: null });
			expect(comparable(routed)).toEqual(comparable(direct));
			expect(routed.results.map((result) => result.id)).not.toContain("owner-fact-other-agent");
		} finally {
			await client.close();
		}
	});

	test("executes vector scoring in the recall owner lane", async () => {
		directory = mkdtempSync(join(tmpdir(), "signet-db-owner-vector-search-"));
		previousSignetPath = process.env.SIGNET_PATH;
		mkdirSync(join(directory, "memory"), { recursive: true });
		writeFileSync(join(directory, "agent.yaml"), "name: DbOwnerVectorSearchTest\n");
		process.env.SIGNET_PATH = directory;
		const databasePath = join(directory, "memory", "memories.db");
		initDbAccessor(databasePath);
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (id, content, type, agent_id, visibility, created_at, updated_at, updated_by)
				 VALUES (?, ?, 'fact', 'agent-a', 'global', datetime('now'), datetime('now'), 'test')`,
			).run("owner-vector-fact", "owner vector fixture");
			db.prepare(
				"INSERT INTO embeddings (content_hash, source_id, source_type, vector, dimensions, chunk_text, created_at) VALUES (?, ?, 'memory', ?, ?, '', datetime('now'))",
			).run("owner-vector-hash", "owner-vector-fact", new Float32Array([1, 0, 0]), 3);
		});
		closeDbAccessor();

		const client = createDbOwnerClient({ dbPath: databasePath, workerRole: "recall" });
		try {
			const result = await vectorSearchThroughDbOwner(client, [1, 0, 0], { limit: 1, maxScanRows: 10 });
			expect(result.results).toEqual([{ id: "owner-vector-fact", score: 1 }]);
			expect(["complete", "recent-window"]).toContain(result.completeness);
		} finally {
			await client.close();
		}
	});

	test("nested recall-owner vector search does not reject its own isolated request", async () => {
		directory = mkdtempSync(join(tmpdir(), "signet-db-owner-nested-vector-search-"));
		previousSignetPath = process.env.SIGNET_PATH;
		mkdirSync(join(directory, "memory"), { recursive: true });
		writeFileSync(join(directory, "agent.yaml"), "name: DbOwnerNestedVectorSearchTest\n");
		process.env.SIGNET_PATH = directory;
		const databasePath = join(directory, "memory", "memories.db");
		initDbAccessor(databasePath);
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (id, content, type, agent_id, visibility, created_at, updated_at, updated_by)
				 VALUES (?, ?, 'fact', 'agent-a', 'global', datetime('now'), datetime('now'), 'test')`,
			).run("nested-owner-vector-fact", "nested owner vector fixture");
			db.prepare(
				"INSERT INTO embeddings (content_hash, source_id, source_type, vector, dimensions, chunk_text, created_at) VALUES (?, ?, 'memory', ?, ?, '', datetime('now'))",
			).run("nested-owner-vector-hash", "nested-owner-vector-fact", new Float32Array([1, 0, 0]), 3);
		});

		const previousOwnerWorker = process.env.SIGNET_DB_OWNER_WORKER;
		process.env.SIGNET_DB_OWNER_WORKER = "1";
		try {
			const owner = await getDbRecallOwner(databasePath);
			const result = await vectorSearchThroughDbOwner(owner, [1, 0, 0], { limit: 1, maxScanRows: 10 });
			expect(result.results).toEqual([{ id: "nested-owner-vector-fact", score: 1 }]);
		} finally {
			if (previousOwnerWorker === undefined) delete process.env.SIGNET_DB_OWNER_WORKER;
			else process.env.SIGNET_DB_OWNER_WORKER = previousOwnerWorker;
		}
	});

	test("keeps one recall owner across slow extraction reranking", async () => {
		directory = mkdtempSync(join(tmpdir(), "signet-db-owner-reranker-"));
		previousSignetPath = process.env.SIGNET_PATH;
		mkdirSync(join(directory, "memory"), { recursive: true });
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (new URL(request.url).pathname.endsWith("/models")) {
					return new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } });
				}
				const body = await request.json();
				const messages = Array.isArray(body.messages) ? body.messages : [];
				const prompt = messages.at(-1)?.content;
				if (typeof prompt !== "string" || !prompt.includes("You are a reranker.")) {
					return new Response(JSON.stringify({ error: "unexpected prompt" }), { status: 400 });
				}
				await Bun.sleep(1_100);
				const scores = [
					{ id: "owner-fact-a", score: 0.1 },
					{ id: "owner-fact-a-second", score: 0.9 },
				];
				const chunks = [
					`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ scores }) } }] })}\n\n`,
					`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
					"data: [DONE]\n\n",
				];
				return new Response(chunks.join(""), { headers: { "content-type": "text/event-stream" } });
			},
		});
		stopInferenceServer = () => server.stop();
		writeFileSync(
			join(directory, "agent.yaml"),
			`memory:
  pipelineV2:
    reranker:
      enabled: true
      useExtractionModel: true
      topN: 2
      timeoutMs: 2000
inference:
  defaultPolicy: recall
  targets:
    local:
      executor: openai-compatible
      endpoint: http://127.0.0.1:${server.port}/v1
      models:
        default:
          model: test-model
  policies:
    recall:
      mode: strict
      defaultTargets:
        - local/default
  workloads:
    memoryExtraction:
      policy: recall
`,
		);
		process.env.SIGNET_PATH = directory;
		const databasePath = join(directory, "memory", "memories.db");
		initDbAccessor(databasePath);
		seedFacts();
		const cfg = testConfig(directory);
		const reranker = {
			...cfg.pipelineV2.reranker,
			enabled: true,
			useExtractionModel: true,
			topN: 2,
			timeoutMs: 2000,
		};
		const params = {
			query: "owner recall fixture",
			keywordQuery: "owner recall fixture",
			limit: 2,
			agentId: "agent-a",
			readPolicy: "isolated" as const,
			trackRecallAccess: false,
			claimRecallResults: false,
		};
		const client = createDbOwnerClient({ dbPath: databasePath, workerRole: "recall" });
		try {
			const routed = await hybridRecallThroughDbOwner(
				client,
				params,
				{ ...cfg, pipelineV2: { ...cfg.pipelineV2, reranker } },
				{ queryEmbedding: null },
			);
			expect(routed.results.map((result) => result.id)).toEqual(["owner-fact-a-second", "owner-fact-a"]);
			const first = client.health();
			await hybridRecallThroughDbOwner(
				client,
				params,
				{ ...cfg, pipelineV2: { ...cfg.pipelineV2, reranker } },
				{ queryEmbedding: null },
			);
			expect(client.health()).toMatchObject({ state: "ready", generation: first.generation, pid: first.pid });
		} finally {
			await client.close();
		}
	});

	test("fails loudly instead of returning unreranked results when extraction reranking provider fails", async () => {
		directory = mkdtempSync(join(tmpdir(), "signet-db-owner-reranker-failure-"));
		previousSignetPath = process.env.SIGNET_PATH;
		mkdirSync(join(directory, "memory"), { recursive: true });
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname.endsWith("/models")) {
					return new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } });
				}
				return new Response(JSON.stringify({ error: "provider unavailable" }), {
					status: 503,
					headers: { "content-type": "application/json" },
				});
			},
		});
		stopInferenceServer = () => server.stop();
		writeFileSync(
			join(directory, "agent.yaml"),
			`memory:
  pipelineV2:
    reranker:
      enabled: true
      useExtractionModel: true
      topN: 2
      timeoutMs: 2000
inference:
  defaultPolicy: recall
  targets:
    local:
      executor: openai-compatible
      endpoint: http://127.0.0.1:${server.port}/v1
      models:
        default:
          model: test-model
  policies:
    recall:
      mode: strict
      defaultTargets:
        - local/default
  workloads:
    memoryExtraction:
      policy: recall
`,
		);
		process.env.SIGNET_PATH = directory;
		const databasePath = join(directory, "memory", "memories.db");
		initDbAccessor(databasePath);
		seedFacts();
		const cfg = testConfig(directory);
		const reranker = {
			...cfg.pipelineV2.reranker,
			enabled: true,
			useExtractionModel: true,
			topN: 2,
			timeoutMs: 2000,
		};
		const params = {
			query: "owner recall fixture",
			keywordQuery: "owner recall fixture",
			limit: 2,
			agentId: "agent-a",
			readPolicy: "isolated" as const,
			trackRecallAccess: false,
			claimRecallResults: false,
		};
		const client = createDbOwnerClient({ dbPath: databasePath, workerRole: "recall" });
		try {
			let failure: unknown;
			try {
				await hybridRecallThroughDbOwner(
					client,
					params,
					{ ...cfg, pipelineV2: { ...cfg.pipelineV2, reranker } },
					{ queryEmbedding: null },
				);
			} catch (error) {
				failure = error;
			}
			expect(failure).toMatchObject({ causeFamily: "provider_unavailable" });
		} finally {
			await client.close();
		}
	});
});
