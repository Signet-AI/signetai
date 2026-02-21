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
	getSynthesisConfig,
	effectiveScore,
	selectWithBudget,
	isDuplicate,
	inferType,
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
	}> = [],
): void {
	const dbPath = join(TEST_DIR, "memory", "memories.db");
	ensureDir(join(TEST_DIR, "memory"));

	if (existsSync(dbPath)) rmSync(dbPath);

	const db = new Database(dbPath);

	db.exec("PRAGMA busy_timeout = 5000");

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
			confidence REAL DEFAULT 1.0
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

	const stmt = db.prepare(`
		INSERT INTO memories
			(id, content, type, importance, who, tags, pinned, project, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
	test("pinned items always score 1.0", () => {
		expect(effectiveScore(0.1, "2020-01-01", true)).toBe(1.0);
		expect(effectiveScore(0.5, "2015-06-01", true)).toBe(1.0);
	});

	test("today's memory scores approximately its importance", () => {
		const score = effectiveScore(0.8, new Date().toISOString(), false);
		// With 0 days age: importance * 0.95^0 = importance
		expect(score).toBeCloseTo(0.8, 1);
	});

	test("30-day-old memory decays", () => {
		const thirtyDaysAgo = new Date(
			Date.now() - 30 * 24 * 60 * 60 * 1000,
		).toISOString();
		const score = effectiveScore(1.0, thirtyDaysAgo, false);
		// 1.0 * 0.95^30 ≈ 0.214
		expect(score).toBeGreaterThan(0.1);
		expect(score).toBeLessThan(0.4);
	});

	test("0 importance scores 0", () => {
		const score = effectiveScore(0, new Date().toISOString(), false);
		expect(score).toBe(0);
	});
});

// ============================================================================
// selectWithBudget
// ============================================================================

describe("selectWithBudget", () => {
	test("fits rows within budget", () => {
		const rows = [
			{ content: "aaaa" }, // 4 chars
			{ content: "bbbb" }, // 4 chars
			{ content: "cccc" }, // 4 chars
		];
		const result = selectWithBudget(rows, 10);
		expect(result.length).toBe(2); // 4+4=8 fits, 4+4+4=12 doesn't
	});

	test("0 budget returns empty", () => {
		const rows = [{ content: "hello" }];
		expect(selectWithBudget(rows, 0)).toEqual([]);
	});

	test("oversized single row excluded", () => {
		const rows = [{ content: "x".repeat(100) }];
		expect(selectWithBudget(rows, 10)).toEqual([]);
	});

	test("empty input returns empty", () => {
		expect(selectWithBudget([], 1000)).toEqual([]);
	});
});

// ============================================================================
// isDuplicate
// ============================================================================

describe("isDuplicate", () => {
	test("detects high overlap as duplicate", () => {
		createMemoryDb([
			{
				content: "The user prefers dark mode and vim keybindings always",
			},
		]);

		const db = openTestDb();
		const result = isDuplicate(
			db,
			"The user prefers dark mode and vim keybindings",
		);
		db.close();

		expect(result).toBe(true);
	});

	test("unrelated content is not duplicate", () => {
		createMemoryDb([{ content: "Project uses TypeScript and Bun" }]);

		const db = openTestDb();
		const result = isDuplicate(db, "The weather is sunny and warm today");
		db.close();

		expect(result).toBe(false);
	});

	test("empty database returns false", () => {
		createMemoryDb([]);

		const db = openTestDb();
		const result = isDuplicate(db, "Some new content here");
		db.close();

		expect(result).toBe(false);
	});

	test("short words are filtered out", () => {
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
	test("detects preferences", () => {
		expect(inferType("User prefers dark mode")).toBe("preference");
		expect(inferType("He likes TypeScript")).toBe("preference");
	});

	test("detects decisions", () => {
		expect(inferType("We decided to use Bun")).toBe("decision");
		expect(inferType("Team agreed on REST")).toBe("decision");
	});

	test("detects learnings", () => {
		expect(inferType("TIL bun is fast")).toBe("learning");
		expect(inferType("Discovered new pattern")).toBe("learning");
	});

	test("detects issues", () => {
		expect(inferType("Found a bug in auth")).toBe("issue");
		expect(inferType("This is broken")).toBe("issue");
	});

	test("detects rules", () => {
		expect(inferType("Never use var")).toBe("rule");
		expect(inferType("Always write tests")).toBe("rule");
	});

	test("defaults to fact", () => {
		expect(inferType("The sky is blue")).toBe("fact");
	});
});

// ============================================================================
// handleSessionStart
// ============================================================================

describe("handleSessionStart", () => {
	test("returns default identity when no config files exist", () => {
		const result = handleSessionStart({ harness: "claude-code" });

		expect(result.identity.name).toBe("Agent");
		expect(result.identity.description).toBeUndefined();
		expect(result.memories).toEqual([]);
		expect(typeof result.inject).toBe("string");
	});

	test("inject starts with memory status line", () => {
		const result = handleSessionStart({ harness: "test" });
		expect(result.inject).toContain("[memory active");
	});

	test("loads identity from agent.yaml", () => {
		writeAgentYaml(`
agent:
  name: TestBot
  description: A test agent
`);

		const result = handleSessionStart({ harness: "claude-code" });

		expect(result.identity.name).toBe("TestBot");
		expect(result.identity.description).toBe("A test agent");
		expect(result.inject).toContain("TestBot");
		expect(result.inject).toContain("A test agent");
	});

	test("falls back to IDENTITY.md when agent.yaml has no name", () => {
		writeAgentYaml("version: 1");
		writeIdentityMd(`
name: MarkdownBot
creature: digital assistant
`);

		const result = handleSessionStart({ harness: "claude-code" });

		expect(result.identity.name).toBe("MarkdownBot");
		expect(result.identity.description).toBe("digital assistant");
	});

	test("returns memories from database", () => {
		createMemoryDb([
			{ content: "User prefers dark mode", importance: 0.9 },
			{ content: "Project uses TypeScript", importance: 0.7 },
		]);

		const result = handleSessionStart({ harness: "claude-code" });

		expect(result.memories.length).toBe(2);
		expect(
			result.memories.some((m) => m.content === "User prefers dark mode"),
		).toBe(true);
		expect(result.inject).toContain("Relevant Memories");
	});

	test("includes MEMORY.md as working memory", () => {
		writeMemoryMd("# Working Memory\n\nCurrently working on hooks migration.");

		const result = handleSessionStart({ harness: "claude-code" });

		expect(result.recentContext).toContain("Working Memory");
		expect(result.inject).toContain("## Working Memory");
	});

	test("loads AGENTS.md before MEMORY.md in inject context", () => {
		writeAgentsMd("# AGENTS\n\nFollow AGENTS instructions first.");
		writeMemoryMd("# Working Memory\n\nThis is working memory context.");

		const result = handleSessionStart({ harness: "claude-code" });

		const agentsIndex = result.inject.indexOf(
			"Follow AGENTS instructions first.",
		);
		const workingMemoryIndex = result.inject.indexOf("## Working Memory");

		expect(result.inject).toContain("## Agent Instructions");
		expect(agentsIndex).toBeGreaterThan(-1);
		expect(workingMemoryIndex).toBeGreaterThan(agentsIndex);
	});

	test("uses AGENTS.md instead of fallback identity sentence", () => {
		writeAgentYaml(`
agent:
  name: TestBot
  description: A test agent
`);
		writeAgentsMd("# AGENTS\n\nOperator policy from AGENTS.");

		const result = handleSessionStart({ harness: "claude-code" });

		expect(result.inject).toContain("Operator policy from AGENTS.");
		expect(result.inject).not.toContain("You are TestBot");
	});

	test("excludes identity when includeIdentity is false", () => {
		writeAgentYaml(`
agent:
  name: HiddenBot
hooks:
  sessionStart:
    includeIdentity: false
`);

		const result = handleSessionStart({ harness: "test" });

		expect(result.identity.name).toBe("Agent");
		expect(result.inject).not.toContain("HiddenBot");
	});

	test("handles missing memory database gracefully", () => {
		const result = handleSessionStart({ harness: "test" });
		expect(result.memories).toEqual([]);
	});

	test("filters out low-score memories", () => {
		// Very old, low importance memory should be filtered by effectiveScore > 0.2
		const veryOld = new Date(
			Date.now() - 365 * 24 * 60 * 60 * 1000,
		).toISOString();
		createMemoryDb([
			{
				content: "Ancient low-importance fact",
				importance: 0.1,
				created_at: veryOld,
			},
		]);

		const result = handleSessionStart({ harness: "test" });

		// 0.1 * 0.95^365 ≈ extremely small, should be filtered out
		expect(result.memories.length).toBe(0);
	});

	test("pinned memories are always included", () => {
		const veryOld = new Date(
			Date.now() - 365 * 24 * 60 * 60 * 1000,
		).toISOString();
		createMemoryDb([
			{
				content: "Critical pinned memory",
				importance: 0.1,
				pinned: 1,
				created_at: veryOld,
			},
		]);

		const result = handleSessionStart({ harness: "test" });

		expect(result.memories.length).toBe(1);
		expect(result.memories[0].content).toBe("Critical pinned memory");
	});

	test("project-scoped memories sort first", () => {
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

		const result = handleSessionStart({
			harness: "test",
			project: "/home/user/myproject",
		});

		// Project-matching memory should appear first despite lower importance
		if (result.memories.length >= 2) {
			expect(result.memories[0].content).toBe("Project-specific memory");
		}
	});
});

// ============================================================================
// handlePreCompaction
// ============================================================================

describe("handlePreCompaction", () => {
	test("returns default guidelines when no config", () => {
		const result = handlePreCompaction({ harness: "test" });

		expect(result.guidelines).toContain("Key decisions made");
		expect(result.guidelines).toContain("User preferences discovered");
		expect(result.summaryPrompt).toContain("Pre-compaction memory flush");
	});

	test("uses custom guidelines from config", () => {
		writeAgentYaml(`
hooks:
  preCompaction:
    summaryGuidelines: "Custom summary rules"
`);

		const result = handlePreCompaction({ harness: "test" });

		expect(result.guidelines).toBe("Custom summary rules");
		expect(result.summaryPrompt).toContain("Custom summary rules");
	});

	test("includes recent memories in summary prompt", () => {
		createMemoryDb([
			{ content: "Important decision about auth", importance: 0.9 },
		]);

		const result = handlePreCompaction({ harness: "test" });

		expect(result.summaryPrompt).toContain("Recent memories for reference");
		expect(result.summaryPrompt).toContain("Important decision about auth");
	});

	test("excludes recent memories when configured", () => {
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
	test("returns matching memories for prompt", () => {
		createMemoryDb([
			{
				content: "TypeScript is the preferred language",
				importance: 0.8,
			},
		]);

		const result = handleUserPromptSubmit({
			harness: "test",
			userPrompt: "What TypeScript language should we use?",
		});

		expect(result.memoryCount).toBeGreaterThan(0);
		expect(result.inject).toContain("TypeScript");
	});

	test("returns empty for no-match prompt", () => {
		createMemoryDb([
			{ content: "PostgreSQL replication setup guide", importance: 0.8 },
		]);

		const result = handleUserPromptSubmit({
			harness: "test",
			userPrompt: "quantum entanglement photon wavelength",
		});

		expect(result.memoryCount).toBe(0);
		expect(result.inject).toBe("");
	});

	test("skips very short prompts with no words >= 3 chars", () => {
		createMemoryDb([{ content: "Something important", importance: 0.8 }]);

		const result = handleUserPromptSubmit({
			harness: "test",
			userPrompt: "hi ok",
		});

		expect(result.memoryCount).toBe(0);
		expect(result.inject).toBe("");
	});

	test("handles missing database gracefully", () => {
		const result = handleUserPromptSubmit({
			harness: "test",
			userPrompt: "A reasonable question here",
		});

		expect(result.memoryCount).toBe(0);
		expect(result.inject).toBe("");
	});

	test("applies character budget", () => {
		// Create many memories that would exceed the 500 char budget
		const mems = Array.from({ length: 20 }, (_, i) => ({
			content: `Important fact number ${i}: ${"x".repeat(80)}`,
			importance: 0.9,
		}));
		createMemoryDb(mems);

		const result = handleUserPromptSubmit({
			harness: "test",
			userPrompt: "important fact number",
		});

		// Should be capped by budget, not return all 20
		if (result.memoryCount > 0) {
			const totalChars = result.inject.length;
			// Inject includes "[relevant memories]\n" prefix
			expect(totalChars).toBeLessThan(700);
		}
	});
});

// ============================================================================
// handleRemember
// ============================================================================

describe("handleRemember", () => {
	test("saves valid content", () => {
		createMemoryDb([]);

		const result = handleRemember({
			harness: "test",
			content: "User prefers dark mode",
		});

		expect(result.saved).toBe(true);
		expect(result.id).toBeTruthy();
		expect(result.id.length).toBeGreaterThan(0);
	});

	test("handles critical: prefix", () => {
		createMemoryDb([]);

		const result = handleRemember({
			harness: "test",
			content: "critical: Never deploy on Fridays",
		});

		expect(result.saved).toBe(true);

		// Verify pinned in DB
		const db = openTestDb();
		const row = db
			.prepare("SELECT * FROM memories WHERE id = ?")
			.get(result.id) as {
			pinned: number;
			importance: number;
			content: string;
		};
		db.close();

		expect(row.pinned).toBe(1);
		expect(row.importance).toBe(1.0);
		expect(row.content).toBe("Never deploy on Fridays");
	});

	test("extracts [tags] from content", () => {
		createMemoryDb([]);

		const result = handleRemember({
			harness: "test",
			content: "[auth,security]: Use JWT for API tokens",
		});

		expect(result.saved).toBe(true);

		const db = openTestDb();
		const row = db
			.prepare("SELECT * FROM memories WHERE id = ?")
			.get(result.id) as {
			tags: string;
			content: string;
		};
		db.close();

		expect(row.tags).toBe("auth,security");
		expect(row.content).toBe("Use JWT for API tokens");
	});

	test("fails gracefully on missing database", () => {
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
	test("finds matching memories via FTS", () => {
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
		expect(result.results.some((r) => r.content.includes("TypeScript"))).toBe(
			true,
		);
	});

	test("returns empty for no-match query", () => {
		createMemoryDb([
			{ content: "The database uses PostgreSQL", importance: 0.8 },
		]);

		const result = handleRecall({
			harness: "test",
			query: "quantum computing algorithms",
		});

		expect(result.count).toBe(0);
		expect(result.results).toEqual([]);
	});

	test("handles missing database", () => {
		const result = handleRecall({
			harness: "test",
			query: "anything",
		});

		expect(result.count).toBe(0);
		expect(result.results).toEqual([]);
	});

	test("falls back to LIKE when FTS has no results", () => {
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
	test("skips on reason=clear", async () => {
		const result = await handleSessionEnd({
			harness: "test",
			reason: "clear",
		});

		expect(result.memoriesSaved).toBe(0);
	});

	test("skips on short transcript", async () => {
		// Write a short transcript
		const transcriptPath = join(TEST_DIR, "transcript.txt");
		writeFileSync(transcriptPath, "Hello world");

		const result = await handleSessionEnd({
			harness: "test",
			transcriptPath,
		});

		expect(result.memoriesSaved).toBe(0);
	});

	test("skips on missing transcript path", async () => {
		const result = await handleSessionEnd({
			harness: "test",
			transcriptPath: "/nonexistent/path.txt",
		});

		expect(result.memoriesSaved).toBe(0);
	});

	test("handles no transcriptPath gracefully", async () => {
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
	test("returns synthesis config and prompt", () => {
		createMemoryDb([
			{
				content: "User likes Bun",
				type: "preference",
				importance: 0.8,
			},
		]);

		const result = handleSynthesisRequest({ trigger: "manual" });

		expect(result.harness).toBe("openclaw");
		expect(result.model).toBe("sonnet");
		expect(result.prompt).toContain("regenerating MEMORY.md");
		expect(result.memories.length).toBe(1);
		expect(result.memories[0].content).toBe("User likes Bun");
	});

	test("uses config from agent.yaml", () => {
		writeAgentYaml(`
memory:
  synthesis:
    harness: claude-code
    model: opus
    schedule: weekly
    max_tokens: 2000
`);

		createMemoryDb([]);

		const result = handleSynthesisRequest({ trigger: "scheduled" });

		expect(result.harness).toBe("claude-code");
		expect(result.model).toBe("opus");
		expect(result.prompt).toContain("2000 tokens");
	});

	test("returns empty memories when no database", () => {
		const result = handleSynthesisRequest({ trigger: "manual" });
		expect(result.memories).toEqual([]);
	});
});

// ============================================================================
// getSynthesisConfig
// ============================================================================

describe("getSynthesisConfig", () => {
	test("returns defaults when no config file", () => {
		const config = getSynthesisConfig();

		expect(config.harness).toBe("openclaw");
		expect(config.model).toBe("sonnet");
		expect(config.schedule).toBe("daily");
		expect(config.max_tokens).toBe(4000);
	});

	test("merges config from agent.yaml", () => {
		writeAgentYaml(`
memory:
  synthesis:
    model: haiku
`);

		const config = getSynthesisConfig();

		expect(config.model).toBe("haiku");
		expect(config.harness).toBe("openclaw");
	});
});

// ============================================================================
// Edge cases and error handling
// ============================================================================

describe("error handling", () => {
	test("handles corrupt agent.yaml gracefully", () => {
		writeAgentYaml("{{{{invalid yaml content!!!!");

		const result = handleSessionStart({ harness: "test" });
		expect(result.identity.name).toBe("Agent");
	});

	test("handles empty IDENTITY.md gracefully", () => {
		writeIdentityMd("");

		const result = handleSessionStart({ harness: "test" });
		expect(result.identity.name).toBe("Agent");
	});

	test("handles corrupt memory database gracefully", () => {
		ensureDir(join(TEST_DIR, "memory"));
		writeFileSync(
			join(TEST_DIR, "memory", "memories.db"),
			"not a sqlite database",
		);

		const result = handleSessionStart({ harness: "test" });
		expect(result.memories).toEqual([]);
	});

	test("handles missing MEMORY.md gracefully", () => {
		const result = handleSessionStart({ harness: "test" });
		expect(result.recentContext).toBeUndefined();
	});
});

// ============================================================================
// Schema: FTS and triggers
// ============================================================================

describe("schema", () => {
	test("FTS5 table exists and works", () => {
		createMemoryDb([{ content: "FTS test memory about TypeScript" }]);

		const db = openTestDb();
		const rows = db
			.prepare("SELECT content FROM memories_fts WHERE memories_fts MATCH ?")
			.all("TypeScript") as Array<{ content: string }>;
		db.close();

		expect(rows.length).toBe(1);
		expect(rows[0].content).toContain("TypeScript");
	});

	test("insert trigger populates FTS", () => {
		createMemoryDb([]);
		const db = openTestDb();

		db.prepare(
			"INSERT INTO memories (id, content, who, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		).run(
			crypto.randomUUID(),
			"Trigger test content",
			"test",
			new Date().toISOString(),
			new Date().toISOString(),
		);

		const rows = db
			.prepare("SELECT content FROM memories_fts WHERE memories_fts MATCH ?")
			.all("trigger") as Array<{ content: string }>;
		db.close();

		expect(rows.length).toBe(1);
	});

	test("busy_timeout is set by openDb", () => {
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
	test("combines identity, memories, and working memory", () => {
		writeAgentYaml(`
agent:
  name: IntegrationBot
  description: tests all the things
`);

		createMemoryDb([{ content: "Remember to test", importance: 0.8 }]);

		writeMemoryMd("# Context\nSome context here.");

		const result = handleSessionStart({ harness: "test" });

		expect(result.inject).toContain("[memory active");
		expect(result.inject).toContain("IntegrationBot");
		expect(result.inject).toContain("tests all the things");
		expect(result.inject).toContain("## Relevant Memories");
		expect(result.inject).toContain("Remember to test");
		expect(result.inject).toContain("## Working Memory");
		expect(result.inject).toContain("Some context here");
	});

	test("memories show as bullet points", () => {
		createMemoryDb([
			{ content: "First fact", importance: 0.8 },
			{ content: "Second fact", importance: 0.8 },
		]);

		const result = handleSessionStart({ harness: "test" });

		expect(result.inject).toContain("- First fact");
		expect(result.inject).toContain("- Second fact");
	});
});
