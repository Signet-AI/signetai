import { describe, expect, it } from "bun:test";
import {
	createDeferredRuntimeGate,
	createDeferredRuntimeScheduler,
	releaseDeferredRuntimeGateIfSafe,
	scheduleDeferredRuntimeWork,
} from "./deferred-runtime-gate";

describe("deferred runtime startup contention (#1609)", () => {
	it("releases ordinary startup without waiting for background integrity", async () => {
		const gate = createDeferredRuntimeGate();
		let pipelineStarted = false;
		const pipeline = gate.waitForIntegrity().then(() => {
			pipelineStarted = true;
		});

		expect(
			releaseDeferredRuntimeGateIfSafe(gate, {
				migrationBackupPending: false,
				writesBlocked: false,
			}),
		).toBe(true);
		await pipeline;

		expect(pipelineStarted).toBe(true);
	});

	it("keeps startup gated while migration verification is required", async () => {
		const gate = createDeferredRuntimeGate();
		let pipelineStarted = false;
		const pipeline = gate.waitForIntegrity().then(() => {
			pipelineStarted = true;
		});

		expect(
			releaseDeferredRuntimeGateIfSafe(gate, {
				migrationBackupPending: true,
				writesBlocked: false,
			}),
		).toBe(false);
		expect(
			releaseDeferredRuntimeGateIfSafe(gate, {
				migrationBackupPending: false,
				writesBlocked: true,
			}),
		).toBe(false);
		await Bun.sleep(0);
		expect(pipelineStarted).toBe(false);

		gate.completeIntegrity();
		await pipeline;
		expect(pipelineStarted).toBe(true);
	});

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

	it("keeps FTS maintenance behind the deferred integrity gate", async () => {
		const gate = createDeferredRuntimeGate();
		const callbacks: Array<() => void> = [];
		const events: string[] = [];

		const scheduler = createDeferredRuntimeScheduler({
			gate,
			schedule: (callback) => callbacks.push(callback),
			onPipelineError: (error) => events.push(`pipeline-error:${String(error)}`),
			onMaintenanceError: (error) => events.push(`maintenance-error:${String(error)}`),
		});
		scheduler.scheduleMaintenance(async () => {
			events.push("maintenance:start");
		});

		expect(callbacks).toHaveLength(1);
		callbacks[0]?.();
		await Bun.sleep(0);
		expect(events).toEqual([]);

		gate.completeIntegrity();
		await Bun.sleep(0);
		expect(events).toEqual(["maintenance:start"]);
	});

	it("can hold integrity completion until an observed slice result", async () => {
		const gate = createDeferredRuntimeGate();
		const callbacks: Array<() => void> = [];
		let integrityFinished = false;
		let pipelineStarted = false;
		const scheduler = createDeferredRuntimeScheduler({
			gate,
			completeIntegrityOnCallback: false,
			schedule: (callback) => callbacks.push(callback),
			onPipelineError: () => {},
			onMaintenanceError: () => {},
		});
		scheduler.scheduleIntegrity(async () => {
			integrityFinished = true;
		});
		scheduler.schedulePipeline(async () => {
			pipelineStarted = true;
			expect(integrityFinished).toBe(true);
		});

		callbacks[0]?.();
		callbacks[1]?.();
		await Bun.sleep(0);
		expect(integrityFinished).toBe(true);
		expect(pipelineStarted).toBe(false);
		gate.completeIntegrity();
		await Bun.sleep(0);
		expect(pipelineStarted).toBe(true);
	});

	it("releases the gate and reports a rejected integrity callback", async () => {
		const gate = createDeferredRuntimeGate();
		const callbacks: Array<() => void> = [];
		const events: string[] = [];
		const scheduler = createDeferredRuntimeScheduler({
			gate,
			completeIntegrityOnCallback: false,
			schedule: (callback) => callbacks.push(callback),
			onPipelineError: (error) => events.push(`pipeline-error:${String(error)}`),
			onMaintenanceError: (error) => events.push(`maintenance-error:${String(error)}`),
			onIntegrityFailure: (error) => events.push(`integrity-error:${String(error)}`),
		});
		scheduler.scheduleIntegrity(async () => {
			throw new Error("integrity failed");
		});
		scheduler.schedulePipeline(async () => {
			events.push("pipeline:start");
		});

		callbacks[1]?.();
		callbacks[0]?.();
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(events).toEqual(["integrity-error:Error: integrity failed", "pipeline:start"]);
	});
});
