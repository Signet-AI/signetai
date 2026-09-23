/**
 * Fast source-run boot guard for the daemon's most dangerous failure mode:
 * startup completes neither liveness nor idle. The gate deliberately runs the
 * real daemon from TypeScript, then observes the real HTTP process and its OS
 * CPU usage instead of testing an in-process mock.
 *
 * Usage:
 *   bun tests/integration/boot-wedge/run.ts [--out DIR]
 */

import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	BOOT_TIMEOUT_MS,
	CPU_CEILING_PERCENT,
	CPU_INTERVAL_MS,
	LIVE_INTERVAL_MS,
	LIVE_REQUEST_TIMEOUT_MS,
	MIN_CPU_SAMPLES,
	OBSERVATION_MS,
	evaluateBootWedge,
	type BootWedgeMeasurements,
} from "./criteria";

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const daemonScript = join(repoRoot, "platform/daemon/src/daemon.ts");
const CPU_COUNT = cpus().length;
const STOP_GRACE_MS = 5_000;
const STOP_POLL_MS = 50;
const outputDir = process.argv.includes("--out")
	? resolve(process.argv[process.argv.indexOf("--out") + 1] ?? "boot-wedge-artifacts")
	: null;
const outputPath = join(outputDir ?? tmpdir(), "boot-wedge.json");

interface CpuSnapshot {
	readonly processTicks: number;
	readonly totalTicks: number;
	readonly processCount: number;
}

export interface ProcEntry {
	readonly pid: number;
	readonly parentPid: number;
	readonly processGroupId: number;
	readonly processTicks: number;
}

export interface ProcessTargets {
	readonly pids: readonly number[];
	readonly processGroups: readonly number[];
}

interface CpuSample {
	readonly at: number;
	readonly percent: number;
	readonly processCount: number;
}

interface LiveMeasurement {
	readonly samples: number;
	readonly successes: number;
	readonly failures: number;
	readonly maxMs: number;
	readonly latenciesMs: readonly number[];
}

interface BootWedgeReport {
	readonly harness: "boot-wedge";
	readonly platform: NodeJS.Platform;
	readonly pid: number | null;
	readonly startupMs: number;
	readonly observationMs: number;
	readonly cpu: {
		readonly available: boolean;
		readonly samples: readonly CpuSample[];
		readonly maxPercent: number;
		readonly ceilingPercent: number;
	};
	readonly live: LiveMeasurement;
	readonly evaluation: ReturnType<typeof evaluateBootWedge>;
	readonly daemonStdoutTail: string;
	readonly daemonStderrTail: string;
	readonly error?: string;
}

function parseOutputDir(): void {
	if (outputDir) mkdirSync(outputDir, { recursive: true });
}

function appendBounded(target: string[], chunk: Buffer): void {
	target.push(chunk.toString("utf8"));
	const text = target.join("");
	if (text.length > 16_000) {
		target.splice(0, target.length, text.slice(-16_000));
	}
}

function reservePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("could not obtain an ephemeral loopback port"));
				return;
			}
			server.close((error) => (error ? reject(error) : resolvePort(address.port)));
		});
	});
}

function readProcEntry(pid: number): ProcEntry | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const closingParen = stat.lastIndexOf(")");
		if (closingParen < 0) return null;
		const fields = stat
			.slice(closingParen + 2)
			.trim()
			.split(/\s+/);
		const parentPid = Number(fields[1]);
		const processGroupId = Number(fields[2]);
		const userTicks = Number(fields[11]);
		const systemTicks = Number(fields[12]);
		if (![parentPid, processGroupId, userTicks, systemTicks].every(Number.isFinite)) return null;
		return { pid, parentPid, processGroupId, processTicks: userTicks + systemTicks };
	} catch {
		return null;
	}
}

function readProcEntries(): ProcEntry[] {
	if (process.platform !== "linux") return [];
	try {
		return readdirSync("/proc")
			.filter((name) => /^\d+$/.test(name))
			.map((name) => readProcEntry(Number(name)))
			.filter((entry): entry is ProcEntry => entry !== null);
	} catch {
		return [];
	}
}

function processTree(rootPid: number, entries: readonly ProcEntry[]): Set<number> {
	const childrenByParent = new Map<number, number[]>();
	for (const entry of entries) {
		const children = childrenByParent.get(entry.parentPid) ?? [];
		children.push(entry.pid);
		childrenByParent.set(entry.parentPid, children);
	}
	const tree = new Set<number>([rootPid]);
	const pending = [rootPid];
	while (pending.length > 0) {
		const parentPid = pending.pop();
		if (parentPid === undefined) continue;
		for (const childPid of childrenByParent.get(parentPid) ?? []) {
			if (tree.has(childPid)) continue;
			tree.add(childPid);
			pending.push(childPid);
		}
	}
	return tree;
}

export function snapshotProcessTargets(rootPid: number, entries: readonly ProcEntry[]): ProcessTargets {
	if (!entries.some((entry) => entry.pid === rootPid)) return { pids: [], processGroups: [] };
	const tree = processTree(rootPid, entries);
	const processGroups = new Set<number>();
	for (const entry of entries) {
		if (tree.has(entry.pid) && entry.processGroupId > 0) processGroups.add(entry.processGroupId);
	}
	return {
		pids: [...tree].filter((pid) => pid !== rootPid),
		processGroups: [...processGroups],
	};
}

export function hasLiveProcessTarget(
	targets: ProcessTargets,
	isPidAlive: (pid: number) => boolean,
	isProcessGroupAlive: (processGroupId: number) => boolean,
): boolean {
	return targets.pids.some(isPidAlive) || targets.processGroups.some(isProcessGroupAlive);
}

function readCpuSnapshot(pid: number): CpuSnapshot | null {
	if (process.platform !== "linux") return null;
	const entries = readProcEntries();
	const root = entries.find((entry) => entry.pid === pid);
	if (!root) return null;
	const tree = processTree(pid, entries);
	const processTicks = entries
		.filter((entry) => tree.has(entry.pid))
		.reduce((sum, entry) => sum + entry.processTicks, 0);
	try {
		const cpuLine = readFileSync("/proc/stat", "utf8").split("\n", 1)[0] ?? "";
		const totalTicks = cpuLine
			.trim()
			.split(/\s+/)
			.slice(1)
			.reduce((sum, value) => sum + Number(value), 0);
		if (!Number.isFinite(totalTicks)) return null;
		return { processTicks, totalTicks, processCount: tree.size };
	} catch {
		return null;
	}
}

function cpuPercent(previous: CpuSnapshot, current: CpuSnapshot): number | null {
	const processDelta = current.processTicks - previous.processTicks;
	const totalDelta = current.totalTicks - previous.totalTicks;
	if (processDelta < 0 || totalDelta <= 0) return null;
	return (processDelta / totalDelta) * CPU_COUNT * 100;
}

function childIsAlive(child: ChildProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}

export function isLivePayload(body: string, expectedPid: number, expectedPort: number): boolean {
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed !== "object" || parsed === null) return false;
		const record = parsed as Record<string, unknown>;
		return record.pid === expectedPid && record.port === expectedPort && record.status === "healthy";
	} catch {
		return false;
	}
}

export async function isLiveResponse(response: Response, expectedPid: number, expectedPort: number): Promise<boolean> {
	const body = await response.text();
	if (response.status !== 200) return false;
	return isLivePayload(body, expectedPid, expectedPort);
}

async function waitForLive(origin: string, port: number, child: ChildProcess): Promise<number> {
	const startedAt = Date.now();
	const deadline = startedAt + BOOT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (!childIsAlive(child)) {
			throw new Error(
				`daemon exited during startup (code=${child.exitCode ?? "null"}, signal=${child.signalCode ?? "null"})`,
			);
		}
		try {
			const response = await fetch(`${origin}/health/live`, {
				signal: AbortSignal.timeout(LIVE_REQUEST_TIMEOUT_MS),
			});
			if (await isLiveResponse(response, child.pid, port)) return Date.now() - startedAt;
		} catch {
			// Startup is expected to refuse connections until the listener binds.
		}
		await Bun.sleep(100);
	}
	throw new Error(`daemon did not become live within ${BOOT_TIMEOUT_MS}ms`);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function processGroupAlive(processGroupId: number): boolean {
	if (process.platform === "win32") return false;
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch {
		return false;
	}
}

function signalProcessTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL", targets: ProcessTargets): void {
	// Snapshot process groups before signalling. Detached descendants have their
	// own groups and can be reparented as soon as the daemon exits.
	if (process.platform !== "win32") {
		for (const processGroupId of targets.processGroups) {
			if (processGroupId <= 1) continue;
			try {
				process.kill(-processGroupId, signal);
			} catch {}
		}
	}

	// Direct PID signals cover partially-created groups and the Windows path.
	// Descendants are signalled before the parent so shutdown cannot orphan a
	// DB-owner or worker process.
	for (const pid of [...targets.pids].reverse()) {
		try {
			process.kill(pid, signal);
		} catch {}
	}
	if (childIsAlive(child)) {
		try {
			child.kill(signal);
		} catch {}
	}
}

function stopPending(child: ChildProcess, targets: ProcessTargets): boolean {
	return childIsAlive(child) || hasLiveProcessTarget(targets, processAlive, processGroupAlive);
}

function mergeProcessTargets(current: ProcessTargets, next: ProcessTargets): ProcessTargets {
	return {
		pids: [...new Set([...current.pids, ...next.pids])],
		processGroups: [...new Set([...current.processGroups, ...next.processGroups])],
	};
}

async function waitForStopped(
	child: ChildProcess,
	timeoutMs: number,
	targets: ProcessTargets,
): Promise<{ readonly stopped: boolean; readonly targets: ProcessTargets }> {
	const deadline = Date.now() + timeoutMs;
	let currentTargets = targets;
	while (Date.now() < deadline) {
		// Re-scan while the root is present, then retain every discovered target
		// after it exits so detached descendants cannot disappear from tracking.
		if (childIsAlive(child) && process.platform === "linux") {
			currentTargets = mergeProcessTargets(currentTargets, snapshotProcessTargets(child.pid, readProcEntries()));
		}
		if (!stopPending(child, currentTargets)) return { stopped: true, targets: currentTargets };
		await Bun.sleep(STOP_POLL_MS);
	}
	return { stopped: !stopPending(child, currentTargets), targets: currentTargets };
}

async function stopChild(child: ChildProcess | null): Promise<boolean> {
	if (!child) return true;
	let targets =
		process.platform === "linux"
			? snapshotProcessTargets(child.pid, readProcEntries())
			: { pids: [], processGroups: [] };
	if (!stopPending(child, targets)) return true;
	signalProcessTree(child, "SIGTERM", targets);
	const grace = await waitForStopped(child, STOP_GRACE_MS, targets);
	if (grace.stopped) return true;
	targets = grace.targets;
	signalProcessTree(child, "SIGKILL", targets);
	return (await waitForStopped(child, STOP_POLL_MS * 20, targets)).stopped;
}

function writeConfig(agentsDir: string): void {
	writeFileSync(
		join(agentsDir, "agent.yaml"),
		[
			"embedding:",
			"  provider: none",
			"memory:",
			"  pipelineV2:",
			"    enabled: true",
			"    hints:",
			"      enabled: false",
			"    reflections:",
			"      enabled: false",
			"    embeddingTracker:",
			"      enabled: false",
			"    modelRegistry:",
			"      enabled: false",
			"    procedural:",
			"      enabled: false",
			"    feedback:",
			"      enabled: false",
			"    significance:",
			"      enabled: false",
			"    telemetryEnabled: false",
			"",
		].join("\n"),
	);
}

async function run(): Promise<BootWedgeReport> {
	const workspace = mkdtempSync(join(tmpdir(), "signet-boot-wedge-"));
	const agentsDir = join(workspace, "agents");
	mkdirSync(join(agentsDir, ".daemon", "logs"), { recursive: true });
	mkdirSync(join(agentsDir, "memory"), { recursive: true });
	const database = new Database(join(agentsDir, "memory", "memories.db"));
	database.close();
	writeConfig(agentsDir);

	let child: ChildProcess | null = null;
	const stdout: string[] = [];
	const stderr: string[] = [];
	let startupMs = -1;
	const liveLatencies: number[] = [];
	let liveSuccesses = 0;
	let liveFailures = 0;
	const cpuSamples: CpuSample[] = [];
	let error: string | undefined;
	try {
		const port = await reservePort();
		const daemonHome = join(workspace, "home");
		mkdirSync(daemonHome, { recursive: true });
		child = spawn(process.execPath, [daemonScript], {
			cwd: repoRoot,
			detached: process.platform !== "win32",
			env: {
				...process.env,
				HOME: daemonHome,
				USERPROFILE: daemonHome,
				CODEX_HOME: join(daemonHome, ".codex"),
				CLAUDE_CONFIG_DIR: join(daemonHome, ".claude"),
				HERMES_HOME: join(daemonHome, ".hermes"),
				SIGNET_PATH: agentsDir,
				SIGNET_PORT: String(port),
				SIGNET_HOST: "127.0.0.1",
				SIGNET_BIND: "127.0.0.1",
				SIGNET_TELEMETRY_OPTOUT: "1",
				SIGNET_DAEMON_ENTRYPOINT: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.on("error", (caught) => {
			error = `daemon spawn failed: ${caught instanceof Error ? caught.message : String(caught)}`;
		});
		child.stdout?.on("data", (chunk: Buffer) => appendBounded(stdout, chunk));
		child.stderr?.on("data", (chunk: Buffer) => appendBounded(stderr, chunk));

		const origin = `http://127.0.0.1:${port}`;
		startupMs = await waitForLive(origin, port, child);
		const observationStartedAt = Date.now();
		let previousCpu = readCpuSnapshot(child.pid);
		let previousCpuAt = performance.now();
		while (Date.now() - observationStartedAt < OBSERVATION_MS) {
			const liveStartedAt = performance.now();
			let status = 0;
			try {
				const response = await fetch(`${origin}/health/live`, {
					signal: AbortSignal.timeout(LIVE_REQUEST_TIMEOUT_MS),
				});
				status = (await isLiveResponse(response, child.pid, port)) ? 200 : 0;
			} catch {
				status = 0;
			}
			liveLatencies.push(performance.now() - liveStartedAt);
			if (status === 200) liveSuccesses++;
			else liveFailures++;

			const now = performance.now();
			if (now - previousCpuAt >= CPU_INTERVAL_MS) {
				const currentCpu = readCpuSnapshot(child.pid);
				if (previousCpu && currentCpu) {
					const percent = cpuPercent(previousCpu, currentCpu);
					if (percent !== null) cpuSamples.push({ at: Date.now(), percent, processCount: currentCpu.processCount });
				}
				if (currentCpu) previousCpu = currentCpu;
				previousCpuAt = now;
			}
			if (status !== 200 || !childIsAlive(child)) {
				throw new Error(
					`liveness failed during observation (status=${status}, code=${child.exitCode ?? "null"}, signal=${child.signalCode ?? "null"})`,
				);
			}
			await Bun.sleep(LIVE_INTERVAL_MS);
		}
		if (!childIsAlive(child)) {
			throw new Error(
				`daemon exited at the end of observation (code=${child.exitCode ?? "null"}, signal=${child.signalCode ?? "null"})`,
			);
		}
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	} finally {
		const stopped = await stopChild(child);
		if (!stopped && error === undefined) error = "daemon process tree did not stop after SIGKILL";
		rmSync(workspace, { recursive: true, force: true });
	}

	const live: LiveMeasurement = {
		samples: liveLatencies.length,
		successes: liveSuccesses,
		failures: liveFailures,
		maxMs: liveLatencies.length > 0 ? Math.max(...liveLatencies) : 0,
		latenciesMs: liveLatencies,
	};
	const measurements: BootWedgeMeasurements = {
		startupMs,
		live,
		cpu: {
			samples: cpuSamples.length,
			maxPercent: cpuSamples.length > 0 ? Math.max(...cpuSamples.map((sample) => sample.percent)) : 0,
		},
	};
	const baseEvaluation = evaluateBootWedge(measurements);
	const evaluation = error
		? {
				...baseEvaluation,
				pass: false,
				checks: [
					...baseEvaluation.checks,
					{ name: "harness completes without an error", pass: false, observed: error, limit: "no harness error" },
				],
			}
		: baseEvaluation;
	const report: BootWedgeReport = {
		harness: "boot-wedge",
		platform: process.platform,
		pid: child?.pid ?? null,
		startupMs,
		observationMs: OBSERVATION_MS,
		cpu: {
			available: process.platform === "linux" && cpuSamples.length >= MIN_CPU_SAMPLES,
			samples: cpuSamples,
			maxPercent: measurements.cpu.maxPercent,
			ceilingPercent: CPU_CEILING_PERCENT,
		},
		live,
		evaluation,
		daemonStdoutTail: stdout.join(""),
		daemonStderrTail: stderr.join(""),
		...(error ? { error } : {}),
	};
	return report;
}

if (import.meta.main) {
	parseOutputDir();
	const report = await run();
	writeFileSync(outputPath, JSON.stringify(report, null, 2));
	for (const check of report.evaluation.checks) {
		console.error(`  ${check.pass ? "PASS" : "FAIL"}  ${check.name}: ${check.observed} (limit ${check.limit})`);
	}
	console.error(`  artifact: ${outputPath}`);
	if (report.error) console.error(`  error: ${report.error}`);
	process.exitCode = report.evaluation.pass ? 0 : 1;
}
