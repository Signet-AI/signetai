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
import { checkbox, confirm, input, password, select } from "@inquirer/prompts";
import { ClaudeCodeConnector } from "@signet/connector-claude-code";
import { CodexConnector } from "@signet/connector-codex";
import { OpenClawConnector } from "@signet/connector-openclaw";
import { OpenCodeConnector } from "@signet/connector-opencode";
import {
	IDENTITY_FILES,
	type ImportResult,
	type MigrationResult,
	type SchemaInfo,
	SIGNET_GIT_PROTECTED_PATHS,
	type SetupDetection,
	type SkillsResult,
	detectExistingSetup as detectExistingSetupCore,
	detectSchema,
	ensureUnifiedSchema,
	formatYaml,
	getGlobalInstallCommand,
	resolveGlobalPackagePath,
	getMissingIdentityFiles,
	getSkillsRunnerCommand,
	hasValidIdentity,
	importMemoryLogs,
	loadSqliteVec,
	mergeSignetGitignoreEntries,
	parseSimpleYaml,
	resolvePrimaryPackageManager,
	runMigrations,
	symlinkSkills,
	readStaticIdentity,
	unifySkills,
} from "@signet/core";
import chalk from "chalk";
import { Command } from "commander";
import open from "open";
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
// Git Helpers
// ============================================================================

function isGitRepo(dir: string): boolean {
	return existsSync(join(dir, ".git"));
}

async function gitInit(dir: string): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn("git", ["init"], { cwd: dir, stdio: "pipe", windowsHide: true });
		proc.on("close", (code) => resolve(code === 0));
		proc.on("error", () => resolve(false));
	});
}

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

async function gitAddAndCommit(dir: string, message: string): Promise<boolean> {
	ensureProtectedGitignore(dir);
	await gitUntrackProtectedFiles(dir);
	return new Promise((resolve) => {
		// First, git add -A
		const add = spawn("git", ["add", "-A"], { cwd: dir, stdio: "pipe", windowsHide: true });
		add.on("close", (addCode) => {
			if (addCode !== 0) {
				resolve(false);
				return;
			}
			// Check if there are changes to commit
			const status = spawn("git", ["status", "--porcelain"], {
				cwd: dir,
				stdio: "pipe",
				windowsHide: true,
			});
			let statusOutput = "";
			status.stdout?.on("data", (d) => {
				statusOutput += d.toString();
			});
			status.on("close", (statusCode) => {
				if (statusCode !== 0 || !statusOutput.trim()) {
					// No changes to commit
					resolve(true);
					return;
				}
				// Commit
				const commit = spawn("git", ["commit", "-m", message], {
					cwd: dir,
					stdio: "pipe",
					windowsHide: true,
				});
				commit.on("close", (commitCode) => resolve(commitCode === 0));
				commit.on("error", () => resolve(false));
			});
			status.on("error", () => resolve(false));
		});
		add.on("error", () => resolve(false));
	});
}

async function gitAutoCommit(dir: string, changedFile: string): Promise<boolean> {
	const now = new Date();
	const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const filename = changedFile.split("/").pop() || "file";
	const message = `${timestamp}_auto_${filename}`;
	return gitAddAndCommit(dir, message);
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

/**
 * Check if the detected setup has significant existing identity files
 * that should trigger the migration flow
 */
function hasExistingIdentityFiles(detection: SetupDetection): boolean {
	// Check for core identity files (non-optional ones)
	const coreFiles = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];
	const foundCore = detection.identityFiles.filter((f) => coreFiles.includes(f));
	return foundCore.length >= 2;
}

/**
 * Format detection summary for display
 */
function formatDetectionSummary(detection: SetupDetection): string {
	const lines: string[] = [];

	if (detection.identityFiles.length > 0) {
		lines.push(`  ${chalk.cyan("Identity files:")}`);
		for (const file of detection.identityFiles) {
			lines.push(`    ${chalk.dim("•")} ${file}`);
		}
	}

	if (detection.memoryLogCount > 0) {
		lines.push(`  ${chalk.cyan("Memory logs:")}`);
		lines.push(`    ${chalk.dim("•")} ${detection.memoryLogCount} files in memory/`);
	}

	if (detection.hasClawdhub) {
		lines.push(`  ${chalk.cyan("OpenClaw registry:")}`);
		lines.push(`    ${chalk.dim("•")} .clawdhub/lock.json found`);
	}

	const installedHarnesses: string[] = [];
	if (detection.harnesses.claudeCode) installedHarnesses.push("Claude Code");
	if (detection.harnesses.openclaw) installedHarnesses.push("OpenClaw");
	if (detection.harnesses.opencode) installedHarnesses.push("OpenCode");
	if (detection.harnesses.codex) installedHarnesses.push("Codex");

	if (installedHarnesses.length > 0) {
		lines.push(`  ${chalk.cyan("Installed harnesses:")}`);
		lines.push(`    ${chalk.dim("•")} ${installedHarnesses.join(", ")}`);
	}

	return lines.join("\n");
}

type HarnessChoice = "claude-code" | "opencode" | "openclaw" | "codex";
type EmbeddingProviderChoice = "native" | "ollama" | "openai" | "none";
type ExtractionProviderChoice = "claude-code" | "ollama" | "opencode" | "codex" | "openrouter" | "none";
type OpenClawRuntimeChoice = "plugin" | "legacy";

interface SetupWizardOptions {
	path?: string;
	nonInteractive?: boolean;
	name?: string;
	description?: string;
	harness?: string[];
	embeddingProvider?: string;
	embeddingModel?: string;
	extractionProvider?: string;
	extractionModel?: string;
	searchBalance?: string;
	skipGit?: boolean;
	openDashboard?: boolean;
	openclawRuntimePath?: string;
	configureOpenclawWorkspace?: boolean;
}

const SETUP_HARNESS_CHOICES: readonly HarnessChoice[] = ["claude-code", "opencode", "openclaw", "codex"];
const EMBEDDING_PROVIDER_CHOICES: readonly EmbeddingProviderChoice[] = ["native", "ollama", "openai", "none"];
const EXTRACTION_PROVIDER_CHOICES: readonly ExtractionProviderChoice[] = [
	"claude-code",
	"ollama",
	"opencode",
	"codex",
	"openrouter",
	"none",
];
const OPENCLAW_RUNTIME_CHOICES: readonly OpenClawRuntimeChoice[] = ["plugin", "legacy"];

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

function hasExistingAgentState(detection: SetupDetection): boolean {
	return detection.memoryDb || detection.agentYaml || detection.identityFiles.length > 0;
}

function scoreOpenClawWorkspace(pathValue: string): number {
	const detection = detectExistingSetup(pathValue);
	let score = 0;

	if (detection.memoryDb) score += 100;
	if (detection.agentYaml) score += 60;
	if (detection.identityFiles.length >= 2) score += 40;
	if (detection.agentsDir) score += 10;

	return score;
}

function detectPreferredOpenClawWorkspace(defaultPath: string): string | null {
	const connector = new OpenClawConnector();
	const normalizedDefault = normalizeAgentPath(defaultPath);
	const discovered = connector
		.getDiscoveredWorkspacePaths()
		.map((workspacePath) => normalizeAgentPath(workspacePath))
		.filter((workspacePath) => workspacePath !== normalizedDefault);

	if (discovered.length === 0) {
		return null;
	}

	const unique = [...new Set(discovered)];
	const ranked = unique
		.map((workspacePath) => ({
			workspacePath,
			score: scoreOpenClawWorkspace(workspacePath),
		}))
		.sort((a, b) => b.score - a.score);

	if (ranked[0].score > 0) {
		return ranked[0].workspacePath;
	}

	return ranked.length === 1 ? ranked[0].workspacePath : null;
}

function normalizeHarnessList(rawValues: readonly string[] | undefined): HarnessChoice[] {
	if (!rawValues || rawValues.length === 0) {
		return [];
	}

	const harnesses: HarnessChoice[] = [];
	for (const rawValue of rawValues) {
		const parts = rawValue
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);

		for (const part of parts) {
			const harness = normalizeChoice(part, SETUP_HARNESS_CHOICES);
			if (harness && !harnesses.includes(harness)) {
				harnesses.push(harness);
			}
		}
	}

	return harnesses;
}

function failNonInteractiveSetup(message: string): never {
	console.error(chalk.red(`  ${message}`));
	console.error(chalk.dim("  Ask the user for explicit provider choices and pass them as CLI flags."));
	process.exit(1);
}

function getEmbeddingDimensions(model: string): number {
	switch (model) {
		case "all-minilm":
			return 384;
		case "mxbai-embed-large":
			return 1024;
		case "text-embedding-3-large":
			return 3072;
		case "text-embedding-3-small":
			return 1536;
		default:
			return 768;
	}
}

async function promptOpenAIEmbeddingModel() {
	console.log();
	const model = await select({
		message: "Which embedding model?",
		choices: [
			{
				value: "text-embedding-3-small",
				name: "text-embedding-3-small (1536d, cheaper)",
			},
			{
				value: "text-embedding-3-large",
				name: "text-embedding-3-large (3072d, better)",
			},
		],
	});

	return {
		provider: "openai" as const,
		model,
		dimensions: getEmbeddingDimensions(model),
	};
}

async function runCommandWithOutput(
	command: string,
	args: string[],
	options?: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		timeout?: number;
	},
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd: options?.cwd,
			env: options?.env,
			timeout: options?.timeout,
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
			resolve({ code: code ?? 1, stdout, stderr });
		});
		proc.on("error", (error) => {
			resolve({ code: 1, stdout, stderr: error.message });
		});
	});
}

function hasCommand(command: string): boolean {
	try {
		const result = spawnSync(command, ["--version"], { stdio: "ignore", windowsHide: true });
		return result.status === 0;
	} catch {
		return false;
	}
}

function printOllamaInstallInstructions() {
	console.log(chalk.dim("  Install Ollama:"));

	if (platform() === "darwin") {
		console.log(chalk.dim("    brew install ollama"));
		console.log(chalk.dim("    open -a Ollama"));
		return;
	}

	if (platform() === "linux") {
		console.log(chalk.dim("    curl -fsSL https://ollama.com/install.sh | sh"));
		console.log(chalk.dim("    ollama serve"));
		return;
	}

	console.log(chalk.dim("    https://ollama.com/download"));
}

async function offerOllamaInstallFlow(): Promise<boolean> {
	const installNow = await confirm({
		message: "Ollama is not installed. Try to install it now?",
		default: true,
	});

	if (!installNow) {
		printOllamaInstallInstructions();
		return false;
	}

	if (platform() === "darwin") {
		if (!hasCommand("brew")) {
			console.log(chalk.yellow("  Homebrew not found, cannot auto-install."));
			printOllamaInstallInstructions();
			return false;
		}

		const spinner = ora("Installing Ollama with Homebrew...").start();
		const result = await runCommandWithOutput("brew", ["install", "ollama"], {
			env: { ...process.env },
			timeout: 300000,
		});

		if (result.code !== 0) {
			spinner.fail("Ollama install failed");
			if (result.stderr.trim()) {
				console.log(chalk.dim(`  ${result.stderr.trim()}`));
			}
			printOllamaInstallInstructions();
			return false;
		}

		spinner.succeed("Ollama installed");
		return hasCommand("ollama");
	}

	if (platform() === "linux") {
		const spinner = ora("Installing Ollama...").start();
		const result = await runCommandWithOutput("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], {
			env: { ...process.env },
			timeout: 300000,
		});

		if (result.code !== 0) {
			spinner.fail("Ollama install failed");
			if (result.stderr.trim()) {
				console.log(chalk.dim(`  ${result.stderr.trim()}`));
			}
			printOllamaInstallInstructions();
			return false;
		}

		spinner.succeed("Ollama installed");
		return hasCommand("ollama");
	}

	console.log(chalk.yellow("  Automated install is not available on this platform."));
	printOllamaInstallInstructions();
	return false;
}

async function queryOllamaModels(baseUrl = "http://localhost:11434"): Promise<{
	available: boolean;
	models: string[];
	error?: string;
}> {
	try {
		const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
			signal: AbortSignal.timeout(5000),
		});

		if (!response.ok) {
			return {
				available: false,
				models: [],
				error: `Ollama returned ${response.status}`,
			};
		}

		const data = (await response.json()) as {
			models?: Array<{ name?: string }>;
		};

		const models = (data.models ?? []).map((m) => m.name?.trim()).filter((m): m is string => Boolean(m));

		return { available: true, models };
	} catch (error) {
		return {
			available: false,
			models: [],
			error: (error as Error).message,
		};
	}
}

function hasOllamaModel(models: string[], model: string): boolean {
	return models.some((entry) => entry === model || entry.startsWith(`${model}:`));
}

async function pullOllamaModel(model: string): Promise<boolean> {
	const spinner = ora(`Pulling ${model}...`).start();
	const result = await runCommandWithOutput("ollama", ["pull", model], {
		env: { ...process.env },
		timeout: 600000,
	});

	if (result.code !== 0) {
		spinner.fail(`Failed to pull ${model}`);
		if (result.stderr.trim()) {
			console.log(chalk.dim(`  ${result.stderr.trim()}`));
		}
		return false;
	}

	spinner.succeed(`Model ${model} is ready`);
	return true;
}

async function promptOllamaFailureFallback(): Promise<"retry" | "native" | "openai" | "none"> {
	console.log();
	return select({
		message: "How do you want to continue?",
		choices: [
			{ value: "native", name: "Use built-in embeddings (recommended)" },
			{ value: "retry", name: "Retry Ollama checks" },
			{ value: "openai", name: "Switch to OpenAI" },
			{ value: "none", name: "Continue without embeddings" },
		],
	});
}

async function preflightOllamaEmbedding(model: string): Promise<{
	provider: "native" | "ollama" | "openai" | "none";
	model?: string;
	dimensions?: number;
}> {
	while (true) {
		if (!hasCommand("ollama")) {
			console.log(chalk.yellow("  Ollama is not installed."));
			const installed = await offerOllamaInstallFlow();
			if (!installed) {
				const fallback = await promptOllamaFailureFallback();
				if (fallback === "retry") continue;
				if (fallback === "native") {
					return { provider: "native", model: "nomic-embed-text-v1.5", dimensions: 768 };
				}
				if (fallback === "openai") {
					return promptOpenAIEmbeddingModel();
				}
				return { provider: "none" };
			}
		}

		const service = await queryOllamaModels();
		if (!service.available) {
			console.log(chalk.yellow("  Ollama is installed but not reachable."));
			if (service.error) console.log(chalk.dim(`  ${service.error}`));
			console.log(chalk.dim("  Start Ollama with: ollama serve"));

			const fallback = await promptOllamaFailureFallback();
			if (fallback === "retry") continue;
			if (fallback === "native") {
				return { provider: "native", model: "nomic-embed-text-v1.5", dimensions: 768 };
			}
			if (fallback === "openai") {
				return promptOpenAIEmbeddingModel();
			}
			return { provider: "none" };
		}

		if (!hasOllamaModel(service.models, model)) {
			console.log(chalk.yellow(`  Model '${model}' is not installed.`));
			const pullNow = await confirm({
				message: `Pull '${model}' now with ollama pull ${model}?`,
				default: true,
			});

			if (pullNow) {
				const pulled = await pullOllamaModel(model);
				if (pulled) {
					continue;
				}
			}

			const fallback = await promptOllamaFailureFallback();
			if (fallback === "retry") continue;
			if (fallback === "native") {
				return { provider: "native", model: "nomic-embed-text-v1.5", dimensions: 768 };
			}
			if (fallback === "openai") {
				return promptOpenAIEmbeddingModel();
			}
			return { provider: "none" };
		}

		return {
			provider: "ollama",
			model,
			dimensions: getEmbeddingDimensions(model),
		};
	}
}

// ============================================================================
// Interactive TUI Menu
// ============================================================================

async function interactiveMenu() {
	console.log(signetLogo());

	const status = await getDaemonStatus();

	if (!status.running) {
		console.log(chalk.yellow("  Daemon is not running.\n"));

		const startNow = await confirm({
			message: "Start the daemon?",
			default: true,
		});

		if (startNow) {
			const spinner = ora("Starting daemon...").start();
			const started = await startDaemon();
			if (started) {
				spinner.succeed("Daemon started");
				console.log(chalk.dim(`  Dashboard: http://localhost:${DEFAULT_PORT}`));
			} else {
				spinner.fail("Failed to start daemon");
				return;
			}
		} else {
			return;
		}
	} else {
		console.log(chalk.green(`  ● Daemon running`));
		console.log(chalk.dim(`    PID: ${status.pid} | Uptime: ${formatUptime(status.uptime || 0)}`));
		console.log();
	}

	while (true) {
		// Clear and re-show header for clean menu
		console.clear();
		console.log(signetLogo());
		console.log(chalk.green(`  ● Daemon running`));
		console.log(chalk.dim(`    http://localhost:${DEFAULT_PORT}`));
		console.log();

		let action: string;
		try {
			action = await select({
				message: "What would you like to do?",
				choices: [
					{ value: "dashboard", name: "[web] Open dashboard" },
					{ value: "status", name: "[info] View status" },
					{ value: "config", name: "[config] Configure settings" },
					{ value: "secrets", name: "[key] Manage secrets" },
					{ value: "harnesses", name: "[link] Manage harnesses" },
					{ value: "logs", name: "[logs] View logs" },
					{ value: "restart", name: "[restart] Restart daemon" },
					{ value: "stop", name: "[stop] Stop daemon" },
					{ value: "exit", name: "[exit] Exit" },
				],
			});
		} catch {
			// Handle Ctrl+C gracefully
			console.log();
			return;
		}

		console.log();

		switch (action) {
			case "dashboard":
				console.log();
				console.log(chalk.dim("  Opening dashboard in browser..."));
				console.log(chalk.dim(`  http://localhost:${DEFAULT_PORT}`));
				await open(`http://localhost:${DEFAULT_PORT}`);
				await new Promise((r) => setTimeout(r, 1500));
				break;

			case "status":
				await showStatus({ path: AGENTS_DIR });
				await input({ message: "Press Enter to continue..." });
				break;

			case "config":
				console.log();
				console.log(chalk.dim("  Opening config in browser..."));
				console.log(chalk.dim(`  http://localhost:${DEFAULT_PORT}#config`));
				await open(`http://localhost:${DEFAULT_PORT}#config`);
				await new Promise((r) => setTimeout(r, 1500)); // let user see message
				break;

			case "secrets":
				await manageSecrets();
				await input({ message: "Press Enter to continue..." });
				break;

			case "harnesses":
				await manageHarnesses();
				break;

			case "logs":
				await showLogs({ lines: "30" });
				await input({ message: "Press Enter to continue..." });
				break;

			case "restart": {
				const spinner = ora("Restarting daemon...").start();
				await stopDaemon();
				const restarted = await startDaemon();
				if (restarted) {
					spinner.succeed("Daemon restarted");
				} else {
					spinner.fail("Failed to restart daemon");
				}
				if (isOpenClawDetected()) {
					const shouldRestart = await confirm({
						message: "Restart connected OpenClaw instance?",
						default: false,
					});
					if (shouldRestart) {
						await restartOpenClaw(AGENTS_DIR);
					}
				}
				await input({ message: "Press Enter to continue..." });
				break;
			}

			case "stop":
				const stopSpinner = ora("Stopping daemon...").start();
				const stopped = await stopDaemon();
				if (stopped) {
					stopSpinner.succeed("Daemon stopped");
				} else {
					stopSpinner.fail("Failed to stop daemon");
				}
				return;

			case "exit":
				return;
		}

		console.log();
	}
}

async function manageSecrets() {
	console.log();
	console.log(chalk.bold("  Manage Secrets\n"));

	// List current secrets
	let secrets: string[] = [];
	try {
		const { ok, data } = await secretApiCall("GET", "/api/secrets");
		if (ok) {
			secrets = (data as { secrets: string[] }).secrets;
		}
	} catch {}

	if (secrets.length > 0) {
		console.log(chalk.dim("  Current secrets:"));
		for (const name of secrets) {
			console.log(`    ${chalk.cyan("◈")} ${name}`);
		}
		console.log();
	}

	const action = await select({
		message: "What would you like to do?",
		choices: [
			{ value: "add", name: "Add a secret" },
			{ value: "delete", name: "Delete a secret" },
			{ value: "back", name: "Back to menu" },
		],
	});

	if (action === "back") return;

	if (action === "add") {
		const name = await input({
			message: "Secret name (e.g., OPENAI_API_KEY):",
			validate: (val) => (val.trim() ? true : "Name is required"),
		});

		const value = await password({
			message: `Enter value for ${chalk.bold(name)}:`,
			mask: "•",
		});

		if (!value) {
			console.log(chalk.red("  Value cannot be empty"));
			return;
		}

		const spinner = ora("Saving secret...").start();
		try {
			const { ok, data } = await secretApiCall("POST", `/api/secrets/${name}`, {
				value,
			});
			if (ok) {
				spinner.succeed(chalk.green(`Secret ${chalk.bold(name)} saved`));
			} else {
				spinner.fail(chalk.red(`Failed: ${(data as { error: string }).error}`));
			}
		} catch (e) {
			spinner.fail(chalk.red(`Error: ${(e as Error).message}`));
		}
	}

	if (action === "delete") {
		if (secrets.length === 0) {
			console.log(chalk.dim("  No secrets to delete"));
			return;
		}

		const name = await select({
			message: "Select secret to delete:",
			choices: secrets.map((s) => ({ value: s, name: s })),
		});

		const confirmed = await confirm({
			message: `Delete secret ${chalk.bold(name)}?`,
			default: false,
		});

		if (!confirmed) return;

		const spinner = ora("Deleting...").start();
		try {
			const { ok, data } = await secretApiCall("DELETE", `/api/secrets/${name}`);
			if (ok) {
				spinner.succeed(chalk.green(`Secret ${chalk.bold(name)} deleted`));
			} else {
				spinner.fail(chalk.red(`Failed: ${(data as { error: string }).error}`));
			}
		} catch (e) {
			spinner.fail(chalk.red(`Error: ${(e as Error).message}`));
		}
	}
}

async function manageHarnesses() {
	const basePath = AGENTS_DIR;

	const harnesses = await checkbox({
		message: "Select harnesses to configure:",
		choices: [
			{ value: "claude-code", name: "Claude Code (Anthropic CLI)" },
			{ value: "codex", name: "Codex" },
			{ value: "opencode", name: "OpenCode" },
			{ value: "openclaw", name: "OpenClaw" },
			{ value: "cursor", name: "Cursor" },
			{ value: "windsurf", name: "Windsurf" },
		],
	});

	const spinner = ora("Configuring harnesses...").start();

	for (const harness of harnesses) {
		try {
			await configureHarnessHooks(harness, basePath);
			spinner.text = `Configured ${harness}`;
		} catch (err) {
			console.warn(`\n  ⚠ Could not configure ${harness}: ${(err as Error).message}`);
		}
	}

	spinner.succeed("Harnesses configured");
}

// ============================================================================
// Existing Setup Migration Wizard (for OpenClaw/Clawdbot users)
// ============================================================================

async function existingSetupWizard(
	basePath: string,
	detection: SetupDetection,
	existingConfig: Record<string, any>,
	options?: {
		nonInteractive?: boolean;
		openDashboard?: boolean;
		skipGit?: boolean;
		embeddingProvider?: EmbeddingProviderChoice;
		embeddingModel?: string;
		extractionProvider?: ExtractionProviderChoice;
		extractionModel?: string;
	},
) {
	const spinner = ora("Setting up Signet for existing identity...").start();

	try {
		const templatesDir = getTemplatesDir();

		// Create base directories if needed
		if (!existsSync(basePath)) {
			mkdirSync(basePath, { recursive: true });
		}
		if (!existsSync(join(basePath, "memory"))) {
			mkdirSync(join(basePath, "memory"), { recursive: true });
		}
		if (!existsSync(join(basePath, "memory", "scripts"))) {
			mkdirSync(join(basePath, "memory", "scripts"), { recursive: true });
		}

		// 1. Install memory scripts
		spinner.text = "Installing memory system...";
		const scriptsSource = join(templatesDir, "memory", "scripts");
		if (existsSync(scriptsSource)) {
			copyDirRecursive(scriptsSource, join(basePath, "memory", "scripts"));
		}

		// Copy requirements.txt
		const requirementsSource = join(templatesDir, "memory", "requirements.txt");
		if (existsSync(requirementsSource)) {
			copyFileSync(requirementsSource, join(basePath, "memory", "requirements.txt"));
		}

		// Install/update built-in skills
		spinner.text = "Syncing built-in skills...";
		syncBuiltinSkills(templatesDir, basePath);

		// 2. Create agent.yaml manifest pointing to existing files
		spinner.text = "Creating agent manifest...";
		const now = new Date().toISOString();

		// Extract agent name from existing IDENTITY.md if available
		let agentName = "My Agent";
		const identityPath = join(basePath, "IDENTITY.md");
		if (existsSync(identityPath)) {
			try {
				const content = readFileSync(identityPath, "utf-8");
				const nameMatch = content.match(/^#\s*(.+)$/m);
				if (nameMatch) {
					agentName = nameMatch[1].trim();
				}
			} catch {
				// Use default
			}
		}

		// Determine which harnesses to configure based on detection
		const detectedHarnesses: string[] = [];
		if (detection.harnesses.claudeCode) detectedHarnesses.push("claude-code");
		if (detection.harnesses.openclaw) detectedHarnesses.push("openclaw");
		if (detection.harnesses.opencode) detectedHarnesses.push("opencode");
		if (detection.harnesses.codex) detectedHarnesses.push("codex");
		const packageManager = resolvePrimaryPackageManager({
			agentsDir: basePath,
			env: process.env,
		});

		const config: Record<string, unknown> = {
			version: 1,
			schema: "signet/v1",
			agent: {
				name: agentName,
				description: existingConfig.description || existingConfig.agent?.description || "Personal AI assistant",
				created: now,
				updated: now,
			},
			harnesses: detectedHarnesses,
			install: {
				primary_package_manager: packageManager.family,
				source: packageManager.source,
			},
			memory: {
				database: "memory/memories.db",
				session_budget: 2000,
				decay_rate: 0.95,
			},
			search: {
				alpha: 0.7,
				top_k: 20,
				min_score: 0.3,
			},
			// Reference existing identity files
			identity: {
				agents: "AGENTS.md",
				soul: "SOUL.md",
				identity: "IDENTITY.md",
				user: "USER.md",
				heartbeat: "HEARTBEAT.md",
				memory: "MEMORY.md",
				tools: "TOOLS.md",
			},
		};

		if (options?.embeddingProvider && options.embeddingProvider !== "none") {
			const embeddingModel =
				options.embeddingModel ||
				(options.embeddingProvider === "openai" ? "text-embedding-3-small" : "nomic-embed-text");
			config.embedding = {
				provider: options.embeddingProvider,
				model: embeddingModel,
				dimensions: getEmbeddingDimensions(embeddingModel),
			};
		}

		if (options?.extractionProvider && options.extractionProvider !== "none") {
			(config.memory as Record<string, unknown>).pipelineV2 = {
				enabled: true,
				extraction: {
					provider: options.extractionProvider,
					model:
						options.extractionModel ||
						(options.extractionProvider === "claude-code"
							? "haiku"
							: options.extractionProvider === "codex"
								? "gpt-5.3-codex"
								: options.extractionProvider === "opencode"
									? "anthropic/claude-haiku-4-5-20251001"
									: options.extractionProvider === "openrouter"
										? "openai/gpt-4o-mini"
										: "glm-4.7-flash"),
				},
				semanticContradictionEnabled: true,
				graph: { enabled: true },
				reranker: { enabled: true },
				autonomous: {
					enabled: true,
					allowUpdateDelete: true,
				},
				predictor: { enabled: true },
				predictorPipeline: { agentFeedback: true, trainingTelemetry: false },
			};
		}

		// Only write agent.yaml if it doesn't exist
		if (!existsSync(join(basePath, "agent.yaml"))) {
			writeFileSync(join(basePath, "agent.yaml"), formatYaml(config));
		}

		// 3. Initialize SQLite database with unified schema
		spinner.text = "Initializing database...";
		const dbPath = join(basePath, "memory", "memories.db");
		const db = Database(dbPath);

		// Migrate legacy schema if needed, then run versioned migrations
		const migrationResult = ensureUnifiedSchema(db);
		if (migrationResult.migrated) {
			spinner.text = `Migrated ${migrationResult.memoriesMigrated} memories from ${migrationResult.fromSchema} schema...`;
		}
		runMigrations(db);

		// 4. Import memory logs to SQLite if available
		let importResult: ImportResult | null = null;
		if (detection.hasMemoryDir && detection.memoryLogCount > 0) {
			spinner.text = `Importing ${detection.memoryLogCount} memory logs...`;
			try {
				// Create a wrapper for better-sqlite3 that matches our Database interface
				const dbWrapper = {
					addMemory: (mem: {
						type: string;
						category: string;
						content: string;
						confidence: number;
						sourceType: string;
						sourceId: string;
						tags: string[];
						updatedBy: string;
						vectorClock: Record<string, unknown>;
						manualOverride: boolean;
					}) => {
						const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
						const stmt = db.prepare(`
              INSERT INTO memories (id, content, type, source, tags, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `);
						stmt.run(id, mem.content, mem.type, mem.sourceType, JSON.stringify(mem.tags));
					},
				};
				importResult = importMemoryLogs(basePath, dbWrapper as any);
			} catch (err) {
				console.warn(`\n  ⚠ Memory import warning: ${(err as Error).message}`);
			}
		}

		db.close();

		// 5. Unify skills from all sources
		let skillsResult: SkillsResult | null = null;
		spinner.text = "Unifying skills...";
		try {
			skillsResult = await unifySkills(basePath, {
				registries: [
					// Add OpenCode skills if detected
					detection.harnesses.opencode
						? {
								path: join(homedir(), ".config", "opencode", "skills"),
								harness: "opencode",
								symlink: true,
							}
						: null,
				].filter(Boolean) as Array<{
					path: string;
					harness: string;
					symlink: boolean;
				}>,
			});
		} catch (err) {
			console.warn(`\n  ⚠ Skills unification warning: ${(err as Error).message}`);
		}

		// 6. Install connectors for detected harnesses
		spinner.text = "Configuring harness connectors...";
		const configuredHarnesses: string[] = [];

		for (const harness of detectedHarnesses) {
			try {
				await configureHarnessHooks(harness, basePath);
				configuredHarnesses.push(harness);
			} catch (err) {
				console.warn(`\n  ⚠ Could not configure ${harness}: ${(err as Error).message}`);
			}
		}

		// 7. Copy .gitignore if not present
		const gitignoreSrc = join(templatesDir, "gitignore.template");
		const gitignoreDest = join(basePath, ".gitignore");
		if (existsSync(gitignoreSrc) && !existsSync(gitignoreDest)) {
			copyFileSync(gitignoreSrc, gitignoreDest);
		}

		// 8. Initialize git if not already a repo
		let gitEnabled = false;
		if (options?.skipGit !== true) {
			if (!isGitRepo(basePath)) {
				spinner.text = "Initializing git...";
				gitEnabled = await gitInit(basePath);
			} else {
				gitEnabled = true;
			}
		}

		// 9. Start the daemon
		spinner.text = "Starting daemon...";
		const daemonStarted = await startDaemon(basePath);

		spinner.succeed(chalk.green("Signet setup complete!"));

		// Summary output
		console.log();
		console.log(chalk.dim("  Your existing identity files are now managed by Signet."));
		console.log(chalk.dim(`    ${basePath}`));
		console.log();

		// Show what was done
		if (importResult && importResult.imported > 0) {
			console.log(chalk.dim(`  Memory logs imported: ${importResult.imported} entries`));
			if (importResult.skipped > 0) {
				console.log(chalk.dim(`    (${importResult.skipped} skipped)`));
			}
		}

		if (skillsResult && (skillsResult.imported > 0 || skillsResult.symlinked > 0)) {
			console.log(
				chalk.dim(`  Skills unified: ${skillsResult.imported} imported, ${skillsResult.symlinked} symlinked`),
			);
		}

		if (configuredHarnesses.length > 0) {
			console.log();
			console.log(chalk.dim("  Connectors installed for:"));
			for (const h of configuredHarnesses) {
				console.log(chalk.dim(`    ✓ ${h}`));
			}
		}

		if (daemonStarted) {
			console.log();
			console.log(chalk.green(`  ● Daemon running at http://localhost:${DEFAULT_PORT}`));
		}

		// Git commit
		if (options?.skipGit !== true && gitEnabled) {
			const date = new Date().toISOString().split("T")[0];
			const committed = await gitAddAndCommit(basePath, `${date}_signet-setup`);
			if (committed) {
				console.log(chalk.dim("  ✓ Changes committed to git"));
			}
		}

		console.log();

		if (options?.nonInteractive === true) {
			if (options.openDashboard === true) {
				await open(`http://localhost:${DEFAULT_PORT}`);
			}
		} else {
			const launchNow = await confirm({
				message: "Open the dashboard?",
				default: true,
			});

			if (launchNow) {
				await open(`http://localhost:${DEFAULT_PORT}`);
			}
		}

		// Suggest onboarding
		console.log();
		console.log(chalk.cyan("  → Next step: Say '/onboarding' to personalize your agent"));
		console.log(chalk.dim("    This will walk you through setting up your agent's personality,"));
		console.log(chalk.dim("    communication style, and your preferences."));
	} catch (err) {
		spinner.fail(chalk.red("Setup failed"));
		console.error(err);
		process.exit(1);
	}
}

// ============================================================================
// signet setup - Interactive Setup Wizard
// ============================================================================

async function setupWizard(options: SetupWizardOptions) {
	console.log(signetLogo());
	console.log();

	const nonInteractive = options.nonInteractive === true;
	const explicitPath = normalizeStringValue(options.path);
	let basePath = normalizeAgentPath(explicitPath ?? AGENTS_DIR);

	if (!explicitPath) {
		const defaultDetection = detectExistingSetup(basePath);
		if (!hasExistingAgentState(defaultDetection)) {
			const openClawWorkspace = detectPreferredOpenClawWorkspace(basePath);
			if (openClawWorkspace) {
				if (nonInteractive) {
					basePath = openClawWorkspace;
				} else {
					console.log(chalk.cyan(`  Detected OpenClaw workspace: ${openClawWorkspace}`));
					const useDetectedWorkspace = await confirm({
						message: "Use this as the Signet agent directory?",
						default: true,
					});
					if (useDetectedWorkspace) {
						basePath = openClawWorkspace;
					}
					console.log();
				}
			}
		}
	}

	const existing = detectExistingSetup(basePath);

	if (nonInteractive) {
		console.log(chalk.dim("  Running in non-interactive mode"));
		if (!explicitPath && basePath !== AGENTS_DIR) {
			console.log(chalk.dim(`  Using detected OpenClaw workspace: ${basePath}`));
		}
		console.log();
	}

	// Load existing config for defaults
	let existingConfig: Record<string, any> = {};
	if (existing.agentYaml) {
		try {
			const yaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
			existingConfig = parseSimpleYaml(yaml);
		} catch {
			// Failed to parse, use empty defaults
		}
	}

	// Extract existing values for defaults
	const existingName = existingConfig.name || existingConfig.agent?.name || "My Agent";
	const existingDesc = existingConfig.description || existingConfig.agent?.description || "Personal AI assistant";
	const existingHarnesses: string[] = Array.isArray(existingConfig.harnesses)
		? existingConfig.harnesses
				.filter((value: unknown): value is string => typeof value === "string")
				.map((value) => value.trim())
				.filter((value) => value.length > 0)
		: typeof existingConfig.harnesses === "string"
			? existingConfig.harnesses
					.split(",")
					.map((value: string) => value.trim())
					.filter((value: string) => value.length > 0)
			: [];
	const existingEmbedding = existingConfig.embedding || {};
	const existingSearch = existingConfig.search || {};
	const existingMemory = existingConfig.memory || {};

	// Check for existing Signet installation with database
	if (existing.agentsDir && existing.memoryDb) {
		console.log(chalk.green("  ✓ Existing Signet installation detected"));
		console.log(chalk.dim(`    ${basePath}`));
		console.log();

		if (nonInteractive) {
			const running = await isDaemonRunning();
			if (!running) {
				const spinner = ora("Starting daemon...").start();
				const started = await startDaemon(basePath);
				if (started) {
					spinner.succeed("Daemon started");
				} else {
					spinner.fail("Failed to start daemon");
				}
			}

			if (options.openDashboard === true) {
				await open(`http://localhost:${DEFAULT_PORT}`);
			}

			return;
		}

		const action = await select({
			message: "What would you like to do?",
			choices: [
				{ value: "dashboard", name: "Launch dashboard" },
				{ value: "github-import", name: "Import agent config from GitHub" },
				{ value: "reconfigure", name: "Reconfigure settings" },
				{ value: "status", name: "View status" },
				{ value: "exit", name: "Exit" },
			],
		});

		if (action === "dashboard") {
			await launchDashboard({ path: basePath });
			return;
		}

		if (action === "github-import") {
			await importFromGitHub(basePath);
			return;
		}

		if (action === "status") {
			await showStatus({ path: basePath });
			return;
		}

		if (action === "exit") {
			return;
		}

		// Sync template files on reconfigure
		const templatesDir = getTemplatesDir();
		// Sync gitignore (stored as gitignore.template because npm excludes .gitignore)
		const gitignoreSrc = join(templatesDir, "gitignore.template");
		const gitignoreDest = join(basePath, ".gitignore");
		if (existsSync(gitignoreSrc) && !existsSync(gitignoreDest)) {
			copyFileSync(gitignoreSrc, gitignoreDest);
			console.log(chalk.dim(`  Synced missing: .gitignore`));
		}

		const skillSyncResult = syncBuiltinSkills(templatesDir, basePath);
		const syncedBuiltins = skillSyncResult.installed.length + skillSyncResult.updated.length;
		if (syncedBuiltins > 0) {
			console.log(chalk.dim(`  Synced built-in skills: ${syncedBuiltins}`));
		}
	}
	// Check for existing identity files (OpenClaw/Clawdbot migration scenario)
	else if (hasExistingIdentityFiles(existing)) {
		// Show detailed summary of what was detected
		console.log(chalk.cyan("  Detected existing agent identity"));
		console.log(chalk.dim(`    ${basePath}`));
		console.log();
		console.log(formatDetectionSummary(existing));
		console.log();

		console.log(chalk.bold("  Signet will:"));
		console.log(chalk.dim("    1. Create AGENT.yaml manifest pointing to your existing files"));
		console.log(chalk.dim("    2. Import memory logs to SQLite for search"));
		console.log(chalk.dim("    3. Sync built-in skills + unify external skill sources"));
		console.log(chalk.dim("    4. Install connectors for detected harnesses"));
		console.log(chalk.dim("    5. Keep all existing files unchanged"));
		console.log();

		if (nonInteractive) {
			const migrationEmbeddingProvider = normalizeChoice(options.embeddingProvider, EMBEDDING_PROVIDER_CHOICES);
			const migrationExtractionProvider = normalizeChoice(options.extractionProvider, EXTRACTION_PROVIDER_CHOICES);
			if (!migrationEmbeddingProvider) {
				failNonInteractiveSetup(
					"Non-interactive setup requires --embedding-provider (native, ollama, openai, or none).",
				);
			}
			if (!migrationExtractionProvider) {
				failNonInteractiveSetup(
					"Non-interactive setup requires --extraction-provider (claude-code, codex, ollama, opencode, openrouter, or none).",
				);
			}

			await existingSetupWizard(basePath, existing, existingConfig, {
				nonInteractive: true,
				openDashboard: options.openDashboard === true,
				skipGit: options.skipGit === true,
				embeddingProvider: migrationEmbeddingProvider,
				embeddingModel: normalizeStringValue(options.embeddingModel) || undefined,
				extractionProvider: migrationExtractionProvider,
				extractionModel: normalizeStringValue(options.extractionModel) || undefined,
			});
			return;
		}

		const proceed = await confirm({
			message: "Proceed with Signet setup?",
			default: true,
		});

		if (!proceed) {
			console.log();
			const manualAction = await select({
				message: "What would you like to do instead?",
				choices: [
					{ value: "fresh", name: "Start fresh (create new identity)" },
					{ value: "github", name: "Import from GitHub repository" },
					{ value: "exit", name: "Exit" },
				],
			});

			if (manualAction === "exit") {
				return;
			} else if (manualAction === "github") {
				mkdirSync(basePath, { recursive: true });
				mkdirSync(join(basePath, "memory"), { recursive: true });
				await importFromGitHub(basePath);
				return;
			}
			// For 'fresh', continue to normal setup flow below
		} else {
			// Run the enhanced migration wizard for existing setups
			await existingSetupWizard(basePath, existing, existingConfig);
			return;
		}
	}
	// Fresh install - no existing identity
	else {
		console.log(chalk.bold("  Let's set up your agent identity.\n"));

		// For fresh installs, offer to import from GitHub
		const setupMethod = nonInteractive
			? "new"
			: await select({
					message: "How would you like to set up?",
					choices: [
						{ value: "new", name: "Create new agent identity" },
						{ value: "github", name: "Import from GitHub repository" },
					],
				});

		if (setupMethod === "github") {
			// Create minimal structure first
			mkdirSync(basePath, { recursive: true });
			mkdirSync(join(basePath, "memory"), { recursive: true });
			await importFromGitHub(basePath);
			return;
		}
		console.log();
	}

	const configuredName = normalizeStringValue(options.name);
	const agentName = nonInteractive
		? configuredName || existingName
		: await input({
				message: "What should your agent be called?",
				default: existingName,
			});

	// Build harness choices with existing selections pre-checked
	const harnessChoices = [
		{
			value: "claude-code",
			name: "Claude Code (Anthropic CLI)",
			checked: existingHarnesses.includes("claude-code"),
		},
		{
			value: "codex",
			name: "Codex",
			checked: existingHarnesses.includes("codex"),
		},
		{
			value: "opencode",
			name: "OpenCode",
			checked: existingHarnesses.includes("opencode"),
		},
		{
			value: "openclaw",
			name: "OpenClaw",
			checked: existingHarnesses.includes("openclaw"),
		},
	];

	let harnesses: string[] = [];
	if (nonInteractive) {
		const rawParts = (options.harness ?? []).flatMap((v) =>
			v
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
		);
		const requestedHarnesses = normalizeHarnessList(options.harness);

		// Reject unknown harness values in non-interactive mode
		if (rawParts.length > 0 && rawParts.length !== requestedHarnesses.length) {
			const unknown = rawParts.filter((p) => !normalizeChoice(p, SETUP_HARNESS_CHOICES));
			failNonInteractiveSetup(
				`Unknown --harness value(s): ${unknown.join(", ")}. Valid choices: ${SETUP_HARNESS_CHOICES.join(", ")}.`,
			);
		}

		if (requestedHarnesses.length > 0) {
			harnesses = requestedHarnesses;
		} else {
			harnesses = normalizeHarnessList(existingHarnesses);
		}
	} else {
		console.log();
		harnesses = await checkbox({
			message: "Which AI platforms do you use?",
			choices: harnessChoices,
		});
	}

	// OpenClaw configuration (handles openclaw/clawdbot/moltbot)
	let configureOpenClawWs = false;
	let openclawRuntimePath: OpenClawRuntimeChoice = "plugin";
	if (harnesses.includes("openclaw")) {
		const connector = new OpenClawConnector();
		const existingConfigs = connector.getDiscoveredConfigPaths();

		if (nonInteractive) {
			configureOpenClawWs = options.configureOpenclawWorkspace === true && existingConfigs.length > 0;

			const requestedRuntimePath = normalizeChoice(options.openclawRuntimePath, OPENCLAW_RUNTIME_CHOICES);
			openclawRuntimePath = requestedRuntimePath ?? "plugin";
		} else {
			if (existingConfigs.length > 0) {
				console.log();
				configureOpenClawWs = await confirm({
					message: `Set OpenClaw workspace to ${basePath} in ${existingConfigs.length} config file(s)?`,
					default: true,
				});
			}

			console.log();
			openclawRuntimePath = (await select({
				message: "OpenClaw integration mode:",
				choices: [
					{
						value: "plugin" as const,
						name: "Plugin adapter (recommended)",
						description: "@signetai/signet-memory-openclaw — full lifecycle + memory tools",
					},
					{
						value: "legacy" as const,
						name: "Legacy hooks",
						description: "handler.js for /remember, /recall, /context commands",
					},
				],
				default: "plugin",
			})) as OpenClawRuntimeChoice;
		}
	}

	const configuredDescription = normalizeStringValue(options.description);
	const agentDescription = nonInteractive
		? configuredDescription || existingDesc
		: await input({
				message: "Short description of your agent:",
				default: existingDesc,
			});

	const requestedEmbeddingProvider = normalizeChoice(options.embeddingProvider, EMBEDDING_PROVIDER_CHOICES);
	const requestedExtractionProvider = normalizeChoice(options.extractionProvider, EXTRACTION_PROVIDER_CHOICES);

	if (nonInteractive && !requestedEmbeddingProvider) {
		failNonInteractiveSetup("Non-interactive setup requires --embedding-provider (native, ollama, openai, or none).");
	}

	if (nonInteractive && !requestedExtractionProvider) {
		failNonInteractiveSetup(
			"Non-interactive setup requires --extraction-provider (claude-code, codex, ollama, opencode, openrouter, or none).",
		);
	}

	let embeddingProvider: EmbeddingProviderChoice;
	if (nonInteractive) {
		const providerFromConfig = normalizeChoice(existingEmbedding.provider, EMBEDDING_PROVIDER_CHOICES);
		embeddingProvider = requestedEmbeddingProvider ?? providerFromConfig ?? "none";
	} else {
		console.log();
		embeddingProvider = (await select({
			message: "How should memories be embedded for search?",
			choices: [
				{ value: "native", name: "Built-in (recommended, no setup required)" },
				{ value: "ollama", name: "Ollama (local, requires ollama install)" },
				{ value: "openai", name: "OpenAI API" },
				{ value: "none", name: "Skip embeddings for now" },
			],
		})) as EmbeddingProviderChoice;
	}

	// Embedding model selection based on provider
	let embeddingModel = "nomic-embed-text";
	let embeddingDimensions = 768;

	if (embeddingProvider === "native") {
		embeddingModel = "nomic-embed-text-v1.5";
		embeddingDimensions = 768;
		// No preflight needed — model downloads on first daemon start
	} else if (embeddingProvider === "ollama") {
		if (nonInteractive) {
			const configuredModel =
				normalizeStringValue(options.embeddingModel) ||
				normalizeStringValue(existingEmbedding.model) ||
				"nomic-embed-text";
			embeddingModel = configuredModel;
			embeddingDimensions = getEmbeddingDimensions(configuredModel);
		} else {
			console.log();
			const model = await select({
				message: "Which embedding model?",
				choices: [
					{
						value: "nomic-embed-text",
						name: "nomic-embed-text (768d, recommended)",
					},
					{ value: "all-minilm", name: "all-minilm (384d, faster)" },
					{
						value: "mxbai-embed-large",
						name: "mxbai-embed-large (1024d, better quality)",
					},
				],
			});

			const preflight = await preflightOllamaEmbedding(model);
			embeddingProvider = preflight.provider;
			embeddingModel = preflight.model ?? embeddingModel;
			embeddingDimensions = preflight.dimensions ?? embeddingDimensions;
		}
	} else if (embeddingProvider === "openai") {
		if (nonInteractive) {
			const configuredModel =
				normalizeChoice(options.embeddingModel, ["text-embedding-3-small", "text-embedding-3-large"]) ||
				normalizeChoice(existingEmbedding.model, ["text-embedding-3-small", "text-embedding-3-large"]) ||
				"text-embedding-3-small";
			embeddingModel = configuredModel;
			embeddingDimensions = getEmbeddingDimensions(configuredModel);
		} else {
			const openai = await promptOpenAIEmbeddingModel();
			embeddingModel = openai.model;
			embeddingDimensions = openai.dimensions;
		}
	}

	// Search settings
	const existingSearchBalance = parseSearchBalanceValue(existingSearch.alpha);
	const requestedSearchBalance = parseSearchBalanceValue(options.searchBalance);
	const searchBalance = nonInteractive
		? (requestedSearchBalance ?? existingSearchBalance ?? 0.7)
		: await select({
				message: "Search style (semantic vs keyword matching):",
				choices: [
					{
						value: 0.7,
						name: "Balanced (70% semantic, 30% keyword) - recommended",
					},
					{ value: 0.9, name: "Semantic-heavy (90% semantic, 10% keyword)" },
					{ value: 0.5, name: "Equal (50/50)" },
					{ value: 0.3, name: "Keyword-heavy (30% semantic, 70% keyword)" },
				],
			});

	// Memory pipeline provider — auto-detect best default
	const detectedProvider: ExtractionProviderChoice = hasCommand("claude")
		? "claude-code"
		: hasCommand("codex")
			? "codex"
			: hasCommand("opencode")
				? "opencode"
				: !!normalizeStringValue(process.env.OPENROUTER_API_KEY)
					? "openrouter"
					: hasCommand("ollama")
						? "ollama"
						: "none";

	let extractionProvider: ExtractionProviderChoice;
	if (nonInteractive) {
		const providerFromConfig = normalizeChoice(
			existingMemory.pipelineV2?.extractionProvider,
			EXTRACTION_PROVIDER_CHOICES,
		);
		extractionProvider = requestedExtractionProvider ?? providerFromConfig ?? detectedProvider;
	} else {
		console.log();
		const choices = [
			{
				value: "claude-code" as const,
				name: `Claude Code (uses your Claude subscription via CLI)${detectedProvider === "claude-code" ? " — detected" : ""}`,
			},
			{
				value: "codex" as const,
				name: `Codex (uses your OpenAI Codex CLI locally)${detectedProvider === "codex" ? " — detected" : ""}`,
			},
			{
				value: "opencode" as const,
				name: `OpenCode (uses the OpenCode CLI or local server)${detectedProvider === "opencode" ? " — detected" : ""}`,
			},
			{
				value: "openrouter" as const,
				name: `OpenRouter (cloud API, requires OPENROUTER_API_KEY)${detectedProvider === "openrouter" ? " — detected" : ""}`,
			},
			{
				value: "ollama" as const,
				name: `Ollama (local, requires running Ollama server)${detectedProvider === "ollama" ? " — detected" : ""}`,
			},
			{ value: "none" as const, name: "Skip extraction pipeline" },
		];
		extractionProvider = (await select({
			message: "Memory extraction provider (analyzes conversations):",
			choices,
			default: detectedProvider,
		})) as ExtractionProviderChoice;
	}

	let extractionModel = "haiku";
	if (extractionProvider === "claude-code") {
		if (nonInteractive) {
			extractionModel =
				normalizeStringValue(options.extractionModel) ||
				normalizeStringValue(existingMemory.pipelineV2?.extractionModel) ||
				"haiku";
		} else {
			console.log();
			extractionModel = (await select({
				message: "Which Claude model for extraction?",
				choices: [
					{ value: "haiku", name: "Haiku (fast, cheap, recommended)" },
					{ value: "sonnet", name: "Sonnet (better quality, slower)" },
				],
			})) as string;
		}
	} else if (extractionProvider === "codex") {
		if (nonInteractive) {
			extractionModel =
				normalizeStringValue(options.extractionModel) ||
				normalizeStringValue(existingMemory.pipelineV2?.extractionModel) ||
				"gpt-5.3-codex";
		} else {
			console.log();
			extractionModel = (await select({
				message: "Which Codex model for extraction?",
				choices: [
					{ value: "gpt-5.3-codex", name: "gpt-5.3-codex (recommended)" },
					{ value: "gpt-5-codex", name: "gpt-5-codex (stable fallback)" },
					{ value: "gpt-5-codex-mini", name: "gpt-5-codex-mini (faster, lighter)" },
				],
			})) as string;
		}
	} else if (extractionProvider === "opencode") {
		if (nonInteractive) {
			extractionModel =
				normalizeStringValue(options.extractionModel) ||
				normalizeStringValue(existingMemory.pipelineV2?.extractionModel) ||
				"anthropic/claude-haiku-4-5-20251001";
		} else {
			console.log();
			extractionModel = (await select({
				message: "Which model for OpenCode extraction? (provider/model format)",
				choices: [
					{
						value: "anthropic/claude-haiku-4-5-20251001",
						name: "Claude Haiku (fast, cheap, recommended)",
					},
					{
						value: "anthropic/claude-sonnet-4-5-20250514",
						name: "Claude Sonnet (better quality, slower)",
					},
					{
						value: "google/gemini-2.5-flash",
						name: "Gemini 2.5 Flash (fast, multimodal)",
					},
				],
			})) as string;
		}
	} else if (extractionProvider === "openrouter") {
		if (nonInteractive) {
			extractionModel =
				normalizeStringValue(options.extractionModel) ||
				normalizeStringValue(existingMemory.pipelineV2?.extractionModel) ||
				"openai/gpt-4o-mini";
		} else {
			console.log();
			extractionModel = (await select({
				message: "Which OpenRouter model for extraction? (provider/model format)",
				choices: [
					{
						value: "openai/gpt-4o-mini",
						name: "openai/gpt-4o-mini (fast, recommended)",
					},
					{
						value: "openai/gpt-4o",
						name: "openai/gpt-4o (higher quality)",
					},
					{
						value: "anthropic/claude-sonnet-4-6",
						name: "anthropic/claude-sonnet-4-6 (high quality)",
					},
					{
						value: "google/gemini-2.5-flash",
						name: "google/gemini-2.5-flash (balanced)",
					},
				],
			})) as string;
		}
	} else if (extractionProvider === "ollama") {
		if (nonInteractive) {
			extractionModel =
				normalizeStringValue(options.extractionModel) ||
				normalizeStringValue(existingMemory.pipelineV2?.extractionModel) ||
				"glm-4.7-flash";
		} else {
			console.log();
			extractionModel = (await select({
				message: "Which Ollama model for extraction?",
				choices: [
					{
						value: "glm-4.7-flash",
						name: "glm-4.7-flash (good quality, recommended)",
					},
					{ value: "qwen3:4b", name: "qwen3:4b (lighter, faster)" },
					{ value: "llama3", name: "llama3 (general purpose)" },
				],
			})) as string;
		}
	}

	// Advanced settings (optional)
	const wantAdvanced = nonInteractive
		? false
		: await confirm({
				message: "Configure advanced settings?",
				default: false,
			});

	let searchTopK = parseIntegerValue(existingSearch.top_k) ?? 20;
	let searchMinScore = parseSearchBalanceValue(existingSearch.min_score) ?? 0.3;
	let memorySessionBudget = parseIntegerValue(existingMemory.session_budget) ?? 2000;
	let memoryDecayRate = parseSearchBalanceValue(existingMemory.decay_rate) ?? 0.95;

	if (wantAdvanced) {
		console.log();
		console.log(chalk.dim("  Advanced settings:\n"));

		const topKInput = await input({
			message: "Search candidates per source (top_k):",
			default: "20",
		});
		searchTopK = Number.parseInt(topKInput, 10) || 20;

		const minScoreInput = await input({
			message: "Minimum search score threshold (0-1):",
			default: "0.3",
		});
		searchMinScore = Number.parseFloat(minScoreInput) || 0.3;

		const budgetInput = await input({
			message: "Session context budget (characters):",
			default: "2000",
		});
		memorySessionBudget = Number.parseInt(budgetInput, 10) || 2000;

		const decayInput = await input({
			message: "Memory importance decay rate per day (0-1):",
			default: "0.95",
		});
		memoryDecayRate = Number.parseFloat(decayInput) || 0.95;
	}

	// Git version control setup
	let gitEnabled = false;
	const shouldSkipGit = nonInteractive && options.skipGit === true;

	if (existing.agentsDir) {
		// Directory exists - check if it's a git repo
		if (isGitRepo(basePath)) {
			gitEnabled = true;
			console.log(chalk.dim("  Git repo detected. Will create backup commit before changes."));
		} else if (!shouldSkipGit) {
			const initGit = nonInteractive
				? true
				: await confirm({
						message: "Initialize git for version history?",
						default: true,
					});

			if (initGit) {
				const initialized = await gitInit(basePath);
				if (initialized) {
					gitEnabled = true;
					console.log(chalk.dim("  ✓ Git initialized"));
				} else {
					console.log(chalk.yellow("  ⚠ Could not initialize git"));
				}
			}
		}
	} else if (!shouldSkipGit) {
		// Fresh install - ask about git
		const initGit = nonInteractive
			? true
			: await confirm({
					message: "Initialize git for version history?",
					default: true,
				});
		gitEnabled = initGit;
	}

	console.log();
	const spinner = ora("Setting up Signet...").start();

	try {
		const templatesDir = getTemplatesDir();

		// Create base directory first (needed for git init on fresh install)
		mkdirSync(basePath, { recursive: true });

		// Copy .gitignore first (before git init)
		// Note: stored as gitignore.template because npm excludes .gitignore files
		const gitignoreSource = join(templatesDir, "gitignore.template");
		if (existsSync(gitignoreSource)) {
			copyFileSync(gitignoreSource, join(basePath, ".gitignore"));
		}

		// Initialize git if requested and fresh install
		if (gitEnabled && !isGitRepo(basePath)) {
			spinner.text = "Initializing git...";
			await gitInit(basePath);
		}

		// Create backup commit if git enabled and there's existing content
		if (gitEnabled && existing.agentsDir) {
			spinner.text = "Creating backup commit...";
			const date = new Date().toISOString().split("T")[0];
			await gitAddAndCommit(basePath, `${date}_pre-signet-backup`);
		}

		mkdirSync(join(basePath, "memory", "scripts"), { recursive: true });
		mkdirSync(join(basePath, "harnesses"), { recursive: true });

		spinner.text = "Installing memory system...";
		const scriptsSource = join(templatesDir, "memory", "scripts");
		if (existsSync(scriptsSource)) {
			copyDirRecursive(scriptsSource, join(basePath, "memory", "scripts"));
		}

		// Copy requirements.txt (optional, for users who want Python scripts)
		const requirementsSource = join(templatesDir, "memory", "requirements.txt");
		if (existsSync(requirementsSource)) {
			copyFileSync(requirementsSource, join(basePath, "memory", "requirements.txt"));
		}

		const utilScriptsSource = join(templatesDir, "scripts");
		if (existsSync(utilScriptsSource)) {
			mkdirSync(join(basePath, "scripts"), { recursive: true });
			copyDirRecursive(utilScriptsSource, join(basePath, "scripts"));
		}

		// Install built-in skills (remember, recall, signet, memory-debug)
		spinner.text = "Installing built-in skills...";
		syncBuiltinSkills(templatesDir, basePath);

		spinner.text = "Creating agent identity...";
		const agentsTemplate = join(templatesDir, "AGENTS.md.template");
		let agentsMd: string;
		if (existsSync(agentsTemplate)) {
			agentsMd = readFileSync(agentsTemplate, "utf-8").replace(/\{\{AGENT_NAME\}\}/g, agentName);
		} else {
			agentsMd = `# ${agentName}

This is your agent identity file. Define your agent's personality, capabilities,
and behaviors here. This file is shared across all your AI tools.

## Personality

${agentName} is a helpful assistant.

## Instructions

- Be concise and direct
- Ask clarifying questions when needed
- Remember user preferences
`;
		}
		writeFileSync(join(basePath, "AGENTS.md"), agentsMd);

		spinner.text = "Writing configuration...";
		const now = new Date().toISOString();
		const packageManager = resolvePrimaryPackageManager({
			agentsDir: basePath,
			env: process.env,
		});
		const config: Record<string, unknown> = {
			version: 1,
			schema: "signet/v1",
			agent: {
				name: agentName,
				description: agentDescription,
				created: now,
				updated: now,
			},
			harnesses: harnesses,
			install: {
				primary_package_manager: packageManager.family,
				source: packageManager.source,
			},
			memory: {
				database: "memory/memories.db",
				session_budget: memorySessionBudget,
				decay_rate: memoryDecayRate,
			},
			search: {
				alpha: searchBalance,
				top_k: searchTopK,
				min_score: searchMinScore,
			},
		};

		if (embeddingProvider !== "none") {
			config.embedding = {
				provider: embeddingProvider,
				model: embeddingModel,
				dimensions: embeddingDimensions,
			};
		}

		if (extractionProvider !== "none") {
			(config.memory as Record<string, unknown>).pipelineV2 = {
				enabled: true,
				extraction: {
					provider: extractionProvider,
					model: extractionModel,
				},
				semanticContradictionEnabled: true,
				graph: { enabled: true },
				reranker: { enabled: true },
				autonomous: {
					enabled: true,
					allowUpdateDelete: true,
					maintenanceMode: "execute",
				},
				predictor: { enabled: true },
				predictorPipeline: { agentFeedback: true, trainingTelemetry: false },
			};
		}

		writeFileSync(join(basePath, "agent.yaml"), formatYaml(config));

		// Create all standard document files from templates
		const docFiles = [
			{ name: "MEMORY.md", template: "MEMORY.md.template" },
			{ name: "SOUL.md", template: "SOUL.md.template" },
			{ name: "IDENTITY.md", template: "IDENTITY.md.template" },
			{ name: "USER.md", template: "USER.md.template" },
		];

		for (const doc of docFiles) {
			const templatePath = join(templatesDir, doc.template);
			const destPath = join(basePath, doc.name);

			// Don't overwrite existing files
			if (existsSync(destPath)) continue;

			if (existsSync(templatePath)) {
				const content = readFileSync(templatePath, "utf-8").replace(/\{\{AGENT_NAME\}\}/g, agentName);
				writeFileSync(destPath, content);
			}
		}

		spinner.text = "Initializing database...";
		const dbPath = join(basePath, "memory", "memories.db");
		const db = Database(dbPath);

		ensureUnifiedSchema(db);
		runMigrations(db);

		db.close();

		spinner.text = "Configuring harness hooks...";
		const configuredHarnesses: string[] = [];

		for (const harness of harnesses) {
			try {
				await configureHarnessHooks(harness, basePath, {
					openclawRuntimePath,
				});
				configuredHarnesses.push(harness);
			} catch (err) {
				console.warn(`\n  ⚠ Could not configure ${harness}: ${(err as Error).message}`);
			}
		}

		// Configure OpenClaw workspace if requested
		if (configureOpenClawWs) {
			spinner.text = "Configuring OpenClaw workspace...";
			const patched = await new OpenClawConnector().configureWorkspace(basePath);
			if (patched.length > 0) {
				console.log(chalk.dim(`\n  ✓ OpenClaw workspace set to ${basePath}`));
			}
		}

		// Start the daemon
		spinner.text = "Starting daemon...";
		const daemonStarted = await startDaemon(basePath);

		spinner.succeed(chalk.green("Signet initialized!"));

		console.log();
		console.log(chalk.dim("  Files created:"));
		console.log(chalk.dim(`    ${basePath}/`));
		console.log(chalk.dim("    ├── agent.yaml    manifest & config"));
		console.log(chalk.dim("    ├── AGENTS.md     agent instructions"));
		console.log(chalk.dim("    ├── SOUL.md       personality & tone"));
		console.log(chalk.dim("    ├── IDENTITY.md   agent identity"));
		console.log(chalk.dim("    ├── USER.md       your profile"));
		console.log(chalk.dim("    ├── MEMORY.md     working memory"));
		console.log(chalk.dim("    └── memory/       database & vectors"));

		if (configuredHarnesses.length > 0) {
			console.log();
			console.log(chalk.dim("  Hooks configured for:"));
			for (const h of configuredHarnesses) {
				console.log(chalk.dim(`    ✓ ${h}`));
			}
		}

		if (daemonStarted) {
			console.log();
			console.log(chalk.green(`  ● Daemon running at http://localhost:${DEFAULT_PORT}`));
		}

		console.log();

		// Commit the initial setup
		if (gitEnabled) {
			const date = new Date().toISOString().split("T")[0];
			const committed = await gitAddAndCommit(basePath, `${date}_signet-setup`);
			if (committed) {
				console.log(chalk.dim("  ✓ Changes committed to git"));
			}
		}

		if (nonInteractive) {
			if (options.openDashboard === true) {
				await open(`http://localhost:${DEFAULT_PORT}`);
			}
		} else {
			const launchNow = await confirm({
				message: "Open the dashboard?",
				default: true,
			});

			if (launchNow) {
				await open(`http://localhost:${DEFAULT_PORT}`);
			}
		}

		// Suggest onboarding
		console.log();
		console.log(chalk.cyan("  → Next step: Say '/onboarding' to personalize your agent"));
		console.log(chalk.dim("    This will walk you through setting up your agent's personality,"));
		console.log(chalk.dim("    communication style, and your preferences."));
	} catch (err) {
		spinner.fail(chalk.red("Setup failed"));
		console.error(err);
		process.exit(1);
	}
}

// ============================================================================
// Import from GitHub
// ============================================================================

async function importFromGitHub(basePath: string) {
	console.log();
	console.log(chalk.bold("  Import agent configuration from GitHub\n"));

	const repoUrl = await input({
		message: "GitHub repo URL (e.g., username/repo or full URL):",
		validate: (val) => {
			if (!val.trim()) return "URL is required";
			return true;
		},
	});

	// Normalize URL
	let gitUrl = repoUrl.trim();
	if (!gitUrl.includes("://") && !gitUrl.startsWith("git@")) {
		// Assume it's username/repo format
		gitUrl = `https://github.com/${gitUrl}.git`;
	} else if (gitUrl.startsWith("https://github.com/") && !gitUrl.endsWith(".git")) {
		gitUrl = gitUrl + ".git";
	}

	console.log();
	console.log(chalk.dim(`  Cloning from ${gitUrl}...`));

	// Check if basePath has uncommitted changes
	if (isGitRepo(basePath)) {
		const statusResult = spawnSync("git", ["status", "--porcelain"], {
			cwd: basePath,
			encoding: "utf-8",
			windowsHide: true,
		});
		if (statusResult.stdout && statusResult.stdout.trim()) {
			const proceed = await confirm({
				message: "You have uncommitted changes. Create backup commit first?",
				default: true,
			});
			if (proceed) {
				const date = new Date().toISOString().replace(/[:.]/g, "-");
				await gitAddAndCommit(basePath, `backup-before-import-${date}`);
				console.log(chalk.green("  ✓ Backup commit created"));
			}
		}
	}

	// Clone to temp dir first
	const tmpDir = join(basePath, ".import-tmp");
	if (existsSync(tmpDir)) {
		rmSync(tmpDir, { recursive: true });
	}

	// Validate URL scheme — reject file:// and bare local paths to prevent
	// local filesystem reads and crafted repo content execution.
	const SAFE_SCHEMES = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i;
	if (!SAFE_SCHEMES.test(gitUrl)) {
		console.log(chalk.red("  Invalid git URL — only https://, ssh://, and git:// are allowed"));
		return;
	}

	const spinner = ora("Cloning repository...").start();

	try {
		const cloneResult = spawnSync("git", ["clone", "--depth", "1", "--single-branch", gitUrl, tmpDir], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		if (cloneResult.status !== 0) {
			spinner.fail("Clone failed");
			console.log(chalk.red(`  ${cloneResult.stderr || "Unknown error"}`));
			if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
			return;
		}

		spinner.succeed("Repository cloned");

		// List files that will be imported
		const configFiles = ["agent.yaml", "AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"];
		const foundFiles: string[] = [];

		for (const file of configFiles) {
			if (existsSync(join(tmpDir, file))) {
				foundFiles.push(file);
			}
		}

		if (foundFiles.length === 0) {
			console.log(chalk.yellow("  No agent config files found in repository"));
			rmSync(tmpDir, { recursive: true });
			return;
		}

		console.log();
		console.log(chalk.dim("  Found config files:"));
		for (const file of foundFiles) {
			console.log(chalk.dim(`    • ${file}`));
		}
		console.log();

		const doImport = await confirm({
			message: `Import ${foundFiles.length} file(s)? (will overwrite existing)`,
			default: true,
		});

		if (!doImport) {
			rmSync(tmpDir, { recursive: true });
			return;
		}

		// Copy files
		for (const file of foundFiles) {
			copyFileSync(join(tmpDir, file), join(basePath, file));
			console.log(chalk.green(`  ✓ ${file}`));
		}

		// Also copy skills if present
		const skillsDir = join(tmpDir, "skills");
		if (existsSync(skillsDir)) {
			const skills = readdirSync(skillsDir);
			if (skills.length > 0) {
				mkdirSync(join(basePath, "skills"), { recursive: true });
				for (const skill of skills) {
					const src = join(skillsDir, skill);
					const dest = join(basePath, "skills", skill);
					if (statSync(src).isDirectory()) {
						copyDirRecursive(src, dest);
						console.log(chalk.green(`  ✓ skills/${skill}/`));
					}
				}
			}
		}

		// Also copy memory scripts if present
		const scriptsDir = join(tmpDir, "memory", "scripts");
		if (existsSync(scriptsDir)) {
			mkdirSync(join(basePath, "memory", "scripts"), { recursive: true });
			copyDirRecursive(scriptsDir, join(basePath, "memory", "scripts"));
			console.log(chalk.green("  ✓ memory/scripts/"));
		}

		// Clean up
		rmSync(tmpDir, { recursive: true });

		// Set up git remote if not already configured
		if (isGitRepo(basePath)) {
			const remoteResult = spawnSync("git", ["remote", "get-url", "origin"], {
				cwd: basePath,
				encoding: "utf-8",
				windowsHide: true,
			});
			if (remoteResult.status !== 0) {
				// No origin remote, add it
				spawnSync("git", ["remote", "add", "origin", gitUrl], {
					cwd: basePath,
					windowsHide: true,
				});
				console.log(chalk.dim(`  Set origin remote to ${gitUrl}`));
			}
		}

		// Commit the import
		if (isGitRepo(basePath)) {
			await gitAddAndCommit(basePath, `import from ${repoUrl.trim()}`);
			console.log(chalk.green("  ✓ Changes committed"));
		}

		console.log();
		console.log(chalk.green("  Import complete!"));
		console.log(chalk.dim("  Run `signet restart` to apply changes"));
	} catch (err: any) {
		spinner.fail("Import failed");
		console.log(chalk.red(`  ${err.message}`));
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
	}
}

// signet dashboard - Launch Web UI
// ============================================================================

async function launchDashboard(options: { path?: string }) {
	console.log(signetLogo());
	const basePath = normalizeAgentPath(extractPathOption(options) ?? AGENTS_DIR);

	const running = await isDaemonRunning();

	if (!running) {
		console.log(chalk.yellow("  Daemon is not running. Starting..."));
		const started = await startDaemon(basePath);
		if (!started) {
			console.error(chalk.red("  Failed to start daemon"));
			process.exit(1);
		}
		console.log(chalk.green("  Daemon started"));
	}

	console.log();
	console.log(`  ${chalk.cyan(`http://localhost:${DEFAULT_PORT}`)}`);
	console.log();

	await open(`http://localhost:${DEFAULT_PORT}`);
}

// ============================================================================
// signet migrate-schema - Database Schema Migration
// ============================================================================

async function migrateSchema(options: { path?: string }) {
	const basePath = normalizeAgentPath(extractPathOption(options) ?? AGENTS_DIR);
	const dbPath = join(basePath, "memory", "memories.db");

	console.log(signetLogo());

	if (!existsSync(dbPath)) {
		console.log(chalk.yellow("  No database found."));
		console.log(`  Run ${chalk.bold("signet setup")} to create one.`);
		return;
	}

	const spinner = ora("Checking database schema...").start();

	try {
		// First detect schema in readonly mode
		const db = Database(dbPath, { readonly: true });
		const schemaInfo = detectSchema(db);
		db.close();

		if (schemaInfo.type === "core") {
			spinner.succeed("Database already on unified schema");
			return;
		}

		if (schemaInfo.type === "unknown" && !schemaInfo.hasMemories) {
			spinner.succeed("Database is empty or has no memories");
			return;
		}

		spinner.text = `Migrating from ${schemaInfo.type} schema...`;
		spinner.info();

		// Stop daemon if running (it may have the DB open)
		const running = await isDaemonRunning();
		if (running) {
			console.log(chalk.dim("  Stopping daemon for migration..."));
			await stopDaemon(basePath);
			await new Promise((r) => setTimeout(r, 1000));
		}

		// Open with write access and migrate
		const writeDb = Database(dbPath);
		const result = ensureUnifiedSchema(writeDb);

		if (result.errors.length > 0) {
			for (const err of result.errors) {
				console.log(chalk.red(`  Error: ${err}`));
			}
		}

		if (result.migrated) {
			console.log(
				chalk.green(`  ✓ Migrated ${result.memoriesMigrated} memories from ${result.fromSchema} to ${result.toSchema}`),
			);
		} else {
			console.log(chalk.dim("  No migration needed"));
		}

		runMigrations(writeDb);

		writeDb.close();

		// Restart daemon if it was running
		if (running) {
			console.log(chalk.dim("  Restarting daemon..."));
			await startDaemon(basePath);
		}

		console.log();
		console.log(chalk.green("  Migration complete!"));
	} catch (err: any) {
		spinner.fail("Migration failed");
		console.log(chalk.red(`  ${err.message}`));
	}
}

// ============================================================================
// signet status - Show Agent Status
// ============================================================================

interface StatusFile {
	name: string;
	exists: boolean;
}

interface StatusDb {
	exists: boolean;
	schema: string | null;
	needsMigration: boolean;
	memoryCount: number | null;
	conversationCount: number | null;
}

interface StatusReport {
	basePath: string;
	installed: boolean;
	validIdentity: boolean;
	missingIdentityFiles: string[];
	files: StatusFile[];
	db: StatusDb;
	daemon: {
		running: boolean;
		pid: number | null;
		uptime: number | null;
		version: string | null;
	};
}

interface DoctorFinding {
	level: "error" | "warn" | "info";
	message: string;
	fix?: string;
}

function readCount(db: ReturnType<typeof Database>, sql: string): number | null {
	try {
		const raw = db.prepare(sql).get();
		if (!isRecord(raw)) {
			return null;
		}
		return parseIntegerValue(raw.count);
	} catch {
		return null;
	}
}

async function getStatusReport(basePath: string): Promise<StatusReport> {
	const existing = detectExistingSetup(basePath);
	const installed = existing.agentsDir;
	const files = [
		{ name: "AGENTS.md", exists: existing.agentsMd },
		{ name: "agent.yaml", exists: existing.agentYaml },
		{ name: "memories.db", exists: existing.memoryDb },
	];
	const daemon = await getDaemonStatus();
	const report: StatusReport = {
		basePath,
		installed,
		validIdentity: installed ? hasValidIdentity(basePath) : false,
		missingIdentityFiles: installed ? getMissingIdentityFiles(basePath) : [],
		files,
		db: {
			exists: existing.memoryDb,
			schema: null,
			needsMigration: false,
			memoryCount: null,
			conversationCount: null,
		},
		daemon,
	};

	if (!existing.memoryDb) {
		return report;
	}

	try {
		const db = Database(join(basePath, "memory", "memories.db"), {
			readonly: true,
		});
		const schema = detectSchema(db);
		const memoryCount = readCount(db, "SELECT COUNT(*) as count FROM memories");
		const conversationCount = schema.hasConversations
			? readCount(db, "SELECT COUNT(*) as count FROM conversations")
			: null;
		db.close();
		report.db = {
			exists: true,
			schema: schema.type,
			needsMigration: schema.type !== "core" && schema.type !== "unknown",
			memoryCount,
			conversationCount,
		};
	} catch {
		return report;
	}

	return report;
}

function getDoctorFindings(report: StatusReport): DoctorFinding[] {
	if (!report.installed) {
		return [
			{
				level: "error",
				message: "No Signet installation found.",
				fix: "Run `signet setup`.",
			},
		];
	}

	const findings: DoctorFinding[] = [];

	if (!report.validIdentity) {
		const missing = report.missingIdentityFiles.join(", ");
		findings.push({
			level: "error",
			message: `Missing required identity files${missing ? `: ${missing}` : "."}`,
			fix: "Run `signet setup` or restore the missing files.",
		});
	}

	if (!report.files.find((file) => file.name === "agent.yaml")?.exists) {
		findings.push({
			level: "error",
			message: "agent.yaml is missing.",
			fix: "Run `signet setup` to recreate the manifest.",
		});
	}

	if (!report.db.exists) {
		findings.push({
			level: "error",
			message: "Memory database is missing.",
			fix: "Run `signet setup` to initialize memory storage.",
		});
	}

	if (!report.daemon.running) {
		findings.push({
			level: "warn",
			message: "Daemon is not running.",
			fix: "Run `signet daemon start`.",
		});
	}

	if (report.db.needsMigration && report.db.schema) {
		findings.push({
			level: "warn",
			message: `Database is still on ${report.db.schema} schema.`,
			fix: "Run `signet migrate-schema`.",
		});
	}

	if (report.db.exists && report.db.memoryCount === 0) {
		findings.push({
			level: "info",
			message: "Memory database is empty.",
			fix: "Use `signet remember` or keep chatting so the daemon can build memory.",
		});
	}

	return findings;
}

async function showStatus(options: { path?: string; json?: boolean }) {
	const basePath = normalizeAgentPath(extractPathOption(options) ?? AGENTS_DIR);
	const report = await getStatusReport(basePath);

	if (options.json) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}

	console.log(signetLogo());

	if (!report.installed) {
		console.log(chalk.yellow("  No Signet installation found."));
		console.log(`  Run ${chalk.bold("signet setup")} to get started.`);
		return;
	}

	console.log(chalk.bold("  Status\n"));

	// Daemon status
	if (report.daemon.running) {
		const versionLabel = report.daemon.version && report.daemon.version !== "0.0.0" ? ` v${report.daemon.version}` : "";
		console.log(`  ${chalk.green("●")} Daemon ${chalk.green("running")}${chalk.dim(versionLabel)}`);
		console.log(chalk.dim(`    PID: ${report.daemon.pid}`));
		console.log(chalk.dim(`    Uptime: ${formatUptime(report.daemon.uptime || 0)}`));
		console.log(chalk.dim(`    Dashboard: http://localhost:${DEFAULT_PORT}`));
	} else {
		console.log(`  ${chalk.red("○")} Daemon ${chalk.red("stopped")}`);
	}

	console.log();

	// Files
	for (const file of report.files) {
		const icon = file.exists ? chalk.green("✓") : chalk.red("✗");
		console.log(`  ${icon} ${file.name}`);
	}

	if (report.db.needsMigration && report.db.schema) {
		console.log();
		console.log(chalk.yellow(`  ⚠ Database schema: ${report.db.schema}`));
		console.log(chalk.dim(`    Run ${chalk.bold("signet migrate-schema")} to upgrade`));
	}

	if (report.db.exists) {
		console.log();
		if (typeof report.db.memoryCount === "number") {
			console.log(chalk.dim(`  Memories: ${report.db.memoryCount}`));
		}
		if (typeof report.db.conversationCount === "number") {
			console.log(chalk.dim(`  Conversations: ${report.db.conversationCount}`));
		}
	}

	if (!report.validIdentity && report.missingIdentityFiles.length > 0) {
		console.log();
		console.log(chalk.yellow(`  Missing identity files: ${report.missingIdentityFiles.join(", ")}`));
	}

	console.log();
	console.log(chalk.dim(`  Path: ${report.basePath}`));
	console.log();
}

async function showDoctor(options: { path?: string; json?: boolean }) {
	const basePath = normalizeAgentPath(extractPathOption(options) ?? AGENTS_DIR);
	const report = await getStatusReport(basePath);
	const findings = getDoctorFindings(report);
	const ok = findings.every((finding) => finding.level !== "error");

	if (options.json) {
		console.log(JSON.stringify({ ok, report, findings }, null, 2));
		return;
	}

	console.log(signetLogo());
	console.log(chalk.bold("  Doctor\n"));

	if (findings.length === 0) {
		console.log(chalk.green("  ✓ Looks healthy"));
		console.log(chalk.dim("  No obvious local issues detected."));
		console.log();
		return;
	}

	for (const finding of findings) {
		const icon =
			finding.level === "error" ? chalk.red("✗") : finding.level === "warn" ? chalk.yellow("⚠") : chalk.cyan("•");
		console.log(`  ${icon} ${finding.message}`);
		if (finding.fix) {
			console.log(chalk.dim(`    ${finding.fix}`));
		}
	}

	console.log();
	if (ok) {
		console.log(chalk.yellow("  Signet can run, but there's a bit of duct tape showing."));
	} else {
		console.log(chalk.red("  Fix the errors above before trusting the CLI to behave."));
	}
	console.log();
}

// ============================================================================
// signet logs - Show Daemon Logs
// ============================================================================

interface LogEntry {
	timestamp: string;
	level: "debug" | "info" | "warn" | "error";
	category: string;
	message: string;
	data?: Record<string, unknown>;
	duration?: number;
	error?: { name: string; message: string; stack?: string };
}

function formatLogEntry(entry: LogEntry): string {
	const levelColors: Record<string, string> = {
		debug: chalk.gray,
		info: chalk.cyan,
		warn: chalk.yellow,
		error: chalk.red,
	};
	const colorFn = levelColors[entry.level] || chalk.white;

	const time = entry.timestamp.split("T")[1]?.slice(0, 8) || "";
	const level = entry.level.toUpperCase().padEnd(5);
	const category = `[${entry.category}]`.padEnd(12);

	let line = `${chalk.dim(time)} ${colorFn(level)} ${category} ${entry.message}`;

	if (entry.duration !== undefined) {
		line += chalk.dim(` (${entry.duration}ms)`);
	}

	if (entry.data && Object.keys(entry.data).length > 0) {
		line += chalk.dim(` ${JSON.stringify(entry.data)}`);
	}

	if (entry.error) {
		line += `\n  ${chalk.red(entry.error.name)}: ${entry.error.message}`;
	}

	return line;
}

async function showLogs(options: {
	lines?: string;
	follow?: boolean;
	level?: string;
	category?: string;
	path?: string;
}) {
	const limit = Number.parseInt(options.lines || "50", 10);
	const { follow, level, category } = options;
	const basePath = normalizeAgentPath(extractPathOption(options) ?? AGENTS_DIR);

	console.log(signetLogo());

	// Check if daemon is running
	const status = await getDaemonStatus();

	if (status.running) {
		// Fetch logs from API
		try {
			const params = new URLSearchParams({ limit: String(limit) });
			if (level) params.set("level", level);
			if (category) params.set("category", category);

			const res = await fetch(`http://localhost:${DEFAULT_PORT}/api/logs?${params}`);
			const data = await res.json();

			if (data.logs && data.logs.length > 0) {
				console.log(chalk.bold(`  Recent Logs (${data.count})\n`));
				for (const entry of data.logs) {
					console.log("  " + formatLogEntry(entry));
				}
			} else {
				console.log(chalk.dim("  No logs found"));
			}

			// Follow mode - stream logs
			if (follow) {
				console.log();
				console.log(chalk.dim("  Streaming logs... (Ctrl+C to stop)\n"));

				const eventSource = new EventSource(`http://localhost:${DEFAULT_PORT}/api/logs/stream`);

				eventSource.onmessage = (event) => {
					try {
						const entry = JSON.parse(event.data);
						if (entry.type === "connected") return;
						console.log("  " + formatLogEntry(entry));
					} catch {
						// Ignore parse errors
					}
				};

				eventSource.onerror = () => {
					console.log(chalk.red("  Stream disconnected"));
					eventSource.close();
				};

				// Keep process alive
				await new Promise(() => {});
			}
		} catch (e) {
			console.log(chalk.yellow("  Could not fetch logs from daemon"));
			fallbackToFile();
		}
	} else {
		console.log(chalk.yellow("  Daemon not running - reading from log files\n"));
		fallbackToFile();
	}

	function fallbackToFile() {
		// Fall back to reading log files directly
		const logDir = join(basePath, ".daemon", "logs");
		const logFile = join(logDir, `signet-${new Date().toISOString().split("T")[0]}.log`);

		if (!existsSync(logFile)) {
			console.log(chalk.dim("  No log files found"));
			return;
		}

		const content = readFileSync(logFile, "utf-8");
		const lines = content.trim().split("\n").slice(-limit);

		for (const line of lines) {
			try {
				const entry = JSON.parse(line) as LogEntry;
				if (level && entry.level !== level) continue;
				if (category && entry.category !== category) continue;
				console.log("  " + formatLogEntry(entry));
			} catch {
				// Not JSON, print raw
				console.log("  " + line);
			}
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

// Daemon action handlers (shared between top-level and subcommand)
async function doStart(options: { path?: string } = {}) {
	console.log(signetLogo());
	const basePath = normalizeAgentPath(extractPathOption(options) ?? AGENTS_DIR);

	const running = await isDaemonRunning();
	if (running) {
		console.log(chalk.yellow("  Daemon is already running"));
		return;
	}

	const spinner = ora("Starting daemon...").start();
	const started = await startDaemon(basePath);

	if (started) {
		spinner.succeed("Daemon started");
		console.log(chalk.dim(`  Dashboard: http://localhost:${DEFAULT_PORT}`));
	} else {
		spinner.fail("Failed to start daemon");
	}
}

async function doStop(options: { path?: string } = {}) {
	console.log(signetLogo());
	const basePath = normalizeAgentPath(extractPathOption(options) ?? AGENTS_DIR);

	const running = await isDaemonRunning();
	if (!running) {
		console.log(chalk.yellow("  Daemon is not running"));
		return;
	}

	const spinner = ora("Stopping daemon...").start();
	const stopped = await stopDaemon(basePath);

	if (stopped) {
		spinner.succeed("Daemon stopped");
	} else {
		spinner.fail("Failed to stop daemon");
	}
}

function isOpenClawDetected(): boolean {
	const connector = new OpenClawConnector();
	return connector.getDiscoveredConfigPaths().length > 0;
}

async function restartOpenClaw(basePath: string): Promise<boolean> {
	const yamlPath = join(basePath, "agent.yaml");
	let restartCommand: string | undefined;

	try {
		const yaml = readFileSync(yamlPath, "utf-8");
		const config = parseSimpleYaml(yaml);
		restartCommand = config.services?.openclaw?.restart_command;
	} catch {
		// agent.yaml missing or unparseable
	}

	if (!restartCommand) {
		console.log();
		console.log(chalk.yellow("  No OpenClaw restart command configured."));
		console.log(chalk.dim("  Add to ~/.agents/agent.yaml:"));
		console.log(chalk.dim("    services:"));
		console.log(chalk.dim("      openclaw:"));
		console.log(chalk.dim('        restart_command: "systemctl --user restart openclaw"'));
		return false;
	}

	// Parse command into argv to avoid sh -c shell injection.
	// agent.yaml is user-controlled — a tampered file could inject
	// arbitrary commands if passed directly to a shell wrapper.
	const argv = restartCommand.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
	if (!argv || argv.length === 0) {
		console.log(chalk.red("  Invalid restart command"));
		return false;
	}
	// Strip surrounding quotes from each arg
	const cmd = argv.map((a: string) => a.replace(/^["']|["']$/g, ""));

	const spinner = ora("Restarting OpenClaw...").start();
	try {
		const result = spawnSync(cmd[0], cmd.slice(1), {
			timeout: 15_000,
			stdio: "pipe",
			windowsHide: true,
		});
		if (result.status === 0) {
			spinner.succeed("OpenClaw restarted");
			return true;
		}
		const stderr = result.stderr?.toString().trim();
		spinner.fail(`OpenClaw restart failed${stderr ? `: ${stderr}` : ""}`);
		return false;
	} catch {
		spinner.fail("OpenClaw restart timed out");
		return false;
	}
}

async function doRestart(options: { path?: string; openclaw?: boolean } = {}) {
	console.log(signetLogo());
	const basePath = normalizeAgentPath(extractPathOption(options) ?? AGENTS_DIR);

	const spinner = ora("Restarting daemon...").start();
	await stopDaemon(basePath);
	await new Promise((resolve) => setTimeout(resolve, 500));
	const started = await startDaemon(basePath);

	if (started) {
		spinner.succeed("Daemon restarted");
		console.log(chalk.dim(`  Dashboard: http://localhost:${DEFAULT_PORT}`));
	} else {
		spinner.fail("Failed to restart daemon");
	}

	if (options.openclaw !== false && isOpenClawDetected()) {
		const shouldRestart = await confirm({
			message: "Restart connected OpenClaw instance?",
			default: false,
		});
		if (shouldRestart) {
			await restartOpenClaw(basePath);
		}
	}
}

registerAppCommands(program, {
	collectListOption,
	configureAgent,
	launchDashboard,
	migrateSchema,
	setupWizard,
	showDoctor,
	showStatus,
	syncTemplates,
});

registerDaemonCommands(program, {
	doRestart,
	doStart,
	doStop,
	showLogs,
	showStatus,
});

async function syncTemplates() {
	console.log(signetLogo());
	const basePath = AGENTS_DIR;
	const templatesDir = getTemplatesDir();

	if (!existsSync(basePath)) {
		console.log(chalk.red("  No Signet installation found. Run: signet setup"));
		return;
	}

	console.log(chalk.bold("  Syncing template files...\n"));

	let synced = 0;

	const gitignoreSrc = join(templatesDir, "gitignore.template");
	const gitignoreDest = join(basePath, ".gitignore");
	if (existsSync(gitignoreSrc) && !existsSync(gitignoreDest)) {
		copyFileSync(gitignoreSrc, gitignoreDest);
		console.log(chalk.green("  ✓ .gitignore"));
		synced++;
	}

	const skillSyncResult = syncBuiltinSkills(templatesDir, basePath);
	for (const skill of skillSyncResult.installed) {
		console.log(chalk.green(`  ✓ skills/${skill} (installed)`));
	}
	for (const skill of skillSyncResult.updated) {
		console.log(chalk.green(`  ✓ skills/${skill} (updated)`));
	}
	synced += skillSyncResult.installed.length + skillSyncResult.updated.length;

	const predictor = await syncPredictorBinary(basePath);
	if (predictor.status === "updated") {
		console.log(chalk.green(`  ✓ predictor sidecar (${predictor.message})`));
		synced++;
	} else if (predictor.status === "current") {
		console.log(chalk.dim("  predictor sidecar is up to date"));
	} else if (predictor.status === "skipped") {
		console.log(chalk.dim(`  predictor sidecar skipped: ${predictor.message}`));
	} else {
		console.log(chalk.yellow(`  ⚠ predictor sidecar sync failed: ${predictor.message}`));
	}

	const native = await syncNativeEmbeddingModel(basePath);
	if (native.status === "updated") {
		console.log(chalk.green(`  ✓ native embedding model warmed (${native.message})`));
		synced++;
	} else if (native.status === "current") {
		console.log(chalk.dim("  native embedding model is ready"));
	} else if (native.status === "skipped") {
		console.log(chalk.dim(`  native embedding warmup skipped: ${native.message}`));
	} else {
		console.log(chalk.yellow(`  ⚠ native embedding warmup failed: ${native.message}`));
	}

	const detectedHarnesses: string[] = [];
	if (existsSync(join(homedir(), ".claude", "settings.json"))) {
		detectedHarnesses.push("claude-code");
	}
	if (
		existsSync(join(homedir(), ".config", "signet", "bin", "codex")) ||
		existsSync(join(homedir(), ".codex", "config.toml"))
	) {
		detectedHarnesses.push("codex");
	}
	if (existsSync(join(homedir(), ".config", "opencode"))) {
		detectedHarnesses.push("opencode");
	}
	const ocConnector = new OpenClawConnector();
	if (ocConnector.isInstalled()) {
		detectedHarnesses.push("openclaw");
	}

	for (const harness of detectedHarnesses) {
		try {
			await configureHarnessHooks(harness, basePath);
			console.log(chalk.green(`  ✓ hooks re-registered for ${harness}`));
			synced++;
		} catch {
			console.log(chalk.yellow(`  ⚠ hooks re-registration failed for ${harness}`));
		}
	}

	if (synced === 0) {
		console.log(chalk.dim("  All built-in templates are up to date"));
	}

	console.log();
	console.log(chalk.green("  Done!"));
}

async function configureAgent() {
	console.log(signetLogo());

	const agentYamlPath = join(AGENTS_DIR, "agent.yaml");
	if (!existsSync(agentYamlPath)) {
		console.log(chalk.yellow("  No agent.yaml found. Run `signet setup` first."));
		return;
	}

	const existingYaml = readFileSync(agentYamlPath, "utf-8");
	const getYamlValue = (key: string, fallback: string) => {
		const match = existingYaml.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "m"));
		return match ? match[1].trim().replace(/^["']|["']$/g, "") : fallback;
	};

	console.log(chalk.bold("  Configure your agent\n"));

	while (true) {
		const section = await select({
			message: "What would you like to configure?",
			choices: [
				{ value: "agent", name: "👤 Agent identity (name, description)" },
				{ value: "harnesses", name: "[link] Harnesses (AI platforms)" },
				{ value: "embedding", name: "🧠 Embedding provider" },
				{ value: "search", name: "🔍 Search settings" },
				{ value: "memory", name: "💾 Memory settings" },
				{ value: "view", name: "📄 View current config" },
				{ value: "done", name: "✓ Done" },
			],
		});

		if (section === "done") break;

		console.log();

		if (section === "view") {
			console.log(chalk.dim("  Current agent.yaml:\n"));
			console.log(
				existingYaml
					.split("\n")
					.map((line) => chalk.dim(`  ${line}`))
					.join("\n"),
			);
			console.log();
			continue;
		}

		if (section === "agent") {
			const name = await input({
				message: "Agent name:",
				default: getYamlValue("name", "My Agent"),
			});
			const description = await input({
				message: "Description:",
				default: getYamlValue("description", "Personal AI assistant"),
			});

			let updatedYaml = existingYaml;
			updatedYaml = updatedYaml.replace(/^(\s*name:)\s*.+$/m, `$1 "${name}"`);
			updatedYaml = updatedYaml.replace(/^(\s*description:)\s*.+$/m, `$1 "${description}"`);
			updatedYaml = updatedYaml.replace(/^(\s*updated:)\s*.+$/m, `$1 "${new Date().toISOString()}"`);

			writeFileSync(agentYamlPath, updatedYaml);
			console.log(chalk.green("  ✓ Agent identity updated"));
		}

		if (section === "harnesses") {
			const harnesses = await checkbox({
				message: "Select AI platforms:",
				choices: [
					{ value: "claude-code", name: "Claude Code" },
					{ value: "codex", name: "Codex" },
					{ value: "opencode", name: "OpenCode" },
					{ value: "openclaw", name: "OpenClaw" },
					{ value: "cursor", name: "Cursor" },
					{ value: "windsurf", name: "Windsurf" },
				],
			});

			const harnessYaml = harnesses.map((harness) => `  - ${harness}`).join("\n");
			const updatedYaml = existingYaml.replace(/^harnesses:\n( {2}- .+\n)+/m, `harnesses:\n${harnessYaml}\n`);

			writeFileSync(agentYamlPath, updatedYaml);
			console.log(chalk.green("  ✓ Harnesses updated"));

			const regen = await confirm({
				message: "Regenerate harness hook configurations?",
				default: true,
			});

			if (regen) {
				for (const harness of harnesses) {
					try {
						await configureHarnessHooks(harness, AGENTS_DIR);
						console.log(chalk.dim(`    ✓ ${harness}`));
					} catch {
						console.log(chalk.yellow(`    ⚠ ${harness} failed`));
					}
				}
			}
		}

		if (section === "embedding") {
			const provider = await select({
				message: "Embedding provider:",
				choices: [
					{ value: "ollama", name: "Ollama (local)" },
					{ value: "openai", name: "OpenAI API" },
					{ value: "none", name: "Disable embeddings" },
				],
			});

			if (provider !== "none") {
				let model = "nomic-embed-text";
				let dimensions = 768;

				if (provider === "ollama") {
					const selected = await select({
						message: "Model:",
						choices: [
							{ value: "nomic-embed-text", name: "nomic-embed-text (768d)" },
							{ value: "all-minilm", name: "all-minilm (384d)" },
							{ value: "mxbai-embed-large", name: "mxbai-embed-large (1024d)" },
						],
					});
					model = selected;
					dimensions = selected === "all-minilm" ? 384 : selected === "mxbai-embed-large" ? 1024 : 768;
				} else {
					const selected = await select({
						message: "Model:",
						choices: [
							{ value: "text-embedding-3-small", name: "text-embedding-3-small (1536d)" },
							{ value: "text-embedding-3-large", name: "text-embedding-3-large (3072d)" },
						],
					});
					model = selected;
					dimensions = selected === "text-embedding-3-large" ? 3072 : 1536;
				}

				let updatedYaml = existingYaml;
				if (existingYaml.includes("embedding:")) {
					updatedYaml = updatedYaml.replace(
						/^embedding:\n( {2}.+\n)+/m,
						`embedding:\n  provider: ${provider}\n  model: ${model}\n  dimensions: ${dimensions}\n`,
					);
				} else {
					updatedYaml = updatedYaml.replace(
						/^(harnesses:\n( {2}- .+\n)+)/m,
						`$1\nembedding:\n  provider: ${provider}\n  model: ${model}\n  dimensions: ${dimensions}\n`,
					);
				}
				writeFileSync(agentYamlPath, updatedYaml);
			}

			console.log(chalk.green("  ✓ Embedding settings updated"));
		}

		if (section === "search") {
			const alpha = await select({
				message: "Search balance:",
				choices: [
					{ value: "0.7", name: "Balanced (70% semantic, 30% keyword)" },
					{ value: "0.9", name: "Semantic-heavy (90/10)" },
					{ value: "0.5", name: "Equal (50/50)" },
					{ value: "0.3", name: "Keyword-heavy (30/70)" },
				],
			});

			const topK = await input({
				message: "Candidates per source (top_k):",
				default: getYamlValue("top_k", "20"),
			});

			const minScore = await input({
				message: "Minimum score threshold:",
				default: getYamlValue("min_score", "0.3"),
			});

			let updatedYaml = existingYaml;
			updatedYaml = updatedYaml.replace(/^(\s*alpha:)\s*.+$/m, `$1 ${alpha}`);
			updatedYaml = updatedYaml.replace(/^(\s*top_k:)\s*.+$/m, `$1 ${topK}`);
			updatedYaml = updatedYaml.replace(/^(\s*min_score:)\s*.+$/m, `$1 ${minScore}`);

			writeFileSync(agentYamlPath, updatedYaml);
			console.log(chalk.green("  ✓ Search settings updated"));
		}

		if (section === "memory") {
			const sessionBudget = await input({
				message: "Session context budget (characters):",
				default: getYamlValue("session_budget", "2000"),
			});

			const decayRate = await input({
				message: "Importance decay rate per day (0-1):",
				default: getYamlValue("decay_rate", "0.95"),
			});

			let updatedYaml = existingYaml;
			updatedYaml = updatedYaml.replace(/^(\s*session_budget:)\s*.+$/m, `$1 ${sessionBudget}`);
			updatedYaml = updatedYaml.replace(/^(\s*decay_rate:)\s*.+$/m, `$1 ${decayRate}`);

			writeFileSync(agentYamlPath, updatedYaml);
			console.log(chalk.green("  ✓ Memory settings updated"));
		}

		console.log();
	}

	console.log(chalk.dim("  Configuration saved to agent.yaml"));
	console.log();
}

// ============================================================================
// signet secret - Secrets management
// ============================================================================

const DAEMON_URL = `http://localhost:${DEFAULT_PORT}`;

async function secretApiCall(
	method: string,
	path: string,
	body?: unknown,
	timeoutMs = 5_000,
): Promise<{ ok: boolean; data: unknown }> {
	const res = await fetch(`${DAEMON_URL}${path}`, {
		method,
		headers: body ? { "Content-Type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		data = { error: text || "Request failed" };
	}
	return { ok: res.ok, data };
}

async function ensureDaemonForSecrets(): Promise<boolean> {
	const running = await isDaemonRunning();
	if (!running) {
		console.error(chalk.red("  Daemon is not running. Start it with: signet start"));
		return false;
	}
	return true;
}

async function fetchFromDaemon<T>(path: string, opts?: RequestInit & { timeout?: number }): Promise<T | null> {
	const { timeout: timeoutMs, ...fetchOpts } = opts || {};
	try {
		const res = await fetch(`http://localhost:${DEFAULT_PORT}${path}`, {
			signal: AbortSignal.timeout(timeoutMs || 5000),
			...fetchOpts,
		});
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}
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
	const report = await getStatusReport(AGENTS_DIR);
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
