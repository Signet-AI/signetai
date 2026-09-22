import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogCategory =
	| "daemon"
	| "api"
	| "memory"
	| "sync"
	| "git"
	| "github-source"
	| "watcher"
	| "embedding"
	| "harness"
	| "skills"
	| "plugins"
	| "secrets"
	| "hooks"
	| "pipeline"
	| "inference"
	| "embedding-tracker"
	| "synthesis"
	| "session-memories"
	| "predictor"
	| "maintenance"
	| "retention"
	| "reflections"
	| "session-tracker"
	| "system"
	| "update"
	| "probe"
	| "event-bus"
	| "event-bridge"
	| "widget"
	| "os-chat"
	| "os-agent"
	| "mcp-analytics"
	| "config"
	| "config-migration"
	| "diagnostics"
	| "dreaming"
	| "http"
	| "resources"
	| "connectors"
	| "documents"
	| "projection"
	| "os"
	| "changelog"
	| "auth"
	| "reconciler"
	| "llm"
	| "native-embedding"
	| "document-worker"
	| "dreaming-worker"
	| "model-registry"
	| "structural-classify"
	| "structural-dependency"
	| "training-pairs"
	| "telemetry"
	| "temporal-fallback"
	| "checkpoints"
	| "system-pressure"
	| "yielding-writes"
	| "startup-recovery"
	| "db-vacuum"
	| "transcripts"
	| "shadow";

export interface LogEntry {
	timestamp: string;
	level: LogLevel;
	category: LogCategory;
	message: string;
	data?: Record<string, unknown>;
	duration?: number;
	error?: {
		name: string;
		message: string;
		stack?: string;
	};
}

export interface LoggerConfig {
	logDir: string;
	logFilePath?: string;
	level: LogLevel;
	maxFileSize: number;
	maxFiles: number;
	consoleOutput: boolean;
	jsonFormat: boolean;
	flushRetryBackoffMs?: number;
}

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};
const DEFAULT_CONFIG: LoggerConfig = {
	logDir: join(homedir(), ".agents", ".daemon", "logs"),
	logFilePath: undefined,
	level: "info",
	maxFileSize: 10 * 1024 * 1024,
	maxFiles: 5,
	consoleOutput: true,
	jsonFormat: true,
	flushRetryBackoffMs: 30_000,
};

export function resolveLoggerConfig(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): Partial<LoggerConfig> {
	const envLogFile = env.SIGNET_LOG_FILE?.trim();
	if (envLogFile) {
		return { logFilePath: envLogFile, logDir: dirname(envLogFile) };
	}

	const envLogDir = env.SIGNET_LOG_DIR?.trim();
	if (envLogDir) {
		return { logDir: envLogDir };
	}

	const signetPath = env.SIGNET_PATH?.trim();
	return {
		logDir: join(signetPath || join(homeDir, ".agents"), ".daemon", "logs"),
	};
}

export class Logger extends EventEmitter {
	private config: LoggerConfig;
	private currentLogFile: string;
	private buffer: LogEntry[] = [];
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private fileOutputEnabled = true;
	private lastFlushFailureAt = 0;
	private static readonly MAX_BUFFERED_ENTRIES = 2000;
	private static readonly LOG_FILE_PATTERN = /^signet-(\d{4}-\d{2}-\d{2})(?:-(.+))?\.log$/;

	constructor(config: Partial<LoggerConfig> = {}) {
		super();
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.currentLogFile = this.getLogFileName();
		this.startFlushTimer();
	}

	private getLogFileName(): string {
		if (this.config.logFilePath) {
			return this.config.logFilePath;
		}
		const date = new Date().toISOString().split("T")[0];
		return join(this.config.logDir, `signet-${date}.log`);
	}
	get logFilePath(): string {
		return this.currentLogFile;
	}

	private shouldLog(level: LogLevel): boolean {
		return LOG_LEVELS[level] >= LOG_LEVELS[this.config.level];
	}

	private parseLogFileName(fileName: string): { date: string; archiveSuffix: string | null } | null {
		const match = Logger.LOG_FILE_PATTERN.exec(fileName);
		if (!match) return null;
		return {
			date: match[1],
			archiveSuffix: match[2] ?? null,
		};
	}

	private compareLogFilesNewestFirst(aName: string, bName: string): number {
		const aMeta = this.parseLogFileName(aName);
		const bMeta = this.parseLogFileName(bName);

		if (!aMeta && !bMeta) return bName.localeCompare(aName);
		if (!aMeta) return 1;
		if (!bMeta) return -1;

		const byDate = bMeta.date.localeCompare(aMeta.date);
		if (byDate !== 0) return byDate;

		const aIsArchive = aMeta.archiveSuffix !== null;
		const bIsArchive = bMeta.archiveSuffix !== null;
		if (aIsArchive !== bIsArchive) return aIsArchive ? 1 : -1;

		if (!aIsArchive) return bName.localeCompare(aName);

		return (bMeta.archiveSuffix ?? "").localeCompare(aMeta.archiveSuffix ?? "");
	}

	private listLogFilesNewestFirst(): Array<{ name: string; path: string }> {
		if (!this.fileOutputEnabled) {
			return [];
		}
		if (this.config.logFilePath) {
			if (!existsSync(this.config.logFilePath)) return [];
			return [
				{
					name: basename(this.config.logFilePath),
					path: this.config.logFilePath,
				},
			];
		}
		if (!existsSync(this.config.logDir)) return [];
		return readdirSync(this.config.logDir)
			.filter((f) => this.parseLogFileName(f) !== null)
			.map((f) => ({
				name: f,
				path: join(this.config.logDir, f),
			}))
			.sort((a, b) => this.compareLogFilesNewestFirst(a.name, b.name));
	}

	private formatConsole(entry: LogEntry): string {
		const levelColors: Record<LogLevel, string> = {
			debug: "\x1b[90m",
			info: "\x1b[36m",
			warn: "\x1b[33m",
			error: "\x1b[31m",
		};
		const reset = "\x1b[0m";
		const dim = "\x1b[2m";

		const parts = entry.timestamp.split("T");
		const time = (parts[1] ?? "").slice(0, 8) || "00:00:00";
		const level = entry.level.toUpperCase().padEnd(5);
		const category = `[${entry.category}]`.padEnd(12);

		let line = `${dim}${time}${reset} ${levelColors[entry.level]}${level}${reset} ${category} ${entry.message}`;

		if (entry.duration !== undefined) {
			line += ` ${dim}(${entry.duration}ms)${reset}`;
		}

		if (entry.data && Object.keys(entry.data).length > 0) {
			line += ` ${dim}${JSON.stringify(entry.data)}${reset}`;
		}

		if (entry.error) {
			line += `\n  ${levelColors.error}${entry.error.name}: ${entry.error.message}${reset}`;
		}

		return line;
	}

	private formatJson(entry: LogEntry): string {
		return JSON.stringify(entry);
	}

	private write(entry: LogEntry) {
		if (this.config.consoleOutput) {
			const message = this.formatConsole(entry);
			if (process.env.SIGNET_DB_OWNER_WORKER === "1") console.error(message);
			else console.log(message);
		}
		this.buffer.push(entry);
		this.emit("log", entry);
		this.checkRotation();
	}

	private flush(force = false) {
		if (this.buffer.length === 0) return;

		if (!this.fileOutputEnabled && !force) {
			const backoffMs = this.config.flushRetryBackoffMs ?? 30_000;
			if (Date.now() - this.lastFlushFailureAt < backoffMs) {
				this.trimBuffer();
				return;
			}
			console.error(`[logger] retrying file logging to ${this.currentLogFile}`);
		}

		this.appendBuffered();
	}

	private trimBuffer() {
		if (this.buffer.length > Logger.MAX_BUFFERED_ENTRIES) {
			this.buffer = this.buffer.slice(-Logger.MAX_BUFFERED_ENTRIES);
		}
	}

	private appendBuffered() {
		const lines = `${this.buffer
			.map((entry) => (this.config.jsonFormat ? this.formatJson(entry) : this.formatConsole(entry)))
			.join("\n")}\n`;

		try {
			const newLogFile = this.getLogFileName();
			if (newLogFile !== this.currentLogFile) {
				this.currentLogFile = newLogFile;
			}

			appendFileSync(this.currentLogFile, lines);
			this.buffer = [];
			if (!this.fileOutputEnabled) {
				this.fileOutputEnabled = true;
				console.error(`[logger] file logging recovered: ${this.currentLogFile}`);
			}
		} catch (e) {
			this.fileOutputEnabled = false;
			this.lastFlushFailureAt = Date.now();
			this.trimBuffer();
			console.error(`Failed to write logs to ${this.currentLogFile}, disabling file logging (retrying):`, e);
		}
	}

	private startFlushTimer() {
		this.flushTimer = setInterval(() => this.flush(), 1000);
	}

	private checkRotation() {
		if (!this.fileOutputEnabled) return;
		if (this.config.logFilePath) return;
		try {
			if (!existsSync(this.currentLogFile)) return;

			const stats = statSync(this.currentLogFile);
			if (stats.size > this.config.maxFileSize) {
				this.rotate();
			}
		} catch {}
	}

	private rotate() {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const rotatedName = this.currentLogFile.replace(".log", `-${timestamp}.log`);

		try {
			renameSync(this.currentLogFile, rotatedName);
			this.cleanOldLogs();
		} catch {}
	}

	private cleanOldLogs() {
		if (!this.fileOutputEnabled) return;
		try {
			const files = this.listLogFilesNewestFirst();
			for (let i = this.config.maxFiles; i < files.length; i++) {
				unlinkSync(files[i].path);
			}
		} catch {}
	}
	log(level: LogLevel, category: LogCategory, message: string, data?: Record<string, unknown>) {
		if (!this.shouldLog(level)) return;

		const entry: LogEntry = {
			timestamp: new Date().toISOString(),
			level,
			category,
			message,
			...(data && { data }),
		};

		this.write(entry);
	}

	debug(category: LogCategory, message: string, data?: Record<string, unknown>) {
		this.log("debug", category, message, data);
	}

	info(category: LogCategory, message: string, data?: Record<string, unknown>) {
		this.log("info", category, message, data);
	}

	warn(category: LogCategory, message: string, errorOrData?: Error | Record<string, unknown>) {
		if (errorOrData instanceof Error) {
			const entry: LogEntry = {
				timestamp: new Date().toISOString(),
				level: "warn",
				category,
				message,
				error: {
					name: errorOrData.name,
					message: errorOrData.message,
					stack: errorOrData.stack,
				},
			};
			this.write(entry);
		} else {
			this.log("warn", category, message, errorOrData);
		}
	}

	error(category: LogCategory, message: string, error?: Error, data?: Record<string, unknown>) {
		const entry: LogEntry = {
			timestamp: new Date().toISOString(),
			level: "error",
			category,
			message,
			...(data && { data }),
			...(error && {
				error: {
					name: error.name,
					message: error.message,
					stack: error.stack,
				},
			}),
		};

		this.write(entry);
	}
	time(category: LogCategory, operation: string): (data?: Record<string, unknown>) => void {
		const start = Date.now();
		return (data?: Record<string, unknown>) => {
			const duration = Date.now() - start;
			this.log("info", category, `${operation} completed`, {
				...data,
				duration,
			});
		};
	}
	memory = {
		save: (content: string, type: string, who: string) => {
			this.info("memory", "Memory saved", {
				contentLength: content.length,
				type,
				who,
			});
		},
		recall: (query: string, resultCount: number, duration: number) => {
			this.info("memory", "Memory recalled", {
				query,
				resultCount,
				duration,
			});
		},
		embed: (contentLength: number, model: string, duration: number) => {
			this.debug("embedding", "Content embedded", {
				contentLength,
				model,
				duration,
			});
		},
	};

	sync = {
		harness: (harness: string, target: string) => {
			this.info("sync", `Synced to ${harness}`, { target });
		},
		failed: (harness: string, error: Error) => {
			this.error("sync", `Failed to sync to ${harness}`, error);
		},
	};

	git = {
		commit: (message: string, filesChanged: number) => {
			this.info("git", "Auto-committed", { message, filesChanged });
		},
		failed: (error: Error) => {
			this.warn("git", "Auto-commit failed", error);
		},
		sync: (operation: "pull" | "push", commits: number) => {
			this.info("git", `Git ${operation}`, { commits });
		},
	};

	api = {
		request: (method: string, path: string, status: number, duration: number) => {
			this.debug("api", `${method} ${path}`, { status, duration });
		},
	};
	getRecent(options: { limit?: number; level?: LogLevel; category?: LogCategory; since?: Date } = {}): LogEntry[] {
		const { limit = 100, level, category, since } = options;
		const results: LogEntry[] = [];

		try {
			const logFiles = this.listLogFilesNewestFirst();
			for (const file of logFiles) {
				if (results.length >= limit * 2) break;

				try {
					const content = readFileSync(file.path, "utf-8");
					const lines = content.trim().split("\n").filter(Boolean);
					const recentLines = lines.slice(-(limit * 2));

					for (const line of recentLines) {
						try {
							const entry = JSON.parse(line) as LogEntry;
							if (level && LOG_LEVELS[entry.level] < LOG_LEVELS[level]) continue;
							if (category && entry.category !== category) continue;
							if (since && new Date(entry.timestamp) < since) continue;

							results.push(entry);
						} catch {}
					}
				} catch {}
			}
			results.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
		} catch {}

		return results.slice(-limit);
	}
	shutdown(flush = true) {
		if (flush) this.flush(true);
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
		}
	}
}
export const logger = new Logger(resolveLoggerConfig());

export default logger;
