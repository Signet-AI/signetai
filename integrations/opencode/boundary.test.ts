import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("OpenCode boundary has no core or daemon package imports", () => {
	for (const file of ["plugin/src/index.ts", "plugin/src/tools.ts", "connector/src/index.ts"]) {
		const source = readFileSync(join(import.meta.dir, file), "utf8");
		expect(source.includes("@signet/core")).toBe(false);
		expect(source.includes("@signet/daemon")).toBe(false);
	}
});
