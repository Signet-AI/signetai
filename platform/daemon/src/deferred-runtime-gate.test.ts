import { describe, expect, it } from "bun:test";
import { createDeferredRuntimeGate } from "./deferred-runtime-gate";

describe("deferred runtime startup contention (#1609)", () => {
	it("starts the pipeline only after the same-tick integrity work completes", async () => {
		const gate = createDeferredRuntimeGate();
		const events: string[] = [];

		const integrity = (async (): Promise<void> => {
			events.push("integrity:start");
			await Bun.sleep(10);
			events.push("integrity:complete");
			gate.completeIntegrity();
		})();
		const pipeline = (async (): Promise<void> => {
			await gate.waitForIntegrity();
			events.push("pipeline:start");
		})();

		await Promise.all([integrity, pipeline]);

		expect(events).toEqual(["integrity:start", "integrity:complete", "pipeline:start"]);
	});
});
