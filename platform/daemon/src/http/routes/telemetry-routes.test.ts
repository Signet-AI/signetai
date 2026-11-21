import { describe, expect, test } from "bun:test";
import {
	addAccountingCoverage,
	addDreamingCacheAccounting,
	addDreamingCacheAccountingByDimension,
	dreamingCacheHitRate,
	emptyAccountingCoverage,
	emptyDreamingCacheAccounting,
} from "./telemetry-routes";

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

describe("dreaming cache accounting", () => {
	test("aggregates bounded event fields and preserves unavailable coverage", () => {
		const totals = emptyDreamingCacheAccounting();
		addDreamingCacheAccounting(totals, {
			cacheAccountingAvailable: true,
			cacheRequests: 4,
			cacheHits: 1,
			cacheMisses: 1,
			cacheUnknown: 2,
			cacheWrites: 1,
		});
		addDreamingCacheAccounting(totals, {
			cacheAccountingAvailable: false,
			cacheRequests: null,
			cacheHits: null,
			cacheMisses: null,
			cacheUnknown: null,
			cacheWrites: null,
		});

		expect(totals).toEqual({
			cacheRequests: 4,
			cacheHits: 1,
			cacheMisses: 1,
			cacheUnknown: 2,
			cacheWrites: 1,
			cacheAccountingAvailablePasses: 1,
			cacheAccountingUnavailablePasses: 1,
		});
	});

	test("uses only classified requests as the hit-rate denominator", () => {
		const totals = emptyDreamingCacheAccounting();
		totals.cacheRequests = 4;
		totals.cacheHits = 1;
		totals.cacheMisses = 1;
		totals.cacheUnknown = 2;

		expect(dreamingCacheHitRate(totals)).toBe(0.5);
	});

	test("returns no rate when provider cache semantics are unavailable", () => {
		expect(dreamingCacheHitRate(emptyDreamingCacheAccounting())).toBeNull();
	});

	test("does not aggregate counters from unavailable cache accounting", () => {
		const totals = emptyDreamingCacheAccounting();
		addDreamingCacheAccounting(totals, {
			cacheAccountingAvailable: false,
			cacheRequests: 4,
			cacheHits: 4,
			cacheMisses: 0,
			cacheUnknown: 0,
			cacheWrites: 0,
		});

		expect(totals).toEqual({
			cacheRequests: 0,
			cacheHits: 0,
			cacheMisses: 0,
			cacheUnknown: 0,
			cacheWrites: 0,
			cacheAccountingAvailablePasses: 0,
			cacheAccountingUnavailablePasses: 1,
		});
	});

	test("aggregates cache accounting by provider, model, and workload class", () => {
		const properties = {
			cacheAccountingAvailable: true,
			cacheRequests: 2,
			cacheHits: 1,
			cacheMisses: 1,
			cacheUnknown: 0,
			cacheWrites: 1,
			provider: "anthropic",
			model: "claude-test",
			workloadClass: "memory_extraction",
		};
		const providers = new Map<string, ReturnType<typeof emptyDreamingCacheAccounting>>();
		const models = new Map<string, ReturnType<typeof emptyDreamingCacheAccounting>>();
		const workloadClasses = new Map<string, ReturnType<typeof emptyDreamingCacheAccounting>>();

		addDreamingCacheAccountingByDimension(providers, properties, "provider");
		addDreamingCacheAccountingByDimension(models, properties, "model");
		addDreamingCacheAccountingByDimension(workloadClasses, properties, "workloadClass");

		expect(providers.get("anthropic")).toMatchObject({ cacheRequests: 2, cacheHits: 1, cacheMisses: 1 });
		expect(models.get("claude-test")).toMatchObject({ cacheRequests: 2, cacheHits: 1, cacheMisses: 1 });
		expect(workloadClasses.get("memory_extraction")).toMatchObject({ cacheRequests: 2, cacheHits: 1, cacheMisses: 1 });
	});
});
