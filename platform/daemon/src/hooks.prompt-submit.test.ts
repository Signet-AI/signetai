import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { vectorToBlob } from "./db-helpers";
import { handleUserPromptSubmit } from "./hooks";
import { SIGNET_SECRETS_PLUGIN_ID, getDefaultPluginHost, resetDefaultPluginHostForTests } from "./plugins/index";

type PromptDeps = Required<NonNullable<Parameters<typeof handleUserPromptSubmit>[1]>>;

const originalSignetPath = process.env.SIGNET_PATH;
const agentsDir = mkdtempSync(join(tmpdir(), "signet-hooks-prompt-submit-"));
const memoryDir = join(agentsDir, "memory");
const memoryDbPath = join(memoryDir, "memories.db");

const infoMock = mock((_cat: string, _msg: string, _data?: Record<string, unknown>) => {});
const warnMock = mock((..._args: unknown[]) => {});
const errorMock = mock((..._args: unknown[]) => {});
const hybridRecallMock = mock(async (..._args: Parameters<PromptDeps["hybridRecall"]>) => ({ results: [] }));
const fetchEmbeddingMock = mock(async (..._args: Parameters<PromptDeps["fetchEmbedding"]>) => null);
const searchTemporalFallbackMock = mock(() => []);

const { loadMemoryConfig: realLoadMemoryConfig } = await import("./memory-config");

process.env.SIGNET_PATH = agentsDir;

function resetDb(): void {
	closeDbAccessor();
	mkdirSync(memoryDir, { recursive: true });
	if (existsSync(memoryDbPath)) rmSync(memoryDbPath);
	initDbAccessor(memoryDbPath, { agentsDir });
}

function makeDeps(): PromptDeps {
	return {
		logger: {
			debug() {},
			info: infoMock,
			warn: warnMock,
			error: errorMock,
		},
		loadMemoryConfig: () => {
			const cfg = realLoadMemoryConfig(agentsDir);
			return {
				...cfg,
				pipelineV2: {
					...cfg.pipelineV2,
					feedback: { ...cfg.pipelineV2.feedback, enabled: false },
					continuity: { ...cfg.pipelineV2.continuity, enabled: false },
					guardrails: { ...cfg.pipelineV2.guardrails, contextBudgetChars: 4000 },
				},
			};
		},
		resolveAgentId: () => "default",
		getAgentScope: () => ({ readPolicy: "isolated" as const, policyGroup: null }),
		hybridRecall: hybridRecallMock,
		fetchEmbedding: fetchEmbeddingMock,
		searchTemporalFallback: searchTemporalFallbackMock,
		upsertSessionTranscript() {},
		getExpiryWarning: () => null,
		recordPrompt() {},
		shouldCheckpoint() {
			return false;
		},
		consumeState() {
			return null;
		},
		queueCheckpointWrite() {},
		formatPeriodicDigest() {
			return "";
		},
		parseFeedback() {
			return null;
		},
		recordAgentFeedback() {},
		trackFtsHits() {},
	} as unknown as PromptDeps;
}

function seedEntityContext(): void {
	getDbAccessor().withWriteTx((db) => {
		const now = "2026-05-27T00:00:00.000Z";
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'default', 10, ?, ?)`,
		).run("entity-signet", "Signet", "signet", "project", now, now);
		db.prepare(
			`INSERT INTO entity_aliases
			 (id, entity_id, agent_id, alias, canonical_alias, confidence, source, status, created_at, updated_at)
			 VALUES (?, ?, 'default', ?, ?, 1, 'test', 'active', ?, ?)`,
		).run("alias-signetai", "entity-signet", "SignetAI", "signetai", now, now);
		db.prepare(
			`INSERT INTO entity_aspects
			 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
			 VALUES (?, ?, 'default', ?, ?, ?, ?, ?)`,
		).run("aspect-architecture", "entity-signet", "architecture", "architecture", 0.9, now, now);
		db.prepare(
			`INSERT INTO entity_aspects
			 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
			 VALUES (?, ?, 'default', ?, ?, ?, ?, ?)`,
		).run("aspect-marketing", "entity-signet", "marketing", "marketing", 0.2, now, now);
		db.prepare(
			`INSERT INTO entity_aspects
			 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
			 VALUES (?, ?, 'default', ?, ?, ?, ?, ?)`,
		).run("aspect-preferences", "entity-signet", "preferences", "preferences", 0.8, now, now);
		db.prepare(
			`INSERT INTO entity_attributes
			 (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key,
			  confidence, importance, status, memory_id, source_kind, source_id, created_at, updated_at)
			 VALUES (?, ?, 'default', ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
		).run(
			"attr-architecture",
			"aspect-architecture",
			"attribute",
			"Prompt context should come from entity current views.",
			"prompt context should come from entity current views",
			"runtime",
			"prompt_context",
			0.95,
			0.9,
			"mem-architecture",
			"memory",
			"mem-architecture",
			now,
			now,
		);
		db.prepare(
			`INSERT INTO entity_attributes
			 (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key,
			  confidence, importance, status, version, created_at, updated_at)
			 VALUES (?, ?, 'default', ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
		).run(
			"attr-architecture-stale",
			"aspect-architecture",
			"attribute",
			"Stale prompt context should not be injected.",
			"stale prompt context should not be injected",
			"runtime",
			"prompt_context",
			0.5,
			2,
			0,
			now,
			now,
		);
		db.prepare(
			`INSERT INTO entity_attributes
			 (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key,
			  confidence, importance, status, created_at, updated_at)
			 VALUES (?, ?, 'default', ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
		).run(
			"constraint-architecture",
			"aspect-architecture",
			"constraint",
			"Do not use generic fallback injection.",
			"do not use generic fallback injection",
			"runtime",
			"fallback_policy",
			0.99,
			1,
			now,
			now,
		);
		db.prepare(
			`INSERT INTO entity_attributes
			 (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key,
			  confidence, importance, status, created_at, updated_at)
			 VALUES (?, ?, 'default', 'attribute', ?, ?, 'copy', 'positioning', 0.8, 0.3, 'active', ?, ?)`,
		).run("attr-marketing", "aspect-marketing", "Marketing copy should stay secondary.", "marketing copy", now, now);
		db.prepare(
			`INSERT INTO entity_attributes
			 (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key,
			  confidence, importance, status, memory_id, source_kind, source_id, created_at, updated_at)
			 VALUES (?, ?, 'default', 'attribute', ?, ?, 'writing', 'favorite_pen', 0.95, 0.9, 'active', ?, 'memory', ?, ?, ?)`,
		).run(
			"attr-preferences-pen",
			"aspect-preferences",
			"Favorite pen is a Pilot G-2.",
			"favorite pen is a pilot g 2",
			"mem-preferences-pen",
			"mem-preferences-pen",
			now,
			now,
		);
		db.prepare(
			`INSERT INTO embeddings
			 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
			 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?, 'default')`,
		).run(
			"emb-preferences-pen",
			"hash-preferences-pen",
			vectorToBlob([1, 0]),
			2,
			"mem-preferences-pen",
			"Favorite pen is a Pilot G-2.",
			now,
		);
	});
}

describe("handleUserPromptSubmit entity context", () => {
	beforeEach(() => {
		infoMock.mockClear();
		warnMock.mockClear();
		errorMock.mockClear();
		hybridRecallMock.mockClear();
		fetchEmbeddingMock.mockClear();
		searchTemporalFallbackMock.mockClear();
		resetDefaultPluginHostForTests();
		getDefaultPluginHost().setEnabled(SIGNET_SECRETS_PLUGIN_ID, true);
		resetDb();
	});

	afterAll(() => {
		closeDbAccessor();
		rmSync(agentsDir, { recursive: true, force: true });
		if (originalSignetPath === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
		} else {
			process.env.SIGNET_PATH = originalSignetPath;
		}
	});

	it("returns empty inject for low-signal turns without searching", async () => {
		seedEntityContext();

		const result = await handleUserPromptSubmit(
			{ harness: "codex", userMessage: "okay cool", sessionKey: "session-low-signal" },
			makeDeps(),
		);

		expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "low-signal" });
		expect(hybridRecallMock).not.toHaveBeenCalled();
		expect(fetchEmbeddingMock).not.toHaveBeenCalled();
		expect(searchTemporalFallbackMock).not.toHaveBeenCalled();
		expect(infoMock.mock.calls.at(-1)?.[2]?.engine).toBe("low-signal");
	});

	it("returns empty inject when no known entity or alias is mentioned", async () => {
		seedEntityContext();

		const result = await handleUserPromptSubmit(
			{ harness: "codex", userMessage: "what should we do about unrelated routing", sessionKey: "session-no-entity" },
			makeDeps(),
		);

		expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "no-entity" });
		expect(hybridRecallMock).not.toHaveBeenCalled();
		expect(searchTemporalFallbackMock).not.toHaveBeenCalled();
	});

	it("injects compact current-view context for an exact entity mention", async () => {
		seedEntityContext();

		const result = await handleUserPromptSubmit(
			{
				harness: "codex",
				userMessage: "How should Signet architecture handle prompt context?",
				sessionKey: "session-entity",
			},
			makeDeps(),
		);

		expect(result.engine).toBe("entity-context");
		expect(result.inject).toContain("## Relevant Entity Context");
		expect(result.inject).toContain("[attribute] Signet / architecture / runtime / prompt_context");
		expect(result.inject).not.toContain("[constraint] Signet / architecture / runtime / fallback_policy");
		expect(result.inject).not.toContain("Stale prompt context should not be injected.");
		expect(result.inject).not.toContain("## Relevant Memory");
		expect(result.inject).not.toContain("Marketing copy should stay secondary");
	});

	it("resolves active aliases to canonical entity context", async () => {
		seedEntityContext();

		const result = await handleUserPromptSubmit(
			{ harness: "codex", userMessage: "Should SignetAI architecture use current views?", sessionKey: "session-alias" },
			makeDeps(),
		);

		expect(result.engine).toBe("entity-context");
		expect(result.inject).toContain("Signet / architecture");
		expect(result.inject).toContain("Prompt context should come from entity current views.");
	});

	it("uses entity match only as the semantic scope for attribute relevance", async () => {
		seedEntityContext();
		fetchEmbeddingMock.mockImplementationOnce(async () => [1, 0]);

		const result = await handleUserPromptSubmit(
			{ harness: "codex", userMessage: "Signet likes taking notes", sessionKey: "session-attribute-semantic" },
			makeDeps(),
		);

		expect(fetchEmbeddingMock.mock.calls.at(-1)?.[0]).toBe("likes taking notes");
		expect(result.engine).toBe("entity-context");
		expect(result.inject).toContain("Signet / preferences / writing / favorite_pen");
		expect(result.inject).toContain("Favorite pen is a Pilot G-2.");
		expect(result.inject).not.toContain("Marketing copy should stay secondary");
		expect(result.inject).not.toContain("## Relevant Memory");
	});

	it("uses structured path terms to select zero-confidence curated attributes", async () => {
		getDbAccessor().withWriteTx((db) => {
			const now = "2026-05-27T00:00:00.000Z";
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-nicholai', 'Nicholai', 'nicholai', 'person', 'default', 10, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES ('aspect-nicholai-preferences', 'entity-nicholai', 'default',
				  'preferences', 'preferences', 1, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key,
				  confidence, importance, status, created_at, updated_at)
				 VALUES ('attr-nicholai-favorite-pens', 'aspect-nicholai-preferences',
				  'default', 'attribute',
				  'Nicholai prefers Pilot G-2 0.7 mm, Pilot G-TEC-C4, and Pilot Razor Point II pens.',
				  'nicholai prefers pilot g 2 0 7 mm pilot g tec c4 and pilot razor point ii pens',
				  'writing_tools', 'favorite_pens', 0, 0, 'active', ?, ?)`,
			).run(now, now);
		});

		const result = await handleUserPromptSubmit(
			{
				harness: "codex",
				userMessage: "what are nicholais favorite pens?",
				sessionKey: "session-structured-path-favorite-pens",
			},
			makeDeps(),
		);

		expect(result.engine).toBe("entity-context");
		expect(result.inject).toContain("Nicholai / preferences / writing_tools / favorite_pens");
		expect(result.inject).toContain("Pilot G-2 0.7 mm");
	});

	it("normalizes possessive entity matches to the dominant canonical entity", async () => {
		seedEntityContext();
		getDbAccessor().withWriteTx((db) => {
			const now = "2026-05-27T00:00:00.000Z";
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-signet-possessive', 'Signet''s', 'signet''s', 'tool', 'default', 2, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES ('aspect-signet-possessive-noise', 'entity-signet-possessive', 'default',
				  'noise', 'noise', 1, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key,
				  confidence, importance, status, created_at, updated_at)
				 VALUES ('attr-signet-possessive-noise', 'aspect-signet-possessive-noise', 'default',
				  'attribute', 'Possessive duplicate entity should not win prompt matching.',
				  'possessive duplicate entity should not win prompt matching',
				  'runtime', 'duplicate_guard', 0.9, 0.9, 'active', ?, ?)`,
			).run(now, now);
		});
		fetchEmbeddingMock.mockImplementationOnce(async () => [1, 0]);

		const result = await handleUserPromptSubmit(
			{
				harness: "codex",
				userMessage: "What are Signet's favorite pens?",
				sessionKey: "session-possessive-entity",
			},
			makeDeps(),
		);

		expect(fetchEmbeddingMock.mock.calls.at(-1)?.[0]).toBe("favorite pens");
		expect(result.engine).toBe("entity-context");
		expect(result.inject).toContain("Signet / preferences / writing / favorite_pen");
		expect(result.inject).not.toContain("Signet's / noise");
		expect(result.inject).not.toContain("Possessive duplicate entity should not win");
	});

	it("matches missing-apostrophe possessive entity mentions", async () => {
		seedEntityContext();
		fetchEmbeddingMock.mockImplementationOnce(async () => [1, 0]);

		const result = await handleUserPromptSubmit(
			{
				harness: "codex",
				userMessage: "What are Signets favorite pens?",
				sessionKey: "session-bare-possessive-entity",
			},
			makeDeps(),
		);

		expect(fetchEmbeddingMock.mock.calls.at(-1)?.[0]).toBe("favorite pens");
		expect(result.engine).toBe("entity-context");
		expect(result.inject).toContain("Signet / preferences / writing / favorite_pen");
	});

	it("does not treat generic plural ontology nouns as possessive entity mentions", async () => {
		getDbAccessor().withWriteTx((db) => {
			const now = "2026-05-27T00:00:00.000Z";
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-project', 'Project', 'project', 'project', 'default', 50, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-agents', 'Agents', 'agents', 'concept', 'default', 200, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES ('aspect-project-roadmap', 'entity-project', 'default', 'roadmap', 'roadmap', 1, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key,
				  confidence, importance, status, created_at, updated_at)
				 VALUES ('attr-project-roadmap', 'aspect-project-roadmap', 'default', 'attribute',
				  'Generic project roadmap context should not inject for plural projects.',
				  'generic project roadmap context should not inject for plural projects',
				  'general', 'roadmap', 0.9, 0.9, 'active', ?, ?)`,
			).run(now, now);
		});

		const result = await handleUserPromptSubmit(
			{
				harness: "codex",
				userMessage: "projects roadmap",
				sessionKey: "session-generic-plural-entity",
			},
			makeDeps(),
		);

		expect(result.engine).toBe("no-entity");
		expect(result.inject).not.toContain("Project / roadmap");

		const pluralResult = await handleUserPromptSubmit(
			{
				harness: "codex",
				userMessage: "agents are useful",
				sessionKey: "session-generic-plural-entity-exact",
			},
			makeDeps(),
		);

		expect(pluralResult.engine).toBe("no-entity");
	});

	it("ignores disallowed entity types for prompt context", async () => {
		getDbAccessor().withWriteTx((db) => {
			const now = "2026-05-27T00:00:00.000Z";
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-claude-code-connector', 'Claude Code connector', 'claude code connector',
				  'tool', 'default', 80, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES ('aspect-claude-code-connector-runtime', 'entity-claude-code-connector', 'default',
				  'runtime', 'runtime', 1, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key,
				  confidence, importance, status, created_at, updated_at)
				 VALUES ('attr-claude-code-connector-runtime', 'aspect-claude-code-connector-runtime',
				  'default', 'attribute', 'Claude Code connector setup context should not inject.',
				  'claude code connector setup context should not inject',
				  'setup', 'routing', 0.9, 0.9, 'active', ?, ?)`,
			).run(now, now);
		});

		const result = await handleUserPromptSubmit(
			{
				harness: "codex",
				userMessage: "Claude Code connector setup",
				sessionKey: "session-disallowed-entity-type",
			},
			makeDeps(),
		);

		expect(result.engine).toBe("no-entity");
		expect(result.inject).not.toContain("Claude Code connector / runtime");
	});

	it("ignores generic role-label person entities for prompt context", async () => {
		getDbAccessor().withWriteTx((db) => {
			const now = "2026-05-27T00:00:00.000Z";
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-user-role', 'User', 'user', 'person', 'default', 2000, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES ('aspect-user-general', 'entity-user-role', 'default', 'general', 'general', 1, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key,
				  confidence, importance, status, created_at, updated_at)
				 VALUES ('attr-user-role-context', 'aspect-user-general', 'default', 'attribute',
				  'User prompt context role-label junk should not inject.',
				  'user prompt context role label junk should not inject',
				  'general', 'uncategorized', 0.9, 0.9, 'active', ?, ?)`,
			).run(now, now);
		});

		const result = await handleUserPromptSubmit(
			{
				harness: "codex",
				userMessage: "tell the user about prompt context",
				sessionKey: "session-role-label-entity",
			},
			makeDeps(),
		);

		expect(result.engine).toBe("no-entity");
		expect(result.inject).not.toContain("User / general");
	});

	it("does not inject broad general uncategorized entity attributes", async () => {
		seedEntityContext();
		getDbAccessor().withWriteTx((db) => {
			const now = "2026-05-27T00:00:00.000Z";
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES ('aspect-signet-general', 'entity-signet', 'default', 'general', 'general', 1, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key,
				  confidence, importance, status, created_at, updated_at)
				 VALUES ('attr-signet-general-junk', 'aspect-signet-general', 'default', 'constraint',
				  'Prompt context junk from general uncategorized should not inject.',
				  'prompt context junk from general uncategorized should not inject',
				  'general', 'uncategorized', 0.99, 1, 'active', ?, ?)`,
			).run(now, now);
		});
		fetchEmbeddingMock.mockImplementationOnce(async () => [1, 0]);

		const result = await handleUserPromptSubmit(
			{
				harness: "codex",
				userMessage: "Signet prompt context",
				sessionKey: "session-general-uncategorized-filter",
			},
			makeDeps(),
		);

		expect(result.engine).toBe("entity-context");
		expect(result.inject).toContain("Signet / architecture / runtime / prompt_context");
		expect(result.inject).not.toContain("Signet / general / general / uncategorized");
		expect(result.inject).not.toContain("Prompt context junk from general uncategorized");
	});

	it("strips all selected entity terms from semantic attribute queries", async () => {
		seedEntityContext();
		getDbAccessor().withWriteTx((db) => {
			const now = "2026-05-27T00:00:00.000Z";
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-nicholai', 'Nicholai', 'nicholai', 'person', 'default', 10, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES ('aspect-nicholai-collaboration', 'entity-nicholai', 'default',
				  'collaboration', 'collaboration', 1, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key,
				  confidence, importance, status, created_at, updated_at)
				 VALUES ('attr-nicholai-collaboration-style', 'aspect-nicholai-collaboration',
				  'default', 'attribute', 'Collaboration style prefers direct artifact-first work.',
				  'collaboration style prefers direct artifact first work',
				  'working_style', 'style_summary', 0.9, 0.9, 'active', ?, ?)`,
			).run(now, now);
		});
		fetchEmbeddingMock.mockImplementation(async () => [0, 0]);

		await handleUserPromptSubmit(
			{
				harness: "codex",
				userMessage: "Signet Nicholai collaboration style",
				sessionKey: "session-strip-all-entities",
			},
			makeDeps(),
		);

		expect(fetchEmbeddingMock.mock.calls.map((call) => call[0])).toEqual([
			"collaboration style",
			"collaboration style",
		]);
	});

	it("requires lexical support for generic prompt context semantic hits", async () => {
		getDbAccessor().withWriteTx((db) => {
			const now = "2026-05-27T00:00:00.000Z";
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-nicholai', 'Nicholai', 'nicholai', 'person', 'default', 10, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES ('aspect-nicholai-projects', 'entity-nicholai', 'default', 'projects', 'projects', 1, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, group_key, claim_key,
				  confidence, importance, status, created_at, updated_at)
				 VALUES ('attr-nicholai-compass', 'aspect-nicholai-projects', 'default', 'mem-nicholai-compass',
				  'attribute', 'Compass is an active client project management tool.',
				  'compass is an active client project management tool',
				  'active_projects', 'compass', 0.9, 0.9, 'active', ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO embeddings
				 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
				 VALUES ('emb-nicholai-compass', 'hash-nicholai-compass', ?, 2, 'memory',
				  'mem-nicholai-compass', 'Compass is an active client project management tool.', ?, 'default')`,
			).run(vectorToBlob([1, 0]), now);
		});
		fetchEmbeddingMock.mockImplementationOnce(async () => [1, 0]);

		const result = await handleUserPromptSubmit(
			{
				harness: "codex",
				userMessage: "Nicholai prompt context",
				sessionKey: "session-generic-context-semantic-gate",
			},
			makeDeps(),
		);

		expect(result.engine).toBe("no-aspect-hit");
		expect(result.inject).not.toContain("Compass is an active client project management tool.");
	});

	it("ignores low-quality generic entity collisions when a stronger entity is present", async () => {
		seedEntityContext();
		getDbAccessor().withWriteTx((db) => {
			const now = "2026-05-27T00:00:00.000Z";
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-favorite', 'Favorite', 'favorite', 'extracted', 'default', 3, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES ('aspect-favorite-noise', 'entity-favorite', 'default', 'noise', 'noise', 1, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key,
				  confidence, importance, status, created_at, updated_at)
				 VALUES ('attr-favorite-noise', 'aspect-favorite-noise', 'default', 'attribute',
				  'Favorite pens from generic extracted entities should not inject.',
				  'favorite pens from generic extracted entities should not inject',
				  'runtime', 'generic_collision', 0.9, 0.9, 'active', ?, ?)`,
			).run(now, now);
		});
		fetchEmbeddingMock.mockImplementationOnce(async () => [1, 0]);

		const result = await handleUserPromptSubmit(
			{
				harness: "codex",
				userMessage: "What are Signet favorite pens?",
				sessionKey: "session-generic-collision",
			},
			makeDeps(),
		);

		expect(result.engine).toBe("entity-context");
		expect(result.inject).toContain("Signet / preferences / writing / favorite_pen");
		expect(result.inject).not.toContain("Favorite / noise");
		expect(result.inject).not.toContain("generic extracted entities");
	});

	it("prefers the longest non-overlapping entity span", async () => {
		getDbAccessor().withWriteTx((db) => {
			const now = "2026-05-27T00:00:00.000Z";
			for (const [id, name, canonical, mentions] of [
				["entity-claude-code-connector", "Claude Code connector", "claude code connector", 8],
				["entity-claude-code", "Claude Code", "claude code", 135],
				["entity-claude", "Claude", "claude", 113],
				["entity-code", "code", "code", 15],
				["entity-connector", "connector", "connector", 5],
			] as const) {
				db.prepare(
					`INSERT INTO entities
					 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
					 VALUES (?, ?, ?, 'project', 'default', ?, ?, ?)`,
				).run(id, name, canonical, mentions, now, now);
				db.prepare(
					`INSERT INTO entity_aspects
					 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
					 VALUES (?, ?, 'default', 'runtime', 'runtime', 1, ?, ?)`,
				).run(`aspect-${id}`, id, now, now);
				db.prepare(
					`INSERT INTO entity_attributes
					 (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key,
					  confidence, importance, status, created_at, updated_at)
					 VALUES (?, ?, 'default', 'attribute', ?, ?, 'setup', 'routing', 0.9, 0.9, 'active', ?, ?)`,
				).run(`attr-${id}`, `aspect-${id}`, `${name} setup context.`, `${canonical} setup context`, now, now);
			}
		});

		const result = await handleUserPromptSubmit(
			{
				harness: "codex",
				userMessage: "Claude Code connector setup",
				sessionKey: "session-longest-span",
			},
			makeDeps(),
		);

		expect(result.engine).toBe("entity-context");
		expect(result.inject).toContain("Claude Code connector / runtime / setup / routing");
		expect(result.inject).not.toContain("Claude Code / runtime");
		expect(result.inject).not.toContain("- [attribute] connector / runtime");
	});

	it("keeps semantic attribute scoring scoped to the current agent", async () => {
		seedEntityContext();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO embeddings
				 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
				 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?, ?)`,
			).run(
				"emb-other-agent-preferences-pen",
				"hash-other-agent-preferences-pen",
				vectorToBlob([0, 1]),
				2,
				"mem-preferences-pen",
				"Other agent favorite pen evidence.",
				"2026-05-27T00:00:00.000Z",
				"other-agent",
			);
		});
		fetchEmbeddingMock.mockImplementationOnce(async () => [0, 1]);

		const result = await handleUserPromptSubmit(
			{ harness: "codex", userMessage: "Signet likes taking notes", sessionKey: "session-agent-scoped-embedding" },
			makeDeps(),
		);

		expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "no-aspect-hit" });
		expect(result.inject).not.toContain("Favorite pen is a Pilot G-2.");
	});

	it("ignores mismatched embedding dimensions for semantic attribute scoring", async () => {
		seedEntityContext();
		getDbAccessor().withWriteTx((db) => {
			db.prepare("DELETE FROM embeddings WHERE id = ?").run("emb-preferences-pen");
			db.prepare(
				`INSERT INTO embeddings
				 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
				 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?, 'default')`,
			).run(
				"emb-preferences-pen-short",
				"hash-preferences-pen-short",
				vectorToBlob([1]),
				1,
				"mem-preferences-pen",
				"Favorite pen is a Pilot G-2.",
				"2026-05-27T00:00:00.000Z",
			);
		});
		fetchEmbeddingMock.mockImplementationOnce(async () => [1, 0]);

		const result = await handleUserPromptSubmit(
			{ harness: "codex", userMessage: "Signet likes taking notes", sessionKey: "session-dimension-mismatch" },
			makeDeps(),
		);

		expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "no-aspect-hit" });
		expect(result.inject).not.toContain("Favorite pen is a Pilot G-2.");
	});

	it("stays silent when the prompt only names an entity alias", async () => {
		seedEntityContext();

		const result = await handleUserPromptSubmit(
			{ harness: "codex", userMessage: "SignetAI", sessionKey: "session-alias-only" },
			makeDeps(),
		);

		expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "no-aspect-hit" });
	});

	it("does not select aspects from literal aspect names without an attribute hit", async () => {
		seedEntityContext();

		const result = await handleUserPromptSubmit(
			{ harness: "codex", userMessage: "SignetAI architecture", sessionKey: "session-aspect-name-only" },
			makeDeps(),
		);

		expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "no-aspect-hit" });
		expect(result.inject).not.toContain("Prompt context should come from entity current views.");
	});

	it("does not match short entity names as ordinary prompt tokens", async () => {
		getDbAccessor().withWriteTx((db) => {
			const now = "2026-05-27T00:00:00.000Z";
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-ai', 'AI', 'ai', 'concept', 'default', 10, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES ('aspect-ai-architecture', 'entity-ai', 'default', 'architecture', 'architecture', 1, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key,
				  confidence, importance, status, created_at, updated_at)
				 VALUES ('attr-ai-architecture', 'aspect-ai-architecture', 'default', 'attribute',
				  'Short entity names should not match ordinary words.',
				  'short entity names should not match ordinary words',
				  'runtime', 'short_match_guard', 0.9, 0.9, 'active', ?, ?)`,
			).run(now, now);
		});

		const result = await handleUserPromptSubmit(
			{ harness: "codex", userMessage: "Can AI architecture be summarized?", sessionKey: "session-short-name" },
			makeDeps(),
		);

		expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "no-entity" });
	});

	it("stays silent when the entity is known but no aspect clears the gate", async () => {
		seedEntityContext();

		const result = await handleUserPromptSubmit(
			{ harness: "codex", userMessage: "What about Signet billing?", sessionKey: "session-no-aspect" },
			makeDeps(),
		);

		expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "no-aspect-hit" });
	});
});
