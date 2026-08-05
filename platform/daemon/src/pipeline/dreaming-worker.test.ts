import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DreamingConfig } from "@signet/core";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor } from "../db-accessor";
import { DREAMING_AGENT_PROMPT } from "./dreaming";
import { getDreamingWorkerAgentIds, shouldDeferDreamingSweep, startDreamingWorker } from "./dreaming-worker";

function defaultCfg(overrides?: Partial<DreamingConfig>): DreamingConfig {
	return {
		enabled: true,
		tokenThreshold: 100_000,
		maxInterval: 6 * 60 * 60 * 1_000,
		maxInputTokens: 32_000,
		maxOutputTokens: 16_000,
		timeout: 300_000,
		backfillOnFirstRun: false,
		...overrides,
	};
}

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

describe("dreaming worker agent scope", () => {
	let db: Database;
	let accessor: DbAccessor;
	let agentsDir: string;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = wrapDb(db);
		agentsDir = mkdtempSync(join(tmpdir(), "dreaming-worker-"));
	});

	afterEach(() => {
		rmSync(agentsDir, { recursive: true, force: true });
		db.close();
	});

	it("discovers registered and data-bearing agents for periodic checks", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO agents (id, name, read_policy, created_at, updated_at)
			 VALUES (?, ?, 'isolated', ?, ?)`,
		).run("noam", "noam", now, now);
		db.prepare(
			`INSERT INTO memories (id, content, type, agent_id, created_at, updated_at, updated_by)
			 VALUES (?, ?, 'fact', ?, ?, ?, 'test')`,
		).run("mem-agent", "agent-owned memory", "memory-agent", now, now);
		db.prepare(
			`INSERT INTO session_summaries (id, agent_id, content, token_count, depth, kind, earliest_at, latest_at, created_at)
			 VALUES (?, ?, ?, 10, 0, 'session', ?, ?, ?)`,
		).run("summary-agent", "summary-agent", "agent-owned summary", now, now, now);
		db.prepare(
			`INSERT INTO dreaming_state (agent_id, tokens_since_last_pass)
			 VALUES (?, 500)`,
		).run("state-agent");
		db.prepare(
			`INSERT INTO memory_artifacts
			 (agent_id, source_path, source_sha256, source_kind, session_id, session_token, captured_at, content, updated_at, is_deleted)
			 VALUES (?, 'sources/agent.md', 'artifact-agent', 'source_markdown', 'artifact-session', 'artifact-token', ?, 'agent artifact', ?, 0)`,
		).run("artifact-agent", now, now);
		db.prepare(
			`INSERT INTO session_transcripts (session_key, content, harness, agent_id, created_at, updated_at)
			 VALUES ('transcript-agent', 'agent transcript', 'pi', ?, ?, ?)`,
		).run("transcript-agent", now, now);

		expect(getDreamingWorkerAgentIds(accessor, "default")).toEqual([
			"artifact-agent",
			"default",
			"memory-agent",
			"noam",
			"state-agent",
			"summary-agent",
			"transcript-agent",
		]);
	});

	it("defers a sweep while the shared queue health watermark is exceeded", () => {
		const now = new Date().toISOString();
		for (let index = 0; index <= 50; index += 1) {
			db.prepare(
				`INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at)
				 VALUES (?, ?, 'index', 'pending', ?, ?)`,
			).run(`pressure-${index}`, `memory-${index}`, now, now);
		}
		expect(shouldDeferDreamingSweep(accessor)).toBe(true);
	});

	it("writes manual async trigger passes to the requested agent", async () => {
		const worker = startDreamingWorker(accessor, defaultCfg(), agentsDir, "default");
		try {
			const passId = worker.triggerAsync("incremental", "noam");
			await worker.activePass;

			const row = db.prepare("SELECT agent_id, status, mode FROM dreaming_passes WHERE id = ?").get(passId) as {
				agent_id: string;
				status: string;
				mode: string;
			};
			expect(row).toEqual({ agent_id: "noam", status: "completed", mode: "incremental" });
			expect(
				db.prepare("SELECT COUNT(*) AS count FROM dreaming_passes WHERE agent_id = 'default'").get() as {
					count: number;
				},
			).toEqual({ count: 0 });
		} finally {
			worker.stop();
		}
	});

	it("seeds deterministic hygiene attention for legacy graph rows at worker startup", () => {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES ('legacy-husk', 'Legacy Husk', 'legacy husk', 'project', 'default', 5, datetime('now'), datetime('now'))`,
		).run();
		const worker = startDreamingWorker(accessor, defaultCfg(), agentsDir, "default");
		try {
			expect(db.prepare("SELECT kind, subject_ref FROM dreaming_attention WHERE agent_id = ?").get("default")).toEqual({
				kind: "hygiene",
				subject_ref: "entity:legacy-husk",
			});
		} finally {
			worker.stop();
		}
	});

	it("runs one universe pass over every agent scope and keeps semantic rows agent-isolated (#946)", async () => {
		// Behavioral regression: one Dreaming pass covers the whole install.
		// The pass addresses each agent scope via the per-call agentId on its
		// tools; every write is attributed to the agent named on the call, and
		// no cross-agent evidence leaks into another scope's derived graph.
		const ALPHA = "alpha";
		const BETA = "beta";
		const alphaEvidence = "Alpha is building the Apex platform.";
		const betaEvidence = "Beta is building the Zenith platform.";

		// Seed distinct episodic evidence for each agent.
		db.prepare(
			`INSERT INTO session_summaries
			 (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
			 VALUES ('summary-alpha', ?, ?, 10, 0, 'session', 'summary',
			         datetime('now'), datetime('now'), datetime('now'))`,
		).run(ALPHA, alphaEvidence);
		db.prepare(
			`INSERT INTO session_summaries
			 (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
			 VALUES ('summary-beta', ?, ?, 10, 0, 'session', 'summary',
			         datetime('now'), datetime('now'), datetime('now'))`,
		).run(BETA, betaEvidence);

		// Deterministic provider: one universe pass consolidates BOTH scopes
		// in a single invocation, each apply batch carrying the agentId whose
		// graph it maintains and citing that scope's own evidence.
		const seenPrompts: string[] = [];
		const executorFactory = (agentId: string) => ({
			async run(input: {
				prompt: string;
				tools: ReadonlyArray<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
			}) {
				seenPrompts.push(input.prompt);
				const apply = input.tools.find((tool) => tool.name === "apply_ontology_ops");
				if (!apply) throw new Error("Missing apply_ontology_ops");
				await apply.execute("call", {
					agentId: ALPHA,
					operations: [
						{
							operation: "create_entity",
							payload: { name: "Apex", type: "project" },
							reason: "The evidence identifies the project.",
							confidence: 0.9,
							evidence: [
								{
									source_ref: "summary:summary-alpha",
									source_kind: "summary",
									source_id: "summary-alpha",
									quote: alphaEvidence,
								},
							],
						},
					],
				});
				await apply.execute("call", {
					agentId: BETA,
					operations: [
						{
							operation: "create_entity",
							payload: { name: "Zenith", type: "project" },
							reason: "The evidence identifies the project.",
							confidence: 0.9,
							evidence: [
								{
									source_ref: "summary:summary-beta",
									source_kind: "summary",
									source_id: "summary-beta",
									quote: betaEvidence,
								},
							],
						},
					],
				});
				return { summary: "Consolidated both scopes" };
			},
		});

		const worker = startDreamingWorker(
			accessor,
			defaultCfg({ tokenThreshold: 1, backfillOnFirstRun: true }),
			agentsDir,
			"default",
			{ executorFactory },
		);
		try {
			// One trigger = one pass covering every discovered scope.
			await worker.trigger("incremental", "default");

			// A single pass row on the primary agent.
			const passes = db
				.prepare("SELECT agent_id, status, mode FROM dreaming_passes ORDER BY created_at")
				.all() as Array<{ agent_id: string; status: string; mode: string }>;
			expect(passes).toEqual([{ agent_id: "default", status: "completed", mode: "incremental" }]);

			// One invocation, and the prompt names every scope in the install.
			expect(seenPrompts).toHaveLength(1);
			expect(seenPrompts[0]).toContain(DREAMING_AGENT_PROMPT);
			expect(seenPrompts[0]).toContain("<agent_scopes>");
			expect(seenPrompts[0]).toContain(ALPHA);
			expect(seenPrompts[0]).toContain(BETA);

			// Semantic rows are agent-isolated: each agent only owns its entity.
			const alphaEntities = (
				db
					.prepare("SELECT canonical_name FROM entities WHERE agent_id = ? ORDER BY canonical_name")
					.all(ALPHA) as Array<{
					canonical_name: string;
				}>
			).map((r) => r.canonical_name);
			const betaEntities = (
				db
					.prepare("SELECT canonical_name FROM entities WHERE agent_id = ? ORDER BY canonical_name")
					.all(BETA) as Array<{
					canonical_name: string;
				}>
			).map((r) => r.canonical_name);
			expect(alphaEntities).toEqual(["apex"]);
			expect(betaEntities).toEqual(["zenith"]);

			// No entity was written to the wrong agent.
			expect(
				(
					db
						.prepare("SELECT COUNT(*) AS n FROM entities WHERE agent_id = ? AND canonical_name = 'zenith'")
						.get(ALPHA) as {
						n: number;
					}
				).n,
			).toBe(0);
			expect(
				(
					db.prepare("SELECT COUNT(*) AS n FROM entities WHERE agent_id = ? AND canonical_name = 'apex'").get(BETA) as {
						n: number;
					}
				).n,
			).toBe(0);
		} finally {
			worker.stop();
		}
	});
});
