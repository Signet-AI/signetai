import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveJUnitCaseIdentities, resolveRuntimeCaseEvidence } from "./shared-corpus-identities";

let root: string | null = null;

afterEach(() => {
	if (root) rmSync(root, { force: true, recursive: true });
	root = null;
});

describe("shared-corpus runtime case attribution", () => {
	test("attributes native stacks to the uniquely enclosing JUnit case", () => {
		root = mkdtempSync(join(tmpdir(), "signet-corpus-runtime-range-"));
		writeFileSync(
			join(root, "sample.test.ts"),
			[
				'import { describe, test } from "bun:test";',
				'describe("suite", () => {',
				'	test("first", () => {',
				"		void marker(1);",
				"	});",
				'	test("second", async () => {',
				"		await marker(2);",
				"	});",
				"});",
			].join("\n"),
		);
		const cases = [
			'<testcase name="first" classname="suite" file="sample.test.ts" line="3" />',
			'<testcase name="second" classname="suite" file="sample.test.ts" line="6" />',
		];
		const stacks = [
			`Error\n    at rustCall (/adapter.ts:1:1)\n    at <anonymous> (${resolve(root, "sample.test.ts")}:4:12)`,
			`Error\n    at rustCall (/adapter.ts:1:1)\n    at <anonymous> (${resolve(root, "sample.test.ts")}:7:13)`,
		];

		const identities = resolveJUnitCaseIdentities(cases, root);
		const result = resolveRuntimeCaseEvidence(cases, root, stacks);

		expect(identities.caseIdentities).toHaveLength(2);
		expect(identities.caseIdentities[0]).toMatchObject({ runtimeStartLine: 3, runtimeEndLine: 5 });
		expect(identities.caseIdentities[1]).toMatchObject({ runtimeStartLine: 6, runtimeEndLine: 8 });
		expect(result.caseKeys).toEqual(identities.caseIdentities.map((identity) => identity.key).sort());
		expect(result.unmatchedEvidenceCount).toBe(0);
		expect(result.ambiguousEvidenceCount).toBe(0);
	});

	test("finds the test callback when Bun's timeout is a trailing argument", () => {
		root = mkdtempSync(join(tmpdir(), "signet-corpus-runtime-timeout-"));
		writeFileSync(
			join(root, "sample.test.ts"),
			['import { test } from "bun:test";', 'test("timed", async () => {', "	await marker();", "}, 30_000);"].join(
				"\n",
			),
		);
		const cases = ['<testcase name="timed" classname="" file="sample.test.ts" line="2" />'];
		const stack = `Error\n    at rustCall (/adapter.ts:1:1)\n    at <anonymous> (${resolve(root, "sample.test.ts")}:3:10)`;

		const identities = resolveJUnitCaseIdentities(cases, root);
		const result = resolveRuntimeCaseEvidence(cases, root, [stack]);

		expect(identities.caseIdentities[0]).toMatchObject({ runtimeStartLine: 2, runtimeEndLine: 4 });
		expect(result.caseKeys).toEqual(identities.caseIdentities.map((identity) => identity.key));
	});

	test("fails closed when parameterized rows share one execution range", () => {
		root = mkdtempSync(join(tmpdir(), "signet-corpus-runtime-ambiguous-"));
		writeFileSync(
			join(root, "sample.test.ts"),
			[
				'import { describe, test } from "bun:test";',
				'describe("suite", () => {',
				'	test.each([1, 2])("row %i", () => {',
				"		void marker();",
				"	});",
				"});",
			].join("\n"),
		);
		const cases = [
			'<testcase name="row 1" classname="suite" file="sample.test.ts" line="3" />',
			'<testcase name="row 2" classname="suite" file="sample.test.ts" line="3" />',
		];
		const stack = `Error\n    at rustCall (/adapter.ts:1:1)\n    at <anonymous> (${resolve(root, "sample.test.ts")}:4:12)`;

		expect(resolveRuntimeCaseEvidence(cases, root, [stack])).toEqual({
			caseKeys: [],
			unmatchedEvidenceCount: 0,
			ambiguousEvidenceCount: 1,
		});
	});

	test("does not attribute evidence outside the source root", () => {
		root = mkdtempSync(join(tmpdir(), "signet-corpus-runtime-unmatched-"));
		writeFileSync(join(root, "sample.test.ts"), 'import { test } from "bun:test";\ntest("case", () => marker());\n');
		const cases = ['<testcase name="case" classname="" file="sample.test.ts" line="2" />'];
		const stack = "Error\n    at rustCall (/mnt/work/other.test.ts:2:3)";

		expect(resolveRuntimeCaseEvidence(cases, root, [stack])).toEqual({
			caseKeys: [],
			unmatchedEvidenceCount: 1,
			ambiguousEvidenceCount: 0,
		});
	});
});
