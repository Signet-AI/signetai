#!/usr/bin/env node
/**
 * Signet CLI
 * Own your agent. Bring it anywhere.
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { input, select, confirm, checkbox, password } from "@inquirer/prompts";
import { spawn, spawnSync } from "child_process";
import { homedir, platform } from "os";
import { join, dirname } from "path";
import {
	existsSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	copyFileSync,
	readdirSync,
	rmSync,
	statSync,
	lstatSync,
} from "fs";
import { fileURLToPath } from "url";
import Database from "./sqlite.js";
import open from "open";
import {
	detectSystemPython,
	detectPyenv,
	detectConda,
	detectBestPython,
	isZvecCompatible,
	getPyenvPython,
	createVenv,
	installDeps,
	installPyenvPython,
	createCondaEnv,
	getCondaPython,
	checkZvecInstalled,
	type PythonInfo,
	type PyenvInfo,
	type CondaInfo,
} from "./python.js";
import {
	detectExistingSetup as detectExistingSetupCore,
	hasValidIdentity,
	getMissingIdentityFiles,
	unifySkills,
	importMemoryLogs,
	IDENTITY_FILES,
	detectSchema,
	ensureUnifiedSchema,
	runMigrations,
	loadSqliteVec,
	parseSimpleYaml,
	formatYaml,
	symlinkSkills,
	resolvePrimaryPackageManager,
	getSkillsRunnerCommand,
	type SetupDetection,
	type SkillsResult,
	type ImportResult,
	type SchemaInfo,
	type MigrationResult,
} from "@signet/core";
import { OpenClawConnector } from "@signet/connector-openclaw";
import { ClaudeCodeConnector } from "@signet/connector-claude-code";
import { OpenCodeConnector } from "@signet/connector-opencode";

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

	const entries = readdirSync(skillsSource, { withFileTypes: true }).filter(
		(d) => d.isDirectory(),
	);

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
		const proc = spawn("git", ["init"], { cwd: dir, stdio: "pipe" });
		proc.on("close", (code) => resolve(code === 0));
		proc.on("error", () => resolve(false));
	});
}

async function gitAddAndCommit(dir: string, message: string): Promise<boolean> {
	return new Promise((resolve) => {
		// First, git add -A
		const add = spawn("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
		add.on("close", (addCode) => {
			if (addCode !== 0) {
				resolve(false);
				return;
			}
			// Check if there are changes to commit
			const status = spawn("git", ["status", "--porcelain"], {
				cwd: dir,
				stdio: "pipe",
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
				});
				commit.on("close", (commitCode) => resolve(commitCode === 0));
				commit.on("error", () => resolve(false));
			});
			status.on("error", () => resolve(false));
		});
		add.on("error", () => resolve(false));
	});
}

async function gitAutoCommit(
	dir: string,
	changedFile: string,
): Promise<boolean> {
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
const DAEMON_DIR = join(AGENTS_DIR, ".daemon");
const PID_FILE = join(DAEMON_DIR, "pid");
const LOG_DIR = join(DAEMON_DIR, "logs");
const DEFAULT_PORT = 3850;
const LOCAL_TOKEN_FILE = join(DAEMON_DIR, "local.token");

/** Read the local auth token for daemon API calls. */
function getLocalToken(): string | null {
	try {
		return readFileSync(LOCAL_TOKEN_FILE, "utf-8").trim();
	} catch {
		return null;
	}
}

/** Build auth headers for daemon API requests. */
function daemonAuthHeaders(): Record<string, string> {
	const token = getLocalToken();
	if (token) return { "X-Local-Token": token };
	return {};
}

async function isDaemonRunning(): Promise<boolean> {
	try {
		const response = await fetch(`http://localhost:${DEFAULT_PORT}/health`, {
			signal: AbortSignal.timeout(2000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

async function getDaemonStatus(): Promise<{
	running: boolean;
	pid: number | null;
	uptime: number | null;
	version: string | null;
}> {
	try {
		const response = await fetch(
			`http://localhost:${DEFAULT_PORT}/api/status`,
			{
				signal: AbortSignal.timeout(2000),
			},
		);
		if (response.ok) {
			const data = (await response.json()) as {
				pid?: number;
				uptime?: number;
				version?: string;
			};
			return {
				running: true,
				pid: data.pid ?? null,
				uptime: data.uptime ?? null,
				version: data.version ?? null,
			};
		}
	} catch {
		// Not running
	}

	return { running: false, pid: null, uptime: null, version: null };
}

async function startDaemon(): Promise<boolean> {
	mkdirSync(DAEMON_DIR, { recursive: true });
	mkdirSync(LOG_DIR, { recursive: true });

	// Find daemon script (check multiple locations for dev vs published package)
	const daemonLocations = [
		join(__dirname, "daemon.js"), // published: dist/daemon.js (same dir as cli.js)
		join(__dirname, "..", "..", "daemon", "src", "daemon.ts"), // dev: packages/daemon/src/daemon.ts
		join(__dirname, "..", "..", "daemon", "dist", "daemon.js"), // dev built: packages/daemon/dist/daemon.js
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

	const outLog = join(LOG_DIR, "daemon.out.log");
	const errLog = join(LOG_DIR, "daemon.err.log");

	const proc = spawn(runtime, [daemonPath], {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			SIGNET_PORT: DEFAULT_PORT.toString(),
			SIGNET_PATH: AGENTS_DIR,
		},
	});

	// Write logs to files
	const fs = await import("fs");
	const out = fs.createWriteStream(outLog, { flags: "a" });
	const err = fs.createWriteStream(errLog, { flags: "a" });
	proc.stdout?.pipe(out);
	proc.stderr?.pipe(err);

	proc.unref();

	// Wait for daemon to be ready
	for (let i = 0; i < 20; i++) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		if (await isDaemonRunning()) {
			return true;
		}
	}

	return false;
}

async function stopDaemon(): Promise<boolean> {
	// Try graceful shutdown via PID
	if (existsSync(PID_FILE)) {
		try {
			const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
			process.kill(pid, "SIGTERM");

			// Wait for shutdown
			for (let i = 0; i < 20; i++) {
				await new Promise((resolve) => setTimeout(resolve, 250));
				try {
					process.kill(pid, 0);
				} catch {
					// Process is dead
					return true;
				}
			}

			// Force kill
			process.kill(pid, "SIGKILL");
			return true;
		} catch {
			// Process might already be dead
		}
	}

	return !(await isDaemonRunning());
}

function formatUptime(seconds: number): string {
	if (seconds < 60) return `${Math.floor(seconds)}s`;
	if (seconds < 3600)
		return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
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
		case "opencode": {
			const connector = new OpenCodeConnector();
			await connector.install(basePath);
			break;
		}
		case "openclaw": {
			const connector = new OpenClawConnector();
			await connector.install(basePath, {
				configureWorkspace: options?.configureOpenClawWorkspace ?? false,
				runtimePath: options?.openclawRuntimePath ?? "legacy",
			});
			break;
		}
	}
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

/**
 * Check if the detected setup has significant existing identity files
 * that should trigger the migration flow
 */
function hasExistingIdentityFiles(detection: SetupDetection): boolean {
	// Check for core identity files (non-optional ones)
	const coreFiles = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];
	const foundCore = detection.identityFiles.filter((f) =>
		coreFiles.includes(f),
	);
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
		lines.push(
			`    ${chalk.dim("•")} ${detection.memoryLogCount} files in memory/`,
		);
	}

	if (detection.hasClawdhub) {
		lines.push(`  ${chalk.cyan("OpenClaw registry:")}`);
		lines.push(`    ${chalk.dim("•")} .clawdhub/lock.json found`);
	}

	const installedHarnesses: string[] = [];
	if (detection.harnesses.claudeCode) installedHarnesses.push("Claude Code");
	if (detection.harnesses.openclaw) installedHarnesses.push("OpenClaw");
	if (detection.harnesses.opencode) installedHarnesses.push("OpenCode");

	if (installedHarnesses.length > 0) {
		lines.push(`  ${chalk.cyan("Installed harnesses:")}`);
		lines.push(`    ${chalk.dim("•")} ${installedHarnesses.join(", ")}`);
	}

	return lines.join("\n");
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
		const result = spawnSync(command, ["--version"], { stdio: "ignore" });
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
		const result = await runCommandWithOutput(
			"sh",
			["-c", "curl -fsSL https://ollama.com/install.sh | sh"],
			{
				env: { ...process.env },
				timeout: 300000,
			},
		);

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

	console.log(
		chalk.yellow("  Automated install is not available on this platform."),
	);
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

		const models = (data.models ?? [])
			.map((m) => m.name?.trim())
			.filter((m): m is string => Boolean(m));

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
	return models.some(
		(entry) => entry === model || entry.startsWith(`${model}:`),
	);
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

async function promptOllamaFailureFallback(): Promise<
	"retry" | "openai" | "none"
> {
	console.log();
	return select({
		message: "How do you want to continue?",
		choices: [
			{ value: "retry", name: "Retry Ollama checks" },
			{ value: "openai", name: "Switch to OpenAI" },
			{ value: "none", name: "Continue without embeddings" },
		],
	});
}

async function preflightOllamaEmbedding(model: string): Promise<{
	provider: "ollama" | "openai" | "none";
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
		console.log(
			chalk.dim(
				`    PID: ${status.pid} | Uptime: ${formatUptime(status.uptime || 0)}`,
			),
		);
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

			case "restart":
				const spinner = ora("Restarting daemon...").start();
				await stopDaemon();
				const restarted = await startDaemon();
				if (restarted) {
					spinner.succeed("Daemon restarted");
				} else {
					spinner.fail("Failed to restart daemon");
				}
				await input({ message: "Press Enter to continue..." });
				break;

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
			const { ok, data } = await secretApiCall(
				"DELETE",
				`/api/secrets/${name}`,
			);
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
			console.warn(
				`\n  ⚠ Could not configure ${harness}: ${(err as Error).message}`,
			);
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
			copyFileSync(
				requirementsSource,
				join(basePath, "memory", "requirements.txt"),
			);
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
		const packageManager = resolvePrimaryPackageManager({
			agentsDir: basePath,
			env: process.env,
		});

		const config: Record<string, unknown> = {
			version: 1,
			schema: "signet/v1",
			agent: {
				name: agentName,
				description:
					existingConfig.description ||
					existingConfig.agent?.description ||
					"Personal AI assistant",
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

		// Only write agent.yaml if it doesn't exist
		if (!existsSync(join(basePath, "agent.yaml"))) {
			writeFileSync(join(basePath, "agent.yaml"), formatYaml(config));
		}

		// 3. Initialize SQLite database with unified schema
		spinner.text = "Initializing database...";
		const dbPath = join(basePath, "memory", "memories.db");
		const db = new Database(dbPath);

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
						stmt.run(
							id,
							mem.content,
							mem.type,
							mem.sourceType,
							JSON.stringify(mem.tags),
						);
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
			console.warn(
				`\n  ⚠ Skills unification warning: ${(err as Error).message}`,
			);
		}

		// 6. Install connectors for detected harnesses
		spinner.text = "Configuring harness connectors...";
		const configuredHarnesses: string[] = [];

		for (const harness of detectedHarnesses) {
			try {
				await configureHarnessHooks(harness, basePath);
				configuredHarnesses.push(harness);
			} catch (err) {
				console.warn(
					`\n  ⚠ Could not configure ${harness}: ${(err as Error).message}`,
				);
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
		if (!isGitRepo(basePath)) {
			spinner.text = "Initializing git...";
			gitEnabled = await gitInit(basePath);
		} else {
			gitEnabled = true;
		}

		// 9. Start the daemon
		spinner.text = "Starting daemon...";
		const daemonStarted = await startDaemon();

		spinner.succeed(chalk.green("Signet setup complete!"));

		// Summary output
		console.log();
		console.log(
			chalk.dim("  Your existing identity files are now managed by Signet."),
		);
		console.log(chalk.dim(`    ${basePath}`));
		console.log();

		// Show what was done
		if (importResult && importResult.imported > 0) {
			console.log(
				chalk.dim(`  Memory logs imported: ${importResult.imported} entries`),
			);
			if (importResult.skipped > 0) {
				console.log(chalk.dim(`    (${importResult.skipped} skipped)`));
			}
		}

		if (
			skillsResult &&
			(skillsResult.imported > 0 || skillsResult.symlinked > 0)
		) {
			console.log(
				chalk.dim(
					`  Skills unified: ${skillsResult.imported} imported, ${skillsResult.symlinked} symlinked`,
				),
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
			console.log(
				chalk.green(`  ● Daemon running at http://localhost:${DEFAULT_PORT}`),
			);
		}

		// Git commit
		if (gitEnabled) {
			const date = new Date().toISOString().split("T")[0];
			const committed = await gitAddAndCommit(basePath, `${date}_signet-setup`);
			if (committed) {
				console.log(chalk.dim("  ✓ Changes committed to git"));
			}
		}

		console.log();

		const launchNow = await confirm({
			message: "Open the dashboard?",
			default: true,
		});

		if (launchNow) {
			await open(`http://localhost:${DEFAULT_PORT}`);
		}

		// Suggest onboarding
		console.log();
		console.log(
			chalk.cyan(
				"  → Next step: Say '/onboarding' to personalize your agent",
			),
		);
		console.log(
			chalk.dim(
				"    This will walk you through setting up your agent's personality,",
			),
		);
		console.log(
			chalk.dim(
				"    communication style, and your preferences.",
			),
		);
	} catch (err) {
		spinner.fail(chalk.red("Setup failed"));
		console.error(err);
		process.exit(1);
	}
}

// ============================================================================
// signet setup - Interactive Setup Wizard
// ============================================================================

async function setupWizard(options: { path?: string }) {
	console.log(signetLogo());
	console.log();

	const basePath = options.path || AGENTS_DIR;
	const existing = detectExistingSetup(basePath);

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
	const existingName =
		existingConfig.name || existingConfig.agent?.name || "My Agent";
	const existingDesc =
		existingConfig.description ||
		existingConfig.agent?.description ||
		"Personal AI assistant";
	const existingHarnesses: string[] = existingConfig.harnesses
		? typeof existingConfig.harnesses === "string"
			? existingConfig.harnesses.split(",").map((s: string) => s.trim())
			: []
		: [];
	const existingEmbedding = existingConfig.embedding || {};
	const existingSearch = existingConfig.search || {};

	// Check for existing Signet installation with database
	if (existing.agentsDir && existing.memoryDb) {
		console.log(chalk.green("  ✓ Existing Signet installation detected"));
		console.log(chalk.dim(`    ${basePath}`));
		console.log();

		const action = await select({
			message: "What would you like to do?",
			choices: [
				{ value: "dashboard", name: "Launch dashboard" },
				{ value: "migrate", name: "Import memories from another platform" },
				{ value: "github-import", name: "Import agent config from GitHub" },
				{ value: "reconfigure", name: "Reconfigure settings" },
				{ value: "status", name: "View status" },
				{ value: "exit", name: "Exit" },
			],
		});

		if (action === "dashboard") {
			await launchDashboard({});
			return;
		} else if (action === "migrate") {
			await migrateWizard(basePath);
			return;
		} else if (action === "github-import") {
			await importFromGitHub(basePath);
			return;
		} else if (action === "status") {
			await showStatus({ path: basePath });
			return;
		} else if (action === "exit") {
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
		const syncedBuiltins =
			skillSyncResult.installed.length + skillSyncResult.updated.length;
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
		console.log(
			chalk.dim(
				"    1. Create AGENT.yaml manifest pointing to your existing files",
			),
		);
		console.log(chalk.dim("    2. Import memory logs to SQLite for search"));
		console.log(
			chalk.dim("    3. Sync built-in skills + unify external skill sources"),
		);
		console.log(chalk.dim("    4. Install connectors for detected harnesses"));
		console.log(chalk.dim("    5. Keep all existing files unchanged"));
		console.log();

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
		const setupMethod = await select({
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

	const agentName = await input({
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
			value: "opencode",
			name: "OpenCode",
			checked: existingHarnesses.includes("opencode"),
		},
		{
			value: "openclaw",
			name: "OpenClaw",
			checked: existingHarnesses.includes("openclaw"),
		},
		{
			value: "cursor",
			name: "Cursor",
			checked: existingHarnesses.includes("cursor"),
		},
		{
			value: "windsurf",
			name: "Windsurf",
			checked: existingHarnesses.includes("windsurf"),
		},
		{
			value: "chatgpt",
			name: "ChatGPT",
			checked: existingHarnesses.includes("chatgpt"),
		},
		{
			value: "gemini",
			name: "Gemini",
			checked: existingHarnesses.includes("gemini"),
		},
	];

	console.log();
	const harnesses = await checkbox({
		message: "Which AI platforms do you use?",
		choices: harnessChoices,
	});

	// OpenClaw configuration (handles openclaw/clawdbot/moltbot)
	let configureOpenClawWs = false;
	let openclawRuntimePath: "plugin" | "legacy" = "plugin";
	if (harnesses.includes("openclaw")) {
		const connector = new OpenClawConnector();
		const existingConfigs = connector.getDiscoveredConfigPaths();

		if (existingConfigs.length > 0) {
			console.log();
			configureOpenClawWs = await confirm({
				message: `Set OpenClaw workspace to ~/.agents in ${existingConfigs.length} config file(s)?`,
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
					description:
						"@signetai/signet-memory-openclaw — full lifecycle + memory tools",
				},
				{
					value: "legacy" as const,
					name: "Legacy hooks",
					description:
						"handler.js for /remember, /recall, /context commands",
				},
			],
			default: "plugin",
		})) as "plugin" | "legacy";
	}

	console.log();
	const agentDescription = await input({
		message: "Short description of your agent:",
		default: existingDesc,
	});

	console.log();
	let embeddingProvider = (await select({
		message: "How should memories be embedded for search?",
		choices: [
			{ value: "ollama", name: "Ollama (local, recommended)" },
			{ value: "openai", name: "OpenAI API" },
			{ value: "none", name: "Skip embeddings for now" },
		],
	})) as "ollama" | "openai" | "none";

	// Embedding model selection based on provider
	let embeddingModel = "nomic-embed-text";
	let embeddingDimensions = 768;

	if (embeddingProvider === "ollama") {
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
	} else if (embeddingProvider === "openai") {
		const openai = await promptOpenAIEmbeddingModel();
		embeddingModel = openai.model;
		embeddingDimensions = openai.dimensions;
	}

	// Search settings
	console.log();
	const searchBalance = await select({
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

	// Memory pipeline provider
	console.log();
	const extractionProvider = (await select({
		message: "Memory extraction provider (analyzes conversations):",
		choices: [
			{
				value: "claude-code",
				name: "Claude Code (uses your Claude subscription via CLI)",
			},
			{
				value: "ollama",
				name: "Ollama (local, requires running Ollama server)",
			},
			{ value: "none", name: "Skip extraction pipeline" },
		],
	})) as "claude-code" | "ollama" | "none";

	let extractionModel = "haiku";
	if (extractionProvider === "claude-code") {
		console.log();
		extractionModel = (await select({
			message: "Which Claude model for extraction?",
			choices: [
				{ value: "haiku", name: "Haiku (fast, cheap, recommended)" },
				{ value: "sonnet", name: "Sonnet (better quality, slower)" },
			],
		})) as string;
	} else if (extractionProvider === "ollama") {
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

	// Advanced settings (optional)
	console.log();
	const wantAdvanced = await confirm({
		message: "Configure advanced settings?",
		default: false,
	});

	let searchTopK = 20;
	let searchMinScore = 0.3;
	let memorySessionBudget = 2000;
	let memoryDecayRate = 0.95;

	if (wantAdvanced) {
		console.log();
		console.log(chalk.dim("  Advanced settings:\n"));

		const topKInput = await input({
			message: "Search candidates per source (top_k):",
			default: "20",
		});
		searchTopK = parseInt(topKInput, 10) || 20;

		const minScoreInput = await input({
			message: "Minimum search score threshold (0-1):",
			default: "0.3",
		});
		searchMinScore = parseFloat(minScoreInput) || 0.3;

		const budgetInput = await input({
			message: "Session context budget (characters):",
			default: "2000",
		});
		memorySessionBudget = parseInt(budgetInput, 10) || 2000;

		const decayInput = await input({
			message: "Memory importance decay rate per day (0-1):",
			default: "0.95",
		});
		memoryDecayRate = parseFloat(decayInput) || 0.95;
	}

	console.log();
	const wantImport = await confirm({
		message: "Do you want to import existing conversations?",
		default: false,
	});

	// Git version control setup
	console.log();
	let gitEnabled = false;

	if (existing.agentsDir) {
		// Directory exists - check if it's a git repo
		if (isGitRepo(basePath)) {
			gitEnabled = true;
			console.log(
				chalk.dim(
					"  Git repo detected. Will create backup commit before changes.",
				),
			);
		} else {
			const initGit = await confirm({
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
	} else {
		// Fresh install - ask about git
		const initGit = await confirm({
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
			copyFileSync(
				requirementsSource,
				join(basePath, "memory", "requirements.txt"),
			);
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
			agentsMd = readFileSync(agentsTemplate, "utf-8").replace(
				/\{\{AGENT_NAME\}\}/g,
				agentName,
			);
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
				extractionProvider,
				extractionModel,
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
				const content = readFileSync(templatePath, "utf-8").replace(
					/\{\{AGENT_NAME\}\}/g,
					agentName,
				);
				writeFileSync(destPath, content);
			}
		}

		spinner.text = "Initializing database...";
		const dbPath = join(basePath, "memory", "memories.db");
		const db = new Database(dbPath);

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
				console.warn(
					`\n  ⚠ Could not configure ${harness}: ${(err as Error).message}`,
				);
			}
		}

		// Configure OpenClaw workspace if requested
		if (configureOpenClawWs) {
			spinner.text = "Configuring OpenClaw workspace...";
			const patched = await new OpenClawConnector().configureWorkspace(
				basePath,
			);
			if (patched.length > 0) {
				console.log(chalk.dim("\n  ✓ OpenClaw workspace set to ~/.agents"));
			}
		}

		// Start the daemon
		spinner.text = "Starting daemon...";
		const daemonStarted = await startDaemon();

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
			console.log(
				chalk.green(`  ● Daemon running at http://localhost:${DEFAULT_PORT}`),
			);
		}

		console.log();

		if (wantImport) {
			await migrateWizard(basePath);
		}

		// Commit the initial setup
		if (gitEnabled) {
			const date = new Date().toISOString().split("T")[0];
			const committed = await gitAddAndCommit(basePath, `${date}_signet-setup`);
			if (committed) {
				console.log(chalk.dim("  ✓ Changes committed to git"));
			}
		}

		const launchNow = await confirm({
			message: "Open the dashboard?",
			default: true,
		});

		if (launchNow) {
			await open(`http://localhost:${DEFAULT_PORT}`);
		}

		// Suggest onboarding
		console.log();
		console.log(
			chalk.cyan(
				"  → Next step: Say '/onboarding' to personalize your agent",
			),
		);
		console.log(
			chalk.dim(
				"    This will walk you through setting up your agent's personality,",
			),
		);
		console.log(
			chalk.dim(
				"    communication style, and your preferences.",
			),
		);
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
	} else if (
		gitUrl.startsWith("https://github.com/") &&
		!gitUrl.endsWith(".git")
	) {
		gitUrl = gitUrl + ".git";
	}

	console.log();
	console.log(chalk.dim(`  Cloning from ${gitUrl}...`));

	// Check if basePath has uncommitted changes
	if (isGitRepo(basePath)) {
		const statusResult = spawnSync("git", ["status", "--porcelain"], {
			cwd: basePath,
			encoding: "utf-8",
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

	const spinner = ora("Cloning repository...").start();

	try {
		const cloneResult = spawnSync(
			"git",
			["clone", "--depth", "1", gitUrl, tmpDir],
			{
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		if (cloneResult.status !== 0) {
			spinner.fail("Clone failed");
			console.log(chalk.red(`  ${cloneResult.stderr || "Unknown error"}`));
			if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
			return;
		}

		spinner.succeed("Repository cloned");

		// List files that will be imported
		const configFiles = [
			"agent.yaml",
			"AGENTS.md",
			"SOUL.md",
			"IDENTITY.md",
			"USER.md",
			"MEMORY.md",
		];
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
			});
			if (remoteResult.status !== 0) {
				// No origin remote, add it
				spawnSync("git", ["remote", "add", "origin", gitUrl], {
					cwd: basePath,
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

// signet migrate - Import Wizard
// ============================================================================

async function migrateWizard(basePath: string) {
	console.log();
	console.log(chalk.bold("  Import existing conversations\n"));

	const source = await select({
		message: "Where are you importing from?",
		choices: [
			{ value: "chatgpt", name: "ChatGPT export (conversations.json)" },
			{ value: "claude", name: "Claude export" },
			{ value: "gemini", name: "Gemini / Google AI Studio" },
			{ value: "custom", name: "Custom JSON format" },
		],
	});

	const inputPath = await input({
		message: "Path to export file:",
		validate: (v) => existsSync(v) || "File not found",
	});

	console.log();
	console.log(
		chalk.yellow(
			"  ⚠ Migration from " + source + " is not yet implemented.",
		),
	);
	console.log(
		chalk.dim("  This feature is coming soon. File: " + inputPath),
	);
	console.log(
		chalk.dim("  Track progress at https://github.com/signetai/signetai/issues"),
	);
}

// ============================================================================
// signet dashboard - Launch Web UI
// ============================================================================

async function launchDashboard(options: { path?: string }) {
	console.log(signetLogo());

	const running = await isDaemonRunning();

	if (!running) {
		console.log(chalk.yellow("  Daemon is not running. Starting..."));
		const started = await startDaemon();
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
	const basePath = options.path || AGENTS_DIR;
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
		const db = new Database(dbPath, { readonly: true });
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
			await stopDaemon();
			await new Promise((r) => setTimeout(r, 1000));
		}

		// Open with write access and migrate
		const writeDb = new Database(dbPath);
		const result = ensureUnifiedSchema(writeDb);

		if (result.errors.length > 0) {
			for (const err of result.errors) {
				console.log(chalk.red(`  Error: ${err}`));
			}
		}

		if (result.migrated) {
			console.log(
				chalk.green(
					`  ✓ Migrated ${result.memoriesMigrated} memories from ${result.fromSchema} to ${result.toSchema}`,
				),
			);
		} else {
			console.log(chalk.dim("  No migration needed"));
		}

		runMigrations(writeDb);

		writeDb.close();

		// Restart daemon if it was running
		if (running) {
			console.log(chalk.dim("  Restarting daemon..."));
			await startDaemon();
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

async function showStatus(options: { path?: string }) {
	const basePath = options.path || AGENTS_DIR;
	const existing = detectExistingSetup(basePath);

	console.log(signetLogo());

	if (!existing.agentsDir) {
		console.log(chalk.yellow("  No Signet installation found."));
		console.log(`  Run ${chalk.bold("signet setup")} to get started.`);
		return;
	}

	console.log(chalk.bold("  Status\n"));

	// Daemon status
	const status = await getDaemonStatus();
	if (status.running) {
		console.log(`  ${chalk.green("●")} Daemon ${chalk.green("running")}`);
		console.log(chalk.dim(`    PID: ${status.pid}`));
		console.log(chalk.dim(`    Uptime: ${formatUptime(status.uptime || 0)}`));
		console.log(chalk.dim(`    Dashboard: http://localhost:${DEFAULT_PORT}`));
	} else {
		console.log(`  ${chalk.red("○")} Daemon ${chalk.red("stopped")}`);
	}

	console.log();

	// Files
	const checks = [
		{ name: "AGENTS.md", exists: existing.agentsMd },
		{ name: "agent.yaml", exists: existing.agentYaml },
		{ name: "memories.db", exists: existing.memoryDb },
	];

	for (const check of checks) {
		const icon = check.exists ? chalk.green("✓") : chalk.red("✗");
		console.log(`  ${icon} ${check.name}`);
	}

	if (existing.memoryDb) {
		try {
			const db = new Database(join(basePath, "memory", "memories.db"), {
				readonly: true,
			});

			// Detect schema type
			const schemaInfo = detectSchema(db);

			if (schemaInfo.type !== "core" && schemaInfo.type !== "unknown") {
				console.log();
				console.log(chalk.yellow(`  ⚠ Database schema: ${schemaInfo.type}`));
				console.log(
					chalk.dim(
						`    Run ${chalk.bold("signet migrate-schema")} to upgrade`,
					),
				);
			}

			const memoryCount = db
				.prepare("SELECT COUNT(*) as count FROM memories")
				.get() as { count: number };

			// Conversations table may not exist in older schemas
			let conversationCount: { count: number } | undefined;
			if (schemaInfo.hasConversations) {
				conversationCount = db
					.prepare("SELECT COUNT(*) as count FROM conversations")
					.get() as { count: number } | undefined;
			}

			console.log();
			console.log(chalk.dim(`  Memories: ${memoryCount.count}`));
			if (conversationCount) {
				console.log(chalk.dim(`  Conversations: ${conversationCount.count}`));
			}

			db.close();
		} catch {
			// Database might not have expected schema
		}
	}

	console.log();
	console.log(chalk.dim(`  Path: ${basePath}`));
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
	const levelColors: Record<string, (text: string) => string> = {
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
}) {
	const limit = parseInt(options.lines || "50", 10);
	const { follow, level, category } = options;

	console.log(signetLogo());

	// Check if daemon is running
	const status = await getDaemonStatus();

	if (status.running) {
		// Fetch logs from API
		try {
			const params = new URLSearchParams({ limit: String(limit) });
			if (level) params.set("level", level);
			if (category) params.set("category", category);

			const res = await fetch(
				`http://localhost:${DEFAULT_PORT}/api/logs?${params}`,
			);
			const data = await res.json();

			if (data.logs && data.logs.length > 0) {
				console.log(chalk.bold(`  Recent Logs (${data.count})\n`));
				for (const entry of data.logs) {
					console.log("  " + formatLogEntry(entry));
				}
			} else {
				console.log(chalk.dim("  No logs found"));
			}

			// Follow mode - stream logs using Node.js compatible fetch streaming
			if (follow) {
				console.log();
				console.log(chalk.dim("  Streaming logs... (Ctrl+C to stop)\n"));

				const streamUrl = `http://localhost:${DEFAULT_PORT}/api/logs/stream`;
				const streamRes = await fetch(streamUrl, {
					headers: { Accept: "text/event-stream", ...daemonAuthHeaders() },
				});

				if (!streamRes.ok || !streamRes.body) {
					console.log(chalk.red("  Failed to open log stream"));
				} else {
					const reader = streamRes.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";

					const processSSE = () => {
						const lines = buffer.split("\n");
						buffer = lines.pop() || "";
						for (const line of lines) {
							if (line.startsWith("data: ")) {
								try {
									const entry = JSON.parse(line.slice(6));
									if (entry.type === "connected") continue;
									console.log("  " + formatLogEntry(entry));
								} catch {
									// Ignore parse errors
								}
							}
						}
					};

					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							buffer += decoder.decode(value, { stream: true });
							processSSE();
						}
					} catch {
						// stream closed
					}
					console.log(chalk.red("  Stream disconnected"));
				}
			}
		} catch (e) {
			console.log(chalk.yellow("  Could not fetch logs from daemon"));
			fallbackToFile();
		}
	} else {
		console.log(
			chalk.yellow("  Daemon not running - reading from log files\n"),
		);
		fallbackToFile();
	}

	function fallbackToFile() {
		// Fall back to reading log files directly
		const logFile = join(
			LOG_DIR,
			`signet-${new Date().toISOString().split("T")[0]}.log`,
		);

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

program
	.name("signet")
	.description("Own your agent. Bring it anywhere.")
	.version(VERSION);

program
	.command("setup")
	.description("Interactive setup wizard")
	.option("-p, --path <path>", "Base path for agent files")
	.action(setupWizard);

program
	.command("dashboard")
	.alias("ui")
	.description("Open the web dashboard")
	.option("-p, --path <path>", "Base path for agent files")
	.action(launchDashboard);

program
	.command("status")
	.description("Show agent and daemon status")
	.option("-p, --path <path>", "Base path for agent files")
	.action(showStatus);

program
	.command("migrate-schema")
	.description("Migrate database to unified schema")
	.option("-p, --path <path>", "Base path for agent files")
	.action(migrateSchema);

// Daemon action handlers (shared between top-level and subcommand)
async function doStart() {
	console.log(signetLogo());

	const running = await isDaemonRunning();
	if (running) {
		console.log(chalk.yellow("  Daemon is already running"));
		return;
	}

	const spinner = ora("Starting daemon...").start();
	const started = await startDaemon();

	if (started) {
		spinner.succeed("Daemon started");
		console.log(chalk.dim(`  Dashboard: http://localhost:${DEFAULT_PORT}`));
	} else {
		spinner.fail("Failed to start daemon");
	}
}

async function doStop() {
	console.log(signetLogo());

	const running = await isDaemonRunning();
	if (!running) {
		console.log(chalk.yellow("  Daemon is not running"));
		return;
	}

	const spinner = ora("Stopping daemon...").start();
	const stopped = await stopDaemon();

	if (stopped) {
		spinner.succeed("Daemon stopped");
	} else {
		spinner.fail("Failed to stop daemon");
	}
}

async function doRestart() {
	console.log(signetLogo());

	const spinner = ora("Restarting daemon...").start();
	await stopDaemon();
	await new Promise((resolve) => setTimeout(resolve, 500));
	const started = await startDaemon();

	if (started) {
		spinner.succeed("Daemon restarted");
		console.log(chalk.dim(`  Dashboard: http://localhost:${DEFAULT_PORT}`));
	} else {
		spinner.fail("Failed to restart daemon");
	}
}

// signet daemon <command> - grouped daemon commands
const daemonCmd = program
	.command("daemon")
	.description("Manage the Signet daemon");

daemonCmd.command("start").description("Start the daemon").action(doStart);

daemonCmd.command("stop").description("Stop the daemon").action(doStop);

daemonCmd
	.command("restart")
	.description("Restart the daemon")
	.action(doRestart);

daemonCmd
	.command("status")
	.description("Show daemon status")
	.action(showStatus);

daemonCmd
	.command("logs")
	.description("View daemon logs")
	.option("-n, --lines <lines>", "Number of lines to show", "50")
	.option("-f, --follow", "Follow log output in real-time")
	.option("-l, --level <level>", "Filter by level (debug, info, warn, error)")
	.option(
		"-c, --category <category>",
		"Filter by category (daemon, api, memory, sync, git, watcher)",
	)
	.action(showLogs);

// Top-level aliases for convenience (backwards compatible)
program
	.command("start")
	.description("Start the daemon (alias for: signet daemon start)")
	.action(doStart);

program
	.command("stop")
	.description("Stop the daemon (alias for: signet daemon stop)")
	.action(doStop);

program
	.command("restart")
	.description("Restart the daemon (alias for: signet daemon restart)")
	.action(doRestart);

program
	.command("logs")
	.description("View daemon logs (alias for: signet daemon logs)")
	.option("-n, --lines <lines>", "Number of lines to show", "50")
	.option("-f, --follow", "Follow log output in real-time")
	.option("-l, --level <level>", "Filter by level (debug, info, warn, error)")
	.option(
		"-c, --category <category>",
		"Filter by category (daemon, api, memory, sync, git, watcher)",
	)
	.action(showLogs);

program
	.command("migrate")
	.description("Import from another platform")
	.argument("[source]", "Source platform (chatgpt, claude, gemini)")
	.action(async (source) => {
		const basePath = AGENTS_DIR;
		await migrateWizard(basePath);
	});

program
	.command("sync")
	.description("Sync built-in templates and skills")
	.action(async () => {
		console.log(signetLogo());
		const basePath = AGENTS_DIR;
		const templatesDir = getTemplatesDir();

		if (!existsSync(basePath)) {
			console.log(
				chalk.red("  No Signet installation found. Run: signet setup"),
			);
			return;
		}

		console.log(chalk.bold("  Syncing template files...\n"));

		// Sync template files
		// Note: gitignore stored as gitignore.template because npm excludes .gitignore
		let synced = 0;

		const gitignoreSrc = join(templatesDir, "gitignore.template");
		const gitignoreDest = join(basePath, ".gitignore");
		if (existsSync(gitignoreSrc) && !existsSync(gitignoreDest)) {
			copyFileSync(gitignoreSrc, gitignoreDest);
			console.log(chalk.green(`  ✓ .gitignore`));
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

		// Re-register hooks for detected harnesses
		const detectedHarnesses: string[] = [];
		if (existsSync(join(homedir(), ".claude", "settings.json"))) {
			detectedHarnesses.push("claude-code");
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
				console.log(
					chalk.yellow(`  ⚠ hooks re-registration failed for ${harness}`),
				);
			}
		}

		if (synced === 0) {
			console.log(chalk.dim("  All built-in templates are up to date"));
		}

		console.log();
		console.log(chalk.green("  Done!"));
	});

program
	.command("config")
	.description("Configure agent settings")
	.action(async () => {
		console.log(signetLogo());

		const agentYamlPath = join(AGENTS_DIR, "agent.yaml");
		if (!existsSync(agentYamlPath)) {
			console.log(
				chalk.yellow("  No agent.yaml found. Run `signet setup` first."),
			);
			return;
		}

		// Helper to re-read YAML fresh from disk each time (avoids stale reads)
		const readCurrentYaml = () => readFileSync(agentYamlPath, "utf-8");
		// Simple YAML parsing for our known structure
		const getYamlValue = (key: string, fallback: string) => {
			const yaml = readCurrentYaml();
			const match = yaml.match(
				new RegExp(`^\\s*${key}:\\s*(.+)$`, "m"),
			);
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
				const currentYaml = readCurrentYaml();
				console.log(chalk.dim("  Current agent.yaml:\n"));
				console.log(
					currentYaml
						.split("\n")
						.map((l) => chalk.dim("  " + l))
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

				// Re-read YAML fresh before editing to avoid stale overwrites
				let updatedYaml = readCurrentYaml();
				updatedYaml = updatedYaml.replace(/^(\s*name:)\s*.+$/m, `$1 "${name}"`);
				updatedYaml = updatedYaml.replace(
					/^(\s*description:)\s*.+$/m,
					`$1 "${description}"`,
				);
				updatedYaml = updatedYaml.replace(
					/^(\s*updated:)\s*.+$/m,
					`$1 "${new Date().toISOString()}"`,
				);

				writeFileSync(agentYamlPath, updatedYaml);
				console.log(chalk.green("  ✓ Agent identity updated"));
			}

			if (section === "harnesses") {
				const harnesses = await checkbox({
					message: "Select AI platforms:",
					choices: [
						{ value: "claude-code", name: "Claude Code" },
						{ value: "opencode", name: "OpenCode" },
						{ value: "openclaw", name: "OpenClaw" },
						{ value: "cursor", name: "Cursor" },
						{ value: "windsurf", name: "Windsurf" },
					],
				});

				// Update harnesses in YAML (re-read fresh; handle empty list)
				const harnessYaml = harnesses.map((h) => `  - ${h}`).join("\n");
				let updatedYaml = readCurrentYaml().replace(
					/^harnesses:\n(  - .+\n)*/m,
					`harnesses:\n${harnessYaml}\n`,
				);

				writeFileSync(agentYamlPath, updatedYaml);
				console.log(chalk.green("  ✓ Harnesses updated"));

				// Offer to regenerate harness configs
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
						const m = await select({
							message: "Model:",
							choices: [
								{ value: "nomic-embed-text", name: "nomic-embed-text (768d)" },
								{ value: "all-minilm", name: "all-minilm (384d)" },
								{
									value: "mxbai-embed-large",
									name: "mxbai-embed-large (1024d)",
								},
							],
						});
						model = m;
						dimensions =
							m === "all-minilm" ? 384 : m === "mxbai-embed-large" ? 1024 : 768;
					} else {
						const m = await select({
							message: "Model:",
							choices: [
								{
									value: "text-embedding-3-small",
									name: "text-embedding-3-small (1536d)",
								},
								{
									value: "text-embedding-3-large",
									name: "text-embedding-3-large (3072d)",
								},
							],
						});
						model = m;
						dimensions = m === "text-embedding-3-large" ? 3072 : 1536;
					}

					// Update embedding section (re-read fresh)
					let updatedYaml = readCurrentYaml();
					if (updatedYaml.includes("embedding:")) {
						updatedYaml = updatedYaml.replace(
							/^embedding:\n(  .+\n)+/m,
							`embedding:\n  provider: ${provider}\n  model: ${model}\n  dimensions: ${dimensions}\n`,
						);
					} else {
						// Add embedding section after harnesses
						updatedYaml = updatedYaml.replace(
							/^(harnesses:\n(  - .+\n)+)/m,
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

				let updatedYaml = readCurrentYaml();
				updatedYaml = updatedYaml.replace(/^(\s*alpha:)\s*.+$/m, `$1 ${alpha}`);
				updatedYaml = updatedYaml.replace(/^(\s*top_k:)\s*.+$/m, `$1 ${topK}`);
				updatedYaml = updatedYaml.replace(
					/^(\s*min_score:)\s*.+$/m,
					`$1 ${minScore}`,
				);

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

				let updatedYaml = readCurrentYaml();
				updatedYaml = updatedYaml.replace(
					/^(\s*session_budget:)\s*.+$/m,
					`$1 ${sessionBudget}`,
				);
				updatedYaml = updatedYaml.replace(
					/^(\s*decay_rate:)\s*.+$/m,
					`$1 ${decayRate}`,
				);

				writeFileSync(agentYamlPath, updatedYaml);
				console.log(chalk.green("  ✓ Memory settings updated"));
			}

			console.log();
		}

		console.log(chalk.dim("  Configuration saved to agent.yaml"));
		console.log();
	});

// ============================================================================
// signet secret - Secrets management
// ============================================================================

const DAEMON_URL = `http://localhost:${DEFAULT_PORT}`;

async function secretApiCall(
	method: string,
	path: string,
	body?: unknown,
): Promise<{ ok: boolean; data: unknown }> {
	const authHeaders = daemonAuthHeaders();
	const res = await fetch(`${DAEMON_URL}${path}`, {
		method,
		headers: {
			...authHeaders,
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(5000),
	});
	const data = await res.json();
	return { ok: res.ok, data };
}

async function ensureDaemonForSecrets(): Promise<boolean> {
	const running = await isDaemonRunning();
	if (!running) {
		console.error(
			chalk.red("  Daemon is not running. Start it with: signet start"),
		);
		return false;
	}
	return true;
}

const secretCmd = program
	.command("secret")
	.description("Manage encrypted secrets");

secretCmd
	.command("put <name> [value]")
	.description("Store a secret (prompted if value omitted)")
	.action(async (name: string, rawValue?: string) => {
		if (!(await ensureDaemonForSecrets())) return;

		const value =
			rawValue ??
			(await password({
				message: `Enter value for ${chalk.bold(name)}:`,
				mask: "•",
			}));

		if (!value) {
			console.error(chalk.red("  Value cannot be empty"));
			process.exit(1);
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
				process.exit(1);
			}
		} catch (e) {
			spinner.fail(chalk.red(`Error: ${(e as Error).message}`));
			process.exit(1);
		}
	});

secretCmd
	.command("list")
	.description("List secret names (never values)")
	.action(async () => {
		if (!(await ensureDaemonForSecrets())) return;

		try {
			const { ok, data } = await secretApiCall("GET", "/api/secrets");
			if (!ok) {
				console.error(
					chalk.red(`  Error: ${(data as { error: string }).error}`),
				);
				process.exit(1);
			}
			const secrets = (data as { secrets: string[] }).secrets;
			if (secrets.length === 0) {
				console.log(chalk.dim("  No secrets stored."));
			} else {
				for (const name of secrets) {
					console.log(`  ${chalk.cyan("◈")} ${name}`);
				}
			}
		} catch (e) {
			console.error(chalk.red(`  Error: ${(e as Error).message}`));
			process.exit(1);
		}
	});

secretCmd
	.command("delete <name>")
	.description("Delete a secret")
	.action(async (name: string) => {
		if (!(await ensureDaemonForSecrets())) return;

		const confirmed = await confirm({
			message: `Delete secret ${chalk.bold(name)}?`,
			default: false,
		});
		if (!confirmed) return;

		const spinner = ora("Deleting...").start();
		try {
			const { ok, data } = await secretApiCall(
				"DELETE",
				`/api/secrets/${name}`,
			);
			if (ok) {
				spinner.succeed(chalk.green(`Secret ${chalk.bold(name)} deleted`));
			} else {
				spinner.fail(chalk.red(`Failed: ${(data as { error: string }).error}`));
				process.exit(1);
			}
		} catch (e) {
			spinner.fail(chalk.red(`Error: ${(e as Error).message}`));
			process.exit(1);
		}
	});

secretCmd
	.command("has <name>")
	.description("Check if a secret exists (exits 0 if found, 1 if not)")
	.action(async (name: string) => {
		if (!(await ensureDaemonForSecrets())) return;

		try {
			const { data } = await secretApiCall("GET", "/api/secrets");
			const secrets = (data as { secrets: string[] }).secrets ?? [];
			const exists = secrets.includes(name);
			console.log(exists ? "true" : "false");
			process.exit(exists ? 0 : 1);
		} catch (e) {
			console.error(chalk.red(`  Error: ${(e as Error).message}`));
			process.exit(1);
		}
	});

// ============================================================================
// Skills Commands
// ============================================================================

const SKILLS_DIR = join(AGENTS_DIR, "skills");

interface SkillMeta {
	name: string;
	description?: string;
	version?: string;
	author?: string;
	user_invocable?: boolean;
	arg_hint?: string;
}

function parseSkillFrontmatter(content: string): SkillMeta {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return { name: "" };

	const fm = match[1];
	const get = (key: string) => {
		const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
		return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
	};

	return {
		name: get("name"),
		description: get("description") || undefined,
		version: get("version") || undefined,
		author: get("author") || undefined,
		user_invocable: /^user_invocable:\s*true$/m.test(fm),
		arg_hint: get("arg_hint") || undefined,
	};
}

function listLocalSkills(): Array<SkillMeta & { dirName: string }> {
	if (!existsSync(SKILLS_DIR)) return [];

	return readdirSync(SKILLS_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.flatMap((d) => {
			const skillMdPath = join(SKILLS_DIR, d.name, "SKILL.md");
			if (!existsSync(skillMdPath)) return [];
			try {
				const content = readFileSync(skillMdPath, "utf-8");
				const meta = parseSkillFrontmatter(content);
				return [{ ...meta, dirName: d.name }];
			} catch {
				return [];
			}
		});
}

async function fetchFromDaemon<T>(
	path: string,
	opts?: RequestInit & { timeout?: number },
): Promise<T | null> {
	const { timeout: timeoutMs, ...fetchOpts } = opts || {};
	try {
		// Inject local auth token and Content-Type into all daemon requests
		const authHeaders = daemonAuthHeaders();
		const headers: Record<string, string> = {
			...authHeaders,
			...(fetchOpts.body ? { "Content-Type": "application/json" } : {}),
			...((fetchOpts.headers as Record<string, string>) || {}),
		};
		const res = await fetch(`http://localhost:${DEFAULT_PORT}${path}`, {
			signal: AbortSignal.timeout(timeoutMs || 5000),
			...fetchOpts,
			headers,
		});
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

// Returns [results, rateLimited]
async function searchRegistry(
	query: string,
): Promise<
	[Array<{ name: string; description: string; url: string }>, boolean]
> {
	// GitHub repository search - no auth needed for public search (10 req/min limit)
	try {
		const q = encodeURIComponent(
			`${query} topic:agent-skill OR filename:SKILL.md in:path`,
		);
		const res = await fetch(
			`https://api.github.com/search/repositories?q=${q}&sort=stars&per_page=10`,
			{
				headers: {
					Accept: "application/vnd.github.v3+json",
					"User-Agent": "signet-cli",
				},
				signal: AbortSignal.timeout(8000),
			},
		);

		if (res.status === 403 || res.status === 429) return [[], true];
		if (!res.ok) return [[], false];

		const data = (await res.json()) as {
			items?: Array<{
				name: string;
				description: string | null;
				html_url: string;
				full_name: string;
			}>;
		};

		return [
			(data.items ?? []).map((item) => ({
				name: item.name,
				description: item.description ?? "",
				url: item.html_url,
			})),
			false,
		];
	} catch {
		return [[], false];
	}
}

const skillCmd = program.command("skill").description("Manage agent skills");

// signet skill list
skillCmd
	.command("list")
	.description("Show installed skills")
	.action(async () => {
		// Try daemon first, fall back to local FS
		const data = await fetchFromDaemon<{
			skills: Array<SkillMeta & { name: string }>;
		}>("/api/skills");
		const skills =
			data?.skills ?? listLocalSkills().map((s) => ({ ...s, name: s.dirName }));

		if (skills.length === 0) {
			console.log(chalk.dim(`  No skills installed at ${SKILLS_DIR}`));
			console.log(
				chalk.dim("  Run `signet skill search <query>` to find skills"),
			);
			return;
		}

		console.log(chalk.bold(`  Installed skills (${skills.length}):\n`));
		const nameWidth = Math.max(...skills.map((s) => s.name.length), 12);
		for (const skill of skills) {
			const name = skill.name.padEnd(nameWidth);
			const desc = skill.description ? chalk.dim(skill.description) : "";
			const ver = skill.version ? chalk.dim(` v${skill.version}`) : "";
			console.log(`    ${chalk.cyan(name)}  ${desc}${ver}`);
		}
		console.log();
	});

// signet skill install <name>
skillCmd
	.command("install <name>")
	.description(
		"Install a skill from skills.sh registry (e.g. browser-use or owner/repo)",
	)
	.action(async (name: string) => {
		const spinner = ora(`Installing ${chalk.cyan(name)}...`).start();

		const daemonRunning = await isDaemonRunning();

		if (daemonRunning) {
			const result = await fetchFromDaemon<{
				success: boolean;
				error?: string;
			}>("/api/skills/install", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name }),
			});

			if (result?.success) {
				spinner.succeed(
					`Installed ${chalk.cyan(name)} to ${SKILLS_DIR}/${name}/`,
				);
			} else {
				spinner.fail(`Failed to install ${name}`);
				if (result?.error) console.error(chalk.dim(`  ${result.error}`));
				console.log(
					chalk.dim(
						`\n  Tip: provide full GitHub path: signet skill install owner/repo`,
					),
				);
			}
		} else {
			const packageManager = resolvePrimaryPackageManager({
				agentsDir: AGENTS_DIR,
				env: process.env,
			});
			const skillsCommand = getSkillsRunnerCommand(packageManager.family, [
				"add",
				name,
				"--global",
				"--yes",
			]);

			spinner.text = `Installing ${chalk.cyan(name)} (daemon offline, running ${skillsCommand.command} skills)...`;
			if (packageManager.source === "fallback") {
				console.log(chalk.dim(`  ${packageManager.reason}`));
			}

			await new Promise<void>((resolve) => {
				const proc = spawn(skillsCommand.command, skillsCommand.args, {
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env },
				});

				let stderr = "";
				proc.stderr.on("data", (d: Buffer) => {
					stderr += d.toString();
				});

				proc.on("close", (code) => {
					if (code === 0) {
						spinner.succeed(`Installed ${chalk.cyan(name)}`);
					} else {
						spinner.fail(`Failed to install ${name}`);
						if (stderr) console.error(chalk.dim(`  ${stderr.trim()}`));
						console.log(
							chalk.dim(
								`\n  Tip: provide full GitHub path: signet skill install owner/repo`,
							),
						);
					}
					resolve();
				});

				proc.on("error", () => {
					spinner.fail(`${skillsCommand.command} is not available`);
					resolve();
				});
			});
		}
	});

// signet skill uninstall <name>
skillCmd
	.command("uninstall <name>")
	.alias("remove")
	.description("Remove an installed skill")
	.action(async (name: string) => {
		const skillDir = join(SKILLS_DIR, name);

		if (!existsSync(skillDir)) {
			console.log(chalk.yellow(`  Skill '${name}' is not installed`));
			return;
		}

		const spinner = ora(`Removing ${chalk.cyan(name)}...`).start();

		const daemonRunning = await isDaemonRunning();

		if (daemonRunning) {
			const result = await fetchFromDaemon<{
				success: boolean;
				error?: string;
			}>(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });

			if (result?.success) {
				spinner.succeed(`Removed ${chalk.cyan(name)}`);
			} else {
				spinner.fail(`Failed to remove ${name}`);
				if (result?.error) console.error(chalk.dim(`  ${result.error}`));
			}
		} else {
			// Daemon offline - remove directly
			try {
				const { rmSync } = await import("fs");
				rmSync(skillDir, { recursive: true, force: true });
				spinner.succeed(`Removed ${chalk.cyan(name)}`);
			} catch (err) {
				spinner.fail(`Failed to remove ${name}`);
				console.error(chalk.dim(`  ${(err as Error).message}`));
			}
		}
	});

// signet skill search <query>
skillCmd
	.command("search <query>")
	.description("Search skills.sh registry for skills")
	.action(async (query: string) => {
		// Search local installed skills first
		const local = listLocalSkills().filter((s) => {
			const q = query.toLowerCase();
			return (
				s.dirName.includes(q) ||
				(s.name ?? "").toLowerCase().includes(q) ||
				(s.description ?? "").toLowerCase().includes(q)
			);
		});

		const spinner = ora(`Searching registry for "${query}"...`).start();
		const [remote, rateLimited] = await searchRegistry(query);
		spinner.stop();

		const installed = new Set(listLocalSkills().map((s) => s.dirName));

		if (local.length > 0) {
			console.log(chalk.bold(`  Installed matching "${query}":\n`));
			for (const skill of local) {
				const desc = skill.description
					? chalk.dim(` — ${skill.description}`)
					: "";
				console.log(
					`    ${chalk.green("✓")} ${chalk.cyan(skill.dirName)}${desc}`,
				);
			}
			console.log();
		}

		if (remote.length > 0) {
			console.log(chalk.bold(`  Available on GitHub:\n`));
			for (const skill of remote) {
				const isInstalled = installed.has(skill.name);
				const mark = isInstalled ? chalk.green("✓ ") : "  ";
				const desc = skill.description
					? chalk.dim(` — ${skill.description}`)
					: "";
				console.log(`  ${mark}${chalk.cyan(skill.name)}${desc}`);
				console.log(`       ${chalk.dim(skill.url)}`);
			}
			console.log();
			console.log(
				chalk.dim(`  Install with: signet skill install <owner/repo>`),
			);
		} else if (rateLimited) {
			console.log(
				chalk.yellow(
					`  Registry search rate-limited. Browse at ${chalk.cyan("https://skills.sh")}`,
				),
			);
		} else if (local.length === 0) {
			console.log(chalk.dim(`  No skills found for "${query}"`));
			console.log(chalk.dim(`  Browse all skills at https://skills.sh`));
		}

		console.log();
	});

// signet skill show <name>
skillCmd
	.command("show <name>")
	.description("Display SKILL.md content for an installed skill")
	.action(async (name: string) => {
		const data = await fetchFromDaemon<{
			content?: string;
			description?: string;
			version?: string;
			error?: string;
		}>(`/api/skills/${encodeURIComponent(name)}`);

		if (data?.error || !data?.content) {
			// Try local fallback
			const skillMdPath = join(SKILLS_DIR, name, "SKILL.md");
			if (!existsSync(skillMdPath)) {
				console.log(chalk.red(`  Skill '${name}' is not installed`));
				console.log(chalk.dim(`  Run: signet skill install ${name}`));
				return;
			}
			const content = readFileSync(skillMdPath, "utf-8");
			console.log(content);
			return;
		}

		console.log(data.content);
	});

// ============================================================================
// signet remember / recall - Quick memory operations
// ============================================================================

// signet remember <content>
program
	.command("remember <content>")
	.description("Save a memory (auto-embedded for vector search)")
	.option("-w, --who <who>", "Who is remembering", "user")
	.option("-t, --tags <tags>", "Comma-separated tags")
	.option("-i, --importance <n>", "Importance (0-1)", parseFloat, 0.7)
	.option("--critical", "Mark as critical (pinned)", false)
	.action(async (content: string, options) => {
		if (!(await ensureDaemonForSecrets())) return;

		const spinner = ora("Saving memory...").start();

		const { ok, data } = await secretApiCall("POST", "/api/memory/remember", {
			content,
			who: options.who,
			tags: options.tags,
			importance: options.importance,
			pinned: options.critical,
		});

		if (!ok || (data as { error?: string }).error) {
			spinner.fail(
				(data as { error?: string }).error || "Failed to save memory",
			);
			process.exit(1);
		}

		const result = data as {
			id: string;
			type: string;
			tags?: string;
			pinned: boolean;
			embedded: boolean;
		};

		const embedStatus = result.embedded
			? chalk.dim(" (embedded)")
			: chalk.yellow(" (no embedding)");
		spinner.succeed(`Saved memory: ${chalk.cyan(result.id)}${embedStatus}`);

		if (result.pinned) {
			console.log(chalk.dim("  Marked as critical"));
		}
		if (result.tags) {
			console.log(chalk.dim(`  Tags: ${result.tags}`));
		}
	});

// signet recall <query>
program
	.command("recall <query>")
	.description("Search memories using hybrid (vector + keyword) search")
	.option("-l, --limit <n>", "Max results", parseInt, 10)
	.option("-t, --type <type>", "Filter by type")
	.option("--tags <tags>", "Filter by tags (comma-separated)")
	.option("--who <who>", "Filter by who")
	.option("--since <date>", "Only memories created after this date (ISO or YYYY-MM-DD)")
	.option("--until <date>", "Only memories created before this date (ISO or YYYY-MM-DD)")
	.option("--json", "Output as JSON")
	.action(async (query: string, options) => {
		if (!(await ensureDaemonForSecrets())) return;

		const spinner = ora("Searching memories...").start();

		const { ok, data } = await secretApiCall("POST", "/api/memory/recall", {
			query,
			limit: options.limit,
			type: options.type,
			tags: options.tags,
			who: options.who,
			since: options.since,
			until: options.until,
		});

		if (!ok || (data as { error?: string }).error) {
			spinner.fail((data as { error?: string }).error || "Search failed");
			process.exit(1);
		}

		spinner.stop();

		const result = data as {
			results: Array<{
				content: string;
				score: number;
				source: string;
				type: string;
				tags?: string;
				pinned: boolean;
				who: string;
				created_at: string;
			}>;
			query: string;
			method: string;
		};

		if (options.json) {
			console.log(JSON.stringify(result.results, null, 2));
			return;
		}

		if (result.results.length === 0) {
			console.log(chalk.dim("  No memories found"));
			console.log(
				chalk.dim(
					"  Try a different query or add memories with `signet remember`",
				),
			);
			return;
		}

		console.log(chalk.bold(`\n  Found ${result.results.length} memories:\n`));

		for (const r of result.results) {
			const date = r.created_at.slice(0, 10);
			const score = chalk.dim(`[${(r.score * 100).toFixed(0)}%]`);
			const source = chalk.dim(`(${r.source})`);
			const critical = r.pinned ? chalk.red("★") : "";
			const tags = r.tags ? chalk.dim(` [${r.tags}]`) : "";

			// Truncate long content for display
			const displayContent =
				r.content.length > 120 ? r.content.slice(0, 117) + "..." : r.content;

			console.log(
				`  ${chalk.dim(date)} ${score} ${critical}${displayContent}${tags}`,
			);
			console.log(chalk.dim(`      by ${r.who} · ${r.type} · ${source}`));
		}
		console.log();
	});

// ============================================================================
// signet ingest - Document ingestion engine ("pour your brain in")
// ============================================================================

program
	.command("ingest <path>")
	.description(
		"Ingest documents into memory (Markdown, PDF, TXT, code files or directories)",
	)
	.option("--type <type>", "Force file type (markdown|pdf|txt|code)")
	.option("--dry-run", "Show what would be extracted without saving", false)
	.option("--verbose", "Show each extracted fact", false)
	.option("--model <model>", "LLM model for extraction")
	.option("--ollama-url <url>", "Ollama base URL", "http://localhost:11434")
	.option(
		"--skip-extraction",
		"Store raw chunks without LLM extraction",
		false,
	)
	.option(
		"--max-chunks <n>",
		"Max chunks to process (for testing)",
		parseInt,
	)
	.option("-w, --workspace <name>", "Workspace name", "user")
	.action(
		async (
			inputPath: string,
			options: {
				type?: string;
				dryRun: boolean;
				verbose: boolean;
				model?: string;
				ollamaUrl: string;
				skipExtraction: boolean;
				maxChunks?: number;
				workspace: string;
			},
		) => {
			const { resolve: resolvePath } = await import("path");
			const absPath = resolvePath(inputPath);

			if (!existsSync(absPath)) {
				console.error(chalk.red(`  Path does not exist: ${absPath}`));
				process.exit(1);
			}

			// Load model from agent.yaml if not specified
			let model = options.model;
			if (!model) {
				try {
					const agentsDir = join(homedir(), ".agents");
					const yamlPath = join(agentsDir, "agent.yaml");
					if (existsSync(yamlPath)) {
						const yaml = readFileSync(yamlPath, "utf-8");
						const config = parseSimpleYaml(yaml);
						const extractionModel =
							config?.memory?.pipelineV2?.extraction?.model;
						const embeddingModel = config?.embedding?.model;
						model = extractionModel || embeddingModel || undefined;
					}
				} catch {
					// Ignore — will use default
				}
			}

			// Open database (unless dry-run)
			let db: ReturnType<typeof Database> | null = null;
			if (!options.dryRun) {
				const agentsDir = join(homedir(), ".agents");
				const dbPath = join(agentsDir, "memory", "memories.db");
				if (!existsSync(dbPath)) {
					console.error(
						chalk.red(
							"  No memory database found. Run `signet setup` first.",
						),
					);
					process.exit(1);
				}
				db = new Database(dbPath);
				try {
					loadSqliteVec(db as unknown as Parameters<typeof loadSqliteVec>[0]);
				} catch {
					// Non-fatal
				}
				runMigrations(
					db as unknown as Parameters<typeof runMigrations>[0],
				);
			}

			const spinner = ora("Scanning files...").start();

			try {
				const { ingestPath } = await import("@signet/core");

				const result = await ingestPath(
					absPath,
					{
						type: options.type as
							| "markdown"
							| "pdf"
							| "txt"
							| "code"
							| undefined,
						dryRun: options.dryRun,
						verbose: options.verbose,
						model,
						ollamaUrl: options.ollamaUrl,
						skipExtraction: options.skipExtraction,
						maxChunks: options.maxChunks,
						db,
						workspace: options.workspace,
					},
					(event) => {
						switch (event.type) {
							case "file-start":
								spinner.text = `[${event.fileIndex + 1}/${event.totalFiles}] ${event.filePath.replace(homedir(), "~")}`;
								break;
							case "file-done":
								if (options.verbose) {
									spinner.info(
										`  ${chalk.dim(event.filePath.replace(homedir(), "~"))} → ${event.memories} memories from ${event.chunks} chunks`,
									);
									spinner.start();
								}
								break;
							case "file-error":
								spinner.warn(
									`  ${chalk.yellow("⚠")} ${event.filePath.replace(homedir(), "~")}: ${event.error}`,
								);
								spinner.start();
								break;
							case "chunk-done":
								if (options.verbose && event.items > 0) {
									spinner.text = `  Chunk ${event.chunkIndex + 1}: extracted ${event.items} items`;
								}
								break;
						}
					},
				);

				// Close database
				if (db) {
					(db as { close(): void }).close();
				}

				spinner.stop();

				// Summary
				const dryRunLabel = options.dryRun
					? chalk.yellow(" (dry run)")
					: "";
				console.log();

				if (
					result.filesProcessed === 0 &&
					result.filesErrored === 0
				) {
					console.log(
						chalk.dim(
							"  No supported files found at the specified path.",
						),
					);
					console.log(
						chalk.dim(
							"  Supported: .md, .txt, .pdf, .py, .ts, .js, and more",
						),
					);
					return;
				}

				// Type breakdown
				const typeBreakdown = Object.entries(result.byType)
					.map(([type, count]) => `${count} ${type}s`)
					.join(", ");

				const filesLabel =
					result.filesProcessed === 1
						? "1 file"
						: `${result.filesProcessed} files`;

				console.log(
					chalk.bold(
						`  Ingested ${filesLabel} → ${chalk.green(String(result.memoriesCreated))} memories created${dryRunLabel}`,
					),
				);

				if (typeBreakdown) {
					console.log(chalk.dim(`  (${typeBreakdown})`));
				}

				if (result.filesErrored > 0) {
					console.log(
						chalk.yellow(
							`  ${result.filesErrored} file(s) had errors`,
						),
					);
				}

				console.log(
					chalk.dim(
						`  ${result.totalChunks} chunks processed across ${result.filesProcessed + result.filesErrored} files`,
					),
				);
				console.log();

				if (options.dryRun) {
					console.log(
						chalk.dim(
							"  Run without --dry-run to save to memory database.",
						),
					);
					console.log();
				}

				// Show per-file results in verbose mode
				if (options.verbose) {
					for (const file of result.files) {
						const status =
							file.status === "success"
								? chalk.green("✓")
								: file.status === "error"
									? chalk.red("✗")
									: chalk.dim("○");
						const path = file.filePath.replace(homedir(), "~");
						const info =
							file.status === "error"
								? chalk.red(file.error || "unknown error")
								: `${file.memoriesCreated} memories`;
						console.log(`  ${status} ${chalk.dim(path)} ${info}`);
					}
					console.log();
				}
			} catch (err) {
				if (db) {
					(db as { close(): void }).close();
				}
				spinner.fail(
					`Ingestion failed: ${(err as Error).message}`,
				);
				process.exit(1);
			}
		},
	);

// ============================================================================
// signet knowledge - Knowledge health dashboard
// ============================================================================

const knowledgeCmd = program
	.command("knowledge")
	.description("Knowledge base health and analytics");

knowledgeCmd
	.command("status")
	.description("Show knowledge health report with scoring")
	.option("--json", "Output as JSON")
	.action(async (options) => {
		const { getKnowledgeHealth, runMigrations, loadSqliteVec } = await import(
			"@signet/core"
		);

		const agentsDir = join(homedir(), ".agents");
		const dbPath = join(agentsDir, "memory", "memories.db");

		if (!existsSync(dbPath)) {
			console.error(
				chalk.red("  No memory database found. Run `signet setup` first."),
			);
			process.exit(1);
		}

		const spinner = ora("Analyzing knowledge health...").start();

		const db = new Database(dbPath, { readonly: true });
		try {
			loadSqliteVec(db);
		} catch {
			// Non-fatal
		}

		try {
			// Run migrations to ensure schema is up to date (read-only is fine for queries)
			// We'll open a writable connection for migrations then reopen readonly
		} catch {
			// ignore
		}

		try {
			const report = getKnowledgeHealth(db);
			db.close();
			spinner.stop();

			if (options.json) {
				console.log(JSON.stringify(report, null, 2));
				return;
			}

			// -- Header --
			console.log();
			const scoreColor =
				report.overallScore > 80
					? chalk.green
					: report.overallScore > 60
						? chalk.yellow
						: chalk.red;
			const scoreBar = renderScoreBar(report.overallScore);
			console.log(
				chalk.bold("  📊 Knowledge Health Report"),
			);
			console.log();
			console.log(
				`  Overall Score: ${scoreColor(chalk.bold(report.overallScore.toString()))} / 100  ${scoreBar}`,
			);
			console.log();

			// -- Score breakdown --
			console.log(chalk.bold("  Score Breakdown:"));
			const bd = report.scoreBreakdown;
			printScoreLine("Type Diversity", bd.typeDiversity, 10);
			printScoreLine("Signing", bd.signingCompleteness, 15);
			printScoreLine("Provenance", bd.provenanceCoverage, 15);
			printScoreLine("Graph Connectivity", bd.graphConnectivity, 15);
			printScoreLine("Freshness", bd.freshness, 15);
			printScoreLine("Contradictions", bd.contradictionResolution, 15);
			printScoreLine("Session Continuity", bd.sessionContinuity, 15);
			console.log();

			// -- Memory overview --
			console.log(chalk.bold("  Memory Overview:"));
			console.log(
				`    Total: ${chalk.cyan(report.totalMemories.toString())}  Active: ${chalk.cyan(report.activeMemories.toString())}  Stale: ${report.staleMemoryCount > 0 ? chalk.yellow(report.staleMemoryCount.toString()) : chalk.dim("0")}`,
			);
			console.log(
				`    Signed: ${chalk.green(report.signedCount.toString())}  Unsigned: ${report.unsignedCount > 0 ? chalk.yellow(report.unsignedCount.toString()) : chalk.dim("0")}`,
			);
			console.log(
				`    With provenance: ${chalk.green(report.withProvenanceCount.toString())}  Without: ${report.withoutProvenanceCount > 0 ? chalk.yellow(report.withoutProvenanceCount.toString()) : chalk.dim("0")}`,
			);
			console.log();

			// -- Type breakdown --
			if (report.typeBreakdown.length > 0) {
				console.log(chalk.bold("  Types:"));
				for (const t of report.typeBreakdown) {
					const bar = "█".repeat(
						Math.max(
							1,
							Math.round(
								(t.count / Math.max(1, report.activeMemories)) * 30,
							),
						),
					);
					console.log(
						`    ${chalk.dim(t.type.padEnd(14))} ${chalk.cyan(bar)} ${t.count}`,
					);
				}
				console.log();
			}

			// -- Graph --
			console.log(chalk.bold("  Knowledge Graph:"));
			console.log(
				`    Entities: ${chalk.cyan(report.totalEntities.toString())}  Relations: ${chalk.cyan(report.totalRelations.toString())}  Connected: ${chalk.cyan(report.connectedEntities.toString())}`,
			);
			if (report.totalEntities > 0) {
				const orphans = report.totalEntities - report.connectedEntities;
				if (orphans > 0) {
					console.log(
						`    Orphan entities: ${chalk.yellow(orphans.toString())}`,
					);
				}
			}
			console.log();

			// -- Contradictions --
			if (
				report.contradictionsPending > 0 ||
				report.contradictionsResolved > 0
			) {
				console.log(chalk.bold("  Contradictions:"));
				console.log(
					`    Resolved: ${chalk.green(report.contradictionsResolved.toString())}  Pending: ${report.contradictionsPending > 0 ? chalk.red(report.contradictionsPending.toString()) : chalk.dim("0")}`,
				);
				console.log();
			}

			// -- Sources --
			if (report.sourceBreakdown.length > 0) {
				console.log(chalk.bold("  Sources:"));
				for (const s of report.sourceBreakdown.slice(0, 8)) {
					console.log(
						`    ${chalk.dim(s.source.padEnd(18))} ${s.count}`,
					);
				}
				console.log();
			}

			// -- Top topics --
			if (report.topTopics.length > 0) {
				console.log(chalk.bold("  Top Topics:"));
				for (const t of report.topTopics.slice(0, 8)) {
					console.log(
						`    ${chalk.cyan(t.name.padEnd(24))} ${chalk.dim(t.count + " mentions")}`,
					);
				}
				console.log();
			}

			// -- Weakest areas --
			if (report.weakestAreas.length > 0) {
				console.log(chalk.bold("  Weakest Areas:"));
				for (const t of report.weakestAreas.slice(0, 5)) {
					console.log(
						`    ${chalk.yellow(t.name.padEnd(24))} ${chalk.dim(t.count + " mention" + (t.count === 1 ? "" : "s"))}`,
					);
				}
				console.log();
			}

			// -- Suggestions --
			if (report.suggestions.length > 0) {
				console.log(chalk.bold("  💡 Suggestions:"));
				for (const s of report.suggestions) {
					console.log(`    ${chalk.yellow("→")} ${s}`);
				}
				console.log();
			}
		} catch (err) {
			db.close();
			spinner.fail("Failed to compute knowledge health");
			console.error(chalk.red(`  ${(err as Error).message}`));
			process.exit(1);
		}
	});

// Helper: render a text-based score bar
function renderScoreBar(score: number): string {
	const width = 20;
	const filled = Math.round((score / 100) * width);
	const empty = width - filled;
	const color =
		score > 80 ? chalk.green : score > 60 ? chalk.yellow : chalk.red;
	return color("█".repeat(filled)) + chalk.dim("░".repeat(empty));
}

// Helper: print a single score line with visual bar
function printScoreLine(label: string, value: number, max: number): void {
	const pct = max > 0 ? value / max : 0;
	const barWidth = 12;
	const filled = Math.round(pct * barWidth);
	const empty = barWidth - filled;
	const color = pct > 0.8 ? chalk.green : pct > 0.5 ? chalk.yellow : chalk.red;
	console.log(
		`    ${chalk.dim(label.padEnd(22))} ${color("█".repeat(filled))}${chalk.dim("░".repeat(empty))} ${value}/${max}`,
	);
}

// ============================================================================
// signet session-stats - Session continuity trend
// ============================================================================

program
	.command("session-stats")
	.description("Show session continuity score trend")
	.option("-l, --limit <n>", "Number of sessions to show", parseInt, 20)
	.option("--json", "Output as JSON")
	.action(async (options) => {
		const { getSessionTrend, runMigrations, loadSqliteVec } = await import(
			"@signet/core"
		);

		const agentsDir = join(homedir(), ".agents");
		const dbPath = join(agentsDir, "memory", "memories.db");

		if (!existsSync(dbPath)) {
			console.error(
				chalk.red("  No memory database found. Run `signet setup` first."),
			);
			process.exit(1);
		}

		const spinner = ora("Loading session stats...").start();

		const db = new Database(dbPath, { readonly: true });
		try {
			loadSqliteVec(db);
		} catch {
			// Non-fatal
		}

		try {
			const trend = getSessionTrend(db, options.limit);
			db.close();
			spinner.stop();

			if (options.json) {
				console.log(JSON.stringify(trend, null, 2));
				return;
			}

			console.log();
			console.log(chalk.bold("  📈 Session Continuity Trend"));
			console.log();

			if (trend.sessions.length === 0) {
				console.log(
					chalk.dim(
						"  No session metrics recorded yet.",
					),
				);
				console.log(
					chalk.dim(
						"  Metrics are recorded at the end of each AI session.",
					),
				);
				console.log();
				return;
			}

			// -- Summary --
			const avgColor =
				trend.averageScore > 0.7
					? chalk.green
					: trend.averageScore > 0.4
						? chalk.yellow
						: chalk.red;

			const directionIcon =
				trend.direction === "improving"
					? chalk.green("↑ Improving")
					: trend.direction === "declining"
						? chalk.red("↓ Declining")
						: trend.direction === "stable"
							? chalk.blue("→ Stable")
							: chalk.dim("- Insufficient data");

			console.log(
				`  Average Score: ${avgColor(chalk.bold((trend.averageScore * 100).toFixed(1) + "%"))}  Trend: ${directionIcon}`,
			);
			console.log(
				`  Sessions analyzed: ${chalk.cyan(trend.sessions.length.toString())}`,
			);
			console.log();

			// -- Table --
			console.log(
				chalk.bold(
					"  " +
						"Session".padEnd(14) +
						"Score".padEnd(10) +
						"Injected".padEnd(10) +
						"Used".padEnd(8) +
						"Reconstructed".padEnd(15) +
						"New",
				),
			);
			console.log(chalk.dim("  " + "─".repeat(65)));

			for (const s of trend.sessions) {
				const scorePct = (s.continuityScore * 100).toFixed(0) + "%";
				const scoreColor =
					s.continuityScore > 0.7
						? chalk.green
						: s.continuityScore > 0.4
							? chalk.yellow
							: chalk.red;

				const sessionLabel = s.harness
					? s.harness.slice(0, 12)
					: s.sessionId.slice(0, 12);

				const dateStr = new Date(s.createdAt).toLocaleDateString("en-US", {
					month: "short",
					day: "numeric",
				});

				console.log(
					"  " +
						chalk.dim(dateStr.padEnd(14)) +
						scoreColor(scorePct.padEnd(10)) +
						s.memoriesInjected.toString().padEnd(10) +
						s.memoriesUsed.toString().padEnd(8) +
						s.factsReconstructed.toString().padEnd(15) +
						s.newMemories.toString(),
				);
			}

			console.log();

			// -- Mini chart (sparkline-style) --
			if (trend.sessions.length >= 3) {
				const reversed = [...trend.sessions].reverse(); // chronological order
				const sparkChars = " ▁▂▃▄▅▆▇█";
				const spark = reversed
					.map((s) => {
						const idx = Math.min(
							sparkChars.length - 1,
							Math.round(s.continuityScore * (sparkChars.length - 1)),
						);
						return sparkChars[idx];
					})
					.join("");
				console.log(`  Trend: ${chalk.cyan(spark)}`);
				console.log(
					chalk.dim("         oldest → newest"),
				);
				console.log();
			}
		} catch (err) {
			db.close();
			spinner.fail("Failed to load session stats");
			console.error(chalk.red(`  ${(err as Error).message}`));
			process.exit(1);
		}
	});

// ============================================================================
// signet embed - Embedding audit and backfill
// ============================================================================

const embedCmd = program
	.command("embed")
	.description("Embedding management (audit, backfill)");

embedCmd
	.command("audit")
	.description("Check embedding coverage for memories")
	.option("--json", "Output as JSON")
	.action(async (options) => {
		if (!(await ensureDaemonForSecrets())) return;

		const spinner = ora("Checking embedding coverage...").start();

		const { ok, data } = await secretApiCall(
			"GET",
			"/api/repair/embedding-gaps",
		);

		if (!ok || (data as { error?: string }).error) {
			spinner.fail((data as { error?: string }).error || "Audit failed");
			process.exit(1);
		}

		spinner.stop();

		const stats = data as {
			total: number;
			unembedded: number;
			coverage: string;
		};

		if (options.json) {
			console.log(JSON.stringify(stats, null, 2));
			return;
		}

		const embedded = stats.total - stats.unembedded;
		const coverageColor =
			stats.unembedded === 0
				? chalk.green
				: stats.unembedded > stats.total * 0.3
					? chalk.red
					: chalk.yellow;

		console.log(chalk.bold("\n  Embedding Coverage Audit\n"));
		console.log(`  Total memories:    ${chalk.cyan(stats.total)}`);
		console.log(`  Embedded:          ${chalk.green(embedded)}`);
		console.log(
			`  Missing:           ${stats.unembedded > 0 ? chalk.red(stats.unembedded) : chalk.green(0)}`,
		);
		console.log(`  Coverage:          ${coverageColor(stats.coverage)}`);
		console.log();

		if (stats.unembedded > 0) {
			console.log(
				chalk.dim(
					"  Run `signet embed backfill` to generate missing embeddings",
				),
			);
			console.log(
				chalk.dim(
					"  Run `signet embed backfill --dry-run` to preview without changes",
				),
			);
			console.log();
		}
	});

embedCmd
	.command("backfill")
	.description("Generate embeddings for memories that are missing them")
	.option("--dry-run", "Preview what would be embedded without making changes")
	.option(
		"--batch-size <n>",
		"Number of memories to embed per batch",
		parseInt,
		50,
	)
	.option("--json", "Output as JSON")
	.action(async (options) => {
		if (!(await ensureDaemonForSecrets())) return;

		const spinner = ora(
			options.dryRun
				? "Checking missing embeddings..."
				: "Backfilling embeddings...",
		).start();

		const { ok, data } = await secretApiCall("POST", "/api/repair/re-embed", {
			batchSize: options.batchSize,
			dryRun: !!options.dryRun,
		});

		if (!ok || (data as { error?: string }).error) {
			spinner.fail((data as { error?: string }).error || "Backfill failed");
			process.exit(1);
		}

		spinner.stop();

		const result = data as {
			action: string;
			success: boolean;
			affected: number;
			message: string;
		};

		if (options.json) {
			console.log(JSON.stringify(result, null, 2));
			return;
		}

		if (result.success) {
			if (options.dryRun) {
				console.log(chalk.bold("\n  Dry Run Results\n"));
			} else {
				console.log(chalk.bold("\n  Backfill Results\n"));
			}
			console.log(`  ${result.message}`);
			if (!options.dryRun && result.affected > 0) {
				console.log(
					chalk.dim(
						"\n  Run `signet embed audit` to check updated coverage",
					),
				);
			}
		} else {
			console.log(chalk.yellow(`\n  ${result.message}`));
		}
		console.log();
	});

// ============================================================================
// signet export / import - Portable agent bundles
// ============================================================================

program
	.command("export")
	.description("Export agent identity, memories, and skills to a portable bundle")
	.option("-o, --output <path>", "Output file path")
	.option("--include-embeddings", "Include embedding vectors (can be regenerated)")
	.option("--json", "Output as JSON instead of ZIP")
	.action(async (options) => {
		const {
			collectExportData,
			serializeExportData,
			loadSqliteVec,
		} = await import("@signet/core");

		const agentsDir = join(homedir(), ".agents");
		const dbPath = join(agentsDir, "memory", "memories.db");

		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found. Nothing to export."));
			process.exit(1);
		}

		const spinner = ora("Collecting export data...").start();

		const db = new Database(dbPath, { readonly: true });
		try {
			loadSqliteVec(db);
		} catch {
			// Non-fatal, vec extension may not be needed for export
		}

		const data = collectExportData(agentsDir, db, {
			includeEmbeddings: options.includeEmbeddings,
			includeSkills: true,
		});

		db.close();

		const fileMap = serializeExportData(data);

		const today = new Date().toISOString().slice(0, 10);
		const defaultName = `signet-export-${today}`;

		if (options.json) {
			const outPath = options.output || `${defaultName}.json`;
			writeFileSync(outPath, JSON.stringify(Object.fromEntries(fileMap), null, 2));
			spinner.succeed(`Exported to ${chalk.cyan(outPath)}`);
		} else {
			// Write as a directory bundle (ZIP requires additional dep)
			const outDir = options.output || defaultName;
			mkdirSync(outDir, { recursive: true });
			for (const [path, content] of fileMap) {
				const fullPath = join(outDir, path);
				mkdirSync(dirname(fullPath), { recursive: true });
				writeFileSync(fullPath, content);
			}
			spinner.succeed(`Exported to ${chalk.cyan(outDir + "/")}`);
		}

		console.log(chalk.dim(`  ${data.manifest.stats.memories} memories`));
		console.log(chalk.dim(`  ${data.manifest.stats.entities} entities`));
		console.log(chalk.dim(`  ${data.manifest.stats.relations} relations`));
		console.log(chalk.dim(`  ${data.manifest.stats.skills} skills`));
		console.log();
	});

program
	.command("import <path>")
	.description("Import agent data from an export bundle")
	.option(
		"--conflict <strategy>",
		"Conflict resolution: skip, overwrite, merge",
		"skip",
	)
	.option("--json", "Input is a JSON file instead of a directory")
	.action(async (importPath: string, options) => {
		const {
			importMemories,
			importEntities,
			importRelations,
			loadSqliteVec,
			runMigrations,
		} = await import("@signet/core");

		const agentsDir = join(homedir(), ".agents");
		const dbPath = join(agentsDir, "memory", "memories.db");

		if (!existsSync(importPath)) {
			console.error(chalk.red(`  Path not found: ${importPath}`));
			process.exit(1);
		}

		const spinner = ora("Importing agent data...").start();

		let fileMap: Map<string, string>;

		if (options.json || importPath.endsWith(".json")) {
			const raw = readFileSync(importPath, "utf-8");
			const obj = JSON.parse(raw) as Record<string, string>;
			fileMap = new Map(Object.entries(obj));
		} else {
			fileMap = new Map();
			loadDirRecursive(importPath, "", fileMap);
		}

		// Write identity files
		let identityCount = 0;
		for (const [path, content] of fileMap) {
			if (path.startsWith("identity/")) {
				const name = path.replace("identity/", "");
				const destPath = join(agentsDir, name);
				writeFileSync(destPath, content);
				identityCount++;
			}
		}

		if (fileMap.has("agent.yaml")) {
			writeFileSync(join(agentsDir, "agent.yaml"), fileMap.get("agent.yaml")!);
		}

		// Import database records
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		const db = new Database(dbPath);
		try {
			loadSqliteVec(db);
		} catch {
			// Non-fatal
		}
		runMigrations(db);

		const memResult = fileMap.has("memories.jsonl")
			? importMemories(db, fileMap.get("memories.jsonl")!, {
					conflictStrategy: options.conflict as "skip" | "overwrite" | "merge",
				})
			: { imported: 0, skipped: 0 };

		const entityCount = fileMap.has("entities.jsonl")
			? importEntities(db, fileMap.get("entities.jsonl")!)
			: 0;

		const relationCount = fileMap.has("relations.jsonl")
			? importRelations(db, fileMap.get("relations.jsonl")!)
			: 0;

		db.close();

		// Write skill files
		let skillCount = 0;
		const skillsDir = join(agentsDir, "skills");
		for (const [path, content] of fileMap) {
			if (path.startsWith("skills/")) {
				const destPath = join(agentsDir, path);
				mkdirSync(dirname(destPath), { recursive: true });
				writeFileSync(destPath, content);
				skillCount++;
			}
		}

		spinner.succeed("Import complete");
		console.log(chalk.dim(`  ${memResult.imported} memories imported`));
		if (memResult.skipped > 0) {
			console.log(chalk.dim(`  ${memResult.skipped} memories skipped (conflict: ${options.conflict})`));
		}
		console.log(chalk.dim(`  ${entityCount} entities imported`));
		console.log(chalk.dim(`  ${relationCount} relations imported`));
		console.log(chalk.dim(`  ${identityCount} identity files written`));
		if (skillCount > 0) {
			console.log(chalk.dim(`  ${skillCount} skill files written`));
		}
		console.log();
	});

function loadDirRecursive(
	dir: string,
	prefix: string,
	out: Map<string, string>,
): void {
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			loadDirRecursive(fullPath, relPath, out);
		} else {
			try {
				out.set(relPath, readFileSync(fullPath, "utf-8"));
			} catch {
				// Skip binary files
			}
		}
	}
}

// ============================================================================
// signet hook - Lifecycle hooks for harness integration
// ============================================================================

const hookCmd = program
	.command("hook")
	.description("Lifecycle hooks for harness integration");

// signet hook session-start
hookCmd
	.command("session-start")
	.description("Get context/memories for a new session")
	.requiredOption("-H, --harness <harness>", "Harness name")
	.option("--project <project>", "Project path")
	.option("--agent-id <id>", "Agent ID")
	.option("--context <context>", "Additional context")
	.option("--json", "Output as JSON")
	.action(async (options) => {
		const data = await fetchFromDaemon<{
			identity?: { name: string; description?: string };
			memories?: Array<{ content: string }>;
			inject?: string;
			error?: string;
		}>("/api/hooks/session-start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness: options.harness,
				project: options.project,
				agentId: options.agentId,
				context: options.context,
			}),
		});

		if (!data) {
			process.stderr.write("[signet] daemon not running, hook skipped\n");
			process.exit(0);
		}

		if (data.error) {
			console.error(chalk.red(`Error: ${data.error}`));
			process.exit(1);
		}

		if (options.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			if (data.inject) {
				console.log(data.inject);
			}
		}
	});

// signet hook user-prompt-submit
hookCmd
	.command("user-prompt-submit")
	.description("Get relevant memories for a user prompt")
	.requiredOption("-H, --harness <harness>", "Harness name")
	.option("--project <project>", "Project path")
	.action(async (options) => {
		let userPrompt = "";
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of process.stdin) {
				chunks.push(chunk);
			}
			const input = Buffer.concat(chunks).toString("utf-8").trim();
			if (input) {
				const parsed = JSON.parse(input);
				userPrompt = parsed.user_prompt || parsed.userPrompt || "";
			}
		} catch {
			// No stdin or invalid JSON
		}

		const data = await fetchFromDaemon<{
			inject?: string;
			memoryCount?: number;
			error?: string;
		}>("/api/hooks/user-prompt-submit", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness: options.harness,
				project: options.project,
				userPrompt,
			}),
		});

		if (!data) {
			process.stderr.write("[signet] daemon not running, hook skipped\n");
			process.exit(0);
		}

		if (data.inject) {
			console.log(data.inject);
		}
	});

// signet hook session-end
hookCmd
	.command("session-end")
	.description("Extract and save memories from session transcript")
	.requiredOption("-H, --harness <harness>", "Harness name")
	.action(async (options) => {
		let body: Record<string, string> = {};
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of process.stdin) {
				chunks.push(chunk);
			}
			const input = Buffer.concat(chunks).toString("utf-8").trim();
			if (input) {
				body = JSON.parse(input);
			}
		} catch {
			// No stdin or invalid JSON
		}

		const data = await fetchFromDaemon<{
			memoriesSaved?: number;
			error?: string;
		}>("/api/hooks/session-end", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness: options.harness,
				transcriptPath: body.transcript_path || body.transcriptPath,
				sessionId: body.session_id || body.sessionId,
				cwd: body.cwd,
				reason: body.reason,
			}),
			timeout: 60000,
		});

		if (!data) {
			process.stderr.write("[signet] daemon not running, hook skipped\n");
			process.exit(0);
		}

		if (data.memoriesSaved !== undefined && data.memoriesSaved > 0) {
			process.stderr.write(`[signet] ${data.memoriesSaved} memories saved\n`);
		}
	});

// signet hook pre-compaction
hookCmd
	.command("pre-compaction")
	.description("Get summary instructions before session compaction")
	.requiredOption("-H, --harness <harness>", "Harness name")
	.option("--message-count <count>", "Number of messages in session", parseInt)
	.option("--json", "Output as JSON")
	.action(async (options) => {
		const data = await fetchFromDaemon<{
			summaryPrompt?: string;
			guidelines?: string;
			error?: string;
		}>("/api/hooks/pre-compaction", {
			method: "POST",
			body: JSON.stringify({
				harness: options.harness,
				messageCount: options.messageCount,
			}),
		});

		if (data?.error) {
			console.error(chalk.red(`Error: ${data.error}`));
			process.exit(1);
		}

		if (options.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			if (data?.summaryPrompt) {
				console.log(data.summaryPrompt);
			}
		}
	});

// signet hook compaction-complete
hookCmd
	.command("compaction-complete")
	.description("Save session summary after compaction")
	.requiredOption("-H, --harness <harness>", "Harness name")
	.requiredOption("-s, --summary <summary>", "Session summary text")
	.action(async (options) => {
		const data = await fetchFromDaemon<{
			success?: boolean;
			memoryId?: number;
			error?: string;
		}>("/api/hooks/compaction-complete", {
			method: "POST",
			body: JSON.stringify({
				harness: options.harness,
				summary: options.summary,
			}),
		});

		if (data?.error) {
			console.error(chalk.red(`Error: ${data.error}`));
			process.exit(1);
		}

		if (data?.success) {
			console.log(chalk.green("✓ Summary saved"));
			if (data.memoryId) {
				console.log(chalk.dim(`  Memory ID: ${data.memoryId}`));
			}
		}
	});

// signet hook synthesis
hookCmd
	.command("synthesis")
	.description(
		"Request MEMORY.md synthesis (returns prompt for configured harness)",
	)
	.option("--json", "Output as JSON")
	.action(async (options) => {
		// First get the config
		const config = await fetchFromDaemon<{
			harness?: string;
			model?: string;
			error?: string;
		}>("/api/hooks/synthesis/config");

		// Then get the synthesis request
		const data = await fetchFromDaemon<{
			harness?: string;
			model?: string;
			prompt?: string;
			memories?: Array<{ content: string }>;
			error?: string;
		}>("/api/hooks/synthesis", {
			method: "POST",
			body: JSON.stringify({ trigger: "manual" }),
		});

		if (data?.error) {
			console.error(chalk.red(`Error: ${data.error}`));
			process.exit(1);
		}

		if (options.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			console.log(chalk.bold("MEMORY.md Synthesis Request\n"));
			console.log(chalk.dim(`Harness: ${data?.harness}`));
			console.log(chalk.dim(`Model: ${data?.model}`));
			console.log(chalk.dim(`Memories: ${data?.memories?.length || 0}\n`));
			console.log(data?.prompt);
		}
	});

// signet hook synthesis-complete
hookCmd
	.command("synthesis-complete")
	.description("Save synthesized MEMORY.md content")
	.requiredOption("-c, --content <content>", "Synthesized MEMORY.md content")
	.action(async (options) => {
		const data = await fetchFromDaemon<{
			success?: boolean;
			error?: string;
		}>("/api/hooks/synthesis/complete", {
			method: "POST",
			body: JSON.stringify({ content: options.content }),
		});

		if (data?.error) {
			console.error(chalk.red(`Error: ${data.error}`));
			process.exit(1);
		}

		if (data?.success) {
			console.log(chalk.green("✓ MEMORY.md synthesized"));
		}
	});

// ============================================================================
// Update Commands
// ============================================================================

const updateCmd = program
	.command("update")
	.description("Check, install, and manage auto-updates");

const MIN_AUTO_UPDATE_INTERVAL = 300;
const MAX_AUTO_UPDATE_INTERVAL = 604800;

// signet update check
updateCmd
	.command("check")
	.description("Check for available updates")
	.option("-f, --force", "Force check (ignore cache)")
	.action(async (options) => {
		const spinner = ora("Checking for updates...").start();

		const data = await fetchFromDaemon<{
			currentVersion?: string;
			latestVersion?: string;
			updateAvailable?: boolean;
			releaseUrl?: string;
			releaseNotes?: string;
			publishedAt?: string;
			checkError?: string;
			cached?: boolean;
			restartRequired?: boolean;
			pendingVersion?: string;
		}>(`/api/update/check${options.force ? "?force=true" : ""}`);

		if (!data) {
			spinner.fail("Could not connect to daemon");
			return;
		}

		if (data?.checkError) {
			spinner.warn("Could not fully check for updates");
			console.log(chalk.dim(`  Error: ${data.checkError}`));
			if (!data.restartRequired) {
				return;
			}
		}

		if (data?.updateAvailable) {
			spinner.succeed(chalk.green(`Update available: v${data.latestVersion}`));
			console.log(chalk.dim(`  Current: v${data.currentVersion}`));
			if (data.restartRequired && data.pendingVersion) {
				console.log(
					chalk.dim(
						`  Pending restart: v${data.pendingVersion} already installed`,
					),
				);
			}
			if (data.publishedAt) {
				console.log(
					chalk.dim(
						`  Released: ${new Date(data.publishedAt).toLocaleDateString()}`,
					),
				);
			}
			if (data.releaseUrl) {
				console.log(chalk.dim(`  ${data.releaseUrl}`));
			}
			console.log(chalk.cyan("\n  Run: signet update install"));
		} else if (data.restartRequired) {
			spinner.succeed(
				chalk.yellow(
					`Update installed: v${data.pendingVersion || data.latestVersion}. Restart required.`,
				),
			);
			console.log(
				chalk.cyan("\n  Restart daemon to apply: signet daemon restart"),
			);
		} else {
			spinner.succeed("Already up to date");
			console.log(chalk.dim(`  Version: v${data?.currentVersion}`));
		}
	});

// signet update install
updateCmd
	.command("install")
	.description("Install the latest update")
	.action(async () => {
		// First check if update available
		const check = await fetchFromDaemon<{
			updateAvailable?: boolean;
			latestVersion?: string;
			restartRequired?: boolean;
			pendingVersion?: string;
		}>("/api/update/check?force=true");

		if (!check) {
			console.error(chalk.red("Could not connect to daemon"));
			process.exit(1);
		}

		if (check.restartRequired && !check.updateAvailable) {
			console.log(
				chalk.yellow(
					`✓ Update already installed (v${check.pendingVersion || check.latestVersion})`,
				),
			);
			console.log(
				chalk.cyan("  Restart daemon to apply: signet daemon restart"),
			);
			return;
		}

		if (!check?.updateAvailable) {
			console.log(chalk.green("✓ Already running the latest version"));
			return;
		}

		console.log(chalk.cyan(`Installing v${check.latestVersion}...`));
		const spinner = ora("Downloading and installing...").start();

		const data = await fetchFromDaemon<{
			success?: boolean;
			message?: string;
			output?: string;
			restartRequired?: boolean;
			installedVersion?: string;
		}>("/api/update/run", { method: "POST" });

		if (!data?.success) {
			spinner.fail(data?.message || "Update failed");
			if (data?.output) {
				console.log(chalk.dim(data.output));
			}
			process.exit(1);
		}

		spinner.succeed(data.message || "Update installed");

		// Auto-sync skills and re-register hooks after update
		try {
			const templatesDir = getTemplatesDir();
			const skillResult = syncBuiltinSkills(templatesDir, AGENTS_DIR);
			const totalSynced =
				skillResult.installed.length + skillResult.updated.length;
			if (totalSynced > 0) {
				console.log(chalk.green(`  ✓ ${totalSynced} skills synced`));
			}

			const harnesses: string[] = [];
			if (existsSync(join(homedir(), ".claude", "settings.json"))) {
				harnesses.push("claude-code");
			}
			if (existsSync(join(homedir(), ".config", "opencode"))) {
				harnesses.push("opencode");
			}
			const oc = new OpenClawConnector();
			if (oc.isInstalled()) {
				harnesses.push("openclaw");
			}

			for (const h of harnesses) {
				try {
					await configureHarnessHooks(h, AGENTS_DIR);
					console.log(chalk.green(`  ✓ hooks re-registered for ${h}`));
				} catch {
					// Non-fatal
				}
			}
		} catch {
			// Non-fatal: skill sync after update is best-effort
		}

		if (data.restartRequired) {
			console.log(
				chalk.cyan("\n  Restart daemon to apply: signet daemon restart"),
			);
		}
	});

// signet update status
updateCmd
	.command("status")
	.description("Show auto-update settings and status")
	.action(async () => {
		const data = await fetchFromDaemon<{
			autoInstall?: boolean;
			checkInterval?: number;
			pendingRestartVersion?: string;
			lastAutoUpdateAt?: string;
			lastAutoUpdateError?: string;
			updateInProgress?: boolean;
		}>("/api/update/config");

		if (!data) {
			console.error(chalk.red("Failed to get update status"));
			process.exit(1);
		}

		console.log(chalk.bold("Update Status\n"));
		console.log(
			`  ${chalk.dim("Auto-install:")} ${data.autoInstall ? chalk.green("enabled") : chalk.dim("disabled")}`,
		);
		console.log(
			`  ${chalk.dim("Interval:")}     every ${data.checkInterval || "?"}s`,
		);
		console.log(
			`  ${chalk.dim("In progress:")}  ${data.updateInProgress ? chalk.yellow("yes") : chalk.dim("no")}`,
		);

		if (data.pendingRestartVersion) {
			console.log(
				`  ${chalk.dim("Pending:")}      v${data.pendingRestartVersion} (restart required)`,
			);
		}

		if (data.lastAutoUpdateAt) {
			console.log(
				`  ${chalk.dim("Last success:")} ${new Date(data.lastAutoUpdateAt).toLocaleString()}`,
			);
		}

		if (data.lastAutoUpdateError) {
			console.log(
				`  ${chalk.dim("Last error:")}   ${chalk.yellow(data.lastAutoUpdateError)}`,
			);
		}
	});

// signet update enable
updateCmd
	.command("enable")
	.description("Enable unattended auto-update installs")
	.option(
		"-i, --interval <seconds>",
		`Check interval in seconds (${MIN_AUTO_UPDATE_INTERVAL}-${MAX_AUTO_UPDATE_INTERVAL})`,
		"21600",
	)
	.action(async (options) => {
		const interval = Number.parseInt(options.interval, 10);
		if (
			!Number.isFinite(interval) ||
			interval < MIN_AUTO_UPDATE_INTERVAL ||
			interval > MAX_AUTO_UPDATE_INTERVAL
		) {
			console.error(
				chalk.red(
					`Interval must be between ${MIN_AUTO_UPDATE_INTERVAL} and ${MAX_AUTO_UPDATE_INTERVAL} seconds`,
				),
			);
			process.exit(1);
		}

		const data = await fetchFromDaemon<{
			success?: boolean;
			config?: { autoInstall: boolean; checkInterval: number };
			persisted?: boolean;
		}>("/api/update/config", {
			method: "POST",
			body: JSON.stringify({
				autoInstall: true,
				checkInterval: interval,
			}),
		});

		if (!data?.success) {
			console.error(chalk.red("Failed to enable auto-update"));
			process.exit(1);
		}

		console.log(chalk.green("✓ Auto-update enabled"));
		console.log(chalk.dim(`  Interval: every ${interval}s`));
		console.log(chalk.dim("  Updates install in the background"));
		if (data.persisted === false) {
			console.log(
				chalk.yellow("  ⚠ Could not persist updates block to agent.yaml"),
			);
		}
	});

// signet update disable
updateCmd
	.command("disable")
	.description("Disable unattended auto-update installs")
	.action(async () => {
		const data = await fetchFromDaemon<{
			success?: boolean;
			persisted?: boolean;
		}>("/api/update/config", {
			method: "POST",
			body: JSON.stringify({ autoInstall: false }),
		});

		if (!data?.success) {
			console.error(chalk.red("Failed to disable auto-update"));
			process.exit(1);
		}

		console.log(chalk.green("✓ Auto-update disabled"));
		if (data.persisted === false) {
			console.log(
				chalk.yellow("  ⚠ Could not persist updates block to agent.yaml"),
			);
		}
	});

// Shortcut: signet update (same as signet update check)
updateCmd.action(async () => {
	const spinner = ora("Checking for updates...").start();

	const data = await fetchFromDaemon<{
		currentVersion?: string;
		latestVersion?: string;
		updateAvailable?: boolean;
		releaseUrl?: string;
		checkError?: string;
		restartRequired?: boolean;
		pendingVersion?: string;
	}>("/api/update/check?force=true");

	if (!data) {
		spinner.fail("Could not connect to daemon");
		return;
	}

	if (data?.checkError) {
		spinner.warn("Could not fully check for updates");
		console.log(chalk.dim(`  Error: ${data.checkError}`));
		if (!data.restartRequired) {
			return;
		}
	}

	if (data?.updateAvailable) {
		spinner.succeed(chalk.green(`Update available: v${data.latestVersion}`));
		console.log(chalk.dim(`  Current: v${data.currentVersion}`));
		console.log(chalk.cyan("\n  Run: signet update install"));
	} else if (data.restartRequired) {
		spinner.succeed(
			chalk.yellow(
				`Update installed: v${data.pendingVersion || data.latestVersion}. Restart required.`,
			),
		);
		console.log(chalk.cyan("\n  Run: signet daemon restart"));
	} else {
		spinner.succeed("Already up to date");
		console.log(chalk.dim(`  Version: v${data?.currentVersion}`));
	}
});

// ============================================================================
// Git Sync Commands
// ============================================================================

const gitCmd = program.command("git").description("Git sync management");

// signet git status
gitCmd
	.command("status")
	.description("Show git sync status")
	.action(async () => {
		const data = await fetchFromDaemon<{
			isRepo?: boolean;
			branch?: string;
			remote?: string;
			hasToken?: boolean;
			autoSync?: boolean;
			lastSync?: string;
			uncommittedChanges?: number;
			unpushedCommits?: number;
		}>("/api/git/status");

		if (!data) {
			console.error(chalk.red("Failed to get git status"));
			process.exit(1);
		}

		console.log(chalk.bold("Git Status\n"));

		if (!data.isRepo) {
			console.log(chalk.yellow("  Not a git repository"));
			console.log(chalk.dim("  Run: cd ~/.agents && git init"));
			return;
		}

		console.log(`  ${chalk.dim("Branch:")}     ${data.branch || "unknown"}`);
		console.log(`  ${chalk.dim("Remote:")}     ${data.remote || "none"}`);
		console.log(
			`  ${chalk.dim("Token:")}      ${data.hasToken ? chalk.green("configured") : chalk.yellow("not set")}`,
		);
		console.log(
			`  ${chalk.dim("Auto-sync:")}  ${data.autoSync ? chalk.green("enabled") : chalk.dim("disabled")}`,
		);

		if (data.lastSync) {
			console.log(`  ${chalk.dim("Last sync:")}  ${data.lastSync}`);
		}

		if (data.uncommittedChanges !== undefined && data.uncommittedChanges > 0) {
			console.log(
				`  ${chalk.dim("Uncommitted:")} ${chalk.yellow(data.uncommittedChanges + " changes")}`,
			);
		}

		if (data.unpushedCommits !== undefined && data.unpushedCommits > 0) {
			console.log(
				`  ${chalk.dim("Unpushed:")}   ${chalk.cyan(data.unpushedCommits + " commits")}`,
			);
		}

		if (!data.hasToken) {
			console.log(
				chalk.dim("\n  To enable sync: signet secret put GITHUB_TOKEN"),
			);
		}
	});

// signet git sync
gitCmd
	.command("sync")
	.description("Sync with remote (pull + push)")
	.action(async () => {
		const spinner = ora("Syncing with remote...").start();

		const data = await fetchFromDaemon<{
			success?: boolean;
			message?: string;
			pulled?: number;
			pushed?: number;
		}>("/api/git/sync", { method: "POST" });

		if (!data?.success) {
			spinner.fail(data?.message || "Sync failed");
			process.exit(1);
		}

		spinner.succeed("Sync complete");
		console.log(chalk.dim(`  Pulled: ${data.pulled || 0} commits`));
		console.log(chalk.dim(`  Pushed: ${data.pushed || 0} commits`));
	});

// signet git pull
gitCmd
	.command("pull")
	.description("Pull changes from remote")
	.action(async () => {
		const spinner = ora("Pulling from remote...").start();

		const data = await fetchFromDaemon<{
			success?: boolean;
			message?: string;
			changes?: number;
		}>("/api/git/pull", { method: "POST" });

		if (!data?.success) {
			spinner.fail(data?.message || "Pull failed");
			process.exit(1);
		}

		spinner.succeed(data.message || "Pull complete");
		if (data.changes !== undefined) {
			console.log(chalk.dim(`  ${data.changes} commits`));
		}
	});

// signet git push
gitCmd
	.command("push")
	.description("Push changes to remote")
	.action(async () => {
		const spinner = ora("Pushing to remote...").start();

		const data = await fetchFromDaemon<{
			success?: boolean;
			message?: string;
			changes?: number;
		}>("/api/git/push", { method: "POST" });

		if (!data?.success) {
			spinner.fail(data?.message || "Push failed");
			process.exit(1);
		}

		spinner.succeed(data.message || "Push complete");
		if (data.changes !== undefined) {
			console.log(chalk.dim(`  ${data.changes} commits`));
		}
	});

// signet git enable
gitCmd
	.command("enable")
	.description("Enable auto-sync")
	.option("-i, --interval <seconds>", "Sync interval in seconds", "300")
	.action(async (options) => {
		const data = await fetchFromDaemon<{
			success?: boolean;
			config?: { autoSync: boolean; syncInterval: number };
		}>("/api/git/config", {
			method: "POST",
			body: JSON.stringify({
				autoSync: true,
				syncInterval: parseInt(options.interval, 10),
			}),
		});

		if (!data?.success) {
			console.error(chalk.red("Failed to enable auto-sync"));
			process.exit(1);
		}

		console.log(chalk.green("✓ Auto-sync enabled"));
		console.log(chalk.dim(`  Interval: every ${options.interval}s`));
	});

// signet git disable
gitCmd
	.command("disable")
	.description("Disable auto-sync")
	.action(async () => {
		const data = await fetchFromDaemon<{
			success?: boolean;
		}>("/api/git/config", {
			method: "POST",
			body: JSON.stringify({ autoSync: false }),
		});

		if (!data?.success) {
			console.error(chalk.red("Failed to disable auto-sync"));
			process.exit(1);
		}

		console.log(chalk.green("✓ Auto-sync disabled"));
	});

// ============================================================================
// signet migrate-vectors - Migrate BLOB vectors to sqlite-vec
// ============================================================================

interface MigrationSource {
	type: "zvec" | "blob" | "vec_table";
	path: string;
	count: number;
}

async function detectVectorSources(
	basePath: string,
): Promise<MigrationSource[]> {
	const sources: MigrationSource[] = [];
	const memoryDir = join(basePath, "memory");

	// Check for old Python zvec store
	const zvecPath = join(memoryDir, "vectors.zvec");
	if (existsSync(zvecPath)) {
		try {
			statSync(zvecPath);
			sources.push({
				type: "zvec",
				path: zvecPath,
				count: 0, // Would need to parse zvec to count
			});
		} catch {
			// Ignore
		}
	}

	// Check for BLOB vectors in memories.db
	const dbPath = join(memoryDir, "memories.db");
	if (existsSync(dbPath)) {
		try {
			const db = new Database(dbPath, { readonly: true });

			// Check if embeddings table exists with BLOB vectors
			const tableCheck = db
				.prepare(`
				SELECT name FROM sqlite_master
				WHERE type='table' AND name='embeddings'
			`)
				.get();

			if (tableCheck) {
				// Check if vector column is BLOB (old format)
				const schemaCheck = db
					.prepare(`PRAGMA table_info(embeddings)`)
					.all() as Array<{
					name: string;
					type: string;
				}>;
				const vectorCol = schemaCheck.find((c) => c.name === "vector");

				if (vectorCol && vectorCol.type === "BLOB") {
					const countResult = db
						.prepare(`SELECT COUNT(*) as count FROM embeddings`)
						.get() as { count: number };
					if (countResult.count > 0) {
						sources.push({
							type: "blob",
							path: dbPath,
							count: countResult.count,
						});
					}
				}

				// Check if vec_embeddings virtual table already exists
				const vecTableCheck = db
					.prepare(`
					SELECT name FROM sqlite_master
					WHERE type='table' AND name='vec_embeddings'
				`)
					.get();

				if (vecTableCheck) {
					const vecCountResult = db
						.prepare(`SELECT COUNT(*) as count FROM vec_embeddings`)
						.get() as { count: number };
					if (vecCountResult.count > 0) {
						sources.push({
							type: "vec_table",
							path: dbPath,
							count: vecCountResult.count,
						});
					}
				}
			}

			db.close();
		} catch {
			// Ignore errors
		}
	}

	return sources;
}

// ============================================================================
// DID & Web3 Identity Commands
// ============================================================================

const didCmd = program.command("did").description("Manage agent decentralized identity (DID)");

didCmd
	.command("init")
	.description("Initialize agent DID (generates keypair if needed)")
	.action(async () => {
		const { initializeAgentDid } = await import("@signet/core");
		console.log(signetLogo());
		console.log(chalk.bold("  DID Initialization\n"));

		const spinner = ora("  Generating identity...").start();
		try {
			const result = await initializeAgentDid();
			spinner.succeed("Identity initialized");
			console.log();

			if (result.keypairGenerated) {
				console.log(chalk.green("  ✓ Ed25519 signing keypair generated"));
			} else {
				console.log(chalk.dim("  ✓ Existing keypair found"));
			}
			console.log(chalk.green(`  ✓ DID: ${chalk.cyan(result.didShort)}`));
			if (result.yamlUpdated) {
				console.log(chalk.green("  ✓ agent.yaml updated with DID"));
			}
			console.log(chalk.green(`  ✓ DID Document: ${result.didDocumentPath}`));
			console.log();
			console.log(chalk.dim("  Full DID:"));
			console.log(chalk.cyan(`  ${result.did}`));
		} catch (err) {
			spinner.fail("Failed to initialize DID");
			console.error(chalk.red(`  ${(err as Error).message}`));
			process.exit(1);
		}
	});

didCmd
	.command("show")
	.description("Display the agent's DID")
	.option("--full", "Show full DID (not abbreviated)")
	.action(async (options) => {
		const { getConfiguredDid, formatDidShort } = await import("@signet/core");

		const did = getConfiguredDid();
		if (!did) {
			console.log(chalk.yellow("  No DID configured. Run: signet did init"));
			process.exit(1);
		}

		if (options.full) {
			console.log(did);
		} else {
			console.log(formatDidShort(did));
		}
	});

didCmd
	.command("document")
	.description("Export the agent's DID Document (JSON)")
	.option("-o, --output <path>", "Write to file instead of stdout")
	.action(async (options) => {
		const { getConfiguredDid, didToPublicKey, generateDidDocument } = await import("@signet/core");
		// writeFileSync already imported at top of file (line 24)

		const did = getConfiguredDid();
		if (!did) {
			console.log(chalk.yellow("  No DID configured. Run: signet did init"));
			process.exit(1);
		}

		const publicKey = didToPublicKey(did);

		// Verify the keypair on disk still matches the configured DID
		const { hasSigningKeypair, getPublicKeyBytes } = await import("@signet/core");
		if (hasSigningKeypair()) {
			try {
				const storedPub = await getPublicKeyBytes();
				const didPub = publicKey;
				if (storedPub.length !== didPub.length || !storedPub.every((b, i) => b === didPub[i])) {
					console.error(chalk.red("  ⚠ Warning: keypair on disk does not match configured DID!"));
					console.error(chalk.red("    The DID Document may be stale. Run: signet did init"));
				}
			} catch {
				// Keypair load failed — warning only, don't block document export
			}
		}

		const doc = generateDidDocument(did, publicKey);
		const json = JSON.stringify(doc, null, 2);

		if (options.output) {
			writeFileSync(options.output, json);
			console.log(chalk.green(`  ✓ DID Document written to ${options.output}`));
		} else {
			console.log(json);
		}
	});

didCmd
	.command("verify")
	.description("Verify the agent's keypair and DID consistency")
	.action(async () => {
		try {
		const {
			hasSigningKeypair,
			getPublicKeyBytes,
			signContent,
			verifySignature,
			getConfiguredDid,
			publicKeyToDid,
		} = await import("@signet/core");

		console.log(signetLogo());
		console.log(chalk.bold("  DID Verification\n"));

		// Check keypair
		if (!hasSigningKeypair()) {
			console.log(chalk.red("  ✗ No signing keypair found"));
			console.log(chalk.dim("  Run: signet did init"));
			process.exit(1);
		}
		console.log(chalk.green("  ✓ Signing keypair exists"));

		// Check DID in config
		const configDid = getConfiguredDid();
		if (!configDid) {
			console.log(chalk.yellow("  ⚠ No DID in agent.yaml"));
		} else {
			console.log(chalk.green(`  ✓ DID in config: ${configDid.slice(0, 30)}...`));
		}

		// Verify keypair derives the same DID
		const pubKey = await getPublicKeyBytes();
		const derivedDid = publicKeyToDid(pubKey);
		if (configDid && configDid !== derivedDid) {
			console.log(chalk.red("  ✗ DID mismatch! Config DID doesn't match keypair."));
			console.log(chalk.dim(`    Config:  ${configDid}`));
			console.log(chalk.dim(`    Derived: ${derivedDid}`));
			process.exit(1);
		}
		console.log(chalk.green("  ✓ DID matches keypair"));

		// Test sign/verify round-trip
		const testMessage = "signet-did-verification-test";
		const sig = await signContent(testMessage);
		const valid = await verifySignature(testMessage, sig, pubKey);
		if (!valid) {
			console.log(chalk.red("  ✗ Sign/verify round-trip FAILED"));
			process.exit(1);
		}
		console.log(chalk.green("  ✓ Sign/verify round-trip passed"));
		console.log();
		console.log(chalk.green.bold("  All checks passed ✓"));
		} catch (err) {
			console.error(chalk.red(`  ✗ Verification failed: ${err instanceof Error ? err.message : String(err)}`));
			process.exit(1);
		}
	});

// ============================================================================
// Memory Signing Commands
// ============================================================================

const memoryCmd = program.command("memory").description("Memory provenance and verification");

memoryCmd
	.command("sign-backfill")
	.description("Sign all unsigned memories with the agent's keypair")
	.option("--dry-run", "Show what would be signed without making changes")
	.action(async (options) => {
		const { hasSigningKeypair, signContent, getPublicKeyBytes, buildSignablePayload } = await import("@signet/core");
		const { publicKeyToDid } = await import("@signet/core");

		console.log(signetLogo());
		console.log(chalk.bold("  Memory Signing Backfill\n"));

		if (!hasSigningKeypair()) {
			console.log(chalk.red("  No signing keypair found. Run: signet did init"));
			process.exit(1);
		}

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.log(chalk.yellow("  No memories database found."));
			return;
		}

		// Resolve crypto BEFORE opening DB — if these throw, no DB handle to leak
		const pubKey = await getPublicKeyBytes();
		const did = publicKeyToDid(pubKey);

		const db = new Database(dbPath);
		try {
			// Count unsigned memories
			const countRow = db.prepare(
				"SELECT COUNT(*) as count FROM memories WHERE signature IS NULL AND is_deleted = 0 AND content_hash IS NOT NULL"
			).get() as { count: number } | undefined;
			const unsignedCount = countRow?.count ?? 0;

			if (unsignedCount === 0) {
				console.log(chalk.green("  All memories are already signed ✓"));
				return;
			}

			console.log(chalk.dim(`  Found ${unsignedCount} unsigned memories`));

			if (options.dryRun) {
				console.log(chalk.yellow(`  Dry run: would sign ${unsignedCount} memories`));
				return;
			}

			const spinner = ora(`  Signing ${unsignedCount} memories...`).start();

			// Fetch unsigned memories
			const rows = db.prepare(
				"SELECT id, content_hash, created_at FROM memories WHERE signature IS NULL AND is_deleted = 0 AND content_hash IS NOT NULL"
			).all() as Array<{ id: string; content_hash: string; created_at: string }>;

			let signed = 0;
			let failed = 0;

			const updateStmt = db.prepare(
				"UPDATE memories SET signature = ?, signer_did = ? WHERE id = ?"
			);

			// Sign in batches with transactions for performance
			// (individual UPDATEs without explicit tx = ~1000x slower)
			const BATCH_SIZE = 500;
			for (let i = 0; i < rows.length; i += BATCH_SIZE) {
				const batch = rows.slice(i, i + BATCH_SIZE);

				// Sign all in batch (async, outside transaction)
				const signedBatch: Array<{ signature: string; id: string }> = [];
				for (const row of batch) {
					try {
						// Use core's buildSignablePayload for validation + single source of truth
						const payload = buildSignablePayload(row.content_hash, row.created_at, did);
						const signature = await signContent(payload);
						signedBatch.push({ signature, id: row.id });
						signed++;
					} catch {
						failed++;
					}
				}

				// Write batch in single transaction
				db.transaction(() => {
					for (const s of signedBatch) {
						updateStmt.run(s.signature, did, s.id);
					}
				})();

				spinner.text = `  Signing memories... ${signed}/${unsignedCount}`;
			}

			spinner.succeed(`Signed ${signed} memories`);
			if (failed > 0) {
				console.log(chalk.yellow(`  ⚠ ${failed} memories failed to sign`));
			}
		} finally {
			db.close();
		}
	});

memoryCmd
	.command("verify-signatures")
	.description("Verify signatures of signed memories")
	.option("--limit <n>", "Maximum number to verify", "100")
	.action(async (options) => {
		const { verifySignature, buildSignablePayload, buildSignablePayloadV2 } = await import("@signet/core");
		const { didToPublicKey } = await import("@signet/core");

		console.log(signetLogo());
		console.log(chalk.bold("  Memory Signature Verification\n"));

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.log(chalk.yellow("  No memories database found."));
			return;
		}

		const db = new Database(dbPath);
		try {
			const limit = parseInt(options.limit, 10) || 100;

			const rows = db.prepare(
				`SELECT id, content_hash, created_at, signature, signer_did
				 FROM memories
				 WHERE signature IS NOT NULL
				 ORDER BY created_at DESC
				 LIMIT ?`
			).all(limit) as Array<{
				id: string;
				content_hash: string;
				created_at: string;
				signature: string;
				signer_did: string;
			}>;

			if (rows.length === 0) {
				console.log(chalk.yellow("  No signed memories found."));
				return;
			}

			let valid = 0;
			let invalid = 0;
			const spinner = ora(`  Verifying ${rows.length} signatures...`).start();

			for (const row of rows) {
				try {
					const pubKey = didToPublicKey(row.signer_did);
					// Try v2 format first (includes memory ID), fall back to v1
					const v2Payload = buildSignablePayloadV2(row.id, row.content_hash, row.created_at, row.signer_did);
					let isValid = await verifySignature(v2Payload, row.signature, pubKey);
					if (!isValid) {
						// Fall back to v1 for legacy signatures
						const v1Payload = buildSignablePayload(row.content_hash, row.created_at, row.signer_did);
						isValid = await verifySignature(v1Payload, row.signature, pubKey);
					}
					if (isValid) {
						valid++;
					} else {
						invalid++;
					}
				} catch {
					invalid++;
				}
			}

			spinner.succeed(`Verified ${rows.length} signatures`);
			console.log(chalk.green(`  ✓ Valid: ${valid}`));
			if (invalid > 0) {
				console.log(chalk.red(`  ✗ Invalid: ${invalid}`));
			}
		} finally {
			db.close();
		}
	});

memoryCmd
	.command("merkle")
	.description("Compute Merkle root of all memories")
	.option("--save", "Save the Merkle root to the database")
	.action(async (options) => {
		const { computeMerkleRoot, hashContent } = await import("@signet/core");

		console.log(signetLogo());
		console.log(chalk.bold("  Memory Merkle Root\n"));

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.log(chalk.yellow("  No memories database found."));
			return;
		}

		const db = new Database(dbPath);
		const spinner = ora("  Computing Merkle root...").start();

		// Fetch all content hashes
		const rows = db.prepare(
			"SELECT content_hash FROM memories WHERE is_deleted = 0 ORDER BY created_at ASC"
		).all() as Array<{ content_hash: string }>;

		if (rows.length === 0) {
			spinner.warn("No memories found");
			db.close();
			return;
		}

		// Hash them all with BLAKE2b for consistent Merkle leaves
		const leafHashes: string[] = [];
		for (const row of rows) {
			leafHashes.push(await hashContent(row.content_hash));
		}

		const root = await computeMerkleRoot(leafHashes);
		spinner.succeed("Merkle root computed");
		console.log();
		console.log(chalk.dim(`  Memories: ${rows.length}`));
		console.log(chalk.cyan(`  Root:     ${root}`));

		if (options.save) {
			try {
				const { getConfiguredDid, signContent } = await import("@signet/core");
				const did = getConfiguredDid();
				let sig: string | null = null;

				const now = new Date().toISOString();

				if (did) {
					// Bind identity, count, and timestamp into the signed payload
					// (prevents replay: same root at different times can't reuse sig)
					const payload = `merkle|${root}|${rows.length}|${now}|${did}`;
					sig = await signContent(payload);
				}
				db.prepare(
					`INSERT INTO merkle_roots
					 (root_hash, memory_count, leaf_hashes, computed_at, signer_did, signature, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`
				).run(root, rows.length, JSON.stringify(leafHashes), now, did, sig, now);

				console.log(chalk.green("  ✓ Saved to merkle_roots table"));
			} catch (err) {
				console.log(chalk.yellow(`  ⚠ Failed to save: ${(err as Error).message}`));
			}
		}

		db.close();
	});

memoryCmd
	.command("status")
	.description("Show knowledge health and signing status")
	.action(async () => {
		const { getConfiguredDid, formatDidShort, hasSigningKeypair } = await import("@signet/core");

		console.log(signetLogo());
		console.log(chalk.bold("  Knowledge Status\n"));

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.log(chalk.yellow("  No memories database found."));
			return;
		}

		const db = new Database(dbPath);
		let total = 0;
		let signed = 0;
		let unsigned = 0;
		let types: Array<{ type: string; c: number }> = [];
		let merkleCount = 0;
		try {
			// Basic counts
			total = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE is_deleted = 0").get() as any)?.c ?? 0;
			try {
				signed = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE signature IS NOT NULL AND is_deleted = 0").get() as any)?.c ?? 0;
			} catch {
				// signature column may not exist yet (pre-migration 012)
			}
			unsigned = total - signed;

			// Type breakdown
			types = db.prepare(
				"SELECT type, COUNT(*) as c FROM memories WHERE is_deleted = 0 GROUP BY type ORDER BY c DESC"
			).all() as Array<{ type: string; c: number }>;

			// Merkle roots
			try {
				merkleCount = (db.prepare("SELECT COUNT(*) as c FROM merkle_roots").get() as any)?.c ?? 0;
			} catch {
				// Table may not exist yet
			}
		} finally {
			db.close();
		}

		// Identity info
		const did = getConfiguredDid();
		const hasKeys = hasSigningKeypair();

		console.log(chalk.bold("  Identity"));
		if (did) {
			console.log(chalk.green(`    DID:     ${formatDidShort(did)}`));
		} else {
			console.log(chalk.yellow(`    DID:     Not configured`));
		}
		console.log(`    Keypair: ${hasKeys ? chalk.green("✓") : chalk.yellow("✗ Not generated")}`);
		console.log();

		console.log(chalk.bold("  Memories"));
		console.log(`    Total:    ${chalk.cyan(total.toString())}`);
		console.log(`    Signed:   ${chalk.green(signed.toString())} ${total > 0 ? chalk.dim(`(${Math.round(signed / total * 100)}%)`) : ""}`);
		if (unsigned > 0) {
			console.log(`    Unsigned: ${chalk.yellow(unsigned.toString())}`);
		}
		console.log();

		if (types.length > 0) {
			console.log(chalk.bold("  Types"));
			for (const t of types.slice(0, 8)) {
				console.log(`    ${t.type.padEnd(16)} ${chalk.dim(t.c.toString())}`);
			}
			console.log();
		}

		console.log(chalk.bold("  Provenance"));
		console.log(`    Merkle roots: ${chalk.cyan(merkleCount.toString())}`);

		// Health score
		const healthParts: number[] = [];
		if (hasKeys) healthParts.push(25);
		if (did) healthParts.push(25);
		if (total > 0 && signed / total > 0.9) healthParts.push(25);
		else if (total > 0 && signed / total > 0.5) healthParts.push(15);
		if (merkleCount > 0) healthParts.push(25);
		const health = healthParts.reduce((a, b) => a + b, 0);

		console.log();
		const healthColor = health >= 75 ? chalk.green : health >= 50 ? chalk.yellow : chalk.red;
		console.log(chalk.bold(`  Health: ${healthColor(`${health}/100`)}`));
	});

program
	.command("migrate-vectors")
	.description("Migrate existing BLOB vectors to sqlite-vec format")
	.option(
		"--keep-blobs",
		"Keep old BLOB column after migration (safer for rollback)",
	)
	.option(
		"--remove-zvec",
		"Delete vectors.zvec file after successful migration",
	)
	.option("--dry-run", "Show what would be migrated without making changes")
	.option("--rollback", "Rollback to BLOB format (not implemented in Phase 1)")
	.action(async (options) => {
		const basePath = AGENTS_DIR;
		const memoryDir = join(basePath, "memory");
		const dbPath = join(memoryDir, "memories.db");

		console.log(signetLogo());
		console.log(chalk.bold("  Vector Migration\n"));

		// Handle rollback option
		if (options.rollback) {
			console.log(chalk.yellow("  Rollback is not implemented in Phase 1."));
			console.log(
				chalk.dim(
					"  If you used --keep-blobs during migration, you can manually",
				),
			);
			console.log(
				chalk.dim(
					"  restore by dropping vec_embeddings table and using the BLOB column.",
				),
			);
			return;
		}

		// Check for existing setup
		if (!existsSync(dbPath)) {
			console.log(chalk.yellow("  No memories database found."));
			console.log(chalk.dim(`  Expected: ${dbPath}`));
			return;
		}

		// Detect vector sources
		console.log(chalk.dim("  Detecting vector sources..."));
		const sources = await detectVectorSources(basePath);

		// Check if vec_embeddings already populated
		const vecTableSource = sources.find((s) => s.type === "vec_table");
		if (vecTableSource) {
			console.log(
				chalk.green(
					`  vec_embeddings table already populated with ${vecTableSource.count} vectors`,
				),
			);
			console.log(chalk.dim("  Migration appears to have already been run."));

			// Still check for zvec to clean up
			const zvecSource = sources.find((s) => s.type === "zvec");
			if (zvecSource && options.removeZvec) {
				const confirmed = await confirm({
					message: `Delete ${zvecSource.path}?`,
					default: false,
				});
				if (confirmed) {
					rmSync(zvecSource.path);
					console.log(chalk.dim(`  Removed ${zvecSource.path}`));
				}
			}
			return;
		}

		// Find BLOB source
		const blobSource = sources.find((s) => s.type === "blob");
		if (!blobSource) {
			console.log(chalk.yellow("  No existing embeddings found to migrate."));
			console.log(
				chalk.dim("  The embeddings table is empty or already migrated."),
			);
			return;
		}

		// Show migration plan
		console.log();
		console.log(chalk.cyan("  Migration Plan:"));
		console.log(chalk.dim(`    Source: ${blobSource.path}`));
		console.log(chalk.dim(`    Embeddings to migrate: ${blobSource.count}`));
		console.log(
			chalk.dim(`    Keep BLOB column: ${options.keepBlobs ? "yes" : "no"}`),
		);

		const zvecSource = sources.find((s) => s.type === "zvec");
		if (zvecSource) {
			console.log(chalk.dim(`    zvec file found: ${zvecSource.path}`));
			if (options.removeZvec) {
				console.log(chalk.dim("    Will be deleted after migration"));
			}
		}

		if (options.dryRun) {
			console.log();
			console.log(chalk.yellow("  Dry run complete. No changes made."));
			console.log(chalk.dim("  Run without --dry-run to perform migration."));
			return;
		}

		// Confirm migration
		console.log();
		const confirmed = await confirm({
			message: `Migrate ${blobSource.count} embeddings to sqlite-vec?`,
			default: true,
		});

		if (!confirmed) {
			console.log(chalk.dim("  Migration cancelled."));
			return;
		}

		// Perform migration
		const spinner = ora("Migrating vectors...").start();

		try {
			const db = new Database(dbPath);

			// Load sqlite-vec extension BEFORE creating virtual table
			if (!loadSqliteVec(db)) {
				spinner.fail(
					"sqlite-vec extension not found — cannot migrate vectors."
				);
				return;
			}

			// Detect actual embedding dimensions from existing data
			const dimRow = db
				.prepare("SELECT dimensions FROM embeddings LIMIT 1")
				.get() as { dimensions: number } | undefined;
			const dims = dimRow?.dimensions ?? 768;

			// Drop existing vec_embeddings (may have wrong dimensions from prior run)
			spinner.text = `Creating vec_embeddings table (${dims}d)...`;
			db.exec("DROP TABLE IF EXISTS vec_embeddings");
			db.exec(`
				CREATE VIRTUAL TABLE vec_embeddings USING vec0(
					id TEXT PRIMARY KEY,
					embedding FLOAT[${dims}] distance_metric=cosine
				);
			`);

			// Read all embeddings from BLOB column
			spinner.text = "Reading existing embeddings...";
			const embeddings = db
				.prepare(`
				SELECT id, vector, dimensions FROM embeddings
			`)
				.all() as Array<{ id: string; vector: Buffer; dimensions: number }>;

			const total = embeddings.length;
			let migrated = 0;
			let failed = 0;

			// Insert into vec_embeddings
			const insertStmt = db.prepare(`
				INSERT OR REPLACE INTO vec_embeddings (id, embedding)
				VALUES (?, ?)
			`);

			for (const row of embeddings) {
				try {
					// Convert BLOB to Float32Array
					const float32Array = new Float32Array(
						row.vector.buffer.slice(
							row.vector.byteOffset,
							row.vector.byteOffset + row.vector.byteLength,
						),
					);

					// Insert with rowid matching the embeddings.id
					insertStmt.run(row.id, float32Array);
					migrated++;

					if (migrated % 50 === 0 || migrated === total) {
						spinner.text = `Migrating ${migrated}/${total} embeddings...`;
					}
				} catch (err) {
					failed++;
					console.error(
						`\n  Failed to migrate embedding ${row.id}: ${(err as Error).message}`,
					);
				}
			}

			// Optionally remove BLOB column (by recreating table)
			if (!options.keepBlobs && migrated > 0) {
				spinner.text = "Removing old BLOB column...";
				try {
					db.exec(`
						-- Create new embeddings table without vector column
						CREATE TABLE embeddings_new (
							id TEXT PRIMARY KEY,
							content_hash TEXT NOT NULL UNIQUE,
							dimensions INTEGER NOT NULL,
							source_type TEXT NOT NULL,
							source_id TEXT NOT NULL,
							chunk_text TEXT NOT NULL,
							created_at TEXT NOT NULL
						);

						-- Copy data
						INSERT INTO embeddings_new (id, content_hash, dimensions, source_type, source_id, chunk_text, created_at)
						SELECT id, content_hash, dimensions, source_type, source_id, chunk_text, created_at
						FROM embeddings;

						-- Drop old table and rename
						DROP TABLE embeddings;
						ALTER TABLE embeddings_new RENAME TO embeddings;

						-- Recreate indexes
						CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
						CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON embeddings(content_hash);
					`);
				} catch (err) {
					spinner.warn("Could not remove BLOB column");
					console.log(chalk.dim(`  ${(err as Error).message}`));
					console.log(
						chalk.dim(
							"  Vectors were migrated successfully. BLOB column retained.",
						),
					);
				}
			}

			db.close();

			spinner.succeed(
				chalk.green(`Migrated ${migrated} embeddings to sqlite-vec format`),
			);

			if (failed > 0) {
				console.log(chalk.yellow(`  ${failed} embeddings failed to migrate`));
			}

			// Remove zvec file if requested
			if (options.removeZvec && zvecSource) {
				try {
					rmSync(zvecSource.path);
					console.log(chalk.dim(`  Removed ${zvecSource.path}`));
				} catch (err) {
					console.log(
						chalk.yellow(
							`  Could not remove zvec file: ${(err as Error).message}`,
						),
					);
				}
			}

			console.log();
			console.log(
				chalk.dim(
					"  You may need to restart the daemon for changes to take effect:",
				),
			);
			console.log(chalk.cyan("    signet daemon restart"));
		} catch (err) {
			spinner.fail("Migration failed");
			console.error(chalk.red(`  ${(err as Error).message}`));
			process.exit(1);
		}
	});

// ============================================================================
// On-Chain Identity Commands (Phase 4A)
// ============================================================================

const chainCmd = program.command("chain").description("On-chain identity and memory anchoring");

chainCmd
	.command("register")
	.description("Register agent identity on-chain (ERC-8004)")
	.option("--chain <chain>", "Target chain", "base-sepolia")
	.option("--contract <address>", "SignetIdentity contract address")
	.option("--metadata-uri <uri>", "Metadata URI (IPFS or HTTP)")
	.action(async (options) => {
		const {
			getConfiguredDid,
			getPublicKeyBytes,
			CHAIN_CONFIGS,
			createWallet,
			loadWallet,
			getWalletAddress,
			checkWalletFunds,
			registerIdentity,
			getLocalIdentity,
			keccak256Hash,
		} = await import("@signet/core");

		console.log(signetLogo());
		console.log(chalk.bold("  On-Chain Identity Registration\n"));

		const chain = options.chain;
		const chainConfig = CHAIN_CONFIGS[chain];
		if (!chainConfig) {
			console.error(chalk.red(`  Unknown chain: ${chain}`));
			console.error(chalk.dim(`  Supported: ${Object.keys(CHAIN_CONFIGS).join(", ")}`));
			process.exit(1);
		}

		// Check DID exists
		const did = getConfiguredDid();
		if (!did) {
			console.error(chalk.red("  No DID configured. Run: signet did init"));
			process.exit(1);
		}
		console.log(chalk.dim(`  DID: ${did.slice(0, 40)}...`));

		// Check contract address
		const contractAddress = options.contract || chainConfig.contractAddress;
		if (!contractAddress) {
			console.error(chalk.red("  No contract address configured for this chain."));
			console.error(chalk.dim("  Use --contract <address> to specify the deployed SignetIdentity contract."));
			process.exit(1);
		}

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found. Run: signet setup"));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			// Check if already registered on this chain
			const existing = getLocalIdentity(db, chain);
			if (existing) {
				console.log(chalk.yellow(`  Already registered on ${chain}!`));
				console.log(chalk.dim(`  Token ID: ${existing.tokenId}`));
				console.log(chalk.dim(`  TX: ${existing.txHash}`));
				return;
			}

			// Ensure wallet exists
			let walletAddress = getWalletAddress(db, chain);
			if (!walletAddress) {
				const spinner = ora("  Creating wallet...").start();
				const walletConfig = await createWallet(db, chain);
				walletAddress = walletConfig.address;
				spinner.succeed(`  Wallet created: ${chalk.cyan(walletAddress)}`);
			} else {
				console.log(chalk.dim(`  Wallet: ${walletAddress}`));
			}

			// Check funds
			const funds = await checkWalletFunds(walletAddress, chainConfig.rpcUrl);
			console.log(chalk.dim(`  Balance: ${funds.balance} ETH`));

			if (!funds.sufficient) {
				console.log();
				console.error(chalk.yellow("  ⚠ Insufficient ETH for registration transaction."));
				console.error(chalk.dim(`  Send testnet ETH to: ${walletAddress}`));
				if (chain === "base-sepolia") {
					console.error(chalk.dim("  Faucet: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet"));
				}
				process.exit(1);
			}

			// Compute public key hash
			const pubKeyBytes = await getPublicKeyBytes();
			const pubKeyHash = keccak256Hash(pubKeyBytes);

			// Metadata URI (default: empty, can be IPFS later)
			const metadataURI = options.metadataUri || "";

			// Register on-chain
			const spinner = ora("  Submitting registration transaction...").start();
			const wallet = await loadWallet(db, chain, chainConfig.rpcUrl);
			const result = await registerIdentity(
				db, wallet, contractAddress, did, metadataURI, pubKeyHash, chain,
			);
			spinner.succeed("  Identity registered on-chain!");

			console.log();
			console.log(chalk.green.bold("  ✓ Registration complete"));
			console.log(chalk.dim(`  Chain:    ${chain}`));
			console.log(chalk.dim(`  Token ID: ${result.tokenId}`));
			console.log(chalk.dim(`  TX:       ${result.txHash}`));
			if (chainConfig.explorerUrl && result.txHash) {
				console.log(chalk.dim(`  Explorer: ${chainConfig.explorerUrl}/tx/${result.txHash}`));
			}
		} finally {
			db.close();
		}
	});

chainCmd
	.command("anchor")
	.description("Anchor memory Merkle root on-chain")
	.option("--chain <chain>", "Target chain", "base-sepolia")
	.option("--contract <address>", "SignetIdentity contract address")
	.action(async (options) => {
		const {
			CHAIN_CONFIGS,
			loadWallet,
			getLocalIdentity,
			getMemoryRoot,
			anchorMemoryOnChain,
			checkWalletFunds,
		} = await import("@signet/core");

		console.log(signetLogo());
		console.log(chalk.bold("  Memory Anchoring\n"));

		const chain = options.chain;
		const chainConfig = CHAIN_CONFIGS[chain];
		if (!chainConfig) {
			console.error(chalk.red(`  Unknown chain: ${chain}`));
			process.exit(1);
		}

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found. Run: signet setup"));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			// Check on-chain identity exists
			const identity = getLocalIdentity(db, chain);
			if (!identity || !identity.tokenId) {
				console.error(chalk.red("  No on-chain identity found. Run: signet chain register"));
				process.exit(1);
			}

			const contractAddress = options.contract || identity.contractAddress || chainConfig.contractAddress;
			if (!contractAddress) {
				console.error(chalk.red("  No contract address found."));
				process.exit(1);
			}

			// Check funds
			const funds = await checkWalletFunds(identity.walletAddress, chainConfig.rpcUrl);
			if (!funds.sufficient) {
				console.error(chalk.yellow("  ⚠ Insufficient ETH for anchor transaction."));
				console.error(chalk.dim(`  Balance: ${funds.balance} ETH`));
				console.error(chalk.dim(`  Send ETH to: ${identity.walletAddress}`));
				process.exit(1);
			}

			// Compute Merkle root
			const spinner = ora("  Computing memory Merkle root...").start();
			const merkleTree = getMemoryRoot(db);

			if (merkleTree.count === 0) {
				spinner.fail("  No memories to anchor");
				return;
			}

			spinner.text = `  Anchoring ${merkleTree.count} memories...`;

			// Submit anchor transaction
			const wallet = await loadWallet(db, chain, chainConfig.rpcUrl);
			const result = await anchorMemoryOnChain(
				db, wallet, contractAddress,
				identity.tokenId, merkleTree.root, merkleTree.count, identity.id,
			);

			spinner.succeed("  Memories anchored on-chain!");
			console.log();
			console.log(chalk.green.bold(`  ✓ Anchored ${merkleTree.count} memories`));
			console.log(chalk.dim(`  Root: ${merkleTree.root}`));
			console.log(chalk.dim(`  TX:   ${result.txHash}`));
			if (chainConfig.explorerUrl) {
				console.log(chalk.dim(`  Explorer: ${chainConfig.explorerUrl}/tx/${result.txHash}`));
			}
		} finally {
			db.close();
		}
	});

chainCmd
	.command("status")
	.description("Show on-chain identity status")
	.option("--chain <chain>", "Target chain", "base-sepolia")
	.action(async (options) => {
		const {
			CHAIN_CONFIGS,
			getWalletAddress,
			getWalletBalance,
			getLocalIdentity,
			getLatestAnchor,
		} = await import("@signet/core");

		console.log(signetLogo());
		console.log(chalk.bold("  On-Chain Identity Status\n"));

		const chain = options.chain;
		const chainConfig = CHAIN_CONFIGS[chain];
		if (!chainConfig) {
			console.error(chalk.red(`  Unknown chain: ${chain}`));
			process.exit(1);
		}

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found. Run: signet setup"));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			console.log(chalk.dim(`  Chain: ${chain} (${chainConfig.chainId})`));
			console.log(chalk.dim(`  RPC:   ${chainConfig.rpcUrl}`));
			console.log();

			// Wallet info
			const walletAddress = getWalletAddress(db, chain);
			if (walletAddress) {
				console.log(chalk.bold("  Wallet"));
				console.log(`    Address: ${chalk.cyan(walletAddress)}`);
				try {
					const balance = await getWalletBalance(walletAddress, chainConfig.rpcUrl);
					console.log(`    Balance: ${balance} ETH`);
				} catch {
					console.log(chalk.dim("    Balance: (unable to fetch)"));
				}
			} else {
				console.log(chalk.yellow("  No wallet configured"));
				console.log(chalk.dim("  Run: signet chain wallet create"));
			}
			console.log();

			// Identity info
			const identity = getLocalIdentity(db, chain);
			if (identity) {
				console.log(chalk.bold("  On-Chain Identity"));
				console.log(`    Token ID: ${chalk.cyan(identity.tokenId || "pending")}`);
				console.log(`    DID:      ${identity.did.slice(0, 40)}...`);
				console.log(`    TX:       ${identity.txHash || "none"}`);
				console.log(`    Registered: ${identity.registeredAt || "pending"}`);

				// Latest anchor
				const anchor = getLatestAnchor(db, identity.id);
				console.log();
				if (anchor) {
					console.log(chalk.bold("  Latest Memory Anchor"));
					console.log(`    Root:   ${anchor.memoryRoot.slice(0, 20)}...`);
					console.log(`    Count:  ${anchor.memoryCount} memories`);
					console.log(`    TX:     ${anchor.txHash || "none"}`);
					console.log(`    At:     ${anchor.anchoredAt || "unknown"}`);
				} else {
					console.log(chalk.dim("  No memory anchors yet"));
					console.log(chalk.dim("  Run: signet chain anchor"));
				}
			} else {
				console.log(chalk.yellow("  No on-chain identity"));
				console.log(chalk.dim("  Run: signet chain register"));
			}
		} finally {
			db.close();
		}
	});

// Wallet subcommand
const walletCmd = chainCmd.command("wallet").description("Manage Ethereum wallet");

walletCmd
	.command("create")
	.description("Create a new Ethereum wallet")
	.option("--chain <chain>", "Target chain", "base-sepolia")
	.action(async (options) => {
		const { CHAIN_CONFIGS, createWallet, getWalletAddress } = await import("@signet/core");

		console.log(signetLogo());
		console.log(chalk.bold("  Wallet Creation\n"));

		const chain = options.chain;
		const chainConfig = CHAIN_CONFIGS[chain];
		if (!chainConfig) {
			console.error(chalk.red(`  Unknown chain: ${chain}`));
			process.exit(1);
		}

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found. Run: signet setup"));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			// Check for existing wallet
			const existing = getWalletAddress(db, chain);
			if (existing) {
				console.log(chalk.yellow(`  Wallet already exists for ${chain}: ${existing}`));
				return;
			}

			const spinner = ora("  Generating wallet...").start();
			const wallet = await createWallet(db, chain);
			spinner.succeed("  Wallet created!");

			console.log();
			console.log(chalk.green.bold("  ✓ New wallet ready"));
			console.log(`    Chain:   ${chain}`);
			console.log(`    Address: ${chalk.cyan(wallet.address)}`);
			console.log();
			console.log(chalk.dim("  Private key encrypted with master key."));
			if (chain === "base-sepolia") {
				console.log(chalk.dim("  Fund with testnet ETH:"));
				console.log(chalk.dim("    https://www.coinbase.com/faucets/base-ethereum-goerli-faucet"));
			}
		} finally {
			db.close();
		}
	});

walletCmd
	.command("show")
	.description("Show wallet address and balance")
	.option("--chain <chain>", "Target chain", "base-sepolia")
	.action(async (options) => {
		const { CHAIN_CONFIGS, getWalletAddress, getWalletBalance } = await import("@signet/core");

		const chain = options.chain;
		const chainConfig = CHAIN_CONFIGS[chain];
		if (!chainConfig) {
			console.error(chalk.red(`  Unknown chain: ${chain}`));
			process.exit(1);
		}

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found. Run: signet setup"));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const address = getWalletAddress(db, chain);
			if (!address) {
				console.log(chalk.yellow("  No wallet found. Run: signet chain wallet create"));
				process.exit(1);
			}

			console.log(`  Address: ${chalk.cyan(address)}`);
			try {
				const balance = await getWalletBalance(address, chainConfig.rpcUrl);
				console.log(`  Balance: ${balance} ETH`);
			} catch {
				console.log(chalk.dim("  Balance: (unable to fetch)"));
			}
			console.log(`  Chain:   ${chain} (${chainConfig.chainId})`);
		} finally {
			db.close();
		}
	});

walletCmd
	.command("export")
	.description("Export wallet private key (DANGEROUS)")
	.option("--chain <chain>", "Target chain", "base-sepolia")
	.action(async (options) => {
		const { CHAIN_CONFIGS, exportWalletKey, getWalletAddress } = await import("@signet/core");

		const chain = options.chain;

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found."));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const address = getWalletAddress(db, chain);
			if (!address) {
				console.error(chalk.red("  No wallet found."));
				process.exit(1);
			}

			console.log(chalk.red.bold("\n  ⚠ WARNING: This will display your private key!"));
			console.log(chalk.red("  Anyone with this key can spend your funds.\n"));

			const confirmed = await confirm({
				message: "Are you sure you want to export the private key?",
				default: false,
			});

			if (!confirmed) {
				console.log(chalk.dim("  Cancelled."));
				return;
			}

			const key = await exportWalletKey(db, chain);
			console.log();
			console.log(chalk.dim(`  Address: ${address}`));
			console.log(`  Private Key: ${chalk.red(key)}`);
			console.log();
			console.log(chalk.yellow("  Store this securely and never share it."));
		} finally {
			db.close();
		}
	});

// ============================================================================
// Session Key Commands (Phase 4B)
// ============================================================================

const sessionCmd = chainCmd.command("session").description("Manage session keys for scoped operations");

sessionCmd
	.command("create")
	.description("Create a new session key with scoped permissions")
	.option("--chain <chain>", "Target chain", "base-sepolia")
	.option("--duration <hours>", "Validity duration in hours", "24")
	.option("--max-tx <eth>", "Maximum transaction value in ETH", "0.01")
	.option("--max-daily-spend <eth>", "Maximum daily spend in ETH", "0.1")
	.option("--max-daily-tx <count>", "Maximum daily transactions", "100")
	.option("--contracts <addresses>", "Comma-separated allowed contract addresses")
	.option("--functions <selectors>", "Comma-separated allowed function selectors")
	.action(async (options) => {
		const { getWalletAddress, createSessionKey } = await import("@signet/core");

		console.log(signetLogo());
		console.log(chalk.bold("  Session Key Creation\n"));

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found. Run: signet setup"));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const walletAddress = getWalletAddress(db, options.chain);
			if (!walletAddress) {
				console.error(chalk.red("  No wallet found. Run: signet chain wallet create"));
				process.exit(1);
			}

			const permissions = {
				maxTransactionValue: options.maxTx,
				allowedContracts: options.contracts ? options.contracts.split(",").map((s: string) => s.trim()) : [],
				allowedFunctions: options.functions ? options.functions.split(",").map((s: string) => s.trim()) : [],
				maxDailyTransactions: parseInt(options.maxDailyTx, 10),
				maxDailySpend: options.maxDailySpend,
			};

			const spinner = ora("  Creating session key...").start();
			const sessionKey = await createSessionKey(
				db,
				walletAddress,
				permissions,
				parseFloat(options.duration),
			);
			spinner.succeed("  Session key created!");

			console.log();
			console.log(chalk.green.bold("  ✓ Session key ready"));
			console.log(`    ID:        ${chalk.cyan(sessionKey.id)}`);
			console.log(`    Address:   ${chalk.cyan(sessionKey.sessionAddress)}`);
			console.log(`    Expires:   ${sessionKey.expiresAt}`);
			console.log(`    Max TX:    ${permissions.maxTransactionValue} ETH`);
			console.log(`    Daily cap: ${permissions.maxDailySpend} ETH`);
			console.log();
			console.log(chalk.dim("  Fund the session key address to enable transactions."));
			console.log(chalk.dim("  Private key encrypted with master key — never exposed."));
		} finally {
			db.close();
		}
	});

sessionCmd
	.command("list")
	.description("List active session keys")
	.option("--chain <chain>", "Target chain", "base-sepolia")
	.option("--all", "Include expired/revoked keys")
	.action(async (options) => {
		const { getWalletAddress, getActiveSessionKeys } = await import("@signet/core");

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found."));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const walletAddress = getWalletAddress(db, options.chain);
			if (!walletAddress) {
				console.error(chalk.red("  No wallet found. Run: signet chain wallet create"));
				process.exit(1);
			}

			let keys;
			if (options.all) {
				keys = db
					.prepare("SELECT * FROM session_keys WHERE wallet_address = ? ORDER BY created_at DESC")
					.all(walletAddress)
					.map((row: Record<string, unknown>) => ({
						id: row.id as string,
						sessionAddress: row.session_address as string,
						permissions: JSON.parse(row.permissions as string),
						expiresAt: row.expires_at as string,
						createdAt: row.created_at as string,
						revokedAt: row.revoked_at as string | null,
					}));
			} else {
				keys = getActiveSessionKeys(db, walletAddress);
			}

			if (keys.length === 0) {
				console.log(chalk.yellow("  No session keys found."));
				console.log(chalk.dim("  Run: signet chain session create"));
				return;
			}

			console.log(chalk.bold(`  Session Keys (${keys.length})\n`));
			for (const key of keys) {
				const expired = new Date(key.expiresAt) <= new Date();
				const revoked = !!(key as any).revokedAt;
				let status = chalk.green("ACTIVE");
				if (revoked) status = chalk.red("REVOKED");
				else if (expired) status = chalk.yellow("EXPIRED");

				console.log(`  ${chalk.cyan(key.id)}`);
				console.log(`    Address:  ${key.sessionAddress}`);
				console.log(`    Status:   ${status}`);
				console.log(`    Expires:  ${key.expiresAt}`);
				console.log(`    Max TX:   ${key.permissions.maxTransactionValue} ETH`);
				console.log();
			}
		} finally {
			db.close();
		}
	});

sessionCmd
	.command("revoke")
	.description("Revoke a session key")
	.argument("<id>", "Session key ID to revoke")
	.action(async (id) => {
		const { revokeSessionKey } = await import("@signet/core");

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found."));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			revokeSessionKey(db, id);
			console.log(chalk.green(`  ✓ Session key ${chalk.cyan(id)} revoked.`));
		} catch (err) {
			console.error(chalk.red(`  ${(err as Error).message}`));
			process.exit(1);
		} finally {
			db.close();
		}
	});

// ============================================================================
// Payment Commands (Phase 4B)
// ============================================================================

chainCmd
	.command("payments")
	.description("View x402 payment history")
	.option("--limit <count>", "Number of payments to show", "20")
	.option("--session-key <id>", "Filter by session key ID")
	.option("--status <status>", "Filter by status (pending|completed|failed)")
	.action(async (options) => {
		const { getPaymentHistory } = await import("@signet/core");

		console.log(signetLogo());
		console.log(chalk.bold("  x402 Payment History\n"));

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found."));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const payments = getPaymentHistory(db, {
				limit: parseInt(options.limit, 10),
				sessionKeyId: options.sessionKey,
				status: options.status,
			});

			if (payments.length === 0) {
				console.log(chalk.dim("  No payments found."));
				return;
			}

			for (const payment of payments) {
				const statusColor = payment.status === "completed" ? chalk.green
					: payment.status === "failed" ? chalk.red
					: chalk.yellow;

				console.log(`  ${chalk.cyan(payment.id)}`);
				console.log(`    Amount:  ${payment.amount} ETH`);
				console.log(`    To:      ${payment.toAddress}`);
				console.log(`    Status:  ${statusColor(payment.status)}`);
				console.log(`    Purpose: ${payment.purpose || "(none)"}`);
				if (payment.txHash) {
					console.log(`    TX:      ${payment.txHash}`);
				}
				console.log(`    Date:    ${payment.createdAt}`);
				console.log();
			}
		} finally {
			db.close();
		}
	});

// ============================================================================
// Bundle Export/Import Commands (Phase 4B — signed bundles)
// ============================================================================

const bundleCmd = program
	.command("bundle")
	.description("Signed bundle export/import (Phase 4B)");

bundleCmd
	.command("export")
	.description("Export agent data as a portable signed bundle")
	.option("--output <path>", "Output file path")
	.option("--query <search>", "Export only memories matching this search")
	.option("--format <format>", "Export format: full, selective, agent-card", "full")
	.action(async (options) => {
		const { exportBundle, exportSelective } = await import("@signet/core");

		console.log(signetLogo());
		console.log(chalk.bold("  Portable Export\n"));

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found. Run: signet setup"));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const spinner = ora("  Exporting agent data...").start();

			let result: { filePath: string; metadata: any };

			if (options.query || options.format === "selective") {
				if (!options.query) {
					spinner.fail("  --query is required for selective export");
					process.exit(1);
				}
				result = await exportSelective(db, options.query, {
					outputPath: options.output,
				});
			} else {
				result = await exportBundle(db, {
					outputPath: options.output,
					format: options.format,
				});
			}

			spinner.succeed("  Export complete!");

			console.log();
			console.log(chalk.green.bold("  ✓ Bundle created"));
			console.log(`    File:       ${result.filePath}`);
			console.log(`    Format:     ${result.metadata.format}`);
			console.log(`    Memories:   ${result.metadata.counts.memories}`);
			console.log(`    Decisions:  ${result.metadata.counts.decisions}`);
			console.log(`    Entities:   ${result.metadata.counts.entities}`);
			console.log(`    Relations:  ${result.metadata.counts.relations}`);
			console.log(`    Checksum:   ${result.metadata.checksum.slice(0, 16)}...`);
			if (result.metadata.signature) {
				console.log(`    Signed:     ${chalk.green("✓")} (DID verified)`);
			} else {
				console.log(`    Signed:     ${chalk.yellow("✗")} (no signing key)`);
			}
		} finally {
			db.close();
		}
	});

bundleCmd
	.command("import")
	.description("Import an agent bundle")
	.argument("<bundle-path>", "Path to .signet-bundle.json.gz file")
	.option("--dry-run", "Preview import without writing data")
	.option("--merge-strategy <strategy>", "Merge strategy: replace, merge, skip", "merge")
	.option("--skip-verification", "Skip signature verification")
	.action(async (bundlePath, options) => {
		const { importBundle } = await import("@signet/core");

		console.log(signetLogo());
		console.log(chalk.bold("  Bundle Import\n"));

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found. Run: signet setup"));
			process.exit(1);
		}

		if (!existsSync(bundlePath)) {
			console.error(chalk.red(`  Bundle not found: ${bundlePath}`));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const spinner = ora(
				options.dryRun ? "  Analyzing bundle (dry run)..." : "  Importing bundle...",
			).start();

			const result = await importBundle(db, bundlePath, {
				mergeStrategy: options.mergeStrategy === "skip" ? "skip-existing" : options.mergeStrategy,
				dryRun: !!options.dryRun,
				skipVerification: !!options.skipVerification,
			});

			if (options.dryRun) {
				spinner.succeed("  Dry run complete — no data written");
			} else {
				spinner.succeed("  Import complete!");
			}

			console.log();
			console.log(chalk.bold("  Bundle Info"));
			console.log(`    Version:  ${result.bundleMetadata.version}`);
			console.log(`    Format:   ${result.bundleMetadata.format}`);
			console.log(`    Exported: ${result.bundleMetadata.exportedAt}`);
			if (result.bundleMetadata.did) {
				console.log(`    DID:      ${result.bundleMetadata.did.slice(0, 40)}...`);
			}

			console.log();
			console.log(chalk.bold("  Import Summary"));
			console.log(`    Strategy:           ${result.mergeStrategy}`);
			console.log(`    Memories imported:   ${chalk.green(String(result.imported.memories))}`);
			console.log(`    Memories skipped:    ${chalk.dim(String(result.skipped.memories))}`);
			console.log(`    Decisions imported:  ${chalk.green(String(result.imported.decisions))}`);
			console.log(`    Decisions skipped:   ${chalk.dim(String(result.skipped.decisions))}`);
			console.log(`    Entities imported:   ${chalk.green(String(result.imported.entities))}`);
			console.log(`    Relations imported:  ${chalk.green(String(result.imported.relations))}`);

			if (result.warnings.length > 0) {
				console.log();
				console.log(chalk.yellow("  Warnings:"));
				for (const w of result.warnings) {
					console.log(chalk.yellow(`    ⚠ ${w}`));
				}
			}
		} catch (err) {
			console.error(chalk.red(`  Import failed: ${(err as Error).message}`));
			process.exit(1);
		} finally {
			db.close();
		}
	});

// ============================================================================
// Perception Layer Commands
// ============================================================================

const perceiveCmd = program
	.command("perceive")
	.description("Ambient perception layer — learn from your work activity");

perceiveCmd
	.command("start")
	.description("Start perception capture")
	.option("--screen", "Enable screen capture")
	.option("--voice", "Enable voice capture")
	.option("--files", "Enable file watching")
	.option("--terminal", "Enable terminal watching")
	.option("--comms", "Enable communications watching")
	.option("--no-screen", "Disable screen capture")
	.option("--no-files", "Disable file watching")
	.option("--no-terminal", "Disable terminal watching")
	.option("--no-comms", "Disable communications watching")
	.action(async (options: Record<string, boolean | undefined>) => {
		console.log(signetLogo());

		// Build config overrides from CLI flags
		const configOverrides: Record<string, unknown> = {};
		if (options.screen !== undefined) configOverrides.screen = { enabled: options.screen };
		if (options.voice !== undefined) configOverrides.voice = { enabled: options.voice };
		if (options.files !== undefined) configOverrides.files = { enabled: options.files };
		if (options.terminal !== undefined) configOverrides.terminal = { enabled: options.terminal };
		if (options.comms !== undefined) configOverrides.comms = { enabled: options.comms };

		// Also load from agent.yaml if available
		const agentYamlPath = join(AGENTS_DIR, "agent.yaml");
		let yamlConfig: Record<string, unknown> = {};
		if (existsSync(agentYamlPath)) {
			try {
				const raw = readFileSync(agentYamlPath, "utf-8");
				const parsed = parseSimpleYaml(raw);
				if (parsed.perception && typeof parsed.perception === "object") {
					yamlConfig = parsed.perception as Record<string, unknown>;
				}
			} catch {
				// Use defaults
			}
		}

		// Voice capture warning
		const voiceEnabled =
			options.voice === true ||
			(!options.voice && (yamlConfig as any)?.voice?.enabled === true);
		if (voiceEnabled) {
			console.log(
				chalk.yellow(
					"  ⚠ Voice capture requires microphone access. All processing is local.",
				),
			);
			console.log();
		}

		const spinner = ora("Starting perception layer...").start();

		try {
			const { startPerception } = await import("@signet/perception");
			const mergedConfig = { ...yamlConfig, ...configOverrides };
			await startPerception(mergedConfig as any);

			spinner.succeed("Perception layer started");
			console.log(chalk.dim("  Capturing ambient activity..."));
			if (voiceEnabled) {
				console.log(chalk.dim("  🎤 Voice capture: ACTIVE (local Whisper transcription)"));
			}
			console.log(chalk.dim("  Run `signet perceive status` for details"));
			console.log(chalk.dim("  Run `signet perceive stop` to stop"));
			console.log();

			// Keep the process running
			process.on("SIGINT", async () => {
				console.log();
				const stopSpinner = ora("Stopping perception...").start();
				const { stopPerception } = await import("@signet/perception");
				await stopPerception();
				stopSpinner.succeed("Perception stopped");
				process.exit(0);
			});

			// Block — run until interrupted
			await new Promise(() => {});
		} catch (err) {
			spinner.fail(`Failed to start perception: ${(err as Error).message}`);
		}
	});

perceiveCmd
	.command("stop")
	.description("Stop perception capture")
	.action(async () => {
		console.log(signetLogo());
		try {
			const { stopPerception } = await import("@signet/perception");
			await stopPerception();
			console.log(chalk.green("  Perception stopped."));
		} catch (err) {
			console.log(chalk.yellow("  Perception is not running or already stopped."));
		}
	});

perceiveCmd
	.command("status")
	.description("Show perception status")
	.action(async () => {
		console.log(signetLogo());

		try {
			const { getPerceptionStatus } = await import("@signet/perception");
			const status = await getPerceptionStatus();

			if (!status.running) {
				console.log(chalk.yellow("  Perception: INACTIVE"));
				console.log(chalk.dim("  Run `signet perceive start` to begin."));
				return;
			}

			const uptime = status.startedAt
				? formatUptime((Date.now() - new Date(status.startedAt).getTime()) / 1000)
				: "unknown";

			console.log(chalk.green(`  Perception: ACTIVE (${uptime})`));

			const adapters = status.adapters;
			const adapterLine = (name: string, a: { enabled: boolean; captureCount: number }) =>
				a.enabled
					? chalk.green(`  ├── ${name}: ON (${a.captureCount} captures)`)
					: chalk.dim(`  ├── ${name}: OFF`);

			console.log(adapterLine("Screen", adapters.screen));
			console.log(adapterLine("Voice", adapters.voice));
			console.log(adapterLine("Files", adapters.files));
			console.log(adapterLine("Terminal", adapters.terminal));
			// Last one uses └
			const commsLine = adapters.comms.enabled
				? chalk.green(`  └── Comms: ON (${adapters.comms.captureCount} captures)`)
				: chalk.dim(`  └── Comms: OFF`);
			console.log(commsLine);

			console.log();
			if (status.lastRefinerRun) {
				const ago = Math.round(
					(Date.now() - new Date(status.lastRefinerRun).getTime()) / 60000,
				);
				console.log(chalk.dim(`  Last refiner run: ${ago} minutes ago`));
			}
			console.log(chalk.dim(`  Memories extracted today: ${status.memoriesExtractedToday}`));
		} catch (err) {
			console.log(chalk.yellow("  Could not get perception status."));
			console.log(chalk.dim(`  ${(err as Error).message}`));
		}
	});

// ============================================================================
// signet perceive profile / export / graph — Distillation commands
// ============================================================================

perceiveCmd
	.command("profile")
	.description("Show cognitive profile built from observations")
	.option("--full", "Show full JSON profile")
	.option("--json", "Output as JSON")
	.option("--rebuild", "Force rebuild (re-run LLM synthesis)")
	.action(async (options: { full?: boolean; json?: boolean; rebuild?: boolean }) => {
		console.log(signetLogo());

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found. Run `signet setup` first."));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const {
				loadCognitiveProfile,
				buildCognitiveProfile,
				runDistillation,
			} = await import("@signet/perception");

			let profile = options.rebuild ? null : loadCognitiveProfile(db);

			if (!profile) {
				const spinner = ora("Building cognitive profile (this may take a minute)...").start();
				try {
					const result = await runDistillation(db);
					profile = result.profile;
					if (profile) {
						spinner.succeed("Cognitive profile built");
					} else {
						spinner.fail("Could not build profile (not enough data?)");
						return;
					}
				} catch (err) {
					spinner.fail(`Profile build failed: ${(err as Error).message}`);
					return;
				}
			}

			if (options.json) {
				console.log(JSON.stringify(profile, null, 2));
				return;
			}

			// Pretty print
			console.log(
				chalk.bold(
					`  🧠 Cognitive Profile (${Math.round(profile.confidenceScore * 100)}% confidence, ${profile.observationDays} days observed)`,
				),
			);
			console.log();

			console.log(
				`  ${chalk.cyan("Problem Solving:")} ${profile.problemSolving.approach}` +
					(profile.problemSolving.debuggingStyle !== "unknown"
						? ` (${profile.problemSolving.debuggingStyle})`
						: ""),
			);
			console.log(
				`  ${chalk.cyan("Communication:")} ${profile.communication.verbosity} + ${profile.communication.formality}` +
					(profile.communication.preferredFormats.length > 0
						? `, prefers ${profile.communication.preferredFormats.join(", ")}`
						: ""),
			);
			console.log(
				`  ${chalk.cyan("Peak Hours:")} ${profile.workPatterns.peakHours.length > 0 ? profile.workPatterns.peakHours.map((h: number) => `${h}:00`).join(", ") : "unknown"}`,
			);

			if (profile.expertise.languages.length > 0) {
				console.log(
					`  ${chalk.cyan("Languages:")} ${profile.expertise.languages.join(", ")}`,
				);
			}
			if (profile.expertise.frameworks.length > 0) {
				console.log(
					`  ${chalk.cyan("Frameworks:")} ${profile.expertise.frameworks.join(", ")}`,
				);
			}
			if (profile.expertise.primaryDomains.length > 0) {
				console.log(
					`  ${chalk.cyan("Domains:")} ${profile.expertise.primaryDomains.join(", ")}`,
				);
			}

			console.log(
				`  ${chalk.cyan("Tools:")} ${profile.toolPreferences.editor}` +
					(profile.toolPreferences.terminal !== "unknown"
						? ` + ${profile.toolPreferences.terminal}`
						: "") +
					(profile.toolPreferences.prefersCLI ? ", prefers CLI" : ""),
			);
			console.log(
				`  ${chalk.cyan("Decision Style:")} ${profile.decisionMaking.speed}` +
					(profile.decisionMaking.revisitsDecisions
						? ", revisits decisions"
						: ", commits once decided"),
			);

			if (options.full) {
				console.log();
				console.log(chalk.dim("  Full profile JSON:"));
				console.log(chalk.dim(JSON.stringify(profile, null, 2)));
			}

			console.log();
			console.log(chalk.dim("  Run `signet perceive profile --full` for detailed breakdown"));
			console.log(chalk.dim("  Run `signet perceive export` to generate training context"));
		} catch (err) {
			console.error(chalk.red(`  Error: ${(err as Error).message}`));
		} finally {
			db.close();
		}
	});

perceiveCmd
	.command("export")
	.description("Export agent card and training context for agent personalization")
	.option("--output <path>", "Output directory", join(AGENTS_DIR))
	.action(async (options: { output: string }) => {
		console.log(signetLogo());

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found. Run `signet setup` first."));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const {
				loadCognitiveProfile,
				runDistillation,
				generateAgentCard,
				exportAgentCard,
				generateTrainingContext,
				loadMemoriesForCard,
			} = await import("@signet/perception");

			let profile = loadCognitiveProfile(db);

			if (!profile) {
				const spinner = ora("Building cognitive profile first...").start();
				const result = await runDistillation(db);
				profile = result.profile;
				if (!profile) {
					spinner.fail("Could not build profile");
					return;
				}
				spinner.succeed("Profile built");
			}

			const memories = loadMemoriesForCard(db);
			const card = generateAgentCard(profile, memories);
			const training = generateTrainingContext(profile, memories);

			const outputDir = options.output;
			mkdirSync(outputDir, { recursive: true });

			// Export agent card
			const cardPath = join(outputDir, "agent-card.json");
			exportAgentCard(card, cardPath);
			console.log(chalk.green(`  ✓ Agent card: ${cardPath}`));

			// Export training context
			const contextPath = join(outputDir, "training-context.md");
			writeFileSync(contextPath, training, "utf-8");
			console.log(chalk.green(`  ✓ Training context: ${contextPath}`));

			// Export cognitive profile
			const profilePath = join(outputDir, "cognitive-profile.json");
			writeFileSync(profilePath, JSON.stringify(profile, null, 2), "utf-8");
			console.log(chalk.green(`  ✓ Cognitive profile: ${profilePath}`));

			console.log();
			console.log(
				chalk.dim(
					"  The training-context.md can be injected into any agent's system prompt",
				),
			);
			console.log(
				chalk.dim("  to make the agent personalized to your working style."),
			);
		} catch (err) {
			console.error(chalk.red(`  Error: ${(err as Error).message}`));
		} finally {
			db.close();
		}
	});

perceiveCmd
	.command("graph")
	.description("Show expertise graph — skill/tool relationships")
	.option("--domain <domain>", "Show depth for a specific domain")
	.option("--json", "Output as JSON")
	.action(async (options: { domain?: string; json?: boolean }) => {
		console.log(signetLogo());

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found. Run `signet setup` first."));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const {
				getExpertiseGraph,
				buildExpertiseGraph,
				getExpertiseDepth,
				getRelatedSkills,
			} = await import("@signet/perception");

			if (options.domain) {
				// Show depth for a specific domain
				const depth = await getExpertiseDepth(db, options.domain);
				const related = await getRelatedSkills(db, options.domain);

				if (options.json) {
					console.log(JSON.stringify({ depth, related }, null, 2));
					return;
				}

				console.log(chalk.bold(`  📊 Expertise: ${options.domain}`));
				console.log();
				console.log(`  ${chalk.cyan("Depth:")} ${depth.depth}`);
				console.log(`  ${chalk.cyan("Memories:")} ${depth.memoryCount}`);
				console.log(`  ${chalk.cyan("Unique skills:")} ${depth.uniqueSkills}`);

				if (depth.relatedEntities.length > 0) {
					console.log(
						`  ${chalk.cyan("Related:")} ${depth.relatedEntities.join(", ")}`,
					);
				}

				if (related.length > 0) {
					console.log();
					console.log(chalk.dim("  Commonly used with:"));
					for (const r of related.slice(0, 10)) {
						const bar = "█".repeat(Math.round(r.weight * 3));
						console.log(
							`    ${chalk.dim(bar)} ${r.skill} (weight: ${r.weight.toFixed(1)})`,
						);
					}
				}

				return;
			}

			// Build or load the full graph
			let graph = await getExpertiseGraph(db);
			if (graph.nodes.length === 0) {
				const spinner = ora("Building expertise graph...").start();
				graph = await buildExpertiseGraph(db);
				spinner.succeed("Graph built");
			}

			if (options.json) {
				console.log(JSON.stringify(graph, null, 2));
				return;
			}

			console.log(
				chalk.bold(
					`  🕸️  Expertise Graph — ${graph.nodes.length} entities, ${graph.edges.length} connections`,
				),
			);
			console.log();

			// Group nodes by type
			const byType = new Map<string, Array<{ name: string; mentions: number }>>();
			for (const node of graph.nodes) {
				const group = byType.get(node.entityType) || [];
				group.push({ name: node.name, mentions: node.mentions });
				byType.set(node.entityType, group);
			}

			const typeEmoji: Record<string, string> = {
				language: "💻",
				framework: "🏗️",
				tool: "🔧",
				skill: "⚡",
				project: "📁",
				person: "👤",
				domain: "🌐",
			};

			for (const [type, items] of byType) {
				const sorted = items.sort((a, b) => b.mentions - a.mentions);
				const emoji = typeEmoji[type] || "•";
				console.log(
					`  ${emoji} ${chalk.cyan(type.toUpperCase())} (${sorted.length})`,
				);
				for (const item of sorted.slice(0, 8)) {
					console.log(
						`    ${chalk.dim("•")} ${item.name} ${chalk.dim(`(${item.mentions}×)`)}`,
					);
				}
				if (sorted.length > 8) {
					console.log(chalk.dim(`    ... and ${sorted.length - 8} more`));
				}
				console.log();
			}

			console.log(chalk.dim("  Run `signet perceive graph --domain <name>` for depth analysis"));
		} catch (err) {
			console.error(chalk.red(`  Error: ${(err as Error).message}`));
		} finally {
			db.close();
		}
	});

// ============================================================================
// Federation Commands (Phase 5)
// ============================================================================

const federationCmd = program
	.command("federation")
	.description("P2P federation — peer connections, sync, and selective memory publishing");

federationCmd
	.command("start")
	.description("Start the federation WebSocket server")
	.option("--port <port>", "WebSocket server port", "3851")
	.action(async (options) => {
		const {
			createFederationServer,
			getConfiguredDid,
			getPublicKeyBase64,
			hasSigningKeypair,
		} = await import("@signet/core");

		console.log(signetLogo());
		console.log(chalk.bold("  Federation Server\n"));

		if (!hasSigningKeypair()) {
			console.error(chalk.red("  No signing keypair found. Run: signet did init"));
			process.exit(1);
		}

		const did = getConfiguredDid();
		if (!did) {
			console.error(chalk.red("  No DID configured. Run: signet did init"));
			process.exit(1);
		}

		const publicKey = await getPublicKeyBase64();
		const port = parseInt(options.port, 10);

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found. Run: signet setup"));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const server = createFederationServer(port, db, {
				port,
				did,
				publicKey,
			});

			console.log(chalk.green.bold("  ✓ Federation server started"));
			console.log(`    Port:  ${chalk.cyan(String(port))}`);
			console.log(`    DID:   ${chalk.dim(did)}`);
			console.log();
			console.log(chalk.dim("  Peers can connect to: ws://localhost:" + port));
			console.log(chalk.dim("  Press Ctrl+C to stop"));

			// Keep process alive
			process.on("SIGINT", () => {
				console.log(chalk.dim("\n  Shutting down..."));
				server.close();
				db.close();
				process.exit(0);
			});

			// Keep the process running
			await new Promise(() => {});
		} catch (err) {
			console.error(chalk.red(`  Error: ${(err as Error).message}`));
			db.close();
			process.exit(1);
		}
	});

federationCmd
	.command("status")
	.description("Show federation status")
	.action(async () => {
		const {
			getPeers,
			getPublishRules,
			getConfiguredDid,
		} = await import("@signet/core");

		console.log(signetLogo());
		console.log(chalk.bold("  Federation Status\n"));

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found."));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const did = getConfiguredDid();
			const peers = getPeers(db);
			const rules = getPublishRules(db);

			const trusted = peers.filter((p: any) => p.trustLevel === "trusted").length;
			const pending = peers.filter((p: any) => p.trustLevel === "pending").length;
			const blocked = peers.filter((p: any) => p.trustLevel === "blocked").length;

			const totalShared = peers.reduce((sum: number, p: any) => sum + p.memoriesShared, 0);
			const totalReceived = peers.reduce((sum: number, p: any) => sum + p.memoriesReceived, 0);

			console.log(`  DID:            ${did ? chalk.cyan(did) : chalk.yellow("Not configured")}`);
			console.log();
			console.log(chalk.bold("  Peers"));
			console.log(`    Trusted:      ${chalk.green(String(trusted))}`);
			console.log(`    Pending:      ${chalk.yellow(String(pending))}`);
			console.log(`    Blocked:      ${chalk.red(String(blocked))}`);
			console.log();
			console.log(chalk.bold("  Sync"));
			console.log(`    Shared:       ${totalShared} memories`);
			console.log(`    Received:     ${totalReceived} memories`);
			console.log();
			console.log(chalk.bold("  Publish Rules"));
			console.log(`    Active:       ${rules.length}`);
			console.log(`    Auto-publish: ${rules.filter((r: any) => r.autoPublish).length}`);
		} finally {
			db.close();
		}
	});

// -- Peer subcommands --

const peerCmd = federationCmd.command("peer").description("Manage federation peers");

peerCmd
	.command("add <endpoint-url>")
	.description("Connect to a peer at the given WebSocket URL")
	.action(async (endpointUrl) => {
		const {
			connectToPeer,
			addPeer,
			getConfiguredDid,
			getPublicKeyBase64,
			hasSigningKeypair,
			getPeerByDid,
		} = await import("@signet/core");

		console.log(signetLogo());
		console.log(chalk.bold("  Add Federation Peer\n"));

		if (!hasSigningKeypair()) {
			console.error(chalk.red("  No signing keypair. Run: signet did init"));
			process.exit(1);
		}

		const did = getConfiguredDid();
		if (!did) {
			console.error(chalk.red("  No DID configured. Run: signet did init"));
			process.exit(1);
		}

		const publicKey = await getPublicKeyBase64();
		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found."));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const spinner = ora(`  Connecting to ${endpointUrl}...`).start();

			const connection = await connectToPeer(endpointUrl, {
				port: 0,
				did,
				publicKey,
			});

			spinner.succeed(`  Connected! Peer DID verified.`);

			// Check if peer already exists
			const existing = getPeerByDid(db, connection.peerDid);
			if (existing) {
				console.log(chalk.yellow(`  Peer already registered: ${existing.id}`));
				console.log(chalk.dim(`  DID: ${connection.peerDid}`));
			} else {
				const peerId = `peer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				const peer = addPeer(db, {
					id: peerId,
					did: connection.peerDid,
					publicKey: connection.peerPublicKey,
					endpointUrl: endpointUrl,
					trustLevel: "pending",
				});

				console.log(chalk.green.bold(`  ✓ Peer added`));
				console.log(`    ID:        ${chalk.cyan(peer.id)}`);
				console.log(`    DID:       ${chalk.dim(peer.did)}`);
				console.log(`    Trust:     ${chalk.yellow("pending")}`);
				console.log();
				console.log(chalk.dim("  Run: signet federation peer trust " + peer.id));
			}

			connection.close();
		} catch (err) {
			console.error(chalk.red(`  Failed to connect: ${(err as Error).message}`));
			process.exit(1);
		} finally {
			db.close();
		}
	});

peerCmd
	.command("list")
	.description("List all federation peers")
	.action(async () => {
		const { getPeers } = await import("@signet/core");

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found."));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const peers = getPeers(db);

			if (peers.length === 0) {
				console.log(chalk.dim("  No federation peers."));
				console.log(chalk.dim("  Run: signet federation peer add <ws-url>"));
				return;
			}

			console.log(chalk.bold(`  Federation Peers (${peers.length})\n`));

			for (const peer of peers) {
				const trustColor = peer.trustLevel === "trusted" ? chalk.green
					: peer.trustLevel === "blocked" ? chalk.red
					: chalk.yellow;

				console.log(`  ${chalk.cyan(peer.id)}`);
				if (peer.displayName) console.log(`    Name:     ${peer.displayName}`);
				console.log(`    DID:      ${chalk.dim(peer.did)}`);
				console.log(`    Trust:    ${trustColor(peer.trustLevel)}`);
				if (peer.endpointUrl) console.log(`    Endpoint: ${peer.endpointUrl}`);
				console.log(`    Shared:   ${peer.memoriesShared} | Received: ${peer.memoriesReceived}`);
				if (peer.lastSeen) console.log(`    Last seen: ${peer.lastSeen}`);
				console.log();
			}
		} finally {
			db.close();
		}
	});

peerCmd
	.command("trust <peer-id>")
	.description("Trust a peer (allows sync)")
	.action(async (peerId) => {
		const { updatePeerTrust, getPeerById } = await import("@signet/core");

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found."));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const peer = getPeerById(db, peerId);
			if (!peer) {
				console.error(chalk.red(`  Peer not found: ${peerId}`));
				process.exit(1);
			}

			updatePeerTrust(db, peerId, "trusted");
			console.log(chalk.green(`  ✓ Peer ${chalk.cyan(peerId)} is now trusted.`));
			console.log(chalk.dim("  This peer can now sync memories with you."));
		} catch (err) {
			console.error(chalk.red(`  ${(err as Error).message}`));
			process.exit(1);
		} finally {
			db.close();
		}
	});

peerCmd
	.command("block <peer-id>")
	.description("Block a peer (rejects connections)")
	.action(async (peerId) => {
		const { blockFederationPeer, getPeerById } = await import("@signet/core");

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found."));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const peer = getPeerById(db, peerId);
			if (!peer) {
				console.error(chalk.red(`  Peer not found: ${peerId}`));
				process.exit(1);
			}

			blockFederationPeer(db, peerId);
			console.log(chalk.red(`  ✓ Peer ${chalk.cyan(peerId)} is now blocked.`));
		} catch (err) {
			console.error(chalk.red(`  ${(err as Error).message}`));
			process.exit(1);
		} finally {
			db.close();
		}
	});

peerCmd
	.command("remove <peer-id>")
	.description("Remove a peer and all associated records")
	.action(async (peerId) => {
		const { removePeer, getPeerById } = await import("@signet/core");

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found."));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const peer = getPeerById(db, peerId);
			if (!peer) {
				console.error(chalk.red(`  Peer not found: ${peerId}`));
				process.exit(1);
			}

			removePeer(db, peerId);
			console.log(chalk.green(`  ✓ Peer ${chalk.cyan(peerId)} removed.`));
		} catch (err) {
			console.error(chalk.red(`  ${(err as Error).message}`));
			process.exit(1);
		} finally {
			db.close();
		}
	});

// -- Sync subcommand --

federationCmd
	.command("sync")
	.description("Sync memories with federation peers")
	.option("--peer <peer-id>", "Sync with a specific peer")
	.option("--since <date>", "Only sync memories since this date")
	.action(async (options) => {
		const {
			getTrustedPeers,
			getPeerById,
			connectToPeer,
			getConfiguredDid,
			getPublicKeyBase64,
			hasSigningKeypair,
			processSyncResponse,
		} = await import("@signet/core");

		console.log(signetLogo());
		console.log(chalk.bold("  Federation Sync\n"));

		if (!hasSigningKeypair()) {
			console.error(chalk.red("  No signing keypair. Run: signet did init"));
			process.exit(1);
		}

		const did = getConfiguredDid();
		if (!did) {
			console.error(chalk.red("  No DID configured. Run: signet did init"));
			process.exit(1);
		}

		const publicKey = await getPublicKeyBase64();
		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found."));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			let peers;
			if (options.peer) {
				const peer = getPeerById(db, options.peer);
				if (!peer) {
					console.error(chalk.red(`  Peer not found: ${options.peer}`));
					process.exit(1);
				}
				if (peer.trustLevel !== "trusted") {
					console.error(chalk.red(`  Peer is not trusted. Run: signet federation peer trust ${options.peer}`));
					process.exit(1);
				}
				if (!peer.endpointUrl) {
					console.error(chalk.red("  Peer has no endpoint URL."));
					process.exit(1);
				}
				peers = [peer];
			} else {
				peers = getTrustedPeers(db).filter((p: any) => p.endpointUrl);
			}

			if (peers.length === 0) {
				console.log(chalk.yellow("  No trusted peers with endpoints to sync with."));
				return;
			}

			for (const peer of peers) {
				const spinner = ora(`  Syncing with ${peer.displayName || peer.id}...`).start();

				try {
					const conn = await connectToPeer(peer.endpointUrl!, {
						port: 0,
						did,
						publicKey,
					});

					const response = await conn.syncWithPeer(options.since || peer.lastSync || undefined);
					const imported = processSyncResponse(db, peer.id, response.memories);

					conn.close();

					spinner.succeed(
						`  ${peer.displayName || peer.id}: ${response.memories.length} received, ${imported} new`,
					);
				} catch (err) {
					spinner.fail(`  ${peer.displayName || peer.id}: ${(err as Error).message}`);
				}
			}
		} finally {
			db.close();
		}
	});

// -- Publish subcommands --

const publishCmd = federationCmd.command("publish").description("Manage publish rules for selective memory sharing");

publishCmd
	.command("add")
	.description("Create a publish rule")
	.requiredOption("--name <name>", "Rule name")
	.option("--query <query>", "Memory search query to match")
	.option("--tags <tags>", "Comma-separated tags to match")
	.option("--types <types>", "Comma-separated memory types to match")
	.option("--min-importance <value>", "Minimum importance threshold", "0.5")
	.option("--auto", "Enable auto-publishing for this rule")
	.action(async (options) => {
		const { createPublishRule } = await import("@signet/core");

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found."));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const rule = createPublishRule(db, {
				name: options.name,
				query: options.query,
				tags: options.tags ? options.tags.split(",").map((t: string) => t.trim()) : undefined,
				types: options.types ? options.types.split(",").map((t: string) => t.trim()) : undefined,
				minImportance: parseFloat(options.minImportance),
				autoPublish: !!options.auto,
			});

			console.log(chalk.green.bold("  ✓ Publish rule created"));
			console.log(`    ID:          ${chalk.cyan(rule.id)}`);
			console.log(`    Name:        ${rule.name}`);
			if (rule.query) console.log(`    Query:       ${rule.query}`);
			if (rule.tags) console.log(`    Tags:        ${rule.tags.join(", ")}`);
			if (rule.types) console.log(`    Types:       ${rule.types.join(", ")}`);
			console.log(`    Min import.: ${rule.minImportance}`);
			console.log(`    Auto:        ${rule.autoPublish ? chalk.green("yes") : "no"}`);
		} catch (err) {
			console.error(chalk.red(`  Error: ${(err as Error).message}`));
			process.exit(1);
		} finally {
			db.close();
		}
	});

publishCmd
	.command("list")
	.description("List all publish rules")
	.action(async () => {
		const { getPublishRules } = await import("@signet/core");

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found."));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			const rules = getPublishRules(db);

			if (rules.length === 0) {
				console.log(chalk.dim("  No publish rules defined."));
				console.log(chalk.dim("  Run: signet federation publish add --name <name> --query <query>"));
				return;
			}

			console.log(chalk.bold(`  Publish Rules (${rules.length})\n`));

			for (const rule of rules) {
				console.log(`  ${chalk.cyan(rule.id)}`);
				console.log(`    Name:        ${rule.name}`);
				if (rule.query) console.log(`    Query:       ${rule.query}`);
				if (rule.tags) console.log(`    Tags:        ${rule.tags.join(", ")}`);
				if (rule.types) console.log(`    Types:       ${rule.types.join(", ")}`);
				console.log(`    Min import.: ${rule.minImportance}`);
				console.log(`    Auto:        ${rule.autoPublish ? chalk.green("yes") : "no"}`);
				if (rule.peerIds) console.log(`    Peers:       ${rule.peerIds.join(", ")}`);
				console.log();
			}
		} finally {
			db.close();
		}
	});

publishCmd
	.command("remove <rule-id>")
	.description("Remove a publish rule")
	.action(async (ruleId) => {
		const { deletePublishRule } = await import("@signet/core");

		const basePath = AGENTS_DIR;
		const dbPath = join(basePath, "memory", "memories.db");
		if (!existsSync(dbPath)) {
			console.error(chalk.red("  No memory database found."));
			process.exit(1);
		}

		const db = new Database(dbPath);

		try {
			deletePublishRule(db, ruleId);
			console.log(chalk.green(`  ✓ Publish rule ${chalk.cyan(ruleId)} removed.`));
		} catch (err) {
			console.error(chalk.red(`  ${(err as Error).message}`));
			process.exit(1);
		} finally {
			db.close();
		}
	});

// ============================================================================
// Default action when no command specified
// ============================================================================

// Default action when no command specified
program.action(async () => {
	const basePath = AGENTS_DIR;
	const existing = detectExistingSetup(basePath);

	if (existing.agentsDir && existing.memoryDb) {
		// Existing installation - show interactive menu
		await interactiveMenu();
	} else {
		// No installation - run setup
		await setupWizard({});
	}
});

program.parse();
