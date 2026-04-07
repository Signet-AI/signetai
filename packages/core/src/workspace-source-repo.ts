import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SIGNET_SOURCE_CHECKOUT_DIRNAME = "signetai";
export const SIGNET_SOURCE_REMOTE_URL = "https://github.com/Signet-AI/signetai.git";

const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const SOURCE_REPO_SYNC_LOCK_FILENAME = "source-repo-sync.lock";
const SOURCE_REPO_SYNC_LOCK_STALE_MS = 5 * 60_000;
const SOURCE_REPO_SYNC_LOCK_WAIT_MS = 15_000;

export type WorkspaceSourceRepoStatus = "cloned" | "pulled" | "fetched" | "current" | "skipped" | "error";

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

interface RepoState {
	readonly branch: string | null;
	readonly defaultBranch: string | null;
}

interface SyncLock {
	readonly fd: number;
	readonly path: string;
}

export function resolveWorkspaceSourceRepoPath(
	workspaceDir: string,
	repoDirName = SIGNET_SOURCE_CHECKOUT_DIRNAME,
): string {
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
		return unsafeRemoteResult(repoPath);
	}
	if (!isGitAvailable(timeoutMs)) {
		return gitUnavailableResult(repoPath);
	}

	const lock = acquireSourceRepoSyncLock(workspaceDir, timeoutMs);
	if (lock === null) {
		return syncInProgressResult(repoPath);
	}

	try {
		return syncWorkspaceSourceRepoLocked(workspaceDir, repoPath, remoteUrl, timeoutMs);
	} finally {
		releaseSourceRepoSyncLock(lock);
	}
}

export async function syncWorkspaceSourceRepoAsync(
	workspaceDir: string,
	options: WorkspaceSourceRepoSyncOptions = {},
): Promise<WorkspaceSourceRepoSyncResult> {
	const timeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
	const remoteUrl = options.remoteUrl ?? SIGNET_SOURCE_REMOTE_URL;
	const repoPath = resolveWorkspaceSourceRepoPath(workspaceDir, options.repoDirName);
	if (!isSafeCloneSource(remoteUrl)) {
		return unsafeRemoteResult(repoPath);
	}
	if (!(await isGitAvailableAsync(timeoutMs))) {
		return gitUnavailableResult(repoPath);
	}

	const lock = await acquireSourceRepoSyncLockAsync(workspaceDir);
	if (lock === null) {
		return syncInProgressResult(repoPath);
	}

	try {
		return await syncWorkspaceSourceRepoLockedAsync(workspaceDir, repoPath, remoteUrl, timeoutMs);
	} finally {
		releaseSourceRepoSyncLock(lock);
	}
}

function syncWorkspaceSourceRepoLocked(
	workspaceDir: string,
	repoPath: string,
	remoteUrl: string,
	timeoutMs: number,
): WorkspaceSourceRepoSyncResult {
	if (!existsSync(repoPath) || isEmptyDirectory(repoPath)) {
		mkdirSync(workspaceDir, { recursive: true });
		const clone = runGit(["clone", "--depth", "1", "--", remoteUrl, repoPath], undefined, timeoutMs);
		if (!clone.ok) {
			return errorResult(repoPath, `failed to clone Signet source checkout: ${readGitError(clone)}`);
		}

		const state = readRepoState(repoPath, timeoutMs);
		return clonedResult(repoPath, state);
	}

	if (!hasGitMetadata(repoPath)) {
		return skippedResult(repoPath, "workspace already has a non-git signetai directory, skipped managed checkout sync");
	}

	const state = readRepoState(repoPath, timeoutMs);
	const currentRemote = readOriginRemote(repoPath, timeoutMs);
	if (!currentRemote) {
		return skippedResult(repoPath, "existing Signet source checkout has no origin remote, skipped managed sync", state);
	}

	if (normalizeRemoteUrl(currentRemote) !== normalizeRemoteUrl(remoteUrl)) {
		return skippedResult(repoPath, "existing signetai checkout points at a different remote, left it untouched", state);
	}

	const fetch = runGit(["fetch", "origin", "--prune"], repoPath, timeoutMs);
	if (!fetch.ok) {
		return errorResult(repoPath, `failed to fetch Signet source checkout: ${readGitError(fetch)}`, state);
	}

	return finalizeFetchedRepo(repoPath, state, timeoutMs);
}

async function syncWorkspaceSourceRepoLockedAsync(
	workspaceDir: string,
	repoPath: string,
	remoteUrl: string,
	timeoutMs: number,
): Promise<WorkspaceSourceRepoSyncResult> {
	if (!existsSync(repoPath) || isEmptyDirectory(repoPath)) {
		mkdirSync(workspaceDir, { recursive: true });
		const clone = await runGitAsync(["clone", "--depth", "1", "--", remoteUrl, repoPath], undefined, timeoutMs);
		if (!clone.ok) {
			return errorResult(repoPath, `failed to clone Signet source checkout: ${readGitError(clone)}`);
		}

		const state = await readRepoStateAsync(repoPath, timeoutMs);
		return clonedResult(repoPath, state);
	}

	if (!hasGitMetadata(repoPath)) {
		return skippedResult(repoPath, "workspace already has a non-git signetai directory, skipped managed checkout sync");
	}

	const state = await readRepoStateAsync(repoPath, timeoutMs);
	const currentRemote = await readOriginRemoteAsync(repoPath, timeoutMs);
	if (!currentRemote) {
		return skippedResult(repoPath, "existing Signet source checkout has no origin remote, skipped managed sync", state);
	}

	if (normalizeRemoteUrl(currentRemote) !== normalizeRemoteUrl(remoteUrl)) {
		return skippedResult(repoPath, "existing signetai checkout points at a different remote, left it untouched", state);
	}

	const fetch = await runGitAsync(["fetch", "origin", "--prune"], repoPath, timeoutMs);
	if (!fetch.ok) {
		return errorResult(repoPath, `failed to fetch Signet source checkout: ${readGitError(fetch)}`, state);
	}

	return await finalizeFetchedRepoAsync(repoPath, state, timeoutMs);
}

function finalizeFetchedRepo(repoPath: string, state: RepoState, timeoutMs: number): WorkspaceSourceRepoSyncResult {
	if (state.branch === null) {
		return fetchedResult(
			repoPath,
			"fetched latest Signet source checkout, skipped pull because the repo is in detached HEAD state",
			state,
		);
	}
	if (state.defaultBranch === null) {
		return fetchedResult(
			repoPath,
			"fetched latest Signet source checkout, skipped pull because origin HEAD is unavailable",
			state,
		);
	}
	if (state.branch !== state.defaultBranch) {
		return fetchedResult(
			repoPath,
			`fetched latest Signet source checkout, skipped pull because the current branch is ${state.branch}`,
			state,
		);
	}
	if (isWorkingTreeDirty(repoPath, timeoutMs)) {
		return fetchedResult(
			repoPath,
			"fetched latest Signet source checkout, skipped pull because the working tree has local changes",
			state,
		);
	}

	const upstream = readUpstreamBranch(repoPath, timeoutMs);
	if (upstream !== `origin/${state.defaultBranch}`) {
		return fetchedResult(
			repoPath,
			"fetched latest Signet source checkout, skipped pull because the current branch is not tracking origin",
			state,
		);
	}

	const divergence = readAheadBehind(repoPath, upstream, timeoutMs);
	if (divergence === null) {
		return fetchedResult(
			repoPath,
			"fetched latest Signet source checkout, skipped pull because branch divergence could not be determined",
			state,
		);
	}
	if (divergence.ahead > 0) {
		return fetchedResult(
			repoPath,
			"fetched latest Signet source checkout, skipped pull because the checkout has local commits",
			state,
		);
	}
	if (divergence.behind === 0) {
		return currentResult(repoPath, state);
	}
	if (!isSafeBranchName(state.defaultBranch, timeoutMs)) {
		return fetchedResult(
			repoPath,
			"fetched latest Signet source checkout, skipped pull because origin HEAD resolved to an unsafe branch name",
			state,
		);
	}

	const pull = runGit(
		["merge", "--ff-only", "--no-edit", `refs/remotes/origin/${state.defaultBranch}`],
		repoPath,
		timeoutMs,
	);
	if (!pull.ok) {
		return errorResult(repoPath, `failed to fast-forward Signet source checkout: ${readGitError(pull)}`, state);
	}

	return pulledResult(repoPath, state);
}

async function finalizeFetchedRepoAsync(
	repoPath: string,
	state: RepoState,
	timeoutMs: number,
): Promise<WorkspaceSourceRepoSyncResult> {
	if (state.branch === null) {
		return fetchedResult(
			repoPath,
			"fetched latest Signet source checkout, skipped pull because the repo is in detached HEAD state",
			state,
		);
	}
	if (state.defaultBranch === null) {
		return fetchedResult(
			repoPath,
			"fetched latest Signet source checkout, skipped pull because origin HEAD is unavailable",
			state,
		);
	}
	if (state.branch !== state.defaultBranch) {
		return fetchedResult(
			repoPath,
			`fetched latest Signet source checkout, skipped pull because the current branch is ${state.branch}`,
			state,
		);
	}
	if (await isWorkingTreeDirtyAsync(repoPath, timeoutMs)) {
		return fetchedResult(
			repoPath,
			"fetched latest Signet source checkout, skipped pull because the working tree has local changes",
			state,
		);
	}

	const upstream = await readUpstreamBranchAsync(repoPath, timeoutMs);
	if (upstream !== `origin/${state.defaultBranch}`) {
		return fetchedResult(
			repoPath,
			"fetched latest Signet source checkout, skipped pull because the current branch is not tracking origin",
			state,
		);
	}

	const divergence = await readAheadBehindAsync(repoPath, upstream, timeoutMs);
	if (divergence === null) {
		return fetchedResult(
			repoPath,
			"fetched latest Signet source checkout, skipped pull because branch divergence could not be determined",
			state,
		);
	}
	if (divergence.ahead > 0) {
		return fetchedResult(
			repoPath,
			"fetched latest Signet source checkout, skipped pull because the checkout has local commits",
			state,
		);
	}
	if (divergence.behind === 0) {
		return currentResult(repoPath, state);
	}
	if (!(await isSafeBranchNameAsync(state.defaultBranch, timeoutMs))) {
		return fetchedResult(
			repoPath,
			"fetched latest Signet source checkout, skipped pull because origin HEAD resolved to an unsafe branch name",
			state,
		);
	}

	const pull = await runGitAsync(
		["merge", "--ff-only", "--no-edit", `refs/remotes/origin/${state.defaultBranch}`],
		repoPath,
		timeoutMs,
	);
	if (!pull.ok) {
		return errorResult(repoPath, `failed to fast-forward Signet source checkout: ${readGitError(pull)}`, state);
	}

	return pulledResult(repoPath, state);
}

function isGitAvailable(timeoutMs: number): boolean {
	return runGit(["--version"], undefined, timeoutMs).ok;
}

async function isGitAvailableAsync(timeoutMs: number): Promise<boolean> {
	return (await runGitAsync(["--version"], undefined, timeoutMs)).ok;
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

async function runGitAsync(
	args: readonly string[],
	cwd: string | undefined,
	timeoutMs: number,
): Promise<GitCommandResult> {
	return await new Promise((resolve) => {
		const proc = spawn("git", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			proc.kill("SIGKILL");
			resolve({
				ok: false,
				stdout,
				stderr,
				exitCode: null,
				errorCode: "TIMEOUT",
			});
		}, timeoutMs);

		proc.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});
		proc.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});
		proc.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				ok: false,
				stdout,
				stderr,
				exitCode: null,
				errorCode: readErrorCode(error),
			});
		});
		proc.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				ok: code === 0,
				stdout,
				stderr,
				exitCode: code,
				errorCode: null,
			});
		});
	});
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

function readRepoState(repoPath: string, timeoutMs: number): RepoState {
	return {
		branch: readCurrentBranch(repoPath, timeoutMs),
		defaultBranch: readDefaultBranch(repoPath, timeoutMs),
	};
}

async function readRepoStateAsync(repoPath: string, timeoutMs: number): Promise<RepoState> {
	return {
		branch: await readCurrentBranchAsync(repoPath, timeoutMs),
		defaultBranch: await readDefaultBranchAsync(repoPath, timeoutMs),
	};
}

function readOriginRemote(repoPath: string, timeoutMs: number): string | null {
	const result = runGit(["config", "--get", "remote.origin.url"], repoPath, timeoutMs);
	if (!result.ok) {
		return null;
	}

	const value = result.stdout.trim();
	return value.length > 0 ? value : null;
}

async function readOriginRemoteAsync(repoPath: string, timeoutMs: number): Promise<string | null> {
	const result = await runGitAsync(["config", "--get", "remote.origin.url"], repoPath, timeoutMs);
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

async function readCurrentBranchAsync(repoPath: string, timeoutMs: number): Promise<string | null> {
	const result = await runGitAsync(["branch", "--show-current"], repoPath, timeoutMs);
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

async function readDefaultBranchAsync(repoPath: string, timeoutMs: number): Promise<string | null> {
	const result = await runGitAsync(
		["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
		repoPath,
		timeoutMs,
	);
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

async function isWorkingTreeDirtyAsync(repoPath: string, timeoutMs: number): Promise<boolean> {
	const result = await runGitAsync(["status", "--porcelain", "--ignore-submodules=all"], repoPath, timeoutMs);
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

async function readUpstreamBranchAsync(repoPath: string, timeoutMs: number): Promise<string | null> {
	const result = await runGitAsync(
		["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
		repoPath,
		timeoutMs,
	);
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

	return parseAheadBehind(result.stdout);
}

async function readAheadBehindAsync(
	repoPath: string,
	upstream: string,
	timeoutMs: number,
): Promise<AheadBehind | null> {
	const result = await runGitAsync(["rev-list", "--left-right", "--count", `HEAD...${upstream}`], repoPath, timeoutMs);
	if (!result.ok) {
		return null;
	}

	return parseAheadBehind(result.stdout);
}

function parseAheadBehind(value: string): AheadBehind | null {
	const match = /^(\d+)\s+(\d+)$/.exec(value.trim());
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

async function isSafeBranchNameAsync(branch: string, timeoutMs: number): Promise<boolean> {
	if (branch.length === 0 || branch.startsWith("-")) {
		return false;
	}

	return (await runGitAsync(["check-ref-format", "--branch", branch], undefined, timeoutMs)).ok;
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

	if (result.errorCode === "TIMEOUT") {
		return `timed out after ${DEFAULT_GIT_TIMEOUT_MS}ms`;
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

function sourceRepoSyncLockPath(workspaceDir: string): string {
	return join(resolve(workspaceDir), ".daemon", SOURCE_REPO_SYNC_LOCK_FILENAME);
}

function clearStaleSourceRepoSyncLock(path: string): boolean {
	try {
		const age = Date.now() - statSync(path).mtimeMs;
		if (age > SOURCE_REPO_SYNC_LOCK_STALE_MS) {
			rmSync(path, { force: true });
			return true;
		}
	} catch {
		return false;
	}

	return false;
}

function acquireSourceRepoSyncLock(workspaceDir: string, timeoutMs: number): SyncLock | null {
	const path = sourceRepoSyncLockPath(workspaceDir);
	mkdirSync(join(resolve(workspaceDir), ".daemon"), { recursive: true });
	const end = Date.now() + Math.min(timeoutMs, SOURCE_REPO_SYNC_LOCK_WAIT_MS);

	while (Date.now() < end) {
		try {
			const fd = openSync(path, "wx");
			writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
			return { fd, path };
		} catch (err) {
			const code = err instanceof Error && "code" in err ? String(err.code) : "";
			if (code !== "EEXIST") {
				return null;
			}
		}

		if (clearStaleSourceRepoSyncLock(path)) {
			// lock cleared, retry immediately
		}
	}

	return null;
}

async function acquireSourceRepoSyncLockAsync(workspaceDir: string): Promise<SyncLock | null> {
	const path = sourceRepoSyncLockPath(workspaceDir);
	mkdirSync(join(resolve(workspaceDir), ".daemon"), { recursive: true });
	const end = Date.now() + SOURCE_REPO_SYNC_LOCK_WAIT_MS;

	while (Date.now() < end) {
		try {
			const fd = openSync(path, "wx");
			writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
			return { fd, path };
		} catch (err) {
			const code = err instanceof Error && "code" in err ? String(err.code) : "";
			if (code !== "EEXIST") {
				return null;
			}
		}

		if (clearStaleSourceRepoSyncLock(path)) {
			continue;
		}

		await sleep(200);
	}

	return null;
}

function releaseSourceRepoSyncLock(lock: SyncLock): void {
	try {
		closeSync(lock.fd);
	} catch {
		// Ignore.
	}
	rmSync(lock.path, { force: true });
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function unsafeRemoteResult(repoPath: string): WorkspaceSourceRepoSyncResult {
	return {
		status: "error",
		path: repoPath,
		message: "failed to clone Signet source checkout: remote URL is not a safe git source",
		branch: null,
		defaultBranch: null,
	};
}

function gitUnavailableResult(repoPath: string): WorkspaceSourceRepoSyncResult {
	return {
		status: "skipped",
		path: repoPath,
		message: "git is not available, skipped Signet source checkout sync",
		branch: null,
		defaultBranch: null,
	};
}

function syncInProgressResult(repoPath: string): WorkspaceSourceRepoSyncResult {
	return {
		status: "skipped",
		path: repoPath,
		message: "source checkout sync already in progress, skipped duplicate run",
		branch: null,
		defaultBranch: null,
	};
}

function skippedResult(repoPath: string, message: string, state?: RepoState): WorkspaceSourceRepoSyncResult {
	return {
		status: "skipped",
		path: repoPath,
		message,
		branch: state?.branch ?? null,
		defaultBranch: state?.defaultBranch ?? null,
	};
}

function fetchedResult(repoPath: string, message: string, state: RepoState): WorkspaceSourceRepoSyncResult {
	return {
		status: "fetched",
		path: repoPath,
		message,
		branch: state.branch,
		defaultBranch: state.defaultBranch,
	};
}

function errorResult(repoPath: string, message: string, state?: RepoState): WorkspaceSourceRepoSyncResult {
	return {
		status: "error",
		path: repoPath,
		message,
		branch: state?.branch ?? null,
		defaultBranch: state?.defaultBranch ?? null,
	};
}

function clonedResult(repoPath: string, state: RepoState): WorkspaceSourceRepoSyncResult {
	return {
		status: "cloned",
		path: repoPath,
		message: "cloned Signet source checkout",
		branch: state.branch,
		defaultBranch: state.defaultBranch,
	};
}

function pulledResult(repoPath: string, state: RepoState): WorkspaceSourceRepoSyncResult {
	return {
		status: "pulled",
		path: repoPath,
		message: "pulled latest Signet source checkout",
		branch: state.branch,
		defaultBranch: state.defaultBranch,
	};
}

function currentResult(repoPath: string, state: RepoState): WorkspaceSourceRepoSyncResult {
	return {
		status: "current",
		path: repoPath,
		message: "Signet source checkout is already current",
		branch: state.branch,
		defaultBranch: state.defaultBranch,
	};
}
