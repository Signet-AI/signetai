import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DreamingConfig } from "@signet/core";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor } from "../db-accessor";
import type { DbOwnerClient } from "../db-owner-client";
import type { DbOwnerMaintenance } from "../db-owner-maintenance";
import type { DbOwnerRequest } from "../db-owner-protocol";
import { reportEventLoopLag, resetPressureState } from "../system-pressure";
import {
	DREAMING_AGENT_PROMPT,
	type DreamingAgentExecutor,
	type DreamingPassFocus,
	dreamingFocusOfMode,
	enqueueDreamingHygieneAttention,
	getDreamingWorkloadDiagnostics,
} from "./dreaming";
import {
	AlreadyRunningError,
	createAgentScopeSnapshot,
	getDreamingWorkerAgentIds,
	selectDreamingCheckMode,
	shouldDeferDreamingSweep,
	startDreamingWorker,
	_testDreamingTriggerLogData,
} from "./dreaming-worker";

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
		withReadDbAsync<T>(fn: (db: Database) => Promise<T>): Promise<T> {
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
		withWriteTxAsync<T>(fn: (db: Database) => T): Promise<T> {
			return Promise.resolve().then(() => {
				db.exec("BEGIN IMMEDIATE");
				try {
					const result = fn(db);
					db.exec("COMMIT");
					return result;
				} catch (e) {
					db.exec("ROLLBACK");
					throw e;
				}
			});
		},
	} as unknown as DbAccessor;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Condition not met within ${timeoutMs}ms`);
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
		resetPressureState();
		rmSync(agentsDir, { recursive: true, force: true });
		db.close();
	});

	it("discovers registered and data-bearing agents for periodic checks", async () => {
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
		db.prepare(
			`INSERT INTO dreaming_evidence_exclusions
			 (agent_id, source_kind, source_id, reason, pass_id)
			 VALUES ('quarantine-agent', 'transcript', 'repaired-later', 'semantic_operation_rejected', 'pass-1')`,
		).run();

		expect(await getDreamingWorkerAgentIds(accessor, "default")).toEqual([
			"artifact-agent",
			"default",
			"memory-agent",
			"noam",
			"quarantine-agent",
			"state-agent",
			"summary-agent",
			"transcript-agent",
		]);
	});

	it("routes agent-scope discovery through the DB owner without a parent read", async () => {
		const originalRead = accessor.withReadDbAsync;
		const queries: string[] = [];
		accessor.withReadDbAsync = async () => {
			throw new Error("owner-routed scope discovery must not use the parent read accessor");
		};
		const owner = {
			submit(request: DbOwnerRequest) {
				if (request.kind !== "query") throw new Error(`unexpected owner request: ${request.kind}`);
				queries.push(request.statement.sql);
				return {
					job: {} as never,
					result: Promise.resolve([{ id: "owner-agent" }, { id: null }]),
					cancel: (): void => {},
				};
			},
		} as unknown as DbOwnerClient;
		try {
			expect(await getDreamingWorkerAgentIds(accessor, "default", { owner } as DbOwnerMaintenance)).toEqual([
				"default",
				"owner-agent",
			]);
			expect(queries).toHaveLength(1);
		} finally {
			accessor.withReadDbAsync = originalRead;
		}
	});

	it("serves the agent-scope union from a snapshot refreshed on a cadence", async () => {
		let resolves = 0;
		let now = 0;
		const scopes = createAgentScopeSnapshot(
			1_000,
			() => {
				resolves += 1;
				return ["default", "new-scope"];
			},
			() => now,
		);
		expect(await scopes()).toEqual(["default", "new-scope"]);
		now = 999;
		expect(await scopes()).toEqual(["default", "new-scope"]);
		expect(resolves).toBe(1);
		now = 1_000;
		expect(await scopes()).toEqual(["default", "new-scope"]);
		expect(resolves).toBe(2);
	});

	it("does not schedule a blocking agent-scope warm-up", () => {
		const originalSetTimeout = globalThis.setTimeout;
		const delays: number[] = [];
		globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
			if (timeout !== undefined) delays.push(timeout);
			return originalSetTimeout(handler, timeout, ...args);
		}) as typeof setTimeout;
		const worker = startDreamingWorker(accessor, defaultCfg(), agentsDir, "default", { checkIntervalMs: 60_000 });
		try {
			expect(delays).not.toContain(15_000);
		} finally {
			worker.stop();
			globalThis.setTimeout = originalSetTimeout;
		}
	});

	it("defers a sweep while the shared queue health watermark is exceeded", async () => {
		const now = new Date().toISOString();
		for (let index = 0; index <= 50; index += 1) {
			db.prepare(
				`INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at)
				 VALUES (?, ?, 'index', 'pending', ?, ?)`,
			).run(`pressure-${index}`, `memory-${index}`, now, now);
		}
		expect(await shouldDeferDreamingSweep(accessor)).toBe(true);
	});

	it("reports queue pressure only after the scheduler defers a sweep (#1393)", async () => {
		const now = new Date().toISOString();
		for (let index = 0; index <= 50; index += 1) {
			db.prepare(
				`INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at)
				 VALUES (?, ?, 'index', 'pending', ?, ?)`,
			).run(`scheduler-pressure-${index}`, `scheduler-memory-${index}`, now, now);
		}
		const worker = startDreamingWorker(accessor, defaultCfg(), agentsDir, "default", { checkIntervalMs: 10 });
		try {
			await waitFor(() => worker.scheduler.reason === "queue_pressure", 2_000);
			expect(worker.scheduler).toEqual({
				status: "deferred",
				reason: "queue_pressure",
				checkedAt: expect.any(String),
			});
		} finally {
			worker.stop();
		}
	});

	it("reports system pressure when both system and queue pressure defer a sweep (#1446)", async () => {
		const now = new Date().toISOString();
		for (let index = 0; index <= 50; index += 1) {
			db.prepare(
				`INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at)
				 VALUES (?, ?, 'index', 'pending', ?, ?)`,
			).run(`combined-pressure-${index}`, `combined-memory-${index}`, now, now);
		}
		reportEventLoopLag(600);
		const worker = startDreamingWorker(accessor, defaultCfg(), agentsDir, "default", { checkIntervalMs: 10 });
		try {
			await waitFor(() => worker.scheduler.reason === "system_pressure", 2_000);
			expect(worker.scheduler).toEqual({
				status: "deferred",
				reason: "system_pressure",
				checkedAt: expect.any(String),
			});
		} finally {
			worker.stop();
		}
	});

	it("routes the scheduled hygiene scan and backlog probe through the maintenance owner", async () => {
		let hygieneCalls = 0;
		let probeCalls = 0;
		let backlogMaxSources = 0;
		const ownerMaintenance = {
			queueIsHealthy: async () => true,
			dreamingHygieneAttention: async () => {
				hygieneCalls += 1;
				return 0;
			},
			dreamingSurprisalAttention: async () => null,
			dreamingEpisodicBacklogProbe: async (input: {
				readonly agentId: string;
				readonly tokenThreshold: number;
				readonly maxSources: number;
			}) => {
				probeCalls += 1;
				backlogMaxSources = input.maxSources;
				return { kind: "exact", tokens: 0, hasBacklog: false, sourcesScanned: 0 } as const;
			},
			dreamingEpisodicBacklogExists: async () => false,
		} as unknown as DbOwnerMaintenance;
		const worker = startDreamingWorker(accessor, defaultCfg(), agentsDir, "default", {
			checkIntervalMs: 10,
			ownerMaintenance,
		});
		try {
			await waitFor(() => hygieneCalls === 1 && probeCalls === 1, 2_000);
			expect(hygieneCalls).toBe(1);
			expect(probeCalls).toBe(1);
			expect(backlogMaxSources).toBe(50);
		} finally {
			worker.stop();
		}
	});

	it("labels scheduled trigger logs with the decision reason and count semantics", () => {
		const exact = { kind: "exact", tokens: 42, hasBacklog: true, sourcesScanned: 5 } as const;
		const partial = { kind: "indeterminate", tokenLowerBound: 12, hasBacklog: true, sourcesScanned: 50 } as const;

		expect(_testDreamingTriggerLogData("scope", { trigger: true, reason: "token-threshold" }, exact, 100)).toEqual({
			scopeId: "scope",
			reason: "token-threshold",
			threshold: 100,
			hasBacklog: true,
			countComplete: true,
			sourcesScanned: 5,
			episodicTokens: 42,
		});

		for (const reason of ["attention", "continuation", "max-interval"] as const) {
			const data = _testDreamingTriggerLogData("scope", { trigger: true, reason }, partial, 100);
			expect(data).toMatchObject({
				scopeId: "scope",
				reason,
				threshold: 100,
				hasBacklog: true,
				countComplete: false,
				sourcesScanned: 50,
				tokenLowerBound: 12,
			});
			expect(data).not.toHaveProperty("episodicTokens");
		}
	});

	it("writes manual async trigger passes to the requested agent", async () => {
		const worker = startDreamingWorker(accessor, defaultCfg(), agentsDir, "default");
		try {
			const passId = await worker.triggerAsync("incremental", "noam");
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

	it("reports scoped Dreaming ages using SQLite UTC timestamps", async () => {
		db.prepare(
			`INSERT INTO dreaming_passes (id, agent_id, mode, status, started_at, created_at)
			 VALUES ('active-pass', 'default', 'incremental', 'running', '2026-08-13 10:00:00', '2026-08-13 10:00:00')`,
		).run();
		db.prepare(
			`INSERT INTO dreaming_attention (id, agent_id, kind, subject_ref, details_json, priority, created_at)
			 VALUES ('pending-attention', 'default', 'review_due', 'subject', '{}', 50, '2026-08-13 09:00:00')`,
		).run();

		const nowMs = Date.UTC(2026, 7, 13, 11);
		expect(await getDreamingWorkloadDiagnostics(accessor, "default", nowMs)).toEqual({
			activePasses: 1,
			oldestPassAgeMs: 60 * 60 * 1_000,
			pendingAttention: 1,
			oldestAttentionAgeMs: 2 * 60 * 60 * 1_000,
		});
		expect(await getDreamingWorkloadDiagnostics(accessor, "other", nowMs)).toEqual({
			activePasses: 0,
			oldestPassAgeMs: null,
			pendingAttention: 0,
			oldestAttentionAgeMs: null,
		});
	});

	it("rejects an overlapping manual pass without skipping the active pass", async () => {
		db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, agent_id, content, harness, created_at, updated_at, completed_at)
			 VALUES ('overlap-evidence', 'default', 'Evidence for one in-flight pass.', 'pi',
			         datetime('now'), datetime('now'), datetime('now'))`,
		).run();

		let started = false;
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = () => resolve();
		});
		const executorFactory = (): DreamingAgentExecutor => ({
			async run(_input: Parameters<DreamingAgentExecutor["run"]>[0]) {
				started = true;
				await gate;
				return { summary: "Completed one active pass" };
			},
		});

		const worker = startDreamingWorker(accessor, defaultCfg({ tokenThreshold: 1 }), agentsDir, "default", {
			executorFactory,
		});
		try {
			const first = worker.trigger("incremental", "default");
			await waitFor(() => started, 2_000);
			expect(worker.running).toBe(true);
			expect(worker.activeAgentId).toBe("default");
			await expect(worker.trigger("incremental", "default")).rejects.toBeInstanceOf(AlreadyRunningError);
			release();
			await first;

			expect(db.prepare("SELECT status, COUNT(*) AS count FROM dreaming_passes GROUP BY status").all()).toEqual([
				{ status: "completed", count: 1 },
			]);
		} finally {
			worker.stop();
			release();
		}
	});

	it("keeps the check loop alive when a scheduled pass fails (#1198)", async () => {
		db.prepare(
			`INSERT INTO session_transcripts
		 (session_key, agent_id, content, harness, created_at, updated_at, completed_at)
		 VALUES ('sweep-failure-evidence', 'alpha', 'Episodic evidence awaiting a doomed pass.', 'pi',
		         datetime('now'), datetime('now'), datetime('now'))`,
		).run();

		const executorFactory = () => ({
			async run(_input: { prompt: string; tools: ReadonlyArray<{ name: string }> }) {
				throw new Error("429 rate_limit_error: Token usage limit reached");
			},
		});
		const unhandled: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);

		const worker = startDreamingWorker(accessor, defaultCfg({ tokenThreshold: 1 }), agentsDir, "default", {
			executorFactory,
			checkIntervalMs: 20,
		});
		try {
			await waitFor(() => {
				const state = db
					.prepare("SELECT consecutive_failures AS n FROM dreaming_state WHERE agent_id = 'default'")
					.get() as { n: number } | null;
				return state != null && state.n >= 2;
			}, 2_000);
			expect(unhandled).toEqual([]);

			const state = db
				.prepare("SELECT consecutive_failures AS n FROM dreaming_state WHERE agent_id = 'default'")
				.get() as { n: number };
			expect(state.n).toBeGreaterThanOrEqual(2);

			const passes = db.prepare("SELECT status, error FROM dreaming_passes ORDER BY created_at").all() as Array<{
				status: string;
				error: string | null;
			}>;
			expect(passes.length).toBeGreaterThanOrEqual(2);
			expect(passes.every((pass) => pass.status === "failed" && pass.error?.includes("429"))).toBe(true);
		} finally {
			worker.stop();
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("alternates hygiene and content runbooks across sweep checks (#1098)", async () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES ('legacy-husk', 'Legacy Husk', 'legacy husk', 'project', 'default', 5, ?, ?)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, agent_id, content, harness, created_at, updated_at, completed_at)
			 VALUES ('sweep-evidence', 'default', 'New episodic evidence awaiting a content pass.', 'pi', datetime('now'), datetime('now'), datetime('now'))`,
		).run();
		await enqueueDreamingHygieneAttention(accessor, "default");

		let focus: DreamingPassFocus | null = null;
		const first = await selectDreamingCheckMode(accessor, ["default"], focus);
		expect(first).toBe("incremental-hygiene");
		focus = dreamingFocusOfMode(first) ?? focus;
		const second = await selectDreamingCheckMode(accessor, ["default"], focus);
		expect(second).toBe("incremental-content");
		focus = dreamingFocusOfMode(second) ?? focus;
		expect(await selectDreamingCheckMode(accessor, ["default"], focus)).toBe("incremental-hygiene");
	});

	it("routes pending surprisal hints to a content pass without an evidence backlog", async () => {
		db.prepare(
			`INSERT INTO dreaming_attention (id, agent_id, kind, subject_ref, details_json, priority)
			 VALUES ('surprisal-hint', 'default', 'surprisal', 'memory:outlier', '{}', 90)`,
		).run();

		expect(await selectDreamingCheckMode(accessor, ["default"], null)).toBe("incremental-content");
	});

	it("routes pending temporal review attention to a content pass", async () => {
		db.prepare(
			`INSERT INTO dreaming_attention (id, agent_id, kind, subject_ref, details_json, priority)
			 VALUES ('review-hint', 'default', 'review_due', 'memory:temporal', '{}', 90)`,
		).run();

		expect(await selectDreamingCheckMode(accessor, ["default"], null)).toBe("incremental-content");
	});

	it("seeds deterministic hygiene attention for legacy graph rows", async () => {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES ('legacy-husk', 'Legacy Husk', 'legacy husk', 'project', 'default', 5, datetime('now'), datetime('now'))`,
		).run();
		await enqueueDreamingHygieneAttention(accessor, "default");
		expect(db.prepare("SELECT kind, subject_ref FROM dreaming_attention WHERE agent_id = ?").get("default")).toEqual({
			kind: "hygiene",
			subject_ref: "entity:legacy-husk",
		});
	});

	it("runs one universe pass over every agent scope and keeps semantic rows agent-isolated (#946)", async () => {
		const ALPHA = "alpha";
		const BETA = "beta";
		const alphaEvidence = "Alpha is building the Apex platform.";
		const betaEvidence = "Beta is building the Zenith platform.";
		db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, agent_id, content, harness, created_at, updated_at, completed_at)
			 VALUES ('summary-alpha', ?, ?, 'pi', datetime('now'), datetime('now'), datetime('now'))`,
		).run(ALPHA, alphaEvidence);
		db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, agent_id, content, harness, created_at, updated_at, completed_at)
			 VALUES ('summary-beta', ?, ?, 'pi', datetime('now'), datetime('now'), datetime('now'))`,
		).run(BETA, betaEvidence);
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
									source_ref: "transcript:summary-alpha",
									source_kind: "transcript",
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
									source_ref: "transcript:summary-beta",
									source_kind: "transcript",
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
			await worker.trigger("incremental", "default");
			const passes = db
				.prepare("SELECT agent_id, status, mode FROM dreaming_passes ORDER BY created_at")
				.all() as Array<{ agent_id: string; status: string; mode: string }>;
			expect(passes).toEqual([{ agent_id: "default", status: "completed", mode: "incremental" }]);
			expect(seenPrompts).toHaveLength(1);
			expect(seenPrompts[0]).toContain(DREAMING_AGENT_PROMPT);
			expect(seenPrompts[0]).toContain("<agent_scopes>");
			expect(seenPrompts[0]).toContain(ALPHA);
			expect(seenPrompts[0]).toContain(BETA);
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
