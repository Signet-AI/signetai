import { describe, expect, it } from "bun:test";
import { createSingleFlightRunner } from "./single-flight-runner";

describe("createSingleFlightRunner", () => {
	it("replays one follow-up pass when a rerun is requested during execution", async () => {
		const phases: string[] = [];
		let runs = 0;
		let releaseFirstRun: (() => void) | null = null;

		const runner = createSingleFlightRunner(async () => {
			runs += 1;
			phases.push(`run-${runs}-start`);
			if (runs === 1) {
				await new Promise<void>((resolve) => {
					releaseFirstRun = resolve;
				});
			}
			phases.push(`run-${runs}-end`);
		});

		const first = runner.execute();
		expect(runner.running).toBe(true);

		runner.requestRerun();
		await runner.execute();

		releaseFirstRun?.();
		await first;

		expect(runs).toBe(2);
		expect(phases).toEqual(["run-1-start", "run-1-end", "run-2-start", "run-2-end"]);
		expect(runner.running).toBe(false);
	});

	it("collapses repeated rerun requests into one extra pass", async () => {
		let runs = 0;
		let releaseFirstRun: (() => void) | null = null;

		const runner = createSingleFlightRunner(async () => {
			runs += 1;
			if (runs === 1) {
				await new Promise<void>((resolve) => {
					releaseFirstRun = resolve;
				});
			}
		});

		const first = runner.execute();
		runner.requestRerun();
		runner.requestRerun();
		runner.requestRerun();

		releaseFirstRun?.();
		await first;

		expect(runs).toBe(2);
	});

	it("replays a queued rerun after a transient failure", async () => {
		const phases: string[] = [];
		let runs = 0;
		let releaseFirstRun: (() => void) | null = null;
		const seenErrors: string[] = [];

		const runner = createSingleFlightRunner(
			async () => {
				runs += 1;
				phases.push(`run-${runs}-start`);
				if (runs === 1) {
					await new Promise<void>((resolve) => {
						releaseFirstRun = resolve;
					});
					phases.push("run-1-throw");
					throw new Error("transient sync failure");
				}
				phases.push(`run-${runs}-end`);
			},
			(error) => {
				seenErrors.push(error.message);
			},
		);

		const first = runner.execute();
		expect(runner.running).toBe(true);

		runner.requestRerun();
		releaseFirstRun?.();
		await first;

		expect(runs).toBe(2);
		expect(phases).toEqual(["run-1-start", "run-1-throw", "run-2-start", "run-2-end"]);
		expect(seenErrors).toEqual(["transient sync failure"]);
		expect(runner.running).toBe(false);
	});
});
