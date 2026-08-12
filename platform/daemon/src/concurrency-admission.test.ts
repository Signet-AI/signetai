import { describe, expect, it } from "bun:test";
import { createConcurrencyAdmission } from "./concurrency-admission";

describe("concurrency admission", () => {
	it("rejects work at the cap and accepts it again after release", () => {
		const admission = createConcurrencyAdmission(2);

		expect(admission.inFlight()).toBe(0);
		expect(admission.maxInFlight).toBe(2);
		expect(admission.acquire()).toBe(true);
		expect(admission.acquire()).toBe(true);
		expect(admission.acquire()).toBe(false);
		expect(admission.inFlight()).toBe(2);

		admission.release();
		expect(admission.inFlight()).toBe(1);
		expect(admission.acquire()).toBe(true);
	});

	it("does not underflow when release is called without an active lease", () => {
		const admission = createConcurrencyAdmission(1);

		admission.release();
		expect(admission.inFlight()).toBe(0);
	});

	it("supports a zero cap for tests and rejects invalid caps", () => {
		expect(createConcurrencyAdmission(0).acquire()).toBe(false);
		expect(() => createConcurrencyAdmission(-1)).toThrow("non-negative integer");
		expect(() => createConcurrencyAdmission(1.5)).toThrow("non-negative integer");
	});
});
