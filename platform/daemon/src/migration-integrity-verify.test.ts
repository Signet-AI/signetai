import { describe, expect, test } from "bun:test";
import type { DbOwnerClient } from "./db-owner-client";
import { DbOwnerAdmissionError, DbOwnerDeadlineError } from "./db-owner-client";
import { DB_OWNER_MAX_MAINTENANCE_DEADLINE_MS } from "./db-owner-protocol";
import {
	MIGRATION_VERIFY_ATTEMPT_DEADLINE_MS,
	MIGRATION_VERIFY_MAX_INCOMPLETE_ATTEMPTS,
	MIGRATION_VERIFY_PARKED_STATUS,
	MIGRATION_VERIFY_RETRY_INTERVAL_MS,
	createMigrationVerifySetupRetry,
	migrationVerifyAttemptDeadlineMs,
	migrationVerifyCheckpointKey,
	runMigrationIntegrityVerify,
	runMigrationIntegrityVerifyGate,
	type MigrationVerifyCheckpointStore,
	type MigrationVerifyResult,
} from "./migration-integrity-verify";
import type { MigrationVerifyCheckpoint } from "./incremental-database-integrity";

const owner = {} as DbOwnerClient;

function attempt(phase: MigrationVerifyResult["phase"]): MigrationVerifyResult {
	return {
		phase,
		admitted: true,
		messages: phase === "failed" ? ["corrupt"] : [],
		elapsedMs: 12,
		attemptDeadlineMs: 300_000,
	};
}

function fakeStore(
	initialAttemptCount = 0,
	events: string[] = [],
): {
	store: MigrationVerifyCheckpointStore;
	state: { checkpoint: MigrationVerifyCheckpoint; terminal: string | null };
} {
	const state = {
		checkpoint: { attemptCount: initialAttemptCount, status: "running" } as MigrationVerifyCheckpoint,
		terminal: null as string | null,
	};
	return {
		state,
		store: {
			read: async () => state.checkpoint,
			incrementIncompleteAttempt: async () => {
				events.push("attempt-persisted");
				state.checkpoint = { ...state.checkpoint, attemptCount: state.checkpoint.attemptCount + 1 };
				return state.checkpoint.attemptCount;
			},
			markTerminal: async (status) => {
				state.terminal = status;
				state.checkpoint = { ...state.checkpoint, status };
			},
		},
	};
}

describe("migration integrity verify gate", () => {
	test("returns a failed result for recognized corruption errors", async () => {
		const failure = new Error("database disk image is malformed");
		const progress: MigrationVerifyResult[] = [];
		const failingOwner = {
			submit: () => ({ result: Promise.reject(failure), metrics: Promise.resolve(undefined), job: {} }),
		} as unknown as DbOwnerClient;

		await expect(
			runMigrationIntegrityVerify({
				owner: failingOwner,
				onProgress: (result) => {
					progress.push(result);
				},
			}),
		).resolves.toMatchObject({ phase: "failed", messages: ["database disk image is malformed"] });
		expect(progress).toHaveLength(1);
		expect(progress[0]?.phase).toBe("failed");
	});

	test("returns a failed result for a novel message with SQLITE_CORRUPT", async () => {
		const failure = Object.assign(new Error("malformed database schema (novel variant)"), { code: "SQLITE_CORRUPT" });
		const failingOwner = {
			submit: () => ({ result: Promise.reject(failure), metrics: Promise.resolve(undefined), job: {} }),
		} as unknown as DbOwnerClient;

		await expect(runMigrationIntegrityVerify({ owner: failingOwner })).resolves.toMatchObject({
			phase: "failed",
			messages: ["malformed database schema (novel variant)"],
		});
	});

	test("treats non-ok integrity rows as corruption", async () => {
		const corruptOwner = {
			submit: () => ({
				result: Promise.resolve([{ integrity_check: "row missing from index" }]),
				metrics: Promise.resolve(undefined),
				job: {},
			}),
		} as unknown as DbOwnerClient;

		expect(await runMigrationIntegrityVerify({ owner: corruptOwner })).toMatchObject({ phase: "failed" });
	});

	test("treats infrastructure errors as incomplete so they remain retryable", async () => {
		const failure = new Error("owner queue rejected transiently");
		const failingOwner = {
			submit: () => ({ result: Promise.reject(failure), metrics: Promise.resolve(undefined), job: {} }),
		} as unknown as DbOwnerClient;

		await expect(runMigrationIntegrityVerify({ owner: failingOwner })).resolves.toMatchObject({
			phase: "incomplete",
			messages: ["owner queue rejected transiently"],
		});
	});

	test("releases admission failures without waiting for a nonexistent worker", async () => {
		let admissionFailures = 0;
		const admissionOwner = {
			submit: () => {
				throw new DbOwnerAdmissionError("DB_OWNER_QUEUE_FULL", "maintenance queue is full");
			},
		} as unknown as DbOwnerClient;

		const result = await runMigrationIntegrityVerify({
			owner: admissionOwner,
			onAdmissionFailure: () => {
				admissionFailures += 1;
			},
		});

		expect(result).toMatchObject({ phase: "incomplete", admitted: false });
		expect(admissionFailures).toBe(1);
	});

	test("keeps deadline completion tied to the owner worker result", async () => {
		let resolveMetrics: () => void = () => {};
		const metrics = new Promise<void>((resolve) => {
			resolveMetrics = resolve;
		});
		const settled: boolean[] = [];
		const deadlineOwner = {
			submit: () => ({
				result: Promise.reject(new DbOwnerDeadlineError("integrity-job")),
				metrics,
				job: { enqueuedAt: Date.now() },
			}),
		} as unknown as DbOwnerClient;

		await expect(
			runMigrationIntegrityVerify({
				owner: deadlineOwner,
				onWorkerSettled: () => {
					settled.push(true);
				},
			}),
		).resolves.toMatchObject({
			phase: "incomplete",
			admitted: true,
		});
		expect(settled).toEqual([]);
		resolveMetrics();
		await Bun.sleep(0);
		expect(settled).toEqual([true]);
	});

	test("scopes checkpoint state to the backup generation", () => {
		expect(migrationVerifyCheckpointKey("/tmp/memories.db.bak-v151-1234")).toBe(
			"database.migration-verify:memories.db.bak-v151-1234",
		);
		expect(migrationVerifyCheckpointKey("/tmp/memories.db.bak-v152-5678")).not.toBe(
			migrationVerifyCheckpointKey("/tmp/memories.db.bak-v151-1234"),
		);
	});

	test("derives an admissible attempt budget from the database size", () => {
		expect(migrationVerifyAttemptDeadlineMs(0)).toBe(MIGRATION_VERIFY_ATTEMPT_DEADLINE_MS);
		expect(migrationVerifyAttemptDeadlineMs(10 * 1024 * 1024)).toBe(MIGRATION_VERIFY_ATTEMPT_DEADLINE_MS + 1000);
		expect(migrationVerifyAttemptDeadlineMs(128 * 1024 * 1024)).toBeGreaterThan(migrationVerifyAttemptDeadlineMs(1024));
		const largeDatabaseBudget = migrationVerifyAttemptDeadlineMs(7.8 * 1024 ** 3);
		expect(largeDatabaseBudget).toBeGreaterThanOrEqual(MIGRATION_VERIFY_ATTEMPT_DEADLINE_MS);
		expect(largeDatabaseBudget).toBeLessThanOrEqual(DB_OWNER_MAX_MAINTENANCE_DEADLINE_MS);
		expect(migrationVerifyAttemptDeadlineMs(Number.MAX_VALUE)).toBe(DB_OWNER_MAX_MAINTENANCE_DEADLINE_MS);
		expect(MIGRATION_VERIFY_RETRY_INTERVAL_MS).toBe(30 * 60_000);
	});

	test("bounds setup rejection retries and shares the policy with continuations", async () => {
		const scheduled: Array<() => void> = [];
		const warnings: number[] = [];
		const giveUps: number[] = [];
		let calls = 0;
		let capsReached = 0;
		const retry = createMigrationVerifySetupRetry({
			run: async () => {
				calls += 1;
				throw new Error(`rejection ${calls}`);
			},
			scheduleNextAttempt: (callback, delayMs) => {
				expect(delayMs).toBe(MIGRATION_VERIFY_RETRY_INTERVAL_MS);
				scheduled.push(callback);
			},
			logWarn: (_message, details) => warnings.push(Number(details.attemptCount)),
			logError: (_message, _error, details) => giveUps.push(Number(details.attemptCount)),
			onRetryCapReached: () => {
				capsReached += 1;
			},
		});

		retry.run();
		await Bun.sleep(0);
		scheduled.shift()?.();
		await Bun.sleep(0);
		expect(capsReached).toBe(0);
		scheduled.shift()?.();
		await Bun.sleep(0);

		expect(calls).toBe(3);
		expect(warnings).toEqual([1, 2]);
		expect(giveUps).toEqual([3]);
		expect(capsReached).toBe(1);
	});

	test("prunes the rollback backup only after a pass result", async () => {
		const { store, state } = fakeStore();
		let pruned = false;
		let reset = false;
		const publications: Array<{ state: string; messages: readonly string[] | undefined }> = [];
		const result = await runMigrationIntegrityVerifyGate({
			owner,
			backupPath: "/tmp/memories.db.bak-v151-1234",
			checkpointStore: store,
			runAttempt: async () => attempt("pass"),
			pruneBackup: () => {
				pruned = true;
			},
			resetGlobalLatch: () => {
				reset = true;
			},
			publishStatus: (publishedState, messages) => {
				publications.push({ state: publishedState, messages });
			},
		});

		expect(result.phase).toBe("pass");
		expect(pruned).toBe(true);
		expect(reset).toBe(true);
		expect(state.terminal).toBe("complete");
		expect(publications).toEqual([
			{ state: "degraded", messages: ["degraded:integrity-unverified"] },
			{ state: "healthy", messages: undefined },
		]);
	});

	test("records the pass checkpoint before rollback pruning", async () => {
		const { store, state } = fakeStore();
		const logs: Array<{ message: string; details: Record<string, unknown> | undefined }> = [];
		const pruneError = new Error("disk full while deleting backup");

		await expect(
			runMigrationIntegrityVerifyGate({
				owner,
				backupPath: "/tmp/memories.db.bak-v151-1234",
				checkpointStore: store,
				runAttempt: async () => attempt("pass"),
				pruneBackup: () => {
					throw pruneError;
				},
				log: (message, details) => logs.push({ message, details }),
			}),
		).rejects.toThrow("disk full while deleting backup");

		expect(state.terminal).toBe("complete");
		expect(logs).toContainEqual({
			message: "Global integrity check passed but rollback backup prune failed",
			details: { error: "disk full while deleting backup" },
		});
	});

	test("retains the rollback backup and schedules only one fixed-delay retry after incomplete", async () => {
		const events: string[] = [];
		const { store, state } = fakeStore(0, events);
		let pruned = false;
		let scheduledDelay = 0;
		const publications: Array<{ state: string; messages: readonly string[] | undefined }> = [];
		const result = await runMigrationIntegrityVerifyGate({
			owner,
			backupPath: "/tmp/memories.db.bak-v151-1234",
			checkpointStore: store,
			runAttempt: async () => {
				expect(events).toEqual(["attempt-persisted"]);
				events.push("integrity-check");
				return attempt("incomplete");
			},
			pruneBackup: () => {
				pruned = true;
			},
			scheduleNextAttempt: (_callback, delayMs) => {
				scheduledDelay = delayMs;
			},
			publishStatus: (publishedState, messages) => {
				publications.push({ state: publishedState, messages });
			},
		});

		expect(result.phase).toBe("incomplete");
		expect(result.scheduled).toBe(true);
		expect(pruned).toBe(false);
		expect(scheduledDelay).toBe(MIGRATION_VERIFY_RETRY_INTERVAL_MS);
		expect(state.checkpoint.attemptCount).toBe(1);
		expect(publications).toEqual([{ state: "degraded", messages: ["degraded:integrity-unverified"] }]);
	});

	test("routes continuation retries through the injected wrapped runner", async () => {
		const { store } = fakeStore();
		let scheduled: (() => void) | undefined;
		let wrappedCalls = 0;
		await runMigrationIntegrityVerifyGate({
			owner,
			backupPath: "/tmp/memories.db.bak-v151-wrapped",
			checkpointStore: store,
			runAttempt: async () => attempt("incomplete"),
			pruneBackup: () => {},
			scheduleNextAttempt: (callback) => {
				scheduled = callback;
			},
			continuation: async () => {
				wrappedCalls += 1;
				return { phase: "terminal", attemptCount: 1, admitted: false, scheduled: false };
			},
		});

		scheduled?.();
		await Bun.sleep(0);
		expect(wrappedCalls).toBe(1);
	});

	test("retains the rollback backup and stops immediately after a failed result", async () => {
		const { store, state } = fakeStore();
		let pruned = false;
		let scheduled = false;
		const publications: Array<{ state: string; messages: readonly string[] | undefined }> = [];
		const result = await runMigrationIntegrityVerifyGate({
			owner,
			backupPath: "/tmp/memories.db.bak-v151-1234",
			checkpointStore: store,
			runAttempt: async () => attempt("failed"),
			pruneBackup: () => {
				pruned = true;
			},
			scheduleNextAttempt: () => {
				scheduled = true;
			},
			publishStatus: (publishedState, messages) => {
				publications.push({ state: publishedState, messages });
			},
		});

		expect(result.phase).toBe("failed");
		expect(pruned).toBe(false);
		expect(scheduled).toBe(false);
		expect(state.terminal).toBe("failed:integrity-unverified");
		expect(publications).toEqual([
			{ state: "degraded", messages: ["degraded:integrity-unverified"] },
			{ state: "corrupt", messages: ["corrupt"] },
		]);
	});

	test("arms the write block when a durable failed checkpoint is discovered late", async () => {
		const { store, state } = fakeStore();
		state.checkpoint = { attemptCount: 4, status: "failed:integrity-unverified" };
		let armed = 0;
		const published: string[] = [];

		const result = await runMigrationIntegrityVerifyGate({
			owner,
			backupPath: "/tmp/memories.db.bak-v151-late-failure",
			checkpointStore: store,
			pruneBackup: () => {},
			armWriteBlock: () => {
				armed += 1;
			},
			publishStatus: (status) => published.push(status),
		});

		expect(result.phase).toBe("terminal");
		expect(armed).toBe(1);
		expect(published).toEqual(["corrupt"]);
	});

	test("publishes corruption before a terminal checkpoint write fails", async () => {
		const { store } = fakeStore();
		const events: string[] = [];
		const publications: string[] = [];
		const logs: string[] = [];
		const failingStore: MigrationVerifyCheckpointStore = {
			...store,
			markTerminal: async () => {
				events.push("mark-terminal");
				throw new Error("checkpoint owner rejected");
			},
		};

		await expect(
			runMigrationIntegrityVerifyGate({
				owner,
				backupPath: "/tmp/memories.db.bak-v151-1234",
				checkpointStore: failingStore,
				runAttempt: async () => attempt("failed"),
				pruneBackup: () => {},
				publishStatus: (state) => {
					events.push(`publish-${state}`);
					publications.push(state);
				},
				log: (message) => logs.push(message),
			}),
		).rejects.toThrow("checkpoint owner rejected");

		expect(events).toEqual(["publish-degraded", "publish-corrupt", "mark-terminal"]);
		expect(publications).toEqual(["degraded", "corrupt"]);
		expect(logs).toContain("Global integrity check failed; terminal checkpoint persistence rejected");
	});

	test("parks after eight incomplete attempts with degraded:integrity-unverified", async () => {
		const { store, state } = fakeStore(MIGRATION_VERIFY_MAX_INCOMPLETE_ATTEMPTS - 1);
		let pruned = false;
		let scheduled = false;
		const publications: Array<{ state: string; messages: readonly string[] | undefined }> = [];
		const result = await runMigrationIntegrityVerifyGate({
			owner,
			backupPath: "/tmp/memories.db.bak-v151-1234",
			checkpointStore: store,
			runAttempt: async () => attempt("incomplete"),
			pruneBackup: () => {
				pruned = true;
			},
			scheduleNextAttempt: () => {
				scheduled = true;
			},
			publishStatus: (publishedState, messages) => {
				publications.push({ state: publishedState, messages });
			},
		});

		expect(result.phase).toBe("parked");
		expect(result.attemptCount).toBe(MIGRATION_VERIFY_MAX_INCOMPLETE_ATTEMPTS);
		expect(state.terminal).toBe(MIGRATION_VERIFY_PARKED_STATUS);
		expect(pruned).toBe(false);
		expect(scheduled).toBe(false);
		expect(publications).toEqual([{ state: "degraded", messages: ["degraded:integrity-unverified"] }]);
	});
});
