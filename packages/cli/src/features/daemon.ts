import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import { detectSchema, ensureUnifiedSchema, runMigrations } from "@signet/core";
import chalk from "chalk";
import open from "open";
import ora from "ora";
import type { LogOptions, PathOptions, RestartOptions } from "../commands/shared.js";
import { daemonAccessLines } from "../lib/network.js";
import Database from "../sqlite.js";
import { readPipelinePauseState, releaseOllamaModels, setPipelinePaused } from "./pipeline-pause.js";

interface DaemonStatus {
	readonly running: boolean;
	readonly pid: number | null;
	readonly uptime: number | null;
	readonly version: string | null;
	readonly host: string | null;
	readonly bindHost: string | null;
	readonly networkMode: string | null;
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
	readonly hasDaemonProcess: (agentsDir?: string) => Promise<boolean>;
	readonly isDaemonRunning: () => Promise<boolean>;
	readonly normalizeAgentPath: (pathValue: string) => string;
	readonly signetLogo: () => string;
	readonly sleep: (ms: number) => Promise<void>;
	readonly startDaemon: (agentsDir?: string) => Promise<boolean>;
	readonly stopDaemon: (agentsDir?: string) => Promise<boolean>;
	readonly confirmRestartSync?: () => Promise<boolean>;
	readonly isInteractive?: () => boolean;
	readonly syncTemplates?: (basePath: string) => Promise<void>;
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
			console.log(
				chalk.green(`  ✓ Migrated ${result.memoriesMigrated} memories from ${result.fromSchema} to ${result.toSchema}`),
			);
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
		const status = await deps.getDaemonStatus();
		for (const line of daemonAccessLines(deps.defaultPort, status)) {
			console.log(chalk.dim(`  ${line}`));
		}
		return;
	}

	spinner.fail("Failed to start daemon");
	process.exit(1);
}

export async function doStop(options: PathOptions, deps: Deps): Promise<void> {
	console.log(deps.signetLogo());
	const basePath = readPath(options, deps);
	const running = await deps.isDaemonRunning();
	const stale = running ? false : await deps.hasDaemonProcess(basePath);
	if (!running && !stale) {
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
	process.exit(1);
}

export async function doRestart(options: RestartOptions, deps: Deps): Promise<void> {
	console.log(deps.signetLogo());
	const basePath = readPath(options, deps);
	const spinner = ora("Restarting daemon...").start();
	const running = await deps.isDaemonRunning();
	const stale = running ? false : await deps.hasDaemonProcess(basePath);

	if (running || stale) {
		const stopped = await deps.stopDaemon(basePath);
		if (!stopped) {
			spinner.fail("Failed to stop daemon");
			process.exit(1);
		}
		await deps.sleep(500);
	}

	const started = await deps.startDaemon(basePath);

	if (started) {
		spinner.succeed(running || stale ? "Daemon restarted" : "Daemon started");
		const status = await deps.getDaemonStatus();
		for (const line of daemonAccessLines(deps.defaultPort, status)) {
			console.log(chalk.dim(`  ${line}`));
		}
	} else {
		spinner.fail("Failed to restart daemon");
		process.exit(1);
	}

	if (options.openclaw === false) {
		console.log(chalk.yellow("  --no-openclaw is deprecated; use --no-sync instead."));
	}

	if (
		options.sync === false ||
		options.openclaw === false ||
		!deps.syncTemplates ||
		!(deps.isInteractive ?? isInteractiveTerminal)()
	) {
		return;
	}

	const sync = await (deps.confirmRestartSync ?? confirmRestartSync)();
	if (sync) {
		await deps.syncTemplates(basePath);
	}
}

export async function doPause(options: PathOptions, deps: Deps): Promise<void> {
	await togglePipelinePause(options, deps, true);
}

export async function doResume(options: PathOptions, deps: Deps): Promise<void> {
	await togglePipelinePause(options, deps, false);
}

function readPath(options: PathOptions, deps: Deps): string {
	return deps.normalizeAgentPath(deps.extractPathOption(options) ?? deps.agentsDir);
}

interface PipelinePauseApiResponse {
	readonly changed: boolean;
	readonly file: string | null;
	readonly mode: string;
	readonly paused: boolean;
	readonly success: boolean;
}

type PipelinePauseApiResult =
	| {
			readonly kind: "fallback";
	  }
	| {
			readonly data: PipelinePauseApiResponse;
			readonly kind: "ok";
	  };

function isPipelinePauseRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPipelinePauseApiResponse(value: unknown): PipelinePauseApiResponse | null {
	if (!isPipelinePauseRecord(value)) return null;
	if (value.success !== true) return null;
	if (typeof value.changed !== "boolean") return null;
	if (typeof value.paused !== "boolean") return null;
	if (value.file !== null && typeof value.file !== "string") return null;
	if (typeof value.mode !== "string") return null;
	return {
		changed: value.changed,
		file: value.file,
		mode: value.mode,
		paused: value.paused,
		success: true,
	};
}

function readApiError(value: unknown, fallback: string): string {
	if (!isRecord(value)) return fallback;
	return typeof value.error === "string" && value.error.length > 0 ? value.error : fallback;
}

export async function requestPipelinePauseApi(
	port: number,
	paused: boolean,
	doFetch: typeof fetch = fetch,
): Promise<PipelinePauseApiResult> {
	let res: Response;
	try {
		res = await doFetch(`http://localhost:${port}/api/pipeline/${paused ? "pause" : "resume"}`, {
			method: "POST",
		});
	} catch {
		return { kind: "fallback" };
	}

	if (res.status === 401 || res.status === 403 || res.status === 404) {
		return { kind: "fallback" };
	}

	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}

	if (!res.ok) {
		throw new Error(readApiError(body, `Daemon returned HTTP ${res.status}`));
	}

	const data = readPipelinePauseApiResponse(body);
	if (data === null) {
		throw new Error("Daemon returned an invalid pause response");
	}

	return { kind: "ok", data };
}

function printReleaseResults(results: readonly Awaited<ReturnType<typeof releaseOllamaModels>>[number][]): void {
	if (results.length === 0) return;
	const ok = results.filter((item) => item.ok).length;
	const failed = results.length - ok;
	if (ok > 0) {
		console.log(chalk.dim(`  Released ${ok} local Ollama model${ok === 1 ? "" : "s"} from memory.`));
	}
	for (const item of results.filter((entry) => !entry.ok)) {
		console.log(
			chalk.yellow(`  Failed to release ${item.label} model ${item.model}: ${item.error ?? "unknown error"}`),
		);
	}
	if (failed === 0) {
		console.log(chalk.dim("  Local Ollama VRAM should clear as those models unload."));
	}
}

function readPipelineMode(state: { readonly enabled: boolean; readonly paused: boolean }): string {
	if (state.enabled === false) return "disabled";
	if (state.paused) return "paused";
	return "controlled-write";
}

export function summarizePipelineToggle(
	paused: boolean,
	mode: string,
	running: boolean,
): { readonly detail: string; readonly title: string } {
	if (paused) {
		return {
			title: running ? "Extraction pipeline paused" : "Pipeline pause recorded",
			detail: running
				? "  New memories can still queue for later extraction while workers stay offline."
				: "  The daemon is not running. New extraction work will stay paused on next start.",
		};
	}

	if (mode === "disabled") {
		return {
			title: running ? "Pipeline pause cleared, still disabled" : "Pipeline pause cleared",
			detail: running
				? "  Pause flag cleared, but the pipeline is still disabled in config. Enable it before extraction can run."
				: "  The daemon is not running, and the pipeline is still disabled in config. Enable it before extraction can resume on next start.",
		};
	}

	return {
		title: running ? "Extraction pipeline resumed" : "Pipeline resume recorded",
		detail: running
			? "  Queued extraction work can drain again now that the pipeline is active."
			: "  The daemon is not running. Normal extraction will resume on next start.",
	};
}

async function togglePipelinePause(options: PathOptions, deps: Deps, paused: boolean): Promise<void> {
	console.log(deps.signetLogo());
	const basePath = readPath(options, deps);

	let state: ReturnType<typeof readPipelinePauseState>;
	try {
		state = readPipelinePauseState(basePath);
	} catch (err) {
		console.log(chalk.red(`  ${readErr(err)}`));
		return;
	}

	if (!state.exists) {
		console.log(chalk.red("  No Signet config file found."));
		console.log(chalk.dim("  Run `signet setup` first."));
		return;
	}

	if (paused && state.enabled === false) {
		console.log(chalk.yellow("  Pipeline is disabled in config, nothing to pause."));
		return;
	}

	if (!paused && state.enabled === false && state.paused === false) {
		console.log(chalk.yellow("  Pipeline is disabled in config. Enable it before resuming."));
		return;
	}

	if (state.paused === paused) {
		console.log(
			chalk.yellow(paused ? "  Extraction pipeline is already paused." : "  Extraction pipeline is already active."),
		);
		return;
	}

	const spinner = ora(paused ? "Pausing extraction pipeline..." : "Resuming extraction pipeline...").start();

	try {
		const running = await deps.isDaemonRunning();
		if (running) {
			const live = await requestPipelinePauseApi(deps.defaultPort, paused);
			if (live.kind === "ok") {
				const summary = summarizePipelineToggle(paused, live.data.mode, true);
				const released = paused ? await releaseOllamaModels(basePath) : [];
				spinner.succeed(summary.title);
				if (live.data.file) {
					console.log(chalk.dim(`  Config: ${live.data.file}`));
				}
				const status = await deps.getDaemonStatus();
				for (const line of daemonAccessLines(deps.defaultPort, status)) {
					console.log(chalk.dim(`  ${line}`));
				}
				printReleaseResults(released);
				console.log(chalk.dim(summary.detail));
				return;
			}
		}

		const next = setPipelinePaused(basePath, paused);
		if (!running) {
			const summary = summarizePipelineToggle(paused, readPipelineMode(next), false);
			spinner.succeed(summary.title);
			console.log(chalk.dim(`  Config: ${next.file}`));
			console.log(chalk.dim(summary.detail));
			return;
		}

		const stopped = await deps.stopDaemon(basePath);
		if (!stopped) {
			spinner.fail("Failed to restart daemon after updating config");
			return;
		}

		const released = paused ? await releaseOllamaModels(basePath) : [];
		await deps.sleep(500);

		const started = await deps.startDaemon(basePath);
		if (!started) {
			spinner.fail("Config updated, but daemon failed to restart");
			return;
		}

		const summary = summarizePipelineToggle(paused, readPipelineMode(next), true);
		spinner.succeed(summary.title);
		console.log(chalk.dim(`  Config: ${next.file}`));
		const status = await deps.getDaemonStatus();
		for (const line of daemonAccessLines(deps.defaultPort, status)) {
			console.log(chalk.dim(`  ${line}`));
		}
		printReleaseResults(released);
		console.log(chalk.dim(summary.detail));
	} catch (err) {
		spinner.fail(paused ? "Failed to pause extraction pipeline" : "Failed to resume extraction pipeline");
		console.log(chalk.red(`  ${readErr(err)}`));
	}
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

function isInteractiveTerminal(): boolean {
	return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function confirmRestartSync(): Promise<boolean> {
	return confirm({
		message: "Run `signet sync` now?",
		default: false,
	});
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

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readErr(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
