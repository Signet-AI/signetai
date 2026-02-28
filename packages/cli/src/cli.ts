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
import { join, dirname, resolve as resolvePath } from "path";
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

async function startDaemon(agentsDir: string = AGENTS_DIR): Promise<boolean> {
	const daemonDir = join(agentsDir, ".daemon");
	const logDir = join(daemonDir, "logs");

	mkdirSync(daemonDir, { recursive: true });
	mkdirSync(logDir, { recursive: true });

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

	const proc = spawn(runtime, [daemonPath], {
		detached: true,
		stdio: "ignore",
		env: {
			...process.env,
			SIGNET_PORT: DEFAULT_PORT.toString(),
			SIGNET_PATH: agentsDir,
		},
	});

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

async function stopDaemon(agentsDir: string = AGENTS_DIR): Promise<boolean> {
	const pidFile = join(agentsDir, ".daemon", "pid");

	// Try graceful shutdown via PID
	if (existsSync(pidFile)) {
		try {
			const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
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

type HarnessChoice = "claude-code" | "opencode" | "openclaw";
type EmbeddingProviderChoice = "ollama" | "openai" | "none";
type ExtractionProviderChoice = "claude-code" | "ollama" | "opencode" | "none";
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

const SETUP_HARNESS_CHOICES: readonly HarnessChoice[] = [
	"claude-code",
	"opencode",
	"openclaw",
];
const EMBEDDING_PROVIDER_CHOICES: readonly EmbeddingProviderChoice[] = [
	"ollama",
	"openai",
	"none",
];
const EXTRACTION_PROVIDER_CHOICES: readonly ExtractionProviderChoice[] = [
	"claude-code",
	"ollama",
	"opencode",
	"none",
];
const OPENCLAW_RUNTIME_CHOICES: readonly OpenClawRuntimeChoice[] = [
	"plugin",
	"legacy",
];

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

function normalizeChoice<T extends string>(
	value: unknown,
	allowed: readonly T[],
): T | null {
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
	return (
		detection.memoryDb ||
		detection.agentYaml ||
		detection.identityFiles.length > 0
	);
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

	if (ranked.length === 0) {
		return null;
	}

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
	console.error(
		chalk.dim(
			"  Ask the user for explicit provider choices and pass them as CLI flags.",
		),
	);
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

			if (options?.embeddingProvider && options.embeddingProvider !== "none") {
				const embeddingModel =
					options.embeddingModel ||
					(options.embeddingProvider === "openai"
						? "text-embedding-3-small"
						: "nomic-embed-text");
				config.embedding = {
					provider: options.embeddingProvider,
					model: embeddingModel,
					dimensions: getEmbeddingDimensions(embeddingModel),
				};
			}

			if (options?.extractionProvider && options.extractionProvider !== "none") {
				(config.memory as Record<string, unknown>).pipelineV2 = {
					enabled: true,
					extractionProvider: options.extractionProvider,
					extractionModel:
						options.extractionModel ||
						(options.extractionProvider === "claude-code"
							? "haiku"
							: options.extractionProvider === "opencode"
								? "anthropic/claude-haiku-4-5-20251001"
								: "glm-4.7-flash"),
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
					console.log(
						chalk.cyan(`  Detected OpenClaw workspace: ${openClawWorkspace}`),
					);
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
	const existingName =
		existingConfig.name || existingConfig.agent?.name || "My Agent";
	const existingDesc =
		existingConfig.description ||
		existingConfig.agent?.description ||
		"Personal AI assistant";
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

		if (nonInteractive) {
			const migrationEmbeddingProvider = normalizeChoice(
				options.embeddingProvider,
				EMBEDDING_PROVIDER_CHOICES,
			);
			const migrationExtractionProvider = normalizeChoice(
				options.extractionProvider,
				EXTRACTION_PROVIDER_CHOICES,
			);
			if (!migrationEmbeddingProvider) {
				failNonInteractiveSetup(
					"Non-interactive setup requires --embedding-provider (ollama, openai, or none).",
				);
			}
			if (!migrationExtractionProvider) {
				failNonInteractiveSetup(
					"Non-interactive setup requires --extraction-provider (claude-code, ollama, or none).",
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
			const unknown = rawParts.filter(
				(p) => !normalizeChoice(p, SETUP_HARNESS_CHOICES),
			);
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
			configureOpenClawWs =
				options.configureOpenclawWorkspace === true &&
				existingConfigs.length > 0;

			const requestedRuntimePath = normalizeChoice(
				options.openclawRuntimePath,
				OPENCLAW_RUNTIME_CHOICES,
			);
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

	const requestedEmbeddingProvider = normalizeChoice(
		options.embeddingProvider,
		EMBEDDING_PROVIDER_CHOICES,
	);
	const requestedExtractionProvider = normalizeChoice(
		options.extractionProvider,
		EXTRACTION_PROVIDER_CHOICES,
	);

	if (nonInteractive && !requestedEmbeddingProvider) {
		failNonInteractiveSetup(
			"Non-interactive setup requires --embedding-provider (ollama, openai, or none).",
		);
	}

	if (nonInteractive && !requestedExtractionProvider) {
		failNonInteractiveSetup(
			"Non-interactive setup requires --extraction-provider (claude-code, ollama, or none).",
		);
	}

	let embeddingProvider: EmbeddingProviderChoice;
	if (nonInteractive) {
		const providerFromConfig = normalizeChoice(
			existingEmbedding.provider,
			EMBEDDING_PROVIDER_CHOICES,
		);
		embeddingProvider =
			requestedEmbeddingProvider ?? providerFromConfig ?? "none";
	} else {
		console.log();
		embeddingProvider = (await select({
			message: "How should memories be embedded for search?",
			choices: [
				{ value: "ollama", name: "Ollama (local, recommended)" },
				{ value: "openai", name: "OpenAI API" },
				{ value: "none", name: "Skip embeddings for now" },
			],
		})) as EmbeddingProviderChoice;
	}

	// Embedding model selection based on provider
	let embeddingModel = "nomic-embed-text";
	let embeddingDimensions = 768;

	if (embeddingProvider === "ollama") {
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
				normalizeChoice(options.embeddingModel, [
					"text-embedding-3-small",
					"text-embedding-3-large",
				]) ||
				normalizeChoice(existingEmbedding.model, [
					"text-embedding-3-small",
					"text-embedding-3-large",
				]) ||
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
		? requestedSearchBalance ?? existingSearchBalance ?? 0.7
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
		: hasCommand("opencode")
			? "opencode"
			: hasCommand("ollama")
				? "ollama"
				: "none";

	let extractionProvider: ExtractionProviderChoice;
	if (nonInteractive) {
		const providerFromConfig = normalizeChoice(
			existingMemory.pipelineV2?.extractionProvider,
			EXTRACTION_PROVIDER_CHOICES,
		);
		extractionProvider =
			requestedExtractionProvider ?? providerFromConfig ?? detectedProvider;
	} else {
		console.log();
		const choices = [
			{
				value: "claude-code" as const,
				name: `Claude Code (uses your Claude subscription via CLI)${detectedProvider === "claude-code" ? " — detected" : ""}`,
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

	// Git version control setup
	let gitEnabled = false;
	const shouldSkipGit = nonInteractive && options.skipGit === true;

	if (existing.agentsDir) {
		// Directory exists - check if it's a git repo
		if (isGitRepo(basePath)) {
			gitEnabled = true;
			console.log(
				chalk.dim(
					"  Git repo detected. Will create backup commit before changes.",
				),
			);
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
				extraction: {
					provider: extractionProvider,
					model: extractionModel,
				},
				graph: { enabled: true },
				reranker: { enabled: true },
				autonomous: {
					enabled: true,
					allowUpdateDelete: true,
					maintenanceMode: "execute",
				},
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
			console.log(
				chalk.green(`  ● Daemon running at http://localhost:${DEFAULT_PORT}`),
			);
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

// signet dashboard - Launch Web UI
// ============================================================================

async function launchDashboard(options: { path?: string }) {
	console.log(signetLogo());
	const basePath = normalizeAgentPath(
		extractPathOption(options) ?? AGENTS_DIR,
	);

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
	const basePath = normalizeAgentPath(
		extractPathOption(options) ?? AGENTS_DIR,
	);
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

async function showStatus(options: { path?: string }) {
	const basePath = normalizeAgentPath(
		extractPathOption(options) ?? AGENTS_DIR,
	);
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
			const db = Database(join(basePath, "memory", "memories.db"), {
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
	const limit = parseInt(options.lines || "50", 10);
	const { follow, level, category } = options;
	const basePath = normalizeAgentPath(
		extractPathOption(options) ?? AGENTS_DIR,
	);

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

			// Follow mode - stream logs
			if (follow) {
				console.log();
				console.log(chalk.dim("  Streaming logs... (Ctrl+C to stop)\n"));

				const eventSource = new EventSource(
					`http://localhost:${DEFAULT_PORT}/api/logs/stream`,
				);

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
		console.log(
			chalk.yellow("  Daemon not running - reading from log files\n"),
		);
		fallbackToFile();
	}

	function fallbackToFile() {
		// Fall back to reading log files directly
		const logDir = join(basePath, ".daemon", "logs");
		const logFile = join(
			logDir,
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
	.description("Setup wizard (interactive by default)")
	.option("-p, --path <path>", "Base path for agent files")
	.option("--non-interactive", "Run setup without prompts")
	.option("--name <name>", "Agent name (non-interactive mode)")
	.option("--description <description>", "Agent description (non-interactive mode)")
	.option(
		"--harness <harness>",
		"Harness to configure (repeatable or comma-separated: claude-code, opencode, openclaw)",
		collectListOption,
		[],
	)
	.option(
		"--embedding-provider <provider>",
		"Embedding provider in non-interactive mode (ollama, openai, none)",
	)
	.option("--embedding-model <model>", "Embedding model in non-interactive mode")
	.option(
		"--extraction-provider <provider>",
		"Extraction provider in non-interactive mode (claude-code, ollama, none)",
	)
	.option("--extraction-model <model>", "Extraction model in non-interactive mode")
	.option(
		"--search-balance <alpha>",
		"Search balance alpha in non-interactive mode (0-1)",
	)
	.option(
		"--openclaw-runtime-path <mode>",
		"OpenClaw runtime path in non-interactive mode (plugin, legacy)",
	)
	.option(
		"--configure-openclaw-workspace",
		"Patch discovered OpenClaw configs to use the selected setup path in non-interactive mode",
	)
	.option(
		"--open-dashboard",
		"Open dashboard after setup in non-interactive mode",
	)
	.option(
		"--skip-git",
		"Skip git initialization and setup commits in non-interactive mode",
	)
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
async function doStart(options: { path?: string } = {}) {
	console.log(signetLogo());
	const basePath = normalizeAgentPath(
		extractPathOption(options) ?? AGENTS_DIR,
	);

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
	const basePath = normalizeAgentPath(
		extractPathOption(options) ?? AGENTS_DIR,
	);

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

async function doRestart(options: { path?: string } = {}) {
	console.log(signetLogo());
	const basePath = normalizeAgentPath(
		extractPathOption(options) ?? AGENTS_DIR,
	);

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
}

// signet daemon <command> - grouped daemon commands
const daemonCmd = program
	.command("daemon")
	.description("Manage the Signet daemon");

daemonCmd
	.command("start")
	.description("Start the daemon")
	.option("-p, --path <path>", "Base path for agent files")
	.action(doStart);

daemonCmd
	.command("stop")
	.description("Stop the daemon")
	.option("-p, --path <path>", "Base path for agent files")
	.action(doStop);

daemonCmd
	.command("restart")
	.description("Restart the daemon")
	.option("-p, --path <path>", "Base path for agent files")
	.action(doRestart);

daemonCmd
	.command("status")
	.description("Show daemon status")
	.option("-p, --path <path>", "Base path for agent files")
	.action(showStatus);

daemonCmd
	.command("logs")
	.description("View daemon logs")
	.option("-p, --path <path>", "Base path for agent files")
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
	.option("-p, --path <path>", "Base path for agent files")
	.action(doStart);

program
	.command("stop")
	.description("Stop the daemon (alias for: signet daemon stop)")
	.option("-p, --path <path>", "Base path for agent files")
	.action(doStop);

program
	.command("restart")
	.description("Restart the daemon (alias for: signet daemon restart)")
	.option("-p, --path <path>", "Base path for agent files")
	.action(doRestart);

program
	.command("logs")
	.description("View daemon logs (alias for: signet daemon logs)")
	.option("-p, --path <path>", "Base path for agent files")
	.option("-n, --lines <lines>", "Number of lines to show", "50")
	.option("-f, --follow", "Follow log output in real-time")
	.option("-l, --level <level>", "Filter by level (debug, info, warn, error)")
	.option(
		"-c, --category <category>",
		"Filter by category (daemon, api, memory, sync, git, watcher)",
	)
	.action(showLogs);

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

		// Parse existing config
		const existingYaml = readFileSync(agentYamlPath, "utf-8");
		// Simple YAML parsing for our known structure
		const getYamlValue = (key: string, fallback: string) => {
			const match = existingYaml.match(
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
				console.log(chalk.dim("  Current agent.yaml:\n"));
				console.log(
					existingYaml
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

				// Update the YAML
				let updatedYaml = existingYaml;
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

				// Update harnesses in YAML
				const harnessYaml = harnesses.map((h) => `  - ${h}`).join("\n");
				let updatedYaml = existingYaml.replace(
					/^harnesses:\n(  - .+\n)+/m,
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

					// Update embedding section
					let updatedYaml = existingYaml;
					if (existingYaml.includes("embedding:")) {
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

				let updatedYaml = existingYaml;
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

				let updatedYaml = existingYaml;
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
	const res = await fetch(`${DAEMON_URL}${path}`, {
		method,
		headers: body ? { "Content-Type": "application/json" } : {},
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

// Suppress all hook subcommands in spawned agent contexts to prevent
// recursive extraction loops (scheduler spawn, pipeline provider, etc.)
hookCmd.hook("preAction", () => {
	if (process.env.SIGNET_NO_HOOKS === "1") {
		process.exit(0);
	}
});

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
		}>("/api/update/run", {
			method: "POST",
			timeout: 120_000,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ targetVersion: check.latestVersion }),
		});

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
			hasCredentials?: boolean;
			authMethod?: string;
			autoSync?: boolean;
			lastSync?: string;
			uncommittedChanges?: number;
			unpushedCommits?: number;
			unpulledCommits?: number;
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

		// Show auth status with context-appropriate messaging
		if (data.authMethod === "no-remote") {
			console.log(
				`  ${chalk.dim("Auth:")}       ${chalk.dim("no remote configured")}`,
			);
		} else if (data.hasCredentials) {
			console.log(
				`  ${chalk.dim("Auth:")}       ${chalk.green(data.authMethod || "configured")}`,
			);
		} else {
			console.log(
				`  ${chalk.dim("Auth:")}       ${chalk.yellow("no credentials")}`,
			);
		}

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

		if (data.unpulledCommits !== undefined && data.unpulledCommits > 0) {
			console.log(
				`  ${chalk.dim("Unpulled:")}   ${chalk.cyan(data.unpulledCommits + " commits")}`,
			);
		}

		// Context-appropriate help message
		if (data.authMethod === "no-remote") {
			console.log(
				chalk.dim("\n  To enable sync: git -C ~/.agents remote add origin <url>"),
			);
		} else if (!data.hasCredentials) {
			console.log(
				chalk.dim("\n  To enable sync: gh auth login, or signet secret put GITHUB_TOKEN"),
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
			const db = Database(dbPath, { readonly: true });

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
			const db = Database(dbPath);

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
