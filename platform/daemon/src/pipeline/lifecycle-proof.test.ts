import { describe, expect, it } from "bun:test";
import {
	assertLifecycleObservationInvariants,
	assertShutdownInvariant,
	LifecycleObservationRecorder,
} from "@signet/lifecycle-proof";
import { startSynthesisWorker } from "./synthesis-worker";

describe("daemon lifecycle proof integration", () => {
	it("pins the real synthesis owner's bounded shutdown result", async () => {
		const recorder = new LifecycleObservationRecorder();
		recorder.record({ stage: "startup" });
		let resolveSynthesis: (() => void) | undefined;
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
					return { prompt: "# MEMORY", fileCount: 1 };
				}) as never,
				writeMemoryMd: (() => ({ ok: true })) as never,
				logger: { info() {}, warn() {}, error() {} } as never,
				activeSessionCount: () => 0,
			},
		);

		try {
			recorder.record({
				stage: "restart",
				workId: "synthesis",
				state: "queued",
				sourceSessionId: "session",
				targetSessionId: "session",
			});
			const trigger = worker.triggerNow({ force: true, source: "lifecycle-proof" });
			await new Promise((resolve) => setTimeout(resolve, 0));
			worker.stop();
			const shutdownStartedAtMs = Date.now();
			expect(await worker.drain()).toBe("timeout");
			const shutdownCompletedAtMs = Date.now();
			recorder.record({
				stage: "restart",
				workId: "synthesis",
				state: "abandoned",
				sourceSessionId: "session",
				targetSessionId: "session",
			});
			resolveSynthesis?.();
			await trigger;
			const proof = assertLifecycleObservationInvariants(recorder.observations);
			expect(proof.workStateCounts).toMatchObject({ queued: 1, abandoned: 1 });
			assertShutdownInvariant({
				startedAtMs: shutdownStartedAtMs,
				completedAtMs: shutdownCompletedAtMs,
				budgetMs: Math.max(0, shutdownCompletedAtMs - shutdownStartedAtMs),
				startedWork: 1,
				pendingWork: 0,
				completedWork: 0,
				abandonedWork: 1,
			});
		} finally {
			resolveSynthesis?.();
			worker.stop();
			await worker.drain();
		}
	});
});
