/**
 * Invariant: the dashboard production typecheck (`tsc --noEmit`, the first
 * step of `bun run build`) must never compile test files. Test files import
 * `bun:test` and `happy-dom`, which only resolve when ambient bun types
 * happen to be reachable (a machine-global `@types/bun` leaks in on dev
 * boxes), so including them broke the Docker smoke build in a clean
 * environment with `TS2307: Cannot find module 'bun:test'` — every PR went
 * red on main. The daemon and desktop tsconfigs already exclude test files
 * from the production typecheck; this pins the same contract for the
 * dashboard.
 */
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
