import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSimpleYaml } from "@signet/core";
import chalk from "chalk";
import { resolveDaemonNetwork } from "./network.js";
import { resolveAgentsDir } from "./workspace.js";

export const AGENTS_DIR = resolveAgentsDir().path;
export const DEFAULT_PORT = 3850;
const DAEMON_BASE_URLS = [`http://127.0.0.1:${DEFAULT_PORT}`, `http://[::1]:${DEFAULT_PORT}`] as const;

interface DaemonInstance {
	readonly baseUrl: string;
	readonly pid: number | null;
	readonly uptime: number | null;
	readonly version: string | null;
	readonly host: string | null;
	readonly bindHost: string | null;
	readonly networkMode: string | null;
	readonly extraction: {
		readonly configured: string | null;
		readonly effective: string | null;
		readonly fallbackProvider: string | null;
		readonly status: string | null;
		readonly degraded: boolean;
		readonly reason: string | null;
		readonly since: string | null;
	} | null;
	readonly extractionWorker: {
		readonly running: boolean;
		readonly overloaded: boolean;
		readonly loadPerCpu: number | null;
		readonly maxLoadPerCpu: number | null;
		readonly overloadBackoffMs: number | null;
		readonly overloadSince: string | null;
		readonly nextTickInMs: number | null;
	} | null;
}

interface DaemonProbeDeps {
	readonly daemonPaths?: readonly string[];
	readonly isAlive?: (pid: number) => boolean;
	readonly readCmd?: (pid: number) => string | null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliDir = dirname(__dirname);
const pkgDir = dirname(cliDir);

function pidFile(agentsDir: string): string {
	return join(agentsDir, ".daemon", "pid");
}

function daemonPaths(): string[] {
	return [
		join(__dirname, "daemon.js"),
		join(cliDir, "daemon.js"),
		join(pkgDir, "..", "daemon", "dist", "daemon.js"),
		join(pkgDir, "..", "daemon", "src", "daemon.ts"),
	].filter((path, index, items) => items.indexOf(path) === index);
}

function daemonMarks(paths: readonly string[]): string[] {
	return [
		...paths,
		"/signetai/dist/daemon.js",
		"/packages/daemon/dist/daemon.js",
		"/packages/daemon/src/daemon.ts",
	].filter((path, index, items) => items.indexOf(path) === index);
}

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
						host?: string;
						bindHost?: string;
						networkMode?: string;
						providerResolution?: {
							extraction?: {
								configured?: string | null;
								effective?: string | null;
								fallbackProvider?: string | null;
								status?: string | null;
								degraded?: boolean;
								reason?: string | null;
								since?: string | null;
							};
						};
						pipeline?: {
							extraction?: {
								running?: boolean;
								overloaded?: boolean;
								loadPerCpu?: number | null;
								maxLoadPerCpu?: number | null;
								overloadBackoffMs?: number | null;
								overloadSince?: string | null;
								nextTickInMs?: number | null;
							};
						};
					};
					const extraction = data.providerResolution?.extraction;
					const extractionWorker = data.pipeline?.extraction;
					return {
						baseUrl,
						pid: data.pid ?? null,
						uptime: data.uptime ?? null,
						version: data.version ?? null,
						host: data.host ?? null,
						bindHost: data.bindHost ?? null,
						networkMode: data.networkMode ?? null,
						extraction: extraction
							? {
									configured: extraction.configured ?? null,
									effective: extraction.effective ?? null,
									fallbackProvider: extraction.fallbackProvider ?? null,
									status: extraction.status ?? null,
									degraded: extraction.degraded === true,
									reason: extraction.reason ?? null,
									since: extraction.since ?? null,
								}
							: null,
						extractionWorker: extractionWorker
							? {
									running: extractionWorker.running === true,
									overloaded: extractionWorker.overloaded === true,
									loadPerCpu: typeof extractionWorker.loadPerCpu === "number" ? extractionWorker.loadPerCpu : null,
									maxLoadPerCpu:
										typeof extractionWorker.maxLoadPerCpu === "number" ? extractionWorker.maxLoadPerCpu : null,
									overloadBackoffMs:
										typeof extractionWorker.overloadBackoffMs === "number" ? extractionWorker.overloadBackoffMs : null,
									overloadSince: extractionWorker.overloadSince ?? null,
									nextTickInMs:
										typeof extractionWorker.nextTickInMs === "number" ? extractionWorker.nextTickInMs : null,
								}
							: null,
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
				host: null,
				bindHost: null,
				networkMode: null,
				extraction: null,
				extractionWorker: null,
			};
		}),
	);
}

export async function isDaemonRunning(): Promise<boolean> {
	const urls = await getReachableDaemonUrls();
	return urls.length > 0;
}

function normalizeCmd(value: string): string {
	return normalize(value).replaceAll("\\", "/").toLowerCase();
}

function matchesDaemon(cmd: string, paths: readonly string[]): boolean {
	const normalizedCmd = normalizeCmd(cmd);
	return daemonMarks(paths).some((path) => normalizedCmd.includes(normalizeCmd(path)));
}

function readCmd(pid: number): string | null {
	try {
		if (process.platform === "linux") {
			const raw = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
			const value = raw.replaceAll("\u0000", " ").trim();
			return value.length > 0 ? value : null;
		}
	} catch {
		// Fall through.
	}

	try {
		const proc = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
			encoding: "utf-8",
			windowsHide: true,
		});
		if (proc.status !== 0) return null;
		const value = proc.stdout.trim();
		return value.length > 0 ? value : null;
	} catch {
		return null;
	}
}

export function readManagedDaemonPid(agentsDir: string = AGENTS_DIR, deps: DaemonProbeDeps = {}): number | null {
	const path = pidFile(agentsDir);
	if (!existsSync(path)) {
		return null;
	}

	const alive = deps.isAlive ?? isAlive;
	try {
		const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
		if (!Number.isInteger(pid) || pid <= 0) {
			rmSync(path, { force: true });
			return null;
		}
		if (!alive(pid)) {
			rmSync(path, { force: true });
			return null;
		}

		// Only reclaim live PIDs that still look like a Signet daemon process.
		const cmd = (deps.readCmd ?? readCmd)(pid);
		if (!cmd) {
			return null;
		}

		const paths = deps.daemonPaths ?? daemonPaths();
		return matchesDaemon(cmd, paths) ? pid : null;
	} catch {
		return null;
	}
}

export async function hasDaemonProcess(agentsDir: string = AGENTS_DIR): Promise<boolean> {
	return readManagedDaemonPid(agentsDir) !== null;
}

export async function getDaemonStatus(): Promise<{
	running: boolean;
	pid: number | null;
	uptime: number | null;
	version: string | null;
	host: string | null;
	bindHost: string | null;
	networkMode: string | null;
	extraction: DaemonInstance["extraction"];
	extractionWorker: DaemonInstance["extractionWorker"];
}> {
	const instances = await getDaemonInstances();
	if (instances.length > 0) {
		const preferred = instances.find((instance) => typeof instance.uptime === "number") ?? instances[0];
		return {
			running: true,
			pid: preferred.pid,
			uptime: preferred.uptime,
			version: preferred.version,
			host: preferred.host,
			bindHost: preferred.bindHost,
			networkMode: preferred.networkMode,
			extraction: preferred.extraction,
			extractionWorker: preferred.extractionWorker,
		};
	}

	return {
		running: false,
		pid: null,
		uptime: null,
		version: null,
		host: null,
		bindHost: null,
		networkMode: null,
		extraction: null,
		extractionWorker: null,
	};
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
			process.stdout.write(" skipped (checksum mismatch — possible tampering)\n");
			return;
		}

		writeFileSync(dest, buf);
		if (plat !== "win32") chmodSync(dest, 0o755);
		process.stdout.write(" done\n");
	} catch {
		process.stdout.write(" skipped (download failed)\n");
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

	if (await hasDaemonProcess(agentsDir)) {
		const stopped = await stopDaemon(agentsDir);
		if (!stopped) {
			return false;
		}
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

	const net = resolveDaemonNetwork(agentsDir, process.env);

	const daemonDir = join(agentsDir, ".daemon");
	const logDir = join(daemonDir, "logs");
	mkdirSync(daemonDir, { recursive: true });
	mkdirSync(logDir, { recursive: true });

	// In dev, runtime.ts lives in lib/ so cliDir (dirname(__dirname)) = src/.
	// In the published bundle, everything flattens into dist/cli.js so
	// __dirname already points at dist/ — check it first to handle the
	// bundled layout where cliDir overshoots to the package root.
	let daemonPath: string | null = null;
	for (const loc of daemonPaths()) {
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
			SIGNET_HOST: net.host,
			SIGNET_BIND: net.bind,
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
	const pids = new Set<number>();
	const managed = readManagedDaemonPid(agentsDir);
	if (managed !== null) {
		pids.add(managed);
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

	const path = pidFile(agentsDir);
	if (existsSync(path)) {
		try {
			rmSync(path, { force: true });
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
