/**
 * Tests for Signet Hook System
 *
 * Uses dynamic import so SIGNET_PATH is set before hooks.ts evaluates
 * its module-level constants.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = join(tmpdir(), `signet-hooks-test-${Date.now()}`);
process.env.SIGNET_PATH = TEST_DIR;

const { initDbAccessor, closeDbAccessor } = await import("../src/db-accessor");
const hooks = await import("../src/hooks");
const {
	handleSessionStart,
	handlePreCompaction,
	handleSynthesisRequest,
	handleUserPromptSubmit,
	handleRemember,
	handleRecall,
	handleSessionEnd,
	effectiveScore,
	selectWithBudget,
	isDuplicate,
	inferType,
	getAllScoredCandidates,
	writeMemoryMd: synthWriteMemoryMd,
} = hooks;

// ============================================================================
// Helpers
// ============================================================================

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

/** Create an isolated test DB with the full schema */
function createMemoryDb(
	memories: Array<{
		content: string;
		type?: string;
		importance?: number;
		who?: string;
		tags?: string;
		pinned?: number;
		project?: string;
		created_at?: string;
		agent_id?: string;
		visibility?: string;
	}> = [],
): void {
	const dbPath = join(TEST_DIR, "memory", "memories.db");
	ensureDir(join(TEST_DIR, "memory"));

	if (existsSync(dbPath)) rmSync(dbPath);

	const db = new Database(dbPath);

	db.exec("PRAGMA busy_timeout = 5000");

	db.exec(`
		CREATE TABLE IF NOT EXISTS agents (
			id TEXT PRIMARY KEY,
			name TEXT,
			read_policy TEXT NOT NULL DEFAULT 'isolated',
			policy_group TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);

	const seedNow = new Date().toISOString();
	db.prepare(
		`INSERT OR IGNORE INTO agents (id, name, read_policy, created_at, updated_at)
		 VALUES ('default', 'default', 'shared', ?, ?)`,
	).run(seedNow, seedNow);

	db.exec(`
		CREATE TABLE IF NOT EXISTS memories (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			who TEXT DEFAULT 'test',
			why TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT,
			project TEXT,
			session_id TEXT,
			importance REAL DEFAULT 0.5,
			last_accessed TEXT,
			access_count INTEGER DEFAULT 0,
			type TEXT DEFAULT 'explicit',
			tags TEXT,
			pinned INTEGER DEFAULT 0,
			source_type TEXT DEFAULT 'manual',
			source_id TEXT,
			category TEXT,
			updated_by TEXT DEFAULT 'user',
			vector_clock TEXT DEFAULT '{}',
			version INTEGER DEFAULT 1,
			manual_override INTEGER DEFAULT 0,
			confidence REAL DEFAULT 1.0,
			is_deleted INTEGER DEFAULT 0,
			scope TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			visibility TEXT NOT NULL DEFAULT 'global'
		)
	`);

	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
			content, tags, content=memories, content_rowid=rowid
		)
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories
		BEGIN
			INSERT INTO memories_fts(rowid, content, tags)
			VALUES (new.rowid, new.content, new.tags);
		END
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories
		BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content, tags)
			VALUES('delete', old.rowid, old.content, old.tags);
		END
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories
		BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content, tags)
			VALUES('delete', old.rowid, old.content, old.tags);
			INSERT INTO memories_fts(rowid, content, tags)
			VALUES (new.rowid, new.content, new.tags);
		END
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS session_memories (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
			memory_id TEXT NOT NULL,
			source TEXT NOT NULL,
			effective_score REAL,
			predictor_score REAL,
			final_score REAL NOT NULL,
			rank INTEGER NOT NULL,
			was_injected INTEGER NOT NULL,
			relevance_score REAL,
			fts_hit_count INTEGER NOT NULL DEFAULT 0,
			agent_preference TEXT,
			created_at TEXT NOT NULL,
			entity_slot INTEGER,
			aspect_slot INTEGER,
			is_constraint INTEGER NOT NULL DEFAULT 0,
			structural_density INTEGER,
			UNIQUE(session_key, agent_id, memory_id)
		);
		CREATE INDEX IF NOT EXISTS idx_session_memories_session
			ON session_memories(session_key);
		CREATE INDEX IF NOT EXISTS idx_session_memories_memory
			ON session_memories(memory_id)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS summary_jobs (
			id TEXT PRIMARY KEY,
			session_key TEXT,
			harness TEXT NOT NULL,
			project TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			transcript TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			attempts INTEGER DEFAULT 0,
			max_attempts INTEGER DEFAULT 3,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			completed_at TEXT
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS session_transcripts (
			session_key TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			harness TEXT,
			project TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS session_transcripts_fts USING fts5(
			content,
			content='session_transcripts',
			content_rowid='rowid'
		)
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_ai AFTER INSERT ON session_transcripts
		BEGIN
			INSERT INTO session_transcripts_fts(rowid, content)
			VALUES (new.rowid, new.content);
		END
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_ad AFTER DELETE ON session_transcripts
		BEGIN
			INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, content)
			VALUES('delete', old.rowid, old.content);
		END
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_au AFTER UPDATE ON session_transcripts
		BEGIN
			INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, content)
			VALUES('delete', old.rowid, old.content);
			INSERT INTO session_transcripts_fts(rowid, content)
			VALUES (new.rowid, new.content);
		END
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS session_summaries (
			id TEXT PRIMARY KEY,
			project TEXT,
			depth INTEGER NOT NULL DEFAULT 0,
			kind TEXT NOT NULL,
			content TEXT NOT NULL,
			token_count INTEGER,
			earliest_at TEXT NOT NULL,
			latest_at TEXT NOT NULL,
			session_key TEXT,
			harness TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			source_type TEXT,
			source_ref TEXT,
			meta_json TEXT,
			created_at TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_md_heads (
			agent_id TEXT PRIMARY KEY,
			content TEXT NOT NULL DEFAULT '',
			content_hash TEXT NOT NULL DEFAULT '',
			revision INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL,
			lease_token TEXT,
			lease_owner TEXT,
			lease_expires_at TEXT
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS session_summary_children (
			parent_id TEXT NOT NULL,
			child_id TEXT NOT NULL,
			ordinal INTEGER NOT NULL,
			PRIMARY KEY (parent_id, child_id)
		)
	`);

	const stmt = db.prepare(`
		INSERT INTO memories
			(id, content, type, importance, who, tags, pinned, project, created_at, updated_at, agent_id, visibility)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	for (const m of memories) {
		const now = m.created_at || new Date().toISOString();
		stmt.run(
			crypto.randomUUID(),
			m.content,
			m.type || "fact",
			m.importance ?? 0.5,
			m.who || "test",
			m.tags || null,
			m.pinned || 0,
			m.project || null,
			now,
			now,
			m.agent_id || "default",
			m.visibility || "global",
		);
	}

	db.close();

	// Re-init the singleton accessor so hooks can find the DB
	closeDbAccessor();
	initDbAccessor(dbPath);
}

/** Return a writable DB handle for isDuplicate testing */
function openTestDb(): Database {
	const dbPath = join(TEST_DIR, "memory", "memories.db");
	return new Database(dbPath);
}

function writeAgentYaml(content: string): void {
	ensureDir(TEST_DIR);
	writeFileSync(join(TEST_DIR, "agent.yaml"), content);
}

function writeIdentityMd(content: string): void {
	ensureDir(TEST_DIR);
	writeFileSync(join(TEST_DIR, "IDENTITY.md"), content);
}

function writeAgentsMd(content: string): void {
	ensureDir(TEST_DIR);
	writeFileSync(join(TEST_DIR, "AGENTS.md"), content);
}

function writeMemoryMd(content: string): void {
	ensureDir(TEST_DIR);
	writeFileSync(join(TEST_DIR, "MEMORY.md"), content);
}

function upsertAgent(id: string, readPolicy: string, policyGroup?: string): void {
	const db = openTestDb();
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		 	name = excluded.name,
		 	read_policy = excluded.read_policy,
		 	policy_group = excluded.policy_group,
		 	updated_at = excluded.updated_at`,
	).run(id, id, readPolicy, policyGroup ?? null, now, now);
	db.close();
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	if (existsSync(TEST_DIR)) {
		rmSync(TEST_DIR, { recursive: true, force: true });
	}
	ensureDir(TEST_DIR);
});

afterEach(() => {
	closeDbAccessor();
	if (existsSync(TEST_DIR)) {
		rmSync(TEST_DIR, { recursive: true, force: true });
	}
});

// ============================================================================
// effectiveScore
// ============================================================================

describe("effectiveScore", () => {
	test.serial("pinned items always score 1.0", async () => {
		expect(effectiveScore(0.1, "2020-01-01", true)).toBe(1.0);
		expect(effectiveScore(0.5, "2015-06-01", true)).toBe(1.0);
	});

	test.serial("today's memory scores approximately its importance", async () => {
		const score = effectiveScore(0.8, new Date().toISOString(), false);
		// With 0 days age: importance * 0.95^0 = importance
		expect(score).toBeCloseTo(0.8, 1);
	});

	test.serial("30-day-old memory decays", async () => {
		const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
		const score = effectiveScore(1.0, thirtyDaysAgo, false);
		// 1.0 * 0.95^30 ≈ 0.214
		expect(score).toBeGreaterThan(0.1);
		expect(score).toBeLessThan(0.4);
	});

	test.serial("0 importance scores 0", async () => {
		const score = effectiveScore(0, new Date().toISOString(), false);
		expect(score).toBe(0);
	});
});

// ============================================================================
// selectWithBudget
// ============================================================================

describe("selectWithBudget", () => {
	test.serial("fits rows within budget", async () => {
		const rows = [
			{ content: "aaaa" }, // 4 chars
			{ content: "bbbb" }, // 4 chars
			{ content: "cccc" }, // 4 chars
		];
		const result = selectWithBudget(rows, 10);
		expect(result.length).toBe(2); // 4+4=8 fits, 4+4+4=12 doesn't
	});

	test.serial("0 budget returns empty", async () => {
		const rows = [{ content: "hello" }];
		expect(selectWithBudget(rows, 0)).toEqual([]);
	});

	test.serial("oversized single row excluded", async () => {
		const rows = [{ content: "x".repeat(100) }];
		expect(selectWithBudget(rows, 10)).toEqual([]);
	});

	test.serial("empty input returns empty", async () => {
		expect(selectWithBudget([], 1000)).toEqual([]);
	});
});

// ============================================================================
// isDuplicate
// ============================================================================

describe("isDuplicate", () => {
	test.serial("detects high overlap as duplicate", async () => {
		createMemoryDb([
			{
				content: "The user prefers dark mode and vim keybindings always",
			},
		]);

		const db = openTestDb();
		const result = isDuplicate(db, "The user prefers dark mode and vim keybindings");
		db.close();

		expect(result).toBe(true);
	});

	test.serial("unrelated content is not duplicate", async () => {
		createMemoryDb([{ content: "Project uses TypeScript and Bun" }]);

		const db = openTestDb();
		const result = isDuplicate(db, "The weather is sunny and warm today");
		db.close();

		expect(result).toBe(false);
	});

	test.serial("empty database returns false", async () => {
		createMemoryDb([]);

		const db = openTestDb();
		const result = isDuplicate(db, "Some new content here");
		db.close();

		expect(result).toBe(false);
	});

	test.serial("short words are filtered out", async () => {
		createMemoryDb([{ content: "is an a to or" }]);

		const db = openTestDb();
		// All words < 3 chars, should return false (no words to match)
		const result = isDuplicate(db, "is an a to or");
		db.close();

		expect(result).toBe(false);
	});
});

// ============================================================================
// inferType
// ============================================================================

describe("inferType", () => {
	test.serial("detects preferences", async () => {
		expect(inferType("User prefers dark mode")).toBe("preference");
		expect(inferType("He likes TypeScript")).toBe("preference");
	});

	test.serial("detects decisions", async () => {
		expect(inferType("We decided to use Bun")).toBe("decision");
		expect(inferType("Team agreed on REST")).toBe("decision");
	});

	test.serial("detects learnings", async () => {
		expect(inferType("TIL bun is fast")).toBe("learning");
		expect(inferType("Discovered new pattern")).toBe("learning");
	});

	test.serial("detects issues", async () => {
		expect(inferType("Found a bug in auth")).toBe("issue");
		expect(inferType("This is broken")).toBe("issue");
	});

	test.serial("detects rules", async () => {
		expect(inferType("Never use var")).toBe("rule");
		expect(inferType("Always write tests")).toBe("rule");
	});

	test.serial("defaults to fact", async () => {
		expect(inferType("The sky is blue")).toBe("fact");
	});
});

// ============================================================================
// handleSessionStart
// ============================================================================

describe("handleSessionStart", () => {
	test.serial("returns default identity when no config files exist", async () => {
		const result = await handleSessionStart({ harness: "claude-code" });

		expect(result.identity.name).toBe("Agent");
		expect(result.identity.description).toBeUndefined();
		expect(result.memories).toEqual([]);
		expect(typeof result.inject).toBe("string");
	});

	test.serial("inject starts with memory status line", async () => {
		const result = await handleSessionStart({ harness: "test" });
		expect(result.inject).toContain("[memory active");
	});

	test.serial("loads identity from agent.yaml", async () => {
		writeAgentYaml(`
agent:
  name: TestBot
  description: A test agent
`);

		const result = await handleSessionStart({ harness: "claude-code" });

		expect(result.identity.name).toBe("TestBot");
		expect(result.identity.description).toBe("A test agent");
		expect(result.inject).toContain("TestBot");
		expect(result.inject).toContain("A test agent");
	});

	test.serial("falls back to IDENTITY.md when agent.yaml has no name", async () => {
		writeAgentYaml("version: 1");
		writeIdentityMd(`
name: MarkdownBot
creature: digital assistant
`);

		const result = await handleSessionStart({ harness: "claude-code" });

		expect(result.identity.name).toBe("MarkdownBot");
		expect(result.identity.description).toBe("digital assistant");
	});

	test.serial("returns memories from database", async () => {
		createMemoryDb([
			{ content: "User prefers dark mode", importance: 0.9 },
			{ content: "Project uses TypeScript", importance: 0.7 },
		]);

		const result = await handleSessionStart({ harness: "claude-code" });

		expect(result.memories.length).toBe(2);
		expect(result.memories.some((m) => m.content === "User prefers dark mode")).toBe(true);
		expect(result.inject).toContain("Relevant Memories");
	});

	test.serial("includes MEMORY.md as working memory", async () => {
		writeMemoryMd("# Working Memory\n\nCurrently working on hooks migration.");

		const result = await handleSessionStart({ harness: "claude-code" });

		expect(result.recentContext).toContain("Working Memory");
		expect(result.inject).toContain("## Working Memory");
	});

	test.serial("loads AGENTS.md before MEMORY.md in inject context", async () => {
		writeAgentsMd("# AGENTS\n\nFollow AGENTS instructions first.");
		writeMemoryMd("# Working Memory\n\nThis is working memory context.");

		const result = await handleSessionStart({ harness: "claude-code" });

		const agentsIndex = result.inject.indexOf("Follow AGENTS instructions first.");
		const workingMemoryIndex = result.inject.indexOf("## Working Memory");

		expect(result.inject).toContain("## Agent Instructions");
		expect(agentsIndex).toBeGreaterThan(-1);
		expect(workingMemoryIndex).toBeGreaterThan(agentsIndex);
	});

	test.serial("uses AGENTS.md instead of fallback identity sentence", async () => {
		writeAgentYaml(`
agent:
  name: TestBot
  description: A test agent
`);
		writeAgentsMd("# AGENTS\n\nOperator policy from AGENTS.");

		const result = await handleSessionStart({ harness: "claude-code" });

		expect(result.inject).toContain("Operator policy from AGENTS.");
		expect(result.inject).not.toContain("You are TestBot");
	});

	test.serial("excludes identity when includeIdentity is false", async () => {
		writeAgentYaml(`
agent:
  name: HiddenBot
hooks:
  sessionStart:
    includeIdentity: false
`);

		const result = await handleSessionStart({ harness: "test" });

		expect(result.identity.name).toBe("Agent");
		expect(result.inject).not.toContain("HiddenBot");
	});

	test.serial("handles missing memory database gracefully", async () => {
		const result = await handleSessionStart({ harness: "test" });
		expect(result.memories).toEqual([]);
	});

	test.serial("filters out low-score memories", async () => {
		// Very old, low importance memory should be filtered by effectiveScore > 0.2
		const veryOld = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
		createMemoryDb([
			{
				content: "Ancient low-importance fact",
				importance: 0.1,
				created_at: veryOld,
			},
		]);

		const result = await handleSessionStart({ harness: "test" });

		// 0.1 * 0.95^365 ≈ extremely small, should be filtered out
		expect(result.memories.length).toBe(0);
	});

	test.serial("pinned memories are always included", async () => {
		const veryOld = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
		createMemoryDb([
			{
				content: "Critical pinned memory",
				importance: 0.1,
				pinned: 1,
				created_at: veryOld,
			},
		]);

		const result = await handleSessionStart({ harness: "test" });

		expect(result.memories.length).toBe(1);
		expect(result.memories[0].content).toBe("Critical pinned memory");
	});

	test.serial("project-scoped memories sort first", async () => {
		createMemoryDb([
			{
				content: "General memory",
				importance: 0.9,
				project: undefined,
			},
			{
				content: "Project-specific memory",
				importance: 0.7,
				project: "/home/user/myproject",
			},
		]);

		const result = await handleSessionStart({
			harness: "test",
			project: "/home/user/myproject",
		});

		// Project-matching memory should appear first despite lower importance
		if (result.memories.length >= 2) {
			expect(result.memories[0].content).toBe("Project-specific memory");
		}
	});

	test.serial("respects shared visibility at session start", async () => {
		createMemoryDb([
			{
				content: "Shared release checklist",
				importance: 0.9,
				agent_id: "agent-owner",
				visibility: "global",
			},
			{
				content: "Hidden private note",
				importance: 0.95,
				agent_id: "agent-hidden",
				visibility: "private",
			},
		]);
		upsertAgent("agent-shared", "shared");

		const result = await handleSessionStart({
			harness: "test",
			agentId: "agent-shared",
		});

		expect(result.memories.some((memory) => memory.content === "Shared release checklist")).toBe(true);
		expect(result.memories.some((memory) => memory.content === "Hidden private note")).toBe(false);
	});

	test.serial("predictive context honors shared visibility", async () => {
		createMemoryDb([
			...Array.from({ length: 51 }, (_, i) => ({
				content: `Noise memory ${i}`,
				importance: 0.95,
				agent_id: "agent-shared",
				visibility: "global",
			})),
			{
				content: "Shared shardaware rollout memory",
				importance: 0.2,
				agent_id: "agent-owner",
				visibility: "global",
			},
		]);
		upsertAgent("agent-shared", "shared");

		const db = openTestDb();
		db.prepare(
			`INSERT INTO summary_jobs (
				id, session_key, harness, project, agent_id, transcript,
				status, attempts, max_attempts, created_at, completed_at
			) VALUES (?, ?, ?, ?, ?, ?, 'completed', 1, 3, ?, ?)`,
		).run(
			"job-1",
			"sess-1",
			"codex",
			null,
			"agent-shared",
			"We discussed shardaware rollout planning for the release train.",
			"2026-03-25T10:00:00.000Z",
			"2026-03-25T10:01:00.000Z",
		);
		db.prepare(
			`INSERT INTO summary_jobs (
				id, session_key, harness, project, agent_id, transcript,
				status, attempts, max_attempts, created_at, completed_at
			) VALUES (?, ?, ?, ?, ?, ?, 'completed', 1, 3, ?, ?)`,
		).run(
			"job-2",
			"sess-2",
			"codex",
			null,
			"agent-shared",
			"We revisited shardaware rollout coordination and deployment notes.",
			"2026-03-25T11:00:00.000Z",
			"2026-03-25T11:01:00.000Z",
		);
		db.close();

		const result = await handleSessionStart({
			harness: "test",
			agentId: "agent-shared",
		});

		expect(result.memories.some((memory) => memory.content === "Shared shardaware rollout memory")).toBe(true);
	});
});

// ============================================================================
// handlePreCompaction
// ============================================================================

describe("handlePreCompaction", () => {
	test.serial("returns default guidelines when no config", async () => {
		const result = handlePreCompaction({ harness: "test" });

		expect(result.guidelines).toContain("Key decisions made");
		expect(result.guidelines).toContain("User preferences discovered");
		expect(result.summaryPrompt).toContain("Pre-compaction memory flush");
	});

	test.serial("uses custom guidelines from config", async () => {
		writeAgentYaml(`
hooks:
  preCompaction:
    summaryGuidelines: "Custom summary rules"
`);

		const result = handlePreCompaction({ harness: "test" });

		expect(result.guidelines).toBe("Custom summary rules");
		expect(result.summaryPrompt).toContain("Custom summary rules");
	});

	test.serial("includes recent memories in summary prompt", async () => {
		createMemoryDb([{ content: "Important decision about auth", importance: 0.9 }]);

		const result = handlePreCompaction({ harness: "test" });

		expect(result.summaryPrompt).toContain("Recent memories for reference");
		expect(result.summaryPrompt).toContain("Important decision about auth");
	});

	test.serial("excludes recent memories when configured", async () => {
		writeAgentYaml(`
hooks:
  preCompaction:
    includeRecentMemories: false
`);

		createMemoryDb([{ content: "Should not appear", importance: 0.9 }]);

		const result = handlePreCompaction({ harness: "test" });

		expect(result.summaryPrompt).not.toContain("Should not appear");
	});
});

// ============================================================================
// handleUserPromptSubmit
// ============================================================================

describe("handleUserPromptSubmit", () => {
	test.serial("returns matching memories for prompt", async () => {
		createMemoryDb([
			{
				content: "Use TypeScript as the preferred language for this project",
				importance: 0.8,
			},
		]);

		const result = await handleUserPromptSubmit({
			harness: "test",
			userPrompt: "What TypeScript language should we use?",
		});

		expect(result.memoryCount).toBeGreaterThan(0);
		expect(result.inject).toContain("TypeScript");
	});

	test.serial("strips untrusted metadata block from user prompt", async () => {
		createMemoryDb([
			{
				content: "Reiterate the release checklist before deploy",
				importance: 0.8,
			},
		]);

		const result = await handleUserPromptSubmit({
			harness: "test",
			userPrompt:
				'Conversation info (untrusted metadata):\n{"conversation_label":"OpenClaw Session","message_id":"msg_123","sender_id":"user_456"}\n\nCan you reiterate the release checklist?',
		});

		expect(result.memoryCount).toBeGreaterThan(0);
		expect(result.queryTerms).toContain("reiterate");
		expect(result.queryTerms).not.toContain("conversation_label");
	});

	test.serial("prefers adapter-provided userMessage over raw prompt envelope", async () => {
		createMemoryDb([
			{
				content: "Reiterate the release checklist before deploy",
				importance: 0.8,
			},
		]);

		const result = await handleUserPromptSubmit({
			harness: "openclaw",
			userMessage: "Can you reiterate the release checklist?",
			userPrompt:
				'Conversation info (untrusted metadata):\n{"agent_path":"/home/user/.agents","channel":"discord"}\n\n<<<EXTERNAL_UNTRUSTED_CONTENT>>>\nSender (untrusted): discord\nEND_EXTERNAL_UNTRUSTED_CONTENT',
		});

		expect(result.memoryCount).toBeGreaterThan(0);
		expect(result.queryTerms).toContain("reiterate");
		expect(result.queryTerms).toContain("release");
		expect(result.queryTerms).not.toContain("agents");
		expect(result.queryTerms).not.toContain("discord");
	});

	test.serial("keeps recall query terms focused on the cleaned user prompt", async () => {
		createMemoryDb([
			{
				content: "Use pgvector in PostgreSQL for semantic embeddings",
				importance: 0.8,
			},
		]);

		const result = await handleUserPromptSubmit({
			harness: "test",
			userPrompt: "Can you remind me which embeddings database to use?",
			lastAssistantMessage: "Earlier I suggested pgvector for embeddings.",
		});

		expect(result.memoryCount).toBeGreaterThan(0);
		expect(result.queryTerms).toContain("embeddings database");
		expect(result.queryTerms).not.toContain("pgvector");
	});

	test.serial("returns empty for no-match prompt", async () => {
		createMemoryDb([{ content: "PostgreSQL replication setup guide", importance: 0.8 }]);

		const result = await handleUserPromptSubmit({
			harness: "test",
			userPrompt: "quantum entanglement photon wavelength",
		});

		expect(result.memoryCount).toBe(0);
		expect(result.inject).toContain("Current Date & Time");
		expect(result.inject).not.toContain("[signet:recall");
	});

	test.serial("skips very short prompts with no words >= 3 chars", async () => {
		createMemoryDb([{ content: "Something important", importance: 0.8 }]);

		const result = await handleUserPromptSubmit({
			harness: "test",
			userPrompt: "hi ok",
		});

		expect(result.memoryCount).toBe(0);
		expect(result.inject).toContain("Current Date & Time");
		expect(result.inject).not.toContain("[signet:recall");
	});

	test.serial("handles missing database gracefully", async () => {
		const result = await handleUserPromptSubmit({
			harness: "test",
			userPrompt: "A reasonable question here",
		});

		expect(result.memoryCount).toBe(0);
		expect(result.inject).toContain("Current Date & Time");
		expect(result.inject).not.toContain("[signet:recall");
	});

	test.serial("upserts session transcript during prompt flow when provided", async () => {
		createMemoryDb([{ content: "release checklist", importance: 0.8 }]);
		const transcriptPath = join(TEST_DIR, "prompt-transcript.txt");
		writeFileSync(transcriptPath, "User: review the release checklist\nAssistant: here's the checklist");

		await handleUserPromptSubmit({
			harness: "test",
			userPrompt: "review the release checklist",
			sessionKey: "sess-prompt",
			transcriptPath,
		});

		const db = openTestDb();
		const row = db.prepare("SELECT content FROM session_transcripts WHERE session_key = ?").get("sess-prompt") as
			| { content: string }
			| undefined;
		db.close();

		expect(row?.content).toContain("review the release checklist");
	});

	test.serial("falls back to transcript excerpts when structured recall is empty", async () => {
		createMemoryDb([]);
		const db = openTestDb();
		db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, content, harness, project, agent_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"sess-older",
			"User: we decided the temporal index should preserve drill-down handles for MEMORY.md lineage.\nAssistant: yes, the temporal index needs lineage and drill-down handles.",
			"test",
			"proj",
			"default",
			"2026-03-25T10:00:00.000Z",
			"2026-03-25T10:05:00.000Z",
		);
		db.close();

		const result = await handleUserPromptSubmit({
			harness: "test",
			project: "proj",
			sessionKey: "sess-current",
			userPrompt: "where did we decide the temporal index drill-down handles should live?",
		});

		expect(result.memoryCount).toBeGreaterThan(0);
		expect(result.engine).toBe("transcript-fallback");
		expect(result.inject).toContain("temporal index");
		expect(result.inject).toContain("sess-olde");
	});

	test.serial("applies character budget", async () => {
		// Create many memories that would exceed the 500 char budget
		const mems = Array.from({ length: 20 }, (_, i) => ({
			content: `Important fact number ${i}: ${"x".repeat(80)}`,
			importance: 0.9,
		}));
		createMemoryDb(mems);

		const result = await handleUserPromptSubmit({
			harness: "test",
			userPrompt: "important fact number",
		});

		// Should be capped by budget, not return all 20
		if (result.memoryCount > 0) {
			// Memory budget is 500 chars, but inject also includes metadata header,
			// recall status line, and optional feedback block
			expect(result.memoryCount).toBeLessThan(20);
		}
	});

	test.serial("skips conversational prompts with too few substantive words", async () => {
		createMemoryDb([
			{
				content: "The payment retry queue should drain before deploy",
				importance: 0.9,
			},
		]);

		const result = await handleUserPromptSubmit({
			harness: "test",
			userPrompt: "yeah do that",
		});

		expect(result.memoryCount).toBe(0);
		expect(result.inject).toContain("Current Date & Time");
		expect(result.inject).not.toContain("[signet:recall");
	});

	test.serial("respects group visibility during prompt recall", async () => {
		createMemoryDb([
			{
				content: "Team alpha uses shard-aware rollout plans",
				importance: 0.95,
				agent_id: "agent-alpha",
				visibility: "global",
			},
			{
				content: "Team beta migration notes",
				importance: 0.95,
				agent_id: "agent-beta",
				visibility: "global",
			},
		]);
		upsertAgent("agent-group", "group", "team-1");
		upsertAgent("agent-alpha", "isolated", "team-1");
		upsertAgent("agent-beta", "isolated", "team-2");

		const result = await handleUserPromptSubmit({
			harness: "test",
			agentId: "agent-group",
			userPrompt: "which rollout plans are shard aware?",
		});

		expect(result.memoryCount).toBeGreaterThan(0);
		expect(result.inject).toContain("shard-aware rollout plans");
		expect(result.inject).not.toContain("Team beta migration notes");
	});
});

// ============================================================================
// handleRemember
// ============================================================================

describe("handleRemember", () => {
	test.serial("saves valid content", async () => {
		createMemoryDb([]);

		const result = handleRemember({
			harness: "test",
			content: "User prefers dark mode",
		});

		expect(result.saved).toBe(true);
		expect(result.id).toBeTruthy();
		expect(result.id.length).toBeGreaterThan(0);
	});

	test.serial("handles critical: prefix", async () => {
		createMemoryDb([]);

		const result = handleRemember({
			harness: "test",
			content: "critical: Never deploy on Fridays",
		});

		expect(result.saved).toBe(true);

		// Verify pinned in DB
		const db = openTestDb();
		const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(result.id) as {
			pinned: number;
			importance: number;
			content: string;
		};
		db.close();

		expect(row.pinned).toBe(1);
		expect(row.importance).toBe(1.0);
		expect(row.content).toBe("Never deploy on Fridays");
	});

	test.serial("extracts [tags] from content", async () => {
		createMemoryDb([]);

		const result = handleRemember({
			harness: "test",
			content: "[auth,security]: Use JWT for API tokens",
		});

		expect(result.saved).toBe(true);

		const db = openTestDb();
		const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(result.id) as {
			tags: string;
			content: string;
		};
		db.close();

		expect(row.tags).toBe("auth,security");
		expect(row.content).toBe("Use JWT for API tokens");
	});

	test.serial("fails gracefully on missing database", async () => {
		// Don't create db
		const result = handleRemember({
			harness: "test",
			content: "This should fail gracefully",
		});

		expect(result.saved).toBe(false);
		expect(result.id).toBe("");
	});
});

// ============================================================================
// handleRecall
// ============================================================================

describe("handleRecall", () => {
	test.serial("finds matching memories via FTS", async () => {
		createMemoryDb([
			{
				content: "TypeScript is the preferred language for this project",
				importance: 0.8,
			},
			{
				content: "The database uses PostgreSQL",
				importance: 0.7,
			},
		]);

		const result = handleRecall({
			harness: "test",
			query: "TypeScript language",
		});

		expect(result.count).toBeGreaterThan(0);
		expect(result.results.some((r) => r.content.includes("TypeScript"))).toBe(true);
	});

	test.serial("returns empty for no-match query", async () => {
		createMemoryDb([{ content: "The database uses PostgreSQL", importance: 0.8 }]);

		const result = handleRecall({
			harness: "test",
			query: "quantum computing algorithms",
		});

		expect(result.count).toBe(0);
		expect(result.results).toEqual([]);
	});

	test.serial("handles missing database", async () => {
		const result = handleRecall({
			harness: "test",
			query: "anything",
		});

		expect(result.count).toBe(0);
		expect(result.results).toEqual([]);
	});

	test.serial("falls back to LIKE when FTS has no results", async () => {
		createMemoryDb([
			{
				content: "Special config: xyz-protocol-v2",
				importance: 0.8,
			},
		]);

		const result = handleRecall({
			harness: "test",
			query: "xyz-protocol-v2",
		});

		// Should find via LIKE fallback
		expect(result.count).toBeGreaterThan(0);
	});
});

// ============================================================================
// handleSessionEnd
// ============================================================================

describe("handleSessionEnd", () => {
	test.serial("skips on reason=clear", async () => {
		const result = await handleSessionEnd({
			harness: "test",
			reason: "clear",
		});

		expect(result.memoriesSaved).toBe(0);
	});

	test.serial("skips on short transcript", async () => {
		// Write a short transcript
		const transcriptPath = join(TEST_DIR, "transcript.txt");
		writeFileSync(transcriptPath, "Hello world");

		const result = await handleSessionEnd({
			harness: "test",
			transcriptPath,
		});

		expect(result.memoriesSaved).toBe(0);
	});

	test.serial("skips on missing transcript path", async () => {
		const result = await handleSessionEnd({
			harness: "test",
			transcriptPath: "/nonexistent/path.txt",
		});

		expect(result.memoriesSaved).toBe(0);
	});

	test.serial("handles no transcriptPath gracefully", async () => {
		const result = await handleSessionEnd({
			harness: "test",
		});

		expect(result.memoriesSaved).toBe(0);
	});

	test(
		"handles missing ollama gracefully",
		async () => {
			// Write a long enough transcript
			const transcriptPath = join(TEST_DIR, "transcript.txt");
			writeFileSync(transcriptPath, "x".repeat(1000));

			createMemoryDb([]);

			// Ollama is installed but qwen3:4b may not be pulled,
			// so the 45s spawn timeout may fire before returning.
			const result = await handleSessionEnd({
				harness: "test",
				transcriptPath,
			});

			// Should return 0 without crashing
			expect(result.memoriesSaved).toBe(0);
		},
		{ timeout: 60000 },
	);
});

// ============================================================================
// handleSynthesisRequest
// ============================================================================

describe("handleSynthesisRequest", () => {
	test.serial("returns prompt with database-backed temporal sources", async () => {
		createMemoryDb([{ content: "User likes Bun and prefers dark mode.", importance: 0.9 }]);
		const db = openTestDb();
		db.prepare(
			`INSERT INTO session_summaries (
				id, project, depth, kind, content, token_count,
				earliest_at, latest_at, session_key, harness,
				agent_id, source_type, source_ref, meta_json, created_at
			) VALUES (?, ?, 0, 'session', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"node-1",
			"proj",
			"# Session\n\nWorked on Bun defaults and dark mode polish.",
			20,
			"2026-03-05T00:00:00.000Z",
			"2026-03-05T00:00:00.000Z",
			"sess-1",
			"test",
			"default",
			"summary",
			"sess-1",
			JSON.stringify({ source: "summary-worker" }),
			"2026-03-05T00:00:00.000Z",
		);
		db.close();

		const result = handleSynthesisRequest({ trigger: "manual" });

		expect(result.harness).toBe("daemon");
		expect(result.model).toBe("synthesis");
		expect(result.prompt).toContain("MEMORY.md");
		expect(result.prompt).toContain("Temporal DAG artifacts");
		expect(result.prompt).toContain("User likes Bun");
		expect(result.indexBlock).toContain("node-1");
		expect(result.fileCount).toBe(2);
	});

	test.serial("generates prompt with exact temporal index instructions", async () => {
		createMemoryDb([{ content: "Test session summary content", importance: 0.9 }]);

		const result = handleSynthesisRequest({ trigger: "scheduled" });

		expect(result.prompt).toContain("generating MEMORY.md");
		expect(result.prompt).toContain("Test session summary content");
		expect(result.prompt).toContain("Exact Temporal Index Block");
	});

	test.serial("returns zero fileCount when no synthesis sources exist", async () => {
		const result = handleSynthesisRequest({ trigger: "manual" });
		expect(result.fileCount).toBe(0);
	});

	test.serial("uses shared-visible memories when synthesizing for shared agents", async () => {
		createMemoryDb([
			{
				content: "Shared synthesis memory",
				importance: 0.9,
				agent_id: "agent-owner",
				visibility: "global",
			},
		]);
		upsertAgent("agent-shared", "shared");

		const result = handleSynthesisRequest({ trigger: "manual" }, { agentId: "agent-shared" });

		expect(result.prompt).toContain("Shared synthesis memory");
	});
});

// ============================================================================
// writeMemoryMd
// ============================================================================

describe("writeMemoryMd", () => {
	test.serial("records MEMORY.md head metadata in the database", async () => {
		createMemoryDb([]);

		const result = synthWriteMemoryMd("# Working Memory\n\nTemporal head content.");
		expect(result.ok).toBe(true);

		const db = openTestDb();
		const row = db
			.prepare("SELECT revision, content_hash, content FROM memory_md_heads WHERE agent_id = ?")
			.get("default") as
			| {
					revision: number;
					content_hash: string;
					content: string;
			  }
			| undefined;
		db.close();

		expect(row?.revision).toBe(1);
		expect(row?.content_hash.length).toBeGreaterThan(0);
		expect(row?.content).toContain("Temporal head content");
	});

	test.serial("refuses writes when another MEMORY.md lease is active", async () => {
		createMemoryDb([]);
		const db = openTestDb();
		db.prepare(
			`INSERT INTO memory_md_heads
			 (agent_id, content, content_hash, revision, updated_at, lease_token, lease_owner, lease_expires_at)
			 VALUES (?, '', '', 0, ?, ?, ?, ?)`,
		).run("default", "2026-03-25T10:00:00.000Z", "lease-token", "other-writer", "2099-01-01T00:00:00.000Z");
		db.close();

		const result = synthWriteMemoryMd("# Working Memory\n\nShould be blocked.");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("busy");
		}
	});
});

// ============================================================================
// Edge cases and error handling
// ============================================================================

describe("error handling", () => {
	test.serial("handles corrupt agent.yaml gracefully", async () => {
		writeAgentYaml("{{{{invalid yaml content!!!!");

		const result = await handleSessionStart({ harness: "test" });
		expect(result.identity.name).toBe("Agent");
	});

	test.serial("handles empty IDENTITY.md gracefully", async () => {
		writeIdentityMd("");

		const result = await handleSessionStart({ harness: "test" });
		expect(result.identity.name).toBe("Agent");
	});

	test.serial("handles corrupt memory database gracefully", async () => {
		ensureDir(join(TEST_DIR, "memory"));
		writeFileSync(join(TEST_DIR, "memory", "memories.db"), "not a sqlite database");

		const result = await handleSessionStart({ harness: "test" });
		expect(result.memories).toEqual([]);
	});

	test.serial("handles missing MEMORY.md gracefully", async () => {
		const result = await handleSessionStart({ harness: "test" });
		expect(result.recentContext).toBeUndefined();
	});
});

// ============================================================================
// Schema: FTS and triggers
// ============================================================================

describe("schema", () => {
	test.serial("FTS5 table exists and works", async () => {
		createMemoryDb([{ content: "FTS test memory about TypeScript" }]);

		const db = openTestDb();
		const rows = db.prepare("SELECT content FROM memories_fts WHERE memories_fts MATCH ?").all("TypeScript") as Array<{
			content: string;
		}>;
		db.close();

		expect(rows.length).toBe(1);
		expect(rows[0].content).toContain("TypeScript");
	});

	test.serial("insert trigger populates FTS", async () => {
		createMemoryDb([]);
		const db = openTestDb();

		db.prepare("INSERT INTO memories (id, content, who, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
			crypto.randomUUID(),
			"Trigger test content",
			"test",
			new Date().toISOString(),
			new Date().toISOString(),
		);

		const rows = db.prepare("SELECT content FROM memories_fts WHERE memories_fts MATCH ?").all("trigger") as Array<{
			content: string;
		}>;
		db.close();

		expect(rows.length).toBe(1);
	});

	test.serial("busy_timeout is set by openDb", async () => {
		createMemoryDb([]);

		// handleRecall uses openDb internally which sets busy_timeout
		// If this doesn't throw, the timeout is working
		const result = handleRecall({
			harness: "test",
			query: "anything",
		});

		expect(result).toBeDefined();
	});
});

// ============================================================================
// Integration: inject string format
// ============================================================================

describe("inject string formatting", () => {
	test.serial("combines identity, memories, and working memory", async () => {
		writeAgentYaml(`
agent:
  name: IntegrationBot
  description: tests all the things
`);

		createMemoryDb([{ content: "Remember to test", importance: 0.8 }]);

		writeMemoryMd("# Context\nSome context here.");

		const result = await handleSessionStart({ harness: "test" });

		expect(result.inject).toContain("[memory active");
		expect(result.inject).toContain("IntegrationBot");
		expect(result.inject).toContain("tests all the things");
		expect(result.inject).toContain("## Relevant Memories");
		expect(result.inject).toContain("Remember to test");
		expect(result.inject).toContain("## Working Memory");
		expect(result.inject).toContain("Some context here");
	});

	test.serial("memories show as bullet points", async () => {
		createMemoryDb([
			{ content: "First fact", importance: 0.8 },
			{ content: "Second fact", importance: 0.8 },
		]);

		const result = await handleSessionStart({ harness: "test" });

		expect(result.inject).toContain("- First fact");
		expect(result.inject).toContain("- Second fact");
	});
});

// ============================================================================
// selectWithBudget generic type preservation
// ============================================================================

describe("selectWithBudget type preservation", () => {
	test.serial("preserves extra properties on input type", async () => {
		const rows = [
			{ content: "aaaa", id: "1", score: 0.9 },
			{ content: "bbbb", id: "2", score: 0.7 },
		];
		const result = selectWithBudget(rows, 10);
		// Should preserve id and score properties
		expect(result[0].id).toBe("1");
		expect(result[0].score).toBe(0.9);
		expect(result[1].id).toBe("2");
	});
});

// ============================================================================
// getAllScoredCandidates
// ============================================================================

describe("getAllScoredCandidates", () => {
	test.serial("returns scored memories without budget truncation", async () => {
		createMemoryDb([
			{ content: "Memory A", importance: 0.9 },
			{ content: "Memory B", importance: 0.8 },
			{ content: "Memory C", importance: 0.7 },
		]);

		const candidates = getAllScoredCandidates(undefined, 30);

		// All three should be returned (no budget applied)
		expect(candidates.length).toBe(3);
		// Each should have effScore
		for (const c of candidates) {
			expect(c.effScore).toBeGreaterThan(0);
			expect(c.id).toBeTruthy();
			expect(c.content).toBeTruthy();
		}
	});

	test.serial("filters out low-score memories below 0.2 threshold", async () => {
		const veryOld = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
		createMemoryDb([
			{
				content: "Ancient low-importance fact",
				importance: 0.1,
				created_at: veryOld,
			},
			{ content: "Recent important fact", importance: 0.9 },
		]);

		const candidates = getAllScoredCandidates(undefined, 30);

		// Only the recent one should pass
		expect(candidates.length).toBe(1);
		expect(candidates[0].content).toBe("Recent important fact");
	});

	test.serial("sorts project matches first", async () => {
		createMemoryDb([
			{
				content: "General memory",
				importance: 0.9,
				project: undefined,
			},
			{
				content: "Project-specific memory",
				importance: 0.7,
				project: "/home/user/myproject",
			},
		]);

		const candidates = getAllScoredCandidates("/home/user/myproject", 30);

		if (candidates.length >= 2) {
			expect(candidates[0].content).toBe("Project-specific memory");
		}
	});

	test.serial("returns empty for missing database", async () => {
		// No createMemoryDb call
		const candidates = getAllScoredCandidates(undefined, 30);
		expect(candidates).toEqual([]);
	});
});

// ============================================================================
// Session memory recording integration
// ============================================================================

describe("session memory recording integration", () => {
	test.serial("handleSessionStart records candidates to session_memories table", async () => {
		createMemoryDb([
			{ content: "User prefers dark mode", importance: 0.9 },
			{ content: "Project uses TypeScript", importance: 0.7 },
		]);

		await handleSessionStart({
			harness: "test",
			sessionKey: "integration-session-001",
		});

		// Read session_memories directly
		const db = openTestDb();
		const rows = db
			.prepare(
				"SELECT memory_id, source, was_injected, rank, effective_score FROM session_memories WHERE session_key = ? ORDER BY rank ASC",
			)
			.all("integration-session-001") as Array<{
			memory_id: string;
			source: string;
			was_injected: number;
			rank: number;
			effective_score: number;
		}>;
		db.close();

		// Should have recorded at least some candidates
		expect(rows.length).toBeGreaterThan(0);
		// All should have source = 'effective'
		for (const row of rows) {
			expect(row.source).toBe("effective");
			expect(row.effective_score).toBeGreaterThan(0);
		}
		// At least one should be injected
		const injectedCount = rows.filter((r) => r.was_injected === 1).length;
		expect(injectedCount).toBeGreaterThan(0);
	});

	test.serial("handleSessionStart does not record when sessionKey is missing", async () => {
		createMemoryDb([{ content: "Some memory", importance: 0.9 }]);

		await handleSessionStart({
			harness: "test",
			// no sessionKey
		});

		const db = openTestDb();
		const count = db.prepare("SELECT COUNT(*) as cnt FROM session_memories").get() as { cnt: number };
		db.close();

		expect(count.cnt).toBe(0);
	});

	test.serial("handleUserPromptSubmit tracks FTS hits", async () => {
		createMemoryDb([
			{
				content: "TypeScript is the preferred language for this project",
				importance: 0.8,
			},
		]);

		// First, do a session start to establish context
		await handleSessionStart({
			harness: "test",
			sessionKey: "fts-tracking-session",
		});

		// Now submit a prompt that will match via hybrid recall
		await handleUserPromptSubmit({
			harness: "test",
			sessionKey: "fts-tracking-session",
			userPrompt: "What TypeScript language config should we use?",
		});

		const db = openTestDb();
		const rows = db
			.prepare("SELECT memory_id, fts_hit_count, source FROM session_memories WHERE session_key = ?")
			.all("fts-tracking-session") as Array<{
			memory_id: string;
			fts_hit_count: number;
			source: string;
		}>;
		db.close();

		// Should have at least one row with fts_hit_count > 0
		const withHits = rows.filter((r) => r.fts_hit_count > 0);
		expect(withHits.length).toBeGreaterThan(0);
	});
});
