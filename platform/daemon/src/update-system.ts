/**
 * Singleton update system — extracted from daemon.ts for observability.
 *
 * Pattern: init once in main(), get from anywhere (like llm.ts,
 * db-accessor.ts).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type PackageManagerFamily,
	type SignetInstallMethod,
	type SignetInstallationReport,
	type SignetUpdateTarget,
	type WorkspaceSourceRepoSyncResult,
	detectSignetInstallations,
	parseSimpleYaml,
	resolveGlobalPackagePath,
	resolvePrimaryPackageManager,
	syncWorkspaceSourceRepoAsync,
} from "@signet/core";
import { logger } from "./logger";
import {
	UPDATE_INSTALL_TIMEOUT_MS,
	type UpdateInstallDeps,
	type UpdateInstallErrorCode,
	UpdateInstallFailure,
	type UpdateProcessOptions,
	type UpdateProcessResult,
	VERSION_VERIFY_TIMEOUT_MS,
	cliSubprocessEnvironment,
	clipUpdateOutput,
	installUpdateTarget,
	normalizeExactSemver,
	remainingUpdateTimeout,
	runUpdateProcess,
	verifyExecutableVersion,
} from "./update-install";
import { compareVersions, isMajorUpgrade, isVersionNewer } from "./version";

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

export interface UpdateRunSuccess {
	readonly success: true;
	readonly message: string;
	readonly output?: string;
	readonly installedVersion: string;
	readonly restartRequired: boolean;
	readonly installMethod: SignetInstallMethod;
	readonly activeExecutablePath: string;
	readonly activeExecutableVerified: true;
	readonly observedVersion: string;
	readonly desktopUpdate?: DesktopUpdateResult;
}

export interface UpdateRunFailure {
	readonly success: false;
	readonly message: string;
	readonly output?: string;
	readonly restartRequired: false;
	readonly errorCode: UpdateInstallErrorCode;
	readonly installMethod?: SignetInstallMethod;
	readonly activeExecutablePath?: string;
	readonly activeExecutableVerified: boolean;
	readonly observedVersion?: string;
}

export type UpdateRunResult = UpdateRunSuccess | UpdateRunFailure;

export type UpdateChannel = "stable" | "nightly";

export interface UpdateConfig {
	autoInstall: boolean;
	checkInterval: number; // seconds
	channel: UpdateChannel;
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
	draft?: boolean;
	prerelease?: boolean;
}

export type DesktopUpdateStatus = "updated" | "skipped" | "error";

export interface DesktopUpdateResult {
	readonly status: DesktopUpdateStatus;
	readonly message: string;
	readonly output?: string;
}

export interface DesktopInstallDetection {
	readonly installed: boolean;
	readonly managed: boolean;
	readonly launcherPath: string;
	readonly appImagePath: string;
	readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITHUB_REPO = "Signet-AI/signetai";
const NPM_PACKAGE = "signetai";
const CHANNEL_TO_NPM_TAG: Record<UpdateChannel, "latest" | "next"> = {
	stable: "latest",
	nightly: "next",
};
const MANAGED_DESKTOP_LAUNCHER_MARKER = "# signet-desktop managed launcher";

export const MIN_UPDATE_INTERVAL_SECONDS = 300;
export const MAX_UPDATE_INTERVAL_SECONDS = 604800;
export const DESKTOP_UPDATE_TIMEOUT_MS = 15 * 60_000;
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
	channel: "stable" as const,
};
let restartCallback: ((preferredExecutablePath?: string) => void) | null = null;

// ---------------------------------------------------------------------------
// Init / accessors
// ---------------------------------------------------------------------------

export function initUpdateSystem(
	version: string,
	dir: string,
	onRestartNeeded?: (preferredExecutablePath?: string) => void,
): void {
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
		return `Signet v${pendingRestartVersion} is installed but needs a daemon restart. Run:\n  signet daemon restart\n  signet sync\n\nThese are the ONLY supported post-update commands.`;
	}

	if (lastAutoUpdateError && updateConfig.autoInstall) {
		const categorized = categorizeUpdateError(lastAutoUpdateError);
		return `Auto-updates are enabled but failing: ${categorized} Run \`signet update status\` for details.`;
	}

	const latest = lastUpdateCheck?.latestVersion;
	if (lastUpdateCheck?.updateAvailable && latest) {
		const notes = lastUpdateCheck.releaseNotes ? `\n\nWhat's new:\n${lastUpdateCheck.releaseNotes}` : "";

		if (updateConfig.autoInstall) {
			const autoInfo = lastAutoUpdateAt ? ` Last auto-update: ${lastAutoUpdateAt.toISOString()}.` : "";
			return `Signet v${latest} is available (current: v${currentVersion}). Auto-update will install it on the next check cycle.${autoInfo}${notes}`;
		}

		return `Signet v${latest} is available (current: v${currentVersion}).\n\nTo update the active Signet installation:\n  signet update install\n  signet daemon restart\n  signet sync${notes}`;
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

export function parseUpdateChannel(value: unknown): UpdateChannel | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "stable" || normalized === "latest") return "stable";
	if (normalized === "nightly" || normalized === "next") return "nightly";
	return null;
}

export function npmTagForUpdateChannel(channel: UpdateChannel): "latest" | "next" {
	return CHANNEL_TO_NPM_TAG[channel];
}

function loadUpdateConfig(): UpdateConfig {
	const defaults: UpdateConfig = {
		autoInstall: false,
		checkInterval: DEFAULT_UPDATE_INTERVAL_SECONDS,
		channel: "stable" as const,
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

				const channel = parseUpdateChannel(updates.channel);
				if (channel !== null) {
					defaults.channel = channel;
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
	return `updates:\n  auto_install: ${config.autoInstall}\n  check_interval: ${config.checkInterval}\n  channel: ${config.channel}\n`;
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

async function fetchStableFromGitHub(): Promise<{
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
	if (data.draft || data.prerelease) {
		throw new Error("GitHub latest release is not stable");
	}
	const version = data.tag_name.replace(/^v/, "");

	return {
		version,
		releaseUrl: data.html_url,
		releaseNotes: data.body?.slice(0, 500),
		publishedAt: data.published_at,
	};
}

async function fetchLatestFromNpm(channel: UpdateChannel = "stable"): Promise<string> {
	const tag = npmTagForUpdateChannel(channel);
	const npmRes = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/${tag}`, {
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

	if (updateConfig.channel === "stable") {
		try {
			const github = await fetchStableFromGitHub();
			result.latestVersion = github.version;
			result.releaseUrl = github.releaseUrl;
			result.releaseNotes = github.releaseNotes;
			result.publishedAt = github.publishedAt;
		} catch (e) {
			errors.push((e as Error).message);
		}
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
	return normalizeExactSemver(targetVersion);
}

interface FinalizeSuccessfulUpdateDeps {
	syncWorkspaceSourceRepoAsync?: (workspaceDir: string) => Promise<WorkspaceSourceRepoSyncResult>;
	updateDesktopInstallAfterUpdate?: (
		repoSync: WorkspaceSourceRepoSyncResult,
		installedVersion: string,
		activeExecutablePath: string,
	) => Promise<DesktopUpdateResult>;
	/** Lifecycle hook (issue #1026 Phase 2): fired with (from, to) after a
	 *  successful install so the daemon can emit `version.upgraded`. */
	onUpgraded?: (from: string, to: string) => void;
}

interface SuccessfulUpdateMetadata {
	readonly installMethod: SignetInstallMethod;
	readonly activeExecutablePath: string;
}

interface RunUpdateDeps extends UpdateInstallDeps {
	readonly detectInstallations?: () => SignetInstallationReport;
	readonly finalizeSuccessfulUpdate?: typeof finalizeSuccessfulUpdateInstall;
	/** Lifecycle hook (issue #1026 Phase 2): (from, to) after a successful
	 *  install; forwarded into finalizeSuccessfulUpdateInstall. */
	readonly onUpgraded?: (from: string, to: string) => void;
}

function updateFailure(
	errorCode: UpdateInstallErrorCode,
	message: string,
	options: {
		readonly output?: string;
		readonly installMethod?: SignetInstallMethod;
		readonly activeExecutablePath?: string;
		readonly activeExecutableVerified?: boolean;
		readonly observedVersion?: string;
	} = {},
): UpdateRunFailure {
	return {
		success: false,
		message,
		restartRequired: false,
		errorCode,
		activeExecutableVerified: options.activeExecutableVerified ?? false,
		...(options.output ? { output: options.output } : {}),
		...(options.installMethod ? { installMethod: options.installMethod } : {}),
		...(options.activeExecutablePath ? { activeExecutablePath: options.activeExecutablePath } : {}),
		...(options.observedVersion ? { observedVersion: options.observedVersion } : {}),
	};
}

/**
 * When a package-manager daemon coexists with a direct native install, keep
 * the native installation authoritative. This is the common mixed-install
 * shape where npm is needed for `signet-mcp` but should not own Signet updates.
 */
export function selectUpdateTarget(report: SignetInstallationReport): SignetUpdateTarget {
	if (report.target.kind !== "package-manager") return report.target;

	const native = report.inactive.find((installation) => installation.method === "native");
	return native ? { kind: "native", executablePath: native.executablePath } : report.target;
}

interface DesktopInstallDetectionDeps {
	readonly existsSync: (path: string) => boolean;
	readonly readFileSync: (path: string, encoding: BufferEncoding) => string;
}

interface DesktopUpdateDeps {
	readonly home?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly execPath?: string;
	readonly signetCliPath?: string;
	readonly timeoutMs?: number;
	readonly existsSync?: (path: string) => boolean;
	readonly readFileSync?: (path: string, encoding: BufferEncoding) => string;
	readonly resolveGlobalPackagePath?: (family: PackageManagerFamily, packageName: string) => string | undefined;
	readonly resolvePrimaryPackageManager?: typeof resolvePrimaryPackageManager;
	readonly runCommand?: (
		command: string,
		args: readonly string[],
		options: UpdateProcessOptions,
	) => Promise<UpdateProcessResult>;
}

export function detectDesktopInstall(
	home = homedir(),
	deps: DesktopInstallDetectionDeps = {
		existsSync: (path) => existsSync(path),
		readFileSync: (path, encoding) => readFileSync(path, { encoding }),
	},
): DesktopInstallDetection {
	const launcherPath = join(home, ".local", "bin", "signet-desktop");
	const appImagePath = join(home, ".local", "share", "signet", "desktop", "Signet.AppImage");
	const launcherExists = deps.existsSync(launcherPath);
	const appImageExists = deps.existsSync(appImagePath);

	if (!launcherExists && !appImageExists) {
		return {
			installed: false,
			managed: false,
			launcherPath,
			appImagePath,
			reason: "Signet desktop app is not installed",
		};
	}

	if (!launcherExists) {
		return {
			installed: true,
			managed: false,
			launcherPath,
			appImagePath,
			reason: "Signet desktop AppImage exists without a managed launcher",
		};
	}

	try {
		const launcher = deps.readFileSync(launcherPath, "utf-8");
		return {
			installed: true,
			managed: launcher.includes(MANAGED_DESKTOP_LAUNCHER_MARKER),
			launcherPath,
			appImagePath,
			reason: launcher.includes(MANAGED_DESKTOP_LAUNCHER_MARKER)
				? "managed Signet desktop launcher found"
				: "existing signet-desktop launcher is not managed by Signet",
		};
	} catch (error) {
		return {
			installed: true,
			managed: false,
			launcherPath,
			appImagePath,
			reason: `could not read Signet desktop launcher: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function canUpdateDesktopFromSourceSync(status: WorkspaceSourceRepoSyncResult["status"]): boolean {
	return status === "cloned" || status === "pulled" || status === "current";
}

export async function updateDesktopInstallAfterUpdate(
	repoSync: WorkspaceSourceRepoSyncResult,
	installedVersion: string,
	deps: DesktopUpdateDeps = {},
): Promise<DesktopUpdateResult> {
	const fsDeps = {
		existsSync: deps.existsSync ?? ((path: string) => existsSync(path)),
		readFileSync: deps.readFileSync ?? ((path: string, encoding: BufferEncoding) => readFileSync(path, { encoding })),
	};
	const desktop = detectDesktopInstall(deps.home ?? homedir(), fsDeps);
	if (!desktop.installed) {
		return { status: "skipped", message: desktop.reason ?? "Signet desktop app is not installed" };
	}
	if (!desktop.managed) {
		return {
			status: "skipped",
			message: `${desktop.reason ?? "Signet desktop install is not managed"}. Skipping automatic desktop update.`,
		};
	}
	if (!canUpdateDesktopFromSourceSync(repoSync.status)) {
		return {
			status: "skipped",
			message: `Signet desktop update skipped because source checkout sync status was '${repoSync.status}': ${repoSync.message}`,
		};
	}

	const env = deps.env ?? process.env;
	let command: string;
	let args: string[];
	if (deps.signetCliPath) {
		if (!fsDeps.existsSync(deps.signetCliPath)) {
			return {
				status: "error",
				message: `Active Signet executable is missing at ${deps.signetCliPath}`,
			};
		}
		command = deps.signetCliPath;
		args = ["desktop", "install", "--repo", repoSync.path];
	} else {
		const packageManager = (deps.resolvePrimaryPackageManager ?? resolvePrimaryPackageManager)({
			agentsDir,
			env,
		});
		const packagePath = (deps.resolveGlobalPackagePath ?? resolveGlobalPackagePath)(packageManager.family, NPM_PACKAGE);
		if (!packagePath) {
			return {
				status: "error",
				message: "Could not locate the installed signetai package to run desktop update",
			};
		}

		const signetBin = join(packagePath, "bin", "signet.js");
		if (!fsDeps.existsSync(signetBin)) {
			return {
				status: "error",
				message: `Installed signetai package is missing CLI entrypoint at ${signetBin}`,
			};
		}
		command = deps.execPath ?? process.execPath;
		args = [signetBin, "desktop", "install", "--repo", repoSync.path];
	}
	const result = await (deps.runCommand ?? runUpdateProcess)(command, args, {
		cwd: repoSync.path,
		env: cliSubprocessEnvironment({
			...env,
			SIGNET_SOURCE_DIR: repoSync.path,
		}),
		timeoutMs: deps.timeoutMs ?? DESKTOP_UPDATE_TIMEOUT_MS,
	});
	const output = clipUpdateOutput(`${result.stdout}\n${result.stderr}`);

	if (result.exitCode !== 0) {
		const cause = result.timedOut
			? result.errorMessage
			: (result.errorMessage ?? `exit ${result.exitCode ?? "unknown"}`);
		return {
			status: "error",
			message: `Signet desktop update failed after installing v${installedVersion}: ${cause}`,
			output,
		};
	}

	return {
		status: "updated",
		message: `Signet desktop app updated to v${installedVersion}.`,
		output,
	};
}

export async function finalizeSuccessfulUpdateInstall(
	installedVersion: string,
	stdout: string,
	metadata: SuccessfulUpdateMetadata,
	deps: FinalizeSuccessfulUpdateDeps = {
		syncWorkspaceSourceRepoAsync: (workspaceDir) => syncWorkspaceSourceRepoAsync(workspaceDir),
		updateDesktopInstallAfterUpdate: (repoSync, version, activeExecutablePath) =>
			updateDesktopInstallAfterUpdate(repoSync, version, {
				signetCliPath: activeExecutablePath,
			}),
	},
): Promise<UpdateRunResult> {
	pendingRestartVersion = installedVersion;
	lastUpdateCheck = null;
	lastUpdateCheckTime = null;

	let repoSync: WorkspaceSourceRepoSyncResult;
	try {
		repoSync = await (
			deps.syncWorkspaceSourceRepoAsync ?? ((workspaceDir) => syncWorkspaceSourceRepoAsync(workspaceDir))
		)(agentsDir);
	} catch (error) {
		repoSync = {
			status: "error",
			path: join(agentsDir, "signetai"),
			message: `Signet source checkout sync threw after update: ${error instanceof Error ? error.message : String(error)}`,
			branch: null,
			defaultBranch: null,
		};
	}
	if (repoSync.status === "error") {
		logger.warn("system", "Workspace Signet source checkout sync failed after update", {
			path: repoSync.path,
			message: repoSync.message,
		});
	} else if (repoSync.status !== "current") {
		logger.info("system", "Workspace Signet source checkout sync result", {
			path: repoSync.path,
			status: repoSync.status,
			message: repoSync.message,
		});
	}

	const desktopUpdater =
		deps.updateDesktopInstallAfterUpdate ??
		((repoSyncResult, version, activeExecutablePath) =>
			updateDesktopInstallAfterUpdate(repoSyncResult, version, {
				signetCliPath: activeExecutablePath,
			}));
	let desktopUpdate: DesktopUpdateResult;
	try {
		desktopUpdate = await desktopUpdater(repoSync, installedVersion, metadata.activeExecutablePath);
	} catch (error) {
		desktopUpdate = {
			status: "error",
			message: `Signet desktop update threw after installing v${installedVersion}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (desktopUpdate.status === "updated") {
		logger.info("update", desktopUpdate.message);
	} else if (desktopUpdate.status === "error") {
		logger.warn("update", desktopUpdate.message);
	} else {
		logger.info("update", desktopUpdate.message);
	}

	logger.info("system", "Update installed successfully");
	deps.onUpgraded?.(currentVersion, installedVersion);
	return {
		success: true,
		message: "Update installed. Restart daemon to apply.",
		output: stdout,
		installedVersion,
		restartRequired: true,
		installMethod: metadata.installMethod,
		activeExecutablePath: metadata.activeExecutablePath,
		activeExecutableVerified: true,
		observedVersion: installedVersion,
		desktopUpdate,
	};
}

export async function runUpdate(targetVersion?: string, deps: RunUpdateDeps = {}): Promise<UpdateRunResult> {
	assertInitialized();
	let normalizedTargetVersion = normalizeTargetVersion(targetVersion);
	if (targetVersion !== undefined && !normalizedTargetVersion) {
		return updateFailure("invalid_target_version", `Invalid targetVersion '${targetVersion}'`);
	}

	if (updateInstallInProgress) {
		return updateFailure("update_in_progress", "Update already in progress");
	}

	updateInstallInProgress = true;
	try {
		if (!normalizedTargetVersion) {
			const check = await checkForUpdates();
			normalizedTargetVersion = check.latestVersion;
		}
		if (!normalizedTargetVersion) {
			return updateFailure("no_target_version", "Update failed: no target version available");
		}

		const report = (deps.detectInstallations ?? (() => detectSignetInstallations()))();
		const target = selectUpdateTarget(report);
		if (target.kind === "unsupported") {
			return updateFailure(
				"unsupported_installation",
				`${target.reason}. Install Signet with the native installer or a supported package-manager wrapper before updating.`,
				{ activeExecutablePath: target.executablePath },
			);
		}

		const installMethod: SignetInstallMethod = target.kind === "native" ? "native" : target.family;
		const deadline = Date.now() + UPDATE_INSTALL_TIMEOUT_MS;
		logger.info("update", "Installing update for active executable", {
			version: normalizedTargetVersion,
			installMethod,
			activeExecutablePath: target.executablePath,
		});

		let output = "";
		try {
			output = await installUpdateTarget(
				target,
				normalizedTargetVersion,
				deadline,
				{ packageName: NPM_PACKAGE, githubRepo: GITHUB_REPO },
				deps,
			);
		} catch (error) {
			const code = error instanceof UpdateInstallFailure ? error.code : "install_failed";
			const message = error instanceof Error ? error.message : String(error);
			logger.warn("update", "Update install failed", {
				errorCode: code,
				message,
				installMethod,
				activeExecutablePath: target.executablePath,
			});
			return updateFailure(code, message, {
				output,
				installMethod,
				activeExecutablePath: target.executablePath,
			});
		}

		let verification: Awaited<ReturnType<typeof verifyExecutableVersion>>;
		try {
			verification = await verifyExecutableVersion(target.executablePath, normalizedTargetVersion, {
				runCommand: deps.runCommand,
				env: deps.env ?? process.env,
				platform: deps.platform,
				timeoutMs: Math.min(VERSION_VERIFY_TIMEOUT_MS, remainingUpdateTimeout(deadline)),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return updateFailure("verification_failed", message, {
				output,
				installMethod,
				activeExecutablePath: target.executablePath,
			});
		}
		if (!verification.ok) {
			logger.warn("update", "Active executable verification failed", {
				reason: verification.message,
				installMethod,
				activeExecutablePath: target.executablePath,
			});
			return updateFailure("verification_failed", verification.message, {
				output,
				installMethod,
				activeExecutablePath: target.executablePath,
				observedVersion: verification.observedVersion,
			});
		}

		try {
			const finalizer = deps.finalizeSuccessfulUpdate ?? finalizeSuccessfulUpdateInstall;
			return await finalizer(
				verification.installedVersion,
				output,
				{
					installMethod,
					activeExecutablePath: target.executablePath,
				},
				{
					onUpgraded: deps.onUpgraded,
				},
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn("update", "Update post-install handling failed", {
				message,
				installMethod,
				activeExecutablePath: target.executablePath,
			});
			return updateFailure(
				"post_install_failed",
				`Update installed and verified, but post-install handling failed: ${message}`,
				{
					output,
					installMethod,
					activeExecutablePath: target.executablePath,
					activeExecutableVerified: true,
					observedVersion: verification.installedVersion,
				},
			);
		}
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
				restartCallback(installResult.success ? installResult.activeExecutablePath : undefined);
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
	channel?: UpdateChannel;
}): { config: UpdateConfig; persisted: boolean } {
	if (patch.autoInstall !== undefined) {
		updateConfig.autoInstall = patch.autoInstall;
	}
	if (patch.checkInterval !== undefined) {
		updateConfig.checkInterval = patch.checkInterval;
	}
	if (patch.channel !== undefined) {
		updateConfig.channel = patch.channel;
		lastUpdateCheck = null;
		lastUpdateCheckTime = null;
	}

	stopUpdateTimer();
	if (updateConfig.autoInstall) {
		startUpdateTimer();
	}

	const persisted = persistUpdateConfig(updateConfig);
	return { config: { ...updateConfig }, persisted };
}
