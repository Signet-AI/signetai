import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { type ResolvedMemoryConfig, loadMemoryConfig } from "./memory-config";
import { indexExternalMemoryArtifact } from "./memory-lineage";
import { buildAgentScopeClause, expandRecallKeywordQuery, hybridRecall, transcriptExcerpt } from "./memory-search";

describe("hybridRecall", () => {
	let dir = "";
	let prevSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-memory-search-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(join(dir, "agent.yaml"), "name: SearchTest\n");
		prevSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (prevSignetPath === undefined) {
			process.env.SIGNET_PATH = undefined;
		} else {
			process.env.SIGNET_PATH = prevSignetPath;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	function testCfg(
		opts: {
			graph?: boolean;
			traversal?: boolean;
			traversalPrimary?: boolean;
			reranker?: boolean;
			rerankerTopN?: number;
		} = {},
	): ResolvedMemoryConfig {
		const raw = loadMemoryConfig(dir);
		const trav = raw.pipelineV2.traversal;
		return {
			...raw,
			search: { ...raw.search, rehearsal_enabled: false, min_score: 0 },
			pipelineV2: {
				...raw.pipelineV2,
				graph: { ...raw.pipelineV2.graph, enabled: opts.graph ?? false },
				traversal: trav
					? {
							...trav,
							enabled: opts.traversal ?? false,
							primary: opts.traversalPrimary ?? trav.primary,
						}
					: undefined,
				reranker: {
					...raw.pipelineV2.reranker,
					enabled: opts.reranker ?? false,
					topN: opts.rerankerTopN ?? raw.pipelineV2.reranker.topN,
				},
			},
		};
	}

	function vectorBlob(values: readonly number[]): Buffer {
		return Buffer.from(new Float32Array(values).buffer);
	}

	function unitVector(): number[] {
		return Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0));
	}

	it("keeps expanded transcript sources scoped to the requesting agent", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, source_id, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', ?, ?, ?, ?, 'test')`,
			).run("mem-a", "alpha retrieval context", "sess-shared", "agent-a", now, now);

			db.prepare(
				`INSERT INTO session_transcripts (
					session_key, content, harness, project, agent_id, created_at, updated_at
				) VALUES (?, ?, 'codex', ?, ?, ?, ?)`,
			).run("sess-shared", "agent-a transcript context", "proj-a", "agent-a", now, now);

			db.prepare(
				`INSERT INTO session_transcripts (
					session_key, content, harness, project, agent_id, created_at, updated_at
				) VALUES (?, ?, 'codex', ?, ?, ?, ?)`,
			).run("sess-shared", "agent-b transcript context", "proj-b", "agent-b", now, now);
		});

		const result = await hybridRecall(
			{
				query: "alpha retrieval context",
				keywordQuery: "alpha retrieval context",
				limit: 5,
				agentId: "agent-a",
				readPolicy: "isolated",
				expand: true,
			},
			loadMemoryConfig(dir),
			async () => null,
		);

		expect(result.results.map((row) => row.id)).toContain("mem-a");
		expect(result.results.find((row) => row.id === "mem-a")?.content).toStartWith("[Transcript excerpt]");
		expect(result.sources).toBeDefined();
		expect(result.sources?.["sess-shared"]).toBe("agent-a transcript context");
		expect(Object.values(result.sources ?? {})).not.toContain("agent-b transcript context");
		expect(result.meta.totalReturned).toBe(result.results.length);
		expect(result.meta.noHits).toBe(false);
	});

	it("returns no-hit metadata when recall finds nothing", async () => {
		const result = await hybridRecall(
			{
				query: "nothing to see here",
				keywordQuery: "nothing to see here",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			async () => null,
		);

		expect(result.results).toEqual([]);
		expect(result.meta).toMatchObject({
			totalReturned: 0,
			hasSupplementary: false,
			noHits: true,
		});
		expect(result.meta.timings.totalMs).toBeGreaterThanOrEqual(0);
		expect(result.meta.timings.stages.map((stage) => stage.name)).toEqual(
			expect.arrayContaining([
				"memory_fts",
				"hints_fts",
				"query_embedding_wait",
				"flat_score_merge",
				"final_rank",
				"source_chunk_vector_fallback",
				"native_artifact_fallback",
				"transcript_fallback",
			]),
		);
		for (const stage of result.meta.timings.stages) {
			expect(stage.durationMs).toBeGreaterThanOrEqual(0);
		}
	});

	it("skips source chunk vector fallback for project-scoped recall", async () => {
		const now = new Date().toISOString();
		const vec = unitVector();
		getDbAccessor().withWriteTx((db) => {
			const artifact = db.prepare(
				`INSERT INTO memory_artifacts (
					agent_id, source_path, source_sha256, source_kind, session_id,
					session_token, project, harness, captured_at, content, updated_at
				) VALUES (
					'default', ?, ?, 'source_obsidian_markdown', ?, ?, ?, 'obsidian', ?, ?, ?
				)`,
			);
			artifact.run(
				"/workspace/project-a/source-a.md",
				createHash("sha256").update("project-a").digest("hex"),
				"source-a",
				"token-a",
				"/workspace/project-a",
				now,
				"project-a source artifact",
				now,
			);
			artifact.run(
				"/workspace/project-b/source-b.md",
				createHash("sha256").update("project-b").digest("hex"),
				"source-b",
				"token-b",
				"/workspace/project-b",
				now,
				"project-b source artifact",
				now,
			);

			const embedding = db.prepare(
				`INSERT INTO embeddings (
					id, content_hash, vector, dimensions, source_type, source_id,
					chunk_text, created_at, agent_id
				) VALUES (?, ?, ?, 768, 'source_obsidian_chunk', ?, ?, ?, 'default')`,
			);
			embedding.run(
				"emb-source-a",
				"hash-source-a",
				vectorBlob(vec),
				"obsidian:vault-a:source-a.md#overview:1-1:0",
				"source_path: /workspace/project-a/source-a.md\nproject-a private source chunk",
				now,
			);
			embedding.run(
				"emb-source-b",
				"hash-source-b",
				vectorBlob(vec),
				"obsidian:vault-b:source-b.md#overview:1-1:0",
				"source_path: /workspace/project-a/source-a.md\nproject-b spoofed source chunk",
				now,
			);
		});

		const result = await hybridRecall(
			{
				query: "private source chunk",
				keywordQuery: "private source chunk",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
				project: "/workspace/project-a",
			},
			testCfg(),
			async () => vec,
		);

		expect(result.results).toEqual([]);
		expect(result.meta.noHits).toBe(true);
	});

	it("drops ambiguous source chunk vector matches for project-scoped recall", async () => {
		const now = new Date().toISOString();
		const vec = unitVector();
		getDbAccessor().withWriteTx((db) => {
			const artifact = db.prepare(
				`INSERT INTO memory_artifacts (
					agent_id, source_path, source_sha256, source_kind, session_id,
					session_token, project, harness, captured_at, content, updated_at
				) VALUES (
					'default', ?, ?, 'source_obsidian_markdown', ?, ?, ?, 'obsidian', ?, ?, ?
				)`,
			);
			artifact.run(
				"/workspace/project-a/shared.md",
				createHash("sha256").update("shared-a").digest("hex"),
				"shared-a",
				"shared-token-a",
				"/workspace/project-a",
				now,
				"project-a shared artifact",
				now,
			);
			artifact.run(
				"/workspace/project-b/shared.md",
				createHash("sha256").update("shared-b").digest("hex"),
				"shared-b",
				"shared-token-b",
				"/workspace/project-b",
				now,
				"project-b shared artifact",
				now,
			);

			db.prepare(
				`INSERT INTO embeddings (
					id, content_hash, vector, dimensions, source_type, source_id,
					chunk_text, created_at, agent_id
				) VALUES (?, ?, ?, 768, 'source_obsidian_chunk', ?, ?, ?, 'default')`,
			).run(
				"emb-shared-b",
				"hash-shared-b",
				vectorBlob(vec),
				"obsidian:vault-b:shared.md#overview:1-1:0",
				"source_path: /workspace/project-a/shared.md\nambiguous project-b spoofed chunk marker",
				now,
			);
		});

		const result = await hybridRecall(
			{
				query: "ambiguous project-b spoofed chunk marker",
				keywordQuery: "ambiguous project-b spoofed chunk marker",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
				project: "/workspace/project-a",
			},
			testCfg(),
			async () => vec,
		);

		expect(result.results).toEqual([]);
		expect(result.meta.noHits).toBe(true);
	});

	it("falls back to keyword recall when embedding throws synchronously", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
			).run("mem-keyword-sync-throw", "keyword-only recall survives embedding failure", now, now);
		});

		const result = await hybridRecall(
			{
				query: "keyword-only recall",
				keywordQuery: "keyword-only recall",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			() => {
				throw new Error("embedding unavailable");
			},
		);

		expect(result.results.map((row) => row.id)).toContain("mem-keyword-sync-throw");
	});

	it("falls back to keyword recall when embedding rejects before the delayed wait", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const now = new Date().toISOString();
			getDbAccessor().withWriteTx((db) => {
				db.prepare(
					`INSERT INTO memories (
						id, content, type, agent_id, created_at, updated_at, updated_by
					) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
				).run("mem-keyword-async-reject", "keyword recall survives fast async embedding rejection", now, now);
			});

			const result = await hybridRecall(
				{
					query: "keyword recall fast async rejection",
					keywordQuery: "keyword recall fast async rejection",
					limit: 5,
					agentId: "default",
					readPolicy: "isolated",
				},
				loadMemoryConfig(dir),
				() => Promise.reject(new Error("embedding unavailable")),
			);
			await Bun.sleep(0);

			expect(result.results.map((row) => row.id)).toContain("mem-keyword-async-reject");
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("excludes soft-deleted memories from BM25/FTS keyword recall", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by, is_deleted
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test', 1)`,
			).run("mem-bm25-deleted", "bm25-deleted-marker should not surface", now, now);
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
			).run("mem-bm25-live", "bm25-live-marker should surface", now, now);
		});

		const result = await hybridRecall(
			{
				query: "bm25-deleted-marker",
				keywordQuery: "bm25-deleted-marker",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			() => {
				throw new Error("embedding unavailable");
			},
		);

		expect(result.results.map((row) => row.id)).not.toContain("mem-bm25-deleted");
	});

	it("keeps hint recall scoped to live memories for the requesting agent", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by, is_deleted
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test', 1)`,
			).run("mem-hint-deleted", "deleted hint target has unrelated body", now, now);
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'agent-b', ?, ?, 'test')`,
			).run("mem-hint-other-agent", "other agent hint target has unrelated body", now, now);
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
			).run("mem-hint-live", "live hint target has unrelated body", now, now);
			const stmt = db.prepare(
				`INSERT INTO memory_hints (id, memory_id, agent_id, hint, created_at)
				 VALUES (?, ?, ?, ?, ?)`,
			);
			stmt.run("hint-deleted", "mem-hint-deleted", "default", "hint-scope-marker", now);
			stmt.run("hint-other-agent", "mem-hint-other-agent", "agent-b", "hint-scope-marker", now);
			stmt.run("hint-live", "mem-hint-live", "default", "hint-scope-marker", now);
		});

		const result = await hybridRecall(
			{
				query: "hint-scope-marker",
				keywordQuery: "hint-scope-marker",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			async () => null,
		);

		expect(result.results.map((row) => row.id)).toEqual(["mem-hint-live"]);
	});

	it("defaults agent searches without readPolicy to isolated access", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', ?, ?, ?, 'test')`,
			).run("mem-agent-a", "agent-isolation-marker recall content", "agent-a", now, now);
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', ?, ?, ?, 'test')`,
			).run("mem-agent-b", "agent-isolation-marker recall content", "agent-b", now, now);
		});

		const result = await hybridRecall(
			{
				query: "agent-isolation-marker",
				keywordQuery: "agent-isolation-marker",
				limit: 5,
				agentId: "agent-a",
			},
			loadMemoryConfig(dir),
			async () => null,
		);

		expect(result.results.map((row) => row.id)).toEqual(["mem-agent-a"]);
		const counts = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT id, access_count FROM memories WHERE id IN ('mem-agent-a', 'mem-agent-b') ORDER BY id")
					.all() as Array<{ id: string; access_count: number }>,
		);
		expect(counts).toEqual([
			{ id: "mem-agent-a", access_count: 1 },
			{ id: "mem-agent-b", access_count: 0 },
		]);
	});

	it("recalls indexed native harness memory artifacts without materializing memories", async () => {
		const codexMemoryPath = join(dir, "codex", "memories", "MEMORY.md");
		mkdirSync(join(dir, "codex", "memories"), { recursive: true });
		writeFileSync(codexMemoryPath, "# Codex Memory\n\nNicholai prefers portable memory across Hermes and Codex.\n");
		indexExternalMemoryArtifact({
			agentId: "default",
			sourcePath: codexMemoryPath,
			sourceKind: "native_memory_registry",
			harness: "codex",
			content: readFileSync(codexMemoryPath, "utf-8"),
			sourceMtimeMs: Date.now(),
		});

		const result = await hybridRecall(
			{
				query: "portable memory Hermes Codex",
				keywordQuery: "portable memory Hermes Codex",
				limit: 5,
				agentId: "default",
				project: "/workspace/project",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			async () => null,
		);

		expect(result.results[0]?.source).toBe("native_memory");
		expect(result.results[0]?.source_id).toMatch(/^native:codex:native_memory_registry:[a-f0-9]{16}$/);
		expect(result.results[0]?.source_id).not.toContain(codexMemoryPath);
		expect(result.results[0]?.session_id).toBe(result.results[0]?.source_id);
		expect(result.results[0]?.content).toContain("Native codex memory");
		const materialized = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count: number },
		);
		expect(materialized.count).toBe(0);
	});

	it("excludes soft-deleted native harness artifacts from recall", async () => {
		const codexMemoryPath = join(dir, "codex", "automations", "smoke", "memory.md");
		mkdirSync(join(dir, "codex", "automations", "smoke"), { recursive: true });
		writeFileSync(codexMemoryPath, "# Codex Memory\n\nsoft deleted native bridge marker should not recall.\n");
		indexExternalMemoryArtifact({
			agentId: "default",
			sourcePath: codexMemoryPath,
			sourceKind: "native_automation_memory",
			harness: "codex",
			content: readFileSync(codexMemoryPath, "utf-8"),
			sourceMtimeMs: Date.now(),
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memory_artifacts SET is_deleted = 1, deleted_at = ? WHERE source_path = ?").run(
				new Date().toISOString(),
				codexMemoryPath,
			);
		});

		const result = await hybridRecall(
			{
				query: "soft deleted native bridge marker",
				keywordQuery: "soft deleted native bridge marker",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			async () => null,
		);

		expect(result.results.some((row) => row.source === "native_memory")).toBe(false);
	});

	it("does not classify native-looking artifacts without the bridge-owned provenance marker", async () => {
		const codexMemoryPath = join(dir, "codex", "memories", "MEMORY.md");
		mkdirSync(join(dir, "codex", "memories"), { recursive: true });
		writeFileSync(codexMemoryPath, "# Codex Memory\n\nSpoofed native provenance marker should not surface.\n");
		indexExternalMemoryArtifact({
			agentId: "default",
			sourcePath: codexMemoryPath,
			sourceKind: "native_memory_registry",
			harness: "codex",
			content: readFileSync(codexMemoryPath, "utf-8"),
			sourceMtimeMs: Date.now(),
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memory_artifacts SET source_node_id = ?").run("spoofed-native-marker");
		});

		const result = await hybridRecall(
			{
				query: "Spoofed native provenance marker",
				keywordQuery: "Spoofed native provenance marker",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			async () => null,
		);

		expect(result.results.some((row) => row.source === "native_memory")).toBe(false);
	});

	it("dedupes native artifacts against their public recall source id", async () => {
		const now = new Date().toISOString();
		const codexMemoryPath = join(dir, "codex", "memories", "MEMORY.md");
		const sourceId = `native:codex:native_memory_registry:${createHash("sha256").update(codexMemoryPath).digest("hex").slice(0, 16)}`;
		mkdirSync(join(dir, "codex", "memories"), { recursive: true });
		writeFileSync(codexMemoryPath, "# Codex Memory\n\nCodex remembered a duplicate native recall marker.\n");
		indexExternalMemoryArtifact({
			agentId: "default",
			sourcePath: codexMemoryPath,
			sourceKind: "native_memory_registry",
			harness: "codex",
			content: readFileSync(codexMemoryPath, "utf-8"),
			sourceMtimeMs: Date.now(),
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, source_id, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', ?, 'default', ?, ?, 'test')`,
			).run("native-public-source", "Codex remembered a duplicate native recall marker.", sourceId, now, now);
		});

		const result = await hybridRecall(
			{
				query: "duplicate native recall marker",
				keywordQuery: "duplicate native recall marker",
				limit: 2,
				agentId: "default",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			async () => null,
		);

		expect(result.results.map((row) => row.source_id).filter((id) => id === sourceId)).toHaveLength(1);
		expect(result.results.some((row) => row.source === "native_memory" && row.source_id === sourceId)).toBe(false);
	});

	it("returns more than five native artifacts when they are the primary recall source", async () => {
		const root = join(dir, "codex", "memories", "rollout_summaries");
		mkdirSync(root, { recursive: true });
		for (let i = 0; i < 6; i++) {
			const file = join(root, `native-limit-${i}.md`);
			writeFileSync(file, `# Codex Memory ${i}\n\nshared native bridge limit marker ${i}.\n`);
			indexExternalMemoryArtifact({
				agentId: "default",
				sourcePath: file,
				sourceKind: "native_rollout_summary",
				harness: "codex",
				content: readFileSync(file, "utf-8"),
				sourceMtimeMs: Date.now() + i,
			});
		}

		const result = await hybridRecall(
			{
				query: "shared native bridge limit marker",
				keywordQuery: "shared native bridge limit marker",
				limit: 6,
				agentId: "default",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			async () => null,
		);

		expect(result.results.filter((row) => row.source === "native_memory")).toHaveLength(6);
	});

	it("keeps score calibration stable when reranker provider is noop", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, source_id, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', ?, ?, ?, ?, 'test')`,
			).run("mem-a", "deploy rollback checklist release", "sess-a", "default", now, now);

			db.prepare(
				`INSERT INTO memories (
					id, content, type, source_id, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', ?, ?, ?, ?, 'test')`,
			).run("mem-b", "deploy checklist", "sess-a", "default", now, now);
		});

		const base = testCfg();

		const withReranker = testCfg({ reranker: true, rerankerTopN: 10 });

		const params = {
			query: "deploy rollback checklist release",
			keywordQuery: "deploy rollback checklist release",
			limit: 5,
			agentId: "default",
			readPolicy: "isolated",
		} as const;

		const before = await hybridRecall(params, base, async () => null);
		const after = await hybridRecall(params, withReranker, async () => null);

		expect(after.results.map((row) => row.id)).toEqual(before.results.map((row) => row.id));
		expect(after.results.map((row) => row.score)).toEqual(before.results.map((row) => row.score));
	});

	it("filters temporal bookkeeping noise from constructed entity cards", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
			).run("mem-signet", "Signet project workspace", now, now);

			db.prepare(
				`INSERT INTO entities (
					id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at
				) VALUES (?, ?, ?, 'project', 'default', 10, ?, ?)`,
			).run("ent-signet", "Signet", "signet", now, now);

			db.prepare(
				`INSERT INTO entity_aspects (
					id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at
				) VALUES (?, ?, 'default', 'context', 'context', 0.9, ?, ?)`,
			).run("asp-signet", "ent-signet", now, now);

			const stmt = db.prepare(
				`INSERT INTO entity_attributes (
					id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at
				) VALUES (?, 'asp-signet', 'default', NULL, 'attribute', ?, ?, 1, ?, 'active', ?, ?)`,
			);
			stmt.run("attr-good", "portable memory runtime", "portable memory runtime", 0.9, now, now);
			stmt.run(
				"attr-noise-1",
				"session:abc source=summary latest=2026-03-29",
				"session:abc source=summary latest=2026-03-29",
				0.8,
				now,
				now,
			);
			stmt.run("attr-noise-2", "[[memory/2026-03-29-summary.md]]", "[[memory/2026-03-29-summary.md]]", 0.7, now, now);
		});

		const cfg = testCfg({ graph: true, traversal: true });

		const result = await hybridRecall(
			{
				query: "Signet",
				keywordQuery: "Signet",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
			},
			cfg,
			async () => null,
		);

		const card = result.results.find((row) => row.source === "constructed");
		expect(card).toBeDefined();
		expect(card?.content).toContain("portable memory runtime");
		expect(card?.content).not.toContain("session:abc");
		expect(card?.content).not.toContain("[[memory/");
		expect(card?.content_length ?? 0).toBeLessThanOrEqual(900);
		expect(result.meta.hasSupplementary).toBe(true);
	});

	it("skips null embedding vectors in traversal cosine scoring without crashing", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.exec(`
				DROP TABLE IF EXISTS embeddings;
				CREATE TABLE embeddings (
					id TEXT PRIMARY KEY,
					content_hash TEXT NOT NULL UNIQUE,
					vector BLOB,
					dimensions INTEGER NOT NULL,
					source_type TEXT NOT NULL,
					source_id TEXT NOT NULL,
					chunk_text TEXT NOT NULL,
					created_at TEXT NOT NULL
				);
			`);

			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
			).run("mem-null-vec", "Signet traversal memory", now, now);

			db.prepare(
				`INSERT INTO entities (
					id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at
				) VALUES (?, ?, ?, 'project', 'default', 5, ?, ?)`,
			).run("ent-null-vec", "Signet", "signet", now, now);

			db.prepare(
				`INSERT INTO entity_aspects (
					id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at
				) VALUES (?, ?, 'default', 'context', 'context', 0.9, ?, ?)`,
			).run("asp-null-vec", "ent-null-vec", now, now);

			db.prepare(
				`INSERT INTO entity_attributes (
					id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at
				) VALUES (?, ?, 'default', ?, 'attribute', ?, ?, 1, 0.9, 'active', ?, ?)`,
			).run(
				"attr-null-vec",
				"asp-null-vec",
				"mem-null-vec",
				"Signet traversal memory",
				"signet traversal memory",
				now,
				now,
			);

			db.prepare(
				`INSERT INTO embeddings (
					id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at
				) VALUES (?, ?, NULL, 3, 'memory', ?, ?, ?)`,
			).run("emb-null-vec", "hash-null-vec", "mem-null-vec", "Signet traversal memory", now);
		});

		const cfg = testCfg({ graph: true, traversal: true });

		const result = await hybridRecall(
			{
				query: "Signet",
				keywordQuery: "Signet",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
			},
			cfg,
			async () => [0.1, 0.2, 0.3],
		);

		expect(result.results.length).toBeGreaterThan(0);
		expect(result.results.map((row) => row.id)).toContain("mem-null-vec");
	});

	it("keeps traversal-only evidence below directly anchored recall hits", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
			).run("mem-direct-commute", "daily commute to work takes thirty minutes", now, now);

			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
			).run("mem-traversal-food", "favorite food is swordfish at the corner restaurant", now, now);

			db.prepare(
				`INSERT INTO entities (
					id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at
				) VALUES (?, ?, ?, 'concept', 'default', 5, ?, ?)`,
			).run("ent-commute", "commute", "commute", now, now);

			db.prepare(
				`INSERT INTO entity_aspects (
					id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at
				) VALUES (?, ?, 'default', 'context', 'context', 0.9, ?, ?)`,
			).run("asp-commute", "ent-commute", now, now);

			db.prepare(
				`INSERT INTO entity_attributes (
					id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at
				) VALUES (?, ?, 'default', ?, 'attribute', ?, ?, 1, 1, 'active', ?, ?)`,
			).run(
				"attr-commute-food",
				"asp-commute",
				"mem-traversal-food",
				"favorite food is swordfish at the corner restaurant",
				"favorite food is swordfish at the corner restaurant",
				now,
				now,
			);
		});

		const cfg = loadMemoryConfig(dir);
		cfg.search.rehearsal_enabled = false;
		cfg.search.min_score = 0;
		cfg.pipelineV2.graph.enabled = true;
		cfg.pipelineV2.traversal.enabled = true;
		cfg.pipelineV2.traversal.primary = true;
		cfg.pipelineV2.reranker.enabled = false;

		const result = await hybridRecall(
			{
				query: "commute to work",
				keywordQuery: "commute to work",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
			},
			cfg,
			async () => null,
		);

		const ids = result.results.map((row) => row.id);
		expect(ids).toContain("mem-direct-commute");
		expect(ids).toContain("mem-traversal-food");
		expect(ids.indexOf("mem-direct-commute")).toBeLessThan(ids.indexOf("mem-traversal-food"));
	});

	it("uses prospective hints as their own evidence channel", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
			).run("mem-spotify", "The user listens on Spotify during the workday.", now, now);

			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
			).run("mem-netflix", "Netflix is a video streaming service for movies.", now, now);

			db.prepare(
				`INSERT INTO memory_hints (id, memory_id, agent_id, hint, created_at)
				 VALUES (?, ?, 'default', ?, ?)`,
			).run("hint-spotify", "mem-spotify", "What music streaming service has the user been using lately?", now);
		});

		const cfg = loadMemoryConfig(dir);
		cfg.search.rehearsal_enabled = false;
		cfg.search.min_score = 0;
		cfg.pipelineV2.graph.enabled = false;
		cfg.pipelineV2.traversal.enabled = false;
		cfg.pipelineV2.reranker.enabled = false;
		cfg.pipelineV2.hints.enabled = true;

		const result = await hybridRecall(
			{
				query: "What music streaming service have I been using lately?",
				keywordQuery: "What music streaming service have I been using lately?",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
			},
			cfg,
			async () => null,
		);

		expect(result.results[0]?.id).toBe("mem-spotify");
		expect(result.results[0]?.source).toBe("hint");
		expect(result.results[0]?.score).toBeLessThan(0.8);
	});

	it("uses structured path candidates when lexical recall misses a music platform", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
			).run("mem-spotify-structured", "Speaker A has been listening to songs on Spotify lately.", now, now);

			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
			).run(
				"mem-netflix-distractor",
				"Netflix is a video streaming service with documentary recommendations.",
				now,
				now,
			);

			db.prepare(
				`INSERT INTO entities (
					id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at
				) VALUES (?, ?, ?, 'person', 'default', 1, ?, ?)`,
			).run("ent-music-user", "MemoryBench User music", "memorybench user music", now, now);

			db.prepare(
				`INSERT INTO entity_aspects (
					id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at
				) VALUES (?, ?, 'default', 'music_preferences', 'music_preferences', 0.9, ?, ?)`,
			).run("asp-music-user", "ent-music-user", now, now);

			db.prepare(
				`INSERT INTO entity_attributes (
					id, aspect_id, agent_id, memory_id, kind, group_key, claim_key, content, normalized_content,
					confidence, importance, status, created_at, updated_at
				) VALUES (?, ?, 'default', ?, 'attribute', ?, ?, ?, ?, 1, 0.95, 'active', ?, ?)`,
			).run(
				"attr-music-user",
				"asp-music-user",
				"mem-spotify-structured",
				"listening_habits",
				"recent_platform",
				"Speaker A has been listening to songs on Spotify lately.",
				"speaker a has been listening to songs on spotify lately",
				now,
				now,
			);

			db.prepare(
				`INSERT INTO memory_hints (id, memory_id, agent_id, hint, created_at)
				 VALUES (?, ?, 'default', ?, ?)`,
			).run(
				"hint-spotify-structured",
				"mem-spotify-structured",
				"What music streaming service has the user been using lately?",
				now,
			);
		});

		const cfg = loadMemoryConfig(dir);
		cfg.search.rehearsal_enabled = false;
		cfg.search.min_score = 0;
		cfg.pipelineV2.graph.enabled = true;
		cfg.pipelineV2.traversal.enabled = false;
		cfg.pipelineV2.reranker.enabled = false;

		const result = await hybridRecall(
			{
				query: "What music streaming service has the user been using lately?",
				keywordQuery: "What music streaming service has the user been using lately?",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
			},
			cfg,
			async () => null,
		);

		const hit = result.results.find((row) => row.id === "mem-spotify-structured");
		expect(hit).toBeDefined();
		expect(["structured", "sec"]).toContain(hit?.source);
		expect(hit?.score).toBeGreaterThan(0.75);
	});

	it("uses structured path candidates when lexical recall misses a shampoo brand", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
			).run(
				"mem-shampoo-structured",
				"Speaker A likes the lavender scented shampoo picked up at Trader Joe's.",
				now,
				now,
			);

			const distractor = db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
			);
			for (let i = 0; i < 25; i++) {
				distractor.run(
					`mem-generic-brand-${i}`,
					`A generic brand memo mentioned current shampoo use and product positioning ${i}.`,
					now,
					now,
				);
			}

			db.prepare(
				`INSERT INTO entities (
					id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at
				) VALUES (?, ?, ?, 'person', 'default', 1, ?, ?)`,
			).run("ent-shampoo-user", "MemoryBench User shampoo", "memorybench user shampoo", now, now);

			db.prepare(
				`INSERT INTO entity_aspects (
					id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at
				) VALUES (?, ?, 'default', 'personal_preferences', 'personal_preferences', 0.9, ?, ?)`,
			).run("asp-shampoo-user", "ent-shampoo-user", now, now);

			db.prepare(
				`INSERT INTO entity_attributes (
					id, aspect_id, agent_id, memory_id, kind, group_key, claim_key, content, normalized_content,
					confidence, importance, status, created_at, updated_at
				) VALUES (?, ?, 'default', ?, 'attribute', ?, ?, ?, ?, 1, 0.95, 'active', ?, ?)`,
			).run(
				"attr-shampoo-user",
				"asp-shampoo-user",
				"mem-shampoo-structured",
				"shampoo_preferences",
				"preferred_shampoo_scent_and_source",
				"Likes the lavender scented shampoo picked up at Trader Joe's.",
				"likes the lavender scented shampoo picked up at trader joe's",
				now,
				now,
			);
		});

		const cfg = loadMemoryConfig(dir);
		cfg.search.rehearsal_enabled = false;
		cfg.search.min_score = 0;
		cfg.pipelineV2.graph.enabled = true;
		cfg.pipelineV2.traversal.enabled = true;
		cfg.pipelineV2.traversal.primary = true;
		cfg.pipelineV2.reranker.enabled = false;

		const result = await hybridRecall(
			{
				query: "What brand of shampoo does the user currently use?",
				keywordQuery: "What brand of shampoo does the user currently use?",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
			},
			cfg,
			async () => null,
		);

		const hit = result.results.find((row) => row.id === "mem-shampoo-structured");
		expect(hit).toBeDefined();
		expect(["structured", "sec"]).toContain(hit?.source);
	});

	it("expands baking advice queries to bridge ingredient preference memories", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'preference', 'default', ?, ?, 'test')`,
			).run(
				"mem-turbinado",
				"The user experimented with turbinado sugar and found that it adds a richer flavor. " +
					"They asked which ingredients pair well with it to enhance desserts.\n\n" +
					"## Preferences\n- The user prefers turbinado sugar for its richer flavor.",
				now,
				now,
			);

			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'preference', 'default', ?, ?, 'test')`,
			).run(
				"mem-running",
				"The user was feeling motivated and asked for advice about getting back into a running routine.",
				now,
				now,
			);

			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'preference', 'default', ?, ?, 'test')`,
			).run(
				"mem-cherry",
				"The user asked for a cherry recipe and discussed brown sugar, flavor, texture, and ingredients.",
				now,
				now,
			);
		});

		const cfg = loadMemoryConfig(dir);
		cfg.search.rehearsal_enabled = false;
		cfg.search.min_score = 0;
		cfg.pipelineV2.graph.enabled = false;
		cfg.pipelineV2.traversal.enabled = false;
		cfg.pipelineV2.reranker.enabled = false;

		const result = await hybridRecall(
			{
				query: "I've been feeling like my chocolate chip cookies need something extra. Any advice?",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
			},
			cfg,
			async () => null,
		);

		expect(expandRecallKeywordQuery("chocolate chip cookies need something extra")).toContain("sugar");
		const ids = result.results.map((row) => row.id);
		expect(ids).toContain("mem-turbinado");
	});

	it("expands entertainment recommendation queries for media preferences", async () => {
		expect(expandRecallKeywordQuery("Can you recommend a show or movie for me to watch tonight?")).toContain("netflix");
		expect(expandRecallKeywordQuery("Can you recommend a show or movie for me to watch tonight?")).toContain(
			"storytelling",
		);
	});

	it("uses transcript fallback when extracted memory compressed away media details", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts (
					session_key, content, harness, project, agent_id, created_at, updated_at
				) VALUES (?, ?, 'memorybench-session', ?, ?, ?, ?)`,
			).run(
				"bench-scope:answer_0250ae1c",
				`user: Can you recommend some stand-up comedy specials on Netflix with strong storytelling abilities?
assistant: John Mulaney's Kid Gorgeous is an excellent example. Hasan Minhaj: Homecoming King and Mike Birbiglia: My Girlfriend's Boyfriend are strong storytelling specials.`,
				"memorybench",
				"default",
				now,
				now,
			);
		});

		const cfg = loadMemoryConfig(dir);
		cfg.search.rehearsal_enabled = false;
		cfg.search.min_score = 0;
		cfg.pipelineV2.graph.enabled = false;
		cfg.pipelineV2.traversal.enabled = false;
		cfg.pipelineV2.reranker.enabled = false;

		const result = await hybridRecall(
			{
				query: "Can you recommend a show or movie for me to watch tonight?",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
				project: "memorybench",
				scope: "bench-scope",
				expand: true,
			},
			cfg,
			async () => null,
		);

		expect(result.results[0]?.source).toBe("transcript");
		expect(result.results[0]?.source_id).toBe("bench-scope:answer_0250ae1c");
		expect(result.results[0]?.content).toContain("stand-up comedy specials on Netflix");
		expect(result.results[0]?.tags).toContain("answer_0250ae1c");
	});

	it("hydrates transcript fallback with the same-session structured memory summary", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, source_id, agent_id, project, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', ?, 'default', ?, ?, ?, 'test')`,
			).run(
				"mem-routine-summary",
				"Speaker A mentioned starting yoga on Wednesdays.",
				"bench-scope:session-28",
				"memorybench",
				now,
				now,
			);

			db.prepare(
				`INSERT INTO session_transcripts (
					session_key, content, harness, project, agent_id, created_at, updated_at
				) VALUES (?, ?, 'memorybench-session', ?, ?, ?, ?)`,
			).run(
				"bench-scope:session-28",
				`user: We talked through exercise classes and calendar planning.
assistant: Considering your weightlifting background, power yoga might be useful.`,
				"memorybench",
				"default",
				now,
				now,
			);
		});

		const cfg = loadMemoryConfig(dir);
		cfg.search.rehearsal_enabled = false;
		cfg.search.min_score = 0;
		cfg.pipelineV2.graph.enabled = false;
		cfg.pipelineV2.traversal.enabled = false;
		cfg.pipelineV2.reranker.enabled = false;

		const result = await hybridRecall(
			{
				query: "exercise classes calendar",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
				project: "memorybench",
				scope: "bench-scope",
				expand: true,
			},
			cfg,
			async () => null,
		);

		const hit = result.results.find((row) => row.id === "transcript:bench-scope:session-28");
		expect(hit?.source).toBe("transcript");
		expect(hit?.content).toStartWith("[Structured memory summary]");
		expect(hit?.content).toContain("starting yoga on Wednesdays");
		expect(hit?.content).toContain("[Transcript excerpt]");
		expect(hit?.content).toContain("exercise classes and calendar planning");
	});

	it("defaults transcript summary hydration to the default agent when agentId is omitted", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			const memory = db.prepare(
				`INSERT INTO memories (
					id, content, type, source_id, agent_id, project, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', ?, ?, NULL, ?, ?, 'test')`,
			);
			memory.run(
				"mem-default-summary",
				"Default agent summary says the user maintains a fermented dough culture in the fridge.",
				"shared-session-42",
				"default",
				now,
				now,
			);
			memory.run(
				"mem-other-agent-summary",
				"Other agent summary says the user keeps backup API keys in a notebook.",
				"shared-session-42",
				"agent-b",
				now,
				now,
			);

			db.prepare(
				`INSERT INTO session_transcripts (
					session_key, content, harness, project, agent_id, created_at, updated_at
				) VALUES (?, ?, 'codex', NULL, 'default', ?, ?)`,
			).run("shared-session-42", "user: We discussed sourdough starter storage and feeding cadence.", now, now);
		});

		const result = await hybridRecall(
			{
				query: "sourdough starter feeding cadence",
				limit: 5,
				expand: true,
			},
			testCfg({ reranker: false }),
			async () => null,
		);

		const hit = result.results.find((row) => row.id === "transcript:shared-session-42");
		expect(hit?.content).toContain("Default agent summary");
		expect(hit?.content).not.toContain("Other agent summary");
		expect(hit?.content).not.toContain("backup API keys");
	});

	it("dampens stale structured memories and annotates current replacements", async () => {
		const oldDate = "2023-05-01T12:00:00.000Z";
		const newDate = "2023-06-01T12:00:00.000Z";
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
			).run("mem-old-restaurants", "The user had tried three Korean restaurants.", oldDate, oldDate);

			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
			).run("mem-new-restaurants", "The user has now tried four Korean restaurants.", newDate, newDate);

			db.prepare(
				`INSERT INTO entities (
					id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at
				) VALUES (?, ?, ?, 'person', 'default', 2, ?, ?)`,
			).run("ent-restaurants", "MemoryBench User restaurants", "memorybench user restaurants", oldDate, newDate);

			db.prepare(
				`INSERT INTO entity_aspects (
					id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at
				) VALUES (?, ?, 'default', 'dining history', 'dining history', 0.9, ?, ?)`,
			).run("asp-restaurants", "ent-restaurants", oldDate, newDate);

			db.prepare(
				`INSERT INTO entity_attributes (
					id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
					confidence, importance, status, superseded_by, created_at, updated_at
				) VALUES (?, 'asp-restaurants', 'default', ?, 'attribute', ?, ?, 1, 0.9, ?, ?, ?, ?)`,
			).run(
				"attr-old-restaurants",
				"mem-old-restaurants",
				"MemoryBench User restaurants has tried three Korean restaurants.",
				"memorybench user restaurants has tried three korean restaurants",
				"superseded",
				"attr-new-restaurants",
				oldDate,
				newDate,
			);
			db.prepare(
				`INSERT INTO entity_attributes (
					id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
					confidence, importance, status, created_at, updated_at
				) VALUES (?, 'asp-restaurants', 'default', ?, 'attribute', ?, ?, 1, 0.9, 'active', ?, ?)`,
			).run(
				"attr-new-restaurants",
				"mem-new-restaurants",
				"MemoryBench User restaurants has now tried four Korean restaurants.",
				"memorybench user restaurants has now tried four korean restaurants",
				newDate,
				newDate,
			);
		});

		const cfg = loadMemoryConfig(dir);
		cfg.search.rehearsal_enabled = false;
		cfg.search.min_score = 0;
		cfg.pipelineV2.graph.enabled = false;
		cfg.pipelineV2.traversal.enabled = false;
		cfg.pipelineV2.reranker.enabled = false;

		const result = await hybridRecall(
			{
				query: "How many Korean restaurants has the user tried?",
				keywordQuery: "How many Korean restaurants has the user tried?",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
			},
			cfg,
			async () => null,
		);

		const ids = result.results.map((row) => row.id);
		expect(ids.indexOf("mem-new-restaurants")).toBeLessThan(ids.indexOf("mem-old-restaurants"));
		const stale = result.results.find((row) => row.id === "mem-old-restaurants");
		expect(stale?.content).toContain("[Signet currentness]");
		expect(stale?.content).toContain("Superseded structured facts");
		expect(stale?.content).toContain(
			"Current replacement: MemoryBench User restaurants has now tried four Korean restaurants.",
		);
	});

	it("reapplies project filtering during hydration for traversal results", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, project, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, ?, 'test')`,
			).run("mem-project", "Signet project memory for Nicholai", "/home/nicholai", now, now);

			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, project, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', NULL, ?, ?, 'test')`,
			).run("mem-null-project", "Signet global traversal memory", now, now);

			db.prepare(
				`INSERT INTO entities (
					id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at
				) VALUES (?, ?, ?, 'project', 'default', 5, ?, ?)`,
			).run("ent-project-filter", "Signet", "signet", now, now);

			db.prepare(
				`INSERT INTO entity_aspects (
					id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at
				) VALUES (?, ?, 'default', 'context', 'context', 0.9, ?, ?)`,
			).run("asp-project-filter", "ent-project-filter", now, now);

			const attr = db.prepare(
				`INSERT INTO entity_attributes (
					id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at
				) VALUES (?, 'asp-project-filter', 'default', ?, 'attribute', ?, ?, 1, 0.9, 'active', ?, ?)`,
			);
			attr.run(
				"attr-project-filter",
				"mem-project",
				"Signet project memory for Nicholai",
				"signet project memory for nicholai",
				now,
				now,
			);
			attr.run(
				"attr-null-project-filter",
				"mem-null-project",
				"Signet global traversal memory",
				"signet global traversal memory",
				now,
				now,
			);
		});

		const cfg = testCfg({ graph: true, traversal: true, traversalPrimary: true });

		const result = await hybridRecall(
			{
				query: "Signet",
				keywordQuery: "Signet",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
				project: "/home/nicholai",
			},
			cfg,
			async () => null,
		);

		expect(result.results.map((row) => row.id)).toContain("mem-project");
		expect(result.results.map((row) => row.id)).not.toContain("mem-null-project");
	});

	it("assembles scoped over-fetch results after unauthorized candidates are removed", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, project, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, ?, 'test')`,
			).run("mem-authorized-project", "Signet authorized project recall marker", "/home/nicholai", now, now);

			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, project, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', NULL, ?, ?, 'test')`,
			).run("mem-unauthorized-project", "Signet unauthorized traversal recall marker", now, now);

			db.prepare(
				`INSERT INTO entities (
					id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at
				) VALUES (?, ?, ?, 'project', 'default', 5, ?, ?)`,
			).run("ent-overfetch", "Signet", "signet", now, now);

			db.prepare(
				`INSERT INTO entity_aspects (
					id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at
				) VALUES (?, ?, 'default', 'context', 'context', 0.9, ?, ?)`,
			).run("asp-overfetch", "ent-overfetch", now, now);

			const attr = db.prepare(
				`INSERT INTO entity_attributes (
					id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at
				) VALUES (?, 'asp-overfetch', 'default', ?, 'attribute', ?, ?, 1, ?, 'active', ?, ?)`,
			);
			attr.run(
				"attr-unauthorized-overfetch",
				"mem-unauthorized-project",
				"Signet unauthorized traversal recall marker",
				"signet unauthorized traversal recall marker",
				1,
				now,
				now,
			);
			attr.run(
				"attr-authorized-overfetch",
				"mem-authorized-project",
				"Signet authorized project recall marker",
				"signet authorized project recall marker",
				0.5,
				now,
				now,
			);
		});

		const cfg = testCfg({ graph: true, traversal: true, traversalPrimary: true });

		const result = await hybridRecall(
			{
				query: "Signet",
				keywordQuery: "Signet",
				limit: 1,
				agentId: "default",
				readPolicy: "isolated",
				project: "/home/nicholai",
			},
			cfg,
			async () => null,
		);

		expect(result.results.map((row) => row.id)).toEqual(["mem-authorized-project"]);
	});

	it("does not use pinned entities as implicit traversal ballast for recall queries", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, 'test')`,
			).run("mem-pinned-only", "Nicholai general pinned traversal memory", now, now);

			db.prepare(
				`INSERT INTO entities (
					id, name, canonical_name, entity_type, agent_id, mentions, pinned, pinned_at, created_at, updated_at
				) VALUES (?, ?, ?, 'person', 'default', 10, 1, ?, ?, ?)`,
			).run("ent-pinned-only", "Nicholai", "nicholai", now, now, now);

			db.prepare(
				`INSERT INTO entity_aspects (
					id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at
				) VALUES (?, ?, 'default', 'context', 'context', 0.9, ?, ?)`,
			).run("asp-pinned-only", "ent-pinned-only", now, now);

			db.prepare(
				`INSERT INTO entity_attributes (
					id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at
				) VALUES (?, ?, 'default', ?, 'attribute', ?, ?, 1, 0.9, 'active', ?, ?)`,
			).run(
				"attr-pinned-only",
				"asp-pinned-only",
				"mem-pinned-only",
				"Nicholai general pinned traversal memory",
				"nicholai general pinned traversal memory",
				now,
				now,
			);
		});

		const cfg = testCfg({ graph: true, traversal: true, traversalPrimary: true });

		const result = await hybridRecall(
			{
				query: "proud",
				keywordQuery: "proud",
				limit: 5,
				agentId: "default",
				readPolicy: "isolated",
			},
			cfg,
			async () => null,
		);

		expect(result.results.map((row) => row.id)).not.toContain("mem-pinned-only");
	});

	it("escapes LIKE metacharacters in tag filter values", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, tags, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, ?, 'test')`,
			).run("mem-like-escape", "tagged memory", "important,work", now, now);

			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, tags, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', ?, ?, ?, 'test')`,
			).run("mem-like-other", "percent memory", "other", now, now);
		});

		const cfg = testCfg();

		const result = await hybridRecall(
			{
				query: "tagged",
				keywordQuery: "tagged",
				limit: 10,
				agentId: "default",
				readPolicy: "isolated",
				tags: "%",
			},
			cfg,
			async () => null,
		);

		const ids = result.results.map((row) => row.id);
		expect(ids).not.toContain("mem-like-escape");
		expect(ids).not.toContain("mem-like-other");
	});
});

describe("transcriptExcerpt", () => {
	it("chooses the densest query window instead of the first weak term match", () => {
		const transcript = [
			"assistant: Worsted weight yarn works for many amigurumi projects if you adjust hook size.",
			"assistant: Here is a long filler answer about gauge, density, fabric, toys, and hooks.".repeat(8),
			"user: I have a stash of 17 skeins of worsted weight yarn that I found recently.",
		].join(" ");

		const excerpt = transcriptExcerpt(transcript, "How many skeins of worsted weight yarn did I find in my stash?");

		expect(excerpt).toContain("17 skeins");
		expect(excerpt).toContain("stash");
	});

	it("uses meeting and temporal variants when choosing an excerpt", () => {
		const transcript = [
			"assistant: Questions to ask Mark and Sarah about the local history include festivals and museums.",
			"assistant: Here is filler about travel, hometowns, and restaurant planning.".repeat(8),
			"user: I met Mark and Sarah on a beach trip about a month ago.",
		].join(" ");

		const excerpt = transcriptExcerpt(transcript, "Who did I meet first, Mark and Sarah or Tom?");

		expect(excerpt).toContain("met Mark and Sarah");
		expect(excerpt).toContain("about a month ago");
	});
});

describe("buildAgentScopeClause regression tests", () => {
	it("falls back to isolated scope when policy is 'group' but policyGroup is null", () => {
		const result = buildAgentScopeClause("agent-x", "group", null);
		expect(result.sql).toBe(" AND m.agent_id = ? AND m.visibility != 'archived'");
		expect(result.args).toEqual(["agent-x"]);
	});

	it("uses group scope when both readPolicy and policyGroup are provided", () => {
		const result = buildAgentScopeClause("agent-x", "group", "team-a");
		expect(result.sql).toContain("policy_group = ?");
		expect(result.args).toEqual(["team-a", "agent-x"]);
	});

	it("uses shared scope for readPolicy 'shared'", () => {
		const result = buildAgentScopeClause("agent-x", "shared", null);
		expect(result.sql).toContain("m.visibility = 'global'");
		expect(result.args).toEqual(["agent-x"]);
	});
});
