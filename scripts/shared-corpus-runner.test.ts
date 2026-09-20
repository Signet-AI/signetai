import { describe, expect, test } from "bun:test";
import {
	discoverPaths,
	parseJUnitReport,
	runnableSelectedPaths,
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
});
