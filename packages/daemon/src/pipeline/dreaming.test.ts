/**
 * Tests for dreaming memory consolidation.
 *
 * Tests the threshold check, state management, mutation parsing/application,
 * and pass lifecycle -- all without an LLM (the generate function is mocked).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DreamingConfig } from "@signet/core";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor } from "../db-accessor";
import {
	addDreamingTokens,
	getDreamingPasses,
	getDreamingState,
	recordDreamingFailure,
	runDreamingPass,
	shouldTriggerDreaming,
} from "./dreaming";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const AGENT = "default";

function defaultCfg(overrides?: Partial<DreamingConfig>): DreamingConfig {
	return {
		enabled: true,
		tokenThreshold: 100_000,
		maxInputTokens: 32_000,
		maxOutputTokens: 16_000,
		timeout: 300_000,
		backfillOnFirstRun: true,
		...overrides,
	};
}

/** Minimal DbAccessor wrapper around an in-memory Database. */
function wrapDb(db: Database): DbAccessor {
	return {
		withReadDb<T>(fn: (db: Database) => T): T {
			return fn(db);
		},
		withWriteTx<T>(fn: (db: Database) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db);
				db.exec("COMMIT");
				return result;
			} catch (e) {
				db.exec("ROLLBACK");
				throw e;
			}
		},
	} as unknown as DbAccessor;
}

function seedEntity(db: Database, id: string, name: string, type = "concept"): void {
	const canonical = name.trim().toLowerCase().replace(/\s+/g, " ");
	db.prepare(
		`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
	).run(id, name, canonical, type, AGENT);
}

function seedAspect(db: Database, id: string, entityId: string, name: string): void {
	const canonical = name.trim().toLowerCase().replace(/\s+/g, " ");
	db.prepare(
		`INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 0.5, datetime('now'), datetime('now'))`,
	).run(id, entityId, AGENT, name, canonical);
}

function seedAttribute(db: Database, id: string, aspectId: string, content: string, kind = "attribute"): void {
	const normalized = content.trim().toLowerCase();
	db.prepare(
		`INSERT INTO entity_attributes (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, 0.8, 0.5, 'active', datetime('now'), datetime('now'))`,
	).run(id, aspectId, AGENT, kind, content, normalized);
}

function seedSummary(db: Database, id: string, content: string, tokens: number): void {
	db.prepare(
		`INSERT INTO session_summaries (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
		 VALUES (?, ?, ?, ?, 0, 'session', 'summary', datetime('now'), datetime('now'), datetime('now'))`,
	).run(id, AGENT, content, tokens);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dreaming", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = wrapDb(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("state management", () => {
		it("returns zero state for new agent", () => {
			const state = getDreamingState(accessor, AGENT);
			expect(state.tokensSinceLastPass).toBe(0);
			expect(state.lastPassAt).toBeNull();
			expect(state.lastPassMode).toBeNull();
		});

		it("accumulates tokens", () => {
			addDreamingTokens(accessor, AGENT, 5000);
			addDreamingTokens(accessor, AGENT, 3000);
			const state = getDreamingState(accessor, AGENT);
			expect(state.tokensSinceLastPass).toBe(8000);
		});

		it("scopes tokens to agent_id", () => {
			addDreamingTokens(accessor, AGENT, 5000);
			addDreamingTokens(accessor, "other", 9000);
			expect(getDreamingState(accessor, AGENT).tokensSinceLastPass).toBe(5000);
			expect(getDreamingState(accessor, "other").tokensSinceLastPass).toBe(9000);
		});
	});

	describe("threshold check", () => {
		it("does not trigger when disabled", () => {
			addDreamingTokens(accessor, AGENT, 999_999);
			expect(shouldTriggerDreaming(accessor, defaultCfg({ enabled: false }), AGENT)).toBe(false);
		});

		it("does not trigger below threshold", () => {
			addDreamingTokens(accessor, AGENT, 50_000);
			expect(
				shouldTriggerDreaming(accessor, defaultCfg({ tokenThreshold: 100_000, backfillOnFirstRun: false }), AGENT),
			).toBe(false);
		});

		it("triggers at threshold", () => {
			addDreamingTokens(accessor, AGENT, 100_000);
			expect(shouldTriggerDreaming(accessor, defaultCfg({ tokenThreshold: 100_000 }), AGENT)).toBe(true);
		});

		it("triggers on first run with backfill", () => {
			// No tokens accumulated, but backfillOnFirstRun is true and no pass has run
			expect(shouldTriggerDreaming(accessor, defaultCfg({ backfillOnFirstRun: true }), AGENT)).toBe(true);
		});

		it("does not trigger on first run without backfill", () => {
			expect(shouldTriggerDreaming(accessor, defaultCfg({ backfillOnFirstRun: false }), AGENT)).toBe(false);
		});

		it("backs off on consecutive failures", () => {
			// First failure: requires 2x threshold
			addDreamingTokens(accessor, AGENT, 100_000);
			recordDreamingFailure(accessor, AGENT);
			const cfg = defaultCfg({ tokenThreshold: 100_000, backfillOnFirstRun: false });
			// At 1 failure, need 2x threshold (200k) — current 100k is below
			expect(shouldTriggerDreaming(accessor, cfg, AGENT)).toBe(false);
			// Add more tokens to exceed 2x
			addDreamingTokens(accessor, AGENT, 100_001);
			expect(shouldTriggerDreaming(accessor, cfg, AGENT)).toBe(true);
		});

		it("backs off first-run failures requiring threshold tokens", () => {
			// First-run with backfill but has failures — requires tokenThreshold
			recordDreamingFailure(accessor, AGENT);
			const cfg = defaultCfg({ backfillOnFirstRun: true, tokenThreshold: 100_000 });
			// No tokens: would normally trigger on first run, but failure backoff blocks
			expect(shouldTriggerDreaming(accessor, cfg, AGENT)).toBe(false);
			// Add tokens to reach threshold
			addDreamingTokens(accessor, AGENT, 100_000);
			expect(shouldTriggerDreaming(accessor, cfg, AGENT)).toBe(true);
		});
	});

	describe("pass lifecycle", () => {
		it("completes pass with no data gracefully", async () => {
			const generate = async () => JSON.stringify({ mutations: [], summary: "Nothing to do" });

			const tmpDir = "/tmp";
			const result = await runDreamingPass(accessor, generate, defaultCfg(), tmpDir, AGENT, "incremental");
			expect(result.applied).toBe(0);
			expect(result.failed).toBe(0);
			expect(result.summary).toBe("No new summaries or entities to process");
		});

		it("records pass history", async () => {
			// Seed some data so we get past the empty check
			seedEntity(db, "ent-1", "TypeScript", "tool");
			seedAspect(db, "asp-1", "ent-1", "usage");
			seedAttribute(db, "attr-1", "asp-1", "TypeScript is used for all backend code");

			const generate = async () => JSON.stringify({ mutations: [], summary: "Reviewed graph, no changes needed" });

			await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "compact");
			const passes = getDreamingPasses(accessor, AGENT);
			expect(passes.length).toBe(1);
			expect(passes[0]?.mode).toBe("compact");
			expect(passes[0]?.status).toBe("completed");
		});

		it("applies create_entity mutations", async () => {
			seedSummary(db, "s-1", "User started working on a Rust project called Nexus", 500);

			const generate = async () =>
				JSON.stringify({
					mutations: [
						{
							op: "create_entity",
							name: "Nexus",
							type: "project",
							aspects: [{ name: "overview", attributes: ["A Rust project the user is working on"] }],
						},
					],
					summary: "Created Nexus project entity",
				});

			const result = await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "incremental");
			expect(result.applied).toBe(1);
			expect(result.failed).toBe(0);

			// Verify entity was created
			const entity = db
				.prepare("SELECT name, entity_type FROM entities WHERE agent_id = ? AND canonical_name = ?")
				.get(AGENT, "nexus") as { name: string; entity_type: string } | undefined;
			expect(entity).toBeDefined();
			expect(entity?.entity_type).toBe("project");
		});

		it("applies merge_entities mutations", async () => {
			seedEntity(db, "ent-1", "TypeScript", "tool");
			seedEntity(db, "ent-2", "TS Lang", "tool");
			seedAspect(db, "asp-1", "ent-1", "usage");
			seedAttribute(db, "attr-1", "asp-1", "TypeScript is the primary language");
			seedAspect(db, "asp-2", "ent-2", "features");
			seedAttribute(db, "attr-2", "asp-2", "TypeScript has great type inference");

			const generate = async () =>
				JSON.stringify({
					mutations: [
						{
							op: "merge_entities",
							source: ["TS Lang"],
							target: "TypeScript",
							reason: "Same language, different name",
						},
					],
					summary: "Merged duplicate TypeScript entities",
				});

			const result = await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "compact");
			expect(result.applied).toBe(1);

			// Source entity should be gone
			const remaining = db.prepare("SELECT COUNT(*) as count FROM entities WHERE agent_id = ?").get(AGENT) as {
				count: number;
			};
			expect(remaining.count).toBe(1);

			// Surviving entity should have both aspects
			const aspects = db
				.prepare("SELECT COUNT(*) as count FROM entity_aspects WHERE entity_id = ? AND agent_id = ?")
				.all("ent-1", AGENT) as Array<{ count: number }>;
			expect(aspects[0]?.count).toBeGreaterThanOrEqual(1);
		});

		it("skips merge_entities when source entity is pinned (invariant parity with delete)", async () => {
			seedEntity(db, "ent-1", "TypeScript", "tool");
			seedEntity(db, "ent-2", "PinnedAlias", "tool");
			db.prepare("UPDATE entities SET pinned = 1 WHERE id = ?").run("ent-2");

			const generate = async () =>
				JSON.stringify({
					mutations: [
						{
							op: "merge_entities",
							source: ["PinnedAlias"],
							target: "TypeScript",
							reason: "Same thing",
						},
					],
					summary: "Tried to merge pinned source",
				});

			const result = await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "compact");
			// Source was pinned so no merge should have occurred
			expect(result.applied).toBe(0);

			// Pinned entity must still exist
			const pinned = db.prepare("SELECT id FROM entities WHERE id = 'ent-2' AND agent_id = ?").get(AGENT);
			expect(pinned).toBeDefined();
		});

		it("applies delete_entity mutations but skips pinned", async () => {
			seedEntity(db, "ent-1", "JunkEntity", "unknown");
			seedEntity(db, "ent-2", "PinnedEntity", "concept");
			db.prepare("UPDATE entities SET pinned = 1 WHERE id = ?").run("ent-2");

			const generate = async () =>
				JSON.stringify({
					mutations: [
						{ op: "delete_entity", name: "JunkEntity", reason: "Meaningless fragment" },
						{ op: "delete_entity", name: "PinnedEntity", reason: "Should not be deleted" },
					],
					summary: "Cleaned up junk",
				});

			const result = await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "compact");
			expect(result.applied).toBe(1);
			expect(result.skipped).toBe(1);

			const remaining = db.prepare("SELECT name FROM entities WHERE agent_id = ?").all(AGENT) as Array<{
				name: string;
			}>;
			expect(remaining.length).toBe(1);
			expect(remaining[0]?.name).toBe("PinnedEntity");
		});

		it("skips delete_entity when entity owns active constraint attributes (invariant 5)", async () => {
			// Unpinned entity, but it has a constraint attribute — must not be deleted
			seedEntity(db, "ent-1", "ConstrainedEntity", "concept");
			const aspId = "asp-c1";
			seedAspect(db, aspId, "ent-1", "system constraints");
			db.prepare(
				`INSERT INTO entity_attributes (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
				 VALUES ('attr-c1', ?, ?, 'constraint', 'Must not be deleted', 'must not be deleted', 1.0, 1.0, 'active', datetime('now'), datetime('now'))`,
			).run(aspId, AGENT);

			const generate = async () =>
				JSON.stringify({
					mutations: [{ op: "delete_entity", name: "ConstrainedEntity", reason: "Seems unused" }],
					summary: "Attempt to delete constrained entity",
				});

			const result = await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "compact");
			expect(result.applied).toBe(0);
			expect(result.skipped).toBe(1);

			// Entity must still exist
			const still = db.prepare("SELECT id FROM entities WHERE id = 'ent-1' AND agent_id = ?").get(AGENT);
			expect(still).toBeDefined();
		});

		it("applies supersede_attribute mutations", async () => {
			seedEntity(db, "ent-1", "Redis", "tool");
			seedAspect(db, "asp-1", "ent-1", "usage");
			seedAttribute(db, "attr-1", "asp-1", "Redis is used for caching only");

			const generate = async () =>
				JSON.stringify({
					mutations: [
						{
							op: "supersede_attribute",
							entity: "Redis",
							aspect: "usage",
							old: "Redis is used for caching only",
							new: "Redis is used for caching and session storage",
						},
					],
					summary: "Updated Redis usage",
				});

			const result = await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "incremental");
			expect(result.applied).toBe(1);

			// Old attribute should be superseded
			const old = db.prepare("SELECT status FROM entity_attributes WHERE id = ?").get("attr-1") as { status: string };
			expect(old.status).toBe("superseded");

			// New attribute should exist
			const newAttr = db
				.prepare("SELECT content FROM entity_attributes WHERE aspect_id = ? AND agent_id = ? AND status = 'active'")
				.get("asp-1", AGENT) as { content: string } | undefined;
			expect(newAttr?.content).toBe("Redis is used for caching and session storage");
		});

		it("does not supersede constraints", async () => {
			seedEntity(db, "ent-1", "Auth", "system");
			seedAspect(db, "asp-1", "ent-1", "rules");
			seedAttribute(db, "attr-1", "asp-1", "All endpoints require authentication", "constraint");

			const generate = async () =>
				JSON.stringify({
					mutations: [
						{
							op: "supersede_attribute",
							entity: "Auth",
							aspect: "rules",
							old: "All endpoints require authentication",
							new: "Some endpoints are public",
						},
					],
					summary: "Tried to change constraint",
				});

			const result = await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "incremental");
			expect(result.applied).toBe(0);
			expect(result.skipped).toBe(1); // constraint was protected

			// Constraint should still be active
			const attr = db.prepare("SELECT status, kind FROM entity_attributes WHERE id = ?").get("attr-1") as {
				status: string;
				kind: string;
			};
			expect(attr.status).toBe("active");
			expect(attr.kind).toBe("constraint");
		});

		it("records failed pass on LLM error", async () => {
			seedEntity(db, "ent-1", "Test", "concept");

			const generate = async (): Promise<string> => {
				throw new Error("LLM timeout");
			};

			await expect(runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "incremental")).rejects.toThrow(
				"LLM timeout",
			);

			const passes = getDreamingPasses(accessor, AGENT);
			expect(passes.length).toBe(1);
			expect(passes[0]?.status).toBe("failed");
			expect(passes[0]?.error).toBe("LLM timeout");
		});

		it("handles malformed LLM response gracefully", async () => {
			seedEntity(db, "ent-1", "Test", "concept");

			const generate = async () => "this is not json at all!!!";

			await expect(runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "incremental")).rejects.toThrow();

			const passes = getDreamingPasses(accessor, AGENT);
			expect(passes[0]?.status).toBe("failed");
		});

		it("resets token counter after successful pass", async () => {
			addDreamingTokens(accessor, AGENT, 120_000);
			seedEntity(db, "ent-1", "Test", "concept");

			const generate = async () => JSON.stringify({ mutations: [], summary: "Nothing changed" });

			await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "incremental");

			const state = getDreamingState(accessor, AGENT);
			expect(state.tokensSinceLastPass).toBe(0);
			expect(state.lastPassAt).not.toBeNull();
			expect(state.lastPassMode).toBe("incremental");
		});

		it("applies update_aspect mutations (additive — does not replace existing attributes)", async () => {
			seedEntity(db, "ent-1", "Node.js", "tool");
			seedAspect(db, "asp-1", "ent-1", "usage");
			seedAttribute(db, "attr-1", "asp-1", "Used for API servers");
			seedSummary(db, "s-1", "Node.js is also used for CLI tooling", 200);

			const generate = async () =>
				JSON.stringify({
					mutations: [
						{
							op: "update_aspect",
							entity: "Node.js",
							aspect: "usage",
							attributes: ["Used for CLI tooling"],
						},
					],
					summary: "Added CLI usage to Node.js",
				});

			const result = await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "incremental");
			expect(result.applied).toBe(1);

			// Original attribute must still exist (additive operation)
			const original = db.prepare("SELECT status FROM entity_attributes WHERE id = 'attr-1'").get() as
				| { status: string }
				| undefined;
			expect(original?.status).toBe("active");

			// New attribute should have been added
			const count = db
				.prepare(
					"SELECT COUNT(*) as c FROM entity_attributes WHERE aspect_id = ? AND agent_id = ? AND status = 'active'",
				)
				.get("asp-1", AGENT) as { c: number };
			expect(count.c).toBe(2);
		});

		it("applies delete_aspect mutations (hard-deletes aspect and attributes)", async () => {
			seedEntity(db, "ent-1", "Webpack", "tool");
			seedAspect(db, "asp-1", "ent-1", "legacy config");
			seedAttribute(db, "attr-1", "asp-1", "Used webpack.config.js with CommonJS");
			seedAttribute(db, "attr-2", "asp-1", "Migrated to Vite");

			const generate = async () =>
				JSON.stringify({
					mutations: [{ op: "delete_aspect", entity: "Webpack", aspect: "legacy config", reason: "Outdated info" }],
					summary: "Removed stale Webpack config aspect",
				});

			const result = await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "compact");
			expect(result.applied).toBe(1);

			// Aspect row must be gone (hard delete)
			const aspect = db.prepare("SELECT id FROM entity_aspects WHERE id = 'asp-1' AND agent_id = ?").get(AGENT);
			expect(aspect).toBeNull();

			// All attribute rows must be gone (hard delete)
			const attrCount = db
				.prepare("SELECT COUNT(*) as c FROM entity_attributes WHERE aspect_id = 'asp-1' AND agent_id = ?")
				.get(AGENT) as { c: number };
			expect(attrCount.c).toBe(0);
		});

		it("applies create_attribute mutations", async () => {
			seedEntity(db, "ent-1", "Bun", "tool");
			seedAspect(db, "asp-1", "ent-1", "features");

			const generate = async () =>
				JSON.stringify({
					mutations: [
						{
							op: "create_attribute",
							entity: "Bun",
							aspect: "features",
							content: "Built-in SQLite driver with bun:sqlite",
						},
					],
					summary: "Added Bun SQLite feature",
				});

			const result = await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "incremental");
			expect(result.applied).toBe(1);

			const attr = db
				.prepare(
					"SELECT content, status FROM entity_attributes WHERE aspect_id = ? AND agent_id = ? AND status = 'active'",
				)
				.get("asp-1", AGENT) as { content: string; status: string } | undefined;
			expect(attr?.content).toBe("Built-in SQLite driver with bun:sqlite");
		});

		it("applies delete_attribute mutations (soft-delete)", async () => {
			seedEntity(db, "ent-1", "React", "tool");
			seedAspect(db, "asp-1", "ent-1", "usage");
			seedAttribute(db, "attr-1", "asp-1", "React class components are used throughout");

			const generate = async () =>
				JSON.stringify({
					mutations: [
						{
							op: "delete_attribute",
							entity: "React",
							aspect: "usage",
							content: "React class components are used throughout",
							reason: "Migrated to hooks",
						},
					],
					summary: "Removed stale React class component reference",
				});

			const result = await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "compact");
			expect(result.applied).toBe(1);

			// Attribute row should still exist with status=deleted (soft delete)
			const attr = db.prepare("SELECT status FROM entity_attributes WHERE id = 'attr-1'").get() as
				| { status: string }
				| undefined;
			expect(attr?.status).toBe("deleted");
		});
	});
});
