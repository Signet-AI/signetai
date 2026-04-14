import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { loadMemoryConfig } from "./memory-config";
import { buildAgentScopeClause, hybridRecall } from "./memory-search";

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
		expect(result.meta).toEqual({
			totalReturned: 0,
			hasSupplementary: false,
			noHits: true,
		});
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

		const base = loadMemoryConfig(dir);
		base.search.rehearsal_enabled = false;
		base.search.min_score = 0;
		base.pipelineV2.graph.enabled = false;
		base.pipelineV2.traversal.enabled = false;
		base.pipelineV2.reranker.enabled = false;

		const withReranker = loadMemoryConfig(dir);
		withReranker.search.rehearsal_enabled = false;
		withReranker.search.min_score = 0;
		withReranker.pipelineV2.graph.enabled = false;
		withReranker.pipelineV2.traversal.enabled = false;
		withReranker.pipelineV2.reranker.enabled = true;
		withReranker.pipelineV2.reranker.topN = 10;

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

		const cfg = loadMemoryConfig(dir);
		cfg.search.rehearsal_enabled = false;
		cfg.search.min_score = 0;
		cfg.pipelineV2.graph.enabled = true;
		cfg.pipelineV2.traversal.enabled = true;
		cfg.pipelineV2.reranker.enabled = false;

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

		const cfg = loadMemoryConfig(dir);
		cfg.search.rehearsal_enabled = false;
		cfg.search.min_score = 0;
		cfg.pipelineV2.graph.enabled = true;
		cfg.pipelineV2.traversal.enabled = true;
		cfg.pipelineV2.reranker.enabled = false;

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

		const cfg = loadMemoryConfig(dir);
		cfg.search.rehearsal_enabled = false;
		cfg.search.min_score = 0;
		cfg.pipelineV2.graph.enabled = true;
		cfg.pipelineV2.traversal.enabled = true;
		cfg.pipelineV2.traversal.primary = true;
		cfg.pipelineV2.reranker.enabled = false;

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

		const cfg = loadMemoryConfig(dir);
		cfg.search.rehearsal_enabled = false;
		cfg.search.min_score = 0;
		cfg.pipelineV2.graph.enabled = true;
		cfg.pipelineV2.traversal.enabled = true;
		cfg.pipelineV2.traversal.primary = true;
		cfg.pipelineV2.reranker.enabled = false;

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

		const cfg = loadMemoryConfig(dir);
		cfg.search.rehearsal_enabled = false;
		cfg.search.min_score = 0;
		cfg.pipelineV2.graph.enabled = false;
		cfg.pipelineV2.traversal.enabled = false;
		cfg.pipelineV2.reranker.enabled = false;

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
