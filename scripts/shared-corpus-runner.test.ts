import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	discoverPaths,
	parseJUnitReport,
	runnableSelectedPaths,
	buildTypeScriptCommand,
	prepareTypeScriptLane,
	clearReport,
	resolveReportPath,
	validateBaselineWorktree,
	validateManifest,
	validateLaneOptions,
	requiresNativeEvidence,
	type ManifestEntry,
} from "./shared-corpus-runner";
import { resolveJUnitCaseIdentities } from "./shared-corpus-identities";

function withTestSource(source: string, run: (sourceRoot: string) => void, fileName = "a.test.ts"): void {
	const sourceRoot = mkdtempSync(join(tmpdir(), "shared-corpus-source-"));
	try {
		writeFileSync(join(sourceRoot, fileName), source);
		run(sourceRoot);
	} finally {
		rmSync(sourceRoot, { recursive: true, force: true });
	}
}

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

	test("runs canonical pinned TypeScript setup before the launcher", () => {
		const calls: string[] = [];
		const result = prepareTypeScriptLane(
			"/baseline",
			(command, args, cwd, env) => {
				calls.push(`${command} ${args.join(" ")} @ ${cwd} isolated=${env.SIGNET_TEST_ROOT}`);
				return 0;
			},
			{ ...process.env, SIGNET_TEST_ROOT: "/isolated" },
		);
		expect(result).toEqual({ status: "ready" });
		expect(calls).toEqual([
			"bun install --frozen-lockfile @ /baseline isolated=/isolated",
			"bun run build @ /baseline isolated=/isolated",
		]);
	});

	test("stops pinned setup when installation fails", () => {
		const calls: string[] = [];
		const result = prepareTypeScriptLane(
			"/baseline",
			(command, args) => {
				calls.push(`${command} ${args.join(" ")}`);
				return 1;
			},
			process.env,
		);
		expect(result).toEqual({ status: "failed", step: "install", exitCode: 1 });
		expect(calls).toEqual(["bun install --frozen-lockfile"]);
	});

	test("clears a stale report before setup can fail", () => {
		const report = `/mnt/work/hermes-scratch/shared-runner-stale-report-${process.pid}.xml`;
		writeFileSync(report, "stale report");
		try {
			clearReport(report);
			expect(existsSync(report)).toBe(false);
		} finally {
			rmSync(report, { force: true });
		}
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

	test("fails closed when repeated testcase identities lack source parameter metadata", () => {
		const xml =
			'<testsuite tests="2"><testcase classname="x" name="a" file="a.test.ts" line="10"/><testcase classname="x" name="a" file="a.test.ts" line="10"/></testsuite>';
		const result = parseJUnitReport(xml, ["a.test.ts"]);

		expect(result.tests).toBe(2);
		expect(result.incomplete).toBe(true);
		expect(result.crash).toBe(false);
		expect(result.identityCollisions).toHaveLength(1);
		expect(result.identityCollisions[0]?.count).toBe(2);
	});

	test("uses suite, source, and actual test.each parameters without changing original names", () => {
		const sourceRoot = mkdtempSync(join(tmpdir(), "signet-shared-corpus-identities-"));
		const file = "src/identity.test.ts";
		const sourcePath = join(sourceRoot, file);
		mkdirSync(join(sourceRoot, "src"), { recursive: true });
		writeFileSync(
			sourcePath,
			[
				'import { describe, test } from "bun:test";',
				'describe("policy suite", () => {',
				"	test.each([",
				'		["system", "system"],',
				'		["service", "service"],',
				'	])("allows %s", () => {});',
				"});",
			].join(String.fromCharCode(10)),
		);
		const xml =
			'<testsuite tests="2">' +
			'<testcase file="src/identity.test.ts" line="6" classname="policy suite" name="allows system"/>' +
			'<testcase file="src/identity.test.ts" line="6" classname="policy suite" name="allows service"/>' +
			"</testsuite>";

		try {
			const result = parseJUnitReport(xml, [file], 0, sourceRoot);
			expect(result.tests).toBe(2);
			expect(result.identityCollisions).toEqual([]);
			expect(result.incomplete).toBe(false);
			expect(result.caseIdentities.map((identity) => identity.name)).toEqual(["allows system", "allows service"]);
			expect(result.caseIdentities.map((identity) => identity.suitePath)).toEqual([["policy suite"], ["policy suite"]]);
			expect(result.caseIdentities.map((identity) => identity.parameters)).toEqual([
				["system", "system"],
				["service", "service"],
			]);
			expect(new Set(result.caseIdentities.map((identity) => identity.key)).size).toBe(2);
		} finally {
			rmSync(sourceRoot, { recursive: true, force: true });
		}
	});

	test("does not infer duplicate test.each rows from concurrent JUnit completion order", () => {
		withTestSource(
			'test.concurrent.each([["same", "slow"], ["same", "fast"]])("case %s", async () => {});',
			(sourceRoot) => {
				const xml =
					'<testsuite tests="2" failures="1">' +
					'<testcase file="a.test.ts" line="1" classname="" name="case same"/>' +
					'<testcase file="a.test.ts" line="1" classname="" name="case same"><failure/></testcase>' +
					"</testsuite>";
				const result = parseJUnitReport(xml, ["a.test.ts"], 0, sourceRoot);

				expect(result.failed).toBe(1);
				expect(result.passed).toBe(1);
				expect(result.unresolvedIdentityCount).toBe(2);
				expect(result.caseIdentities.every((identity) => identity.parameters === undefined)).toBe(true);
				expect(result.incomplete).toBe(true);
			},
		);
	});

	test("maps duplicate non-concurrent test.each titles in Bun's registration order", () => {
		withTestSource('test.each([["same", "slow"], ["same", "fast"]])("case %s", async () => {});', (sourceRoot) => {
			const xml =
				'<testsuite tests="2" failures="1">' +
				'<testcase file="a.test.ts" line="1" classname="" name="case same"><failure/></testcase>' +
				'<testcase file="a.test.ts" line="1" classname="" name="case same"/>' +
				"</testsuite>";
			const result = parseJUnitReport(xml, ["a.test.ts"], 0, sourceRoot);

			expect(result.unresolvedIdentityCount).toBe(0);
			expect(result.caseIdentities.map((identity) => identity.parameters)).toEqual([
				["same", "slow"],
				["same", "fast"],
			]);
			expect(result.incomplete).toBe(false);
		});
	});

	test("matches Bun's rendered integer and object test.each names", () => {
		withTestSource(
			'test.each([[2.8]])("integer %i", () => {});\ntest.each([[{ a: 1 }]])("single object %s", () => {});',
			(sourceRoot) => {
				const xml =
					'<testsuite tests="2">' +
					'<testcase file="a.test.ts" line="1" classname="" name="integer %i"/>' +
					'<testcase file="a.test.ts" line="2" classname="" name="single object %s"/>' +
					"</testsuite>";
				const result = parseJUnitReport(xml, ["a.test.ts"], 0, sourceRoot);

				expect(result.unresolvedIdentityCount).toBe(0);
				expect(result.caseIdentities.map((identity) => identity.parameters)).toEqual([[2.8], [{ a: 1 }]]);
				expect(result.incomplete).toBe(false);
			},
		);
	});

	test("does not attribute one afterAll marker to an earlier beforeAll", () => {
		withTestSource('describe("suite", () => { beforeAll(() => {}); afterAll(() => {}); });', (sourceRoot) => {
			const marker = '<testcase file="a.test.ts" classname="suite" name="(unnamed)"><failure/></testcase>';
			const result = resolveJUnitCaseIdentities([marker], sourceRoot);

			expect(result.suiteHookIdentities).toEqual([]);
			expect(result.unresolvedIdentityCount).toBe(1);
		});
	});

	test("rejects ambiguous forward and reversed nested suite classnames", () => {
		withTestSource(
			'describe("a > b", () => { test("works", () => {}); }); describe("b", () => { describe("a", () => { test("works", () => {}); }); });',
			(sourceRoot) => {
				const xml =
					'<testsuite tests="2">' +
					'<testcase file="a.test.ts" line="1" classname="a &gt; b" name="works"/>' +
					'<testcase file="a.test.ts" line="1" classname="a &gt; b" name="works"/>' +
					"</testsuite>";
				const result = parseJUnitReport(xml, ["a.test.ts"], 0, sourceRoot);

				expect(result.unresolvedIdentityCount).toBe(2);
				expect(result.incomplete).toBe(true);
			},
		);
	});

	test("indexes a local conditional describe alias", () => {
		withTestSource(
			'import { describe, test } from "bun:test";\nconst native = true;\nconst describeNative = native ? describe : describe.skip;\ndescribeNative("native suite", () => {\n  test("works", () => {});\n});',
			(sourceRoot) => {
				const result = parseJUnitReport(
					'<testsuite tests="1"><testcase file="a.test.ts" line="5" classname="native suite" name="works"/></testsuite>',
					["a.test.ts"],
					0,
					sourceRoot,
				);
				expect(result.unresolvedIdentityCount).toBe(0);
				expect(result.caseIdentities[0]?.suitePath).toEqual(["native suite"]);
				expect(result.incomplete).toBe(false);
			},
		);
	});

	test("indexes a local conditional test alias", () => {
		withTestSource(
			'import { describe, test } from "bun:test";\ndescribe("smoke suite", () => {\n  const enabled = true;\n  const smoke = enabled ? test : test.skip;\n  smoke("works", () => {});\n});',
			(sourceRoot) => {
				const result = parseJUnitReport(
					'<testsuite tests="1"><testcase file="a.test.ts" line="5" classname="smoke suite" name="works"/></testsuite>',
					["a.test.ts"],
					0,
					sourceRoot,
				);
				expect(result.unresolvedIdentityCount).toBe(0);
				expect(result.incomplete).toBe(false);
			},
		);
	});

	test("indexes a runtime-named conditional suite from its JUnit classname", () => {
		withTestSource(
			[
				'import { describe, test } from "bun:test";',
				'const dynamicName = "runtime";',
				"describe.skipIf(true)(`create $" + "{dynamicName}`, () => {",
				'test("works", () => {});',
				"});",
			].join("\n"),
			(sourceRoot) => {
				const result = parseJUnitReport(
					'<testsuite tests="1" skipped="1"><testcase file="a.test.ts" line="4" classname="create runtime" name="works"><skipped/></testcase></testsuite>',
					["a.test.ts"],
					0,
					sourceRoot,
				);
				expect(result.tests).toBe(1);
				expect(result.skipped).toBe(1);
				expect(result.unresolvedIdentityCount).toBe(0);
				expect(result.caseIdentities[0]?.suitePath).toEqual(["create runtime"]);
				expect(result.incomplete).toBe(false);
			},
		);
	});

	test("indexes test declarations in TSX source files", () => {
		withTestSource(
			'import { describe, test } from "bun:test";\ndescribe("tsx suite", () => {\n  test("renders", () => { const element = <div />; void element; });\n});',
			(sourceRoot) => {
				const result = parseJUnitReport(
					'<testsuite tests="1"><testcase file="a.test.tsx" line="3" classname="tsx suite" name="renders"/></testsuite>',
					["a.test.tsx"],
					0,
					sourceRoot,
				);
				expect(result.unresolvedIdentityCount).toBe(0);
				expect(result.caseIdentities[0]?.suitePath).toEqual(["tsx suite"]);
				expect(result.incomplete).toBe(false);
			},
			"a.test.tsx",
		);
	});

	test("maps dynamic test names to their unique source suite", () => {
		const sourceRoot = mkdtempSync(join(tmpdir(), "signet-shared-corpus-dynamic-suite-"));
		const file = "src/dynamic.test.ts";
		mkdirSync(join(sourceRoot, "src"), { recursive: true });
		writeFileSync(
			join(sourceRoot, file),
			[
				'import { describe, test } from "bun:test";',
				'describe("dynamic suite", () => {',
				'	for (const name of ["first", "second"]) {',
				"		test(name, () => {});",
				"	}",
				"});",
			].join(String.fromCharCode(10)),
		);
		const xml =
			'<testsuite tests="2">' +
			'<testcase file="src/dynamic.test.ts" line="4" classname="dynamic suite" name="first"/>' +
			'<testcase file="src/dynamic.test.ts" line="4" classname="dynamic suite" name="second"/>' +
			"</testsuite>";

		try {
			const result = parseJUnitReport(xml, [file], 0, sourceRoot);
			expect(result.caseIdentities.map((identity) => identity.suitePath)).toEqual([
				["dynamic suite"],
				["dynamic suite"],
			]);
			expect(new Set(result.caseIdentities.map((identity) => identity.key)).size).toBe(2);
			expect(result.incomplete).toBe(false);
		} finally {
			rmSync(sourceRoot, { recursive: true, force: true });
		}
	});

	test("includes the full nested source suite path in a static testcase identity", () => {
		const sourceRoot = mkdtempSync(join(tmpdir(), "signet-shared-corpus-nested-suite-"));
		const file = "src/nested.test.ts";
		mkdirSync(join(sourceRoot, "src"), { recursive: true });
		writeFileSync(
			join(sourceRoot, file),
			[
				'import { describe, test } from "bun:test";',
				'describe("outer suite", () => {',
				'	describe("inner suite", () => {',
				'		test("works", () => {});',
				"	});",
				"});",
			].join(String.fromCharCode(10)),
		);
		const xml =
			'<testsuite tests="1"><testcase file="src/nested.test.ts" line="4" classname="inner suite &gt; outer suite" name="works"/></testsuite>';

		try {
			const result = parseJUnitReport(xml, [file], 0, sourceRoot);
			expect(result.incomplete).toBe(false);
			expect(result.identityCollisions).toEqual([]);
			expect(result.caseIdentities[0]?.suitePath).toEqual(["outer suite", "inner suite"]);
			expect(result.caseIdentities[0]?.key).toContain(["outer suite", "inner suite"].join(String.fromCharCode(0)));
		} finally {
			rmSync(sourceRoot, { recursive: true, force: true });
		}
	});

	test("does not map a leaf-only classname shared by nested suites", () => {
		const sourceRoot = mkdtempSync(join(tmpdir(), "signet-shared-corpus-ambiguous-suite-"));
		const file = "src/nested.test.ts";
		mkdirSync(join(sourceRoot, "src"), { recursive: true });
		writeFileSync(
			join(sourceRoot, file),
			[
				'import { describe, test } from "bun:test";',
				'describe("outer", () => { describe("leaf", () => { test("works", () => {}); }); });',
			].join("\n"),
		);
		try {
			const result = parseJUnitReport(
				'<testsuite tests="1"><testcase file="src/nested.test.ts" line="1" classname="leaf" name="works"/></testsuite>',
				[file],
				0,
				sourceRoot,
			);
			expect(result.incomplete).toBe(true);
			expect(result.caseIdentities[0]?.suitePath).toEqual([]);
		} finally {
			rmSync(sourceRoot, { recursive: true, force: true });
		}
	});

	test("classifies skipped suite hooks separately from testcases", () => {
		const sourceRoot = mkdtempSync(join(tmpdir(), "signet-shared-corpus-hooks-"));
		const file = "src/hooks.test.ts";
		mkdirSync(join(sourceRoot, "src"), { recursive: true });
		writeFileSync(
			join(sourceRoot, file),
			[
				'import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from "bun:test";',
				'describe.skip("retired suite", () => {',
				"	beforeAll(() => {});",
				"	afterAll(() => {});",
				"	beforeEach(() => {});",
				"	afterEach(() => {});",
				'	test("real skipped case", () => {});',
				"});",
			].join(String.fromCharCode(10)),
		);
		const xml =
			'<testsuite tests="3" skipped="3">' +
			'<testcase file="src/hooks.test.ts" classname="retired suite" name="(unnamed)" assertions="0"><skipped/></testcase>' +
			'<testcase file="src/hooks.test.ts" classname="retired suite" name="real skipped case" line="7" assertions="0"><skipped/></testcase>' +
			'<testcase file="src/hooks.test.ts" classname="retired suite" name="(unnamed)" assertions="0"><skipped/></testcase>' +
			"</testsuite>";

		try {
			const result = parseJUnitReport(xml, [file], 0, sourceRoot);
			expect(result.reportedRecords).toBe(3);
			expect(result.tests).toBe(1);
			expect(result.skipped).toBe(1);
			expect(result.suiteHookMarkers).toBe(2);
			expect(result.suiteHookIdentities.map((identity) => identity.hook)).toEqual(["beforeAll", "afterAll"]);
			expect(result.caseIdentities).toHaveLength(1);
			expect(result.identityCollisions).toEqual([]);
			expect(result.incomplete).toBe(false);
		} finally {
			rmSync(sourceRoot, { recursive: true, force: true });
		}
	});

	test("maps nested suite hook markers from Bun's reversed classname path", () => {
		const sourceRoot = mkdtempSync(join(tmpdir(), "signet-shared-corpus-nested-hooks-"));
		const file = "src/nested-hooks.test.ts";
		mkdirSync(join(sourceRoot, "src"), { recursive: true });
		writeFileSync(
			join(sourceRoot, file),
			[
				'import { beforeAll, describe, test } from "bun:test";',
				'describe("outer suite", () => {',
				'	describe("inner suite", () => {',
				"		beforeAll(() => {});",
				'		test("works", () => {});',
				"	});",
				"});",
			].join(String.fromCharCode(10)),
		);
		const xml =
			'<testsuite tests="2" failures="1">' +
			'<testcase file="src/nested-hooks.test.ts" classname="inner suite &gt; outer suite" name="(unnamed)"><failure/></testcase>' +
			'<testcase file="src/nested-hooks.test.ts" classname="inner suite &gt; outer suite" name="works" line="5"/>' +
			"</testsuite>";

		try {
			const result = parseJUnitReport(xml, [file], 0, sourceRoot);
			expect(result.suiteHookMarkers).toBe(1);
			expect(result.suiteHookIdentities[0]?.hook).toBe("beforeAll");
			expect(result.suiteHookIdentities[0]?.suitePath).toEqual(["outer suite", "inner suite"]);
			expect(result.caseIdentities[0]?.suitePath).toEqual(["outer suite", "inner suite"]);
			expect(result.incomplete).toBe(false);
		} finally {
			rmSync(sourceRoot, { recursive: true, force: true });
		}
	});

	test("reports selected entrypoints without JUnit cases as unreported, never skipped", () => {
		const result = parseJUnitReport(
			'<testsuite tests="1"><testcase file="other.test.ts" line="1" classname="suite" name="runs"/></testsuite>',
			["platform/daemon/src/pipeline/pi-provider.live.test.ts"],
		);

		expect(result.tests).toBe(1);
		expect(result.skipped).toBe(0);
		expect(result.unreportedFiles).toEqual(["platform/daemon/src/pipeline/pi-provider.live.test.ts"]);
		expect(result.incomplete).toBe(true);
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

	test("fails closed for testcases with no source line", () => {
		const result = parseJUnitReport(
			'<testsuite tests="1"><testcase file="a.test.ts" classname="x" name="a"/></testsuite>',
			["a.test.ts"],
		);
		expect(result.unresolvedIdentityCount).toBe(1);
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
		withTestSource(
			'describe("x", () => {\n  test("passes", () => {});\n  test("fails", () => {});\n});',
			(sourceRoot) => {
				const result = parseJUnitReport(
					'<testsuite tests="2" failures="1"><testcase file="a.test.ts" line="2" classname="x" name="passes"/><testcase file="a.test.ts" line="3" classname="x" name="fails"><failure/></testcase></testsuite>',
					["a.test.ts"],
					1,
					sourceRoot,
				);
				expect(result.tests).toBe(2);
				expect(result.passed).toBe(1);
				expect(result.failed).toBe(1);
				expect(result.crash).toBe(false);
				expect(result.incomplete).toBe(false);
				expect(result.status).toBe("failed");
			},
		);
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
		expect(result.nativeEvidenceScope).toBe("batch");
	});

	test("preserves nested JUnit suite errors", () => {
		withTestSource('describe("x", () => {\n  test("a", () => {});\n});', (sourceRoot) => {
			const result = parseJUnitReport(
				'<testsuites><testsuite tests="1" errors="1"><testcase file="a.test.ts" line="2" classname="x" name="a"/></testsuite></testsuites>',
				["a.test.ts"],
				0,
				sourceRoot,
			);
			expect(result.tests).toBe(1);
			expect(result.failed).toBe(0);
			expect(result.suiteFailures).toBe(1);
			expect(result.incomplete).toBe(false);
			expect(result.status).toBe("failed");
		});
	});

	test("preserves errors from a nested suite under a testsuite root", () => {
		withTestSource('describe("x", () => {\n  test("a", () => {});\n});', (sourceRoot) => {
			const result = parseJUnitReport(
				'<testsuite tests="1" failures="0"><testsuite tests="1" errors="1"><testcase file="a.test.ts" line="2" classname="x" name="a"/></testsuite></testsuite>',
				["a.test.ts"],
				0,
				sourceRoot,
			);
			expect(result.tests).toBe(1);
			expect(result.failed).toBe(0);
			expect(result.suiteFailures).toBe(1);
			expect(result.incomplete).toBe(false);
			expect(result.status).toBe("failed");
		});
	});

	test("accepts equivalent native evidence attribute serialization", () => {
		const result = parseJUnitReport(
			'<testsuite name="rust" errors="0" nativeEvidence = \'true\' tests="1"><testcase file="a.test.ts" line="1" classname="x" name="a"/></testsuite>',
			["a.test.ts"],
			0,
		);
		expect(result.nativeEvidence).toBe(true);
	});

	test("requires per-case native evidence for every Rust lane, including selected runs", () => {
		expect(requiresNativeEvidence("rust", "none")).toBe(true);
		expect(requiresNativeEvidence("rust", "batch")).toBe(true);
		expect(requiresNativeEvidence("rust", "per-case")).toBe(false);
		expect(requiresNativeEvidence("typescript", "none")).toBe(false);
	});

	test("root suite failures remain visible even when leaf counters exist", () => {
		const result = parseJUnitReport(
			'<testsuites tests="1" failures="1"><testsuite tests="1" failures="0"><testcase file="a.test.ts" line="1" classname="x" name="ok"/></testsuite></testsuites>',
			["a.test.ts"],
		);
		expect(result.suiteFailures).toBe(1);
		expect(result.status).toBe("failed");
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
