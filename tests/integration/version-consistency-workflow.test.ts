import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("version consistency workflow", () => {
	test("uses the central version-sync check so Cargo and publish manifests are covered", () => {
		const workflow = readFileSync(".github/workflows/version-consistency.yml", "utf8");

		expect(workflow).toContain("bun scripts/version-sync.ts --check");
	});
});
