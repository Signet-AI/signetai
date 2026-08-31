import { afterEach, describe, expect, test } from "bun:test";
import {
	beginSyncDbCall,
	captureSyncDbCallSiteToken,
	endSyncDbCall,
	getSyncDbAttributionMetrics,
	getSyncDbCallSitesForWindow,
	resetSyncDbAttribution,
} from "./sync-db-attribution";
import { classifySyncDbSiteToken, normalizeSyncDbSiteToken } from "./sync-db-site-token";

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

	test("latches a stable semantic ID without a source line", () => {
		const token = beginSyncDbCall("withReadDb", 1_000, "db:vacuum.status.read");

		expect(getSyncDbCallSitesForWindow(1_000, 2_000)).toEqual(["withReadDb@db:vacuum.status.read"]);
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

	test("captures source-tree caller tokens before queueing", () => {
		expect(captureSyncDbCallSiteToken()).toMatch(/^sync-db-attribution\.test\.ts:\d+$/);
	});

	test("keeps absolute bundled source locations intact in attribution IDs", () => {
		const token = beginSyncDbCall("withWriteTxAsync", 1_000, "/dist/daemon.js:54");

		expect(token.siteId).toBe("withWriteTxAsync@/dist/daemon.js:54");
	});

	test("accepts absolute bundled source locations while rejecting malformed paths", () => {
		expect(classifySyncDbSiteToken("/dist/daemon.js:54")).toBe("source-location");
		expect(classifySyncDbSiteToken("dir/file.ts:12")).toBe("source-location");
		expect(classifySyncDbSiteToken("//dist/daemon.js:54")).toBeNull();
		expect(classifySyncDbSiteToken("/dist//daemon.js:54")).toBeNull();
		expect(classifySyncDbSiteToken("dir//file.ts:12")).toBeNull();
	});

	test("normalizes Windows absolute source locations without accepting duplicate separators", () => {
		const driveBackslash = String.raw`C:\work\daemon.js:54`;
		const uncBackslash = String.raw`\\server\share\daemon.js:54`;
		const duplicateDriveSeparator = String.raw`C:\\work\daemon.js:54`;
		const duplicateUncSeparator = String.raw`\\server\\share\daemon.js:54`;

		expect(classifySyncDbSiteToken("C:/work/daemon.js:54")).toBe("source-location");
		expect(classifySyncDbSiteToken(driveBackslash)).toBe("source-location");
		expect(classifySyncDbSiteToken("/C:/work/daemon.js:54")).toBe("source-location");
		expect(classifySyncDbSiteToken(uncBackslash)).toBe("source-location");
		expect(normalizeSyncDbSiteToken(driveBackslash)).toBe("/C:/work/daemon.js:54");
		expect(normalizeSyncDbSiteToken("/C:/work/daemon.js:54")).toBe("/C:/work/daemon.js:54");
		expect(normalizeSyncDbSiteToken(uncBackslash)).toBe("/UNC/server/share/daemon.js:54");
		expect(classifySyncDbSiteToken(duplicateDriveSeparator)).toBeNull();
		expect(classifySyncDbSiteToken(duplicateUncSeparator)).toBeNull();

		const token = beginSyncDbCall("withWriteTxAsync", 1_000, "C:/work/daemon.js:54");
		expect(token.siteId).toBe("withWriteTxAsync@/C:/work/daemon.js:54");
	});
});
