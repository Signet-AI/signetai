import { execSyncHidden as execSync, spawnHidden as spawn } from "@signet/core";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
	LOOPBACK_HOST,
	buildLaunchdEnvironment,
	buildLaunchdPlist,
	formatWorkspacePreflightError,
	preflightWorkspace,
	resolveDefaultBasePath,
} from "@signet/core";

const AGENTS_DIR = resolveDefaultBasePath();
const DAEMON_DIR = join(AGENTS_DIR, ".daemon");
const PID_FILE = join(DAEMON_DIR, "pid");
const LOG_DIR = join(DAEMON_DIR, "logs");
const DAEMON_PORT = 3850;
const HEALTH_PROBE_TIMEOUT_MS = 1_200;
const HEALTH_PROBE_URL = `http://${LOOPBACK_HOST}:${DAEMON_PORT}/health/live`;
const LAUNCHD_PLIST = join(homedir(), "Library", "LaunchAgents", "ai.signet.daemon.plist");
const SYSTEMD_UNIT = join(homedir(), ".config", "systemd", "user", "signet.service");

export type ServiceHealthStatus = "healthy" | "degraded" | "unavailable";

export interface ServiceStatus {
	installed: boolean;
	running: boolean;
	pid: number | null;
	uptime: number | null;
	port: number;
	status: ServiceHealthStatus;
}

interface HealthProbeResult {
	status: ServiceHealthStatus;
	uptime: number | null;
	pid: number | null;
}
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
function getDaemonPath(): string {
	const candidates = [
		join(__dirname, "..", "..", "daemon", "dist", "daemon.js"),
		join(__dirname, "..", "dist", "daemon.js"),
		join(__dirname, "daemon.js"),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return "@signet/daemon";
}
function getRuntime(): string {
	try {
		const locator = platform() === "win32" ? "where" : "which";
		execSync(`${locator} bun`, { encoding: "utf-8" });
		return "bun";
	} catch {
		console.error("Error: Bun is required to run Signet daemon (uses bun:sqlite)");
		console.error(
			platform() === "win32"
				? 'Install Bun: powershell -c "irm bun.sh/install.ps1 | iex"'
				: "Install Bun: curl -fsSL https://bun.sh/install | bash",
		);
		process.exit(1);
	}
}

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
		programArguments: [resolveRuntimePath(), daemonPath],
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
	try {
		execSync(`launchctl unload "${LAUNCHD_PLIST}" 2>/dev/null`);
	} catch {}
	writeFileSync(LAUNCHD_PLIST, generateLaunchdPlist(port));
	execSync(`launchctl load "${LAUNCHD_PLIST}"`);
}

async function uninstallLaunchd(): Promise<void> {
	if (!existsSync(LAUNCHD_PLIST)) {
		return;
	}

	try {
		execSync(`launchctl unload "${LAUNCHD_PLIST}"`);
	} catch {}

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

function resolveRuntimePath(): string {
	const execPath = process.execPath;
	if (execPath && existsSync(execPath)) {
		return execPath;
	}
	const locator = platform() === "win32" ? "where" : "which";
	try {
		return execSync(`${locator} bun`, { encoding: "utf-8" }).trim().split(/\r?\n/)[0];
	} catch {
		try {
			return execSync(`${locator} node`, { encoding: "utf-8" }).trim().split(/\r?\n/)[0];
		} catch {
			return platform() === "win32" ? "bun" : "/usr/bin/bun";
		}
	}
}

function generateSystemdUnit(port: number = 3850): string {
	const daemonPath = getDaemonPath();
	const runtimePath = resolveRuntimePath();

	return `[Unit]
Description=Signet Daemon
After=network.target

[Service]
Type=simple
ExecStart=${runtimePath} ${daemonPath}
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
	try {
		execSync("systemctl --user stop signet.service 2>/dev/null");
	} catch {}
	writeFileSync(SYSTEMD_UNIT, generateSystemdUnit(port));
	execSync("systemctl --user daemon-reload");
	execSync("systemctl --user enable signet.service");
	execSync("systemctl --user start signet.service");
}

async function uninstallSystemd(): Promise<void> {
	try {
		execSync("systemctl --user stop signet.service 2>/dev/null");
		execSync("systemctl --user disable signet.service 2>/dev/null");
	} catch {}

	if (existsSync(SYSTEMD_UNIT)) {
		unlinkSync(SYSTEMD_UNIT);
	}

	try {
		execSync("systemctl --user daemon-reload");
	} catch {}
}

function isSystemdRunning(): boolean {
	try {
		const output = execSync("systemctl --user is-active signet.service 2>/dev/null", { encoding: "utf-8" });
		return output.trim() === "active";
	} catch {
		return false;
	}
}

function assertWorkspaceStartable(): void {
	const workspace = preflightWorkspace();
	if (workspace.status === "missing" || workspace.status === "incomplete") {
		throw new Error(formatWorkspacePreflightError(workspace));
	}
}

async function startDirect(port: number = 3850): Promise<number> {
	assertWorkspaceStartable();
	mkdirSync(DAEMON_DIR, { recursive: true });
	mkdirSync(LOG_DIR, { recursive: true });

	const runtime = getRuntime();
	const daemonPath = getDaemonPath();

	const proc = spawn(runtime, [daemonPath], {
		detached: true,
		stdio: "ignore",
		env: {
			...process.env,
			SIGNET_PORT: port.toString(),
			SIGNET_PATH: AGENTS_DIR,
		},
	});

	proc.unref();
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
	} catch {}
	try {
		unlinkSync(PID_FILE);
	} catch {}
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
		try {
			unlinkSync(PID_FILE);
		} catch {}
		return false;
	}
}
export async function installService(port: number = 3850): Promise<void> {
	const os = platform();

	if (os === "darwin") {
		await installLaunchd(port);
	} else if (os === "linux") {
		await installSystemd(port);
	} else {
		await startDirect(port);
	}
}
export async function uninstallService(): Promise<void> {
	const os = platform();

	if (os === "darwin") {
		await uninstallLaunchd();
	} else if (os === "linux") {
		await uninstallSystemd();
	}
	await stopDirect();
}
export async function startDaemon(port: number = 3850): Promise<void> {
	assertWorkspaceStartable();
	const os = platform();

	if (os === "darwin" && existsSync(LAUNCHD_PLIST)) {
		execSync(`launchctl load "${LAUNCHD_PLIST}"`);
	} else if (os === "linux" && existsSync(SYSTEMD_UNIT)) {
		execSync("systemctl --user start signet.service");
	} else {
		await startDirect(port);
	}
}
export async function stopDaemon(): Promise<void> {
	const os = platform();

	if (os === "darwin" && existsSync(LAUNCHD_PLIST)) {
		try {
			execSync(`launchctl unload "${LAUNCHD_PLIST}"`);
		} catch {}
	} else if (os === "linux" && existsSync(SYSTEMD_UNIT)) {
		try {
			execSync("systemctl --user stop signet.service");
		} catch {}
	}

	await stopDirect();
}
export async function restartDaemon(port: number = 3850): Promise<void> {
	await stopDaemon();
	await new Promise((resolve) => setTimeout(resolve, 500));
	await startDaemon(port);
}
export function isDaemonRunning(): boolean {
	const os = platform();

	if (os === "darwin" && existsSync(LAUNCHD_PLIST)) {
		return isLaunchdRunning();
	} else if (os === "linux" && existsSync(SYSTEMD_UNIT)) {
		return isSystemdRunning();
	}

	return isDirectRunning();
}
export function isServiceInstalled(): boolean {
	const os = platform();

	if (os === "darwin") {
		return existsSync(LAUNCHD_PLIST);
	} else if (os === "linux") {
		return existsSync(SYSTEMD_UNIT);
	} else if (os === "win32") {
		return existsSync(PID_FILE);
	}

	return false;
}
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
		} catch {}
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
export function getDaemonLogs(lines: number = 50): string[] {
	const logFile = join(LOG_DIR, `daemon-${new Date().toISOString().split("T")[0]}.log`);

	if (!existsSync(logFile)) {
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
