import { describe, expect, test } from "bun:test";
import { addAccountingCoverage, emptyAccountingCoverage } from "./telemetry-routes";

describe("telemetry accounting coverage", () => {
	test("keeps mixed session summaries out of unavailable coverage", () => {
		const coverage = emptyAccountingCoverage();

		addAccountingCoverage(coverage, "mixed", 42, 0.12);

		expect(coverage.mixed).toEqual({ calls: 1, tokens: 42, cost: 0.12 });
		expect(coverage.unavailable).toEqual({ calls: 0, tokens: 0, cost: 0 });
	});

	test("maps unknown legacy provenance to unavailable", () => {
		const coverage = emptyAccountingCoverage();

		addAccountingCoverage(coverage, undefined, null, null);

		expect(coverage.unavailable).toEqual({ calls: 1, tokens: 0, cost: 0 });
		expect(coverage.mixed).toEqual({ calls: 0, tokens: 0, cost: 0 });
	});
});
