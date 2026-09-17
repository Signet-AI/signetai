import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnHidden, spawnSyncHidden, type SpawnSyncReturns } from "./child-process";

export const SIGNET_SOURCE_CHECKOUT_DIRNAME = "signetai";
export const SIGNET_SOURCE_REMOTE_URL = "https://github.com/Signet-AI/signetai.git";

const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const SOURCE_REPO_SYNC_LOCK_FILENAME = "source-repo-sync.lock";
const SOURCE_REPO_SYNC_LOCK_STALE_MS = 5 * 60_000;
const SOURCE_REPO_SYNC_LOCK_WAIT_MS = 15_000;
const SOURCE_REPO_AUTOSTASH_PREFIX = "signet-source-autostash";

export type WorkspaceSourceRepoStatus = "cloned" | "pulled" | "fetched" | "current" | "skipped" | "error";
export type WorkspaceSourceRepoLocalChanges = "none" | "generated-only" | "left-in-place" | "stashed";

export interface WorkspaceSourceRepoSyncOptions {
	/** Only explicit source builds may create a checkout; routine sync updates existing repositories. */
	readonly cloneIfMissing?: boolean;
	readonly gitTimeoutMs?: number;
	/** Preserve user-owned local changes in a verified Git stash before updating. */
	readonly localChanges?: "skip" | "stash";
	readonly remoteUrl?: string;
	readonly repoDirName?: string;
}

export interface WorkspaceSourceRepoSyncResult {
	readonly status: WorkspaceSourceRepoStatus;
	readonly path: string;
	readonly message: string;
	readonly branch: string | null;
	readonly defaultBranch: string | null;
	readonly localChanges?: WorkspaceSourceRepoLocalChanges;
	readonly stashRef?: string;
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

type SyncLockAttempt =
	| { readonly status: "acquired"; readonly lock: SyncLock }
	| { readonly status: "busy" }
	| { readonly status: "error"; readonly message: string };

type WorkspaceDirEnsureResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

interface WorkingTreeStatus {
	readonly statusReadable: boolean;
	readonly hasUserChanges: boolean;
	readonly hasGeneratedChanges: boolean;
	readonly hasUnmergedChanges: boolean;
	readonly userPaths: readonly string[];
}

interface LocalChangesMetadata {
	readonly localChanges: WorkspaceSourceRepoLocalChanges;
	readonly stashRef?: string;
}

type AutoStashResult =
	| { readonly ok: true; readonly stashRef: string }
	| { readonly ok: false; readonly message: string; readonly stashRef?: string };

type LocalChangesPreparation =
	| { readonly ok: true; readonly metadata: LocalChangesMetadata }
	| { readonly ok: false; readonly message: string; readonly metadata?: LocalChangesMetadata };

type MaybePromise<T> = T | Promise<T>;
type GitRunner = (
	args: readonly string[],
	cwd: string | undefined,
	timeoutMs: number,
) => MaybePromise<GitCommandResult>;

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
	const clone = options.cloneIfMissing === true;
	const timeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
	const remoteUrl = options.remoteUrl ?? SIGNET_SOURCE_REMOTE_URL;
	const repoPath = resolveWorkspaceSourceRepoPath(workspaceDir, options.repoDirName);
	if (!isSafeCloneSource(remoteUrl)) {
		return unsafeRemoteResult(repoPath);
	}
	if (!clone && !existsSync(repoPath)) return missingCheckoutResult(repoPath);
	if (!isGitAvailable(timeoutMs)) {
		return gitUnavailableResult(repoPath);
	}

	const lock = acquireSourceRepoSyncLock(workspaceDir);
	if (lock.status === "busy") {
		return syncInProgressResult(repoPath);
	}
	if (lock.status === "error") {
		return sourceRepoSyncLockErrorResult(repoPath, lock.message);
	}

	try {
		return syncWorkspaceSourceRepoLocked(
			runGit,
			workspaceDir,
			repoPath,
			remoteUrl,
			timeoutMs,
			clone,
			options.localChanges ?? "skip",
		);
	} finally {
		releaseSourceRepoSyncLock(lock.lock);
	}
}

export async function syncWorkspaceSourceRepoAsync(
	workspaceDir: string,
	options: WorkspaceSourceRepoSyncOptions = {},
): Promise<WorkspaceSourceRepoSyncResult> {
	const clone = options.cloneIfMissing === true;
	const timeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
	const remoteUrl = options.remoteUrl ?? SIGNET_SOURCE_REMOTE_URL;
	const repoPath = resolveWorkspaceSourceRepoPath(workspaceDir, options.repoDirName);
	if (!isSafeCloneSource(remoteUrl)) {
		return unsafeRemoteResult(repoPath);
	}
	if (!clone && !existsSync(repoPath)) return missingCheckoutResult(repoPath);
	if (!(await isGitAvailableAsync(timeoutMs))) {
		return gitUnavailableResult(repoPath);
	}

	const lock = await acquireSourceRepoSyncLockAsync(workspaceDir);
	if (lock.status === "busy") {
		return syncInProgressResult(repoPath);
	}
	if (lock.status === "error") {
		return sourceRepoSyncLockErrorResult(repoPath, lock.message);
	}

	try {
		return await syncWorkspaceSourceRepoLocked(
			runGitAsync,
			workspaceDir,
			repoPath,
			remoteUrl,
			timeoutMs,
			clone,
			options.localChanges ?? "skip",
		);
	} finally {
		releaseSourceRepoSyncLock(lock.lock);
	}
}

function syncWorkspaceSourceRepoLocked(
	run: typeof runGit,
	workspaceDir: string,
	repoPath: string,
	remoteUrl: string,
	timeoutMs: number,
	cloneIfMissing: boolean,
	localChanges: "skip" | "stash",
): WorkspaceSourceRepoSyncResult;
function syncWorkspaceSourceRepoLocked(
	run: typeof runGitAsync,
	workspaceDir: string,
	repoPath: string,
	remoteUrl: string,
	timeoutMs: number,
	cloneIfMissing: boolean,
	localChanges: "skip" | "stash",
): Promise<WorkspaceSourceRepoSyncResult>;
function syncWorkspaceSourceRepoLocked(
	run: GitRunner,
	workspaceDir: string,
	repoPath: string,
	remoteUrl: string,
	timeoutMs: number,
	cloneIfMissing: boolean,
	localChanges: "skip" | "stash",
): MaybePromise<WorkspaceSourceRepoSyncResult> {
	if (!existsSync(repoPath) || isEmptyDirectory(repoPath)) {
		if (!cloneIfMissing) return missingCheckoutResult(repoPath);
		const workspaceReady = ensureWorkspaceDir(workspaceDir);
		if (workspaceReady.ok === false) {
			return errorResult(repoPath, workspaceReady.message);
		}
		return mapToSyncResult(run(["clone", "--depth", "1", "--", remoteUrl, repoPath], undefined, timeoutMs), (clone) => {
			if (!clone.ok) {
				return errorResult(repoPath, `failed to clone Signet source checkout: ${readGitError(clone, timeoutMs)}`);
			}

			return mapToSyncResult(readRepoStateWith(run, repoPath, timeoutMs), (state) => clonedResult(repoPath, state));
		});
	}

	if (!hasGitMetadata(repoPath)) {
		return skippedResult(repoPath, "workspace already has a non-git signetai directory, skipped managed checkout sync");
	}

	return mapToSyncResult(readRepoStateWith(run, repoPath, timeoutMs), (state) =>
		mapToSyncResult(readOriginRemoteWith(run, repoPath, timeoutMs), (currentRemote) => {
			if (!currentRemote) {
				return skippedResult(
					repoPath,
					"existing Signet source checkout has no origin remote, skipped managed sync",
					state,
				);
			}

			if (normalizeRemoteUrl(currentRemote) !== normalizeRemoteUrl(remoteUrl)) {
				return skippedResult(
					repoPath,
					"existing signetai checkout points at a different remote, left it untouched",
					state,
				);
			}

			return mapToSyncResult(run(["fetch", "origin", "--prune"], repoPath, timeoutMs), (fetch) => {
				if (!fetch.ok) {
					return errorResult(
						repoPath,
						`failed to fetch Signet source checkout: ${readGitError(fetch, timeoutMs)}`,
						state,
					);
				}

				return finalizeFetchedRepoWith(run, repoPath, state, timeoutMs, localChanges);
			});
		}),
	);
}

function finalizeFetchedRepoWith(
	run: GitRunner,
	repoPath: string,
	state: RepoState,
	timeoutMs: number,
	localChangesMode: "skip" | "stash",
): MaybePromise<WorkspaceSourceRepoSyncResult> {
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
	return flatMapMaybePromise(readWorkingTreeStatusWith(run, repoPath, timeoutMs), (workingTree) => {
		const generatedOnlyMetadata: LocalChangesMetadata = {
			localChanges: workingTree.hasGeneratedChanges ? "generated-only" : "none",
		};
		const localChangesMetadata: LocalChangesMetadata = {
			localChanges: workingTree.hasUserChanges ? "left-in-place" : generatedOnlyMetadata.localChanges,
		};

		if (!workingTree.hasUserChanges) {
			return continueFetchedRepoWith(run, repoPath, state, timeoutMs, generatedOnlyMetadata);
		}

		if (localChangesMode !== "stash") {
			return fetchedResult(
				repoPath,
				"fetched latest Signet source checkout, skipped pull because the working tree has local changes",
				state,
				{ localChanges: "left-in-place" },
			);
		}

		if (workingTree.hasUnmergedChanges) {
			return fetchedResult(
				repoPath,
				"fetched latest Signet source checkout, skipped pull because the working tree has unresolved merge conflicts",
				state,
				{ localChanges: "left-in-place" },
			);
		}

		if (!workingTree.statusReadable) {
			return errorResult(
				repoPath,
				"could not safely inspect the working tree before creating an automatic stash",
				state,
				localChangesMetadata,
			);
		}

		return continueFetchedRepoWith(run, repoPath, state, timeoutMs, localChangesMetadata, () =>
			prepareLocalChangesForUpdateWith(run, repoPath, timeoutMs, workingTree.userPaths),
		);
	});
}

function continueFetchedRepoWith(
	run: GitRunner,
	repoPath: string,
	state: RepoState,
	timeoutMs: number,
	metadata: LocalChangesMetadata,
	prepareForUpdate?: () => MaybePromise<LocalChangesPreparation>,
): MaybePromise<WorkspaceSourceRepoSyncResult> {
	const defaultBranch = state.defaultBranch;
	if (defaultBranch === null) {
		return fetchedResult(
			repoPath,
			"fetched latest Signet source checkout, skipped pull because origin HEAD is unavailable",
			state,
			metadata,
		);
	}

	return flatMapMaybePromise(readUpstreamBranchWith(run, repoPath, timeoutMs), (upstream) => {
		if (upstream !== `origin/${defaultBranch}`) {
			return fetchedResult(
				repoPath,
				"fetched latest Signet source checkout, skipped pull because the current branch is not tracking origin",
				state,
				metadata,
			);
		}

		return flatMapMaybePromise(readAheadBehindWith(run, repoPath, upstream, timeoutMs), (divergence) => {
			if (divergence === null) {
				return fetchedResult(
					repoPath,
					"fetched latest Signet source checkout, skipped pull because branch divergence could not be determined",
					state,
					metadata,
				);
			}
			if (divergence.ahead > 0) {
				return fetchedResult(
					repoPath,
					"fetched latest Signet source checkout, skipped pull because the checkout has local commits",
					state,
					metadata,
				);
			}
			if (divergence.behind === 0) {
				return currentResult(repoPath, state, metadata);
			}

			return flatMapMaybePromise(isSafeBranchNameWith(run, defaultBranch, timeoutMs), (safeBranchName) => {
				if (!safeBranchName) {
					return fetchedResult(
						repoPath,
						"fetched latest Signet source checkout, skipped pull because origin HEAD resolved to an unsafe branch name",
						state,
						metadata,
					);
				}

				const fastForward = (preparedMetadata: LocalChangesMetadata): MaybePromise<WorkspaceSourceRepoSyncResult> =>
					flatMapMaybePromise(
						run(["merge", "--ff-only", "--no-edit", `refs/remotes/origin/${defaultBranch}`], repoPath, timeoutMs),
						(pull) => {
							if (!pull.ok) {
								return errorResult(
									repoPath,
									`failed to fast-forward Signet source checkout: ${readGitError(pull, timeoutMs)}`,
									state,
									preparedMetadata,
								);
							}

							return pulledResult(repoPath, state, preparedMetadata);
						},
					);

				if (!prepareForUpdate) return fastForward(metadata);
				return flatMapMaybePromise(prepareForUpdate(), (preparation) => {
					if (preparation.ok === false) {
						return errorResult(repoPath, preparation.message, state, preparation.metadata ?? metadata);
					}
					return fastForward(preparation.metadata);
				});
			});
		});
	});
}

function prepareLocalChangesForUpdateWith(
	run: GitRunner,
	repoPath: string,
	timeoutMs: number,
	userPaths: readonly string[],
): MaybePromise<LocalChangesPreparation> {
	return flatMapMaybePromise(createAutoStashWith(run, repoPath, timeoutMs, userPaths), (stash) => {
		if (stash.ok === false) {
			return {
				ok: false,
				message: `failed to preserve local changes before updating Signet source checkout: ${stash.message}`,
				...(stash.stashRef ? { metadata: { localChanges: "stashed", stashRef: stash.stashRef } } : {}),
			};
		}

		const stashedMetadata: LocalChangesMetadata = {
			localChanges: "stashed",
			stashRef: stash.stashRef,
		};
		return flatMapMaybePromise(readWorkingTreeStatusWith(run, repoPath, timeoutMs), (afterStash) => {
			if (!afterStash.statusReadable || afterStash.hasUserChanges) {
				return {
					ok: false,
					message: `verified local-change stash ${stash.stashRef} did not leave the source checkout clean; the stash was kept`,
					metadata: stashedMetadata,
				};
			}

			return { ok: true, metadata: stashedMetadata };
		});
	});
}

function isGitAvailable(timeoutMs: number): boolean {
	return runGit(["--version"], undefined, timeoutMs).ok;
}

async function isGitAvailableAsync(timeoutMs: number): Promise<boolean> {
	return (await runGitAsync(["--version"], undefined, timeoutMs)).ok;
}

function runGit(args: readonly string[], cwd: string | undefined, timeoutMs: number): GitCommandResult {
	const result: SpawnSyncReturns<string> = spawnSyncHidden("git", args, {
		cwd,
		encoding: "utf-8",
		timeout: timeoutMs,
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
		const proc = spawnHidden("git", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let killTimer: ReturnType<typeof setTimeout> | null = null;
		let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
		const finish = (result: GitCommandResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (fallbackTimer) clearTimeout(fallbackTimer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			stderr += `\ngit ${args.join(" ")} timed out after ${timeoutMs}ms`;
			killGitProcessTree(proc, "SIGTERM");
			killTimer = setTimeout(() => killGitProcessTree(proc, "SIGKILL"), 1_000);
			killTimer.unref?.();
			fallbackTimer = setTimeout(
				() => finish({ ok: false, stdout, stderr, exitCode: null, errorCode: "TIMEOUT" }),
				3_000,
			);
			fallbackTimer.unref?.();
		}, timeoutMs);
		timer.unref?.();

		proc.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});
		proc.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});
		proc.on("error", (error) => {
			finish({
				ok: false,
				stdout,
				stderr,
				exitCode: null,
				errorCode: readErrorCode(error),
			});
		});
		proc.on("close", (code) => {
			finish({
				ok: code === 0,
				stdout,
				stderr,
				exitCode: code,
				errorCode: null,
			});
		});
	});
}

function killGitProcessTree(proc: ReturnType<typeof spawnHidden>, signal: NodeJS.Signals): void {
	try {
		if (process.platform !== "win32" && proc.pid) {
			process.kill(-proc.pid, signal);
			return;
		}
		proc.kill(signal);
	} catch {
		// Best effort.
	}
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

function readGitError(result: GitCommandResult, timeoutMs: number): string {
	const stderr = result.stderr.trim();
	if (stderr.length > 0) {
		return stderr;
	}

	const stdout = result.stdout.trim();
	if (stdout.length > 0) {
		return stdout;
	}

	if (result.errorCode === "TIMEOUT") {
		return `timed out after ${timeoutMs}ms`;
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

function acquireSourceRepoSyncLock(workspaceDir: string): SyncLockAttempt {
	const path = sourceRepoSyncLockPath(workspaceDir);
	const daemonDirReady = ensureDaemonDir(workspaceDir);
	if (daemonDirReady.ok === false) {
		return { status: "error", message: daemonDirReady.message };
	}
	const immediate = tryAcquireSourceRepoSyncLock(path);
	if (immediate.status === "acquired") {
		return immediate;
	}
	if (immediate.status === "error") {
		return immediate;
	}
	if (clearStaleSourceRepoSyncLock(path)) {
		return tryAcquireSourceRepoSyncLock(path);
	}
	return { status: "busy" };
}

async function acquireSourceRepoSyncLockAsync(workspaceDir: string): Promise<SyncLockAttempt> {
	const path = sourceRepoSyncLockPath(workspaceDir);
	const daemonDirReady = ensureDaemonDir(workspaceDir);
	if (daemonDirReady.ok === false) {
		return { status: "error", message: daemonDirReady.message };
	}
	const end = Date.now() + SOURCE_REPO_SYNC_LOCK_WAIT_MS;

	while (Date.now() < end) {
		try {
			const fd = openSync(path, "wx");
			writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
			return { status: "acquired", lock: { fd, path } };
		} catch (err) {
			const code = err instanceof Error && "code" in err ? String(err.code) : "";
			if (code !== "EEXIST") {
				return { status: "error", message: code || "unknown lock error" };
			}
		}

		if (clearStaleSourceRepoSyncLock(path)) {
			continue;
		}

		await sleep(200);
	}

	return { status: "busy" };
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

function missingCheckoutResult(repoPath: string): WorkspaceSourceRepoSyncResult {
	return {
		status: "skipped",
		path: repoPath,
		message: "No Signet source checkout; source builds can create one explicitly",
		branch: null,
		defaultBranch: null,
	};
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

function sourceRepoSyncLockErrorResult(repoPath: string, detail: string): WorkspaceSourceRepoSyncResult {
	return {
		status: "error",
		path: repoPath,
		message: `failed to acquire source checkout sync lock: ${detail}`,
		branch: null,
		defaultBranch: null,
	};
}

function ensureDaemonDir(workspaceDir: string): WorkspaceDirEnsureResult {
	const daemonDir = join(resolve(workspaceDir), ".daemon");
	try {
		mkdirSync(daemonDir, { recursive: true });
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			message: readFsError("failed to prepare source checkout sync lock directory", err),
		};
	}
}

function ensureWorkspaceDir(workspaceDir: string): WorkspaceDirEnsureResult {
	try {
		mkdirSync(workspaceDir, { recursive: true });
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			message: readFsError("failed to prepare workspace for Signet source checkout", err),
		};
	}
}

function readFsError(prefix: string, err: unknown): string {
	return `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
}

const NO_LOCAL_CHANGES: LocalChangesMetadata = { localChanges: "none" };

function skippedResult(repoPath: string, message: string, state?: RepoState): WorkspaceSourceRepoSyncResult {
	return {
		status: "skipped",
		path: repoPath,
		message,
		branch: state?.branch ?? null,
		defaultBranch: state?.defaultBranch ?? null,
	};
}

function fetchedResult(
	repoPath: string,
	message: string,
	state: RepoState,
	metadata: LocalChangesMetadata = NO_LOCAL_CHANGES,
): WorkspaceSourceRepoSyncResult {
	return {
		status: "fetched",
		path: repoPath,
		message: addLocalChangesMessage(message, metadata),
		branch: state.branch,
		defaultBranch: state.defaultBranch,
		...localChangesFields(metadata),
	};
}

function errorResult(
	repoPath: string,
	message: string,
	state?: RepoState,
	metadata: LocalChangesMetadata = NO_LOCAL_CHANGES,
): WorkspaceSourceRepoSyncResult {
	return {
		status: "error",
		path: repoPath,
		message: addLocalChangesMessage(message, metadata),
		branch: state?.branch ?? null,
		defaultBranch: state?.defaultBranch ?? null,
		...localChangesFields(metadata),
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

function pulledResult(
	repoPath: string,
	state: RepoState,
	metadata: LocalChangesMetadata = NO_LOCAL_CHANGES,
): WorkspaceSourceRepoSyncResult {
	return {
		status: "pulled",
		path: repoPath,
		message: addLocalChangesMessage("pulled latest Signet source checkout", metadata),
		branch: state.branch,
		defaultBranch: state.defaultBranch,
		...localChangesFields(metadata),
	};
}

function currentResult(
	repoPath: string,
	state: RepoState,
	metadata: LocalChangesMetadata = NO_LOCAL_CHANGES,
): WorkspaceSourceRepoSyncResult {
	return {
		status: "current",
		path: repoPath,
		message: addLocalChangesMessage("Signet source checkout is already current", metadata),
		branch: state.branch,
		defaultBranch: state.defaultBranch,
		...localChangesFields(metadata),
	};
}

function localChangesFields(metadata: LocalChangesMetadata): {
	readonly localChanges?: WorkspaceSourceRepoLocalChanges;
	readonly stashRef?: string;
} {
	if (metadata.localChanges === "none") return {};
	return {
		localChanges: metadata.localChanges,
		...(metadata.stashRef ? { stashRef: metadata.stashRef } : {}),
	};
}

function addLocalChangesMessage(message: string, metadata: LocalChangesMetadata): string {
	if (metadata.localChanges === "stashed" && metadata.stashRef) {
		return `${message}; local changes were preserved in stash ${metadata.stashRef}`;
	}
	if (metadata.localChanges === "generated-only") {
		return `${message}; generated build artifacts were left in place`;
	}
	if (metadata.localChanges === "left-in-place") {
		return `${message}; local changes were left in place`;
	}
	return message;
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
	return typeof value === "object" && value !== null && "then" in value;
}

function mapMaybePromise<T, U>(value: MaybePromise<T>, map: (value: T) => U): MaybePromise<U> {
	return isPromiseLike(value) ? value.then(map) : map(value);
}

function flatMapMaybePromise<T, U>(value: MaybePromise<T>, map: (value: T) => MaybePromise<U>): MaybePromise<U> {
	return isPromiseLike(value) ? value.then(map) : map(value);
}

function mapToSyncResult<T>(
	value: MaybePromise<T>,
	map: (value: T) => WorkspaceSourceRepoSyncResult | MaybePromise<WorkspaceSourceRepoSyncResult>,
): MaybePromise<WorkspaceSourceRepoSyncResult> {
	if (isPromiseLike(value)) {
		return value.then(async (resolved) => await map(resolved));
	}
	return map(value);
}

function readRepoStateWith(run: typeof runGit, repoPath: string, timeoutMs: number): RepoState;
function readRepoStateWith(run: typeof runGitAsync, repoPath: string, timeoutMs: number): Promise<RepoState>;
function readRepoStateWith(run: GitRunner, repoPath: string, timeoutMs: number): MaybePromise<RepoState>;
function readRepoStateWith(run: GitRunner, repoPath: string, timeoutMs: number): MaybePromise<RepoState> {
	const branch = readCurrentBranchWith(run, repoPath, timeoutMs);
	if (isPromiseLike(branch)) {
		return branch.then(async (resolvedBranch) => ({
			branch: resolvedBranch,
			defaultBranch: await readDefaultBranchWith(run, repoPath, timeoutMs),
		}));
	}
	return mapMaybePromise(readDefaultBranchWith(run, repoPath, timeoutMs), (defaultBranch) => ({
		branch,
		defaultBranch,
	}));
}

function readOriginRemoteWith(run: typeof runGit, repoPath: string, timeoutMs: number): string | null;
function readOriginRemoteWith(run: typeof runGitAsync, repoPath: string, timeoutMs: number): Promise<string | null>;
function readOriginRemoteWith(run: GitRunner, repoPath: string, timeoutMs: number): MaybePromise<string | null>;
function readOriginRemoteWith(run: GitRunner, repoPath: string, timeoutMs: number): MaybePromise<string | null> {
	return mapMaybePromise(run(["config", "--get", "remote.origin.url"], repoPath, timeoutMs), (result) =>
		readTrimmedValue(result),
	);
}

function readCurrentBranchWith(run: typeof runGit, repoPath: string, timeoutMs: number): string | null;
function readCurrentBranchWith(run: typeof runGitAsync, repoPath: string, timeoutMs: number): Promise<string | null>;
function readCurrentBranchWith(run: GitRunner, repoPath: string, timeoutMs: number): MaybePromise<string | null>;
function readCurrentBranchWith(run: GitRunner, repoPath: string, timeoutMs: number): MaybePromise<string | null> {
	return mapMaybePromise(run(["branch", "--show-current"], repoPath, timeoutMs), (result) => readTrimmedValue(result));
}

function readDefaultBranchWith(run: typeof runGit, repoPath: string, timeoutMs: number): string | null;
function readDefaultBranchWith(run: typeof runGitAsync, repoPath: string, timeoutMs: number): Promise<string | null>;
function readDefaultBranchWith(run: GitRunner, repoPath: string, timeoutMs: number): MaybePromise<string | null>;
function readDefaultBranchWith(run: GitRunner, repoPath: string, timeoutMs: number): MaybePromise<string | null> {
	return mapMaybePromise(
		run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoPath, timeoutMs),
		(result) => {
			if (!result.ok) {
				return null;
			}

			const value = result.stdout.trim();
			if (!value.startsWith("origin/")) {
				return null;
			}

			const branch = value.slice("origin/".length);
			return branch.length > 0 ? branch : null;
		},
	);
}

function readWorkingTreeStatusWith(run: typeof runGit, repoPath: string, timeoutMs: number): WorkingTreeStatus;
function readWorkingTreeStatusWith(
	run: typeof runGitAsync,
	repoPath: string,
	timeoutMs: number,
): Promise<WorkingTreeStatus>;
function readWorkingTreeStatusWith(
	run: GitRunner,
	repoPath: string,
	timeoutMs: number,
): MaybePromise<WorkingTreeStatus>;
function readWorkingTreeStatusWith(
	run: GitRunner,
	repoPath: string,
	timeoutMs: number,
): MaybePromise<WorkingTreeStatus> {
	return mapMaybePromise(
		run(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=all"], repoPath, timeoutMs),
		(result) => {
			if (!result.ok) {
				return {
					statusReadable: false,
					hasUserChanges: true,
					hasGeneratedChanges: false,
					hasUnmergedChanges: false,
					userPaths: [],
				};
			}

			let statusReadable = true;
			let hasUserChanges = false;
			let hasGeneratedChanges = false;
			let hasUnmergedChanges = false;
			const userPaths: string[] = [];
			for (const line of result.stdout
				.split("\n")
				.map((line) => line.trimEnd())
				.filter((line) => line.length > 0)) {
				if (isUnmergedStatusLine(line)) {
					hasUnmergedChanges = true;
					hasUserChanges = true;
					continue;
				}
				if (isGeneratedSourceRepoStatusLine(line)) {
					hasGeneratedChanges = true;
					continue;
				}
				hasUserChanges = true;
				const path = parsePorcelainStatusPath(line);
				if (path) {
					userPaths.push(path);
				} else {
					statusReadable = false;
				}
			}

			return { statusReadable, hasUserChanges, hasGeneratedChanges, hasUnmergedChanges, userPaths };
		},
	);
}

const GENERATED_SOURCE_REPO_PATH_PREFIXES = [
	"dist/signetai/dashboard/",
	"dist/signetai/dist/",
	"dist/signetai/hermes-plugin/",
	"dist/signetai/node_modules/",
	"dist/signetai/skills/",
	"surfaces/desktop/dist/",
	"surfaces/desktop/release/",
	"surfaces/desktop/resources/",
];

const GENERATED_SOURCE_REPO_PATH_PATTERNS = [/^platform\/daemon\/anydoc\.[^/]+\.node$/];

function isGeneratedSourceRepoStatusLine(line: string): boolean {
	const path = parsePorcelainStatusPath(line);
	if (!path) return false;
	return (
		GENERATED_SOURCE_REPO_PATH_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix)) ||
		GENERATED_SOURCE_REPO_PATH_PATTERNS.some((pattern) => pattern.test(path))
	);
}

function isUnmergedStatusLine(line: string): boolean {
	if (line.length < 2) return false;
	const indexStatus = line[0];
	const worktreeStatus = line[1];
	return (
		indexStatus === "U" ||
		worktreeStatus === "U" ||
		(indexStatus === "A" && worktreeStatus === "A") ||
		(indexStatus === "D" && worktreeStatus === "D")
	);
}

function createAutoStashWith(
	run: typeof runGit,
	repoPath: string,
	timeoutMs: number,
	userPaths: readonly string[],
): AutoStashResult;
function createAutoStashWith(
	run: typeof runGitAsync,
	repoPath: string,
	timeoutMs: number,
	userPaths: readonly string[],
): Promise<AutoStashResult>;
function createAutoStashWith(
	run: GitRunner,
	repoPath: string,
	timeoutMs: number,
	userPaths: readonly string[],
): MaybePromise<AutoStashResult>;
function createAutoStashWith(
	run: GitRunner,
	repoPath: string,
	timeoutMs: number,
	userPaths: readonly string[],
): MaybePromise<AutoStashResult> {
	const stashMessage = `${SOURCE_REPO_AUTOSTASH_PREFIX}-${new Date().toISOString().replace(/\D/g, "")}`;
	const pathspecs = userPaths.map((path) => `:(literal)${path}`);
	return flatMapMaybePromise(readStashHeadWith(run, repoPath, timeoutMs), (before) =>
		flatMapMaybePromise(
			run(["stash", "push", "--include-untracked", "--message", stashMessage, "--", ...pathspecs], repoPath, timeoutMs),
			(stash) =>
				flatMapMaybePromise(readStashHeadWith(run, repoPath, timeoutMs), (after) => {
					const stashRef = after && after !== before ? after : undefined;
					if (!stash.ok) {
						return {
							ok: false,
							message: `git stash failed: ${readGitError(stash, timeoutMs)}`,
							...(stashRef ? { stashRef } : {}),
						};
					}
					if (!stashRef) {
						return {
							ok: false,
							message: `git stash completed without creating a verifiable ${SOURCE_REPO_AUTOSTASH_PREFIX} entry`,
						};
					}

					return flatMapMaybePromise(readStashSubjectWith(run, repoPath, stashRef, timeoutMs), (subject) => {
						if (!subject?.includes(stashMessage)) {
							return {
								ok: false,
								message: `new refs/stash entry ${stashRef} could not be verified as Signet's automatic stash`,
								stashRef,
							};
						}

						return { ok: true, stashRef };
					});
				}),
		),
	);
}

function readStashHeadWith(run: typeof runGit, repoPath: string, timeoutMs: number): string | null;
function readStashHeadWith(run: typeof runGitAsync, repoPath: string, timeoutMs: number): Promise<string | null>;
function readStashHeadWith(run: GitRunner, repoPath: string, timeoutMs: number): MaybePromise<string | null>;
function readStashHeadWith(run: GitRunner, repoPath: string, timeoutMs: number): MaybePromise<string | null> {
	return mapMaybePromise(run(["rev-parse", "--verify", "--quiet", "refs/stash"], repoPath, timeoutMs), (result) =>
		readTrimmedValue(result),
	);
}

function readStashSubjectWith(run: typeof runGit, repoPath: string, stashRef: string, timeoutMs: number): string | null;
function readStashSubjectWith(
	run: typeof runGitAsync,
	repoPath: string,
	stashRef: string,
	timeoutMs: number,
): Promise<string | null>;
function readStashSubjectWith(
	run: GitRunner,
	repoPath: string,
	stashRef: string,
	timeoutMs: number,
): MaybePromise<string | null>;
function readStashSubjectWith(
	run: GitRunner,
	repoPath: string,
	stashRef: string,
	timeoutMs: number,
): MaybePromise<string | null> {
	return mapMaybePromise(run(["show", "-s", "--format=%s", stashRef], repoPath, timeoutMs), (result) =>
		readTrimmedValue(result),
	);
}

function parsePorcelainStatusPath(line: string): string | null {
	if (line.length < 4) return null;
	const rawPath = line.slice(3);
	const renameSeparator = " -> ";
	const path = rawPath.includes(renameSeparator)
		? rawPath.slice(rawPath.lastIndexOf(renameSeparator) + renameSeparator.length)
		: rawPath;
	return path.replace(/^"|"$/g, "");
}

function readUpstreamBranchWith(run: typeof runGit, repoPath: string, timeoutMs: number): string | null;
function readUpstreamBranchWith(run: typeof runGitAsync, repoPath: string, timeoutMs: number): Promise<string | null>;
function readUpstreamBranchWith(run: GitRunner, repoPath: string, timeoutMs: number): MaybePromise<string | null>;
function readUpstreamBranchWith(run: GitRunner, repoPath: string, timeoutMs: number): MaybePromise<string | null> {
	return mapMaybePromise(
		run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], repoPath, timeoutMs),
		(result) => readTrimmedValue(result),
	);
}

function readAheadBehindWith(
	run: typeof runGit,
	repoPath: string,
	upstream: string,
	timeoutMs: number,
): AheadBehind | null;
function readAheadBehindWith(
	run: typeof runGitAsync,
	repoPath: string,
	upstream: string,
	timeoutMs: number,
): Promise<AheadBehind | null>;
function readAheadBehindWith(
	run: GitRunner,
	repoPath: string,
	upstream: string,
	timeoutMs: number,
): MaybePromise<AheadBehind | null>;
function readAheadBehindWith(
	run: GitRunner,
	repoPath: string,
	upstream: string,
	timeoutMs: number,
): MaybePromise<AheadBehind | null> {
	return mapMaybePromise(
		run(["rev-list", "--left-right", "--count", `HEAD...${upstream}`], repoPath, timeoutMs),
		(result) => {
			if (!result.ok) {
				return null;
			}

			return parseAheadBehind(result.stdout);
		},
	);
}

function isSafeBranchNameWith(run: typeof runGit, branch: string, timeoutMs: number): boolean;
function isSafeBranchNameWith(run: typeof runGitAsync, branch: string, timeoutMs: number): Promise<boolean>;
function isSafeBranchNameWith(run: GitRunner, branch: string, timeoutMs: number): MaybePromise<boolean>;
function isSafeBranchNameWith(run: GitRunner, branch: string, timeoutMs: number): MaybePromise<boolean> {
	if (branch.length === 0 || branch.startsWith("-")) {
		return false;
	}

	return mapMaybePromise(run(["check-ref-format", "--branch", branch], undefined, timeoutMs), (result) => result.ok);
}

function readTrimmedValue(result: GitCommandResult): string | null {
	if (!result.ok) {
		return null;
	}

	const value = result.stdout.trim();
	return value.length > 0 ? value : null;
}

function tryAcquireSourceRepoSyncLock(path: string): SyncLockAttempt {
	try {
		const fd = openSync(path, "wx");
		writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
		return { status: "acquired", lock: { fd, path } };
	} catch (err) {
		const code = err instanceof Error && "code" in err ? String(err.code) : "";
		if (code === "EEXIST") {
			return { status: "busy" };
		}
		return { status: "error", message: code || "unknown lock error" };
	}
}
