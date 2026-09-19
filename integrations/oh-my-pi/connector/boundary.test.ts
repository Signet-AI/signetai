import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("oh-my-pi production sources do not depend on core or daemon packages", () => {
	const files = ["src/index.ts", "package.json"];
	for (const file of files)
		expect(readFileSync(new URL(file, import.meta.url), "utf8")).not.toMatch(/@signet\/(core|daemon)/);
});
