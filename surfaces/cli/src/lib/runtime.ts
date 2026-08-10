import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { resolveDaemonNetwork } from "./network.js";
import { resolveAgentsDir } from "./workspace.js";

export const AGENTS_DIR = resolveAgentsDir().path;
export const DEFAULT_PORT = 3850;
const DAEMON_BASE_URLS = [`http://127.0.0.1:${DEFAULT_PORT}`, `http://[::1]:${DEFAULT_PORT}`] as const;

export interface DaemonHealthProbe {
	readonly status: "healthy" | "degraded" | "listener-unhealthy" | "process-unhealthy" | "stale-artifact" | "absent";
	readonly detail: string;
	readonly url: string | null;
	readonly listenerPresent: boolean;
	readonly processPid: number | null;
	readonly stalePid: number | null;
	/** Present only when /health/ready reported not_ready; absent when readiness is unknown (older daemon). */
	readonly readinessReasons?: readonly string[];
	/**
	 * The daemon's own last-exit record (`.daemon/lifecycle.json`), when one
	 * exists. A record stuck at "starting"/"running" while no daemon process
	 * is alive means the death was not recorded — an external kill or hard
	 * crash (issue #1148).
	 */
	readonly lastExit?: DaemonLastExit | null;
}

export interface DaemonLastExit {
	readonly state: "starting" | "running" | "clean" | "error";
	readonly pid: number;
	readonly version: string;
	readonly startedAt: string;
	readonly systemdUnit?: string;
	readonly exitedAt?: string;
	readonly exitCode?: number;
	readonly reason?: string;
	readonly error?: string;
}

/** Tolerant read of the daemon lifecycle record; null when absent or corrupt. */
export function readDaemonLifecycleRecord(agentsDir: string): DaemonLastExit | null {
	try {
		const raw = readFileSync(join(agentsDir, ".daemon", "lifecycle.json"), "utf-8");
		const parsed = JSON.parse(raw) as Partial<DaemonLastExit>;
		if (typeof parsed.state !== "string" || typeof parsed.pid !== "number") return null;
		return parsed as DaemonLastExit;
	} catch {
		return null;
	}
}

export interface DaemonOpenClawHealthSummary {
	readonly status: "connected" | "stale" | "never-seen";
	readonly lastHeartbeat: string | null;
	readonly pluginVersion: string | null;
	readonly hooksRegistered: readonly string[];
	readonly hooksSucceeded: number;
	readonly hooksFailed: number;
	readonly lastLatencyMs: number;
	readonly lastError: string | null;
}

export interface DaemonResourceUsage {
	readonly rss: number | null;
	readonly heapUsed: number | null;
	readonly physicalFootprint: number | null;
	readonly peakPhysicalFootprint: number | null;
}

interface DaemonInstance {
	readonly baseUrl: string;
	readonly pid: number | null;
	readonly uptime: number | null;
	readonly version: string | null;
	readonly host: string | null;
	readonly bindHost: string | null;
	readonly networkMode: string | null;
	readonly resources: DaemonResourceUsage | null;
	readonly extraction: {
		readonly configured: string | null;
		readonly resolved: string | null;
		readonly effective: string | null;
		readonly fallbackProvider: string | null;
		readonly status: string | null;
		readonly degraded: boolean;
		readonly reason: string | null;
		readonly blockedBy: readonly string[];
		readonly since: string | null;
		readonly enabled: boolean;
		readonly paused: boolean;
		readonly workerRunning: boolean;
		readonly ready: boolean;
		readonly blockedReason: string | null;
		readonly hasWorkloadState: boolean;
	} | null;
	readonly transcripts: {
		readonly pending: number;
		readonly failed: number;
		readonly dead: number;
	} | null;
	/** Daemon composite health from `/api/status` (score + status). */
	readonly health: {
		readonly score: number | null;
		readonly status: string | null;
	} | null;
	/** Pipeline queue counts from `/api/status` (memory plus legacy summary compatibility). */
	readonly queue: {
		readonly memory: QueueCountsFromStatus | null;
		readonly summary: QueueCountsFromStatus | null;
	} | null;
	readonly probe: DaemonHealthProbe;
	readonly openclaw: DaemonOpenClawHealthSummary | null;
}

interface QueueCountsFromStatus {
	readonly pending: number;
	readonly leased: number;
	readonly completed: number;
	readonly failed: number;
	readonly dead: number;
	readonly oldestAgeSec: number;
	readonly oldestDeadAgeSec: number;
	readonly lastError: string | null;
}

interface DaemonProbeDeps {
	readonly daemonPaths?: readonly string[];
	readonly isAlive?: (pid: number) => boolean;
	readonly readCmd?: (pid: number) => string | null;
	readonly readEnv?: (pid: number) => string | null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliDir = dirname(__dirname);
const pkgDir = dirname(cliDir);

function currentNativeExecutablePath(execPath: string = process.execPath): string | null {
	const name = basename(execPath).toLowerCase();
	if (name === "bun" || name === "bun.exe" || name === "node" || name === "node.exe") return null;
	return execPath;
}

function pidFile(agentsDir: string): string {
	return join(agentsDir, ".daemon", "pid");
}

export function resolveDaemonPaths(env: NodeJS.ProcessEnv = process.env): string[] {
	const currentNativeExecutable = currentNativeExecutablePath();
	const bundledJsDaemon = env.SIGNET_DIR ? join(env.SIGNET_DIR, "runtime", "daemon-js", "daemon.js") : null;
	const bundledRuntimePaths = [bundledJsDaemon];
	return [
		currentNativeExecutable,
		...bundledRuntimePaths,
		join(__dirname, "daemon.js"),
		join(cliDir, "daemon.js"),
		join(pkgDir, "..", "daemon", "dist", "daemon.js"),
		join(pkgDir, "..", "daemon", "src", "daemon.ts"),
	]
		.filter((path): path is string => path !== null)
		.filter((path, index, items) => items.indexOf(path) === index);
}

/** Resolve the daemon executable that the current CLI would launch. */
export function resolveDaemonPath(env: NodeJS.ProcessEnv = process.env): string | null {
	return resolveDaemonPaths(env).find((path) => existsSync(path)) ?? null;
}

function daemonPaths(): string[] {
	return resolveDaemonPaths();
}

function daemonMarks(paths: readonly string[]): string[] {
	return [
		...paths,
		"/signetai/dist/daemon.js",
		"/platform/daemon/dist/daemon.js",
		"/platform/daemon/src/daemon.ts",
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

/**
 * Cheap liveness check: hits /health/live which never touches the DB.
 * Used during startup polling so a daemon running migrations or recovery
 * (where /health may be slow or unavailable) is still detected as alive.
 */
async function isDaemonAliveAt(baseUrl: string): Promise<boolean> {
	try {
		const response = await fetch(`${baseUrl}/health/live`, {
			signal: AbortSignal.timeout(1200),
		});
		return response.ok;
	} catch {
		return false;
	}
}

interface DaemonReadiness {
	readonly ready: boolean;
	readonly reasons: string[];
}

// Readiness is null when /health/ready is unreachable (e.g. an older daemon
// without the route); callers must treat null as unknown, never as not-ready.
async function fetchDaemonReadiness(baseUrl: string): Promise<DaemonReadiness | null> {
	try {
		const response = await fetch(`${baseUrl}/health/ready`, {
			signal: AbortSignal.timeout(1200),
		});
		if (!response.ok && response.status !== 503) return null;
		const data = (await response.json()) as { status?: string; reasons?: unknown };
		if (data.status !== "ready" && data.status !== "not_ready") return null;
		return { ready: data.status === "ready", reasons: stringArray(data.reasons) };
	} catch {
		return null;
	}
}

function reachableDaemonProbe(
	baseUrl: string,
	processPid: number | null,
	readiness: DaemonReadiness | null,
	note?: string,
): DaemonHealthProbe {
	const detail = `/health responded successfully at ${baseUrl}${note ?? ""}`;
	if (readiness !== null && !readiness.ready) {
		return {
			status: "degraded",
			detail: `${detail}; readiness degraded`,
			url: baseUrl,
			listenerPresent: true,
			processPid,
			stalePid: null,
			readinessReasons: readiness.reasons,
		};
	}
	return {
		status: "healthy",
		detail,
		url: baseUrl,
		listenerPresent: true,
		processPid,
		stalePid: null,
	};
}

async function fetchJsonOrNull<T>(baseUrl: string, path: string): Promise<T | null> {
	try {
		const response = await fetch(`${baseUrl}${path}`, {
			signal: AbortSignal.timeout(1200),
		});
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	}
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function summarizeOpenClawHealth(value: unknown): DaemonOpenClawHealthSummary | null {
	if (!value || typeof value !== "object") return null;
	const report = value as Record<string, unknown>;
	const status = report.status;
	if (status !== "connected" && status !== "stale" && status !== "never-seen") return null;
	return {
		status,
		lastHeartbeat: typeof report.lastHeartbeat === "string" ? report.lastHeartbeat : null,
		pluginVersion: typeof report.pluginVersion === "string" ? report.pluginVersion : null,
		hooksRegistered: stringArray(report.hooksRegistered),
		hooksSucceeded: typeof report.hooksSucceeded === "number" ? report.hooksSucceeded : 0,
		hooksFailed: typeof report.hooksFailed === "number" ? report.hooksFailed : 0,
		lastLatencyMs: typeof report.lastLatencyMs === "number" ? report.lastLatencyMs : 0,
		lastError: typeof report.lastError === "string" ? report.lastError : null,
	};
}

function canConnect(host: string, port: number, timeoutMs = 500): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host, port });
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
	});
}

function readPidArtifact(agentsDir: string): { pid: number | null; stale: boolean } {
	const path = pidFile(agentsDir);
	if (!existsSync(path)) return { pid: null, stale: false };
	try {
		const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
		if (!Number.isInteger(pid) || pid <= 0) return { pid: null, stale: true };
		return { pid, stale: !isAlive(pid) };
	} catch {
		return { pid: null, stale: true };
	}
}

async function buildUnreachableDaemonProbe(agentsDir: string): Promise<DaemonHealthProbe> {
	const artifact = readPidArtifact(agentsDir);
	const managedPid = readManagedDaemonPid(agentsDir);
	const processPid = managedPid ?? findMarkedDaemonProcessPids()[0] ?? null;
	const listenerPresent = await canConnect("127.0.0.1", DEFAULT_PORT);
	const url = `http://127.0.0.1:${DEFAULT_PORT}`;
	const lastExit = readDaemonLifecycleRecord(agentsDir);

	if (listenerPresent) {
		return {
			status: "listener-unhealthy",
			detail: `TCP listener is present on ${url}, but /health did not return successfully within the probe timeout`,
			url,
			listenerPresent,
			processPid,
			stalePid: artifact.stale ? artifact.pid : null,
			lastExit,
		};
	}

	if (processPid !== null) {
		return {
			status: "process-unhealthy",
			detail: "A Signet daemon process appears to be running, but the health endpoint is unreachable",
			url,
			listenerPresent,
			processPid,
			stalePid: artifact.stale ? artifact.pid : null,
			lastExit,
		};
	}

	if (artifact.stale) {
		return {
			status: "stale-artifact",
			detail: "Daemon pid artifact is stale; no live Signet daemon process or healthy listener was found",
			url,
			listenerPresent,
			processPid: null,
			stalePid: artifact.pid,
			lastExit,
		};
	}

	return {
		status: "absent",
		detail: "No Signet daemon process or healthy listener was found",
		url,
		listenerPresent,
		processPid: null,
		stalePid: null,
		lastExit,
	};
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
						health?: {
							score?: number;
							status?: string;
						};
						resources?: {
							rss?: number | null;
							heapUsed?: number | null;
							physicalFootprint?: number | null;
							peakPhysicalFootprint?: number | null;
						};
						providerResolution?: {
							extraction?: {
								configured?: string | null;
								resolved?: string | null;
								effective?: string | null;
								fallbackProvider?: string | null;
								status?: string | null;
								degraded?: boolean;
								reason?: string | null;
								blockedBy?: unknown;
								since?: string | null;
								enabled?: boolean;
								paused?: boolean;
								workerRunning?: boolean;
								ready?: boolean;
								blockedReason?: string | null;
							};
						};
						pipeline?: Record<string, unknown>;
						transcripts?: {
							capture?: {
								pending?: number;
								failed?: number;
								dead?: number;
							};
						};
					};
					const extraction = data.providerResolution?.extraction;
					const transcripts = data.transcripts?.capture;
					const resources = data.resources;
					const openclawReport = await fetchJsonOrNull<unknown>(baseUrl, "/api/diagnostics/openclaw");
					const readiness = await fetchDaemonReadiness(baseUrl);
					const healthRaw = data.health;
					const pipelineRaw = data.pipeline;
					const queueRaw =
						typeof pipelineRaw === "object" && pipelineRaw !== null ? Reflect.get(pipelineRaw, "queue") : undefined;
					const health =
						typeof healthRaw === "object" && healthRaw !== null
							? {
									score:
										typeof Reflect.get(healthRaw, "score") === "number"
											? (Reflect.get(healthRaw, "score") as number)
											: null,
									status:
										typeof Reflect.get(healthRaw, "status") === "string"
											? (Reflect.get(healthRaw, "status") as string)
											: null,
								}
							: null;
					const queue =
						typeof queueRaw === "object" && queueRaw !== null
							? {
									memory: normalizeQueueCountsFromStatus(Reflect.get(queueRaw, "memory")),
									summary: normalizeQueueCountsFromStatus(Reflect.get(queueRaw, "summary")),
								}
							: null;
					return {
						baseUrl,
						pid: data.pid ?? null,
						uptime: data.uptime ?? null,
						version: data.version ?? null,
						host: data.host ?? null,
						bindHost: data.bindHost ?? null,
						networkMode: data.networkMode ?? null,
						resources: resources
							? {
									rss: typeof resources.rss === "number" ? resources.rss : null,
									heapUsed: typeof resources.heapUsed === "number" ? resources.heapUsed : null,
									physicalFootprint:
										typeof resources.physicalFootprint === "number" ? resources.physicalFootprint : null,
									peakPhysicalFootprint:
										typeof resources.peakPhysicalFootprint === "number" ? resources.peakPhysicalFootprint : null,
								}
							: null,
						extraction: extraction
							? {
									configured: extraction.configured ?? null,
									resolved: extraction.resolved ?? null,
									effective: extraction.effective ?? null,
									fallbackProvider: extraction.fallbackProvider ?? null,
									status: extraction.status ?? null,
									degraded: extraction.degraded === true,
									reason: extraction.reason ?? null,
									blockedBy: Array.isArray(extraction.blockedBy)
										? extraction.blockedBy.filter(
												(reason): reason is string => typeof reason === "string" && reason.trim().length > 0,
											)
										: [],
									since: extraction.since ?? null,
									enabled: extraction.enabled === true,
									paused: extraction.paused === true,
									workerRunning: extraction.workerRunning === true,
									ready: extraction.ready === true,
									blockedReason: extraction.blockedReason ?? null,
									hasWorkloadState: typeof extraction.ready === "boolean",
								}
							: null,
						transcripts: transcripts
							? {
									pending: typeof transcripts.pending === "number" ? transcripts.pending : 0,
									failed: typeof transcripts.failed === "number" ? transcripts.failed : 0,
									dead: typeof transcripts.dead === "number" ? transcripts.dead : 0,
								}
							: null,
						health,
						queue,
						probe: reachableDaemonProbe(baseUrl, data.pid ?? null, readiness),
						openclaw: summarizeOpenClawHealth(openclawReport),
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
				resources: null,
				extraction: null,
				transcripts: null,
				health: null,
				queue: null,
				probe: reachableDaemonProbe(
					baseUrl,
					null,
					await fetchDaemonReadiness(baseUrl),
					"; /api/status did not return full metadata",
				),
				openclaw: null,
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

export function isDaemonEntrypointEnvironment(value: string): boolean {
	return value.split("\u0000").some((entry) => entry === "SIGNET_DAEMON_ENTRYPOINT=1");
}

function matchesDaemon(cmd: string, paths: readonly string[]): boolean {
	const normalizedCmd = normalizeCmd(cmd);
	return daemonMarks(paths).some((path) => normalizedCmd.includes(normalizeCmd(path)));
}

function normalizeQueueCountsFromStatus(value: unknown): QueueCountsFromStatus | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	const toNumber = (key: string): number => {
		const raw = record[key];
		return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
	};
	const lastErrorRaw = record.lastError;
	return {
		pending: toNumber("pending"),
		leased: toNumber("leased"),
		completed: toNumber("completed"),
		failed: toNumber("failed"),
		dead: toNumber("dead"),
		oldestAgeSec: toNumber("oldestAgeSec"),
		oldestDeadAgeSec: toNumber("oldestDeadAgeSec"),
		lastError: typeof lastErrorRaw === "string" && lastErrorRaw.trim().length > 0 ? lastErrorRaw : null,
	};
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

	if (process.platform === "win32") {
		const script = `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($process) { $process.CommandLine }`;
		for (const command of ["powershell.exe", "pwsh"]) {
			try {
				const proc = spawnSync(command, ["-NoProfile", "-NonInteractive", "-Command", script], {
					encoding: "utf-8",
					windowsHide: true,
					timeout: 3000,
				});
				if (proc.status === 0 && proc.stdout.trim()) return proc.stdout.trim();
			} catch {
				// Try the next available PowerShell command.
			}
		}
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

function readDaemonEntrypoint(pid: number): boolean | null {
	if (process.platform !== "linux") return null;
	try {
		return isDaemonEntrypointEnvironment(readFileSync(`/proc/${pid}/environ`, "utf-8"));
	} catch {
		return false;
	}
}

function findMarkedDaemonProcessPids(): number[] {
	if (process.platform !== "linux") return [];
	try {
		return readdirSync("/proc", { withFileTypes: true })
			.flatMap((entry) => {
				if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) return [];
				const pid = Number.parseInt(entry.name, 10);
				if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return [];
				return readDaemonEntrypoint(pid) === true ? [pid] : [];
			})
			.filter((pid, index, items) => items.indexOf(pid) === index);
	} catch {
		return [];
	}
}

function readManagedDaemonProcess(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 1 || !isAlive(pid)) return false;
	const marker = readDaemonEntrypoint(pid);
	if (marker !== null) return marker;
	const cmd = readCmd(pid);
	return cmd !== null && matchesDaemon(cmd, daemonPaths());
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

		const marker = deps.readEnv ? isDaemonEntrypointEnvironment(deps.readEnv(pid) ?? "") : readDaemonEntrypoint(pid);
		if (marker === true) return pid;
		if (marker === false) return null;

		// On platforms without a readable process environment, only reclaim a
		// live PID whose command line still identifies a Signet daemon.
		const cmd = (deps.readCmd ?? readCmd)(pid);
		if (!cmd) return null;
		const paths = deps.daemonPaths ?? daemonPaths();
		return matchesDaemon(cmd, paths) ? pid : null;
	} catch {
		return null;
	}
}

export async function hasDaemonProcess(agentsDir: string = AGENTS_DIR): Promise<boolean> {
	return readManagedDaemonPid(agentsDir) !== null || findMarkedDaemonProcessPids().length > 0;
}

export async function getDaemonStatus(): Promise<{
	running: boolean;
	pid: number | null;
	uptime: number | null;
	version: string | null;
	host: string | null;
	bindHost: string | null;
	networkMode: string | null;
	resources: DaemonResourceUsage | null;
	extraction: DaemonInstance["extraction"];
	transcripts: DaemonInstance["transcripts"];
	health: DaemonInstance["health"];
	queue: DaemonInstance["queue"];
	probe: DaemonHealthProbe;
	openclaw: DaemonOpenClawHealthSummary | null;
}> {
	const instances = await getDaemonInstances();
	if (instances.length > 0) {
		const preferred = instances.find((instance) => typeof instance.uptime === "number") ?? instances[0];
		const fallbackPid = typeof preferred.pid === "number" ? null : (findMarkedDaemonProcessPids()[0] ?? null);
		return {
			running: true,
			pid: preferred.pid ?? fallbackPid,
			uptime: preferred.uptime,
			version: preferred.version,
			host: preferred.host,
			bindHost: preferred.bindHost,
			networkMode: preferred.networkMode,
			resources: preferred.resources,
			extraction: preferred.extraction,
			transcripts: preferred.transcripts,
			health: preferred.health,
			queue: preferred.queue,
			probe: {
				...preferred.probe,
				processPid: preferred.probe.processPid ?? fallbackPid,
			},
			openclaw: preferred.openclaw,
		};
	}

	const probe = await buildUnreachableDaemonProbe(AGENTS_DIR);
	return {
		running: false,
		pid: probe.processPid,
		uptime: null,
		version: null,
		host: null,
		bindHost: null,
		networkMode: null,
		resources: null,
		extraction: null,
		transcripts: null,
		health: null,
		queue: null,
		probe,
		openclaw: null,
	};
}

export interface DaemonStartArgsInput {
	readonly daemonPath: string;
	readonly agentsDir: string;
	readonly port: number;
	readonly host: string;
	readonly bind: string;
	readonly startupLogPath: string;
	readonly unitName?: string;
	// Service managers do not inherit this debugger setting unless it is explicit.
	readonly bunInspect?: string;
}

export type SystemdDaemonStartArgsInput = DaemonStartArgsInput;

export interface LaunchdDaemonPlistInput extends DaemonStartArgsInput {
	readonly label?: string;
}

export function buildSystemdDaemonStartArgs(input: SystemdDaemonStartArgsInput): string[] {
	return [
		"--user",
		"--quiet",
		"--collect",
		`--unit=${input.unitName ?? `signet-daemon-${process.pid}`}`,
		`--property=WorkingDirectory=${process.cwd()}`,
		"--property=StandardOutput=null",
		`--property=StandardError=append:${input.startupLogPath}`,
		`--setenv=SIGNET_PORT=${input.port}`,
		`--setenv=SIGNET_HOST=${input.host}`,
		`--setenv=SIGNET_BIND=${input.bind}`,
		`--setenv=SIGNET_PATH=${input.agentsDir}`,
		"--setenv=SIGNET_DAEMON_ENTRYPOINT=1",
		...(input.unitName ? [`--setenv=SIGNET_DAEMON_UNIT=${input.unitName}`] : []),
		...(input.bunInspect ? [`--setenv=BUN_INSPECT=${input.bunInspect}`] : []),
		...resolveDaemonLaunchCommand(input.daemonPath),
	];
}

interface DaemonStartDiagnosticsDeps {
	readonly readFileSync: (path: string, encoding: "utf-8") => string;
	readonly existsSync: (path: string) => boolean;
	readonly spawnSync: (
		command: string,
		args: readonly string[],
		options: {
			readonly encoding: "utf8";
			readonly stdio: "pipe";
			readonly windowsHide: true;
			readonly timeout: number;
		},
	) => { readonly stdout?: string };
}

const daemonStartDiagnosticsDeps: DaemonStartDiagnosticsDeps = {
	readFileSync,
	existsSync,
	spawnSync,
};

function tailNonEmptyLines(value: string, max: number): string[] {
	return value
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0)
		.slice(-max);
}

export function readDaemonStartFailureDiagnostics(
	input: {
		readonly startupLogPath: string;
		readonly platform?: NodeJS.Platform;
		readonly systemdUnitName?: string;
	},
	deps: DaemonStartDiagnosticsDeps = daemonStartDiagnosticsDeps,
): string[] {
	if (deps.existsSync(input.startupLogPath)) {
		try {
			const startupLines = tailNonEmptyLines(deps.readFileSync(input.startupLogPath, "utf-8"), 20);
			if (startupLines.length > 0) {
				return ["Daemon failed to start. stderr output:", ...startupLines];
			}
		} catch {
			// Continue to service-manager diagnostics.
		}
	}

	if ((input.platform ?? process.platform) === "linux" && input.systemdUnitName) {
		const result = deps.spawnSync(
			"journalctl",
			[
				"--user",
				"--unit",
				input.systemdUnitName,
				"--since",
				"5 minutes ago",
				"--no-pager",
				"--output=short-iso",
				"-n",
				"40",
			],
			{ encoding: "utf8", stdio: "pipe", windowsHide: true, timeout: 3000 },
		);
		const journal = result.stdout ?? "";
		const journalLines = tailNonEmptyLines(journal, 20);
		if (journalLines.length > 0) {
			return [`Daemon failed to start. journalctl for ${input.systemdUnitName}:`, ...journalLines];
		}
	}

	return [
		"Daemon failed to start, and no startup diagnostics were captured.",
		`Startup log checked: ${input.startupLogPath}`,
	];
}

function findExecutableOnPath(name: string, pathValue: string | undefined = process.env.PATH): string | null {
	if (!pathValue) return null;
	for (const dir of pathValue.split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

export function resolveDaemonRuntimeCommand(
	env: NodeJS.ProcessEnv = process.env,
	execPath: string = process.execPath,
	pathValue: string | undefined = process.env.PATH,
): string {
	if (env.SIGNET_DIR) {
		const nodeName = process.platform === "win32" ? "node.exe" : "node";
		const bundledNode = join(env.SIGNET_DIR, "runtime", "node", "bin", nodeName);
		if (existsSync(bundledNode)) return bundledNode;
	}

	if (basename(execPath).startsWith("bun")) return execPath;
	const found = findExecutableOnPath("bun", pathValue);
	if (found) return found;
	throw new Error("bun executable not found on PATH. Reinstall bun or run signet with bun.");
}

function isJavaScriptDaemonPath(path: string): boolean {
	return path.endsWith(".js") || path.endsWith(".ts");
}

export function resolveDaemonLaunchCommand(daemonPath: string, env: NodeJS.ProcessEnv = process.env): string[] {
	if (!isJavaScriptDaemonPath(daemonPath)) {
		return [daemonPath];
	}
	return [resolveDaemonRuntimeCommand(env), daemonPath];
}

export function macOSLaunchAgentAttributionNotice(
	daemonPath: string,
	opts: {
		readonly env?: NodeJS.ProcessEnv;
		readonly execPath?: string;
		readonly pathValue?: string;
		readonly platform?: NodeJS.Platform;
	} = {},
): string | null {
	if ((opts.platform ?? process.platform) !== "darwin" || !isJavaScriptDaemonPath(daemonPath)) {
		return null;
	}

	const runtime = resolveDaemonRuntimeCommand(opts.env, opts.execPath, opts.pathValue);
	const runtimeName = basename(runtime).startsWith("bun")
		? "Bun"
		: basename(runtime).startsWith("node")
			? "Node.js"
			: basename(runtime);
	const signer = runtimeName === "Bun" ? "Bun's signer (for example, Jarred Sumner)" : `${runtimeName}'s signer`;
	return `macOS may show a Login Items / Background Activity notification naming ${signer} instead of Signet. This is expected when Signet is started from a source checkout or JavaScript daemon path. The public curl, npm, and Bun installers use the compiled Signet binary instead.`;
}

function xmlEscape(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

export const LAUNCHD_DAEMON_LABEL = "ai.signet.daemon";

function currentLaunchdDomain(): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : null;
	return uid === null ? "user" : `gui/${uid}`;
}

export function launchdDaemonPlistPath(_agentsDir: string, home: string = homedir()): string {
	return join(home, "Library", "LaunchAgents", `${LAUNCHD_DAEMON_LABEL}.plist`);
}

export function buildLaunchdDaemonPlist(input: LaunchdDaemonPlistInput): string {
	const label = input.label ?? LAUNCHD_DAEMON_LABEL;
	const programArguments = resolveDaemonLaunchCommand(input.daemonPath)
		.map(
			(arg) => `
		<string>${xmlEscape(arg)}</string>`,
		)
		.join("");
	const env = {
		SIGNET_PORT: String(input.port),
		SIGNET_HOST: input.host,
		SIGNET_BIND: input.bind,
		SIGNET_PATH: input.agentsDir,
		SIGNET_DAEMON_ENTRYPOINT: "1",
		...(input.bunInspect ? { BUN_INSPECT: input.bunInspect } : {}),
		...(process.env.SIGNET_DIR ? { SIGNET_DIR: process.env.SIGNET_DIR } : {}),
		...(process.env.SIGNET_DASHBOARD_DIR ? { SIGNET_DASHBOARD_DIR: process.env.SIGNET_DASHBOARD_DIR } : {}),
		HOME: process.env.HOME ?? homedir(),
		PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
	};
	const envEntries = Object.entries(env)
		.map(
			([key, value]) => `
			<key>${xmlEscape(key)}</key>
			<string>${xmlEscape(value)}</string>`,
		)
		.join("");

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xmlEscape(label)}</string>
	<key>ProgramArguments</key>
	<array>
${programArguments}
	</array>
	<key>EnvironmentVariables</key>
	<dict>${envEntries}
	</dict>
	<key>WorkingDirectory</key>
	<string>${xmlEscape(process.cwd())}</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>/dev/null</string>
	<key>StandardErrorPath</key>
	<string>${xmlEscape(input.startupLogPath)}</string>
	<key>ProcessType</key>
	<string>Background</string>
</dict>
</plist>
`;
}

export function buildLaunchdDaemonStartArgs(plistPath: string): string[] {
	return ["bootstrap", currentLaunchdDomain(), plistPath];
}

export function buildLaunchdDaemonStopArgs(label: string = LAUNCHD_DAEMON_LABEL): string[] {
	return ["bootout", `${currentLaunchdDomain()}/${label}`];
}

/** Minimal structural shape of the `launchctl print` probe so tests can stub it. */
type LaunchctlProbeSpawnSync = (
	command: string,
	args: readonly string[],
	options: { readonly stdio: "ignore"; readonly windowsHide: boolean; readonly timeout: number },
) => {
	readonly status: number | null;
};

/**
 * Whether launchd currently has the Signet daemon job loaded. Under KeepAlive
 * the job respawns the daemon on exit, so `stop`/`start` must coordinate with
 * it. The check is darwin-only; other platforms return false.
 */
export function isLaunchdDaemonLoaded(
	deps: { readonly platform?: NodeJS.Platform; readonly spawnSync?: LaunchctlProbeSpawnSync } = {},
): boolean {
	if ((deps.platform ?? process.platform) !== "darwin") return false;
	const spawn = deps.spawnSync ?? spawnSync;
	const result = spawn("launchctl", ["print", `${currentLaunchdDomain()}/${LAUNCHD_DAEMON_LABEL}`], {
		stdio: "ignore",
		windowsHide: true,
		timeout: 3000,
	});
	return result.status === 0;
}

export function didSystemdDaemonStart(result: Pick<SpawnSyncReturns<Buffer>, "status" | "signal" | "error">): boolean {
	return result.status === 0 && result.signal === null && result.error === undefined;
}

export const didLaunchdDaemonStart = didSystemdDaemonStart;

export async function startDaemon(agentsDir: string = AGENTS_DIR, preferredDaemonPath?: string): Promise<boolean> {
	if ((await isDaemonRunning()) || (await hasDaemonProcess(agentsDir))) return true;

	const daemonPath = preferredDaemonPath ?? resolveDaemonPath();
	if (!daemonPath) {
		console.error(chalk.red("Daemon not found. Try reinstalling signet."));
		return false;
	}

	const net = resolveDaemonNetwork(agentsDir, process.env);

	const daemonDir = join(agentsDir, ".daemon");
	const logDir = join(daemonDir, "logs");
	mkdirSync(daemonDir, { recursive: true });
	mkdirSync(logDir, { recursive: true });

	const attributionNotice = macOSLaunchAgentAttributionNotice(daemonPath);
	if (attributionNotice) {
		console.warn(chalk.yellow(`  Note: ${attributionNotice}`));
	}

	const startupLogPath = join(logDir, "startup.log");
	// Transient unit name derived from the starting CLI's pid; used for the
	// systemd-run unit and, via --setenv SIGNET_DAEMON_UNIT, recorded in the
	// daemon lifecycle record so post-mortems can query the unit's journald
	// exit status (issue #1148).
	const systemdUnitName = `signet-daemon-${process.pid}`;
	let stderrFd: number | null = null;
	let stderrTarget: "ignore" | number = "ignore";
	try {
		stderrFd = openSync(startupLogPath, "w");
		stderrTarget = stderrFd;
	} catch {
		// Non-fatal.
	}

	const daemonEnv = {
		...process.env,
		SIGNET_PORT: DEFAULT_PORT.toString(),
		SIGNET_HOST: net.host,
		SIGNET_BIND: net.bind,
		SIGNET_PATH: agentsDir,
		SIGNET_DAEMON_ENTRYPOINT: "1",
		// SIGNET_DAEMON_UNIT is deliberately NOT set here: it is only meaningful
		// when systemd-run actually creates the transient unit (the --setenv in
		// buildSystemdDaemonStartArgs). On the launchd/detached-spawn fallback
		// paths the daemon must not record a unit name that does not exist, or
		// the doctor journalctl pointer would be fabricated.
	};

	// `detached: true` only creates a new process group; it does not escape the
	// caller's service manager ownership. If `signet daemon start` is run from a
	// short-lived Linux systemd unit or macOS launchd job, that owner can reap the
	// daemon when the caller exits. Prefer the platform service manager first so
	// the daemon is owned independently, then fall back to detached spawn on
	// platforms or environments where that is unavailable.
	let procExited = false;
	let startedByServiceManager = false;
	if (process.platform === "linux") {
		const systemdArgs = buildSystemdDaemonStartArgs({
			daemonPath,
			agentsDir,
			port: DEFAULT_PORT,
			host: net.host,
			bind: net.bind,
			startupLogPath,
			unitName: systemdUnitName,
			bunInspect: process.env.BUN_INSPECT,
		});
		const result = spawnSync("systemd-run", systemdArgs, {
			stdio: ["ignore", "ignore", stderrTarget],
			windowsHide: true,
			env: daemonEnv,
			timeout: 5000,
		});
		startedByServiceManager = didSystemdDaemonStart(result);
		if (!startedByServiceManager) {
			try {
				appendFileSync(
					startupLogPath,
					`[systemd-run fallback] status=${result.status ?? "null"} error=${result.error?.message ?? ""}\n`,
				);
			} catch {
				// Best effort.
			}
		}
	} else if (process.platform === "darwin") {
		const plistPath = launchdDaemonPlistPath(agentsDir);
		mkdirSync(dirname(plistPath), { recursive: true });
		writeFileSync(
			plistPath,
			buildLaunchdDaemonPlist({
				daemonPath,
				agentsDir,
				port: DEFAULT_PORT,
				host: net.host,
				bind: net.bind,
				startupLogPath,
				bunInspect: process.env.BUN_INSPECT,
			}),
		);
		// Boot out any loaded job before (re)bootstrap. When no job is loaded
		// (fresh start, or a restart that already booted it out), launchctl
		// exits 3 with "Boot-out failed: 3: No such process" — launchd handoff
		// noise, not a start failure. Skip the bootout in that case so the
		// message never pollutes the startup log (#1074).
		let bootout: SpawnSyncReturns<Buffer> | null = null;
		if (isLaunchdDaemonLoaded()) {
			bootout = spawnSync("launchctl", buildLaunchdDaemonStopArgs(), {
				stdio: ["ignore", "ignore", stderrTarget],
				windowsHide: true,
				env: daemonEnv,
				timeout: 5000,
			});
		}
		const bootstrap = spawnSync("launchctl", buildLaunchdDaemonStartArgs(plistPath), {
			stdio: ["ignore", "ignore", stderrTarget],
			windowsHide: true,
			env: daemonEnv,
			timeout: 5000,
		});
		startedByServiceManager = didLaunchdDaemonStart(bootstrap);
		if (!startedByServiceManager) {
			const target = buildLaunchdDaemonStopArgs()[1];
			const kickstart = spawnSync("launchctl", ["kickstart", "-k", target], {
				stdio: ["ignore", "ignore", stderrTarget],
				windowsHide: true,
				env: daemonEnv,
				timeout: 5000,
			});
			startedByServiceManager = didLaunchdDaemonStart(kickstart);
			if (!startedByServiceManager) {
				try {
					appendFileSync(
						startupLogPath,
						`[launchd fallback] bootoutStatus=${bootout ? (bootout.status ?? "null") : "skipped"} bootstrapStatus=${bootstrap.status ?? "null"} kickstartStatus=${kickstart.status ?? "null"} bootoutError=${bootout?.error?.message ?? ""} bootstrapError=${bootstrap.error?.message ?? ""} kickstartError=${kickstart.error?.message ?? ""}
`,
					);
				} catch {
					// Best effort.
				}
			}
		}
	}

	if (!startedByServiceManager) {
		const [command, ...args] = resolveDaemonLaunchCommand(daemonPath);
		const proc = spawn(command, args, {
			detached: true,
			stdio: ["ignore", "ignore", stderrTarget],
			windowsHide: true,
			env: daemonEnv,
		});

		proc.on("error", (err) => {
			try {
				appendFileSync(startupLogPath, `[spawn error] ${err.message}\n`);
			} catch {
				// Best effort.
			}
		});

		// Track process exit so the poll loop can short-circuit on fast failures
		// (port conflict, missing binary, bad config) rather than waiting the
		// full deadline.
		proc.on("exit", () => {
			procExited = true;
		});

		if (typeof proc.pid === "number") {
			try {
				writeFileSync(pidFile(agentsDir), `${proc.pid}\n`);
			} catch {
				// Best effort.
			}
		}

		proc.unref();
	}
	if (stderrFd !== null) {
		closeSync(stderrFd);
	}

	// Use wall-clock deadline instead of iteration count so the budget
	// is always sufficient regardless of how long each health probe takes.
	// A large/legacy workspace may need 30-40s for migrations + startup
	// recovery before the HTTP server binds. 60s covers the worst case
	// while still failing fast on a genuinely broken daemon.
	// If the spawned process exits early (fast failure), break immediately.
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		await sleep(250);
		if (procExited) break;
		// Check liveness first (cheap, DB-free /health/live), then health
		// (DB-touching /health). On a fresh start the server may bind before
		// migrations finish — /health/live catches that case.
		for (const baseUrl of DAEMON_BASE_URLS) {
			if (await isDaemonAliveAt(baseUrl)) return true;
		}
		if (await isDaemonRunning()) {
			return true;
		}
	}

	try {
		const diagnostics = readDaemonStartFailureDiagnostics({
			startupLogPath,
			systemdUnitName: process.platform === "linux" ? systemdUnitName : undefined,
		});
		if (diagnostics.length > 0) {
			console.error(chalk.red(`\n${diagnostics[0]}`));
			for (const line of diagnostics.slice(1)) {
				console.error(chalk.dim(line));
			}
		}
	} catch {
		// Best effort.
	}

	return false;
}

export async function stopDaemon(agentsDir: string = AGENTS_DIR, preferredPid?: number): Promise<boolean> {
	if (process.platform === "darwin") {
		spawnSync("launchctl", buildLaunchdDaemonStopArgs(), {
			stdio: "ignore",
			windowsHide: true,
			timeout: 5000,
		});
	}

	const pids = new Set<number>();
	if (preferredPid !== undefined && readManagedDaemonProcess(preferredPid)) {
		pids.add(preferredPid);
	}
	const managed = readManagedDaemonPid(agentsDir);
	if (managed !== null) {
		pids.add(managed);
	}

	for (const instance of await getDaemonInstances()) {
		if (typeof instance.pid === "number" && readManagedDaemonProcess(instance.pid)) {
			pids.add(instance.pid);
		}
	}
	for (const pid of findMarkedDaemonProcessPids()) {
		pids.add(pid);
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
