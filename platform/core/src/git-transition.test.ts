import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { inspectRootGit, managedGitignoreUpdate } from "./git-transition";

function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "git-transition-"));
	spawnSync("git", ["init", "-q"], { cwd: root });
	return root;
}

describe("root git transition", () => {
	it("classifies absent and unmanaged repositories", () => {
		const root = mkdtempSync(join(tmpdir(), "git-transition-"));
		expect(inspectRootGit(root).mode).toBe("absent");
		expect(inspectRootGit(repo()).mode).toBe("unmanaged");
	});
	it("classifies a managed shell repository without changing git state", () => {
		const root = repo();
		writeFileSync(
			join(root, ".gitignore"),
			"# BEGIN Signet lightweight workspace\n# END Signet lightweight workspace\n",
		);
		expect(inspectRootGit(root).mode).toBe("shell");
	});
	it("updates a clean ignore file and refuses dirty or staged edits", () => {
		const root = repo();
		writeFileSync(join(root, ".gitignore"), "# user\n");
		expect(managedGitignoreUpdate(root).status).toBe("updated");
		spawnSync("git", ["add", ".gitignore"], { cwd: root });
		writeFileSync(join(root, ".gitignore"), "# changed\n");
		expect(managedGitignoreUpdate(root)).toEqual({ status: "refused", reason: "staged" });
	});
});
