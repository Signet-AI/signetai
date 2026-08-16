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
});
