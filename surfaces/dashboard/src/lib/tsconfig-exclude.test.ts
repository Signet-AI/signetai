import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("dashboard production typecheck boundary", () => {
	test("excludes test files from the build program", () => {
		const tsconfig = JSON.parse(readFileSync(join(import.meta.dir, "../../tsconfig.json"), "utf-8")) as {
			exclude?: readonly string[];
		};
		expect(tsconfig.exclude).toEqual(expect.arrayContaining(["src/**/*.test.ts", "src/**/*.test.tsx"]));
	});
});
