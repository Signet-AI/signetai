import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	SIGNET_GIT_PROTECTED_PATHS,
	mergeSignetGitignoreEntries,
	parseSimpleYaml,
	readNetworkMode,
} from "@signet/core";
import { logger } from "../logger";
import { getSecret, hasSecret } from "../secrets.js";
import { AGENTS_DIR } from "./state";

export interface GitConfig {
	enabled: boolean;
	autoCommit: boolean;
	autoSync: boolean;
	syncInterval: number;
	remote: string;
	branch: string;
}

function detectGitBranch(remote: string): string {
	try {
		const ref = execFileSync("git", ["symbolic-ref", `refs/remotes/${remote}/HEAD`], {
			cwd: AGENTS_DIR,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 3000,
			windowsHide: true,
		}).trim();
		const prefix = `refs/remotes/${remote}/`;
		if (ref.startsWith(prefix)) {
			return ref.slice(prefix.length);
		}
	} catch {
		// fall through
	}

	try {
		const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: AGENTS_DIR,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 3000,
			windowsHide: true,
		}).trim();
		if (branch && branch !== "HEAD") {
			return branch;
		}
	} catch {
		// fall through
	}

	return "main";
}

export function loadGitConfig(): GitConfig {
	const defaults: GitConfig = {
		enabled: true,
		autoCommit: true,
		autoSync: true,
		syncInterval: 300,
		remote: "origin",
		branch: "",
	};

	const paths = [join(AGENTS_DIR, "agent.yaml"), join(AGENTS_DIR, "AGENT.yaml")];

	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			const yaml = parseSimpleYaml(readFileSync(p, "utf-8"));
			const git = yaml.git as Record<string, string | boolean> | undefined;
			if (git) {
				if (git.enabled !== undefined) defaults.enabled = git.enabled === "true" || git.enabled === true;
				if (git.autoCommit !== undefined) defaults.autoCommit = git.autoCommit === "true" || git.autoCommit === true;
				if (git.autoSync !== undefined) defaults.autoSync = git.autoSync === "true" || git.autoSync === true;
				if (git.syncInterval !== undefined) defaults.syncInterval = Number.parseInt(git.syncInterval as string, 10);
				if (git.remote) defaults.remote = git.remote as string;
				if (git.branch) defaults.branch = git.branch as string;
			}
			break;
		} catch {
			// ignore parse errors
		}
	}

	if (!defaults.branch) {
		defaults.branch = detectGitBranch(defaults.remote);
	}

	return defaults;
}

export const gitConfig: GitConfig = loadGitConfig();

let gitSyncTimer: ReturnType<typeof setInterval> | null = null;
let lastGitSync: Date | null = null;
let gitSyncInProgress = false;
let gitSyncPromise: Promise<unknown> | null = null;

function isGitRepo(dir: string): boolean {
	return existsSync(join(dir, ".git"));
}

interface GitCredentials {
	method: "token" | "gh" | "credential-helper" | "ssh" | "no-remote" | "none";
	authUrl?: string;
	usePlainGit?: boolean;
}

async function runCommand(
	cmd: string,
	args: string[],
	options?: { input?: string; cwd?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, { cwd: options?.cwd, stdio: "pipe", windowsHide: true });
		let stdout = "";
		let stderr = "";

		if (options?.input) {
			proc.stdin?.write(options.input);
			proc.stdin?.end();
		}

		proc.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("close", (code) => {
			resolve({ stdout, stderr, code: code ?? 1 });
		});
		proc.on("error", () => {
			resolve({ stdout: "", stderr: "", code: 1 });
		});
	});
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

function runGitCommand(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn("git", args, { cwd, stdio: "pipe", windowsHide: true });
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("close", (code) => {
			resolve({ code: code ?? 1, stdout, stderr });
		});
		proc.on("error", (e) => {
			resolve({ code: 1, stdout: "", stderr: e.message });
		});
	});
}

export async function gitPull(): Promise<{
	success: boolean;
	message: string;
	changes?: number;
}> {
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

	let fetchResult: { code: number; stdout: string; stderr: string };

	if (creds.usePlainGit) {
		fetchResult = await runGitCommand(["fetch", gitConfig.remote, gitConfig.branch], AGENTS_DIR);
	} else if (creds.authUrl) {
		fetchResult = await runGitCommand(["fetch", creds.authUrl, gitConfig.branch], AGENTS_DIR);
	} else {
		return {
			success: false,
			message: "No git credentials found. Run `gh auth login` or set GITHUB_TOKEN secret.",
		};
	}

	if (fetchResult.code !== 0) {
		logger.warn("git", `Fetch failed: ${fetchResult.stderr}`);
		return { success: false, message: `Fetch failed: ${fetchResult.stderr}` };
	}

	const diffResult = await runGitCommand(
		["rev-list", "--count", `HEAD..${gitConfig.remote}/${gitConfig.branch}`],
		AGENTS_DIR,
	);

	const incomingChanges = Number.parseInt(diffResult.stdout.trim(), 10) || 0;

	if (incomingChanges === 0) {
		return { success: true, message: "Already up to date", changes: 0 };
	}

	const statusResult = await runGitCommand(["status", "--porcelain"], AGENTS_DIR);
	const hasLocalChanges = statusResult.stdout.trim().length > 0;

	let stashed = false;
	if (hasLocalChanges) {
		const stashResult = await runGitCommand(["stash", "push", "-m", "signet-auto-stash"], AGENTS_DIR);
		if (stashResult.code !== 0) {
			logger.warn("git", `Stash failed: ${stashResult.stderr}`);
			return {
				success: false,
				message: `Failed to stash local changes: ${stashResult.stderr}`,
			};
		}
		stashed = true;
	}

	const pullResult = await runGitCommand(["merge", `${gitConfig.remote}/${gitConfig.branch}`, "--ff-only"], AGENTS_DIR);

	if (stashed) {
		const popResult = await runGitCommand(["stash", "pop"], AGENTS_DIR);
		if (popResult.code !== 0) {
			logger.warn("git", `Stash pop failed — local changes preserved in git stash: ${popResult.stderr}`);
		}
	}

	if (pullResult.code !== 0) {
		logger.warn("git", `Pull failed: ${pullResult.stderr}`);
		return { success: false, message: `Pull failed: ${pullResult.stderr}` };
	}

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

	const outgoingChanges = Number.parseInt(diffResult.stdout.trim(), 10) || 0;

	if (outgoingChanges === 0) {
		return { success: true, message: "Nothing to push", changes: 0 };
	}

	let pushResult: { code: number; stdout: string; stderr: string };

	if (creds.usePlainGit) {
		pushResult = await runGitCommand(["push", gitConfig.remote, `HEAD:${gitConfig.branch}`], AGENTS_DIR);
	} else if (creds.authUrl) {
		pushResult = await runGitCommand(["push", creds.authUrl, `HEAD:${gitConfig.branch}`], AGENTS_DIR);
	} else {
		return {
			success: false,
			message: "No git credentials found. Run `gh auth login` or set GITHUB_TOKEN secret.",
		};
	}

	if (pushResult.code !== 0) {
		logger.warn("git", `Push failed: ${pushResult.stderr}`);
		return { success: false, message: `Push failed: ${pushResult.stderr}` };
	}

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
	}

	if (!gitConfig.autoSync || gitConfig.syncInterval <= 0) {
		logger.debug("git", "Auto-sync disabled");
		return;
	}

	const intervalMs = gitConfig.syncInterval * 1000;
	logger.info("git", `Auto-sync enabled: every ${gitConfig.syncInterval}s`);

	gitSyncTimer = setInterval(() => {
		const work = (async () => {
			const hasCreds = await hasAnyGitCredentials();
			if (!hasCreds) {
				return;
			}

			logger.debug("git", "Running periodic sync...");
			const result = await gitSync();
			if (!result.success) {
				logger.warn("git", `Periodic sync failed: ${result.message}`);
			}
		})().catch((e) => {
			logger.warn("git", "Periodic sync error", { error: String(e) });
		});
		gitSyncPromise = work;
		work.finally(() => {
			if (gitSyncPromise === work) gitSyncPromise = null;
		});
	}, intervalMs);
}

function cancelAutoCommit(): void {
	if (commitTimer) {
		clearTimeout(commitTimer);
		commitTimer = null;
	}
	commitPending = false;
	pendingChanges = [];
}

export async function stopGitSyncTimer(): Promise<void> {
	if (gitSyncTimer) {
		clearInterval(gitSyncTimer);
		gitSyncTimer = null;
	}
	// Drain both periodic sync and the debounced auto-commit timer on shutdown.
	cancelAutoCommit();
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
}> {
	const isRepo = isGitRepo(AGENTS_DIR);
	if (!isRepo) return { isRepo, hasCredentials: false, autoSync: gitConfig.autoSync };

	const creds = await resolveGitCredentials(AGENTS_DIR, gitConfig.remote);
	const hasCredentials = creds.method !== "none" && creds.method !== "no-remote";

	let branch: string | undefined;
	const branchResult = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], AGENTS_DIR);
	if (branchResult.code === 0) {
		branch = branchResult.stdout.trim();
	}

	let uncommittedChanges: number | undefined;
	const statusResult = await runGitCommand(["status", "--porcelain"], AGENTS_DIR);
	if (statusResult.code === 0) {
		uncommittedChanges = statusResult.stdout
			.trim()
			.split("\n")
			.filter((l) => l.trim()).length;
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
		}

		const unpulledResult = await runGitCommand(
			["rev-list", "--count", `HEAD..${gitConfig.remote}/${gitConfig.branch}`],
			AGENTS_DIR,
		);
		if (unpulledResult.code === 0) {
			unpulledCommits = Number.parseInt(unpulledResult.stdout.trim(), 10) || 0;
		}
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
	};
}

let commitPending = false;
let commitTimer: ReturnType<typeof setTimeout> | null = null;
const COMMIT_DEBOUNCE_MS = 5000;

function ensureProtectedGitignore(dir: string): void {
	const gitignorePath = join(dir, ".gitignore");
	const existingContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
	const nextContent = mergeSignetGitignoreEntries(existingContent);
	if (nextContent !== existingContent) {
		writeFileSync(gitignorePath, nextContent, "utf-8");
	}
}

async function gitUntrackProtectedFiles(dir: string): Promise<void> {
	return new Promise((resolve) => {
		const proc = spawn("git", ["rm", "--cached", "--ignore-unmatch", "--quiet", "--", ...SIGNET_GIT_PROTECTED_PATHS], {
			cwd: dir,
			stdio: "pipe",
			windowsHide: true,
		});
		proc.on("close", () => resolve());
		proc.on("error", () => resolve());
	});
}

const GIT_AUTOCOMMIT_TIMEOUT_MS = 30_000;
let autocommitInFlight = false;

async function gitAutoCommit(dir: string, changedFiles: string[]): Promise<void> {
	if (!isGitRepo(dir)) return;
	if (autocommitInFlight) return;
	autocommitInFlight = true;

	try {
		ensureProtectedGitignore(dir);
		await gitUntrackProtectedFiles(dir);

		const fileList = changedFiles.map((f) => f.replace(`${dir}/`, "")).join(", ");
		const now = new Date();
		const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const message = `${timestamp}_auto_${fileList.slice(0, 50)}`;

		let active: ReturnType<typeof spawn> | null = null;

		const work = new Promise<void>((resolve) => {
			const add = spawn("git", ["add", "-A"], { cwd: dir, stdio: "pipe", windowsHide: true });
			active = add;
			add.on("close", (addCode) => {
				if (addCode !== 0) {
					logger.warn("git", "Git add failed");
					resolve();
					return;
				}
				const status = spawn("git", ["status", "--porcelain"], {
					cwd: dir,
					stdio: "pipe",
					windowsHide: true,
				});
				active = status;
				let statusOutput = "";
				status.stdout?.on("data", (d) => {
					statusOutput += d.toString();
				});
				status.on("close", (statusCode) => {
					if (statusCode !== 0 || !statusOutput.trim()) {
						resolve();
						return;
					}
					const commit = spawn("git", ["commit", "-m", message], {
						cwd: dir,
						stdio: "pipe",
						windowsHide: true,
					});
					active = commit;
					commit.on("close", (commitCode) => {
						if (commitCode === 0) {
							logger.git.commit(message, changedFiles.length);
						}
						resolve();
					});
					commit.on("error", () => resolve());
				});
				status.on("error", () => resolve());
			});
			add.on("error", () => resolve());
		});

		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(() => {
				logger.warn("git", "Auto-commit timed out after 30s");
				try {
					active?.kill("SIGTERM");
				} catch {}
				resolve();
			}, GIT_AUTOCOMMIT_TIMEOUT_MS);
		});

		await Promise.race([work, timeout]);
		clearTimeout(timer);
	} finally {
		autocommitInFlight = false;
	}
}

let pendingChanges: string[] = [];

export function scheduleAutoCommit(changedPath: string) {
	pendingChanges.push(changedPath);

	if (commitTimer) {
		clearTimeout(commitTimer);
	}

	commitTimer = setTimeout(async () => {
		if (commitPending) return;
		commitPending = true;

		const changes = [...pendingChanges];
		pendingChanges = [];

		await gitAutoCommit(AGENTS_DIR, changes);
		commitPending = false;
	}, COMMIT_DEBOUNCE_MS);
}
