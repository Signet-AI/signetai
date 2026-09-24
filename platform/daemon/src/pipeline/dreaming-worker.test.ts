import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DreamingConfig } from "@signet/core";
import { runMigrations } from "../../../core/src/migrations";
import { closeDbAccessor, getDbAccessor, initDbAccessor, type DbAccessor } from "../db-accessor";
import {
	createDbOwnerClient,
	DbOwnerDeadlineError,
	DbOwnerDiedError,
	type DbOwnerClient,
	type DbOwnerJobHandle,
	type DbOwnerSubmitOptions,
} from "../db-owner-client";
import {
	closeRegisteredDbOwnerMaintenance,
	createDbOwnerMaintenance,
	registerDbOwnerMaintenance,
	type DbOwnerMaintenance,
} from "../db-owner-maintenance";
import type { DbOwnerRequest } from "../db-owner-protocol";
import { recallThroughDbOwner } from "../db-owner-recall";
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

interface ScopeDelayOwner {
	readonly client: DbOwnerClient;
	arm(durationMs: number): void;
	limitPassCreate(deadlineMs: number): void;
	passCreateJobId(): string | null;
	delayPassCreateReconcile(deadlineMs: number, blockerDurationMs: number): void;
	passCreateResult(): "pending" | "resolved" | "rejected" | null;
	passCreateResults(): readonly ("pending" | "resolved" | "rejected")[];
	passCreateIds(): readonly string[];
	passCreateReconcileJobId(): string | null;
	blocker(): DbOwnerJobHandle<{ readonly sleptMs: number }> | null;
}

function createScopeDelayOwner(owner: DbOwnerClient): ScopeDelayOwner {
	let armed = false;
	let durationMs = 0;
	let passCreateDeadlineMs: number | null = null;
	let reconcileDelay: { readonly deadlineMs: number; readonly blockerDurationMs: number } | null = null;
	let reconcileBlockerQueued = false;
	let currentPassCreateJobId: string | null = null;
	let currentPassCreateResult: "pending" | "resolved" | "rejected" | null = null;
	let passCreateResults: Array<"pending" | "resolved" | "rejected"> = [];
	let passCreateIds: string[] = [];
	let currentReconcileJobId: string | null = null;
	let blocker: DbOwnerJobHandle<{ readonly sleptMs: number }> | null = null;
	const client: DbOwnerClient = {
		start: () => owner.start(),
		initialize: (agentsDir?: string) => owner.initialize(agentsDir),
		submit: <Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> => {
			if (armed && options.operation === "pipeline/dreaming-worker.agent-scopes") {
				armed = false;
				blocker = owner.submit<{ readonly sleptMs: number }>(
					{ kind: "sleep", durationMs },
					{
						operation: "maintenance.test.dreaming-scope-blocker",
						lane: "maintenance",
						workloadClass: "maintenance",
						deadlineMs: durationMs + 15_000,
					},
				);
			}
			const submitOptions =
				options.operation === "dreaming.pass.create" && passCreateDeadlineMs !== null
					? { ...options, deadlineMs: passCreateDeadlineMs }
					: options.operation === "dreaming.pass.create.reconcile" && reconcileDelay !== null
						? { ...options, deadlineMs: reconcileDelay.deadlineMs }
						: options;
			const handle = owner.submit<Result>(request, submitOptions);
			if (options.operation === "dreaming.pass.create") {
				currentPassCreateJobId = handle.job.id;
				currentPassCreateResult = "pending";
				const resultIndex = passCreateResults.push("pending") - 1;
				if (request.kind === "query") {
					const passId = request.statement.params?.[0];
					if (typeof passId === "string") passCreateIds.push(passId);
				}
				void handle.result.then(
					() => {
						currentPassCreateResult = "resolved";
						passCreateResults[resultIndex] = "resolved";
					},
					() => {
						currentPassCreateResult = "rejected";
						passCreateResults[resultIndex] = "rejected";
					},
				);
				if (reconcileDelay !== null && !reconcileBlockerQueued) {
					const delay = reconcileDelay;
					reconcileBlockerQueued = true;
					blocker = owner.submit<{ readonly sleptMs: number }>(
						{ kind: "sleep", durationMs: delay.blockerDurationMs },
						{
							operation: "maintenance.test.dreaming-pass-reconcile-blocker",
							lane: "maintenance",
							workloadClass: "maintenance",
							deadlineMs: delay.blockerDurationMs + 5_000,
						},
					);
				}
			}
			if (options.operation === "dreaming.pass.create.reconcile") {
				currentReconcileJobId = handle.job.id;
				reconcileDelay = null;
			}
			return handle;
		},
		setWriteBlocked: (blocked: boolean) => owner.setWriteBlocked(blocked),
		awaitResult: <Result>(handle: DbOwnerJobHandle<Result>, timeoutMs?: number) => owner.awaitResult(handle, timeoutMs),
		cancel: (jobId: string) => owner.cancel(jobId),
		health: () => owner.health(),
		close: () => owner.close(),
	};
	return {
		client,
		arm(nextDurationMs: number) {
			durationMs = nextDurationMs;
			blocker = null;
			armed = true;
		},
		limitPassCreate(deadlineMs) {
			passCreateDeadlineMs = deadlineMs;
			currentPassCreateJobId = null;
		},
		delayPassCreateReconcile(deadlineMs, blockerDurationMs) {
			reconcileDelay = { deadlineMs, blockerDurationMs };
			reconcileBlockerQueued = false;
			currentPassCreateResult = null;
			passCreateResults = [];
			passCreateIds = [];
			currentReconcileJobId = null;
			blocker = null;
		},
		passCreateResult: () => currentPassCreateResult,
		passCreateResults: () => [...passCreateResults],
		passCreateIds: () => [...passCreateIds],
		passCreateReconcileJobId: () => currentReconcileJobId,
		passCreateJobId: () => currentPassCreateJobId,
		blocker: () => blocker,
	};
}

type TriggerOutcome =
	| { readonly kind: "resolved"; readonly passId: string }
	| { readonly kind: "rejected"; readonly error: unknown };

function observeTrigger(trigger: Promise<string>): Promise<TriggerOutcome> {
	return trigger.then(
		(passId) => ({ kind: "resolved", passId }),
		(error: unknown) => ({ kind: "rejected", error }),
	);
}

function processHasPathDescriptor(processId: number, path: string): boolean {
	if (process.platform !== "linux") return false;
	const descriptorDirectory = `/proc/${processId}/fd`;
	if (!existsSync(descriptorDirectory)) return false;
	return readdirSync(descriptorDirectory).some((descriptor) => {
		try {
			return readlinkSync(join(descriptorDirectory, descriptor)) === path;
		} catch {
			return false;
		}
	});
}

interface RealOwnerTriggerFixture {
	readonly agentsDir: string;
	readonly dbPath: string;
	readonly accessor: DbAccessor;
	readonly owner: DbOwnerClient;
	readonly scopeDelay: ScopeDelayOwner;
	readonly maintenance: DbOwnerMaintenance;
	readonly worker: ReturnType<typeof startDreamingWorker>;
	readonly ownerCommitMarker: string;
	readonly ownerCommitResultGate: string;

	readonly previousSignetPath: string | undefined;
	readonly previousCommitMarker: string | undefined;
	readonly previousCommitPause: string | undefined;
	readonly previousCommitResultPause: string | undefined;
	readonly previousCommitResultGate: string | undefined;
}

async function createRealOwnerTriggerFixture(
	options: { readonly commitPauseMs?: number; readonly commitResultPauseMs?: number } = {},
): Promise<RealOwnerTriggerFixture> {
	const agentsDir = mkdtempSync(join(tmpdir(), "dreaming-owner-trigger-"));
	const dbPath = join(agentsDir, "memory", "memories.db");
	const ownerCommitMarker = join(agentsDir, "owner-commit-started");
	const ownerCommitResultGate = join(agentsDir, "owner-commit-result-gate");

	const previousSignetPath = process.env.SIGNET_PATH;
	const previousCommitMarker = process.env.SIGNET_DB_OWNER_TEST_COMMIT_STARTED;
	const previousCommitPause = process.env.SIGNET_DB_OWNER_TEST_COMMIT_PAUSE_MS;
	const previousCommitResultPause = process.env.SIGNET_DB_OWNER_TEST_COMMIT_RESULT_PAUSE_MS;
	const previousCommitResultGate = process.env.SIGNET_DB_OWNER_TEST_COMMIT_RESULT_GATE;

	let owner: DbOwnerClient | null = null;
	let worker: ReturnType<typeof startDreamingWorker> | null = null;
	let registered = false;
	try {
		await closeDbAccessor();
		process.env.SIGNET_PATH = agentsDir;
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		initDbAccessor(dbPath, { agentsDir });
		const accessor = getDbAccessor();
		const now = new Date().toISOString();
		await accessor.withWriteTxAsync((db) => {
			db.prepare(
				`INSERT INTO memories (id, content, type, agent_id, created_at, updated_at, updated_by)
				 VALUES ('owner-recall-fixture', 'isolated recall control row', 'fact', 'default', ?, ?, 'fixture')`,
			).run(now, now);
		});
		accessor.close();

		process.env.SIGNET_DB_OWNER_TEST_COMMIT_STARTED = ownerCommitMarker;
		if (options.commitPauseMs !== undefined) {
			process.env.SIGNET_DB_OWNER_TEST_COMMIT_PAUSE_MS = String(options.commitPauseMs);
		} else Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_TEST_COMMIT_PAUSE_MS");
		if (options.commitResultPauseMs !== undefined) {
			process.env.SIGNET_DB_OWNER_TEST_COMMIT_RESULT_PAUSE_MS = String(options.commitResultPauseMs);
		} else Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_TEST_COMMIT_RESULT_PAUSE_MS");
		process.env.SIGNET_DB_OWNER_TEST_COMMIT_RESULT_GATE = ownerCommitResultGate;

		owner = createDbOwnerClient({ dbPath, workerPath: resolve(import.meta.dir, "../db-owner-worker.ts") });
		const scopeDelay = createScopeDelayOwner(owner);
		const maintenance = createDbOwnerMaintenance({ dbPath, owner: scopeDelay.client });
		await owner.start();
		if (options.commitPauseMs === undefined && options.commitResultPauseMs === undefined)
			await owner.initialize(agentsDir);
		registerDbOwnerMaintenance(maintenance);
		registered = true;
		worker = startDreamingWorker(accessor, defaultCfg(), agentsDir, "default", {
			checkIntervalMs: 60_000,
			ownerMaintenance: maintenance,
		});
		return {
			agentsDir,
			dbPath,
			accessor,
			owner,
			scopeDelay,
			maintenance,
			worker,
			ownerCommitMarker,
			ownerCommitResultGate,

			previousSignetPath,
			previousCommitMarker,
			previousCommitPause,
			previousCommitResultPause,
			previousCommitResultGate,
		};
	} catch (error) {
		worker?.stop();
		await owner?.close();
		if (registered) await closeRegisteredDbOwnerMaintenance();
		await closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		if (previousCommitMarker === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_TEST_COMMIT_STARTED");
		else process.env.SIGNET_DB_OWNER_TEST_COMMIT_STARTED = previousCommitMarker;
		if (previousCommitPause === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_TEST_COMMIT_PAUSE_MS");
		else process.env.SIGNET_DB_OWNER_TEST_COMMIT_PAUSE_MS = previousCommitPause;
		if (previousCommitResultPause === undefined)
			Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_TEST_COMMIT_RESULT_PAUSE_MS");
		else process.env.SIGNET_DB_OWNER_TEST_COMMIT_RESULT_PAUSE_MS = previousCommitResultPause;
		if (previousCommitResultGate === undefined)
			Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_TEST_COMMIT_RESULT_GATE");
		else process.env.SIGNET_DB_OWNER_TEST_COMMIT_RESULT_GATE = previousCommitResultGate;

		rmSync(agentsDir, { recursive: true, force: true });
		throw error;
	}
}

async function closeRealOwnerTriggerFixture(fixture: RealOwnerTriggerFixture): Promise<void> {
	fixture.worker.stop();
	try {
		await fixture.owner.close();
	} finally {
		try {
			await fixture.worker.activePass?.catch(() => {});
		} finally {
			try {
				await closeRegisteredDbOwnerMaintenance();
			} finally {
				try {
					await closeDbAccessor();
				} finally {
					if (fixture.previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
					else process.env.SIGNET_PATH = fixture.previousSignetPath;
					if (fixture.previousCommitMarker === undefined)
						Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_TEST_COMMIT_STARTED");
					else process.env.SIGNET_DB_OWNER_TEST_COMMIT_STARTED = fixture.previousCommitMarker;
					if (fixture.previousCommitPause === undefined)
						Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_TEST_COMMIT_PAUSE_MS");
					else process.env.SIGNET_DB_OWNER_TEST_COMMIT_PAUSE_MS = fixture.previousCommitPause;
					if (fixture.previousCommitResultPause === undefined)
						Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_TEST_COMMIT_RESULT_PAUSE_MS");
					else process.env.SIGNET_DB_OWNER_TEST_COMMIT_RESULT_PAUSE_MS = fixture.previousCommitResultPause;
					if (fixture.previousCommitResultGate === undefined)
						Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_TEST_COMMIT_RESULT_GATE");
					else process.env.SIGNET_DB_OWNER_TEST_COMMIT_RESULT_GATE = fixture.previousCommitResultGate;

					rmSync(fixture.agentsDir, { recursive: true, force: true });
				}
			}
		}
	}
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

	it("waits for owner work to settle after an agent-scope deadline", async () => {
		const metricsGate = { release: (): void => {} };
		const metrics = new Promise<void>((resolve) => {
			metricsGate.release = resolve;
		});
		const owner = {
			submit() {
				return {
					job: {} as never,
					result: Promise.reject(new DbOwnerDeadlineError("scope-query")),
					metrics,
					cancel: (): void => {},
				};
			},
		} as unknown as DbOwnerClient;
		const pending = getDreamingWorkerAgentIds(accessor, "default", { owner } as DbOwnerMaintenance);
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(settled).toBe(false);

		metricsGate.release();
		await expect(pending).rejects.toBeInstanceOf(DbOwnerDeadlineError);
		expect(settled).toBe(true);
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

	it("releases a failed async preflight and admits the next trigger", async () => {
		db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, agent_id, content, harness, created_at, updated_at, completed_at)
			 VALUES ('async-preflight', 'default', 'Fixture evidence for a completed pass.', 'pi',
			         datetime('now'), datetime('now'), datetime('now'))`,
		).run();
		let rejectNextRead = false;
		const triggerAccessor = {
			...accessor,
			withReadDbAsync: <Result>(fn: (db: Database) => Result): Promise<Result> => {
				if (rejectNextRead) {
					rejectNextRead = false;
					return Promise.reject(new DbOwnerDeadlineError("fixture-agent-scopes"));
				}
				return Promise.resolve(fn(db));
			},
		} as unknown as DbAccessor;
		const worker = startDreamingWorker(triggerAccessor, defaultCfg({ tokenThreshold: 1 }), agentsDir, "default", {
			checkIntervalMs: 60_000,
			executorFactory: () => ({
				async run() {
					return { summary: "Controlled executor fixture completed." };
				},
			}),
		});
		try {
			const controlId = await worker.triggerAsync("incremental");
			const control = worker.activePass;
			if (control !== null) await control;
			expect(db.prepare("SELECT status FROM dreaming_passes WHERE id = ?").get(controlId)).toMatchObject({
				status: "completed",
			});

			rejectNextRead = true;
			const failedTrigger = worker.triggerAsync("incremental");
			expect(worker.activePass).not.toBeNull();
			await expect(failedTrigger).rejects.toBeInstanceOf(DbOwnerDeadlineError);
			await waitFor(() => !worker.running, 2_000);
			expect(worker.activePass).toBeNull();
			expect(db.prepare("SELECT COUNT(*) AS count FROM dreaming_passes WHERE status = 'running'").get()).toEqual({
				count: 0,
			});

			const recoveryId = await worker.triggerAsync("incremental");
			const recovery = worker.activePass;
			if (recovery !== null) await recovery;
			await waitFor(() => !worker.running, 2_000);
			expect(db.prepare("SELECT status FROM dreaming_passes WHERE id = ?").get(recoveryId)).toMatchObject({
				status: "completed",
			});
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

describe("dreaming worker async trigger with a real DB owner", () => {
	let fixture: RealOwnerTriggerFixture | null = null;

	beforeEach(async () => {
		fixture = await createRealOwnerTriggerFixture();
	}, 30_000);

	afterEach(async () => {
		if (fixture === null) return;
		await closeRealOwnerTriggerFixture(fixture);
		fixture = null;
	}, 30_000);

	it("holds a timed-out scope trigger until owner work settles, then permits a completed pass", async () => {
		const current = fixture;
		if (current === null) throw new Error("real owner trigger fixture was not initialized");
		const { dbPath, maintenance, owner, scopeDelay, worker } = current;
		const ownerPid = owner.health().pid;
		if (ownerPid === null) throw new Error("DB owner did not publish its pid");
		if (process.platform === "linux") {
			expect(processHasPathDescriptor(process.pid, dbPath)).toBe(false);
			expect(processHasPathDescriptor(ownerPid, dbPath)).toBe(true);
		}

		const controlId = await worker.triggerAsync("incremental");
		const controlAttempt = worker.activePass;
		if (controlAttempt !== null) await controlAttempt;
		const controlRows = await recallThroughDbOwner<{ readonly status: string }>(
			maintenance.owner,
			"SELECT status FROM dreaming_passes WHERE id = ?",
			[controlId],
		);
		expect(controlRows).toEqual([{ status: "completed" }]);

		scopeDelay.arm(6_500);
		let triggerSettled = false;
		const triggerOutcome = observeTrigger(worker.triggerAsync("incremental")).then((outcome) => {
			triggerSettled = true;
			return outcome;
		});
		const activeAttempt = worker.activePass;
		await waitFor(() => {
			const blocker = scopeDelay.blocker();
			return blocker !== null && owner.health().activeJobId === blocker.job.id;
		}, 2_000);
		const blocker = scopeDelay.blocker();
		if (blocker === null) throw new Error("scope lookup blocker was not submitted");
		const healthWhileBlocked = owner.health();
		const recallWhileBlocked = recallThroughDbOwner<{ readonly id: string }>(
			maintenance.owner,
			"SELECT id FROM memories WHERE id = ?",
			["owner-recall-fixture"],
			{ deadlineMs: 20_000 },
		);
		const readinessWhileBlocked = maintenance.healthReady({ deadlineMs: 20_000 });
		await new Promise<void>((resolve) => setTimeout(resolve, 5_200));
		const protectedWhileOutstanding =
			!triggerSettled &&
			worker.running &&
			worker.activePass === activeAttempt &&
			owner.health().activeJobId === blocker.job.id;

		await blocker.result;
		const [recallRows, readiness, failedTrigger] = await Promise.all([
			recallWhileBlocked,
			readinessWhileBlocked,
			triggerOutcome,
		]);
		const runningRows = await recallThroughDbOwner<{ readonly id: string }>(
			maintenance.owner,
			"SELECT id FROM dreaming_passes WHERE status = 'running'",
		);
		const releasedAfterSettle = !worker.running && worker.activePass === null;
		const recoveryOutcome = await observeTrigger(worker.triggerAsync("incremental"));
		if (recoveryOutcome.kind === "resolved") {
			const recoveryAttempt = worker.activePass;
			if (recoveryAttempt !== null) await recoveryAttempt;
		}
		const recoveryRows =
			recoveryOutcome.kind === "resolved"
				? await recallThroughDbOwner<{ readonly status: string }>(
						maintenance.owner,
						"SELECT status FROM dreaming_passes WHERE id = ?",
						[recoveryOutcome.passId],
					)
				: [];

		expect(healthWhileBlocked.state).toBe("ready");
		expect(healthWhileBlocked.activeJobId).toBe(blocker.job.id);
		expect(recallRows).toEqual([{ id: "owner-recall-fixture" }]);
		expect(readiness.migrationsOk).toBe(true);
		expect(protectedWhileOutstanding).toBe(true);
		expect(failedTrigger.kind).toBe("rejected");
		if (failedTrigger.kind === "rejected") {
			expect(failedTrigger.error).toBeInstanceOf(DbOwnerDeadlineError);
		}
		expect(releasedAfterSettle).toBe(true);
		expect(runningRows).toEqual([]);
		expect(recoveryOutcome.kind).toBe("resolved");
		expect(recoveryRows).toEqual([{ status: "completed" }]);
	}, 30_000);

	it("holds the trigger fence through a timed-out pass-create commit", async () => {
		const initial = fixture;
		if (initial === null) throw new Error("real owner trigger fixture was not initialized");
		await closeRealOwnerTriggerFixture(initial);
		fixture = await createRealOwnerTriggerFixture({ commitPauseMs: 1_000 });
		const current = fixture;
		const { maintenance, owner, ownerCommitMarker, scopeDelay, worker } = current;
		scopeDelay.limitPassCreate(100);
		let firstSettled = false;
		let secondTrigger: Promise<TriggerOutcome> | null = null;
		let firstOutcome: TriggerOutcome | null = null;
		let secondOutcomeBeforeRelease: TriggerOutcome | null = null;
		let protectedBeforeRelease = false;
		let commitGateObserved = false;
		let triggerSettledBeforeRelease = false;
		let workerRunningBeforeRelease = false;
		let activePassMatchesBeforeRelease = false;
		let ownerAliveBeforeRelease = false;
		let commitWorkSettled = false;
		let passRows: readonly {
			readonly id: string;
			readonly status: string;
		}[] = [];
		const firstTrigger = observeTrigger(worker.triggerAsync("incremental")).then((outcome) => {
			firstSettled = true;
			return outcome;
		});
		const firstAttempt = worker.activePass;
		try {
			await waitFor(() => {
				const jobId = scopeDelay.passCreateJobId();
				return (
					jobId !== null &&
					existsSync(ownerCommitMarker) &&
					readFileSync(ownerCommitMarker, "utf8").includes("waiting") &&
					owner.health().activeJobId === jobId
				);
			}, 5_000);
			commitGateObserved = readFileSync(ownerCommitMarker, "utf8").includes("waiting");
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
			triggerSettledBeforeRelease = firstSettled;
			workerRunningBeforeRelease = worker.running;
			activePassMatchesBeforeRelease = worker.activePass === firstAttempt;
			ownerAliveBeforeRelease = owner.health().state === "ready";
			protectedBeforeRelease =
				!triggerSettledBeforeRelease &&
				workerRunningBeforeRelease &&
				activePassMatchesBeforeRelease &&
				ownerAliveBeforeRelease &&
				commitGateObserved;
			secondTrigger = observeTrigger(worker.triggerAsync("incremental"));
			secondOutcomeBeforeRelease = await Promise.race([
				secondTrigger,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
			]);
		} finally {
			firstOutcome = await firstTrigger;
			if (secondTrigger !== null) await secondTrigger;
			await waitFor(() => readFileSync(ownerCommitMarker, "utf8").includes("completed"), 5_000);
			commitWorkSettled = true;
			await worker.activePass?.catch(() => {});
			passRows = await recallThroughDbOwner<{
				readonly id: string;
				readonly status: string;
			}>(maintenance.owner, "SELECT id, status FROM dreaming_passes ORDER BY created_at, id");
		}
		const createdRows = passRows;
		expect({
			commitWorkSettled,
			protectedBeforeRelease,
			commitGateObserved,
			triggerSettledBeforeRelease,
			workerRunningBeforeRelease,
			activePassMatchesBeforeRelease,
			ownerAliveBeforeRelease,
			secondOutcomeBeforeRelease: secondOutcomeBeforeRelease?.kind,
			secondOutcomeError:
				secondOutcomeBeforeRelease?.kind === "rejected"
					? secondOutcomeBeforeRelease.error instanceof Error
						? secondOutcomeBeforeRelease.error.name
						: String(secondOutcomeBeforeRelease.error)
					: null,
			firstOutcome: firstOutcome?.kind,
			newPassCount: createdRows.length,
			runningPassCount: createdRows.filter((row) => row.status === "running").length,
			createdPassStatus: createdRows[0]?.status,
			passId: createdRows[0]?.id,
		}).toMatchObject({
			commitWorkSettled: true,
			protectedBeforeRelease: true,
			commitGateObserved: true,
			triggerSettledBeforeRelease: false,
			workerRunningBeforeRelease: true,
			activePassMatchesBeforeRelease: true,
			ownerAliveBeforeRelease: true,
			secondOutcomeBeforeRelease: "rejected",
			secondOutcomeError: "AlreadyRunningError",
			firstOutcome: "resolved",
			newPassCount: 1,
			runningPassCount: 0,
			createdPassStatus: "completed",
			passId: expect.any(String),
		});
	}, 30_000);

	it("returns an acknowledged pass without a reconciliation read", async () => {
		const current = fixture;
		if (current === null) throw new Error("real owner trigger fixture was not initialized");
		const { maintenance, owner, scopeDelay, worker } = current;
		scopeDelay.delayPassCreateReconcile(100, 500);
		const firstOutcomePromise = observeTrigger(worker.triggerAsync("incremental"));
		await waitFor(() => {
			const blocker = scopeDelay.blocker();
			return (
				scopeDelay.passCreateResult() === "resolved" &&
				blocker !== null &&
				owner.health().activeJobId === blocker.job.id
			);
		}, 5_000);
		const firstOutcome = await firstOutcomePromise;
		const firstPassCreateResults = scopeDelay.passCreateResults();
		const firstPassCreateIds = scopeDelay.passCreateIds();
		const firstReconcileSubmitted = scopeDelay.passCreateReconcileJobId() !== null;
		await worker.activePass?.catch(() => {});
		const firstRows = await recallThroughDbOwner<{ readonly id: string; readonly status: string }>(
			maintenance.owner,
			"SELECT id, status FROM dreaming_passes ORDER BY created_at, id",
		);

		const secondOutcome = await observeTrigger(worker.triggerAsync("incremental"));
		await worker.activePass?.catch(() => {});
		const allRows = await recallThroughDbOwner<{ readonly id: string; readonly status: string }>(
			maintenance.owner,
			"SELECT id, status FROM dreaming_passes ORDER BY created_at, id",
		);

		expect({
			passCreateResults: firstPassCreateResults,
			passCreateIds: firstPassCreateIds,
			reconcileSubmitted: firstReconcileSubmitted,
			firstOutcome: firstOutcome.kind,
			firstPassStatuses: firstRows.map((row) => row.status),
			secondOutcome: secondOutcome.kind,
			passCount: allRows.length,
			runningPassCount: allRows.filter((row) => row.status === "running").length,
			passIdsAreDistinct: allRows.length === 2 && allRows[0]?.id !== allRows[1]?.id,
		}).toMatchObject({
			passCreateResults: ["resolved"],
			passCreateIds: [expect.any(String)],
			reconcileSubmitted: false,
			firstOutcome: "resolved",
			firstPassStatuses: [expect.not.stringContaining("running")],
			secondOutcome: "resolved",
			passCount: 2,
			runningPassCount: 0,
			passIdsAreDistinct: true,
		});
	}, 30_000);

	it("keeps a late-committed pass owned when its reconciliation read times out", async () => {
		const initial = fixture;
		if (initial === null) throw new Error("real owner trigger fixture was not initialized");
		await closeRealOwnerTriggerFixture(initial);
		fixture = await createRealOwnerTriggerFixture({ commitPauseMs: 1_000 });
		const current = fixture;
		const { maintenance, owner, ownerCommitMarker, scopeDelay, worker } = current;
		scopeDelay.limitPassCreate(100);
		scopeDelay.delayPassCreateReconcile(100, 500);
		const firstOutcomePromise = observeTrigger(worker.triggerAsync("incremental"));
		await waitFor(() => {
			const blocker = scopeDelay.blocker();
			return (
				blocker !== null &&
				scopeDelay.passCreateReconcileJobId() !== null &&
				owner.health().activeJobId === blocker.job.id &&
				existsSync(ownerCommitMarker) &&
				readFileSync(ownerCommitMarker, "utf8").includes("completed")
			);
		}, 10_000);
		const firstOutcome = await firstOutcomePromise;
		const firstPassCreateResults = scopeDelay.passCreateResults();
		const firstPassCreateIds = scopeDelay.passCreateIds();
		const firstReconcileSubmitted = scopeDelay.passCreateReconcileJobId() !== null;
		await worker.activePass?.catch(() => {});
		const firstRows = await recallThroughDbOwner<{ readonly id: string; readonly status: string }>(
			maintenance.owner,
			"SELECT id, status FROM dreaming_passes ORDER BY created_at, id",
		);

		const secondOutcome = await observeTrigger(worker.triggerAsync("incremental"));
		await worker.activePass?.catch(() => {});
		const allRows = await recallThroughDbOwner<{ readonly id: string; readonly status: string }>(
			maintenance.owner,
			"SELECT id, status FROM dreaming_passes ORDER BY created_at, id",
		);

		expect({
			passCreateResults: firstPassCreateResults,
			passCreateIds: firstPassCreateIds,
			passCreateIdsAreSame:
				firstPassCreateIds.length === 2 && firstPassCreateIds.every((id) => id === firstPassCreateIds[0]),
			reconcileSubmitted: firstReconcileSubmitted,
			commitCompleted: existsSync(ownerCommitMarker) && readFileSync(ownerCommitMarker, "utf8").includes("completed"),
			firstOutcome: firstOutcome.kind,
			firstPassStatuses: firstRows.map((row) => row.status),
			secondOutcome: secondOutcome.kind,
			passCount: allRows.length,
			runningPassCount: allRows.filter((row) => row.status === "running").length,
			passIdsAreDistinct: allRows.length === 2 && allRows[0]?.id !== allRows[1]?.id,
		}).toMatchObject({
			passCreateResults: ["rejected", "resolved"],
			passCreateIds: [expect.any(String), expect.any(String)],
			passCreateIdsAreSame: true,
			commitCompleted: true,
			firstOutcome: "resolved",
			firstPassStatuses: [expect.not.stringContaining("running")],
			secondOutcome: "resolved",
			passCount: 2,
			runningPassCount: 0,
			passIdsAreDistinct: true,
		});
	}, 30_000);

	it("reconciles a committed pass by pass ID after the owner exits before the trigger sees its result", async () => {
		if (process.platform === "win32") return;
		const initial = fixture;
		if (initial === null) throw new Error("real owner trigger fixture was not initialized");
		await closeRealOwnerTriggerFixture(initial);
		fixture = await createRealOwnerTriggerFixture({ commitResultPauseMs: 30_000 });
		const current = fixture;
		const { maintenance, owner, ownerCommitMarker, ownerCommitResultGate, scopeDelay, worker } = current;
		writeFileSync(ownerCommitResultGate, "pause-next-committed-result\n");
		const triggerOutcomePromise = observeTrigger(worker.triggerAsync("incremental"));
		const activeAttempt = worker.activePass;
		await waitFor(
			() => existsSync(ownerCommitMarker) && readFileSync(ownerCommitMarker, "utf8").includes("result-wait"),
			10_000,
		);
		const ownerPid = owner.health().pid;
		if (ownerPid === null) throw new Error("DB owner did not publish its pid");
		const passCreateJobId = scopeDelay.passCreateJobId();
		const protectedWhileResultHeld =
			worker.running &&
			worker.activePass === activeAttempt &&
			passCreateJobId !== null &&
			owner.health().activeJobId === passCreateJobId;
		const duplicateTrigger = await observeTrigger(worker.triggerAsync("incremental"));
		const generationBeforeRetirement = owner.health().generation;
		process.kill(ownerPid, "SIGKILL");
		await waitFor(
			() => owner.health().state === "ready" && owner.health().generation > generationBeforeRetirement,
			10_000,
		);
		const triggerOutcome = await triggerOutcomePromise;
		await activeAttempt?.catch(() => {});
		const ownerRecovered = owner.health().state === "ready" && owner.health().pid !== ownerPid;
		const passRows = await recallThroughDbOwner<{
			readonly id: string;
			readonly status: string;
		}>(maintenance.owner, "SELECT id, status FROM dreaming_passes ORDER BY created_at, id");
		const nextTriggerOutcome = await observeTrigger(worker.triggerAsync("incremental"));
		await worker.activePass?.catch(() => {});
		const settledPassRows = await recallThroughDbOwner<{
			readonly id: string;
			readonly status: string;
		}>(maintenance.owner, "SELECT id, status FROM dreaming_passes ORDER BY created_at, id");

		expect(protectedWhileResultHeld).toBe(true);
		expect(duplicateTrigger.kind).toBe("rejected");
		if (duplicateTrigger.kind === "rejected") expect(duplicateTrigger.error).toBeInstanceOf(AlreadyRunningError);
		expect(triggerOutcome.kind).toBe("resolved");
		expect(ownerRecovered).toBe(true);
		expect(owner.health().generation).toBeGreaterThan(generationBeforeRetirement);
		expect(passRows).toHaveLength(1);
		expect(passRows[0]).toMatchObject({ status: "completed" });
		if (triggerOutcome.kind === "resolved") expect(passRows[0]?.id).toBe(triggerOutcome.passId);
		expect(nextTriggerOutcome.kind).toBe("resolved");
		expect(settledPassRows).toHaveLength(2);
		expect(settledPassRows.every((row) => row.status === "completed")).toBe(true);
		if (triggerOutcome.kind === "resolved" && nextTriggerOutcome.kind === "resolved") {
			expect(triggerOutcome.passId).not.toBe(nextTriggerOutcome.passId);
		}
	}, 30_000);

	it("releases the deadline fence after owner retirement and completes the next pass after restart", async () => {
		if (process.platform === "win32") return;
		const current = fixture;
		if (current === null) throw new Error("real owner trigger fixture was not initialized");
		const { maintenance, owner, scopeDelay, worker } = current;
		const controlId = await worker.triggerAsync("incremental");
		const controlAttempt = worker.activePass;
		if (controlAttempt !== null) await controlAttempt;
		const controlRows = await recallThroughDbOwner<{ readonly status: string }>(
			maintenance.owner,
			"SELECT status FROM dreaming_passes WHERE id = ?",
			[controlId],
		);
		expect(controlRows).toEqual([{ status: "completed" }]);

		const generationBeforeRetirement = owner.health().generation;
		scopeDelay.arm(60_000);
		let triggerSettled = false;
		const triggerOutcome = observeTrigger(worker.triggerAsync("incremental")).then((outcome) => {
			triggerSettled = true;
			return outcome;
		});
		const activeAttempt = worker.activePass;
		await waitFor(() => {
			const blocker = scopeDelay.blocker();
			return blocker !== null && owner.health().activeJobId === blocker.job.id;
		}, 2_000);
		const blocker = scopeDelay.blocker();
		if (blocker === null) throw new Error("scope lookup blocker was not submitted");
		const blockerOutcome = blocker.result.then(
			(value) => ({ kind: "resolved" as const, value }),
			(error: unknown) => ({ kind: "rejected" as const, error }),
		);
		const ownerPid = owner.health().pid;
		if (ownerPid === null) throw new Error("DB owner did not publish its pid");
		await new Promise<void>((resolve) => setTimeout(resolve, 5_200));
		const protectedBeforeRetirement =
			!triggerSettled &&
			worker.running &&
			worker.activePass === activeAttempt &&
			owner.health().activeJobId === blocker.job.id;

		process.kill(ownerPid, "SIGKILL");
		await waitFor(() => owner.health().state === "dead", 5_000);
		const retiredBlocker = await blockerOutcome;
		const failedTrigger = await triggerOutcome;
		const releasedAfterRetirement = !worker.running && worker.activePass === null;
		const recoveryOutcome = await observeTrigger(worker.triggerAsync("incremental"));
		if (recoveryOutcome.kind === "resolved") {
			const recoveryAttempt = worker.activePass;
			if (recoveryAttempt !== null) await recoveryAttempt;
		}
		if (owner.health().state === "dead") await owner.start();
		const passRows = await recallThroughDbOwner<{
			readonly id: string;
			readonly status: string;
		}>(maintenance.owner, "SELECT id, status FROM dreaming_passes ORDER BY created_at, id");
		const runningRows = passRows.filter((row) => row.status === "running");
		const recoveredRows =
			recoveryOutcome.kind === "resolved" ? passRows.filter((row) => row.id === recoveryOutcome.passId) : [];

		expect(protectedBeforeRetirement).toBe(true);
		expect(retiredBlocker.kind).toBe("rejected");
		if (retiredBlocker.kind === "rejected") {
			expect(retiredBlocker.error).toBeInstanceOf(DbOwnerDiedError);
		}
		expect(failedTrigger.kind).toBe("rejected");
		if (failedTrigger.kind === "rejected") {
			expect(failedTrigger.error).toBeInstanceOf(DbOwnerDeadlineError);
		}
		expect(releasedAfterRetirement).toBe(true);
		expect(owner.health().generation).toBeGreaterThan(generationBeforeRetirement);
		expect(runningRows).toEqual([]);
		expect(recoveryOutcome.kind).toBe("resolved");
		expect(recoveredRows).toEqual([{ id: expect.any(String), status: "completed" }]);
	}, 30_000);
});
