import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type WorkspaceSourceRepoSyncOptions,
	type WorkspaceSourceRepoSyncResult,
	resolveWorkspaceSourceRepoPath,
	syncWorkspaceSourceRepo,
	syncWorkspaceSourceRepoAsync,
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

function syncWorkspace(
	workspaceDir: string,
	remoteUrl: string,
	options: Omit<WorkspaceSourceRepoSyncOptions, "remoteUrl" | "cloneIfMissing"> = {},
): WorkspaceSourceRepoSyncResult {
	return syncWorkspaceSourceRepo(workspaceDir, { remoteUrl, cloneIfMissing: true, ...options });
}

describe("syncWorkspaceSourceRepo", () => {
	it("skips absent checkouts without cloning or creating sync state", async () => {
		const { remoteUrl } = seedRemote();
		const workspace = makeTempDir("signet-no-source-");
		for (const sync of [syncWorkspaceSourceRepo, syncWorkspaceSourceRepoAsync]) {
			expect(await sync(workspace, { remoteUrl })).toMatchObject({ status: "skipped" });
			expect(existsSync(resolveWorkspaceSourceRepoPath(workspace))).toBe(false);
			expect(existsSync(join(workspace, ".daemon"))).toBe(false);
		}
	});

	it("does not treat an empty directory as authorization to clone", async () => {
		const { remoteUrl } = seedRemote();
		const workspace = makeTempDir("signet-empty-source-");
		mkdirSync(resolveWorkspaceSourceRepoPath(workspace));
		for (const sync of [syncWorkspaceSourceRepo, syncWorkspaceSourceRepoAsync])
			expect(await sync(workspace, { remoteUrl })).toMatchObject({ status: "skipped" });
		expect(existsSync(join(resolveWorkspaceSourceRepoPath(workspace), ".git"))).toBe(false);
	});

	it("explicit async creation preserves ordinary maintenance of an existing checkout", async () => {
		const { remoteUrl, workDir } = seedRemote();
		const workspace = makeTempDir("signet-explicit-source-");
		expect(await syncWorkspaceSourceRepoAsync(workspace, { remoteUrl, cloneIfMissing: true })).toMatchObject({
			status: "cloned",
		});
		pushRemoteChange(workDir, "Updated source\n", "update");
		expect(await syncWorkspaceSourceRepoAsync(workspace, { remoteUrl })).toMatchObject({ status: "pulled" });
		expect(syncWorkspaceSourceRepo(workspace, { remoteUrl })).toMatchObject({ status: "current" });
	});

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

	it("returns current when the checkout already matches origin", () => {
		const { remoteUrl } = seedRemote();
		const workspaceDir = makeTempDir("signet-source-workspace-");

		expect(syncWorkspace(workspaceDir, remoteUrl).status).toBe("cloned");

		const result = syncWorkspace(workspaceDir, remoteUrl);

		expect(result.status).toBe("current");
		expect(result.message).toContain("already current");
	});

	it("pulls through generated desktop build artifacts", () => {
		const { remoteUrl, workDir } = seedRemote();
		const workspaceDir = makeTempDir("signet-source-workspace-");

		expect(syncWorkspace(workspaceDir, remoteUrl).status).toBe("cloned");
		const repoPath = resolveWorkspaceSourceRepoPath(workspaceDir);
		mkdirSync(join(repoPath, "surfaces", "desktop", "release"), { recursive: true });
		mkdirSync(join(repoPath, "surfaces", "desktop", "resources", "daemon"), { recursive: true });
		mkdirSync(join(repoPath, "dist", "signetai", "hermes-plugin"), { recursive: true });
		mkdirSync(join(repoPath, "platform", "daemon"), { recursive: true });
		writeFileSync(join(repoPath, "surfaces", "desktop", "release", "Signet-0.1.0-linux-x64.AppImage"), "app");
		writeFileSync(join(repoPath, "surfaces", "desktop", "resources", "daemon", "daemon.js"), "daemon");
		writeFileSync(join(repoPath, "dist", "signetai", "hermes-plugin", "plugin.py"), "plugin");
		writeFileSync(join(repoPath, "platform", "daemon", "anydoc.win32-x64-msvc-gs7ezvas.node"), "native addon");
		pushRemoteChange(workDir, "# signet\n\nremote build fix\n", "remote build fix");

		const result = syncWorkspace(workspaceDir, remoteUrl);

		expect(result.status).toBe("pulled");
		expect(readFileSync(join(repoPath, "README.md"), "utf-8")).toContain("remote build fix");
		expect(
			readFileSync(join(repoPath, "surfaces", "desktop", "release", "Signet-0.1.0-linux-x64.AppImage"), "utf-8"),
		).toBe("app");
		expect(readFileSync(join(repoPath, "platform", "daemon", "anydoc.win32-x64-msvc-gs7ezvas.node"), "utf-8")).toBe(
			"native addon",
		);
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

	it("autostashes tracked and untracked changes before pulling when requested", () => {
		const { remoteUrl, workDir } = seedRemote();
		const workspaceDir = makeTempDir("signet-source-workspace-");

		expect(syncWorkspace(workspaceDir, remoteUrl).status).toBe("cloned");
		const repoPath = resolveWorkspaceSourceRepoPath(workspaceDir);
		mkdirSync(join(repoPath, "platform", "daemon"), { recursive: true });
		writeFileSync(join(repoPath, "platform", "daemon", "anydoc.win32-x64-msvc-gs7ezvas.node"), "generated addon\n");
		writeFileSync(join(repoPath, "README.md"), "# local edits\n");
		writeFileSync(join(repoPath, "local-notes.txt"), "keep this\n");
		pushRemoteChange(workDir, "# signet\n\nremote change\n", "remote change");

		const result = syncWorkspace(workspaceDir, remoteUrl, { localChanges: "stash" });

		expect(result.status).toBe("pulled");
		expect(result.localChanges).toBe("stashed");
		expect(result.stashRef).toMatch(/^[0-9a-f]{40}$/);
		expect(result.message).toContain(`local changes were preserved in stash ${result.stashRef}`);
		expect(readFileSync(join(repoPath, "README.md"), "utf-8")).toContain("remote change");
		expect(existsSync(join(repoPath, "local-notes.txt"))).toBe(false);
		expect(existsSync(join(repoPath, "platform", "daemon", "anydoc.win32-x64-msvc-gs7ezvas.node"))).toBe(true);
		expect(runGit(["stash", "list", "--format=%H %s"], repoPath)).toContain(
			`${result.stashRef} On main: signet-source-autostash-`,
		);
	});

	it("does not stash local changes when the checkout is already current", () => {
		const { remoteUrl } = seedRemote();
		const workspaceDir = makeTempDir("signet-source-workspace-");

		expect(syncWorkspace(workspaceDir, remoteUrl).status).toBe("cloned");
		const repoPath = resolveWorkspaceSourceRepoPath(workspaceDir);
		writeFileSync(join(repoPath, "README.md"), "# local edits that stay put\n");

		const result = syncWorkspace(workspaceDir, remoteUrl, { localChanges: "stash" });

		expect(result.status).toBe("current");
		expect(result.localChanges).toBe("left-in-place");
		expect(result.stashRef).toBeUndefined();
		expect(readFileSync(join(repoPath, "README.md"), "utf-8")).toBe("# local edits that stay put\n");
		expect(runGit(["stash", "list"], repoPath)).toBe("");
	});

	it("autostashes local changes through the async sync path", async () => {
		const { remoteUrl, workDir } = seedRemote();
		const workspaceDir = makeTempDir("signet-source-workspace-");

		expect((await syncWorkspaceSourceRepoAsync(workspaceDir, { remoteUrl, cloneIfMissing: true })).status).toBe(
			"cloned",
		);
		const repoPath = resolveWorkspaceSourceRepoPath(workspaceDir);
		writeFileSync(join(repoPath, "README.md"), "# async local edits\n");
		pushRemoteChange(workDir, "# signet\n\nasync remote change\n", "async remote change");

		const result = await syncWorkspaceSourceRepoAsync(workspaceDir, { remoteUrl, localChanges: "stash" });

		expect(result.status).toBe("pulled");
		expect(result.localChanges).toBe("stashed");
		expect(result.stashRef).toMatch(/^[0-9a-f]{40}$/);
		expect(readFileSync(join(repoPath, "README.md"), "utf-8")).toContain("async remote change");
	});

	it("rejects unsafe remote URLs before invoking git clone", () => {
		const workspaceDir = makeTempDir("signet-source-workspace-");

		const result = syncWorkspaceSourceRepo(workspaceDir, {
			cloneIfMissing: true,
			remoteUrl: "--upload-pack=touch /tmp/pwned",
		});

		expect(result.status).toBe("error");
		expect(result.message).toContain("safe git source");
	});

	it("surfaces sync lock acquisition errors instead of reporting a duplicate run", () => {
		const workspaceDir = makeTempDir("signet-source-workspace-");
		writeFileSync(join(workspaceDir, ".daemon"), "not a directory\n");

		const result = syncWorkspaceSourceRepo(workspaceDir, { cloneIfMissing: true });

		expect(result.status).toBe("error");
		expect(result.message).toContain("failed to acquire source checkout sync lock");
	});

	it("returns a typed error when the workspace path cannot host the lock directory", () => {
		const root = makeTempDir("signet-source-workspace-");
		const workspaceFile = join(root, "workspace-file");
		writeFileSync(workspaceFile, "not a directory\n");

		const result = syncWorkspaceSourceRepo(workspaceFile, { cloneIfMissing: true });

		expect(result.status).toBe("error");
		expect(result.message).toContain("failed to prepare source checkout sync lock directory");
	});
});
