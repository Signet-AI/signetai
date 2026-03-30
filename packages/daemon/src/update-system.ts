/**
 * Singleton update system — extracted from daemon.ts for observability.
 *
 * Pattern: init once in main(), get from anywhere (like llm.ts,
 * db-accessor.ts).
 */

import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
	parseSimpleYaml,
	resolvePrimaryPackageManager,
	getGlobalInstallCommand,
	resolveGlobalPackagePath,
	type PackageManagerFamily,
} from "@signet/core";
import { logger } from "./logger";
import { compareVersions, isVersionNewer, isMajorUpgrade } from "./version";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateInfo {
	currentVersion: string;
	latestVersion: string | null;
	updateAvailable: boolean;
	releaseUrl?: string;
	releaseNotes?: string;
	publishedAt?: string;
	checkError?: string;
	restartRequired?: boolean;
	pendingVersion?: string;
	isMajorUpgrade?: boolean;
}

export interface UpdateRunResult {
	success: boolean;
	message: string;
	output?: string;
	installedVersion?: string;
	restartRequired?: boolean;
}

export interface UpdateConfig {
	autoInstall: boolean;
	checkInterval: number; // seconds
	channel: "latest" | "next";
}

export interface UpdateState {
	readonly currentVersion: string;
	readonly lastCheck: UpdateInfo | null;
	readonly lastCheckTime: Date | null;
	readonly checkInProgress: boolean;
	readonly installInProgress: boolean;
	readonly pendingRestartVersion: string | null;
	readonly lastAutoUpdateAt: Date | null;
	readonly lastAutoUpdateError: string | null;
	readonly config: UpdateConfig;
	readonly timerActive: boolean;
}

interface GitHubReleaseResponse {
	tag_name: string;
	html_url: string;
	body?: string;
	published_at?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITHUB_REPO = "Signet-AI/signetai";
const NPM_PACKAGE = "signetai";
const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const MIN_UPDATE_INTERVAL_SECONDS = 300;
export const MAX_UPDATE_INTERVAL_SECONDS = 604800;
const DEFAULT_UPDATE_INTERVAL_SECONDS = 21600;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let currentVersion = "0.0.0";
let agentsDir = "";
let initialized = false;

let lastUpdateCheck: UpdateInfo | null = null;
let lastUpdateCheckTime: Date | null = null;
let updateTimer: ReturnType<typeof setInterval> | null = null;
let updateCheckInProgress = false;
let updateInstallInProgress = false;
let pendingRestartVersion: string | null = null;
let lastAutoUpdateAt: Date | null = null;
let lastAutoUpdateError: string | null = null;
let updateConfig: UpdateConfig = {
	autoInstall: false,
	checkInterval: DEFAULT_UPDATE_INTERVAL_SECONDS,
	channel: "latest" as const,
};
let restartCallback: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Init / accessors
// ---------------------------------------------------------------------------

export function initUpdateSystem(version: string, dir: string, onRestartNeeded?: () => void): void {
	currentVersion = version;
	agentsDir = dir;
	updateConfig = loadUpdateConfig();
	restartCallback = onRestartNeeded ?? null;
	initialized = true;
}

function assertInitialized(): void {
	if (!initialized) {
		throw new Error("Update system not initialized — call initUpdateSystem first");
	}
}

export function getUpdateState(): UpdateState {
	return {
		currentVersion,
		lastCheck: lastUpdateCheck,
		lastCheckTime: lastUpdateCheckTime,
		checkInProgress: updateCheckInProgress,
		installInProgress: updateInstallInProgress,
		pendingRestartVersion,
		lastAutoUpdateAt,
		lastAutoUpdateError,
		config: { ...updateConfig },
		timerActive: updateTimer !== null,
	};
}

export function getUpdateConfig(): UpdateConfig {
	return { ...updateConfig };
}

// ---------------------------------------------------------------------------
// Error categorization
// ---------------------------------------------------------------------------

export function categorizeUpdateError(raw: string): string {
	const lower = raw.toLowerCase();

	if (lower.includes("403") || lower.includes("rate limit")) {
		return "GitHub API rate limited. Set a GITHUB_TOKEN env var or wait ~1 hour.";
	}
	if (lower.includes("enotfound") || lower.includes("fetch failed")) {
		return "No internet connection. Check network connectivity.";
	}
	if (lower.includes("enoent") || lower.includes("not found")) {
		return "Package manager not found on PATH. Ensure bun or npm is installed.";
	}
	if (lower.includes("eacces") || lower.includes("permission")) {
		return "Permission denied installing globally. Check file permissions or use sudo.";
	}
	if (lower.includes("timeout")) {
		return "Request timed out. GitHub/npm may be slow.";
	}

	return raw;
}

// ---------------------------------------------------------------------------
// Human-readable summary (sync — reads in-memory state only)
// ---------------------------------------------------------------------------

export function getUpdateSummary(): string | null {
	if (currentVersion === "0.0.0") {
		return "Warning: could not detect Signet version. " + "The daemon may have been built incorrectly.";
	}

	if (pendingRestartVersion) {
		return (
			`Signet v${pendingRestartVersion} is installed but needs ` +
			"a daemon restart. Run:\n" +
			"  signet daemon restart\n" +
			"  signet sync\n\n" +
			"These are the ONLY supported post-update commands."
		);
	}

	if (lastAutoUpdateError && updateConfig.autoInstall) {
		const categorized = categorizeUpdateError(lastAutoUpdateError);
		return `Auto-updates are enabled but failing: ${categorized} ` + "Run `signet update status` for details.";
	}

	const latest = lastUpdateCheck?.latestVersion;
	if (lastUpdateCheck?.updateAvailable && latest) {
		const notes = lastUpdateCheck.releaseNotes ? `\n\nWhat's new:\n${lastUpdateCheck.releaseNotes}` : "";

		if (updateConfig.autoInstall) {
			const autoInfo = lastAutoUpdateAt ? ` Last auto-update: ${lastAutoUpdateAt.toISOString()}.` : "";
			return (
				`Signet v${latest} is available (current: v${currentVersion}). ` +
				"Auto-update will install it on the next check cycle." +
				autoInfo +
				notes
			);
		}

		const packageManager = resolvePrimaryPackageManager({
			agentsDir,
			env: process.env,
		});
		const installCmd = getGlobalInstallCommand(packageManager.family, NPM_PACKAGE);
		const fullInstallCmd = `${installCmd.command} ${installCmd.args.join(" ")}`;

		return (
			`Signet v${latest} is available (current: v${currentVersion}).\n\n` +
			"To update Signet:\n" +
			`  ${fullInstallCmd}\n` +
			"  signet daemon restart\n" +
			"  signet sync\n\n" +
			"These are the ONLY supported update commands. " +
			"Do not use npx, bunx, or signet update install." +
			notes
		);
	}

	if (lastAutoUpdateAt && updateConfig.autoInstall) {
		return `Signet is up to date (v${currentVersion}). Last auto-update: ${lastAutoUpdateAt.toISOString()}.`;
	}

	return null;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function parseBooleanFlag(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (value === "true") return true;
		if (value === "false") return false;
	}
	return null;
}

export function parseUpdateInterval(value: unknown): number | null {
	const parsed = Number.parseInt(String(value), 10);
	if (!Number.isFinite(parsed)) return null;
	if (parsed < MIN_UPDATE_INTERVAL_SECONDS || parsed > MAX_UPDATE_INTERVAL_SECONDS) {
		return null;
	}
	return parsed;
}

function loadUpdateConfig(): UpdateConfig {
	const defaults: UpdateConfig = {
		autoInstall: false,
		checkInterval: DEFAULT_UPDATE_INTERVAL_SECONDS,
		channel: "latest" as const,
	};

	const paths = [join(agentsDir, "agent.yaml"), join(agentsDir, "AGENT.yaml")];

	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			const yaml = parseSimpleYaml(readFileSync(p, "utf-8"));
			const updates =
				(yaml.updates as Record<string, unknown> | undefined) || (yaml.update as Record<string, unknown> | undefined);

			if (updates) {
				const autoInstallRaw = updates.autoInstall ?? updates.auto_install;
				if (autoInstallRaw !== undefined) {
					const flag = parseBooleanFlag(autoInstallRaw);
					if (flag !== null) {
						defaults.autoInstall = flag;
					}
				}

				const checkIntervalRaw = updates.checkInterval ?? updates.check_interval;
				if (checkIntervalRaw !== undefined) {
					const interval = parseUpdateInterval(checkIntervalRaw);
					if (interval !== null) {
						defaults.checkInterval = interval;
					}
				}

				const channelRaw = updates.channel;
				if (channelRaw === "next" || channelRaw === "latest") {
					defaults.channel = channelRaw;
				}
			}

			break;
		} catch {
			// ignore parse errors
		}
	}

	return defaults;
}

function formatUpdatesSection(config: UpdateConfig): string {
	return (
		`updates:\n` +
		`  auto_install: ${config.autoInstall}\n` +
		`  check_interval: ${config.checkInterval}\n` +
		`  channel: ${config.channel}\n`
	);
}

export function persistUpdateConfig(config: UpdateConfig): boolean {
	const paths = [join(agentsDir, "agent.yaml"), join(agentsDir, "AGENT.yaml")];

	for (const p of paths) {
		if (!existsSync(p)) continue;

		try {
			const current = readFileSync(p, "utf-8");
			const updatesSection = formatUpdatesSection(config);
			const updatesPattern = /^updates:\n(?:[ \t].*(?:\n|$))*/m;
			const trimmedCurrent = current.trimEnd();

			const updated = updatesPattern.test(current)
				? current.replace(updatesPattern, updatesSection)
				: trimmedCurrent
					? `${trimmedCurrent}\n\n${updatesSection}`
					: updatesSection;

			if (updated !== current) {
				writeFileSync(p, updated);
			}

			return true;
		} catch (e) {
			logger.warn("system", "Failed to persist update config", {
				path: p,
				error: (e as Error).message,
			});
			return false;
		}
	}

	return false;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

async function fetchLatestFromGitHub(): Promise<{
	version: string;
	releaseUrl?: string;
	releaseNotes?: string;
	publishedAt?: string;
}> {
	const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
		headers: {
			Accept: "application/vnd.github.v3+json",
			"User-Agent": "signet-daemon",
		},
		signal: AbortSignal.timeout(10000),
	});

	if (!res.ok) {
		throw new Error(`GitHub releases lookup failed (${res.status})`);
	}

	const data = (await res.json()) as GitHubReleaseResponse;
	const version = data.tag_name.replace(/^v/, "");

	return {
		version,
		releaseUrl: data.html_url,
		releaseNotes: data.body?.slice(0, 500),
		publishedAt: data.published_at,
	};
}

async function fetchLatestFromNpm(channel: "latest" | "next" = "latest"): Promise<string> {
	const npmRes = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/${channel}`, {
		signal: AbortSignal.timeout(10000),
	});

	if (!npmRes.ok) {
		throw new Error(`npm registry lookup failed (${npmRes.status})`);
	}

	const npmData = (await npmRes.json()) as { version?: string };
	if (!npmData.version) {
		throw new Error("npm registry response missing version");
	}

	return npmData.version;
}

// ---------------------------------------------------------------------------
// Core: check + install
// ---------------------------------------------------------------------------

export async function checkForUpdates(): Promise<UpdateInfo> {
	assertInitialized();

	const result: UpdateInfo = {
		currentVersion,
		latestVersion: null,
		updateAvailable: false,
	};

	const errors: string[] = [];

	try {
		const github = await fetchLatestFromGitHub();
		result.latestVersion = github.version;
		result.releaseUrl = github.releaseUrl;
		result.releaseNotes = github.releaseNotes;
		result.publishedAt = github.publishedAt;
	} catch (e) {
		errors.push((e as Error).message);
	}

	if (!result.latestVersion) {
		try {
			result.latestVersion = await fetchLatestFromNpm(updateConfig.channel);
		} catch (e) {
			errors.push((e as Error).message);
		}
	}

	if (result.latestVersion) {
		result.updateAvailable = isVersionNewer(result.latestVersion, currentVersion);
		result.isMajorUpgrade = isMajorUpgrade(currentVersion, result.latestVersion);
	}

	if (pendingRestartVersion) {
		result.restartRequired = true;
		result.pendingVersion = pendingRestartVersion;

		if (result.latestVersion && compareVersions(result.latestVersion, pendingRestartVersion) === 0) {
			result.updateAvailable = false;
		}
	}

	if (!result.latestVersion && errors.length > 0) {
		result.checkError = errors.join(" | ");
		logger.warn("system", "Update check failed", {
			error: result.checkError,
		});
	}

	lastUpdateCheck = result;
	lastUpdateCheckTime = new Date();

	if (result.updateAvailable) {
		logger.info("system", `Update available: v${result.latestVersion}`);
	}

	return result;
}

export function normalizeTargetVersion(targetVersion: string | undefined): string | null {
	if (typeof targetVersion !== "string") return null;
	const trimmed = targetVersion.trim();
	if (!trimmed) return null;
	const normalized = trimmed.replace(/^v/i, "");
	if (!EXACT_SEMVER_PATTERN.test(normalized)) {
		return null;
	}
	return normalized;
}

export function parseInstalledPackageVersion(packageJsonContent: string): string | null {
	try {
		const parsed = JSON.parse(packageJsonContent) as { version?: unknown };
		if (typeof parsed.version !== "string") return null;
		const version = parsed.version.trim();
		if (!version) return null;
		return EXACT_SEMVER_PATTERN.test(version) ? version : null;
	} catch {
		return null;
	}
}

interface UpdateVerificationDeps {
	resolveGlobalPackagePath: (family: PackageManagerFamily, packageName: string) => string | undefined;
	existsSync: (path: string) => boolean;
	readFileSync: (path: string, encoding: BufferEncoding) => string;
}

export function verifyInstalledVersion(
	family: PackageManagerFamily,
	packageName: string,
	expectedVersion: string | null,
	deps: UpdateVerificationDeps = {
		resolveGlobalPackagePath: (family, packageName) => resolveGlobalPackagePath(family, packageName),
		existsSync: (path) => existsSync(path),
		readFileSync: (path, encoding) => readFileSync(path, { encoding }),
	},
): { ok: true; installedVersion: string } | { ok: false; message: string } {
	try {
		const packagePath = deps.resolveGlobalPackagePath(family, packageName);
		if (!packagePath) {
			return {
				ok: false,
				message: `Update exited cleanly but could not locate global package path for '${packageName}'`,
			};
		}

		const packageJsonPath = join(packagePath, "package.json");
		if (!deps.existsSync(packageJsonPath)) {
			return {
				ok: false,
				message: `Update exited cleanly but package manifest missing at ${packageJsonPath}`,
			};
		}

		const installedVersion = parseInstalledPackageVersion(deps.readFileSync(packageJsonPath, "utf-8"));
		if (!installedVersion) {
			return {
				ok: false,
				message: `Update exited cleanly but installed package.json has no valid version at ${packageJsonPath}`,
			};
		}

		if (expectedVersion && installedVersion !== expectedVersion) {
			return {
				ok: false,
				message: `Install exited cleanly but version is ${installedVersion}, expected ${expectedVersion}`,
			};
		}

		return {
			ok: true,
			installedVersion,
		};
	} catch (error) {
		return {
			ok: false,
			message: `Update exited cleanly but failed to verify installed version: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

export async function runUpdate(targetVersion?: string): Promise<UpdateRunResult> {
	assertInitialized();
	const normalizedTargetVersion = normalizeTargetVersion(targetVersion);
	if (targetVersion && !normalizedTargetVersion) {
		return {
			success: false,
			message: `Invalid targetVersion '${targetVersion}'`,
		};
	}

	if (updateInstallInProgress) {
		return {
			success: false,
			message: "Update already in progress",
		};
	}

	updateInstallInProgress = true;

	try {
		return await new Promise((resolve) => {
			const packageManager = resolvePrimaryPackageManager({
				agentsDir,
				env: process.env,
			});
			const installPackage = normalizedTargetVersion ? `${NPM_PACKAGE}@${normalizedTargetVersion}` : NPM_PACKAGE;
			const installCommand = getGlobalInstallCommand(packageManager.family, installPackage);

			logger.info("system", "Running update command", {
				command: `${installCommand.command} ${installCommand.args.join(" ")}`,
				family: packageManager.family,
				source: packageManager.source,
				reason: packageManager.reason,
			});

			const proc = spawn(installCommand.command, installCommand.args, {
				stdio: "pipe",
				windowsHide: true,
			});
			let stdout = "";
			let stderr = "";

			proc.stdout?.on("data", (d: Buffer) => {
				stdout += d.toString();
			});
			proc.stderr?.on("data", (d: Buffer) => {
				stderr += d.toString();
			});

			proc.on("close", (code) => {
				logger.info("update", "Update command exited", {
					exitCode: code ?? -1,
					command: `${installCommand.command} ${installCommand.args.join(" ")}`,
				});
				if (code === 0) {
					const verification = verifyInstalledVersion(packageManager.family, NPM_PACKAGE, normalizedTargetVersion);
					if (!verification.ok) {
						logger.warn("system", "Update verification failed", {
							reason: verification.message,
							family: packageManager.family,
						});
						resolve({
							success: false,
							message: verification.message,
							output: stdout + stderr,
						});
						return;
					}

					pendingRestartVersion = verification.installedVersion;
					lastUpdateCheck = null;
					lastUpdateCheckTime = null;

					logger.info("system", "Update installed successfully");
					resolve({
						success: true,
						message: "Update installed. Restart daemon to apply.",
						output: stdout,
						installedVersion: verification.installedVersion,
						restartRequired: true,
					});
				} else {
					logger.warn("system", "Update failed", { stderr });
					resolve({
						success: false,
						message: `Update failed: ${stderr || "Unknown error"}`,
						output: stdout + stderr,
					});
				}
			});

			proc.on("error", (e) => {
				resolve({
					success: false,
					message: `Update failed: ${e.message}`,
				});
			});
		});
	} finally {
		updateInstallInProgress = false;
	}
}

// ---------------------------------------------------------------------------
// Auto-update cycle
// ---------------------------------------------------------------------------

async function runAutoUpdateCycle(): Promise<void> {
	if (!updateConfig.autoInstall) {
		return;
	}

	if (updateCheckInProgress || updateInstallInProgress) {
		logger.info("update", "Auto-update cycle skipped — check or install already in progress");
		return;
	}

	updateCheckInProgress = true;
	logger.info("update", "Auto-update cycle started");

	try {
		const checkResult = await checkForUpdates();

		if (checkResult.checkError) {
			lastAutoUpdateError = categorizeUpdateError(checkResult.checkError);
			logger.warn("update", "Auto-update check returned error", {
				error: checkResult.checkError,
			});
			return;
		}

		logger.info("update", "Update check complete", {
			current: currentVersion,
			latest: checkResult.latestVersion ?? "unknown",
			updateAvailable: checkResult.updateAvailable,
		});

		if (!checkResult.updateAvailable || !checkResult.latestVersion) {
			logger.info("update", "No update available — skipping install");
			return;
		}

		if (isMajorUpgrade(currentVersion, checkResult.latestVersion)) {
			logger.warn("update", "Major upgrade available — skipping auto-install (manual install required)", {
				current: currentVersion,
				latest: checkResult.latestVersion,
			});
			lastAutoUpdateError = "Major version upgrade requires manual install";
			return;
		}

		logger.info("update", `Auto-installing update v${checkResult.latestVersion}`);
		const installResult = await runUpdate(checkResult.latestVersion);

		if (installResult.success) {
			lastAutoUpdateAt = new Date();
			lastAutoUpdateError = null;
			logger.info("update", `Auto-update installed v${checkResult.latestVersion}. Triggering daemon restart.`);

			stopUpdateTimer();

			if (restartCallback) {
				logger.info("update", "Invoking restart callback to spawn replacement daemon");
				restartCallback();
			} else {
				// Fallback: clean exit — systemd/launchd Restart=always will respawn.
				// Without a restart callback, the daemon simply exits.
				logger.warn("update", "No restart callback registered — exiting and relying on service manager to restart");
				setTimeout(() => {
					process.exit(0);
				}, 500);
			}
			return;
		}

		lastAutoUpdateError = categorizeUpdateError(installResult.message);
		logger.warn("update", "Auto-update install failed", {
			error: installResult.message,
		});
	} catch (e) {
		lastAutoUpdateError = categorizeUpdateError((e as Error).message);
		logger.warn("update", "Auto-update cycle failed", {
			error: lastAutoUpdateError,
		});
	} finally {
		updateCheckInProgress = false;
	}
}

// ---------------------------------------------------------------------------
// Timer management
// ---------------------------------------------------------------------------

export function startUpdateTimer(): void {
	assertInitialized();

	if (updateTimer) {
		clearInterval(updateTimer);
	}

	if (!updateConfig.autoInstall || updateConfig.checkInterval <= 0) {
		logger.info("system", "Auto-updates not enabled. Run `signet update enable` to enable.");
		return;
	}

	logger.info(
		"update",
		`Update timer started: checking every ${updateConfig.checkInterval}s, autoInstall=${updateConfig.autoInstall}, channel=${updateConfig.channel}`,
	);

	void runAutoUpdateCycle();

	updateTimer = setInterval(() => {
		void runAutoUpdateCycle();
	}, updateConfig.checkInterval * 1000);
}

export function stopUpdateTimer(): void {
	if (updateTimer) {
		clearInterval(updateTimer);
		updateTimer = null;
	}
}

// ---------------------------------------------------------------------------
// Config mutation (used by route handler)
// ---------------------------------------------------------------------------

export function setUpdateConfig(patch: {
	autoInstall?: boolean;
	checkInterval?: number;
}): { config: UpdateConfig; persisted: boolean } {
	if (patch.autoInstall !== undefined) {
		updateConfig.autoInstall = patch.autoInstall;
	}
	if (patch.checkInterval !== undefined) {
		updateConfig.checkInterval = patch.checkInterval;
	}

	stopUpdateTimer();
	if (updateConfig.autoInstall) {
		startUpdateTimer();
	}

	const persisted = persistUpdateConfig(updateConfig);
	return { config: { ...updateConfig }, persisted };
}
