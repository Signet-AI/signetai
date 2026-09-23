import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
	discoverPaths,
	parseJUnitReport,
	runnableSelectedPaths,
	buildTypeScriptCommand,
	resolveReportPath,
	validateBaselineWorktree,
	validateManifest,
	validateLaneOptions,
	requiresNativeEvidence,
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

	test("rejects duplicate selected paths", () => {
		const manifest = [{ path: "a.test.ts", sha256: "a" }];
		expect(() => runnableSelectedPaths(["a.test.ts", "a.test.ts"], manifest)).toThrow(/duplicate/i);
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

	test("accounts repeated testcase identities with occurrence disambiguation", () => {
		const xml =
			'<testsuite tests="2"><testcase classname="x" name="a" file="a.test.ts" line="10"/><testcase classname="x" name="a" file="a.test.ts" line="10"/></testsuite>';
		const result = parseJUnitReport(xml, ["a.test.ts"]);
		expect(result.tests).toBe(2);
		expect(result.incomplete).toBe(false);
		expect(result.crash).toBe(false);
		expect(result.identityCollisions).toHaveLength(1);
		expect(result.identityCollisions[0]?.count).toBe(2);
	});

	test("rejects testcase identities without a source file", () => {
		const xml = '<testsuite tests="2"><testcase classname="x" name="a"/><testcase classname="x" name="a"/></testsuite>';
		const result = parseJUnitReport(xml, ["a.test.ts"]);
		expect(result.incomplete).toBe(true);
		expect(result.missingFiles).toEqual(["a.test.ts"]);
	});

	test("rejects testcase identities without a source file in full-run mode", () => {
		const result = parseJUnitReport('<testsuite tests="1"><testcase classname="x" name="a"/></testsuite>');
		expect(result.incomplete).toBe(true);
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

	test("complete JUnit output with assertion failures is not misreported as a crash", () => {
		const result = parseJUnitReport(
			'<testsuite tests="2" failures="1"><testcase file="a.test.ts" line="1" classname="x" name="passes"/><testcase file="a.test.ts" line="2" classname="x" name="fails"><failure/></testcase></testsuite>',
			["a.test.ts"],
			1,
		);
		expect(result.tests).toBe(2);
		expect(result.passed).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.crash).toBe(false);
		expect(result.incomplete).toBe(false);
		expect(result.status).toBe("failed");
	});

	test("rejects complete counts whose testcase files do not match the selected paths", () => {
		const result = parseJUnitReport(
			'<testsuite tests="2"><testcase file="wrong-a.test.ts" line="1" classname="x" name="a"/><testcase file="wrong-b.test.ts" line="2" classname="x" name="b"/></testsuite>',
			["a.test.ts", "b.test.ts"],
			0,
		);
		expect(result.tests).toBe(2);
		expect(result.passed).toBe(2);
		expect(result.incomplete).toBe(true);
		expect(result.missingFiles).toEqual(["a.test.ts", "b.test.ts"]);
		expect(result.unexpectedFiles).toEqual(["wrong-a.test.ts", "wrong-b.test.ts"]);
	});

	test("preserves a native evidence marker without treating it as a testcase", () => {
		const result = parseJUnitReport(
			'<testsuite tests="1" nativeEvidence="true"><testcase file="a.test.ts" line="1" classname="x" name="a"/></testsuite>',
			["a.test.ts"],
			0,
		);
		expect(result.tests).toBe(1);
		expect(result.nativeEvidence).toBe(true);
	});

	test("preserves nested JUnit suite errors", () => {
		const result = parseJUnitReport(
			'<testsuites><testsuite tests="1" errors="1"><testcase file="a.test.ts" line="1" classname="x" name="a"/></testsuite></testsuites>',
			["a.test.ts"],
			0,
		);
		expect(result.tests).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.incomplete).toBe(false);
		expect(result.status).toBe("failed");
	});

	test("preserves errors from a nested suite under a testsuite root", () => {
		const result = parseJUnitReport(
			'<testsuite tests="1" failures="0"><testsuite tests="1" errors="1"><testcase file="a.test.ts" line="1" classname="x" name="a"/></testsuite></testsuite>',
			["a.test.ts"],
			0,
		);
		expect(result.tests).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.incomplete).toBe(false);
		expect(result.status).toBe("failed");
	});

	test("accepts equivalent native evidence attribute serialization", () => {
		const result = parseJUnitReport(
			'<testsuite name="rust" errors="0" nativeEvidence = \'true\' tests="1"><testcase file="a.test.ts" line="1" classname="x" name="a"/></testsuite>',
			["a.test.ts"],
			0,
		);
		expect(result.nativeEvidence).toBe(true);
	});

	test("requires native evidence for every Rust lane, including selected runs", () => {
		expect(requiresNativeEvidence("rust", false)).toBe(true);
		expect(requiresNativeEvidence("rust", true)).toBe(false);
		expect(requiresNativeEvidence("typescript", false)).toBe(false);
	});

	test("adapter rejects a forged pinned manifest before launching tests", () => {
		const protectedCorpus = Array.from({ length: 497 }, (_, index) => ({
			path: `forged-${index}.test.ts`,
			sha256: "0".repeat(64),
		}));
		const result = spawnSync(
			process.execPath,
			[
				resolve(import.meta.dir, "rust-shared-corpus-adapter.ts"),
				"--artifact",
				"/nonexistent/signet-daemon",
				"--core-driver",
				"/nonexistent/signet-core-test-driver",
				"--manifest",
				JSON.stringify({ baselineSha: "11e4720c07107caf7fdd57a685eca24e8a82e654", protectedCorpus }),
				"--paths",
				JSON.stringify(["forged-0.test.ts"]),
				"--report",
				`/mnt/work/hermes-scratch/forged-manifest-${process.pid}.xml`,
			],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(/pinned baseline manifest/i);
	});

	test("daemon evidence is emitted only after replacement spawn succeeds", () => {
		const directory = `/mnt/work/hermes-scratch/daemon-preload-test-${process.pid}`;
		const evidence = `${directory}.evidence`;
		rmSync(directory, { recursive: true, force: true });
		rmSync(evidence, { force: true });
		mkdirSync(directory, { recursive: true });
		try {
			const result = spawnSync(
				process.execPath,
				[
					"--preload",
					resolve(import.meta.dir, "rust-baseline-proof-daemon.preload.ts"),
					"-e",
					'Bun.spawn([process.execPath, "platform/daemon/src/daemon.ts"])',
				],
				{
					cwd: process.cwd(),
					env: {
						...process.env,
						SIGNET_RUST_DAEMON_BIN: directory,
						SIGNET_RUST_DAEMON_EVIDENCE_FILE: evidence,
						SIGNET_RUST_EVIDENCE_NONCE: "test-nonce",
					},
					encoding: "utf8",
				},
			);
			expect(result.status).not.toBe(0);
			expect(existsSync(evidence)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
			rmSync(evidence, { force: true });
		}
	});
});
