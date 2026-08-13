import { describe, expect, test } from "bun:test";
import { detectFilesystemType, isNetworkFilesystem, resolveSqliteJournalConfig } from "./sqlite-journal";

describe("SQLite journal selection", () => {
	test("detects a mocked Darwin network-volume path", () => {
		expect(
			detectFilesystemType("/Volumes/team-share/.agents/memory", {
				platform: "darwin",
				statfs: () => ({ f_fstypename: "smbfs" }),
			}),
		).toBe("smbfs");

		expect(
			resolveSqliteJournalConfig({
				platform: "darwin",
				directory: "/Volumes/team-share/.agents/memory",
				statfs: () => ({ f_fstypename: "smbfs" }),
			}),
		).toEqual({
			filesystemType: "smbfs",
			networkFilesystem: true,
			journalMode: "DELETE",
		});
	});

	test("uses rollback journaling with FULL synchronous mode for NFS", () => {
		expect(isNetworkFilesystem("NFS")).toBe(true);
		expect(resolveSqliteJournalConfig({ platform: "darwin", filesystemType: "nfs" })).toMatchObject({
			networkFilesystem: true,
			journalMode: "DELETE",
		});
	});

	test("does not classify iCloud's APFS path as a network filesystem", () => {
		expect(
			resolveSqliteJournalConfig({
				platform: "darwin",
				directory: "/Users/me/Library/Mobile Documents",
				filesystemType: "apfs",
			}),
		).toEqual({
			filesystemType: "apfs",
			networkFilesystem: false,
			journalMode: "WAL",
		});
	});
});
