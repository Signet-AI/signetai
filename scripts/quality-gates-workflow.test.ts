import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("quality gate enforcement", () => {
	test("runs JavaScript and Rust gates across Linux and macOS", () => {
		const workflow = read(".github/workflows/quality-gates.yml");

		expect(workflow).toContain("os: [ubuntu-latest, macos-latest]");
		expect(workflow).toContain('PUPPETEER_SKIP_DOWNLOAD: "1"');
		expect(workflow).toContain("bun test");
		expect(workflow).toContain("cargo clippy --workspace --all-targets --all-features -- -D warnings");
		expect(workflow).toContain("cargo deny check advisories bans licenses sources");
	});

	test("lints automation and removes checklist bypasses", () => {
		const workflow = read(".github/workflows/quality-gates.yml");

		expect(workflow).toContain("rhysd/actionlint");
		expect(workflow).toContain("koalaman/shellcheck");
		expect(workflow).toContain("hadolint/hadolint");
		for (const path of [
			".github/workflows/pr-readiness-check.yml",
			".github/workflows/bugfix-regression-check.yml",
			".github/workflows/migration-guard.yml",
		]) {
			expect(read(path)).not.toContain("checklist-exception");
		}
	});

	test("installs local hooks and defines quality ownership", () => {
		expect(read(".githooks/pre-commit")).toContain("biome check --staged");
		expect(read(".githooks/pre-commit")).toContain("cargo clippy");

		const owners = read(".github/CODEOWNERS");
		expect(owners).toContain("/platform/daemon-rs/");
		expect(owners).toContain("/platform/core/src/migrations/");
	});
});
