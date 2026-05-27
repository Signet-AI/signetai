import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
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
		expect(result.inject).toContain("[constraint] Signet / architecture / runtime / fallback_policy");
		expect(result.inject).toContain("Do not use generic fallback injection.");
		expect(result.inject).toContain("[attribute] Signet / architecture / runtime / prompt_context");
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

	it("stays silent when the prompt only names an entity alias", async () => {
		seedEntityContext();

		const result = await handleUserPromptSubmit(
			{ harness: "codex", userMessage: "SignetAI", sessionKey: "session-alias-only" },
			makeDeps(),
		);

		expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "no-aspect-hit" });
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
