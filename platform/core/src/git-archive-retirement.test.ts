import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { prepareRootGitArchive, restoreVerifiedRootGitArchive, verifyRootGitArchive } from "./git-archive-retirement";

function run(root: string, args: string[]) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
}
function repo() {
	const root = mkdtempSync(join(tmpdir(), "git-archive-retirement-"));
	run(root, ["init", "-q"]);
	run(root, ["config", "user.email", "test@example.invalid"]);
	run(root, ["config", "user.name", "Test"]);
	writeFileSync(join(root, "tracked"), "history\n");
	run(root, ["add", "."]);
	run(root, ["commit", "-qm", "initial"]);
	return root;
}

describe("verified root git archive retirement", () => {
	it("creates a verified bundle and separate live-state archive without mutating the repository", () => {
		const root = repo();
		writeFileSync(join(root, "untracked"), "private\n", { mode: 0o700 });
		writeFileSync(join(root, "tracked"), "working\n");
		const before = spawnSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }).stdout;
		const archive = prepareRootGitArchive(root, join(root, "retirement"));
		expect(verifyRootGitArchive(archive)).toMatchObject({ verified: true });
		expect(statSync(archive.bundlePath).isFile()).toBe(true);
		expect(statSync(archive.liveArchivePath).isFile()).toBe(true);
		expect(readFileSync(archive.manifestPath, "utf8")).not.toContain("private");
		expect(spawnSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }).stdout).toBe(before);
	});

	it("restores staged, unstaged, untracked, hooks, config, and repository identity", () => {
		const root = repo();
		writeFileSync(join(root, "tracked"), "staged\n");
		run(root, ["add", "tracked"]);
		writeFileSync(join(root, "tracked"), "unstaged\n");
		writeFileSync(join(root, "untracked"), "untracked\n");
		const hook = join(root, ".git", "hooks", "pre-commit");
		writeFileSync(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const archive = prepareRootGitArchive(root, join(root, "retirement"));
		expect(verifyRootGitArchive(archive)).toMatchObject({ verified: true });
		const destination = join(root, "restored");
		restoreVerifiedRootGitArchive(archive, destination);
		expect(readFileSync(join(destination, "tracked"), "utf8")).toBe("unstaged\n");
		expect(readFileSync(join(destination, "untracked"), "utf8")).toBe("untracked\n");
		expect(readFileSync(join(destination, ".git", "hooks", "pre-commit"), "utf8")).toContain("exit 0");
		expect(spawnSync("git", ["-C", destination, "diff", "--cached", "--quiet"], { encoding: "utf8" }).status).toBe(1);
		expect(spawnSync("git", ["-C", destination, "status", "--porcelain=v1"], { encoding: "utf8" }).stdout).toContain(
			"untracked",
		);
		expect(
			spawnSync("git", ["-C", destination, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim(),
		).toBe(destination);
	});

	it("preserves nested repositories and refuses non-root repositories", () => {
		const root = repo();
		const nested = join(root, "nested");
		spawnSync("git", ["init", "-q", nested]);
		writeFileSync(join(nested, "nested-file"), "nested\n");
		const archive = prepareRootGitArchive(root, join(root, "retirement"));
		const destination = join(root, "restored-nested");
		restoreVerifiedRootGitArchive(archive, destination);
		expect(
			spawnSync("git", ["-C", join(destination, "nested"), "rev-parse", "--show-toplevel"], { encoding: "utf8" })
				.status,
		).toBe(0);
		expect(readFileSync(join(destination, "nested", "nested-file"), "utf8")).toBe("nested\n");
		const nonRoot = join(root, "plain-directory");
		mkdirSync(nonRoot);
		expect(() => prepareRootGitArchive(nonRoot, join(root, "non-root-retirement"))).toThrow(/root/i);
	});
});
