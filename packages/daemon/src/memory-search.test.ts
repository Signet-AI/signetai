import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { type ResolvedMemoryConfig, loadMemoryConfig } from "./memory-config";
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
