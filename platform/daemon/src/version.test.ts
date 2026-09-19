import { describe, expect, it } from "bun:test";
import { compareVersions, isVersionNewer } from "./version";

describe("compareVersions", () => {
	it("compares multi-digit semver parts numerically", () => {
		expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
		expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
		expect(compareVersions("0.1.9", "0.1.10")).toBe(-1);
	});

	it("handles v-prefixed tags", () => {
		expect(compareVersions("v1.2.3", "1.2.2")).toBe(1);
		expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
	});

	it("treats stable releases as newer than prereleases", () => {
		expect(compareVersions("1.2.3", "1.2.3-beta.1")).toBe(1);
		expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(-1);
	});
});

describe("isVersionNewer", () => {
	it("returns true only when latest is newer", () => {
		expect(isVersionNewer("0.1.54", "0.1.53")).toBe(true);
		expect(isVersionNewer("0.1.53", "0.1.53")).toBe(false);
		expect(isVersionNewer("0.1.52", "0.1.53")).toBe(false);
	});
});
