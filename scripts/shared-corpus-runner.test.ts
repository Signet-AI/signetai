import { describe, expect, test } from "bun:test";
import {
	discoverPaths,
	parseJUnitReport,
	runnableSelectedPaths,
	buildTypeScriptCommand,
	resolveReportPath,
	validateBaselineWorktree,
	validateManifest,
	validateLaneOptions,
	type ManifestEntry,
} from "./shared-corpus-runner";

describe("shared corpus admission", () => {
	test("rejects a manifest that is not the pinned 497-path baseline", () => {
		const entries: ManifestEntry[] = [{ path: "x.test.ts", sha256: "a" }];
		expect(() => validateManifest(entries)).toThrow(/497/);
	});

	test("rejects current bytes whose hash differs from the baseline", () => {
		const entries: ManifestEntry[] = Array.from({ length: 497 }, (_, i) => ({ path: `x${i}.test.ts`, sha256: "a" }));
		expect(() => validateManifest(entries, new Map([["x0.test.ts", "b"]]))).toThrow(/hash/i);
	});

	test("requires the pinned worktree or real Rust artifact for each lane", () => {
		expect(() => validateLaneOptions("typescript", {})).toThrow(/worktree/i);
		expect(() => validateLaneOptions("rust", {})).toThrow(/artifact/i);
	});

	test("classifies the pinned corpus with all accepted roots and load script", () => {
		const paths = discoverPaths([
			"test/tests/__tests__/one.ts",
			"tests/__tests__/two.ts",
			"foo.test.ts",
			"scripts/load-test-daemon.ts",
			"README.md",
		]);
		expect(paths).toEqual([
			"foo.test.ts",
			"scripts/load-test-daemon.ts",
			"test/tests/__tests__/one.ts",
			"tests/__tests__/two.ts",
		]);
	});

	test("requires the baseline worktree to be pinned", () => {
		expect(() => validateBaselineWorktree("/tmp/not-a-worktree")).toThrow(/pinned/i);
	});

	test("does not count a JUnit suite as passed without testcases", () => {
		const result = parseJUnitReport('<testsuite tests="0" failures="0"/>', ["a.test.ts"]);
		expect(result.tests).toBe(0);
		expect(result.incomplete).toBe(true);
		expect(result.crash).toBe(true);
	});

	test("selected mode admits only runnable baseline test entrypoints", () => {
		const manifest = [
			{ path: "a.test.ts", sha256: "a" },
			{ path: "fixtures/input.json", sha256: "b" },
		];
		expect(runnableSelectedPaths(["fixtures/input.json", "a.test.ts"], manifest)).toEqual(["a.test.ts"]);
	});

	test("TypeScript accepts its CLI's default report contract", () => {
		expect(() => validateLaneOptions("typescript", { worktree: "/tmp/not-a-worktree" })).toThrow(/pinned/i);
		expect(resolveReportPath("typescript", "/repo")).toBeUndefined();
	});

	test("selected mode builds a command containing the selected paths", () => {
		expect(buildTypeScriptCommand(["a.test.ts", "b.spec.ts"])).toEqual([
			"bun",
			"run",
			"test:hermetic",
			"a.test.ts",
			"b.spec.ts",
		]);
	});

	test("missing report is incomplete rather than passed", () => {
		const result = parseJUnitReport("", ["a.test.ts"]);
		expect(result.incomplete).toBe(true);
		expect(result.crash).toBe(true);
	});

	test("rejects duplicate testcase identities and substituted expected identities", () => {
		const xml = '<testsuite tests="2"><testcase classname="x" name="a"/><testcase classname="x" name="a"/></testsuite>';
		const result = parseJUnitReport(xml, ["a.test.ts", "b.test.ts"]);
		expect(result.incomplete).toBe(true);
		expect(result.crash).toBe(true);
		expect(result.failed).toBeGreaterThan(0);
	});

	test("nonzero child status cannot be represented as passed", () => {
		const result = parseJUnitReport(
			'<testsuite tests="1"><testcase classname="x" name="a"/></testsuite>',
			["a.test.ts"],
			1,
		);
		expect(result.crash).toBe(true);
		expect(result.status).toBe("failed");
	});
});
