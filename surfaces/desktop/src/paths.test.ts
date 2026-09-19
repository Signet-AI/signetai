import { describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({ app: { isPackaged: false } }));
const { daemonEntry, daemonRoot } = await import("./paths.js");

describe("desktop native daemon paths", () => {
	test("stages the platform-specific Rust daemon", () => {
		expect(daemonEntry()).toContain("signet-daemon");
		expect(daemonEntry()).toContain(`${process.platform}-${process.arch}`);
		expect(daemonEntry()).toStartWith(daemonRoot());
	});
});
