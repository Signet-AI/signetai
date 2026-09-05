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

type ErrorWithPrepareStackTrace = typeof Error & {
	prepareStackTrace?: (...args: unknown[]) => string;
};

function withPreparedStack<T>(stack: string, action: () => T): T {
	const errorConstructor = Error as ErrorWithPrepareStackTrace;
	const previous = errorConstructor.prepareStackTrace;
	errorConstructor.prepareStackTrace = () => stack;
	try {
		return action();
	} finally {
		errorConstructor.prepareStackTrace = previous;
	}
}

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

	test("captures valid Windows source locations with spaces before queueing", () => {
		const stack = [
			"Error",
			"    at captureCallerSite (C:/repo/platform/daemon/src/sync-db-attribution.ts:110:1)",
			"    at captureSyncDbCallSiteToken (C:/repo/platform/daemon/src/sync-db-attribution.ts:262:1)",
			"    at runWriteTxAsync (C:/repo/platform/daemon/src/db-accessor.ts:3029:1)",
			"    at caller (C:/Program Files/Signet/daemon.js:54:1)",
		].join("\n");

		expect(classifySyncDbSiteToken("C:/Program Files/Signet/daemon.js:54")).toBe("source-location");
		expect(normalizeSyncDbSiteToken("C:/Program Files/Signet/daemon.js:54")).toBe(
			"/C:/Program Files/Signet/daemon.js:54",
		);
		const siteToken = withPreparedStack(stack, () => captureSyncDbCallSiteToken());

		expect(siteToken).toBe("/C:/Program Files/Signet/daemon.js:54");
		const token = beginSyncDbCall("withWriteTxAsync", 1_000, siteToken);
		expect(token.siteId).toBe("withWriteTxAsync@/C:/Program Files/Signet/daemon.js:54");
	});

	test("does not attribute anonymous raw-backslash internal frames", () => {
		const stack = [
			"Error",
			String.raw`    at captureCallerSite (C:\repo\platform\daemon\src\sync-db-attribution.ts:110:1)`,
			String.raw`    at C:\repo\platform\daemon\src\db-accessor.ts:2789:1`,
		].join("\n");
		const token = beginSyncDbCall("withWriteTxAsync", 1_000);

		withPreparedStack(stack, () => endSyncDbCall(token, 1_051));

		expect(getSyncDbCallSitesForWindow(1_000, 1_051)).toEqual(["withWriteTxAsync@unattributed"]);
		expect(getSyncDbAttributionMetrics().unattributedCalls).toBe(1);
		expect(getSyncDbAttributionMetrics().sites).toEqual([]);
	});
});
