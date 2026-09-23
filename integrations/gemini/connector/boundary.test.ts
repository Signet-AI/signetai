import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const directory = import.meta.dir;

describe("Gemini connector dependency boundary", () => {
	it("does not depend directly on core or daemon packages", () => {
		const source = readFileSync(join(directory, "src", "index.ts"), "utf8");
		const manifest = readFileSync(join(directory, "package.json"), "utf8");
		expect(source).not.toMatch(/@signet\/(?:core|daemon)/);
		expect(manifest).not.toMatch(/@signet\/(?:core|daemon)/);
	});
});
