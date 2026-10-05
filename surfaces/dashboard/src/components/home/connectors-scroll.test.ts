import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

test("the Home connector list hands wheel scrolling back to the System column", () => {
	const css = readFileSync(join(import.meta.dir, "..", "..", "index.css"), "utf8");
	const rules = [...css.matchAll(/([^{}]*\.home-connectors-rows[^{}]*)\{([^}]*)\}/g)];
	expect(rules.length).toBeGreaterThan(0);
	for (const [, , declarations] of rules) {
		expect(declarations).not.toMatch(/overscroll-behavior(?:-y|-block)?\s*:\s*(?:contain|none)/);
	}
});
