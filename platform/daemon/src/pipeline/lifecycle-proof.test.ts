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
			const trigger = worker.triggerNow({ force: true, source: "lifecycle-proof" });
			await new Promise((resolve) => setTimeout(resolve, 0));
			worker.stop();
			expect(await worker.drain()).toBe("timeout");

			resolveSynthesis?.();
			await trigger;
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
});
