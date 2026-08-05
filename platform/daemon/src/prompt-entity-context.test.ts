import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor, initDbAccessorAsync } from "./db-accessor";
import type { EmbeddingConfig } from "./memory-config";
import { buildEntityPromptContext, promptPhraseSpan } from "./prompt-entity-context";

let dir = "";
let prev: string | undefined;

const DB_PATH = (): string => join(dir, "memory", "memories.db");

function seedEntityContext(): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entities (
				id, name, canonical_name, entity_type, agent_id, pinned, pinned_at, mentions, created_at, updated_at
			) VALUES (?, ?, ?, 'person', 'default', 1, ?, 50, ?, ?)`,
		).run("ent-nicholai", "Nicholai", "nicholai", now, now, now);

		db.prepare(
			`INSERT INTO entities (
				id, name, canonical_name, entity_type, agent_id, pinned, pinned_at, mentions, created_at, updated_at
			) VALUES (?, ?, ?, 'project', 'default', 0, NULL, 10, ?, ?)`,
		).run("ent-signet", "Signet", "signet", now, now);

		db.prepare(
			`INSERT INTO entity_aspects (
				id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at
			) VALUES (?, ?, 'default', ?, ?, 0.9, ?, ?)`,
		).run("asp-nicholai", "ent-nicholai", "background", "background", now, now);
		db.prepare(
			`INSERT INTO entity_aspects (
				id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at
			) VALUES (?, ?, 'default', ?, ?, 0.9, ?, ?)`,
		).run("asp-signet", "ent-signet", "overview", "overview", now, now);

		for (const memory of [
			{ id: "mem-nicholai", content: "Nicholai prefers source-first engineering" },
			{ id: "mem-signet", content: "Signet is a portable memory layer for AI agents" },
		]) {
			db.prepare(
				`INSERT INTO memories (
					id, content, normalized_content, content_hash, who, project, type,
					agent_id, visibility, created_at, updated_at, updated_by
				) VALUES (?, ?, ?, ?, 'test', 'test', 'fact', 'default', 'private', ?, ?, 'test')`,
			).run(memory.id, memory.content, memory.content.toLowerCase(), `hash-${memory.id}`, now, now);
		}

		db.prepare(
			`INSERT INTO entity_attributes (
				id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
				confidence, importance, status, group_key, claim_key, created_at, updated_at
			) VALUES (?, ?, 'default', ?, 'attribute', ?, ?, 0.9, 0.8, 'active', ?, ?, ?, ?)`,
		).run(
			"attr-nicholai",
			"asp-nicholai",
			"mem-nicholai",
			"Prefers source-first engineering",
			"prefers source-first engineering",
			"background",
			"identity",
			now,
			now,
		);
		db.prepare(
			`INSERT INTO entity_attributes (
				id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
				confidence, importance, status, group_key, claim_key, created_at, updated_at
			) VALUES (?, ?, 'default', ?, 'attribute', ?, ?, 0.9, 0.8, 'active', ?, ?, ?, ?)`,
		).run(
			"attr-signet",
			"asp-signet",
			"mem-signet",
			"Portable memory layer for AI agents",
			"portable memory layer for ai agents",
			"overview",
			"purpose",
			now,
			now,
		);

		for (const [id, sourceId] of [
			["emb-nicholai", "mem-nicholai"],
			["emb-signet", "mem-signet"],
		]) {
			db.prepare(
				`INSERT INTO embeddings (
					id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id
				) VALUES (?, ?, ?, 2, 'memory', ?, ?, ?, 'default')`,
			).run(id, `emb-hash-${id}`, Buffer.from(new Float32Array([0.5, 0.5]).buffer), sourceId, `${id} text`, now);
		}
	});
}

describe("prompt entity context scaling (#1059)", () => {
	beforeAll(async () => {
		prev = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-prompt-entity-context-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: false
`,
		);
		process.env.SIGNET_PATH = dir;
		await initDbAccessorAsync(DB_PATH(), { agentsDir: dir });
	});

	beforeEach(() => {
		closeDbAccessor();
		rmSync(DB_PATH(), { force: true });
		rmSync(`${DB_PATH()}-shm`, { force: true });
		rmSync(`${DB_PATH()}-wal`, { force: true });
		initDbAccessor(DB_PATH(), { agentsDir: dir });
		seedEntityContext();
	});

	afterEach(() => {
		closeDbAccessor();
	});

	afterAll(() => {
		closeDbAccessor();
		if (prev === undefined) {
			process.env.SIGNET_PATH = undefined;
		} else {
			process.env.SIGNET_PATH = prev;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("embeds the shared semantic query once instead of once per matched entity", async () => {
		let embeddingCalls = 0;
		const result = await buildEntityPromptContext({
			userMessage: "Tell me about Nicholai and the Signet project",
			agentId: "default",
			minScore: 0.3,
			injectBudget: 4000,
			memoryDbPath: DB_PATH(),
			fetchEmbedding: async () => {
				embeddingCalls += 1;
				return [0.5, 0.5];
			},
			embedding: { provider: "test", model: "test" } as EmbeddingConfig,
		});

		// Two entities match the prompt, but both are scored against the same
		// query vector. One fetch per entity would double embedding latency on
		// every prompt-submit (#1059).
		expect(embeddingCalls).toBe(1);
		expect(result.engine).toBe("entity-context");
		expect(result.lines.length).toBeGreaterThanOrEqual(2);
		const joined = result.lines.join("\n");
		expect(joined).toContain("Nicholai");
		expect(joined).toContain("Signet");
		expect(result.memoryCount).toBeGreaterThanOrEqual(2);
	});

	describe("promptPhraseSpan matches precomputed prompt terms", () => {
		const promptTerms = ["tell", "me", "about", "nicholai", "and", "the", "signet", "project"];

		it("locates an exact entity phrase", () => {
			expect(promptPhraseSpan(promptTerms, "Nicholai")).toEqual({ start: 3, end: 4 });
			expect(promptPhraseSpan(promptTerms, "Signet")).toEqual({ start: 6, end: 7 });
		});

		it("normalizes possessive forms before matching", () => {
			expect(promptPhraseSpan(promptTerms, "Nicholai's")).toEqual({ start: 3, end: 4 });
		});

		it("matches a pluralized prompt term for a singular phrase", () => {
			expect(promptPhraseSpan(["i", "love", "signets"], "signet")).toEqual({ start: 2, end: 3 });
		});

		it("rejects absent, too-short, and over-long phrases", () => {
			expect(promptPhraseSpan(promptTerms, "zebra")).toBeNull();
			expect(promptPhraseSpan(promptTerms, "ok")).toBeNull();
			expect(promptPhraseSpan(promptTerms, "nicholai and the signet project plus extra")).toBeNull();
		});
	});
});
