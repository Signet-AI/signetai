import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("version consistency workflow", () => {
	test("uses the central version-sync check so Cargo and publish manifests are covered", () => {
		const workflow = readFileSync(".github/workflows/version-consistency.yml", "utf8");

		expect(workflow).toContain("bun scripts/version-sync.ts --check");
	});

	test("nightly release bump uses central version sync before refreshing bun.lock", () => {
		const workflow = readFileSync(".github/workflows/release.yml", "utf8");
		const syncIndex = workflow.indexOf('bun scripts/version-sync.ts --to "$NEW_VERSION"');
		const installIndex = workflow.indexOf("bun install", syncIndex);

		expect(syncIndex).toBeGreaterThan(-1);
		expect(installIndex).toBeGreaterThan(syncIndex);
		expect(workflow).toContain("git add -u -- package.json platform surfaces integrations libs plugins dist runtimes");
	});
});
