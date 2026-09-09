import { describe, expect, it } from "bun:test";
import { startDeferredRuntimeAfterDreaming } from "./dreaming-startup";

describe("Dreaming startup admission", () => {
	it("keeps the worker available when deferred startup rejects", async () => {
		let workerAvailable = false;
		let deferredSawWorker = false;
		const startupFailure = new Error("deferred startup failed");

		const deferredRuntime = startDeferredRuntimeAfterDreaming(
			() => {
				workerAvailable = true;
			},
			async () => {
				deferredSawWorker = workerAvailable;
				throw startupFailure;
			},
		);

		await expect(deferredRuntime).rejects.toBe(startupFailure);
		expect(deferredSawWorker).toBe(true);
		expect(workerAvailable).toBe(true);
	});
});
