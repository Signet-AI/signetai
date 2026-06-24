import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	SIGNET_GIT_PROTECTED_PATHS,
	isSignetGitProtectedPath,
	isSignetGitTrackedPath,
	mergeSignetGitignoreEntries,
} from "@signet/core";
import { logger } from "../logger";
import { getSecret, hasSecret } from "../secrets.js";
import { AGENTS_DIR } from "./state";

import { clampGitSyncIntervalSeconds, type GitConfig, gitConfig } from "./git-config";
export { gitConfig };

let gitSyncTimer: ReturnType<typeof setInterval> | null = null;
let lastGitSync: Date | null = null;
let gitSyncInProgress = false;
let gitSyncPromise: Promise<unknown> | null = null;
let gitSyncQueued = false;

const DEFAULT_GIT_TIMEOUT_MS = 10_000;
const FETCH_GIT_TIMEOUT_MS = 45_000;
const MUTATING_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024;
const GIT_FAILURE_CIRCUIT_THRESHOLD = 3;
const GIT_FAILURE_CIRCUIT_COOLDOWN_MS = 10 * 60 * 1000;

interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
	timedOut?: boolean;
	truncated?: boolean;
}

interface CommandOptions {
	input?: string;
	cwd?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
}

let consecutiveGitFailures = 0;
let gitCircuitOpenUntil = 0;
let lastGitFailureReason: string | undefined;

let gitRepoProbe = (dir: string): boolean => existsSync(join(dir, ".git"));

type CommandRunner = (cmd: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;
let commandRunner: CommandRunner = runBoundedCommand;

function isGitRepo(dir: string): boolean {
	return gitRepoProbe(dir);
}

interface GitCredentials {
	method: "token" | "gh" | "credential-helper" | "ssh" | "no-remote" | "none";
	authUrl?: string;
	usePlainGit?: boolean;
}

function killProcessTree(proc: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
	try {
		if (process.platform !== "win32" && proc.pid) {
			process.kill(-proc.pid, signal);
			return;
		}
		proc.kill(signal);
	} catch {
		/* best-effort */
	}
}

async function runBoundedCommand(cmd: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
	return new Promise((resolve) => {
		const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
		const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES;
		const proc = spawn(cmd, args, {
			cwd: options?.cwd,
			stdio: "pipe",
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		let timedOut = false;
		let truncated = false;
		let killTimer: ReturnType<typeof setTimeout> | null = null;
		let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

		const finish = (result: CommandResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (fallbackTimer) clearTimeout(fallbackTimer);
			resolve(result);
		};

		const terminate = () => {
			killProcessTree(proc, "SIGTERM");
			killTimer = setTimeout(() => killProcessTree(proc, "SIGKILL"), 1_000);
			killTimer.unref?.();
			fallbackTimer = setTimeout(() => finish({ stdout, stderr, code: 124, timedOut, truncated }), 3_000);
			fallbackTimer.unref?.();
		};

		const timer = setTimeout(() => {
			timedOut = true;
			stderr += `\nCommand timed out after ${timeoutMs}ms`;
			terminate();
		}, timeoutMs);
		timer.unref?.();

		if (options?.input) {
			proc.stdin?.write(options.input);
			proc.stdin?.end();
		}

		proc.stdout?.on("data", (d) => {
			const chunk = d.toString();
			stdoutBytes += Buffer.byteLength(chunk);
			if (stdoutBytes <= maxOutputBytes) {
				stdout += chunk;
			} else if (!truncated) {
				truncated = true;
				stdout += chunk.slice(0, Math.max(0, maxOutputBytes - Buffer.byteLength(stdout)));
				stderr += `\nCommand output exceeded ${maxOutputBytes} bytes`;
				terminate();
			}
		});
		proc.stderr?.on("data", (d) => {
			const chunk = d.toString();
			stderrBytes += Buffer.byteLength(chunk);
			if (stderrBytes <= maxOutputBytes) {
				stderr += chunk;
			} else if (!truncated) {
				truncated = true;
				stderr += chunk.slice(0, Math.max(0, maxOutputBytes - Buffer.byteLength(stderr)));
				stderr += `\nCommand output exceeded ${maxOutputBytes} bytes`;
				terminate();
			}
		});
		proc.on("close", (code) => {
			finish({ stdout, stderr, code: timedOut || truncated ? 124 : (code ?? 1), timedOut, truncated });
		});
		proc.on("error", (error) => {
			finish({ stdout: "", stderr: error.message, code: 1 });
		});
	});
}

async function runCommand(cmd: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
	return commandRunner(cmd, args, options);
}

function gitCircuitIsOpen(): boolean {
	return Date.now() < gitCircuitOpenUntil;
}

function degradedReason(result: CommandResult, operation: string): string | undefined {
	if (result.timedOut) return `${operation} timed out`;
	if (result.truncated) return `${operation} produced too much output`;
	return undefined;
}

function recordGitSuccess(): void {
	consecutiveGitFailures = 0;
	gitCircuitOpenUntil = 0;
	lastGitFailureReason = undefined;
}

function recordGitFailure(reason: string): void {
	consecutiveGitFailures += 1;
	lastGitFailureReason = reason;
	if (consecutiveGitFailures >= GIT_FAILURE_CIRCUIT_THRESHOLD) {
		gitCircuitOpenUntil = Date.now() + GIT_FAILURE_CIRCUIT_COOLDOWN_MS;
		logger.warn("git", `Git operations temporarily disabled: ${reason}`);
	}
}

function gitCircuitMessage(): string {
	const suffix = lastGitFailureReason ? ` Last failure: ${lastGitFailureReason}.` : "";
	return `Git operations are temporarily disabled after repeated failures.${suffix}`;
}

async function getRemoteUrl(dir: string, remote: string): Promise<string | null> {
	const result = await runCommand("git", ["remote", "get-url", remote], {
		cwd: dir,
	});
	return result.code === 0 ? result.stdout.trim() : null;
}

function buildAuthUrlFromToken(baseUrl: string, token: string): string {
	let url = baseUrl;
	if (url.startsWith("git@github.com:")) {
		url = url.replace("git@github.com:", "https://github.com/");
	}

	if (url.startsWith("https://")) {
		url = url.replace(/https:\/\/[^@]+@/, "https://");
		return url.replace("https://", `https://${token}@`);
	}
	return url;
}

function buildAuthUrlFromCreds(baseUrl: string, creds: { username: string; password: string }): string {
	let url = baseUrl;
	if (url.startsWith("git@github.com:")) {
		url = url.replace("git@github.com:", "https://github.com/");
	}
	if (!url.startsWith("https://")) return url;
	url = url.replace(/https:\/\/[^@]+@/, "https://");
	return url.replace(
		"https://",
		`https://${encodeURIComponent(creds.username)}:${encodeURIComponent(creds.password)}@`,
	);
}

async function getCredentialHelperToken(
	url: string,
	cwd?: string,
): Promise<{ username: string; password: string } | null> {
	try {
		const urlObj = new URL(url);
		const input = `protocol=${urlObj.protocol.replace(":", "")}\nhost=${urlObj.host}\n\n`;
		const result = await runCommand("git", ["credential", "fill"], {
			input,
			cwd,
		});

		if (result.code !== 0) return null;

		const lines = result.stdout.split("\n");
		const username = lines.find((l) => l.startsWith("username="))?.slice(9);
		const password = lines.find((l) => l.startsWith("password="))?.slice(9);

		return username && password ? { username, password } : null;
	} catch {
		return null;
	}
}

async function getGhCliToken(): Promise<string | null> {
	try {
		const result = await runCommand("gh", ["auth", "token"]);
		return result.code === 0 ? result.stdout.trim() : null;
	} catch {
		return null;
	}
}

async function hasAnyGitCredentials(): Promise<boolean> {
	if (!isGitRepo(AGENTS_DIR)) return false;
	const remoteUrl = await getRemoteUrl(AGENTS_DIR, gitConfig.remote);
	if (!remoteUrl) return false;

	if (remoteUrl.startsWith("git@")) return true;

	if (remoteUrl.startsWith("https://")) {
		const creds = await getCredentialHelperToken(remoteUrl, AGENTS_DIR);
		if (creds) return true;
	}

	const isGitHub = extractGitHubHost(remoteUrl);
	if (isGitHub) {
		if (await hasSecret("GITHUB_TOKEN")) return true;
		if (await getGhCliToken()) return true;
	}

	return false;
}

function extractGitHubHost(url: string): boolean {
	try {
		const parsed = new URL(url.startsWith("https://") ? url : `https://${url}`);
		return parsed.hostname === "github.com";
	} catch {
		return false;
	}
}

async function resolveGitCredentials(dir: string, remote: string): Promise<GitCredentials> {
	const remoteUrl = await getRemoteUrl(dir, remote);
	if (!remoteUrl) {
		logger.debug("git", `No remote '${remote}' configured in ${dir} — skipping push/pull`);
		return { method: "no-remote" };
	}

	if (remoteUrl.startsWith("git@")) {
		logger.debug("git", "Using SSH for authentication");
		return { method: "ssh", usePlainGit: true };
	}

	if (remoteUrl.startsWith("https://")) {
		try {
			const creds = await getCredentialHelperToken(remoteUrl, dir);
			if (creds) {
				logger.debug("git", "Using git credential helper for authentication");
				return {
					method: "credential-helper",
					authUrl: buildAuthUrlFromCreds(remoteUrl, creds),
				};
			}
		} catch {
			/* ignore */
		}
	}

	const isGitHub = extractGitHubHost(remoteUrl);

	if (isGitHub) {
		try {
			const token = await getSecret("GITHUB_TOKEN");
			if (token) {
				logger.debug("git", "Using stored GITHUB_TOKEN for authentication");
				return {
					method: "token",
					authUrl: buildAuthUrlFromToken(remoteUrl, token),
				};
			}
		} catch {
			/* ignore */
		}

		try {
			const ghToken = await getGhCliToken();
			if (ghToken) {
				logger.debug("git", "Using gh CLI token for authentication");
				return {
					method: "gh",
					authUrl: buildAuthUrlFromToken(remoteUrl, ghToken),
				};
			}
		} catch {
			/* ignore */
		}
	}

	return { method: "none" };
}

function runGitCommand(args: string[], cwd: string, options?: CommandOptions): Promise<CommandResult> {
	return runCommand("git", args, {
		cwd,
		timeoutMs: options?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
		maxOutputBytes: options?.maxOutputBytes ?? DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES,
	});
}

function failingGitResultMessage(operation: string, result: CommandResult): string {
	const degraded = degradedReason(result, operation);
	return degraded ?? `${operation} failed: ${result.stderr || result.stdout || `exit code ${result.code}`}`;
}

export async function gitPull(): Promise<{
	success: boolean;
	message: string;
	changes?: number;
}> {
	if (gitCircuitIsOpen()) {
		return { success: false, message: gitCircuitMessage() };
	}
	if (!isGitRepo(AGENTS_DIR)) {
		return { success: false, message: "Not a git repository" };
	}

	const creds = await resolveGitCredentials(AGENTS_DIR, gitConfig.remote);

	if (creds.method === "no-remote") {
		return {
			success: true,
			message: `No remote '${gitConfig.remote}' configured — skipping pull`,
			changes: 0,
		};
	}

	let fetchResult: CommandResult;

	if (creds.usePlainGit) {
		fetchResult = await runGitCommand(["fetch", gitConfig.remote, gitConfig.branch], AGENTS_DIR, {
			timeoutMs: FETCH_GIT_TIMEOUT_MS,
		});
	} else if (creds.authUrl) {
		fetchResult = await runGitCommand(["fetch", creds.authUrl, gitConfig.branch], AGENTS_DIR, {
			timeoutMs: FETCH_GIT_TIMEOUT_MS,
		});
	} else {
		return {
			success: false,
			message: "No git credentials found. Run `gh auth login` or set GITHUB_TOKEN secret.",
		};
	}

	if (fetchResult.code !== 0) {
		const message = failingGitResultMessage("Fetch", fetchResult);
		recordGitFailure(message);
		logger.warn("git", message);
		return { success: false, message };
	}

	const diffResult = await runGitCommand(
		["rev-list", "--count", `HEAD..${gitConfig.remote}/${gitConfig.branch}`],
		AGENTS_DIR,
	);

	const incomingChanges = Number.parseInt(diffResult.stdout.trim(), 10) || 0;
	if (diffResult.code !== 0) {
		const message = failingGitResultMessage("Incoming commit count", diffResult);
		recordGitFailure(message);
		logger.warn("git", message);
		return { success: false, message };
	}

	if (incomingChanges === 0) {
		recordGitSuccess();
		return { success: true, message: "Already up to date", changes: 0 };
	}

	const statusResult = await runGitCommand(["status", "--porcelain"], AGENTS_DIR);
	if (statusResult.code !== 0) {
		const message = failingGitResultMessage("Workspace status", statusResult);
		recordGitFailure(message);
		logger.warn("git", message);
		return { success: false, message };
	}
	const hasLocalChanges = statusResult.stdout.trim().length > 0;

	let stashed = false;
	if (hasLocalChanges) {
		const stashResult = await runGitCommand(["stash", "push", "-m", "signet-auto-stash"], AGENTS_DIR, {
			timeoutMs: MUTATING_GIT_TIMEOUT_MS,
		});
		if (stashResult.code !== 0) {
			const message = failingGitResultMessage("Stash", stashResult);
			recordGitFailure(message);
			logger.warn("git", message);
			return {
				success: false,
				message: `Failed to stash local changes: ${message}`,
			};
		}
		stashed = true;
	}

	const pullResult = await runGitCommand(
		["merge", `${gitConfig.remote}/${gitConfig.branch}`, "--ff-only"],
		AGENTS_DIR,
		{
			timeoutMs: MUTATING_GIT_TIMEOUT_MS,
		},
	);

	if (stashed) {
		const popResult = await runGitCommand(["stash", "pop"], AGENTS_DIR, { timeoutMs: MUTATING_GIT_TIMEOUT_MS });
		if (popResult.code !== 0) {
			logger.warn("git", `Stash pop failed — local changes preserved in git stash: ${popResult.stderr}`);
		}
	}

	if (pullResult.code !== 0) {
		const message = failingGitResultMessage("Pull", pullResult);
		recordGitFailure(message);
		logger.warn("git", message);
		return { success: false, message };
	}

	recordGitSuccess();
	logger.git.sync("pull", incomingChanges);
	return {
		success: true,
		message: `Pulled ${incomingChanges} commits`,
		changes: incomingChanges,
	};
}

export async function gitPush(): Promise<{
	success: boolean;
	message: string;
	changes?: number;
}> {
	if (gitCircuitIsOpen()) {
		return { success: false, message: gitCircuitMessage() };
	}
	if (!isGitRepo(AGENTS_DIR)) {
		return { success: false, message: "Not a git repository" };
	}

	const creds = await resolveGitCredentials(AGENTS_DIR, gitConfig.remote);

	if (creds.method === "no-remote") {
		return {
			success: true,
			message: `No remote '${gitConfig.remote}' configured — skipping push`,
			changes: 0,
		};
	}

	const diffResult = await runGitCommand(
		["rev-list", "--count", `${gitConfig.remote}/${gitConfig.branch}..HEAD`],
		AGENTS_DIR,
	);
	if (diffResult.code !== 0) {
		const message = failingGitResultMessage("Outgoing commit count", diffResult);
		recordGitFailure(message);
		logger.warn("git", message);
		return { success: false, message };
	}

	const outgoingChanges = Number.parseInt(diffResult.stdout.trim(), 10) || 0;

	if (outgoingChanges === 0) {
		recordGitSuccess();
		return { success: true, message: "Nothing to push", changes: 0 };
	}

	let pushResult: CommandResult;

	if (creds.usePlainGit) {
		pushResult = await runGitCommand(["push", gitConfig.remote, `HEAD:${gitConfig.branch}`], AGENTS_DIR, {
			timeoutMs: FETCH_GIT_TIMEOUT_MS,
		});
	} else if (creds.authUrl) {
		pushResult = await runGitCommand(["push", creds.authUrl, `HEAD:${gitConfig.branch}`], AGENTS_DIR, {
			timeoutMs: FETCH_GIT_TIMEOUT_MS,
		});
	} else {
		return {
			success: false,
			message: "No git credentials found. Run `gh auth login` or set GITHUB_TOKEN secret.",
		};
	}

	if (pushResult.code !== 0) {
		const message = failingGitResultMessage("Push", pushResult);
		recordGitFailure(message);
		logger.warn("git", message);
		return { success: false, message };
	}

	recordGitSuccess();
	logger.git.sync("push", outgoingChanges);
	return {
		success: true,
		message: `Pushed ${outgoingChanges} commits`,
		changes: outgoingChanges,
	};
}

export async function gitSync(): Promise<{
	success: boolean;
	message: string;
	pulled?: number;
	pushed?: number;
}> {
	if (gitSyncInProgress) {
		return { success: false, message: "Sync already in progress" };
	}

	gitSyncInProgress = true;

	try {
		const pullResult = await gitPull();
		if (!pullResult.success) {
			return { success: false, message: pullResult.message };
		}

		const pushResult = await gitPush();
		if (!pushResult.success) {
			return {
				success: false,
				message: pushResult.message,
				pulled: pullResult.changes,
			};
		}

		lastGitSync = new Date();
		return {
			success: true,
			message: "Sync complete",
			pulled: pullResult.changes,
			pushed: pushResult.changes,
		};
	} finally {
		gitSyncInProgress = false;
	}
}

export function startGitSyncTimer() {
	if (gitSyncTimer) {
		clearInterval(gitSyncTimer);
		gitSyncTimer = null;
	}

	if (!gitConfig.enabled || !gitConfig.autoSync) {
		logger.debug("git", "Auto-sync disabled");
		return;
	}

	gitConfig.syncInterval = clampGitSyncIntervalSeconds(gitConfig.syncInterval) ?? 300;
	const intervalMs = gitConfig.syncInterval * 1000;
	logger.info("git", `Auto-sync enabled: every ${gitConfig.syncInterval}s`);

	gitSyncTimer = setInterval(() => {
		queuePeriodicGitSync();
	}, intervalMs);
}

function queuePeriodicGitSync(): void {
	if (gitSyncPromise) {
		gitSyncQueued = true;
		return;
	}

	const work = (async () => {
		do {
			gitSyncQueued = false;
			const hasCreds = await hasAnyGitCredentials();
			if (!hasCreds) return;

			logger.debug("git", "Running periodic sync...");
			const result = await gitSync();
			if (!result.success) {
				logger.warn("git", `Periodic sync failed: ${result.message}`);
			}
		} while (gitSyncQueued);
	})().catch((e) => {
		logger.warn("git", "Periodic sync error", { error: String(e) });
	});
	gitSyncPromise = work;
	work.finally(() => {
		if (gitSyncPromise === work) gitSyncPromise = null;
	});
}

function cancelAutoCommit(): void {
	if (commitTimer) {
		clearTimeout(commitTimer);
		commitTimer = null;
	}
	commitPending = false;
	pendingChanges = [];
}

export async function stopGitSyncTimer(options?: { readonly shutdown?: boolean }): Promise<void> {
	if (gitSyncTimer) {
		clearInterval(gitSyncTimer);
		gitSyncTimer = null;
	}
	gitSyncQueued = false;
	if (options?.shutdown) cancelAutoCommit();
	if (gitSyncPromise) {
		try {
			await gitSyncPromise;
		} catch {
			// best-effort
		}
		gitSyncPromise = null;
	}
}

export async function getGitStatus(): Promise<{
	isRepo: boolean;
	branch?: string;
	remote?: string;
	hasCredentials: boolean;
	authMethod?: string;
	autoSync: boolean;
	lastSync?: string;
	uncommittedChanges?: number;
	unpushedCommits?: number;
	unpulledCommits?: number;
	degraded?: boolean;
	degradedReason?: string;
}> {
	const isRepo = isGitRepo(AGENTS_DIR);
	if (!isRepo) return { isRepo, hasCredentials: false, autoSync: gitConfig.autoSync };
	if (gitCircuitIsOpen()) {
		return {
			isRepo,
			remote: gitConfig.remote,
			hasCredentials: false,
			autoSync: gitConfig.autoSync,
			lastSync: lastGitSync ? lastGitSync.toISOString() : undefined,
			degraded: true,
			degradedReason: gitCircuitMessage(),
		};
	}

	let degraded: string | undefined;

	let creds: GitCredentials;
	try {
		creds = await resolveGitCredentials(AGENTS_DIR, gitConfig.remote);
	} catch (error) {
		degraded = `Git credential check failed: ${error instanceof Error ? error.message : String(error)}`;
		creds = { method: "none" };
	}
	const hasCredentials = creds.method !== "none" && creds.method !== "no-remote";

	let branch: string | undefined;
	const branchResult = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], AGENTS_DIR);
	if (branchResult.code === 0) {
		branch = branchResult.stdout.trim();
	} else {
		degraded = degraded ?? failingGitResultMessage("Branch lookup", branchResult);
	}

	let uncommittedChanges: number | undefined;
	const statusResult = await runGitCommand(["status", "--porcelain"], AGENTS_DIR);
	if (statusResult.code === 0) {
		uncommittedChanges = statusResult.stdout
			.trim()
			.split("\n")
			.filter((l) => l.trim()).length;
	} else {
		degraded = degraded ?? failingGitResultMessage("Workspace status", statusResult);
	}

	let unpushedCommits: number | undefined;
	let unpulledCommits: number | undefined;
	if (hasCredentials) {
		const unpushedResult = await runGitCommand(
			["rev-list", "--count", `${gitConfig.remote}/${gitConfig.branch}..HEAD`],
			AGENTS_DIR,
		);
		if (unpushedResult.code === 0) {
			unpushedCommits = Number.parseInt(unpushedResult.stdout.trim(), 10) || 0;
		} else {
			degraded = degraded ?? failingGitResultMessage("Outgoing commit count", unpushedResult);
		}

		const unpulledResult = await runGitCommand(
			["rev-list", "--count", `HEAD..${gitConfig.remote}/${gitConfig.branch}`],
			AGENTS_DIR,
		);
		if (unpulledResult.code === 0) {
			unpulledCommits = Number.parseInt(unpulledResult.stdout.trim(), 10) || 0;
		} else {
			degraded = degraded ?? failingGitResultMessage("Incoming commit count", unpulledResult);
		}
	}

	if (degraded) {
		recordGitFailure(degraded);
	} else {
		recordGitSuccess();
	}

	return {
		isRepo,
		branch,
		remote: gitConfig.remote,
		hasCredentials,
		authMethod: creds.method,
		autoSync: gitConfig.autoSync,
		lastSync: lastGitSync ? lastGitSync.toISOString() : undefined,
		uncommittedChanges,
		unpushedCommits,
		unpulledCommits,
		degraded: Boolean(degraded),
		degradedReason: degraded,
	};
}

let commitPending = false;
let commitTimer: ReturnType<typeof setTimeout> | null = null;
const COMMIT_DEBOUNCE_MS = 5000;

export function ensureWorkspaceGitignore(): boolean {
	try {
		return ensureProtectedGitignore(AGENTS_DIR);
	} catch (error) {
		logger.warn("git", "Failed to update lightweight workspace .gitignore", {
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

function ensureProtectedGitignore(dir: string): boolean {
	const gitignorePath = join(dir, ".gitignore");
	const existingContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
	const nextContent = mergeSignetGitignoreEntries(existingContent);
	if (nextContent !== existingContent) {
		writeFileSync(gitignorePath, nextContent, "utf-8");
		return true;
	}
	return false;
}

async function gitUntrackProtectedFiles(dir: string): Promise<void> {
	await runGitCommand(["rm", "-r", "--cached", "--ignore-unmatch", "--quiet", "--", ...SIGNET_GIT_PROTECTED_PATHS], dir, {
		timeoutMs: MUTATING_GIT_TIMEOUT_MS,
	});
}

async function listStagedProtectedRemovals(dir: string): Promise<string[]> {
	const result = await runGitCommand(["diff", "--cached", "--name-only", "-z", "--diff-filter=D"], dir, {
		timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
	});
	if (result.code !== 0) return [];
	return splitNullSeparated(result.stdout).filter(isSignetGitProtectedPath);
}

async function listStagedPaths(dir: string): Promise<string[]> {
	const result = await runGitCommand(["diff", "--cached", "--name-only", "-z"], dir, {
		timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
	});
	if (result.code !== 0) return [];
	return splitNullSeparated(result.stdout);
}

async function restoreStagedPaths(dir: string, paths: readonly string[]): Promise<void> {
	if (paths.length === 0) return;
	await runGitCommand(["restore", "--staged", "--", ...literalPathspecs(paths)], dir, { timeoutMs: DEFAULT_GIT_TIMEOUT_MS });
}

function literalPathspecs(paths: readonly string[]): string[] {
	return paths.map((path) => `:(literal)${path}`);
}

function splitNullSeparated(value: string): string[] {
	return value.split("\0").filter((entry) => entry.length > 0);
}

const GIT_AUTOCOMMIT_TIMEOUT_MS = 30_000;
let autocommitInFlight = false;

function canonicalPathForContainment(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		const parent = dirname(absolute);
		if (parent !== absolute && existsSync(parent)) {
			try {
				return join(realpathSync.native(parent), basename(absolute));
			} catch {
				// Fall through to the normalized absolute path.
			}
		}
		return absolute;
	}
}

function toRelativeGitPath(dir: string, path: string): string | null {
	const canonicalDir = canonicalPathForContainment(dir);
	const candidate = canonicalPathForContainment(isAbsolute(path) ? path : join(dir, path));
	const relativePath = relative(canonicalDir, candidate);
	if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
	return relativePath.replace(/\\/g, "/");
}

async function gitAutoCommit(dir: string, changedFiles: string[]): Promise<void> {
	if (!isGitRepo(dir)) return;
	if (autocommitInFlight) return;
	autocommitInFlight = true;

	try {
		ensureProtectedGitignore(dir);
		const stagedBefore = await listStagedPaths(dir);
		await gitUntrackProtectedFiles(dir);
		let protectedRemovals = await listStagedProtectedRemovals(dir);
		const preexistingProtected = new Set(stagedBefore.filter(isSignetGitProtectedPath));
		const hasUnrelatedStagedChanges = stagedBefore.some((path) => !isSignetGitProtectedPath(path));
		const newlyStagedProtectedRemovals = protectedRemovals.filter((path) => !preexistingProtected.has(path));
		if (protectedRemovals.length > 0 && hasUnrelatedStagedChanges) {
			logger.warn("git", "Skipped protected-path cleanup because unrelated staged changes already exist");
			await restoreStagedPaths(dir, newlyStagedProtectedRemovals);
			protectedRemovals = [];
		}

		const candidateFiles = changedFiles.map((file) => toRelativeGitPath(dir, file)).filter((file): file is string => Boolean(file));
		const relativeFiles = Array.from(new Set(candidateFiles.filter(isSignetGitTrackedPath)));
		const commitFiles = Array.from(new Set([...relativeFiles, ...protectedRemovals]));
		const droppedChanges = changedFiles.length - relativeFiles.length;
		if (droppedChanges > 0) {
			logger.warn("git", `Dropped ${droppedChanges} auto-commit paths outside the lightweight workspace backup policy`);
		}
		if (commitFiles.length === 0) return;

		const fileList = commitFiles.join(", ");
		const now = new Date();
		const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const message = `${timestamp}_auto_${fileList.slice(0, 50)}`;

		if (relativeFiles.length > 0) {
			const addResult = await runGitCommand(["add", "--", ...literalPathspecs(relativeFiles)], dir, {
				timeoutMs: GIT_AUTOCOMMIT_TIMEOUT_MS,
			});
			if (addResult.code !== 0) {
				await restoreStagedPaths(dir, newlyStagedProtectedRemovals);
				logger.warn("git", failingGitResultMessage("Auto-commit add", addResult));
				recordGitFailure(failingGitResultMessage("Auto-commit add", addResult));
				return;
			}
		}

		const commitArgs = protectedRemovals.length > 0
			? ["commit", "-m", message]
			: ["commit", "-m", message, "--", ...literalPathspecs(commitFiles)];
		if (protectedRemovals.length === 0) {
			const statusResult = await runGitCommand(["status", "--porcelain", "--", ...literalPathspecs(commitFiles)], dir, {
				timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
			});
			if (statusResult.code !== 0) {
				logger.warn("git", failingGitResultMessage("Auto-commit status", statusResult));
				recordGitFailure(failingGitResultMessage("Auto-commit status", statusResult));
				return;
			}
			if (!statusResult.stdout.trim()) return;
		}

		const commitResult = await runGitCommand(commitArgs, dir, {
			timeoutMs: MUTATING_GIT_TIMEOUT_MS,
		});
		if (commitResult.code === 0) {
			recordGitSuccess();
			logger.git.commit(message, commitFiles.length);
		} else {
			logger.warn("git", failingGitResultMessage("Auto-commit", commitResult));
			recordGitFailure(failingGitResultMessage("Auto-commit", commitResult));
		}
	} finally {
		autocommitInFlight = false;
	}
}

let pendingChanges: string[] = [];

export function scheduleAutoCommit(changedPath: string) {
	if (!gitConfig.enabled || !gitConfig.autoCommit) return;
	pendingChanges.push(changedPath);
	scheduleAutoCommitFlush(COMMIT_DEBOUNCE_MS);
}

function scheduleAutoCommitFlush(delayMs: number): void {
	if (commitTimer) {
		clearTimeout(commitTimer);
	}

	commitTimer = setTimeout(async () => {
		commitTimer = null;
		if (commitPending || autocommitInFlight) {
			if (pendingChanges.length > 0) scheduleAutoCommitFlush(1_000);
			return;
		}
		commitPending = true;

		const changes = [...pendingChanges];
		pendingChanges = [];

		try {
			await gitAutoCommit(AGENTS_DIR, changes);
		} catch (error) {
			const reason = `Auto-commit crashed: ${error instanceof Error ? error.message : String(error)}`;
			logger.warn("git", reason);
			recordGitFailure(reason);
		} finally {
			commitPending = false;
			if (pendingChanges.length > 0) scheduleAutoCommitFlush(1_000);
		}
	}, delayMs);
	commitTimer.unref?.();
}

export function getAutoCommitQueueStateForTests(): { pending: boolean; queued: number } {
	return { pending: commitTimer !== null || commitPending, queued: pendingChanges.length };
}

export async function gitAutoCommitForTests(dir: string, changedFiles: string[]): Promise<void> {
	await gitAutoCommit(dir, changedFiles);
}

export function setGitCommandRunnerForTests(runner: CommandRunner | null): void {
	commandRunner = runner ?? runBoundedCommand;
}

export function setGitRepoProbeForTests(probe: ((dir: string) => boolean) | null): void {
	gitRepoProbe = probe ?? ((dir: string): boolean => existsSync(join(dir, ".git")));
}

export function toRelativeGitPathForTests(dir: string, path: string): string | null {
	return toRelativeGitPath(dir, path);
}

export function resetGitHealthForTests(): void {
	consecutiveGitFailures = 0;
	gitCircuitOpenUntil = 0;
	lastGitFailureReason = undefined;
}
