import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
		writeFileSync(
			join(root, ".gitignore"),
			"# user\n# BEGIN Signet lightweight workspace\n# END Signet lightweight workspace\n",
		);
		spawnSync("git", ["add", ".gitignore"], { cwd: root });
		spawnSync("git", ["commit", "-qm", "init"], { cwd: root });
		expect(managedGitignoreUpdate(root).status).toBe("updated");
		spawnSync("git", ["add", ".gitignore"], { cwd: root });
		writeFileSync(join(root, ".gitignore"), "# changed\n");
		const refused = managedGitignoreUpdate(root);
		expect(refused.status).toBe("refused");
		if (refused.status === "refused") {
			expect(refused.reason).toBe("staged");
			expect(refused.preimage).toBe("# changed\n");
			expect(refused.content).toContain("# BEGIN Signet lightweight workspace");
		}
	});

	it("refuses an untracked user gitignore without mutation", () => {
		const root = repo();
		writeFileSync(join(root, ".gitignore"), "  user rule  ");
		const result = managedGitignoreUpdate(root);
		expect(result.status).toBe("refused");
		expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("  user rule  ");
	});

	it("refuses nested repositories without mutation", () => {
		const parent = repo();
		const root = join(parent, "nested");
		mkdirSync(root);
		spawnSync("git", ["init", "-q"], { cwd: root });
		writeFileSync(join(root, ".gitignore"), "user\n");
		const result = managedGitignoreUpdate(root);
		expect(result.status).toBe("refused");
		expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("user\n");
	});

	it("preserves user whitespace around the managed block", () => {
		const root = repo();
		const original = "\n  # user  \n\n# BEGIN Signet lightweight workspace\n# END Signet lightweight workspace\n";
		writeFileSync(join(root, ".gitignore"), original);
		spawnSync("git", ["add", ".gitignore"], { cwd: root });
		spawnSync("git", ["commit", "-qm", "init"], { cwd: root });
		const result = managedGitignoreUpdate(root);
		expect(result.status).toBe("updated");
		expect(result.content.startsWith("\n  # user  \n\n# BEGIN")).toBe(true);
	});

	it("preserves CRLF and a missing final newline", () => {
		const root = repo();
		writeFileSync(
			join(root, ".gitignore"),
			"# user\r\n*.tmp\r\n# BEGIN Signet lightweight workspace\r\n# END Signet lightweight workspace",
		);
		spawnSync("git", ["add", ".gitignore"], { cwd: root });
		spawnSync("git", ["commit", "-qm", "init"], { cwd: root });
		const result = managedGitignoreUpdate(root);
		expect(result.status).toBe("updated");
		expect(result.content.includes("\r\n")).toBe(true);
		expect(result.content.endsWith("\r\n")).toBe(false);
	});
});
