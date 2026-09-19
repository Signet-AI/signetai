import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("oh-my-pi production sources do not depend on core or daemon packages", () => {
	for (const file of ["src/lifecycle.ts", "src/static-identity.ts", "package.json"]) {
		expect(readFileSync(new URL(file, import.meta.url), "utf8")).not.toMatch(/@signet\/(core|daemon)/);
	}
});
