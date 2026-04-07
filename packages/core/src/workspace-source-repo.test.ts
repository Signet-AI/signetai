import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveWorkspaceSourceRepoPath,
	syncWorkspaceSourceRepo,
	type WorkspaceSourceRepoSyncResult,
} from "./workspace-source-repo";

const tmpDirs: string[] = [];

afterEach((): void => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (!dir) continue;
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

function runGit(args: readonly string[], cwd: string): string {
	const proc = Bun.spawnSync(["git", ...args], {
		cwd,
		stderr: "pipe",
		stdout: "pipe",
	});

	if (proc.exitCode !== 0) {
		const stderr = proc.stderr.toString().trim();
		const stdout = proc.stdout.toString().trim();
		throw new Error(stderr || stdout || `git ${args.join(" ")} failed`);
	}

	return proc.stdout.toString().trim();
}

function seedRemote(): { remoteDir: string; workDir: string; remoteUrl: string } {
	const root = makeTempDir("signet-source-repo-");
	const remoteDir = join(root, "origin.git");
	const workDir = join(root, "seed");

	runGit(["init", "--bare", remoteDir], root);
	runGit(["init", "--initial-branch=main", workDir], root);
	runGit(["config", "user.name", "Signet Test"], workDir);
	runGit(["config", "user.email", "signet@example.com"], workDir);
	writeFileSync(join(workDir, "README.md"), "# signet\n");
	runGit(["add", "README.md"], workDir);
	runGit(["commit", "-m", "initial"], workDir);
	runGit(["remote", "add", "origin", remoteDir], workDir);
	runGit(["push", "-u", "origin", "main"], workDir);
	runGit(["symbolic-ref", "HEAD", "refs/heads/main"], remoteDir);

	return {
		remoteDir,
		workDir,
		remoteUrl: `file://${remoteDir}`,
	};
}

function pushRemoteChange(workDir: string, content: string, message: string): void {
	writeFileSync(join(workDir, "README.md"), content);
	runGit(["add", "README.md"], workDir);
	runGit(["commit", "-m", message], workDir);
	runGit(["push", "origin", "main"], workDir);
}

function syncWorkspace(workspaceDir: string, remoteUrl: string): WorkspaceSourceRepoSyncResult {
	return syncWorkspaceSourceRepo(workspaceDir, { remoteUrl });
}

describe("syncWorkspaceSourceRepo", () => {
	it("clones the Signet source checkout when the workspace does not have one", () => {
		const { remoteUrl } = seedRemote();
		const workspaceDir = makeTempDir("signet-source-workspace-");

		const result = syncWorkspace(workspaceDir, remoteUrl);
		const repoPath = resolveWorkspaceSourceRepoPath(workspaceDir);

		expect(result.status).toBe("cloned");
		expect(result.path).toBe(repoPath);
		expect(result.branch).toBe("main");
		expect(result.defaultBranch).toBe("main");
		expect(readFileSync(join(repoPath, "README.md"), "utf-8")).toContain("# signet");
	});

	it("pulls the latest commit when the checkout is clean and tracking the default branch", () => {
		const { remoteUrl, workDir } = seedRemote();
		const workspaceDir = makeTempDir("signet-source-workspace-");

		expect(syncWorkspace(workspaceDir, remoteUrl).status).toBe("cloned");
		pushRemoteChange(workDir, "# signet\n\nsecond\n", "second");

		const result = syncWorkspace(workspaceDir, remoteUrl);
		const repoPath = resolveWorkspaceSourceRepoPath(workspaceDir);

		expect(result.status).toBe("pulled");
		expect(readFileSync(join(repoPath, "README.md"), "utf-8")).toContain("second");
	});

	it("fetches but does not pull over local workspace changes", () => {
		const { remoteUrl, workDir } = seedRemote();
		const workspaceDir = makeTempDir("signet-source-workspace-");

		expect(syncWorkspace(workspaceDir, remoteUrl).status).toBe("cloned");
		const repoPath = resolveWorkspaceSourceRepoPath(workspaceDir);
		writeFileSync(join(repoPath, "README.md"), "# local edits\n");
		pushRemoteChange(workDir, "# signet\n\nremote change\n", "remote change");

		const result = syncWorkspace(workspaceDir, remoteUrl);

		expect(result.status).toBe("fetched");
		expect(result.message).toContain("working tree has local changes");
		expect(readFileSync(join(repoPath, "README.md"), "utf-8")).toBe("# local edits\n");
	});
});
