import {
	SIGNET_GIT_PROTECTED_PATHS,
	isSignetGitProtectedPath,
	isSignetGitTrackedPath,
	mergeSignetGitignoreEntries,
} from "@signet/core";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const GIT_COMMAND_TIMEOUT_MS = 30_000;

interface GitResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export function isGitRepo(dir: string): boolean {
	return existsSync(join(dir, ".git"));
}

export async function gitInit(dir: string): Promise<boolean> {
	return (await runGit(dir, ["init"])).code === 0;
}

export async function gitAddAndCommit(dir: string, message: string): Promise<boolean> {
	ensureProtectedGitignore(dir);
	const stagedBefore = await listStagedPaths(dir);
	if (stagedBefore === null) return false;
	await gitUntrackProtectedFiles(dir);

	const paths = await listTrackedWorkspaceBackupPaths(dir);
	let protectedRemovals = await listStagedProtectedRemovals(dir);
	if (paths === null || protectedRemovals === null) return false;
	const preexistingProtected = new Set(stagedBefore.filter(isSignetGitProtectedPath));
	const hasUnrelatedStagedChanges = stagedBefore.some((path) => !isSignetGitProtectedPath(path));
	const newlyStagedProtectedRemovals = protectedRemovals.filter((path) => !preexistingProtected.has(path));
	if (protectedRemovals.length > 0 && hasUnrelatedStagedChanges) {
		await restoreStagedPaths(dir, newlyStagedProtectedRemovals);
		protectedRemovals = [];
	}
	const commitPaths = Array.from(new Set([...paths, ...protectedRemovals]));
	if (commitPaths.length === 0) return true;

	if (paths.length > 0) {
		const add = await runGit(dir, ["add", "-A", "--", ...literalPathspecs(paths)]);
		if (add.code !== 0) {
			await restoreStagedPaths(dir, newlyStagedProtectedRemovals);
			return false;
		}
	}

	if (protectedRemovals.length === 0) {
		const status = await runGit(dir, ["status", "--porcelain", "--", ...literalPathspecs(commitPaths)]);
		if (status.code !== 0 || status.stdout.trim().length === 0) return status.code === 0;
	}

	const commitArgs = protectedRemovals.length > 0
		? ["commit", "-m", message]
		: ["commit", "-m", message, "--", ...literalPathspecs(commitPaths)];
	return (await runGit(dir, commitArgs)).code === 0;
}

function ensureProtectedGitignore(dir: string): void {
	const path = join(dir, ".gitignore");
	const prev = existsSync(path) ? readFileSync(path, "utf-8") : "";
	const next = mergeSignetGitignoreEntries(prev);
	if (next !== prev) {
		writeFileSync(path, next, "utf-8");
	}
}

async function gitUntrackProtectedFiles(dir: string): Promise<void> {
	await runGit(dir, ["rm", "-r", "--cached", "--ignore-unmatch", "--quiet", "--", ...SIGNET_GIT_PROTECTED_PATHS]);
}

async function listTrackedWorkspaceBackupPaths(dir: string): Promise<string[] | null> {
	const [changed, deleted] = await Promise.all([
		runGit(dir, ["ls-files", "-co", "--exclude-standard", "-z"]),
		runGit(dir, ["ls-files", "-d", "-z"]),
	]);
	if (changed.code !== 0 || deleted.code !== 0) return null;
	const paths = [...splitNullSeparated(changed.stdout), ...splitNullSeparated(deleted.stdout)];
	return Array.from(new Set(paths.filter(isSignetGitTrackedPath))).sort();
}

async function listStagedProtectedRemovals(dir: string): Promise<string[] | null> {
	const result = await runGit(dir, ["diff", "--cached", "--name-only", "-z", "--diff-filter=D"]);
	if (result.code !== 0) return null;
	return splitNullSeparated(result.stdout).filter(isSignetGitProtectedPath);
}

async function listStagedPaths(dir: string): Promise<string[] | null> {
	const result = await runGit(dir, ["diff", "--cached", "--name-only", "-z"]);
	if (result.code !== 0) return null;
	return splitNullSeparated(result.stdout);
}

async function restoreStagedPaths(dir: string, paths: readonly string[]): Promise<void> {
	if (paths.length === 0) return;
	await runGit(dir, ["restore", "--staged", "--", ...literalPathspecs(paths)]);
}

function literalPathspecs(paths: readonly string[]): string[] {
	return paths.map((path) => `:(literal)${path}`);
}

function splitNullSeparated(value: string): string[] {
	return value.split("\0").filter((entry) => entry.length > 0);
}

async function runGit(dir: string, args: string[], timeoutMs = GIT_COMMAND_TIMEOUT_MS): Promise<GitResult> {
	return await new Promise((resolve) => {
		const proc = spawn("git", args, {
			cwd: dir,
			stdio: "pipe",
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let killTimer: ReturnType<typeof setTimeout> | null = null;
		let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

		const finish = (result: GitResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (fallbackTimer) clearTimeout(fallbackTimer);
			resolve(result);
		};

		const terminate = () => {
			killGitProcessTree(proc, "SIGTERM");
			killTimer = setTimeout(() => killGitProcessTree(proc, "SIGKILL"), 1_000);
			killTimer.unref?.();
			fallbackTimer = setTimeout(() => finish({ code: 124, stdout, stderr }), 3_000);
			fallbackTimer.unref?.();
		};

		const timer = setTimeout(() => {
			stderr += `\nGit command timed out after ${timeoutMs}ms`;
			terminate();
		}, timeoutMs);
		timer.unref?.();

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
		proc.on("error", (error) => finish({ code: 1, stdout, stderr: error.message }));
	});
}

function killGitProcessTree(proc: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
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
