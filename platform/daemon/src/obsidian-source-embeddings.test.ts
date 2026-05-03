import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, getVectorRuntimeStatus, initDbAccessor } from "./db-accessor";
import { type EmbeddingConfig, loadMemoryConfig } from "./memory-config";
import { hybridRecall } from "./memory-search";
import {
	buildObsidianSourceChunks,
	indexObsidianSourceEmbeddings,
	purgeObsidianSourceEmbeddings,
	purgeObsidianSourceFileEmbeddings,
} from "./obsidian-source-embeddings";

const embeddingConfig: EmbeddingConfig = {
	provider: "native",
	model: "test-embedder",
	dimensions: 768,
	base_url: "",
};

function testVector(value: number): number[] {
	return Array.from({ length: embeddingConfig.dimensions }, (_, index) => (index === 0 ? value : 0));
}

describe("Obsidian source embeddings", () => {
	let dir = "";
	let vault = "";
	let prevSignetPath: string | undefined;
	let prevAgentId: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-obsidian-embeddings-"));
		vault = join(dir, "vault");
		mkdirSync(join(dir, "memory"), { recursive: true });
		mkdirSync(join(vault, "literature"), { recursive: true });
		prevSignetPath = process.env.SIGNET_PATH;
		prevAgentId = process.env.SIGNET_AGENT_ID;
		process.env.SIGNET_PATH = dir;
		process.env.SIGNET_AGENT_ID = "obsidian-embedding-agent";
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (prevSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = prevSignetPath;
		if (prevAgentId === undefined) Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		else process.env.SIGNET_AGENT_ID = prevAgentId;
		rmSync(dir, { recursive: true, force: true });
	});

	it("chunks Markdown by heading, embeds source chunks, and preserves vault provenance in embedding rows", async () => {
		const filePath = join(vault, "literature", "source-memory.md");
		const content =
			"---\ntags: [signet]\n---\n# Source Memory\n\nThis section explains that Obsidian vault files remain canonical source truth while Signet indexes addressable chunks for retrieval.\n\nThe second paragraph gives enough detail to become another retrievable chunk with the same heading provenance.\n\n## Chunk Strategy\n\nHeading aware chunks should preserve source_path, vault relative path, heading, and line range so an agent can read back through the canonical note.\n";
		const embeddedTexts: string[] = [];

		const result = await indexObsidianSourceEmbeddings({
			agentId: "obsidian-embedding-agent",
			sourceId: "obsidian:test-vault",
			root: vault,
			filePath,
			content,
			embeddingConfig,
			fetchEmbedding: async (text) => {
				embeddedTexts.push(text);
				return testVector(text.length);
			},
		});

		expect(result.chunks).toBeGreaterThanOrEqual(2);
		expect(result.embedded).toBe(result.chunks);
		expect(embeddedTexts.length).toBe(result.chunks);

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT source_type, source_id, agent_id, dimensions, chunk_text
					 FROM embeddings
					 WHERE source_type = 'source_obsidian_chunk'
					 ORDER BY source_id`,
					)
					.all() as Array<{
					source_type: string;
					source_id: string;
					agent_id: string;
					dimensions: number;
					chunk_text: string;
				}>,
		);

		expect(rows).toHaveLength(result.chunks);
		expect(rows.every((row) => row.source_id.startsWith("obsidian:test-vault:literature/source-memory.md#"))).toBe(
			true,
		);
		expect(rows.every((row) => row.agent_id === "obsidian-embedding-agent")).toBe(true);
		expect(rows.every((row) => row.dimensions === embeddingConfig.dimensions)).toBe(true);
		expect(rows.some((row) => row.chunk_text.includes("source_path: "))).toBe(true);
		expect(rows.every((row) => row.chunk_text.includes(filePath))).toBe(true);
		expect(rows.some((row) => row.chunk_text.includes("heading: Source Memory"))).toBe(true);
		expect(rows.some((row) => row.chunk_text.includes("Chunk Strategy"))).toBe(true);
		expect(rows.every((row) => /lines: \d+-\d+/.test(row.chunk_text))).toBe(true);
	});

	it("keeps chunk IDs distinct for repeated heading paths", () => {
		const filePath = join(vault, "literature", "repeated-headings.md");
		const chunks = buildObsidianSourceChunks({
			sourceId: "obsidian:test-vault",
			root: vault,
			filePath,
			content:
				"# Notes\n\nThe first repeated heading has enough durable source text to become a standalone retrieval chunk.\n\n# Notes\n\nThe second repeated heading has enough durable source text to become a different standalone retrieval chunk.\n",
		});

		expect(chunks).toHaveLength(2);
		expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);
		expect(chunks.every((chunk) => chunk.id.includes("#notes:"))).toBe(true);
	});

	it("purges file chunks without treating wildcard characters in paths as LIKE patterns", async () => {
		const filePath = join(vault, "literature", "note_%A.md");
		const siblingPath = join(vault, "literature", "note_XA.md");
		const content = "# Source\n\nThis source note has enough durable text to create an embedded Obsidian source chunk.";
		await indexObsidianSourceEmbeddings({
			agentId: "obsidian-embedding-agent",
			sourceId: "obsidian:test-vault",
			root: vault,
			filePath,
			content,
			embeddingConfig,
			fetchEmbedding: async () => testVector(1),
		});
		await indexObsidianSourceEmbeddings({
			agentId: "obsidian-embedding-agent",
			sourceId: "obsidian:test-vault",
			root: vault,
			filePath: siblingPath,
			content,
			embeddingConfig,
			fetchEmbedding: async () => testVector(2),
		});

		const purged = purgeObsidianSourceFileEmbeddings({
			agentId: "obsidian-embedding-agent",
			sourceId: "obsidian:test-vault",
			root: vault,
			filePath,
		});

		expect(purged).toBeGreaterThan(0);
		const remaining = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT source_id FROM embeddings WHERE source_type = 'source_obsidian_chunk' ORDER BY source_id")
					.all() as Array<{ source_id: string }>,
		);
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.source_id).toContain("note_XA.md#");
	});

	it("purges stale source chunk embeddings for a disconnected Obsidian source", async () => {
		const filePath = join(vault, "literature", "source-memory.md");
		await indexObsidianSourceEmbeddings({
			agentId: "obsidian-embedding-agent",
			sourceId: "obsidian:test-vault",
			root: vault,
			filePath,
			content:
				"# Source Memory\n\nThis is enough source content to produce a retrievable embedded chunk for purge testing.",
			embeddingConfig,
			fetchEmbedding: async () => testVector(1),
		});

		const purged = purgeObsidianSourceEmbeddings({ sourceId: "obsidian:test-vault" });
		expect(purged).toBeGreaterThan(0);
		const remaining = getDbAccessor().withReadDb(
			(db) =>
				(
					db.prepare("SELECT COUNT(*) AS count FROM embeddings WHERE source_type = 'source_obsidian_chunk'").get() as {
						count: number;
					}
				).count,
		);
		expect(remaining).toBe(0);
	});

	it("mirrors source chunk embeddings into sqlite-vec when the extension is available", async () => {
		const filePath = join(vault, "literature", "source-memory.md");
		await indexObsidianSourceEmbeddings({
			agentId: "obsidian-embedding-agent",
			sourceId: "obsidian:test-vault",
			root: vault,
			filePath,
			content:
				"# Source Memory\n\nThis is enough source content to produce a retrievable embedded chunk with sqlite vector mirroring.",
			embeddingConfig,
			fetchEmbedding: async () => testVector(1),
		});

		const runtime = getVectorRuntimeStatus();
		if (!runtime.extensionLoaded) return;
		const mirroredRows = getDbAccessor().withReadDb(
			(db) => (db.prepare("SELECT COUNT(*) AS count FROM vec_embeddings_rowids").get() as { count: number }).count,
		);
		expect(mirroredRows).toBeGreaterThan(0);
	});

	it("returns source chunk recall hits with canonical source_path", async () => {
		const filePath = join(vault, "literature", "source-memory.md");
		await indexObsidianSourceEmbeddings({
			agentId: "obsidian-embedding-agent",
			sourceId: "obsidian:test-vault",
			root: vault,
			filePath,
			content:
				"# Retrieval Covenant\n\nObsidian chunk recall should surface the canonical source_path and heading provenance for source knowledge bases.",
			embeddingConfig,
			fetchEmbedding: async () => testVector(1),
		});

		const cfg = loadMemoryConfig(dir);
		cfg.embedding.provider = embeddingConfig.provider;
		cfg.embedding.model = embeddingConfig.model;
		cfg.embedding.dimensions = embeddingConfig.dimensions;
		cfg.embedding.base_url = embeddingConfig.base_url;
		cfg.search.min_score = 0;
		cfg.search.rehearsal_enabled = false;
		cfg.pipelineV2.graph.enabled = false;
		cfg.pipelineV2.hints.enabled = false;
		cfg.pipelineV2.reranker.enabled = false;
		const response = await hybridRecall(
			{ query: "canonical source_path heading provenance", limit: 3, agentId: "obsidian-embedding-agent" },
			cfg,
			async () => testVector(1),
		);

		const hit = response.results.find((row) => row.type === "source_obsidian_chunk");
		expect(hit).toBeTruthy();
		expect(hit?.source).toBe("source_obsidian");
		expect(hit?.source_path).toBe(filePath);
		expect(hit?.content).toContain("[Obsidian vault chunk:");
		expect(hit?.content).toContain("heading: Retrieval Covenant");
	});

	it("keeps source chunk recall and scoped purge isolated by agent id", async () => {
		const filePath = join(vault, "literature", "shared-source.md");
		const content =
			"# Shared Source\n\nAgent scoped Obsidian source chunks must not leak across recall boundaries or scoped purge operations.";
		await indexObsidianSourceEmbeddings({
			agentId: "agent-a",
			sourceId: "obsidian:test-vault",
			root: vault,
			filePath,
			content,
			embeddingConfig,
			fetchEmbedding: async () => testVector(1),
		});
		await indexObsidianSourceEmbeddings({
			agentId: "agent-b",
			sourceId: "obsidian:test-vault",
			root: vault,
			filePath,
			content,
			embeddingConfig,
			fetchEmbedding: async () => testVector(1),
		});

		const cfg = loadMemoryConfig(dir);
		cfg.embedding.provider = embeddingConfig.provider;
		cfg.embedding.model = embeddingConfig.model;
		cfg.embedding.dimensions = embeddingConfig.dimensions;
		cfg.embedding.base_url = embeddingConfig.base_url;
		cfg.search.min_score = 0;
		cfg.search.rehearsal_enabled = false;
		cfg.pipelineV2.graph.enabled = false;
		cfg.pipelineV2.hints.enabled = false;
		cfg.pipelineV2.reranker.enabled = false;

		const agentARecall = await hybridRecall(
			{ query: "scoped Obsidian chunks", limit: 3, agentId: "agent-a" },
			cfg,
			async () => testVector(1),
		);
		const hit = agentARecall.results.find((row) => row.type === "source_obsidian_chunk");
		expect(hit).toBeTruthy();
		expect(hit?.content).not.toContain("agent-b");

		const scopedPurged = purgeObsidianSourceEmbeddings({ sourceId: "obsidian:test-vault", agentId: "agent-a" });
		expect(scopedPurged).toBeGreaterThan(0);
		const remaining = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT agent_id, COUNT(*) AS count FROM embeddings
						 WHERE source_type = 'source_obsidian_chunk'
						 GROUP BY agent_id ORDER BY agent_id`,
					)
					.all() as Array<{ agent_id: string; count: number }>,
		);
		expect(remaining).toEqual([{ agent_id: "agent-b", count: 1 }]);
	});
});
