import { describe, expect, it } from "bun:test";
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
		const recorderShutdown: LifecycleShutdownWindow[] = [];
		setLifecycleObservers({ shutdown: (window) => recorderShutdown.push(window) });
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
			expect(shutdown.pendingWork).toBe(1);
			expect(shutdown.completedWork).toBe(0);
			expect(shutdown.abandonedWork).toBe(0);
			assertShutdownInvariant(shutdown);
		} finally {
			setLifecycleObservers(undefined);
			worker.releaseWriteLock(lockToken);
			worker.stop();
			await worker.drain();
		}
	});
});
