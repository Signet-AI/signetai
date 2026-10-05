import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "..");
const TEST_FILE_PATTERN = "**/*.test.{ts,tsx,mts,mjs,js}";
const SKIPPED_PARTS = new Set(["node_modules", "dist", ".git", ".turbo", "target"]);
const MODULE_MOCK_EXEMPTIONS = new Map<string, string>([["electron", "the real module cannot load under bun test"]]);
const CHILD_PROCESS_MOCK_FILES = new Set(["platform/core/src/database-npm-root.test.ts"]);

function testFiles(): string[] {
	const files: string[] = [];
	for (const path of new Bun.Glob(TEST_FILE_PATTERN).scanSync({ cwd: ROOT, dot: false })) {
		if (path.split("/").some((part) => SKIPPED_PARTS.has(part))) continue;
		files.push(path);
	}
	return files.sort();
}

const files = testFiles().map((path) => ({ path, source: readFileSync(join(ROOT, path), "utf8") }));

test("the contract scans the workspace test suites", () => {
	expect(files.length).toBeGreaterThan(500);
	expect(files.some((file) => file.path === relative(ROOT, import.meta.path))).toBe(true);
});

test("tests delete environment variables instead of assigning undefined", () => {
	const offenders = files.flatMap(({ path, source }) =>
		source
			.split("\n")
			.map((line, index) => ({ line, index }))
			.filter(({ line }) => /process\.env(?:\.[A-Za-z_]\w*|\[[^\]]+\])\s*=\s*undefined\b/.test(line))
			.map(({ index }) => `${path}:${index + 1}`),
	);
	expect(offenders).toEqual([]);
});

test("module mocks are restored before the next test file runs", () => {
	const offenders: string[] = [];
	for (const { path, source } of files) {
		if (CHILD_PROCESS_MOCK_FILES.has(path)) continue;
		const counts = new Map<string, number>();
		for (const match of source.matchAll(/mock\.module\(\s*(["'`])([^"'`]+)\1/g)) {
			const specifier = match[2] ?? "";
			counts.set(specifier, (counts.get(specifier) ?? 0) + 1);
		}
		for (const [specifier, count] of counts) {
			if (MODULE_MOCK_EXEMPTIONS.has(specifier)) continue;
			if (count < 2) offenders.push(`${path}: ${specifier}`);
		}
	}
	expect(offenders).toEqual([]);
});

test("tests start HTTP servers without replacing the global Request and Response", () => {
	const offenders = files
		.filter(({ source }) =>
			/import\s*\{[^}]*\b(?:serve|createAdaptorServer)\b[^}]*\}\s*from\s*["']@hono\/node-server["']/.test(source),
		)
		.map(({ path }) => path);
	expect(offenders).toEqual([]);
});
