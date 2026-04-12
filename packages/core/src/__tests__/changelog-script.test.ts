import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../../../");
const changelogScript = join(repoRoot, "scripts", "changelog.ts");
const extractSectionScript = join(repoRoot, "scripts", "extract-changelog-section.ts");

const tempDirs: string[] = [];

function run(cmd: readonly string[], cwd: string): string {
	const [file, ...args] = cmd;
	const result = spawnSync(file, args, {
		cwd,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(
			[`command failed: ${cmd.join(" ")}`, `stdout:\n${result.stdout}`, `stderr:\n${result.stderr}`].join("\n\n"),
		);
	}
	return result.stdout;
}

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-changelog-test-"));
	tempDirs.push(dir);

	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tmp-root", version: "0.1.0" }, null, 2));
	writeFileSync(join(dir, "bunfig.toml"), '[test]\nroot = "packages"\n');
	mkdirSync(join(dir, "packages", "signetai"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), "node_modules\n");
	writeFileSync(
		join(dir, "packages", "signetai", "package.json"),
		JSON.stringify({ name: "signetai", version: "0.1.0" }, null, 2),
	);

	run(["git", "init"], dir);
	run(["git", "config", "user.name", "Test User"], dir);
	run(["git", "config", "user.email", "test@example.com"], dir);
	run(["git", "add", "."], dir);
	run(["git", "commit", "-m", "chore: bootstrap"], dir);
	run(["git", "tag", "v0.1.0"], dir);

	return dir;
}

function makePendingReleaseRepo(): string {
	const dir = makeRepo();
	writeFileSync(join(dir, "README.md"), "hello\n");
	run(["git", "add", "README.md"], dir);
	run(["git", "commit", "-m", "fix(cli): repair release notes ordering"], dir);
	return dir;
}

function makeTaggedReleaseRepo(): string {
	const dir = makeRepo();
	writeFileSync(join(dir, "README.md"), "hello\n");
	run(["git", "add", "README.md"], dir);
	run(["git", "commit", "-m", "fix(cli): repair release notes ordering"], dir);
	writeFileSync(join(dir, "NOTES.md"), "release notes\n");
	run(["git", "add", "NOTES.md"], dir);
	run(["git", "commit", "-m", "docs(repo): document release flow"], dir);
	run(["git", "tag", "v0.1.1"], dir);
	return dir;
}

function countOccurrences(value: string, needle: string): number {
	return value.split(needle).length - 1;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

describe("scripts/changelog.ts", () => {
	test("writes the changelog section for the explicit release version instead of the pre-bump package version", () => {
		const dir = makePendingReleaseRepo();

		run(["bun", changelogScript, "--bump-only"], dir);
		expect(readFileSync(join(dir, ".bump-level"), "utf8").trim()).toBe("patch");
		expect(existsSync(join(dir, "CHANGELOG.md"))).toBe(false);

		run(["bun", changelogScript, "--version", "0.1.1", "--date", "2026-04-09"], dir);

		const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
		expect(changelog).toContain("## Recent Highlights");
		expect(changelog).toContain("## Release Ledger");
		expect(changelog).toContain("### 2026-04-09");
		expect(changelog).toContain("- Bug fixes: repair release notes ordering.");
		expect(changelog).toContain("## [0.1.1] - 2026-04-09");
		expect(changelog).not.toContain("## [0.1.0] - 2026-04-09");
		expect(changelog).toContain("Release summary: 1 bug fix.");
		expect(changelog).toContain("Tag range: `v0.1.0..v0.1.1`.");
		expect(changelog).toContain("- **cli**: repair release notes ordering");

		const section = run(["bun", extractSectionScript, "0.1.1"], dir).trim();
		expect(section).toContain("## [0.1.1] - 2026-04-09");
		expect(section).toContain("Release summary: 1 bug fix.");
		expect(section).toContain("Tag range: `v0.1.0..v0.1.1`.");
		expect(section).toContain("### Bug Fixes");
		expect(section).toContain("- **cli**: repair release notes ordering");
	});

	test("rebuild regenerates the full changelog from tags with summaries and range lines", () => {
		const dir = makeTaggedReleaseRepo();

		run(["bun", changelogScript, "--rebuild"], dir);

		const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
		expect(changelog).toContain("## Recent Highlights");
		expect(changelog).toContain("## Release Ledger");
		expect(changelog).toMatch(/### \d{4}-\d{2}-\d{2}/);
		expect(changelog).toContain("- Bug fixes: repair release notes ordering.");
		expect(changelog).toContain("- Docs: document release flow.");
		expect(changelog).toContain("## [0.1.1] - ");
		expect(changelog).toContain("Release summary: 1 bug fix and 1 docs update.");
		expect(changelog).toContain("Tag range: `v0.1.0..v0.1.1`.");
		expect(changelog).toContain("- **cli**: repair release notes ordering");
		expect(changelog).toContain("- **repo**: document release flow");
		expect(changelog).toContain("## [0.1.0] - ");
		expect(changelog).toContain(
			"Release summary: internal maintenance release with no conventional commit entries captured.",
		);
		expect(changelog.indexOf("## [0.1.1] - ")).toBeLessThan(changelog.indexOf("## [0.1.0] - "));
	});

	test("prepends a release to an existing structured changelog without duplicating document sections", () => {
		const dir = makePendingReleaseRepo();

		run(["bun", changelogScript, "--version", "0.1.1", "--date", "2026-04-09"], dir);
		run(["git", "add", "CHANGELOG.md", ".bump-level"], dir);
		run(["git", "commit", "-m", "chore: release 0.1.1"], dir);
		run(["git", "tag", "v0.1.1"], dir);

		writeFileSync(join(dir, "API.md"), "api notes\n");
		run(["git", "add", "API.md"], dir);
		run(["git", "commit", "-m", "docs(api): document steady-state release flow"], dir);

		run(["bun", changelogScript, "--version", "0.1.2", "--date", "2026-04-10"], dir);

		const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
		expect(countOccurrences(changelog, "## Recent Highlights")).toBe(1);
		expect(countOccurrences(changelog, "## Release Ledger")).toBe(1);
		expect(changelog.indexOf("## [0.1.2] - 2026-04-10")).toBeLessThan(changelog.indexOf("## [0.1.1] - 2026-04-09"));
		expect(changelog).toContain("Release summary: 1 docs update.");
		expect(changelog).toContain("Tag range: `v0.1.1..v0.1.2`.");
		expect(changelog).toContain("- **api**: document steady-state release flow");
		expect(changelog).toContain("Tag range: `v0.1.0..v0.1.1`.");
		expect(changelog).toContain("- **cli**: repair release notes ordering");
	});
});
