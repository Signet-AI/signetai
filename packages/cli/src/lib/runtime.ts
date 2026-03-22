import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSimpleYaml } from "@signet/core";
import chalk from "chalk";

export const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");
export const DEFAULT_PORT = 3850;
const DAEMON_BASE_URLS = [`http://127.0.0.1:${DEFAULT_PORT}`, `http://[::1]:${DEFAULT_PORT}`] as const;

interface DaemonInstance {
	readonly baseUrl: string;
	readonly pid: number | null;
	readonly uptime: number | null;
	readonly version: string | null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliDir = dirname(__dirname);
const pkgDir = dirname(cliDir);

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isDaemonHealthyAt(baseUrl: string): Promise<boolean> {
	try {
		const response = await fetch(`${baseUrl}/health`, {
			signal: AbortSignal.timeout(1200),
		});
		return response.ok;
	} catch {
		return false;
	}
}

export async function getReachableDaemonUrls(): Promise<string[]> {
	const checks = await Promise.all(
		DAEMON_BASE_URLS.map(async (baseUrl) => ((await isDaemonHealthyAt(baseUrl)) ? baseUrl : null)),
	);
	return checks.flatMap((url) => (url === null ? [] : [url]));
}

async function getDaemonInstances(): Promise<DaemonInstance[]> {
	const urls = await getReachableDaemonUrls();
	return Promise.all(
		urls.map(async (baseUrl): Promise<DaemonInstance> => {
			try {
				const response = await fetch(`${baseUrl}/api/status`, {
					signal: AbortSignal.timeout(1200),
				});
				if (response.ok) {
					const data = (await response.json()) as {
						pid?: number;
						uptime?: number;
						version?: string;
					};
					return {
						baseUrl,
						pid: data.pid ?? null,
						uptime: data.uptime ?? null,
						version: data.version ?? null,
					};
				}
			} catch {
				// Fall back to health-only instance metadata.
			}

			return {
				baseUrl,
				pid: null,
				uptime: null,
				version: null,
			};
		}),
	);
}

export async function isDaemonRunning(): Promise<boolean> {
	const urls = await getReachableDaemonUrls();
	return urls.length > 0;
}

export async function getDaemonStatus(): Promise<{
	running: boolean;
	pid: number | null;
	uptime: number | null;
	version: string | null;
}> {
	const instances = await getDaemonInstances();
	if (instances.length > 0) {
		const preferred = instances.find((instance) => typeof instance.uptime === "number") ?? instances[0];
		return {
			running: true,
			pid: preferred.pid,
			uptime: preferred.uptime,
			version: preferred.version,
		};
	}

	return { running: false, pid: null, uptime: null, version: null };
}

async function downloadDaemonBinary(): Promise<void> {
	let version: string | undefined;
	try {
		const raw = readFileSync(join(pkgDir, "package.json"), "utf8");
		version = (JSON.parse(raw) as { version?: string }).version;
	} catch {
		return;
	}
	if (!version) return;

	const plat = process.platform;
	const arch = process.arch;
	const supported = new Set(["linux:x64", "darwin:x64", "darwin:arm64", "win32:x64", "win32:arm64"]);
	if (!supported.has(`${plat}:${arch}`)) return;

	const ext = plat === "win32" ? ".exe" : "";
	const name = `signet-daemon-${plat}-${arch}${ext}`;
	const binDir = join(pkgDir, "bin");
	const dest = join(binDir, name);
	if (existsSync(dest)) return;

	const base = `https://github.com/Signet-AI/signetai/releases/download/v${version}`;
	process.stdout.write(`  Downloading Rust daemon binary (${name})...`);

	try {
		const checksumRes = await fetch(`${base}/${name}.sha256`, {
			redirect: "follow",
			signal: AbortSignal.timeout(10_000),
		});
		if (!checksumRes.ok) {
			process.stdout.write(` skipped (checksum unavailable: ${checksumRes.status})\n`);
			return;
		}
		const expectedHash = (await checksumRes.text()).trim().split(/\s+/)[0];

		const res = await fetch(`${base}/${name}`, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
		if (!res.ok) {
			process.stdout.write(` skipped (${res.status})\n`);
			return;
		}
		mkdirSync(binDir, { recursive: true });
		const bytes = await res.arrayBuffer();
		const buf = Buffer.from(bytes);
		const actualHash = sha256(buf);
		if (actualHash !== expectedHash) {
			process.stdout.write(` skipped (checksum mismatch — possible tampering)\n`);
			return;
		}

		writeFileSync(dest, buf);
		if (plat !== "win32") chmodSync(dest, 0o755);
		process.stdout.write(` done\n`);
	} catch {
		process.stdout.write(` skipped (download failed)\n`);
		try {
			unlinkSync(dest);
		} catch {
			// Ignore.
		}
	}
}

export async function startDaemon(agentsDir: string = AGENTS_DIR): Promise<boolean> {
	if (await isDaemonRunning()) {
		return true;
	}

	try {
		const raw = parseSimpleYaml(readFileSync(join(agentsDir, "agent.yaml"), "utf8"));
		const mem = raw?.memory as Record<string, unknown> | undefined;
		const p2 = mem?.pipelineV2 as Record<string, unknown> | undefined;
		if (p2?.nativeShadowEnabled === true) {
			await downloadDaemonBinary();
		}
	} catch {
		// Non-fatal — agent.yaml may not exist yet.
	}

	const daemonDir = join(agentsDir, ".daemon");
	const logDir = join(daemonDir, "logs");
	mkdirSync(daemonDir, { recursive: true });
	mkdirSync(logDir, { recursive: true });

	const daemonLocations = [
		join(cliDir, "daemon.js"),
		join(pkgDir, "..", "daemon", "dist", "daemon.js"),
		join(pkgDir, "..", "daemon", "src", "daemon.ts"),
	];

	let daemonPath: string | null = null;
	for (const loc of daemonLocations) {
		if (existsSync(loc)) {
			daemonPath = loc;
			break;
		}
	}

	if (!daemonPath) {
		console.error(chalk.red("Daemon not found. Try reinstalling signet."));
		return false;
	}

	const startupLogPath = join(logDir, "startup.log");
	let stderrFd: number | null = null;
	let stderrTarget: "ignore" | number = "ignore";
	try {
		stderrFd = openSync(startupLogPath, "w");
		stderrTarget = stderrFd;
	} catch {
		// Non-fatal.
	}

	const proc = spawn("bun", [daemonPath], {
		detached: true,
		stdio: ["ignore", "ignore", stderrTarget],
		windowsHide: true,
		env: {
			...process.env,
			SIGNET_PORT: DEFAULT_PORT.toString(),
			SIGNET_HOST: process.env.SIGNET_HOST || "127.0.0.1",
			SIGNET_PATH: agentsDir,
		},
	});

	proc.on("error", (err) => {
		try {
			appendFileSync(startupLogPath, `[spawn error] ${err.message}\n`);
		} catch {
			// Best effort.
		}
	});

	proc.unref();
	if (stderrFd !== null) {
		closeSync(stderrFd);
	}

	for (let i = 0; i < 20; i += 1) {
		await sleep(250);
		if (await isDaemonRunning()) {
			return true;
		}
	}

	try {
		if (stderrFd !== null && existsSync(startupLogPath)) {
			const stderr = readFileSync(startupLogPath, "utf-8").trim();
			if (stderr) {
				console.error(chalk.red("\nDaemon failed to start. stderr output:"));
				for (const line of stderr.split("\n").slice(-20)) {
					console.error(chalk.dim(line));
				}
			}
		}
	} catch {
		// Best effort.
	}

	return false;
}

export async function stopDaemon(agentsDir: string = AGENTS_DIR): Promise<boolean> {
	const pidFile = join(agentsDir, ".daemon", "pid");
	const pids = new Set<number>();

	if (existsSync(pidFile)) {
		try {
			const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
			if (Number.isInteger(pid) && pid > 0) {
				pids.add(pid);
			}
		} catch {
			// Ignore unreadable/stale PID file.
		}
	}

	for (const instance of await getDaemonInstances()) {
		if (typeof instance.pid === "number" && instance.pid > 0) {
			pids.add(instance.pid);
		}
	}

	for (const pid of pids) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Ignore.
		}
	}

	for (const pid of pids) {
		const exited = await waitForPidExit(pid);
		if (!exited) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Ignore.
			}
		}
	}

	for (const pid of pids) {
		await waitForPidExit(pid);
	}

	if (existsSync(pidFile)) {
		try {
			rmSync(pidFile, { force: true });
		} catch {
			// Ignore.
		}
	}

	return !(await isDaemonRunning());
}

export function formatUptime(seconds: number): string {
	if (seconds < 60) return `${Math.floor(seconds)}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
	const hours = Math.floor(seconds / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	return `${hours}h ${mins}m`;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForPidExit(pid: number): Promise<boolean> {
	for (let i = 0; i < 20; i += 1) {
		if (!isAlive(pid)) {
			return true;
		}
		await sleep(250);
	}
	return !isAlive(pid);
}

function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}
