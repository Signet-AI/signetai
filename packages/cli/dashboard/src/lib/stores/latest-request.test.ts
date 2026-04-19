// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { createLatestRequestGate } from "./latest-request";

describe("latest request gate", () => {
	it("marks older async requests as stale after a newer request starts", () => {
		const gate = createLatestRequestGate();

		const first = gate.next();
		const second = gate.next();

		expect(gate.isCurrent(first)).toBe(false);
		expect(gate.isCurrent(second)).toBe(true);
	});
});
