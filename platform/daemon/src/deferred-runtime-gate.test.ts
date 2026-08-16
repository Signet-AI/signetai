import { describe, expect, it } from "bun:test";
import { createDeferredRuntimeGate, scheduleDeferredRuntimeWork } from "./deferred-runtime-gate";

describe("deferred runtime startup contention (#1609)", () => {
	it("serializes both 30-second callbacks before pipeline startup", async () => {
		const gate = createDeferredRuntimeGate();
		const callbacks: Array<{ readonly callback: () => void; readonly delayMs: number }> = [];
		const events: string[] = [];
		let deadlineKills = 0;
		let ownerActive = 0;
		let maxOwnerActive = 0;
		let pipelineFailure: unknown;

		scheduleDeferredRuntimeWork({
			gate,
			schedule: (callback, delayMs) => {
				callbacks.push({ callback, delayMs });
			},
			startIntegrity: async (): Promise<void> => {
				events.push("integrity:start");
				ownerActive += 1;
				maxOwnerActive = Math.max(maxOwnerActive, ownerActive);
				if (ownerActive > 1) deadlineKills += 1;
				await Bun.sleep(10);
				ownerActive -= 1;
				events.push("integrity:complete");
			},
			startPipeline: async (): Promise<void> => {
				try {
					if (ownerActive > 0) deadlineKills += 1;
					ownerActive += 1;
					maxOwnerActive = Math.max(maxOwnerActive, ownerActive);
					events.push("pipeline:start");
					ownerActive -= 1;
				} catch (error) {
					pipelineFailure = error;
				}
			},
			onPipelineError: (error): void => {
				pipelineFailure = error;
			},
		});

		expect(callbacks).toHaveLength(2);
		expect(callbacks.map((entry) => entry.delayMs)).toEqual([30_000, 30_000]);
		callbacks[1]?.callback();
		callbacks[0]?.callback();
		await Bun.sleep(20);

		expect(events).toEqual(["integrity:start", "integrity:complete", "pipeline:start"]);
		expect(maxOwnerActive).toBe(1);
		expect(deadlineKills).toBe(0);
		expect(pipelineFailure).toBeUndefined();
	});
});
