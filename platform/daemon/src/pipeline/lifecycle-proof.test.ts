import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertLifecycleObservationInvariants,
	assertShutdownInvariant,
	LifecycleObservationRecorder,
	setLifecycleObservers,
	type LifecycleObservationInput,
	type LifecycleShutdownWindow,
} from "@signet/lifecycle-proof";
import { startSynthesisWorker } from "./synthesis-worker";

describe("daemon lifecycle proof integration", () => {
	it("pins the real synthesis owner's bounded shutdown result", async () => {
		const recorder = new LifecycleObservationRecorder();
		const recorderShutdown: LifecycleShutdownWindow[] = [];
		setLifecycleObservers({
			observation: (observation: LifecycleObservationInput) => recorder.record(observation),
			shutdown: (window) => recorderShutdown.push(window),
		});
		let resolveSynthesis: (() => void) | undefined;
		let writesAfterAbandonment = 0;
		const synthesisFinished = new Promise<void>((resolve) => {
			resolveSynthesis = resolve;
		});
		const worker = startSynthesisWorker(
			{ timeout: 10, maxTokens: 100, idleGapMinutes: 15 },
			{
				getDbAccessor: (() => ({
					withReadDb: () => ({ last_end: new Date().toISOString() }),
				})) as never,
				handleSynthesisRequest: (async () => {
					await synthesisFinished;
					return { prompt: "", fileCount: 0 };
				}) as never,
				writeMemoryMd: (() => {
					writesAfterAbandonment += 1;
					return { ok: true };
				}) as never,
				logger: { info() {}, warn() {}, error() {} } as never,
				activeSessionCount: () => 0,
			},
		);
		const lastRunBefore = worker.lastRunAt;

		try {
			const trigger = worker.triggerNow({ force: true, source: "lifecycle-proof" });
			await new Promise((resolve) => setTimeout(resolve, 0));
			worker.stop();
			expect(await worker.drain()).toBe("timeout");

			resolveSynthesis?.();
			await trigger;
			expect(writesAfterAbandonment).toBe(0);
			expect(worker.lastRunAt).toBe(lastRunBefore);
			const proof = assertLifecycleObservationInvariants(recorder.observations);
			expect(proof.workStateCounts).toMatchObject({ queued: 1, abandoned: 1 });
			expect(recorderShutdown).toHaveLength(1);
			const shutdown = recorderShutdown[0];
			if (!shutdown) throw new Error("expected owner-emitted shutdown evidence");
			assertShutdownInvariant(shutdown);
		} finally {
			setLifecycleObservers(undefined);
			resolveSynthesis?.();
			worker.stop();
			await worker.drain();
		}
	});

	it("counts forced work that was scheduled but not started during shutdown", async () => {
		const recorder = new LifecycleObservationRecorder();
		const recorderShutdown: LifecycleShutdownWindow[] = [];
		setLifecycleObservers({
			observation: (observation: LifecycleObservationInput) => recorder.record(observation),
			shutdown: (window) => recorderShutdown.push(window),
		});
		const worker = startSynthesisWorker(
			{ timeout: 10, maxTokens: 100, idleGapMinutes: 15 },
			{
				getDbAccessor: (() => ({ withReadDb: () => ({ last_end: new Date().toISOString() }) })) as never,
				handleSynthesisRequest: (async () => ({ prompt: "# MEMORY", fileCount: 1 })) as never,
				writeMemoryMd: (() => ({ ok: true })) as never,
				logger: { info() {}, warn() {}, error() {} } as never,
				activeSessionCount: () => 0,
			},
		);
		const lockToken = worker.acquireWriteLock();
		if (lockToken === null) throw new Error("expected test lock");

		try {
			const queued = await worker.triggerNow({ force: true, source: "scheduled-shutdown" });
			expect(queued.skipped).toBe(true);
			expect(worker.pendingForceCount).toBe(1);
			worker.stop();
			expect(await worker.drain()).toBe("timeout");
			expect(recorderShutdown).toHaveLength(1);
			const shutdown = recorderShutdown[0];
			if (!shutdown) throw new Error("expected owner-emitted shutdown evidence");
			expect(shutdown.startedWork).toBe(1);
			expect(shutdown.pendingWork).toBe(0);
			expect(shutdown.completedWork).toBe(0);
			expect(shutdown.abandonedWork).toBe(1);
			const proof = assertLifecycleObservationInvariants(recorder.observations);
			expect(proof.workStateCounts).toMatchObject({ queued: 1, abandoned: 1 });
			assertShutdownInvariant(shutdown);
		} finally {
			setLifecycleObservers(undefined);
			worker.releaseWriteLock(lockToken);
			worker.stop();
			await worker.drain();
		}
	});

	it("does not report failed forced work as completed during shutdown", async () => {
		const recorder = new LifecycleObservationRecorder();
		const recorderShutdown: LifecycleShutdownWindow[] = [];
		setLifecycleObservers({
			observation: (observation: LifecycleObservationInput) => recorder.record(observation),
			shutdown: (window) => recorderShutdown.push(window),
		});
		let releaseSynthesis: (() => void) | undefined;
		let synthesisStarted: (() => void) | undefined;
		const synthesisStartedPromise = new Promise<void>((resolve) => {
			synthesisStarted = resolve;
		});
		const synthesisGate = new Promise<void>((resolve) => {
			releaseSynthesis = resolve;
		});
		const worker = startSynthesisWorker(
			{ timeout: 100, maxTokens: 100, idleGapMinutes: 15 },
			{
				getDbAccessor: (() => ({ withReadDb: () => ({ last_end: new Date().toISOString() }) })) as never,
				handleSynthesisRequest: (async () => {
					synthesisStarted?.();
					await synthesisGate;
					return { prompt: "", fileCount: 1 };
				}) as never,
				writeMemoryMd: (() => ({ ok: true })) as never,
				logger: { info() {}, warn() {}, error() {} } as never,
				activeSessionCount: () => 0,
			},
		);
		try {
			const queued = worker.triggerNow({ force: true, source: "failed-shutdown" });
			await synthesisStartedPromise;
			worker.stop();
			const drain = worker.drain();
			releaseSynthesis?.();
			await Promise.all([queued, drain]);

			const proof = assertLifecycleObservationInvariants(recorder.observations);
			expect(proof.workStateCounts).toMatchObject({ queued: 1, completed: 0, abandoned: 2 });
			expect(recorderShutdown).toHaveLength(1);
			const shutdown = recorderShutdown[0];
			if (!shutdown) throw new Error("expected owner-emitted shutdown evidence");
			expect(shutdown.startedWork).toBe(2);
			expect(shutdown.completedWork).toBe(0);
			expect(shutdown.abandonedWork).toBe(2);
			assertShutdownInvariant(shutdown);
		} finally {
			setLifecycleObservers(undefined);
			releaseSynthesis?.();
			worker.stop();
			await worker.drain();
		}
	});

	it("resolves an immediately started forced run with a terminal outcome", async () => {
		const recorder = new LifecycleObservationRecorder();
		setLifecycleObservers({
			observation: (observation: LifecycleObservationInput) => recorder.record(observation),
		});
		const worker = startSynthesisWorker(
			{ timeout: 100, maxTokens: 100, idleGapMinutes: 15 },
			{
				getDbAccessor: (() => ({ withReadDb: () => ({ last_end: new Date().toISOString() }) })) as never,
				handleSynthesisRequest: (async () => ({ prompt: "# MEMORY", fileCount: 1 })) as never,
				writeMemoryMd: (() => ({ ok: true })) as never,
				logger: { info() {}, warn() {}, error() {} } as never,
				activeSessionCount: () => 0,
			},
		);

		try {
			expect(await worker.triggerNow({ force: true, source: "immediate-force" })).toMatchObject({
				success: true,
				skipped: false,
			});
			const proof = assertLifecycleObservationInvariants(recorder.observations);
			expect(proof.workStateCounts).toMatchObject({ queued: 1, completed: 1, abandoned: 0 });
		} finally {
			setLifecycleObservers(undefined);
			worker.stop();
			await worker.drain();
		}
	});

	it("does not reuse a forced outcome for a scheduled run abandoned at shutdown", async () => {
		const previousSignetPath = process.env.SIGNET_PATH;
		const signetPath = mkdtempSync(join(tmpdir(), "signet-lifecycle-proof-"));
		process.env.SIGNET_PATH = signetPath;
		const recorder = new LifecycleObservationRecorder();
		const recorderShutdown: LifecycleShutdownWindow[] = [];
		setLifecycleObservers({
			observation: (observation: LifecycleObservationInput) => recorder.record(observation),
			shutdown: (window) => recorderShutdown.push(window),
		});
		let releaseScheduled: (() => void) | undefined;
		let signalScheduledStart: (() => void) | undefined;
		let synthesisCalls = 0;
		const scheduledStarted = new Promise<void>((resolve) => {
			signalScheduledStart = resolve;
		});
		const scheduledGate = new Promise<void>((resolve) => {
			releaseScheduled = resolve;
		});
		let initialTick: (() => void) | undefined;
		const originalSetTimeout = globalThis.setTimeout;
		const worker = (() => {
			globalThis.setTimeout = ((callback: () => void) => {
				initialTick = callback;
				return 0 as ReturnType<typeof setTimeout>;
			}) as typeof globalThis.setTimeout;
			try {
				return startSynthesisWorker(
					{ timeout: 10, maxTokens: 100, idleGapMinutes: 15 },
					{
						getDbAccessor: (() => ({
							withReadDb: () => ({
								last_end: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
							}),
						})) as never,
						handleSynthesisRequest: (async () => {
							synthesisCalls += 1;
							if (synthesisCalls === 1) return { prompt: "# MEMORY", fileCount: 1 };
							signalScheduledStart?.();
							await scheduledGate;
							return { prompt: "# MEMORY", fileCount: 1 };
						}) as never,
						writeMemoryMd: (() => ({ ok: true })) as never,
						logger: { info() {}, warn() {}, error() {} } as never,
						activeSessionCount: () => 0,
					},
				);
			} finally {
				globalThis.setTimeout = originalSetTimeout;
			}
		})();

		try {
			expect(
				await worker.triggerNow({ force: true, source: "forced-before-scheduled", agentId: "forced-agent" }),
			).toMatchObject({ success: true, skipped: false });
			initialTick?.();
			await scheduledStarted;
			worker.stop();
			expect(await worker.drain()).toBe("timeout");
			releaseScheduled?.();
			await Bun.sleep(0);

			const proof = assertLifecycleObservationInvariants(recorder.observations);
			expect(proof.workStateCounts).toMatchObject({ queued: 1, completed: 1, abandoned: 1 });
			expect(recorderShutdown).toHaveLength(1);
			const shutdown = recorderShutdown[0];
			if (!shutdown) throw new Error("expected owner-emitted shutdown evidence");
			expect(shutdown.startedWork).toBe(1);
			expect(shutdown.completedWork).toBe(0);
			expect(shutdown.abandonedWork).toBe(1);
			assertShutdownInvariant(shutdown);
		} finally {
			setLifecycleObservers(undefined);
			releaseScheduled?.();
			worker.stop();
			await worker.drain();
			if (previousSignetPath === undefined) {
				process.env.SIGNET_PATH = undefined;
			} else {
				process.env.SIGNET_PATH = previousSignetPath;
			}
			rmSync(signetPath, { recursive: true, force: true });
		}
	});
});
