import { describe, expect, it } from "bun:test";
import { yieldEvery } from "./async-yield";

describe("yieldEvery", () => {
	it("yields control after batchSize iterations", async () => {
		const events: string[] = [];
		const yielder = yieldEvery(3);

		const work = async () => {
			for (let i = 0; i < 7; i++) {
				events.push(`work-${i}`);
				await yielder();
			}
			events.push("done");
		};

		const probe = () =>
			new Promise<void>((resolve) => {
				setImmediate(() => {
					events.push("event-loop");
					resolve();
				});
			});

		const [, probeResult] = await Promise.all([work(), probe()]);
		void probeResult;
		const eventLoopIdx = events.indexOf("event-loop");
		expect(eventLoopIdx).toBeGreaterThan(0);
		expect(eventLoopIdx).toBeLessThan(events.indexOf("done"));
	});

	it("does not yield before batchSize is reached", async () => {
		const yielder = yieldEvery(100);
		let yielded = false;
		setImmediate(() => { yielded = true; });

		for (let i = 0; i < 50; i++) {
			await yielder();
		}
		expect(yielded).toBe(false);
	});
});
