import { describe, expect, test } from "bun:test";
import {
	findAddedProductionComments,
	isProductionSourcePath,
	scanTypeScriptComments,
	type SourceReader,
} from "./check-production-comments";

const sourceReader =
	(files: Readonly<Record<string, string>>): SourceReader =>
	(path) =>
		files[path];

describe("production source scope", () => {
	test("includes shipped TypeScript-family source and excludes non-production paths", () => {
		expect(isProductionSourcePath("platform/daemon/src/routes.ts")).toBe(true);
		expect(isProductionSourcePath("surfaces/dashboard/src/view.tsx")).toBe(true);
		expect(isProductionSourcePath("scripts/release.mts")).toBe(true);
		expect(isProductionSourcePath("platform/daemon/src/routes.test.ts")).toBe(false);
		expect(isProductionSourcePath("tests/integration/run.ts")).toBe(false);
		expect(isProductionSourcePath("platform/daemon/fixtures/input.ts")).toBe(false);
		expect(isProductionSourcePath("dist/signetai/index.js")).toBe(false);
		expect(isProductionSourcePath("docs/example.ts")).toBe(false);
		expect(isProductionSourcePath("platform/native/src/lib.rs")).toBe(false);
	});
});

describe("TypeScript comment scanning", () => {
	test("finds line, block, and trailing comments without matching strings or regular expressions", () => {
		const source = [
			'const url = "https://example.com/* text */";',
			"const marker = '// text';",
			"const pattern = /https?:\\/\\/example\\.com/;",
			"const value = 1; // trailing",
			"/* block",
			" * body",
			" */",
		].join("\n");
		const comments = scanTypeScriptComments("sample.ts", source);
		expect(comments.map(({ startLine, endLine }) => [startLine, endLine])).toEqual([
			[4, 4],
			[5, 7],
		]);
	});

	test("does not classify template content or contextual regular expressions as comments", () => {
		const interpolation = "${" + "repo}";
		const source = [
			`const error = \`Invalid ${interpolation} owner/*\`;`,
			"const hook = /^\\.githooks\\//.test(path);",
		].join("\n");
		expect(scanTypeScriptComments("sample.ts", source)).toEqual([]);
	});

	test("allows narrow legal headers and rejects API documentation comments", () => {
		const source = [
			"// SPDX-License-Identifier: Apache-2.0",
			"// Copyright (c) 2026 Signet AI",
			"// DYNAMIC_SITE_TOKEN",
			"// DYNAMIC_SITE_TOKEN explanation",
			"// Copyright workaround",
			"/* SPDX-License-Identifier: MIT\n * workaround\n */",
			"/** @param value input */",
			"export function tagged(value: string): string { return value; }",
			"/** Important implementation explanation. */",
			"export function explanatory(): void {}",
		].join("\n");
		const comments = scanTypeScriptComments("sample.ts", source);
		expect(comments.map(({ allowed }) => allowed)).toEqual([true, true, true, false, false, false, false, false]);
	});
});

describe("diff ratchet", () => {
	test("reports only comments intersecting added production lines", () => {
		const diff = [
			"diff --git a/platform/core/src/example.ts b/platform/core/src/example.ts",
			"--- a/platform/core/src/example.ts",
			"+++ b/platform/core/src/example.ts",
			"@@ -1,2 +1,3 @@",
			" const oldValue = 1; // existing",
			"+const nextValue = 2; // added",
			" const end = true;",
		].join("\n");
		const source = ["const oldValue = 1; // existing", "const nextValue = 2; // added", "const end = true;"].join("\n");
		const violations = findAddedProductionComments(
			diff,
			sourceReader({
				"platform/core/src/example.ts": source,
			}),
		);
		expect(violations).toEqual([expect.objectContaining({ path: "platform/core/src/example.ts", startLine: 2 })]);
	});

	test("keeps source lines beginning with two plus operators inside the active hunk", () => {
		const diff = [
			"diff --git a/platform/core/src/example.ts b/platform/core/src/example.ts",
			"--- /dev/null",
			"+++ b/platform/core/src/example.ts",
			"@@ -0,0 +1,2 @@",
			"+++ counter;",
			"+// added comment",
		].join("\n");
		const violations = findAddedProductionComments(
			diff,
			sourceReader({
				"platform/core/src/example.ts": "++ counter;\n// added comment",
			}),
		);
		expect(violations).toEqual([expect.objectContaining({ path: "platform/core/src/example.ts", startLine: 2 })]);
	});

	test("reports a multiline comment when any added line intersects it", () => {
		const diff = [
			"diff --git a/platform/core/src/example.ts b/platform/core/src/example.ts",
			"--- a/platform/core/src/example.ts",
			"+++ b/platform/core/src/example.ts",
			"@@ -1 +1,3 @@",
			" /* existing start",
			"+ * added body",
			"+ */",
		].join("\n");
		const source = ["/* existing start", " * added body", " */"].join("\n");
		const violations = findAddedProductionComments(
			diff,
			sourceReader({
				"platform/core/src/example.ts": source,
			}),
		);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toEqual(expect.objectContaining({ startLine: 1, endLine: 3 }));
	});

	test("ignores excluded paths, deleted files, and approved comments", () => {
		const diff = [
			"diff --git a/platform/core/src/example.test.ts b/platform/core/src/example.test.ts",
			"--- a/platform/core/src/example.test.ts",
			"+++ b/platform/core/src/example.test.ts",
			"@@ -0,0 +1 @@",
			"+// test setup",
			"diff --git a/platform/core/src/legal.ts b/platform/core/src/legal.ts",
			"--- /dev/null",
			"+++ b/platform/core/src/legal.ts",
			"@@ -0,0 +1 @@",
			"+// SPDX-License-Identifier: MIT",
			"diff --git a/platform/core/src/removed.ts b/platform/core/src/removed.ts",
			"--- a/platform/core/src/removed.ts",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"-// removed",
		].join("\n");
		const violations = findAddedProductionComments(
			diff,
			sourceReader({
				"platform/core/src/example.test.ts": "// test setup",
				"platform/core/src/legal.ts": "// SPDX-License-Identifier: MIT",
			}),
		);
		expect(violations).toEqual([]);
	});

	test("sorts diagnostics by path and line", () => {
		const diff = [
			"diff --git a/z.ts b/z.ts",
			"--- /dev/null",
			"+++ b/z.ts",
			"@@ -0,0 +1,2 @@",
			"+// first z",
			"+// second z",
			"diff --git a/a.ts b/a.ts",
			"--- /dev/null",
			"+++ b/a.ts",
			"@@ -0,0 +1 @@",
			"+// a",
		].join("\n");
		const violations = findAddedProductionComments(
			diff,
			sourceReader({
				"z.ts": "// first z\n// second z",
				"a.ts": "// a",
			}),
		);
		expect(violations.map(({ path, startLine }) => `${path}:${startLine}`)).toEqual(["a.ts:1", "z.ts:1", "z.ts:2"]);
	});
});
