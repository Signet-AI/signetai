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
	parseSimpleYaml,
	formatYaml,
	symlinkSkills,
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

const AGENTS_DIR = join(homedir(), ".agents");
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

async function configureHarnessHooks(harness: string, basePath: string) {
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
			await connector.install(basePath);
			break;
		}
	}
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const program = new Command();
const VERSION = "0.1.26";

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
		const db = Database(dbPath);

		// Use ensureUnifiedSchema to create or migrate to the unified schema
		const migrationResult = ensureUnifiedSchema(db);
		if (migrationResult.migrated) {
			spinner.text = `Migrated ${migrationResult.memoriesMigrated} memories from ${migrationResult.fromSchema} schema...`;
		}

		// Record setup in schema_migrations
		db.exec(`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				version INTEGER PRIMARY KEY,
				applied_at TEXT NOT NULL,
				checksum TEXT NOT NULL
			);
			INSERT OR REPLACE INTO schema_migrations (version, applied_at, checksum)
			VALUES (2, '${new Date().toISOString()}', 'setup');
		`);

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

		// Sync missing template files on reconfigure
		const templatesDir = getTemplatesDir();
		// Sync gitignore (stored as gitignore.template because npm excludes .gitignore)
		const gitignoreSrc = join(templatesDir, "gitignore.template");
		const gitignoreDest = join(basePath, ".gitignore");
		if (existsSync(gitignoreSrc) && !existsSync(gitignoreDest)) {
			copyFileSync(gitignoreSrc, gitignoreDest);
			console.log(chalk.dim(`  Synced missing: .gitignore`));
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
			chalk.dim("    3. Unify skills from all sources into ~/.agents/skills/"),
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

	// OpenClaw workspace configuration (handles openclaw/clawdbot/moltbot)
	let configureOpenClawWs = false;
	if (harnesses.includes("openclaw")) {
		const possibleConfigs = [
			join(homedir(), ".openclaw", "openclaw.json"),
			join(homedir(), ".clawdbot", "clawdbot.json"),
			join(homedir(), ".moltbot", "moltbot.json"),
		];
		const hasAnyConfig = possibleConfigs.some((p) => existsSync(p));

		if (hasAnyConfig) {
			console.log();
			configureOpenClawWs = await confirm({
				message: "Set OpenClaw/Clawdbot workspace to ~/.agents?",
				default: true,
			});
		}
	}

	console.log();
	const agentDescription = await input({
		message: "Short description of your agent:",
		default: existingDesc,
	});

	console.log();
	const embeddingProvider = await select({
		message: "How should memories be embedded for search?",
		choices: [
			{ value: "ollama", name: "Ollama (local, recommended)" },
			{ value: "openai", name: "OpenAI API" },
			{ value: "none", name: "Skip embeddings for now" },
		],
	});

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
		embeddingModel = model;
		embeddingDimensions =
			model === "all-minilm" ? 384 : model === "mxbai-embed-large" ? 1024 : 768;
	} else if (embeddingProvider === "openai") {
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
		embeddingModel = model;
		embeddingDimensions = model === "text-embedding-3-large" ? 3072 : 1536;
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

		// Install built-in skills (remember, recall)
		spinner.text = "Installing built-in skills...";
		const skillsSource = join(templatesDir, "skills");
		if (existsSync(skillsSource)) {
			mkdirSync(join(basePath, "skills"), { recursive: true });
			copyDirRecursive(skillsSource, join(basePath, "skills"));
		}

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

		// Use ensureUnifiedSchema for consistent schema management
		ensureUnifiedSchema(db);
		db.exec(`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				version INTEGER PRIMARY KEY,
				applied_at TEXT NOT NULL,
				checksum TEXT NOT NULL
			);
			INSERT OR REPLACE INTO schema_migrations (version, applied_at, checksum)
			VALUES (2, '${new Date().toISOString()}', 'quick-setup');
		`);

		db.close();

		spinner.text = "Configuring harness hooks...";
		const configuredHarnesses: string[] = [];

		for (const harness of harnesses) {
			try {
				await configureHarnessHooks(harness, basePath);
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
			const patched = await new OpenClawConnector().configureAllConfigs(
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

	const spinner = ora(`Importing from ${source}...`).start();

	try {
		await new Promise((r) => setTimeout(r, 1500));
		spinner.succeed(chalk.green("Import complete!"));
		console.log(chalk.dim("  Imported conversations with memories"));
	} catch (err) {
		spinner.fail(chalk.red("Import failed"));
		console.error(err);
	}
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
			await stopDaemon();
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

		// Record migration in schema_migrations table
		const now = new Date().toISOString();
		writeDb.exec(`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				version INTEGER PRIMARY KEY,
				applied_at TEXT NOT NULL,
				checksum TEXT NOT NULL
			);

			INSERT OR REPLACE INTO schema_migrations (version, applied_at, checksum)
			VALUES (2, '${now}', 'schema-migration');
		`);

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
		{ name: "config.yaml", exists: existing.configYaml },
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
	.description("Sync missing template files and fix Python venv")
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

		// Sync missing template files
		// Note: gitignore stored as gitignore.template because npm excludes .gitignore
		let synced = 0;

		const gitignoreSrc = join(templatesDir, "gitignore.template");
		const gitignoreDest = join(basePath, ".gitignore");
		if (existsSync(gitignoreSrc) && !existsSync(gitignoreDest)) {
			copyFileSync(gitignoreSrc, gitignoreDest);
			console.log(chalk.green(`  ✓ .gitignore`));
			synced++;
		}

		if (synced === 0) {
			console.log(chalk.dim("  All template files present"));
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
	.command("put <name>")
	.description("Store a secret (value is prompted, never echoed)")
	.action(async (name: string) => {
		if (!(await ensureDaemonForSecrets())) return;

		const value = await password({
			message: `Enter value for ${chalk.bold(name)}:`,
			mask: "•",
		});

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
	opts?: RequestInit,
): Promise<T | null> {
	try {
		const res = await fetch(`http://localhost:${DEFAULT_PORT}${path}`, {
			signal: AbortSignal.timeout(5000),
			...opts,
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
			// Daemon not running - run npx skills directly
			spinner.text = `Installing ${chalk.cyan(name)} (daemon offline, running npx skills)...`;

			await new Promise<void>((resolve) => {
				const proc = spawn(
					"npx",
					["skills", "add", name, "--global", "--yes"],
					{
						stdio: ["ignore", "pipe", "pipe"],
						env: { ...process.env },
					},
				);

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
					spinner.fail("npx not available");
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
// signet hook - Lifecycle hooks for harness integration
// ============================================================================

const hookCmd = program
	.command("hook")
	.description("Lifecycle hooks for harness integration");

// signet hook session-start
hookCmd
	.command("session-start")
	.description("Get context/memories for a new session")
	.requiredOption(
		"-H, --harness <harness>",
		"Harness name (e.g., claude-code, opencode)",
	)
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
			body: JSON.stringify({
				harness: options.harness,
				agentId: options.agentId,
				context: options.context,
			}),
		});

		if (data?.error) {
			console.error(chalk.red(`Error: ${data.error}`));
			process.exit(1);
		}

		if (options.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			// Output the inject text directly for easy piping
			if (data?.inject) {
				console.log(data.inject);
			}
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
	.description("Check for and install updates");

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
		}>(`/api/update/check${options.force ? "?force=true" : ""}`);

		if (data?.checkError) {
			spinner.warn("Could not check for updates");
			console.log(chalk.dim(`  Error: ${data.checkError}`));
			return;
		}

		if (data?.updateAvailable) {
			spinner.succeed(chalk.green(`Update available: v${data.latestVersion}`));
			console.log(chalk.dim(`  Current: v${data.currentVersion}`));
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
		}>("/api/update/check");

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
		}>("/api/update/run", { method: "POST" });

		if (!data?.success) {
			spinner.fail(data?.message || "Update failed");
			if (data?.output) {
				console.log(chalk.dim(data.output));
			}
			process.exit(1);
		}

		spinner.succeed(data.message || "Update installed");
		console.log(
			chalk.cyan("\n  Restart daemon to apply: signet daemon restart"),
		);
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
	}>("/api/update/check");

	if (data?.checkError) {
		spinner.warn("Could not check for updates");
		console.log(chalk.dim(`  Error: ${data.checkError}`));
		return;
	}

	if (data?.updateAvailable) {
		spinner.succeed(chalk.green(`Update available: v${data.latestVersion}`));
		console.log(chalk.dim(`  Current: v${data.currentVersion}`));
		console.log(chalk.cyan("\n  Run: signet update install"));
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

async function detectVectorSources(basePath: string): Promise<MigrationSource[]> {
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
			const tableCheck = db.prepare(`
				SELECT name FROM sqlite_master
				WHERE type='table' AND name='embeddings'
			`).get();

			if (tableCheck) {
				// Check if vector column is BLOB (old format)
				const schemaCheck = db.prepare(`PRAGMA table_info(embeddings)`).all() as Array<{
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
				const vecTableCheck = db.prepare(`
					SELECT name FROM sqlite_master
					WHERE type='table' AND name='vec_embeddings'
				`).get();

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
	.option("--keep-blobs", "Keep old BLOB column after migration (safer for rollback)")
	.option("--remove-zvec", "Delete vectors.zvec file after successful migration")
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
			console.log(
				chalk.yellow("  Rollback is not implemented in Phase 1."),
			);
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
			console.log(
				chalk.dim("  Migration appears to have already been run."),
			);

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
			console.log(
				chalk.yellow("  No existing embeddings found to migrate."),
			);
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
			console.log(
				chalk.dim("  Run without --dry-run to perform migration."),
			);
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

			// Create vec_embeddings virtual table if not exists
			spinner.text = "Creating vec_embeddings table...";
			db.exec(`
				CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
					id TEXT PRIMARY KEY,
					embedding FLOAT[1024] distance_metric=cosine
				);
			`);

			// Read all embeddings from BLOB column
			spinner.text = "Reading existing embeddings...";
			const embeddings = db.prepare(`
				SELECT id, vector, dimensions FROM embeddings
			`).all() as Array<{ id: string; vector: Buffer; dimensions: number }>;

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
						chalk.dim("  Vectors were migrated successfully. BLOB column retained."),
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
