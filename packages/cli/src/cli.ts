#!/usr/bin/env node
/**
 * Signet CLI
 * Own your agent. Bring it anywhere.
 */

import { spawn, spawnSync } from "child_process";
import { createHash } from "crypto";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { homedir, platform, tmpdir } from "os";
import { dirname, join, resolve as resolvePath } from "path";
import { fileURLToPath } from "url";
import { ClaudeCodeConnector } from "@signet/connector-claude-code";
import { CodexConnector } from "@signet/connector-codex";
import { OpenClawConnector } from "@signet/connector-openclaw";
import { OpenCodeConnector } from "@signet/connector-opencode";
import {
	IDENTITY_FILES,
	type ImportResult,
	type MigrationResult,
	type SchemaInfo,
	type SetupDetection,
	type SkillsResult,
	detectExistingSetup as detectExistingSetupCore,
	formatYaml,
	getGlobalInstallCommand,
	resolveGlobalPackagePath,
	getMissingIdentityFiles,
	getSkillsRunnerCommand,
	hasValidIdentity,
	importMemoryLogs,
	loadSqliteVec,
	parseSimpleYaml,
	resolvePrimaryPackageManager,
	symlinkSkills,
	readStaticIdentity,
	unifySkills,
} from "@signet/core";
import chalk from "chalk";
import { Command } from "commander";
import ora from "ora";
import {
	type CondaInfo,
	type PyenvInfo,
	type PythonInfo,
	checkZvecInstalled,
	createCondaEnv,
	createVenv,
	detectBestPython,
	detectConda,
	detectPyenv,
	detectSystemPython,
	getCondaPython,
	getPyenvPython,
	installDeps,
	installPyenvPython,
	isZvecCompatible,
} from "./python.js";
import Database from "./sqlite.js";
import { registerBrowseCommand } from "./browse.js";
import { registerAppCommands } from "./commands/app.js";
import { registerDaemonCommands } from "./commands/daemon.js";
import { registerGitCommands } from "./commands/git.js";
import { registerHookCommands } from "./commands/hook.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerPortableCommands } from "./commands/portable.js";
import { registerSecretCommands } from "./commands/secret.js";
import { registerSessionCommands } from "./commands/session.js";
import { registerSkillCommands } from "./commands/skill.js";
import { registerUpdateCommands } from "./commands/update.js";
import { registerVectorCommands } from "./commands/vector.js";
import { configureAgent } from "./features/configure.js";
import { doRestart, doStart, doStop, launchDashboard, migrateSchema, showLogs } from "./features/daemon.js";
import { getStatusReport, showDoctor, showStatus } from "./features/health.js";
import { importFromGitHub } from "./features/import.js";
import { setupWizard } from "./features/setup.js";
import { syncTemplates } from "./features/sync.js";
import { createDaemonClient, ensureDaemonRunning } from "./lib/daemon.js";
import { gitAddAndCommit, gitInit, isGitRepo } from "./lib/git.js";

// Template directory location (relative to built CLI)
function getTemplatesDir() {
	const devPath = join(__dirname, "..", "templates");
	const distPath = join(__dirname, "..", "..", "templates");

	if (existsSync(devPath)) return devPath;
	if (existsSync(distPath)) return distPath;

	return join(__dirname, "templates");
}

function copyDirRecursive(src: string, dest: string) {
	mkdirSync(dest, { recursive: true });
	const entries = readdirSync(src, { withFileTypes: true });

	for (const entry of entries) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);

		if (entry.isDirectory()) {
			copyDirRecursive(srcPath, destPath);
		} else {
			copyFileSync(srcPath, destPath);
		}
	}
}

function isBuiltinSkillDir(skillDir: string): boolean {
	const skillMdPath = join(skillDir, "SKILL.md");
	if (!existsSync(skillMdPath)) {
		return false;
	}

	try {
		const content = readFileSync(skillMdPath, "utf-8");
		const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!frontmatter) {
			return false;
		}

		return /^builtin:\s*true$/m.test(frontmatter[1]);
	} catch {
		return false;
	}
}

function syncBuiltinSkills(
	templatesDir: string,
	basePath: string,
): {
	installed: string[];
	updated: string[];
	skipped: string[];
} {
	const skillsSource = join(templatesDir, "skills");
	const skillsDest = join(basePath, "skills");
	const result = {
		installed: [] as string[],
		updated: [] as string[],
		skipped: [] as string[],
	};

	if (!existsSync(skillsSource)) {
		return result;
	}

	mkdirSync(skillsDest, { recursive: true });

	const entries = readdirSync(skillsSource, { withFileTypes: true }).filter((d) => d.isDirectory());

	for (const entry of entries) {
		const src = join(skillsSource, entry.name);
		const dest = join(skillsDest, entry.name);

		if (!existsSync(dest)) {
			copyDirRecursive(src, dest);
			result.installed.push(entry.name);
			continue;
		}

		try {
			const destStat = lstatSync(dest);
			if (destStat.isSymbolicLink() || !destStat.isDirectory()) {
				result.skipped.push(entry.name);
				continue;
			}
		} catch {
			result.skipped.push(entry.name);
			continue;
		}

		if (!isBuiltinSkillDir(dest)) {
			result.skipped.push(entry.name);
			continue;
		}

		copyDirRecursive(src, dest);
		result.updated.push(entry.name);
	}

	return result;
}

// ============================================================================
// Daemon Management
// ============================================================================

const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");
const DEFAULT_PORT = 3850;
const DAEMON_BASE_URLS = [`http://127.0.0.1:${DEFAULT_PORT}`, `http://[::1]:${DEFAULT_PORT}`] as const;

interface DaemonInstance {
	readonly baseUrl: string;
	readonly pid: number | null;
	readonly uptime: number | null;
	readonly version: string | null;
}

function sleep(ms: number): Promise<void> {
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

async function getReachableDaemonUrls(): Promise<string[]> {
	const checks = await Promise.all(
		DAEMON_BASE_URLS.map(async (baseUrl) => ((await isDaemonHealthyAt(baseUrl)) ? baseUrl : null)),
	);
	return checks.flatMap((url) => (url === null ? [] : [url]));
}

async function getDaemonInstances(): Promise<DaemonInstance[]> {
	const urls = await getReachableDaemonUrls();
	const instances = await Promise.all(
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
				// Fall back to health-only instance metadata
			}

			return {
				baseUrl,
				pid: null,
				uptime: null,
				version: null,
			};
		}),
	);

	return instances;
}

async function isDaemonRunning(): Promise<boolean> {
	const urls = await getReachableDaemonUrls();
	return urls.length > 0;
}

async function getDaemonStatus(): Promise<{
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
		const raw = readFileSync(join(__dirname, "..", "package.json"), "utf8");
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
	const binDir = join(__dirname, "..", "bin");
	const dest = join(binDir, name);
	if (existsSync(dest)) return;

	const base = `https://github.com/Signet-AI/signetai/releases/download/v${version}`;
	process.stdout.write(`  Downloading Rust daemon binary (${name})...`);

	try {
		// Fetch checksum first — abort if unavailable so we don't run an unverified binary
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

		// Verify integrity before writing to disk
		const actual = createHash("sha256").update(buf).digest("hex");
		if (actual !== expectedHash) {
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
		} catch {}
	}
}

async function startDaemon(agentsDir: string = AGENTS_DIR): Promise<boolean> {
	if (await isDaemonRunning()) {
		return true;
	}

	// Download Rust shadow daemon binary if shadow mode is configured
	try {
		const raw = parseSimpleYaml(readFileSync(join(agentsDir, "agent.yaml"), "utf8"));
		const mem = raw?.memory as Record<string, unknown> | undefined;
		const p2 = mem?.pipelineV2 as Record<string, unknown> | undefined;
		if (p2?.nativeShadowEnabled === true) {
			await downloadDaemonBinary();
		}
	} catch {
		// non-fatal — agent.yaml may not exist yet
	}

	const daemonDir = join(agentsDir, ".daemon");
	const logDir = join(daemonDir, "logs");

	mkdirSync(daemonDir, { recursive: true });
	mkdirSync(logDir, { recursive: true });

	// Find daemon script (check multiple locations for dev vs published package)
	const daemonLocations = [
		join(__dirname, "daemon.js"), // published: dist/daemon.js (same dir as cli.js)
		join(__dirname, "..", "..", "daemon", "dist", "daemon.js"), // dev built: packages/daemon/dist/daemon.js
		join(__dirname, "..", "..", "daemon", "src", "daemon.ts"), // dev source fallback: packages/daemon/src/daemon.ts
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

	// Always use bun for better native module support
	const runtime = "bun";

	// Capture stderr to file so we can surface migration/startup errors.
	// Best-effort: if the log file can't be opened, fall back to "ignore"
	// so the daemon still spawns in restricted/read-only environments.
	const startupLogPath = join(logDir, "startup.log");
	let stderrFd: number | null = null;
	let stderrTarget: "ignore" | number = "ignore";
	try {
		stderrFd = openSync(startupLogPath, "w");
		stderrTarget = stderrFd;
	} catch {
		// Non-fatal — startup proceeds without stderr capture
	}

	const proc = spawn(runtime, [daemonPath], {
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

	// Prevent unhandled 'error' crash (e.g. bun not on PATH). Spawn-level
	// errors never reach the child's stderr fd — write them to startup.log
	// so the diagnostic tail below surfaces them alongside normal stderr.
	proc.on("error", (err) => {
		if (startupLogPath) {
			try {
				appendFileSync(startupLogPath, `[spawn error] ${err.message}\n`);
			} catch {
				// Best effort — if we can't write, the readiness poll will still
				// time out and report a clean failure.
			}
		}
	});

	proc.unref();
	if (stderrFd !== null) closeSync(stderrFd);

	// Wait for daemon to be ready
	for (let i = 0; i < 20; i++) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		if (await isDaemonRunning()) {
			return true;
		}
	}

	// Daemon failed to start — show captured stderr if this run captured it.
	// Only read startup.log when we wrote it; stale logs from a previous
	// failed start would otherwise be printed misleadingly.
	try {
		if (stderrFd !== null && existsSync(startupLogPath)) {
			const stderr = readFileSync(startupLogPath, "utf-8").trim();
			if (stderr) {
				const lines = stderr.split("\n");
				const tail = lines.slice(-20);
				console.error(chalk.red("\nDaemon failed to start. stderr output:"));
				for (const line of tail) {
					console.error(chalk.dim(line));
				}
			}
		}
	} catch {
		// Best-effort — don't mask the startup failure
	}

	return false;
}

async function stopDaemon(agentsDir: string = AGENTS_DIR): Promise<boolean> {
	const pidFile = join(agentsDir, ".daemon", "pid");
	const targetPids = new Set<number>();

	if (existsSync(pidFile)) {
		try {
			const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
			if (Number.isInteger(pid) && pid > 0) {
				targetPids.add(pid);
			}
		} catch {
			// Ignore unreadable/stale PID file
		}
	}

	const instances = await getDaemonInstances();
	for (const instance of instances) {
		if (typeof instance.pid === "number" && instance.pid > 0) {
			targetPids.add(instance.pid);
		}
	}

	const isPidAlive = (pid: number): boolean => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};

	const waitForPidExit = async (pid: number): Promise<boolean> => {
		for (let i = 0; i < 20; i++) {
			if (!isPidAlive(pid)) return true;
			await sleep(250);
		}
		return !isPidAlive(pid);
	};

	for (const pid of targetPids) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Process already dead or inaccessible
		}
	}

	for (const pid of targetPids) {
		const exited = await waitForPidExit(pid);
		if (!exited) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead or inaccessible
			}
		}
	}

	for (const pid of targetPids) {
		await waitForPidExit(pid);
	}

	if (existsSync(pidFile)) {
		try {
			rmSync(pidFile, { force: true });
		} catch {
			// Ignore
		}
	}

	return !(await isDaemonRunning());
}

function formatUptime(seconds: number): string {
	if (seconds < 60) return `${Math.floor(seconds)}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
	const hours = Math.floor(seconds / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	return `${hours}h ${mins}m`;
}

// ============================================================================
// Harness Hook Configuration
// ============================================================================

async function configureHarnessHooks(
	harness: string,
	basePath: string,
	options?: {
		configureOpenClawWorkspace?: boolean;
		openclawRuntimePath?: "plugin" | "legacy";
	},
) {
	switch (harness) {
		case "claude-code": {
			const connector = new ClaudeCodeConnector();
			await connector.install(basePath);
			break;
		}
		case "codex": {
			const connector = new CodexConnector();
			await connector.install(basePath);
			break;
		}
		case "opencode": {
			const connector = new OpenCodeConnector();
			await connector.install(basePath);
			break;
		}
		case "openclaw": {
			const connector = new OpenClawConnector();
			const runtimePath = options?.openclawRuntimePath ?? connector.getConfiguredRuntimePath() ?? "plugin";
			// Install connector first — writes config with runtimePath so
			// ensureOpenClawPluginPackage's getConfiguredRuntimePath() check passes.
			await connector.install(basePath, {
				configureWorkspace: options?.configureOpenClawWorkspace ?? false,
				runtimePath,
			});
			if (runtimePath === "plugin") {
				// ensureOpenClawPluginPackage installs the package, creates the symlink,
				// and returns the resolved global path so we can patch load.paths in one
				// targeted call without re-running the full connector install.
				const globalPkgPath = await ensureOpenClawPluginPackage(basePath);
				if (globalPkgPath) {
					// dirname gives the parent search directory (e.g. …/@signetai/)
					// that OpenClaw scans for "signet-memory-openclaw" subdirectory.
					// patchLoadPaths already calls console.warn internally for each
					// skipped config (same pattern as sibling private methods).
					const { patched: lPathPatched, warnings: lPathWarnings } = connector.patchLoadPaths(dirname(globalPkgPath));
					if (lPathPatched.length > 0) {
						console.log(
							chalk.green(
								`  ✓ OpenClaw config updated with plugins.load.paths/plugins.allow (${lPathPatched.length} file(s))`,
							),
						);
					} else if (lPathWarnings.length === 0) {
						// No configs found yet — expected on first run before OpenClaw
						// has been launched and created its config file.
						console.log(
							chalk.dim(
								"  (no OpenClaw configs found to patch with load.paths; run 'signet setup' again after first OpenClaw launch)",
							),
						);
					}
				}
			}
			break;
		}
	}
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OPENCLAW_PLUGIN_PACKAGE = "@signetai/signet-memory-openclaw";
const OPENCLAW_PLUGIN_SYNC_FILENAME = "openclaw-plugin-version";
const PREDICTOR_SYNC_FILENAME = "predictor-version";
const NATIVE_SYNC_LOCK_FILENAME = "sync-native.lock";
const PREDICTOR_DOWNLOAD_TIMEOUT_MS = 60_000;

function getVersionFromPackageJson(packageJsonPath: string): string | null {
	if (!existsSync(packageJsonPath)) {
		return null;
	}

	try {
		const raw = readFileSync(packageJsonPath, "utf8");
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : null;
	} catch {
		return null;
	}
}

function getCliVersion(): string {
	const candidates = [
		join(__dirname, "..", "package.json"),
		join(__dirname, "..", "..", "signetai", "package.json"),
		join(__dirname, "..", "..", "package.json"),
	];

	for (const candidate of candidates) {
		const version = getVersionFromPackageJson(candidate);
		if (version) {
			return version;
		}
	}

	return "0.0.0";
}

const program = new Command();
const VERSION = getCliVersion();

// ============================================================================
// Helpers
// ============================================================================

function signetLogo() {
	return `
  ${chalk.hex("#C9A227")("◈")} ${chalk.bold("signet")} ${chalk.dim(`v${VERSION}`)}
  ${chalk.dim("own your agent. bring it anywhere.")}
`;
}

function detectExistingSetup(basePath: string): SetupDetection {
	// Use the enhanced detection from @signet/core
	return detectExistingSetupCore(basePath);
}

function collectListOption(value: string, previous: string[]): string[] {
	const parts = value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);

	return [...previous, ...parts];
}

function normalizeStringValue(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function extractPathOption(value: unknown): string | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}

	const directPath = normalizeStringValue(Reflect.get(value, "path"));
	if (directPath) {
		return directPath;
	}

	const optsGetter = Reflect.get(value, "opts");
	if (typeof optsGetter === "function") {
		const optsValue = optsGetter();
		if (typeof optsValue === "object" && optsValue !== null) {
			return normalizeStringValue(Reflect.get(optsValue, "path"));
		}
	}

	return null;
}

function normalizeChoice<T extends string>(value: unknown, allowed: readonly T[]): T | null {
	const normalized = normalizeStringValue(value);
	if (!normalized) {
		return null;
	}

	for (const candidate of allowed) {
		if (candidate === normalized) {
			return candidate;
		}
	}

	return null;
}

function parseNumericValue(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : null;
	}

	return null;
}

function parseIntegerValue(value: unknown): number | null {
	const parsed = parseNumericValue(value);
	if (parsed === null) {
		return null;
	}

	return Number.isInteger(parsed) ? parsed : Math.trunc(parsed);
}

function parseSearchBalanceValue(value: unknown): number | null {
	const parsed = parseNumericValue(value);
	if (parsed === null || parsed < 0 || parsed > 1) {
		return null;
	}

	return parsed;
}

function expandUserPath(pathValue: string): string {
	const trimmed = pathValue.trim();
	if (trimmed === "~") {
		return homedir();
	}

	if (trimmed.startsWith("~/")) {
		return join(homedir(), trimmed.slice(2));
	}

	if (trimmed.startsWith("~")) {
		return join(homedir(), trimmed.slice(1));
	}

	return trimmed;
}

function normalizeAgentPath(pathValue: string): string {
	return resolvePath(expandUserPath(pathValue));
}

function getOpenClawPluginSyncPath(basePath: string): string {
	return join(basePath, ".daemon", OPENCLAW_PLUGIN_SYNC_FILENAME);
}

function readOpenClawPluginSyncVersion(basePath: string): string | null {
	const syncPath = getOpenClawPluginSyncPath(basePath);
	if (!existsSync(syncPath)) {
		return null;
	}

	try {
		return readFileSync(syncPath, "utf-8").trim() || null;
	} catch {
		return null;
	}
}

function writeOpenClawPluginSyncVersion(basePath: string, version: string): void {
	const syncPath = getOpenClawPluginSyncPath(basePath);
	mkdirSync(dirname(syncPath), { recursive: true });
	writeFileSync(syncPath, `${version}\n`);
}

function hasOpenClawPluginRuntime(path: string): boolean {
	return existsSync(join(path, "dist", "index.js"));
}

function predictorSyncPath(basePath: string): string {
	return join(basePath, ".daemon", PREDICTOR_SYNC_FILENAME);
}

function readPredictorSyncVersion(basePath: string): string | null {
	const path = predictorSyncPath(basePath);
	if (!existsSync(path)) {
		return null;
	}

	try {
		return readFileSync(path, "utf-8").trim() || null;
	} catch {
		return null;
	}
}

function writePredictorSyncVersion(basePath: string, version: string): void {
	const path = predictorSyncPath(basePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${version}\n`);
}

function predictorBinaryName(): {
	readonly name: string;
	readonly tuple: string;
} | null {
	const host = process.platform;
	const cpu = process.arch;
	const tuple = `${host}:${cpu}`;
	const supported = new Set(["linux:x64", "darwin:x64", "darwin:arm64", "win32:x64", "win32:arm64"]);
	if (!supported.has(tuple)) {
		return null;
	}

	const ext = host === "win32" ? ".exe" : "";
	return {
		name: `signet-predictor-${host}-${cpu}${ext}`,
		tuple,
	};
}

function readSha256(raw: string): string | null {
	const hash = raw.trim().split(/\s+/)[0]?.toLowerCase();
	if (!hash) return null;
	return /^[a-f0-9]{64}$/.test(hash) ? hash : null;
}

async function syncPredictorBinary(basePath: string): Promise<{
	readonly status: "updated" | "current" | "skipped" | "error";
	readonly message: string;
}> {
	const binary = predictorBinaryName();
	if (binary === null) {
		return {
			status: "skipped",
			message: `unsupported platform/arch: ${process.platform}:${process.arch}`,
		};
	}

	const dir = join(basePath, ".daemon", "bin");
	const dest = join(dir, binary.name);
	const stamped = readPredictorSyncVersion(basePath) === VERSION;
	if (stamped && existsSync(dest)) {
		return {
			status: "current",
			message: binary.name,
		};
	}

	const url = `https://github.com/Signet-AI/signetai/releases/download/v${VERSION}/${binary.name}`;
	let expected: string;
	try {
		const hashRes = await fetch(`${url}.sha256`, {
			redirect: "follow",
			signal: AbortSignal.timeout(PREDICTOR_DOWNLOAD_TIMEOUT_MS),
		});
		if (!hashRes.ok) {
			return {
				status: "error",
				message: `checksum lookup failed (HTTP ${hashRes.status})`,
			};
		}
		const hashRaw = await hashRes.text();
		const hash = readSha256(hashRaw);
		if (hash === null) {
			return {
				status: "error",
				message: "checksum file is invalid",
			};
		}
		expected = hash;
	} catch (err) {
		return {
			status: "error",
			message: err instanceof Error ? `checksum lookup failed (${err.message})` : "checksum lookup failed",
		};
	}

	let res: Response;
	try {
		res = await fetch(url, {
			redirect: "follow",
			signal: AbortSignal.timeout(PREDICTOR_DOWNLOAD_TIMEOUT_MS),
		});
	} catch (err) {
		return {
			status: "error",
			message: err instanceof Error ? `network unavailable (${err.message})` : "network unavailable",
		};
	}

	if (res.status === 404) {
		return {
			status: "skipped",
			message: `binary not published for v${VERSION} (${binary.tuple})`,
		};
	}
	if (!res.ok) {
		return {
			status: "error",
			message: `download failed (HTTP ${res.status})`,
		};
	}

	let tmp = "";
	try {
		const body = Buffer.from(await res.arrayBuffer());
		if (body.length === 0) {
			return {
				status: "error",
				message: "download returned empty payload",
			};
		}
		const actual = createHash("sha256").update(body).digest("hex");
		if (actual !== expected) {
			return {
				status: "error",
				message: "binary checksum mismatch",
			};
		}
		mkdirSync(dir, { recursive: true });
		tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, body);
		if (process.platform !== "win32") {
			chmodSync(tmp, 0o755);
		}
		try {
			renameSync(tmp, dest);
		} catch {
			rmSync(dest, { force: true });
			renameSync(tmp, dest);
		}
		writePredictorSyncVersion(basePath, VERSION);
	} catch (err) {
		if (tmp.length > 0) {
			rmSync(tmp, { force: true });
		}
		return {
			status: "error",
			message: err instanceof Error ? `write failed (${err.message})` : "write failed",
		};
	}

	return {
		status: "updated",
		message: binary.name,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function embeddingProvider(basePath: string): "native" | "ollama" | "openai" | "none" {
	const paths = ["agent.yaml", "AGENT.yaml", "config.yaml"].map((name) => join(basePath, name));
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const parsed = parseSimpleYaml(readFileSync(path, "utf-8"));
			if (!isRecord(parsed)) continue;
			const direct = parsed.embedding;
			if (isRecord(direct) && typeof direct.provider === "string") {
				const provider = direct.provider;
				if (provider === "native" || provider === "ollama" || provider === "openai" || provider === "none") {
					return provider;
				}
			}
			const mem = parsed.memory;
			if (isRecord(mem)) {
				const nested = mem.embeddings;
				if (isRecord(nested) && typeof nested.provider === "string") {
					const provider = nested.provider;
					if (provider === "native" || provider === "ollama" || provider === "openai" || provider === "none") {
						return provider;
					}
				}
			}
			const legacy = parsed.embeddings;
			if (isRecord(legacy) && typeof legacy.provider === "string") {
				const provider = legacy.provider;
				if (provider === "native" || provider === "ollama" || provider === "openai" || provider === "none") {
					return provider;
				}
			}
		} catch {
			// Ignore malformed config files and keep scanning fallbacks.
		}
	}
	return "native";
}

function hasNativeModelCache(basePath: string): boolean {
	const dir = join(basePath, ".models");
	if (!existsSync(dir)) {
		return false;
	}
	try {
		return readdirSync(dir).length > 0;
	} catch {
		return false;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function nativeSyncLockPath(basePath: string): string {
	return join(basePath, ".daemon", NATIVE_SYNC_LOCK_FILENAME);
}

function clearStaleNativeSyncLock(path: string): boolean {
	try {
		const raw = readFileSync(path, "utf-8");
		const pid = Number.parseInt(raw.trim().split(/\s+/)[0] ?? "", 10);
		if (Number.isInteger(pid) && pid > 0 && !isAlive(pid)) {
			rmSync(path, { force: true });
			return true;
		}
	} catch {
		// Best-effort stale-lock detection.
	}

	try {
		const age = Date.now() - statSync(path).mtimeMs;
		if (age > 5 * 60_000) {
			rmSync(path, { force: true });
			return true;
		}
	} catch {
		// Lock disappeared between checks.
	}

	return false;
}

async function acquireNativeSyncLock(basePath: string): Promise<{
	readonly fd: number;
	readonly path: string;
} | null> {
	const path = nativeSyncLockPath(basePath);
	mkdirSync(dirname(path), { recursive: true });
	const end = Date.now() + 15_000;

	while (Date.now() < end) {
		try {
			const fd = openSync(path, "wx");
			writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
			return { fd, path };
		} catch (err) {
			const code = err instanceof Error && "code" in err ? String(err.code) : "";
			if (code !== "EEXIST") {
				return null;
			}
		}

		if (clearStaleNativeSyncLock(path)) {
			continue;
		}

		await sleep(200);
	}

	return null;
}

function releaseNativeSyncLock(lock: { readonly fd: number; readonly path: string }): void {
	try {
		closeSync(lock.fd);
	} catch {
		// Ignore.
	}
	rmSync(lock.path, { force: true });
}

async function syncNativeEmbeddingModel(basePath: string): Promise<{
	readonly status: "updated" | "current" | "skipped" | "error";
	readonly message: string;
}> {
	const provider = embeddingProvider(basePath);
	if (provider !== "native") {
		return {
			status: "skipped",
			message: `embedding provider is '${provider}'`,
		};
	}

	const lock = await acquireNativeSyncLock(basePath);
	if (lock === null) {
		return {
			status: "error",
			message: "another sync is currently warming native embeddings",
		};
	}

	const hadCache = hasNativeModelCache(basePath);
	let started = false;
	let blocked = false;
	let result: {
		readonly status: "updated" | "current" | "skipped" | "error";
		readonly message: string;
	} = {
		status: "error",
		message: "daemon unreachable",
	};

	try {
		const running = await isDaemonRunning();
		if (!running) {
			const ok = await startDaemon(basePath);
			if (!ok) {
				result = {
					status: "error",
					message: "daemon is required to warm native embeddings (failed to start)",
				};
				blocked = true;
			} else {
				started = true;
			}
		}

		if (!blocked) {
			const urls = await getReachableDaemonUrls();
			const url = urls[0];
			if (!url) {
				result = {
					status: "error",
					message: "daemon reachable URL not found",
				};
			} else {
				const res = await fetch(`${url}/api/embeddings/status`, {
					method: "GET",
					signal: AbortSignal.timeout(10 * 60_000),
				});
				if (!res.ok) {
					result = {
						status: "error",
						message: `warmup request failed (HTTP ${res.status})`,
					};
				} else {
					const body: unknown = await res.json();
					if (!isRecord(body)) {
						result = {
							status: "error",
							message: "warmup response had invalid shape",
						};
					} else {
						const active = typeof body.provider === "string" ? body.provider : "unknown";
						const available = body.available === true;
						const err = typeof body.error === "string" ? body.error : null;
						const reported = body.modelCached === true;
						if (active !== "native") {
							result = {
								status: "skipped",
								message: `daemon embedding provider is '${active}'`,
							};
						} else if (!available) {
							result = {
								status: "error",
								message: err ?? "native provider unavailable",
							};
						} else if (err?.toLowerCase().includes("fallback")) {
							result = {
								status: "error",
								message: err,
							};
						} else {
							const hasCache = hasNativeModelCache(basePath);
							const ready = reported || hasCache;
							if (!ready) {
								result = {
									status: "error",
									message: "native provider responded but model cache was not detected",
								};
							} else {
								result = {
									status: !hadCache && hasCache ? "updated" : "current",
									message: hasCache
										? "nomic-ai/nomic-embed-text-v1.5"
										: "nomic-ai/nomic-embed-text-v1.5 (runtime cache)",
								};
							}
						}
					}
				}
			}
		}
	} catch (err) {
		result = {
			status: "error",
			message: err instanceof Error ? `warmup failed (${err.message})` : "warmup failed",
		};
	} finally {
		if (started) {
			const stopped = await stopDaemon(basePath);
			if (!stopped && result.status !== "error") {
				result = {
					status: "error",
					message: "native model warmed but daemon could not be stopped cleanly",
				};
			}
		}
		releaseNativeSyncLock(lock);
	}

	return result;
}

async function ensureOpenClawPluginPackage(
	basePath: string,
	options: { force?: boolean; silent?: boolean } = {},
): Promise<string | undefined> {
	const connector = new OpenClawConnector();
	if (connector.getConfiguredRuntimePath() !== "plugin") {
		return undefined;
	}

	const packageManager = resolvePrimaryPackageManager({
		agentsDir: basePath,
		env: process.env,
	});

	if (!options.force && readOpenClawPluginSyncVersion(basePath) === VERSION) {
		// Cached — skip re-install but still resolve and return path for caller.
		// If the path can't be resolved (package was pruned after the stamp was
		// written), fall through to re-install rather than returning undefined.
		const cachedPath = resolveGlobalPackagePath(packageManager.family, OPENCLAW_PLUGIN_PACKAGE);
		if (cachedPath) {
			if (!hasOpenClawPluginRuntime(cachedPath)) {
				if (!options.silent) {
					console.log(
						chalk.yellow(
							`  Warning: cached ${OPENCLAW_PLUGIN_PACKAGE}@${VERSION} is missing dist/index.js; retrying install.`,
						),
					);
				}
			} else {
				ensureOpenClawExtensionSymlink(cachedPath, options.silent);
				return cachedPath;
			}
		}
		if (!cachedPath && !options.silent) {
			console.log(chalk.yellow(`  Warning: cached ${OPENCLAW_PLUGIN_PACKAGE} not found on disk; retrying install.`));
		}
		// Fall through to re-install below.
	}

	const installCommand = getGlobalInstallCommand(packageManager.family, `${OPENCLAW_PLUGIN_PACKAGE}@${VERSION}`);

	const result = spawnSync(installCommand.command, installCommand.args, {
		stdio: options.silent ? "pipe" : "inherit",
		timeout: 120_000,
		cwd: tmpdir(),
		env: process.env,
		windowsHide: true,
	});

	if (result.status !== 0) {
		if (!options.silent) {
			console.log(chalk.yellow(`  Warning: failed to refresh ${OPENCLAW_PLUGIN_PACKAGE}@${VERSION}`));
		}
		return undefined;
	}

	// Resolve once and reuse for both symlink creation and load.paths patch.
	const globalPath = resolveGlobalPackagePath(packageManager.family, OPENCLAW_PLUGIN_PACKAGE);
	if (!globalPath) {
		if (!options.silent) {
			console.log(
				chalk.yellow(
					`  Warning: could not resolve global path for ${OPENCLAW_PLUGIN_PACKAGE} after install; plugin discovery may be incomplete. Run 'signet setup' again if needed.`,
				),
			);
		}
		return undefined;
	}
	if (!hasOpenClawPluginRuntime(globalPath)) {
		if (!options.silent) {
			console.log(
				chalk.yellow(
					`  Warning: installed ${OPENCLAW_PLUGIN_PACKAGE}@${VERSION} is missing dist/index.js; this usually means the published package was not built before publish.`,
				),
			);
		}
		return undefined;
	}

	writeOpenClawPluginSyncVersion(basePath, VERSION);
	if (!options.silent) {
		console.log(chalk.green(`  ✓ OpenClaw plugin refreshed (${OPENCLAW_PLUGIN_PACKAGE}@${VERSION})`));
	}

	ensureOpenClawExtensionSymlink(globalPath, options.silent);
	return globalPath;
}

/**
 * Create a symlink from OpenClaw's extensions directory to the globally
 * installed plugin package. Idempotent — skips if already correct,
 * updates if stale, creates if missing.
 */
function ensureOpenClawExtensionSymlink(globalPath: string, silent?: boolean): void {
	// Discover the active OpenClaw state directory. Check env overrides first
	// (expanding ~ just like the connector does), then probe for existing legacy
	// dirs (~/.clawdbot, ~/.moldbot, ~/.moltbot).
	const stateDirCandidates: string[] = [];
	// normalizeAgentPath expands ~ and resolves to an absolute path.
	if (process.env.OPENCLAW_STATE_DIR) {
		stateDirCandidates.push(normalizeAgentPath(process.env.OPENCLAW_STATE_DIR));
	}
	if (process.env.CLAWDBOT_STATE_DIR) {
		stateDirCandidates.push(normalizeAgentPath(process.env.CLAWDBOT_STATE_DIR));
	}
	// OPENCLAW_STATE_HOME is the root of the state directory (openclaw.json lives
	// directly inside it), so extensions/ belongs there too.
	if (process.env.OPENCLAW_STATE_HOME) {
		stateDirCandidates.push(normalizeAgentPath(process.env.OPENCLAW_STATE_HOME));
	}
	const home = homedir();
	for (const name of [".openclaw", ".clawdbot", ".moldbot", ".moltbot"]) {
		const candidate = join(home, name);
		if (existsSync(candidate)) {
			stateDirCandidates.push(candidate);
		}
	}
	// Default to ~/.openclaw if nothing else exists
	if (stateDirCandidates.length === 0) {
		stateDirCandidates.push(join(home, ".openclaw"));
	}

	// Create symlink in every discovered state dir
	for (const stateDir of [...new Set(stateDirCandidates)]) {
		createExtensionSymlink(stateDir, globalPath, silent);
	}
}

function createExtensionSymlink(stateDir: string, globalPath: string, silent?: boolean): void {
	const extensionsDir = join(stateDir, "extensions");
	const symlinkPath = join(extensionsDir, "signet-memory-openclaw");

	try {
		mkdirSync(extensionsDir, { recursive: true });
	} catch (err) {
		if (!silent) {
			console.log(chalk.yellow(`  Warning: could not prepare OpenClaw extensions dir at ${extensionsDir}: ${err}`));
		}
		return;
	}

	// Check existing symlink — lstatSync doesn't follow symlinks, so it
	// catches both valid and broken symlinks. existsSync follows symlinks
	// and misses broken ones.
	try {
		const stat = lstatSync(symlinkPath);
		if (stat.isSymbolicLink()) {
			const currentTarget = readlinkSync(symlinkPath);
			if (currentTarget === globalPath) {
				return; // Already correct
			}
			// Stale symlink — remove and recreate
			try {
				rmSync(symlinkPath, { force: true });
			} catch (rmErr) {
				if (!silent) {
					console.log(chalk.yellow(`  Warning: could not remove stale symlink at ${symlinkPath}: ${rmErr}`));
				}
				return;
			}
		} else {
			// Exists but is not a symlink (real file or directory). Removing it
			// before symlinkSync could permanently destroy a working manual
			// installation if symlink creation then fails. Leave it in place and
			// warn — the user can remove it manually to enable the managed symlink.
			if (!silent) {
				console.log(
					chalk.yellow(
						`  Warning: existing non-symlink at ${symlinkPath}; leaving it in place. Remove it manually to enable the Signet-managed symlink.`,
					),
				);
			}
			return;
		}
	} catch {
		// Path doesn't exist — will create below
	}

	try {
		symlinkSync(globalPath, symlinkPath, process.platform === "win32" ? "junction" : "dir");
		if (!silent) {
			console.log(chalk.green("  ✓ OpenClaw extension symlink created"));
		}
	} catch (err) {
		if (!silent) {
			console.log(chalk.yellow(`  Warning: could not create extension symlink: ${err}`));
		}
	}
}

// ============================================================================
// CLI Definition
// ============================================================================

program.name("signet").description("Own your agent. Bring it anywhere.").version(VERSION);
program.showHelpAfterError();
program.addHelpText(
	"after",
	`
Examples:
  signet setup
    Create or migrate a Signet workspace.
  signet status
    Show install, daemon, and memory status.
  signet doctor
    Run local health checks and suggest fixes.
  signet daemon start
    Start the daemon explicitly.
  signet remember "Nicholai prefers command-first CLIs"
    Save a memory from the terminal.
  signet recall "cli preferences" --json
    Search memories with machine-readable output.
`,
);

program.hook("preAction", async (_thisCommand, actionCommand) => {
	let current: Command | null = actionCommand;
	let topLevelCommand = "";

	while (current && current.parent) {
		if (current.parent.name() === "signet") {
			topLevelCommand = current.name();
			break;
		}
		current = current.parent;
	}

	if (actionCommand.name() === "signet" || topLevelCommand === "") {
		return;
	}

	if (topLevelCommand === "hook" || topLevelCommand === "setup") {
		return;
	}

	if (!existsSync(AGENTS_DIR)) {
		return;
	}

	await ensureOpenClawPluginPackage(AGENTS_DIR, { silent: true });
});

const healthDeps = {
	agentsDir: AGENTS_DIR,
	defaultPort: DEFAULT_PORT,
	detectExistingSetup,
	extractPathOption,
	formatUptime,
	getDaemonStatus,
	normalizeAgentPath,
	parseIntegerValue,
	signetLogo,
};

const daemonDeps = {
	agentsDir: AGENTS_DIR,
	defaultPort: DEFAULT_PORT,
	extractPathOption,
	getDaemonStatus,
	isDaemonRunning,
	normalizeAgentPath,
	signetLogo,
	sleep,
	startDaemon,
	stopDaemon,
};

registerAppCommands(program, {
	collectListOption,
	configureAgent: () =>
		configureAgent({
			agentsDir: AGENTS_DIR,
			configureHarnessHooks,
			signetLogo,
		}),
	launchDashboard: (options) => launchDashboard(options, daemonDeps),
	migrateSchema: (options) => migrateSchema(options, daemonDeps),
	setupWizard: (options) =>
		setupWizard(options, {
			AGENTS_DIR,
			DEFAULT_PORT,
			configureHarnessHooks,
			copyDirRecursive,
			detectExistingSetup,
			getTemplatesDir,
			gitAddAndCommit,
			gitInit,
			importFromGitHub: (basePath) =>
				importFromGitHub(basePath, {
					copyDirRecursive,
					gitAddAndCommit,
					isGitRepo,
				}),
			isDaemonRunning,
			isGitRepo,
			launchDashboard: (options) => launchDashboard(options, daemonDeps),
			normalizeAgentPath,
			normalizeChoice,
			normalizeStringValue,
			parseIntegerValue,
			parseSearchBalanceValue,
			showStatus: (statusOptions) => showStatus(statusOptions, healthDeps),
			signetLogo,
			startDaemon,
			syncBuiltinSkills,
		}),
	showDoctor: (options) => showDoctor(options, healthDeps),
	showStatus: (options) => showStatus(options, healthDeps),
	syncTemplates: () =>
		syncTemplates({
			agentsDir: AGENTS_DIR,
			configureHarnessHooks,
			getTemplatesDir,
			signetLogo,
			syncBuiltinSkills,
			syncNativeEmbeddingModel,
			syncPredictorBinary,
		}),
});

registerDaemonCommands(program, {
	doRestart: (options) => doRestart(options, daemonDeps),
	doStart: (options) => doStart(options, daemonDeps),
	doStop: (options) => doStop(options, daemonDeps),
	showLogs: (options) => showLogs(options, daemonDeps),
	showStatus: (options) => showStatus(options, healthDeps),
});

// ============================================================================
// signet secret - Secrets management
// ============================================================================

async function ensureDaemonForSecrets(): Promise<boolean> {
	return ensureDaemonRunning(isDaemonRunning);
}

const { fetchFromDaemon, secretApiCall } = createDaemonClient(DEFAULT_PORT);
const SKILLS_DIR = join(AGENTS_DIR, "skills");

registerSecretCommands(program, {
	ensureDaemonForSecrets,
	secretApiCall,
});

registerSkillCommands(program, {
	AGENTS_DIR,
	SKILLS_DIR,
	fetchFromDaemon,
	isDaemonRunning,
});

registerMemoryCommands(program, {
	ensureDaemonForSecrets,
	secretApiCall,
});

registerPortableCommands(program);

// ============================================================================
// signet hook - Lifecycle hooks for harness integration
// ============================================================================

registerHookCommands(program, {
	AGENTS_DIR,
	fetchFromDaemon,
	readStaticIdentity,
});

const MIN_AUTO_UPDATE_INTERVAL = 300;
const MAX_AUTO_UPDATE_INTERVAL = 604800;
registerUpdateCommands(program, {
	AGENTS_DIR,
	MAX_AUTO_UPDATE_INTERVAL,
	MIN_AUTO_UPDATE_INTERVAL,
	configureHarnessHooks,
	fetchFromDaemon,
	getTemplatesDir,
	isOpenClawInstalled: () => new OpenClawConnector().isInstalled(),
	syncBuiltinSkills,
});

registerGitCommands(program, {
	fetchFromDaemon,
});

registerVectorCommands(program, {
	AGENTS_DIR,
	signetLogo,
});

// ============================================================================
// signet bypass - Per-session bypass toggle
// ============================================================================

registerSessionCommands(program, {
	fetchFromDaemon,
});

// ============================================================================
// Default action when no command specified
// ============================================================================

// ============================================================================
// signet browse — CDP browser bridge (Phase 1a)
// ============================================================================

registerBrowseCommand(program);

// Default action when no command specified
program.action(async () => {
	program.outputHelp();
	const report = await getStatusReport(AGENTS_DIR, healthDeps);
	console.log();
	if (!report.installed) {
		console.log(chalk.dim("Run `signet setup` to initialize a workspace."));
	} else if (report.daemon.running) {
		console.log(chalk.dim(`Daemon running at http://localhost:${DEFAULT_PORT} • ${report.basePath}`));
	} else {
		console.log(chalk.dim("Workspace found. Run `signet daemon start` or `signet doctor`."));
	}
});

program.parse();
