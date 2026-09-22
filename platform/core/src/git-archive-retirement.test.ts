import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { prepareRootGitArchive, verifyRootGitArchive } from "./git-archive-retirement";

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

	it("refuses nested repositories and non-root repositories", () => {
		const root = repo();
		const nested = join(root, "nested");
		spawnSync("git", ["init", "-q", nested]);
		expect(() => prepareRootGitArchive(root, join(root, "retirement"))).toThrow(/nested/i);
	});
});
