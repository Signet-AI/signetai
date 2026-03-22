import { confirm } from "@inquirer/prompts";
import { OpenClawConnector } from "@signet/connector-openclaw";
import { detectSchema, ensureUnifiedSchema, parseSimpleYaml, runMigrations } from "@signet/core";
import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import open from "open";
import ora from "ora";
import type { LogOptions, PathOptions, RestartOptions } from "../commands/shared.js";
import Database from "../sqlite.js";

interface DaemonStatus {
	readonly running: boolean;
	readonly pid: number | null;
	readonly uptime: number | null;
	readonly version: string | null;
}

interface LogEntry {
	readonly timestamp: string;
	readonly level: "debug" | "info" | "warn" | "error";
	readonly category: string;
	readonly message: string;
	readonly data?: Record<string, unknown>;
	readonly duration?: number;
	readonly error?: {
		readonly name: string;
		readonly message: string;
		readonly stack?: string;
	};
}

interface LogPayload {
	readonly logs: readonly LogEntry[];
	readonly count: number;
}

interface Deps {
	readonly agentsDir: string;
	readonly defaultPort: number;
	readonly extractPathOption: (value: unknown) => string | null;
	readonly getDaemonStatus: () => Promise<DaemonStatus>;
	readonly isDaemonRunning: () => Promise<boolean>;
	readonly normalizeAgentPath: (pathValue: string) => string;
	readonly signetLogo: () => string;
	readonly sleep: (ms: number) => Promise<void>;
	readonly startDaemon: (agentsDir?: string) => Promise<boolean>;
	readonly stopDaemon: (agentsDir?: string) => Promise<boolean>;
}

export async function launchDashboard(options: PathOptions, deps: Deps): Promise<void> {
	console.log(deps.signetLogo());
	const basePath = readPath(options, deps);
	const running = await deps.isDaemonRunning();

	if (!running) {
		console.log(chalk.yellow("  Daemon is not running. Starting..."));
		const started = await deps.startDaemon(basePath);
		if (!started) {
			console.error(chalk.red("  Failed to start daemon"));
			process.exit(1);
		}
		console.log(chalk.green("  Daemon started"));
	}

	console.log();
	console.log(`  ${chalk.cyan(`http://localhost:${deps.defaultPort}`)}`);
	console.log();

	await open(`http://localhost:${deps.defaultPort}`);
}

export async function migrateSchema(options: PathOptions, deps: Deps): Promise<void> {
	const basePath = readPath(options, deps);
	const dbPath = join(basePath, "memory", "memories.db");

	console.log(deps.signetLogo());

	if (!existsSync(dbPath)) {
		console.log(chalk.yellow("  No database found."));
		console.log(`  Run ${chalk.bold("signet setup")} to create one.`);
		return;
	}

	const spinner = ora("Checking database schema...").start();
	let db: ReturnType<typeof Database> | null = null;

	try {
		db = Database(dbPath, { readonly: true });
		const info = detectSchema(db);
		db.close();
		db = null;

		if (info.type === "core") {
			spinner.succeed("Database already on unified schema");
			return;
		}

		if (info.type === "unknown" && !info.hasMemories) {
			spinner.succeed("Database is empty or has no memories");
			return;
		}

		spinner.text = `Migrating from ${info.type} schema...`;
		spinner.info();

		const running = await deps.isDaemonRunning();
		if (running) {
			console.log(chalk.dim("  Stopping daemon for migration..."));
			const stopped = await deps.stopDaemon(basePath);
			if (!stopped) {
				spinner.fail("Migration aborted");
				console.log(chalk.red("  Could not stop the daemon cleanly before migration."));
				return;
			}
			await deps.sleep(1000);
		}

		db = Database(dbPath);
		const result = ensureUnifiedSchema(db);
		printMigrationErrors(result.errors);

		if (result.migrated) {
			console.log(chalk.green(`  ✓ Migrated ${result.memoriesMigrated} memories from ${result.fromSchema} to ${result.toSchema}`));
		} else {
			console.log(chalk.dim("  No migration needed"));
		}

		runMigrations(db);
		db.close();
		db = null;

		if (running) {
			console.log(chalk.dim("  Restarting daemon..."));
			const restarted = await deps.startDaemon(basePath);
			if (!restarted) {
				console.log(chalk.yellow("  Migration finished, but the daemon did not restart cleanly."));
				return;
			}
		}

		console.log();
		console.log(chalk.green("  Migration complete!"));
	} catch (err) {
		spinner.fail("Migration failed");
		console.log(chalk.red(`  ${readErr(err)}`));
	} finally {
		db?.close();
	}
}

export async function showLogs(options: LogOptions, deps: Deps): Promise<void> {
	const limit = readLogLimit(options.lines);
	const basePath = readPath(options, deps);

	console.log(deps.signetLogo());

	const status = await deps.getDaemonStatus();
	if (status.running) {
		const logs = await fetchApiLogs(limit, options, deps);
		if (logs !== null) {
			printApiLogs(logs);
			if (options.follow) {
				await followLogs(deps.defaultPort);
			}
			return;
		}

		console.log(chalk.yellow("  Could not fetch logs from daemon"));
		readFileLogs(basePath, limit, options);
		return;
	}

	console.log(chalk.yellow("  Daemon not running - reading from log files\n"));
	readFileLogs(basePath, limit, options);
}

export async function doStart(options: PathOptions, deps: Deps): Promise<void> {
	console.log(deps.signetLogo());
	const basePath = readPath(options, deps);
	const running = await deps.isDaemonRunning();
	if (running) {
		console.log(chalk.yellow("  Daemon is already running"));
		return;
	}

	const spinner = ora("Starting daemon...").start();
	const started = await deps.startDaemon(basePath);
	if (started) {
		spinner.succeed("Daemon started");
		console.log(chalk.dim(`  Dashboard: http://localhost:${deps.defaultPort}`));
		return;
	}

	spinner.fail("Failed to start daemon");
}

export async function doStop(options: PathOptions, deps: Deps): Promise<void> {
	console.log(deps.signetLogo());
	const basePath = readPath(options, deps);
	const running = await deps.isDaemonRunning();
	if (!running) {
		console.log(chalk.yellow("  Daemon is not running"));
		return;
	}

	const spinner = ora("Stopping daemon...").start();
	const stopped = await deps.stopDaemon(basePath);
	if (stopped) {
		spinner.succeed("Daemon stopped");
		return;
	}

	spinner.fail("Failed to stop daemon");
}

export async function doRestart(options: RestartOptions, deps: Deps): Promise<void> {
	console.log(deps.signetLogo());
	const basePath = readPath(options, deps);
	const spinner = ora("Restarting daemon...").start();
	const running = await deps.isDaemonRunning();

	if (running) {
		const stopped = await deps.stopDaemon(basePath);
		if (!stopped) {
			spinner.fail("Failed to stop daemon");
			return;
		}
		await deps.sleep(500);
	}

	const started = await deps.startDaemon(basePath);

	if (started) {
		spinner.succeed(running ? "Daemon restarted" : "Daemon started");
		console.log(chalk.dim(`  Dashboard: http://localhost:${deps.defaultPort}`));
	} else {
		spinner.fail("Failed to restart daemon");
		return;
	}

	if (options.openclaw === false || !isOpenClawDetected()) {
		return;
	}

	const restart = await confirm({
		message: "Restart connected OpenClaw instance?",
		default: false,
	});
	if (restart) {
		await restartOpenClaw(basePath);
	}
}

function readPath(options: PathOptions, deps: Deps): string {
	return deps.normalizeAgentPath(deps.extractPathOption(options) ?? deps.agentsDir);
}

function printMigrationErrors(errors: readonly string[]): void {
	for (const err of errors) {
		console.log(chalk.red(`  Error: ${err}`));
	}
}

async function fetchApiLogs(limit: number, options: LogOptions, deps: Deps): Promise<LogPayload | null> {
	try {
		const params = new URLSearchParams({ limit: String(limit) });
		if (options.level) {
			params.set("level", options.level);
		}
		if (options.category) {
			params.set("category", options.category);
		}

		const res = await fetch(`http://localhost:${deps.defaultPort}/api/logs?${params}`);
		const json = await res.json();
		return readLogPayload(json);
	} catch {
		return null;
	}
}

function printApiLogs(payload: LogPayload): void {
	if (payload.logs.length === 0) {
		console.log(chalk.dim("  No logs found"));
		return;
	}

	console.log(chalk.bold(`  Recent Logs (${payload.count})\n`));
	for (const entry of payload.logs) {
		console.log(`  ${formatLogEntry(entry)}`);
	}
}

async function followLogs(port: number): Promise<void> {
	console.log();
	console.log(chalk.dim("  Streaming logs... (Ctrl+C to stop)\n"));

	await new Promise<void>((resolve) => {
		const source = new EventSource(`http://localhost:${port}/api/logs/stream`);
		source.onmessage = (event) => {
			try {
				const json = JSON.parse(event.data);
				const entry = readLogEntry(json);
				if (entry === null || entry.category === "connected") {
					return;
				}
				console.log(`  ${formatLogEntry(entry)}`);
			} catch {
				// Ignore parse errors
			}
		};

		source.onerror = () => {
			console.log(chalk.red("  Stream disconnected"));
			source.close();
			resolve();
		};
	});
}

function readFileLogs(basePath: string, limit: number, options: LogOptions): void {
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
			const json = JSON.parse(line);
			const entry = readLogEntry(json);
			if (entry === null) {
				console.log(`  ${line}`);
				continue;
			}
			if (options.level && entry.level !== options.level) {
				continue;
			}
			if (options.category && entry.category !== options.category) {
				continue;
			}
			console.log(`  ${formatLogEntry(entry)}`);
		} catch {
			console.log(`  ${line}`);
		}
	}
}

function formatLogEntry(entry: LogEntry): string {
	const colors = {
		debug: chalk.gray,
		info: chalk.cyan,
		warn: chalk.yellow,
		error: chalk.red,
	};
	const paint = colors[entry.level] ?? chalk.white;
	const time = entry.timestamp.split("T")[1]?.slice(0, 8) || "";
	const level = entry.level.toUpperCase().padEnd(5);
	const category = `[${entry.category}]`.padEnd(12);

	let line = `${chalk.dim(time)} ${paint(level)} ${category} ${entry.message}`;
	if (typeof entry.duration === "number") {
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

function isOpenClawDetected(): boolean {
	return new OpenClawConnector().getDiscoveredConfigPaths().length > 0;
}

async function restartOpenClaw(basePath: string): Promise<boolean> {
	const yamlPath = join(basePath, "agent.yaml");
	let cmd: string | null = null;

	try {
		const yaml = readFileSync(yamlPath, "utf-8");
		const cfg = parseSimpleYaml(yaml);
		cmd = readRestartCommand(cfg);
	} catch {
		// Ignore
	}

	if (!cmd) {
		console.log();
		console.log(chalk.yellow("  No OpenClaw restart command configured."));
		console.log(chalk.dim("  Add to ~/.agents/agent.yaml:"));
		console.log(chalk.dim("    services:"));
		console.log(chalk.dim("      openclaw:"));
		console.log(chalk.dim('        restart_command: "systemctl --user restart openclaw"'));
		return false;
	}

	const spinner = ora("Restarting OpenClaw...").start();
	try {
		const shell = process.platform === "win32" ? "cmd" : "sh";
		const args = process.platform === "win32" ? ["/c", cmd] : ["-c", cmd];
		const result = spawnSync(shell, args, {
			timeout: 15_000,
			stdio: "pipe",
			windowsHide: true,
		});
		if (result.status === 0) {
			spinner.succeed("OpenClaw restarted");
			return true;
		}
		const stderr = readSpawnErr(result.stderr);
		spinner.fail(`OpenClaw restart failed${stderr ? `: ${stderr}` : ""}`);
		return false;
	} catch {
		spinner.fail("OpenClaw restart timed out");
		return false;
	}
}

function readLogPayload(value: unknown): LogPayload | null {
	if (!isRecord(value)) {
		return null;
	}
	if (!Array.isArray(value.logs) || typeof value.count !== "number") {
		return null;
	}
	const logs = value.logs.flatMap((entry) => {
		const log = readLogEntry(entry);
		return log === null ? [] : [log];
	});
	return { logs, count: value.count };
}

function readLogLimit(value: string | undefined): number {
	if (!value) {
		return 50;
	}

	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return 50;
	}

	return parsed;
}

function readLogEntry(value: unknown): LogEntry | null {
	if (!isRecord(value)) {
		return null;
	}
	const timestamp = readString(value.timestamp);
	const category = readString(value.category);
	const message = readString(value.message);
	const level = readLevel(value.level);
	if (!timestamp || !category || !message || !level) {
		return null;
	}

	const data = isRecord(value.data) ? value.data : undefined;
	const duration = typeof value.duration === "number" ? value.duration : undefined;
	const error = readLogError(value.error);
	return { timestamp, level, category, message, data, duration, error };
}

function readLogError(value: unknown): LogEntry["error"] | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const name = readString(value.name);
	const message = readString(value.message);
	if (!name || !message) {
		return undefined;
	}
	const stack = readString(value.stack) ?? undefined;
	return { name, message, stack };
}

function readLevel(value: unknown): LogEntry["level"] | null {
	switch (value) {
		case "debug":
		case "info":
		case "warn":
		case "error":
			return value;
		default:
			return null;
	}
}

function readRestartCommand(value: unknown): string | null {
	if (!isRecord(value)) {
		return null;
	}
	const services = value.services;
	if (!isRecord(services)) {
		return null;
	}
	const openclaw = services.openclaw;
	if (!isRecord(openclaw)) {
		return null;
	}
	return readString(openclaw.restart_command);
}

function readSpawnErr(value: string | Buffer | null): string {
	if (typeof value === "string") {
		return value.trim();
	}
	if (value instanceof Buffer) {
		return value.toString("utf-8").trim();
	}
	return "";
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readErr(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
