/**
 * Service-management compatibility adapter owned by scripts.
 *
 * This preserves the existing service-manager behavior while making the
 * production script independent of platform/daemon runtime code.
 */
/**
 * Signet Daemon Service Installation
 * Handles systemd (Linux), launchd (macOS), and Windows service management
 */

import { execSync as nodeExecSync, spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { resolveFreshRustDaemon } from "./fresh-rust-daemon";

const LOOPBACK_HOST = "127.0.0.1";
const AGENTS_DIR =
	process.env.SIGNET_PATH?.trim() || process.env.SIGNET_WORKSPACE?.trim() || join(homedir(), ".agents");
const DAEMON_DIR = join(AGENTS_DIR, ".daemon");
const PID_FILE = join(DAEMON_DIR, "pid");
const LOG_DIR = join(DAEMON_DIR, "logs");
const DAEMON_PORT = 3850;
const HEALTH_PROBE_TIMEOUT_MS = 1_200;
const HEALTH_PROBE_URL = `http://${LOOPBACK_HOST}:${DAEMON_PORT}/health/live`;

// Platform-specific paths
const LAUNCHD_PLIST = join(homedir(), "Library", "LaunchAgents", "ai.signet.daemon.plist");
const SYSTEMD_UNIT = join(homedir(), ".config", "systemd", "user", "signet.service");

const execSync = (command: string, options?: Parameters<typeof nodeExecSync>[1]) =>
	nodeExecSync(command, { ...options, windowsHide: true });
const spawn = (command: string, args: string[], options: Parameters<typeof nodeSpawn>[2]) =>
	nodeSpawn(command, args, { ...options, windowsHide: true, shell: false });

function xmlEscape(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function buildLaunchdEnvironment(input: { values?: Record<string, string> }): Record<string, string> {
	return { ...input.values, HOME: homedir(), PATH: process.env.PATH ?? "" };
}

function buildLaunchdPlist(input: {
	label: string;
	programArguments: readonly string[];
	environment: Readonly<Record<string, string>>;
	workingDirectory: string;
	standardOutPath: string;
	standardErrorPath: string;
}): string {
	const args = input.programArguments.map((arg) => `\n\t\t<string>${xmlEscape(arg)}</string>`).join("");
	const environment = Object.entries(input.environment)
		.map(([key, value]) => `\n\t\t<key>${xmlEscape(key)}</key>\n\t\t<string>${xmlEscape(value)}</string>`)
		.join("");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n\t<key>Label</key><string>${xmlEscape(input.label)}</string>\n\t<key>ProgramArguments</key><array>${args}\n\t</array>\n\t<key>EnvironmentVariables</key><dict>${environment}\n\t</dict>\n\t<key>WorkingDirectory</key><string>${xmlEscape(input.workingDirectory)}</string>\n\t<key>RunAtLoad</key><true/>\n\t<key>KeepAlive</key><true/>\n\t<key>StandardOutPath</key><string>${xmlEscape(input.standardOutPath)}</string>\n\t<key>StandardErrorPath</key><string>${xmlEscape(input.standardErrorPath)}</string>\n</dict></plist>\n`;
}

function formatWorkspacePreflightError(): string {
	return `Signet cannot start: workspace at ${AGENTS_DIR} is missing required configuration or database. Restore the workspace or run explicit setup; Signet will not recreate it.`;
}

export type ServiceHealthStatus = "healthy" | "degraded" | "unavailable";

export interface ServiceStatus {
	installed: boolean;
	running: boolean;
	pid: number | null;
	uptime: number | null;
	port: number;
	/** The management probe status; a running process can still be degraded. */
	status: ServiceHealthStatus;
}

interface HealthProbeResult {
	status: ServiceHealthStatus;
	uptime: number | null;
	pid: number | null;
}

/**
 * Probe only daemon liveness. Service management does not need the database
 * work performed by the full `/health` endpoint, and the deadline prevents
 * a wedged local daemon from blocking status callers indefinitely.
 */
export async function probeDaemonHealth(
	fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Promise<HealthProbeResult> {
	try {
		const request = fetcher ?? globalThis.fetch;
		if (typeof request !== "function") {
			return { status: "degraded", uptime: null, pid: null };
		}

		const response = await request(HEALTH_PROBE_URL, {
			signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
		});
		if (!response.ok) {
			return { status: "degraded", uptime: null, pid: null };
		}

		const body = await response.json();
		if (typeof body !== "object" || body === null) {
			return { status: "degraded", uptime: null, pid: null };
		}

		const uptime =
			"uptime" in body && typeof body.uptime === "number" && Number.isFinite(body.uptime) && body.uptime >= 0
				? body.uptime
				: null;
		const pid =
			"pid" in body && typeof body.pid === "number" && Number.isInteger(body.pid) && body.pid > 0 ? body.pid : null;
		const status = "status" in body && body.status === "shutting_down" ? "degraded" : "healthy";
		return { status, uptime, pid };
	} catch {
		return { status: "degraded", uptime: null, pid: null };
	}
}

/** Resolve only the packaged/current Rust daemon; never fall back to TypeScript. */
function getDaemonPath(): string {
	return resolveFreshRustDaemon(process.env.SIGNET_DIR ?? process.cwd(), process.env);
}

function resolveDaemonLaunchCommand(daemonPath: string): string[] {
	if (/\.(?:js|ts|mjs|cjs)$/i.test(daemonPath)) throw new Error("Native Signet daemon executable is required.");
	return [daemonPath];
}

function assertInstalledServiceUsesDaemon(servicePath: string, daemonPath: string, marker: string): void {
	if (!existsSync(servicePath)) return;
	const service = readFileSync(servicePath, "utf-8");
	if (!service.includes(marker) || !service.includes(daemonPath)) {
		throw new Error(
			`Installed Signet service does not point to the packaged native daemon at ${daemonPath}. Reinstall the service.`,
		);
	}
}

// ============================================================================
// macOS (launchd)
// ============================================================================

export function generateLaunchdPlist(port: number = 3850): string {
	const daemonPath = getDaemonPath();
	const startupTimeout = process.env.SIGNET_DB_OWNER_START_TIMEOUT_MS;
	const environment = buildLaunchdEnvironment({
		values: {
			SIGNET_PORT: String(port),
			SIGNET_PATH: AGENTS_DIR,
			...(startupTimeout === undefined ? {} : { SIGNET_DB_OWNER_START_TIMEOUT_MS: startupTimeout }),
		},
	});
	return buildLaunchdPlist({
		label: "ai.signet.daemon",
		programArguments: resolveDaemonLaunchCommand(daemonPath),
		environment,
		workingDirectory: AGENTS_DIR,
		standardOutPath: join(LOG_DIR, "daemon.out.log"),
		standardErrorPath: join(LOG_DIR, "daemon.err.log"),
	});
}

async function installLaunchd(port: number = 3850): Promise<void> {
	const plistDir = join(homedir(), "Library", "LaunchAgents");
	mkdirSync(plistDir, { recursive: true });
	mkdirSync(LOG_DIR, { recursive: true });

	// Unload if already loaded
	try {
		execSync(`launchctl unload "${LAUNCHD_PLIST}" 2>/dev/null`);
	} catch {
		// Ignore - might not be loaded
	}

	// Write plist
	writeFileSync(LAUNCHD_PLIST, generateLaunchdPlist(port));

	// Load the service
	execSync(`launchctl load "${LAUNCHD_PLIST}"`);
}

async function uninstallLaunchd(): Promise<void> {
	if (!existsSync(LAUNCHD_PLIST)) {
		return;
	}

	try {
		execSync(`launchctl unload "${LAUNCHD_PLIST}"`);
	} catch {
		// Ignore
	}

	unlinkSync(LAUNCHD_PLIST);
}

function isLaunchdRunning(): boolean {
	try {
		const output = execSync("launchctl list ai.signet.daemon 2>/dev/null", {
			encoding: "utf-8",
		});
		return !output.includes("Could not find");
	} catch {
		return false;
	}
}

// ============================================================================
// Linux (systemd)
// ============================================================================

function resolveRuntimePath(): string {
	return getDaemonPath();
}

export function generateSystemdUnit(port: number = 3850): string {
	const runtimePath = resolveRuntimePath();

	return `[Unit]
Description=Signet Daemon
After=network.target

[Service]
Type=simple
ExecStart=${runtimePath}
Environment=SIGNET_PORT=${port}
Environment=SIGNET_PATH=${AGENTS_DIR}
WorkingDirectory=${AGENTS_DIR}
Restart=always
RestartSec=5

StandardOutput=append:${LOG_DIR}/daemon.out.log
StandardError=append:${LOG_DIR}/daemon.err.log

[Install]
WantedBy=default.target
`;
}

async function installSystemd(port: number = 3850): Promise<void> {
	const unitDir = join(homedir(), ".config", "systemd", "user");
	mkdirSync(unitDir, { recursive: true });
	mkdirSync(LOG_DIR, { recursive: true });

	// Stop if running
	try {
		execSync("systemctl --user stop signet.service 2>/dev/null");
	} catch {
		// Ignore
	}

	// Write unit file
	writeFileSync(SYSTEMD_UNIT, generateSystemdUnit(port));

	// Reload systemd
	execSync("systemctl --user daemon-reload");

	// Enable and start
	execSync("systemctl --user enable signet.service");
	execSync("systemctl --user start signet.service");
}

async function uninstallSystemd(): Promise<void> {
	try {
		execSync("systemctl --user stop signet.service 2>/dev/null");
		execSync("systemctl --user disable signet.service 2>/dev/null");
	} catch {
		// Ignore
	}

	if (existsSync(SYSTEMD_UNIT)) {
		unlinkSync(SYSTEMD_UNIT);
	}

	try {
		execSync("systemctl --user daemon-reload");
	} catch {
		// Ignore
	}
}

function isSystemdRunning(): boolean {
	try {
		const output = execSync("systemctl --user is-active signet.service 2>/dev/null", { encoding: "utf-8" });
		return String(output).trim() === "active";
	} catch {
		return false;
	}
}

// ============================================================================
// Direct Native Process Management
// ============================================================================

function assertWorkspaceStartable(): void {
	if (!existsSync(AGENTS_DIR)) {
		throw new Error(formatWorkspacePreflightError());
	}
}

async function startDirect(port: number = 3850): Promise<number> {
	assertWorkspaceStartable();
	mkdirSync(DAEMON_DIR, { recursive: true });
	mkdirSync(LOG_DIR, { recursive: true });

	const daemonPath = getDaemonPath();

	const proc = spawn(daemonPath, [], {
		detached: true,
		stdio: "ignore",
		env: {
			...process.env,
			SIGNET_PORT: port.toString(),
			SIGNET_PATH: AGENTS_DIR,
		},
	});

	proc.unref();

	// Wait a moment for PID file to be written
	await new Promise((resolve) => setTimeout(resolve, 500));

	return proc.pid || 0;
}

async function stopDirect(): Promise<void> {
	if (!existsSync(PID_FILE)) {
		return;
	}

	const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);

	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Process might already be dead
	}

	// Clean up PID file
	try {
		unlinkSync(PID_FILE);
	} catch {
		// Ignore
	}
}

function isDirectRunning(): boolean {
	if (!existsSync(PID_FILE)) {
		return false;
	}

	const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);

	try {
		process.kill(pid, 0);
		return true;
	} catch {
		// Process doesn't exist, clean up stale PID file
		try {
			unlinkSync(PID_FILE);
		} catch {
			// Ignore
		}
		return false;
	}
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Install the daemon as a system service
 */
export async function installService(port: number = 3850): Promise<void> {
	const os = platform();

	if (os === "darwin") {
		await installLaunchd(port);
	} else if (os === "linux") {
		await installSystemd(port);
	} else {
		// Windows or other - just start directly
		await startDirect(port);
	}
}

/**
 * Uninstall the daemon system service
 */
export async function uninstallService(): Promise<void> {
	const os = platform();

	if (os === "darwin") {
		await uninstallLaunchd();
	} else if (os === "linux") {
		await uninstallSystemd();
	}

	// Always stop direct process too
	await stopDirect();
}

/**
 * Start the daemon
 */
export async function startDaemon(port: number = 3850): Promise<void> {
	assertWorkspaceStartable();
	const daemonPath = getDaemonPath();
	const os = platform();

	if (os === "darwin" && existsSync(LAUNCHD_PLIST)) {
		assertInstalledServiceUsesDaemon(LAUNCHD_PLIST, daemonPath, "<key>ProgramArguments</key>");
		execSync(`launchctl load "${LAUNCHD_PLIST}"`);
	} else if (os === "linux" && existsSync(SYSTEMD_UNIT)) {
		assertInstalledServiceUsesDaemon(SYSTEMD_UNIT, daemonPath, "ExecStart=");
		execSync("systemctl --user start signet.service");
	} else {
		await startDirect(port);
	}
}

/**
 * Stop the daemon
 */
export async function stopDaemon(): Promise<void> {
	const os = platform();

	if (os === "darwin" && existsSync(LAUNCHD_PLIST)) {
		try {
			execSync(`launchctl unload "${LAUNCHD_PLIST}"`);
		} catch {
			// Might not be loaded
		}
	} else if (os === "linux" && existsSync(SYSTEMD_UNIT)) {
		try {
			execSync("systemctl --user stop signet.service");
		} catch {
			// Might not be running
		}
	}

	await stopDirect();
}

/**
 * Restart the daemon
 */
export async function restartDaemon(port: number = 3850): Promise<void> {
	await stopDaemon();
	await new Promise((resolve) => setTimeout(resolve, 500));
	await startDaemon(port);
}

/**
 * Check if daemon is running
 */
export function isDaemonRunning(): boolean {
	const os = platform();

	if (os === "darwin" && existsSync(LAUNCHD_PLIST)) {
		return isLaunchdRunning();
	} else if (os === "linux" && existsSync(SYSTEMD_UNIT)) {
		return isSystemdRunning();
	}

	return isDirectRunning();
}

/**
 * Check if service is installed
 */
export function isServiceInstalled(): boolean {
	const os = platform();

	if (os === "darwin") {
		return existsSync(LAUNCHD_PLIST);
	} else if (os === "linux") {
		return existsSync(SYSTEMD_UNIT);
	} else if (os === "win32") {
		// On Windows, check if daemon is running via direct process management
		return existsSync(PID_FILE);
	}

	return false;
}

/**
 * Get comprehensive daemon status
 */
export async function getDaemonStatus(): Promise<ServiceStatus> {
	const running = isDaemonRunning();
	let pid: number | null = null;
	let uptime: number | null = null;
	const health: HealthProbeResult = running
		? await probeDaemonHealth()
		: { status: "unavailable", uptime: null, pid: null };

	if (running && existsSync(PID_FILE)) {
		try {
			pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
		} catch {
			// Ignore
		}
	}

	if (health.uptime !== null) {
		uptime = health.uptime;
	}
	if (!pid && health.pid !== null) {
		pid = health.pid;
	}

	return {
		installed: isServiceInstalled(),
		running,
		pid,
		uptime,
		port: DAEMON_PORT,
		status: health.status,
	};
}

/**
 * Get daemon logs
 */
export function getDaemonLogs(lines: number = 50): string[] {
	const logFile = join(LOG_DIR, `daemon-${new Date().toISOString().split("T")[0]}.log`);

	if (!existsSync(logFile)) {
		// Try stdout log
		const outLog = join(LOG_DIR, "daemon.out.log");
		if (existsSync(outLog)) {
			const content = readFileSync(outLog, "utf-8");
			return content.split("\n").slice(-lines);
		}
		return [];
	}

	const content = readFileSync(logFile, "utf-8");
	return content.split("\n").slice(-lines);
}
