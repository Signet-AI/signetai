import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("version consistency workflow", () => {
	test("uses the central version-sync check so Cargo and publish manifests are covered", () => {
		const workflow = readFileSync(".github/workflows/version-consistency.yml", "utf8");

		expect(workflow).toContain("bun scripts/version-sync.ts --check");
	});

	test("nightly release uses central version sync for release commits", () => {
		const workflow = readFileSync(".github/workflows/release.yml", "utf8");

		expect(workflow).toContain('bun scripts/version-sync.ts --to "$NEW_VERSION"');
		expect(workflow).not.toContain("mapfile -t PACKAGE_FILES");
		expect(workflow).not.toContain("jq --arg v");
	});
});
