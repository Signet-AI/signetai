import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const SIGNET_SOURCE_CHECKOUT_DIRNAME = "signetai";
export const SIGNET_SOURCE_REMOTE_URL = "https://github.com/Signet-AI/signetai.git";

const DEFAULT_GIT_TIMEOUT_MS = 60_000;

export type WorkspaceSourceRepoStatus =
	| "cloned"
	| "pulled"
	| "fetched"
	| "current"
	| "skipped"
	| "error";

export interface WorkspaceSourceRepoSyncOptions {
	readonly gitTimeoutMs?: number;
	readonly remoteUrl?: string;
	readonly repoDirName?: string;
}

export interface WorkspaceSourceRepoSyncResult {
	readonly status: WorkspaceSourceRepoStatus;
	readonly path: string;
	readonly message: string;
	readonly branch: string | null;
	readonly defaultBranch: string | null;
}

interface GitCommandResult {
	readonly ok: boolean;
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly errorCode: string | null;
}

interface AheadBehind {
	readonly ahead: number;
	readonly behind: number;
}

export function resolveWorkspaceSourceRepoPath(workspaceDir: string, repoDirName = SIGNET_SOURCE_CHECKOUT_DIRNAME): string {
	return join(resolve(workspaceDir), repoDirName);
}

export function syncWorkspaceSourceRepo(
	workspaceDir: string,
	options: WorkspaceSourceRepoSyncOptions = {},
): WorkspaceSourceRepoSyncResult {
	const timeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
	const remoteUrl = options.remoteUrl ?? SIGNET_SOURCE_REMOTE_URL;
	const repoPath = resolveWorkspaceSourceRepoPath(workspaceDir, options.repoDirName);
	if (!isSafeCloneSource(remoteUrl)) {
		return {
			status: "error",
			path: repoPath,
			message: "failed to clone Signet source checkout: remote URL is not a safe git source",
			branch: null,
			defaultBranch: null,
		};
	}

	if (!isGitAvailable(timeoutMs)) {
		return {
			status: "skipped",
			path: repoPath,
			message: "git is not available, skipped Signet source checkout sync",
			branch: null,
			defaultBranch: null,
		};
	}

	if (!existsSync(repoPath) || isEmptyDirectory(repoPath)) {
		mkdirSync(workspaceDir, { recursive: true });
		const clone = runGit(["clone", "--depth", "1", "--", remoteUrl, repoPath], undefined, timeoutMs);
		if (!clone.ok) {
			return {
				status: "error",
				path: repoPath,
				message: `failed to clone Signet source checkout: ${readGitError(clone)}`,
				branch: null,
				defaultBranch: null,
			};
		}

		const branch = readCurrentBranch(repoPath, timeoutMs);
		const defaultBranch = readDefaultBranch(repoPath, timeoutMs);
		return {
			status: "cloned",
			path: repoPath,
			message: "cloned Signet source checkout",
			branch,
			defaultBranch,
		};
	}

	if (!hasGitMetadata(repoPath)) {
		return {
			status: "skipped",
			path: repoPath,
			message: "workspace already has a non-git signetai directory, skipped managed checkout sync",
			branch: null,
			defaultBranch: null,
		};
	}

	const currentRemote = readOriginRemote(repoPath, timeoutMs);
	if (!currentRemote) {
		return {
			status: "skipped",
			path: repoPath,
			message: "existing Signet source checkout has no origin remote, skipped managed sync",
			branch: readCurrentBranch(repoPath, timeoutMs),
			defaultBranch: readDefaultBranch(repoPath, timeoutMs),
		};
	}

	if (normalizeRemoteUrl(currentRemote) !== normalizeRemoteUrl(remoteUrl)) {
		return {
			status: "skipped",
			path: repoPath,
			message: "existing signetai checkout points at a different remote, left it untouched",
			branch: readCurrentBranch(repoPath, timeoutMs),
			defaultBranch: readDefaultBranch(repoPath, timeoutMs),
		};
	}

	const fetch = runGit(["fetch", "origin", "--prune"], repoPath, timeoutMs);
	if (!fetch.ok) {
		return {
			status: "error",
			path: repoPath,
			message: `failed to fetch Signet source checkout: ${readGitError(fetch)}`,
			branch: readCurrentBranch(repoPath, timeoutMs),
			defaultBranch: readDefaultBranch(repoPath, timeoutMs),
		};
	}

	const branch = readCurrentBranch(repoPath, timeoutMs);
	const defaultBranch = readDefaultBranch(repoPath, timeoutMs);
	if (branch === null) {
		return {
			status: "fetched",
			path: repoPath,
			message: "fetched latest Signet source checkout, skipped pull because the repo is in detached HEAD state",
			branch,
			defaultBranch,
		};
	}

	if (defaultBranch === null) {
		return {
			status: "fetched",
			path: repoPath,
			message: "fetched latest Signet source checkout, skipped pull because origin HEAD is unavailable",
			branch,
			defaultBranch,
		};
	}

	if (branch !== defaultBranch) {
		return {
			status: "fetched",
			path: repoPath,
			message: `fetched latest Signet source checkout, skipped pull because the current branch is ${branch}`,
			branch,
			defaultBranch,
		};
	}

	if (isWorkingTreeDirty(repoPath, timeoutMs)) {
		return {
			status: "fetched",
			path: repoPath,
			message: "fetched latest Signet source checkout, skipped pull because the working tree has local changes",
			branch,
			defaultBranch,
		};
	}

	const upstream = readUpstreamBranch(repoPath, timeoutMs);
	if (upstream !== `origin/${defaultBranch}`) {
		return {
			status: "fetched",
			path: repoPath,
			message: "fetched latest Signet source checkout, skipped pull because the current branch is not tracking origin",
			branch,
			defaultBranch,
		};
	}

	const divergence = readAheadBehind(repoPath, upstream, timeoutMs);
	if (divergence === null) {
		return {
			status: "fetched",
			path: repoPath,
			message: "fetched latest Signet source checkout, skipped pull because branch divergence could not be determined",
			branch,
			defaultBranch,
		};
	}

	if (divergence.ahead > 0) {
		return {
			status: "fetched",
			path: repoPath,
			message: "fetched latest Signet source checkout, skipped pull because the checkout has local commits",
			branch,
			defaultBranch,
		};
	}

	if (divergence.behind === 0) {
		return {
			status: "current",
			path: repoPath,
			message: "Signet source checkout is already current",
			branch,
			defaultBranch,
		};
	}

	if (!isSafeBranchName(defaultBranch, timeoutMs)) {
		return {
			status: "fetched",
			path: repoPath,
			message: "fetched latest Signet source checkout, skipped pull because origin HEAD resolved to an unsafe branch name",
			branch,
			defaultBranch,
		};
	}

	const pull = runGit(["merge", "--ff-only", "--no-edit", `refs/remotes/origin/${defaultBranch}`], repoPath, timeoutMs);
	if (!pull.ok) {
		return {
			status: "error",
			path: repoPath,
			message: `failed to fast-forward Signet source checkout: ${readGitError(pull)}`,
			branch,
			defaultBranch,
		};
	}

	return {
		status: "pulled",
		path: repoPath,
		message: "pulled latest Signet source checkout",
		branch,
		defaultBranch,
	};
}

function isGitAvailable(timeoutMs: number): boolean {
	return runGit(["--version"], undefined, timeoutMs).ok;
}

function runGit(args: readonly string[], cwd: string | undefined, timeoutMs: number): GitCommandResult {
	const result: SpawnSyncReturns<string> = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
		timeout: timeoutMs,
		windowsHide: true,
	});

	return {
		ok: result.status === 0 && result.error === undefined,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
		stderr: typeof result.stderr === "string" ? result.stderr : "",
		exitCode: result.status,
		errorCode: readErrorCode(result.error),
	};
}

function hasGitMetadata(path: string): boolean {
	return existsSync(join(path, ".git"));
}

function isEmptyDirectory(path: string): boolean {
	if (!existsSync(path)) {
		return true;
	}

	try {
		return readdirSync(path).length === 0;
	} catch {
		return false;
	}
}

function readOriginRemote(repoPath: string, timeoutMs: number): string | null {
	const result = runGit(["config", "--get", "remote.origin.url"], repoPath, timeoutMs);
	if (!result.ok) {
		return null;
	}

	const value = result.stdout.trim();
	return value.length > 0 ? value : null;
}

function readCurrentBranch(repoPath: string, timeoutMs: number): string | null {
	const result = runGit(["branch", "--show-current"], repoPath, timeoutMs);
	if (!result.ok) {
		return null;
	}

	const value = result.stdout.trim();
	return value.length > 0 ? value : null;
}

function readDefaultBranch(repoPath: string, timeoutMs: number): string | null {
	const result = runGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoPath, timeoutMs);
	if (!result.ok) {
		return null;
	}

	const value = result.stdout.trim();
	if (!value.startsWith("origin/")) {
		return null;
	}

	const branch = value.slice("origin/".length);
	return branch.length > 0 ? branch : null;
}

function isWorkingTreeDirty(repoPath: string, timeoutMs: number): boolean {
	const result = runGit(["status", "--porcelain", "--ignore-submodules=all"], repoPath, timeoutMs);
	if (!result.ok) {
		return true;
	}

	return result.stdout.trim().length > 0;
}

function readUpstreamBranch(repoPath: string, timeoutMs: number): string | null {
	const result = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], repoPath, timeoutMs);
	if (!result.ok) {
		return null;
	}

	const value = result.stdout.trim();
	return value.length > 0 ? value : null;
}

function readAheadBehind(repoPath: string, upstream: string, timeoutMs: number): AheadBehind | null {
	const result = runGit(["rev-list", "--left-right", "--count", `HEAD...${upstream}`], repoPath, timeoutMs);
	if (!result.ok) {
		return null;
	}

	const match = /^(\d+)\s+(\d+)$/.exec(result.stdout.trim());
	if (!match) {
		return null;
	}

	const ahead = Number.parseInt(match[1], 10);
	const behind = Number.parseInt(match[2], 10);
	if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
		return null;
	}

	return { ahead, behind };
}

function normalizeRemoteUrl(url: string): string {
	const trimmed = trimTrailingSlashes(url.trim());
	if (trimmed.startsWith("git@github.com:")) {
		return `github.com/${stripGitSuffix(trimmed.slice("git@github.com:".length))}`.toLowerCase();
	}
	if (trimmed.startsWith("ssh://git@github.com/")) {
		return `github.com/${stripGitSuffix(trimmed.slice("ssh://git@github.com/".length))}`.toLowerCase();
	}
	if (trimmed.startsWith("https://github.com/")) {
		return `github.com/${stripGitSuffix(trimmed.slice("https://github.com/".length))}`.toLowerCase();
	}
	if (trimmed.startsWith("http://github.com/")) {
		return `github.com/${stripGitSuffix(trimmed.slice("http://github.com/".length))}`.toLowerCase();
	}
	return stripGitSuffix(trimmed);
}

function stripGitSuffix(value: string): string {
	return value.replace(/^\/+/, "").replace(/\.git$/i, "");
}

function trimTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value[end - 1] === "/") {
		end -= 1;
	}
	return end === value.length ? value : value.slice(0, end);
}

function isSafeCloneSource(remoteUrl: string): boolean {
	const trimmed = remoteUrl.trim();
	if (trimmed.length === 0 || trimmed.startsWith("-")) {
		return false;
	}

	return (
		trimmed.startsWith("https://") ||
		trimmed.startsWith("http://") ||
		trimmed.startsWith("ssh://") ||
		trimmed.startsWith("git@") ||
		trimmed.startsWith("file://")
	);
}

function isSafeBranchName(branch: string, timeoutMs: number): boolean {
	if (branch.length === 0 || branch.startsWith("-")) {
		return false;
	}

	return runGit(["check-ref-format", "--branch", branch], undefined, timeoutMs).ok;
}

function readGitError(result: GitCommandResult): string {
	const stderr = result.stderr.trim();
	if (stderr.length > 0) {
		return stderr;
	}

	const stdout = result.stdout.trim();
	if (stdout.length > 0) {
		return stdout;
	}

	if (result.errorCode) {
		return result.errorCode;
	}

	return `exit code ${result.exitCode ?? -1}`;
}

function readErrorCode(err: Error | undefined): string | null {
	if (err === undefined) {
		return null;
	}

	const maybeErrno = err as NodeJS.ErrnoException;
	return typeof maybeErrno.code === "string" ? maybeErrno.code : null;
}
