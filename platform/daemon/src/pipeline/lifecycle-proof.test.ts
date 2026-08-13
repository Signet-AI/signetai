import { describe, expect, it } from "bun:test";
import { assertLifecycleInvariants } from "@signet/lifecycle-proof";
import { startSynthesisWorker } from "./synthesis-worker";

describe("daemon lifecycle proof integration", () => {
	it("pins the real synthesis owner's bounded shutdown result", async () => {
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
			assertLifecycleInvariants({
				observations: [
					{ stage: "startup", sequence: 1 },
					{
						stage: "restart",
						workId: "synthesis",
						state: "queued",
						sourceSessionId: "session",
						targetSessionId: "session",
						sequence: 2,
					},
					{
						stage: "restart",
						workId: "synthesis",
						state: "abandoned",
						sourceSessionId: "session",
						targetSessionId: "session",
						sequence: 3,
					},
				],
				shutdown: {
					startedAtMs: 100,
					completedAtMs: 105,
					budgetMs: 10,
					startedWork: 1,
					pendingWork: 0,
					completedWork: 0,
					abandonedWork: 1,
				},
				slowProvider: { startedAtMs: 100, completedAtMs: 2_000, promptHandledAtMs: 105 },
			});
		} finally {
			resolveSynthesis?.();
			worker.stop();
			await worker.drain();
		}
	});
});
