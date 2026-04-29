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
		setImmediate(() => {
			yielded = true;
		});

		for (let i = 0; i < 50; i++) {
			await yielder();
		}
		expect(yielded).toBe(false);
	});

	it("falls back to yielding every call for invalid batch sizes", async () => {
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
			const yielder = yieldEvery(value);
			const events: string[] = [];
			const work = async () => {
				events.push("before");
				await yielder();
				events.push("after");
			};
			const probe = new Promise<void>((resolve) => {
				setImmediate(() => {
					events.push("event-loop");
					resolve();
				});
			});

			await Promise.all([work(), probe]);

			expect(events).toEqual(["before", "event-loop", "after"]);
		}
	});

	it("floors fractional batch sizes", async () => {
		const events: string[] = [];
		const yielder = yieldEvery(2.9);
		const work = async () => {
			events.push("work-1");
			await yielder();
			events.push("work-2");
			await yielder();
			events.push("done");
		};
		const probe = new Promise<void>((resolve) => {
			setImmediate(() => {
				events.push("event-loop");
				resolve();
			});
		});

		await Promise.all([work(), probe]);

		expect(events).toEqual(["work-1", "work-2", "event-loop", "done"]);
	});
});
