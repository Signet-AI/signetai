import { afterEach, describe, expect, test } from "bun:test";
import {
	beginSyncDbCall,
	endSyncDbCall,
	getSyncDbAttributionMetrics,
	getSyncDbCallSitesForWindow,
	resetSyncDbAttribution,
} from "./sync-db-attribution";

afterEach(() => {
	resetSyncDbAttribution();
});

describe("sync DB attribution", () => {
	test("keeps fast calls on the timestamp-only path", () => {
		const token = beginSyncDbCall("withReadDb", 1_000);
		endSyncDbCall(token, 1_001);

		expect(getSyncDbAttributionMetrics()).toMatchObject({
			calls: 1,
			slowCalls: 0,
			unattributedCalls: 1,
		});
		expect(getSyncDbAttributionMetrics().sites).toEqual([]);
	});

	test("latches the explicit file and line for a never-completing in-flight call", () => {
		const token = beginSyncDbCall("withReadDb", 1_000, "sync-db-attribution.test.ts:28");

		expect(getSyncDbCallSitesForWindow(1_000, 2_000)).toEqual([
			"withReadDb@platform/daemon/src/sync-db-attribution.test.ts:28",
		]);
		void token;
	});

	test("latches a stable semantic site token without a source-line dependency", () => {
		const token = beginSyncDbCall("withReadDb", 1_000, "db:memory.projection.ledger");

		expect(getSyncDbCallSitesForWindow(1_000, 2_000)).toEqual(["withReadDb@db:memory.projection.ledger"]);
		void token;
	});

	test("keeps an invalid site token explicitly unattributed", () => {
		const token = beginSyncDbCall("withReadDb", 1_000, "not-a-site");
		endSyncDbCall(token, 1_051);

		expect(getSyncDbCallSitesForWindow(1_000, 1_051)).toEqual(["withReadDb@unattributed"]);
		expect(getSyncDbAttributionMetrics().unattributedSlowDurationMs).toBe(51);
	});

	test("captures a caller only when a slow call needs attribution", () => {
		const token = beginSyncDbCall("withWriteTx", 1_000);
		endSyncDbCall(token, 1_051);

		const metrics = getSyncDbAttributionMetrics();
		expect(metrics.slowCalls).toBe(1);
		expect(metrics.unattributedCalls).toBe(0);
		expect(metrics.sites).toHaveLength(1);
		expect(metrics.sites[0]?.siteId).toContain("sync-db-attribution.test.ts:");
	});
});
