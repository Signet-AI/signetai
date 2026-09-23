import { describe, expect, it } from "bun:test";
import { completeFtsStartupRecovery } from "./fts-startup-recovery";

describe("FTS startup recovery pacing", () => {
	it("waits one second between bounded continuation passes", async () => {
		let passes = 0;
		let continuation: { readonly callback: () => void; readonly delayMs: number } | null = null;
		const recovery = completeFtsStartupRecovery({
			backfill: async () => {
				passes += 1;
				return {
					checkpointKey: "fts.memories.startup",
					status: passes === 1 ? "running" : "complete",
					cursor: passes,
					chunks: 1,
					processed: 1,
				};
			},
			scheduleContinuation: (callback, delayMs) => {
				continuation = { callback, delayMs };
			},
		});

		await Bun.sleep(0);
		expect(passes).toBe(1);
		expect(continuation?.delayMs).toBe(1_000);
		continuation?.callback();
		expect((await recovery).status).toBe("complete");
		expect(passes).toBe(2);
	});
});
