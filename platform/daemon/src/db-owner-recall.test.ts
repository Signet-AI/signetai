import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { createDbOwnerClient } from "./db-owner-client";
import { hybridRecallThroughDbOwner } from "./db-owner-recall";
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

	test("initializes the owner resolver for configured extraction reranking", async () => {
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
			await expect(
				hybridRecallThroughDbOwner(
					client,
					params,
					{ ...cfg, pipelineV2: { ...cfg.pipelineV2, reranker } },
					{ queryEmbedding: null },
				),
			).rejects.toThrow();
		} finally {
			await client.close();
		}
	});
});
