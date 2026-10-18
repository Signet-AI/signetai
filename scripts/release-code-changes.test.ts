import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const script = join(import.meta.dir, "release-code-changes.sh");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function git(repo: string, ...args: readonly string[]): string {
	const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

function createRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "signet-release-changes-test-"));
	tempDirs.push(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "commit.gpgsign", "false");
	git(repo, "config", "tag.gpgsign", "false");
	return repo;
}

function commit(repo: string, path: string, message: string): void {
	mkdirSync(join(repo, dirname(path)), { recursive: true });
	writeFileSync(join(repo, path), `${message}\n`);
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", message);
}

function changes(repo: string, base: string, head: string): ReturnType<typeof spawnSync> {
	return spawnSync(script, [base, head], { cwd: repo, encoding: "utf8" });
}

describe("release-code-changes", () => {
	test("reports code that landed before a docs-only head since the last release", () => {
		const repo = createRepo();
		commit(repo, "package.json", "chore: release 0.1.0");
		git(repo, "tag", "v0.1.0");
		commit(repo, "platform/daemon/src/fix.ts", "fix: daemon");
		commit(repo, "docs/guide.md", "docs: guide");

		const sinceParent = changes(repo, "HEAD~1", "HEAD");
		expect(sinceParent.status).toBe(0);
		expect(sinceParent.stdout).toBe("");

		const sinceRelease = changes(repo, "--since-release", "HEAD");
		expect(sinceRelease.status).toBe(0);
		expect(sinceRelease.stdout.trim()).toBe("platform/daemon/src/fix.ts");
		expect(sinceRelease.stderr).toContain("Comparing v0.1.0..HEAD");
	});

	test("reports nothing when the last release already covers the code", () => {
		const repo = createRepo();
		commit(repo, "package.json", "chore: release 0.1.0");
		git(repo, "tag", "v0.1.0");
		commit(repo, "platform/daemon/src/fix.ts", "fix: daemon");
		commit(repo, "package.json", "chore: release 0.1.1");
		git(repo, "tag", "v0.1.1");
		commit(repo, "docs/guide.md", "docs: guide");

		const result = changes(repo, "--since-release", "HEAD");
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Comparing v0.1.1..HEAD");
	});

	test("ignores docs and images under code directories", () => {
		const repo = createRepo();
		commit(repo, "package.json", "chore: release 0.1.0");
		git(repo, "tag", "v0.1.0");
		commit(repo, "platform/daemon/README.md", "docs: daemon readme");
		commit(repo, "surfaces/dashboard/logo.svg", "chore: logo");

		const result = changes(repo, "--since-release", "HEAD");
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
	});

	test("fails instead of reporting no changes when a ref is missing", () => {
		const repo = createRepo();
		commit(repo, "platform/daemon/src/fix.ts", "fix: daemon");

		expect(changes(repo, "--since-release", "HEAD").status).not.toBe(0);
		expect(changes(repo, "v9.9.9", "HEAD").status).not.toBe(0);
	});
});

describe("release workflow queueing", () => {
	const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
	const preflight = workflow.slice(
		workflow.indexOf("\n  macos-signing-preflight:\n"),
		workflow.indexOf("\n  release:\n"),
	);
	const release = workflow.slice(workflow.indexOf("\n  release:\n"), workflow.indexOf("\n  build-native:\n"));

	test("queues release jobs and keeps resume runs out of the push queue", () => {
		expect(release).toContain(
			"group: ${{ inputs.resume_from_tag && format('nightly-release-resume-{0}', inputs.resume_from_tag) || 'nightly-release-pipeline' }}",
		);
		expect(release).toContain("cancel-in-progress: false");
		expect(release).not.toContain("cancel-in-progress: true");
	});

	test("signing preflight and release compare the same range against the last release tag", () => {
		for (const job of [preflight, release]) {
			expect(job).toContain("git fetch --force --tags origin +refs/heads/main:refs/remotes/origin/main");
			expect(job).toContain("scripts/release-code-changes.sh --since-release origin/main");
			expect(job).not.toContain("HEAD~1");
		}
	});

	test("release scripts the workflows execute directly are committed executable", () => {
		const result = spawnSync(
			"git",
			["ls-files", "-s", "scripts/release-code-changes.sh", "scripts/advance-npm-dist-tag.sh"],
			{ cwd: root, encoding: "utf8" },
		);
		const modes = result.stdout
			.trim()
			.split("\n")
			.map((line) => line.split(/\s+/)[0]);
		expect(modes).toEqual(["100755", "100755"]);
	});
});
