import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("package drift compares the repository map, not absent policy or README tables", () => {
	const root = resolve(import.meta.dir, "..");
	const report = spawnSync(process.execPath, [resolve(import.meta.dir, "doc-drift.ts"), "--json"], {
		cwd: root,
		encoding: "utf8",
	});
	const parsed = JSON.parse(report.stdout) as {
		packages: Array<{ file: string; missingFromTable: unknown[]; extraInTable: unknown[] }>;
	};
	expect(parsed.packages.map((entry) => entry.file)).toEqual(["repo.map.yaml"]);
	expect(parsed.packages[0]?.missingFromTable).toEqual([]);
	expect(parsed.packages[0]?.extraInTable).toEqual([]);
	expect(report.status).toBe(0);
});
