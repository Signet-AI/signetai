/**
 * Signet Structured Logging System
 *
 * Features:
 * - Structured JSON logs
 * - Log levels (debug, info, warn, error)
 * - Log rotation
 * - Activity tracking (memory ops, syncs, git, API)
 * - Real-time streaming for dashboard
 */

import {
	existsSync,
	mkdirSync,
	appendFileSync,
	readdirSync,
	statSync,
	unlinkSync,
	readFileSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { EventEmitter } from "events";

// Types
export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogCategory =
	| "daemon" // Daemon lifecycle
	| "api" // API requests
	| "memory" // Memory operations (save, recall, search)
	| "sync" // Harness sync operations
	| "git" // Git auto-commits
	| "watcher" // File watcher events
	| "embedding" // Embedding operations
	| "harness" // Harness configuration
	| "skills" // Skills management
	| "secrets" // Secrets management
	| "hooks" // Hook handlers
	| "pipeline" // Extraction/decision pipeline
	| "system"; // System events

export interface LogEntry {
	timestamp: string;
	level: LogLevel;
	category: LogCategory;
	message: string;
	data?: Record<string, unknown>;
	duration?: number; // For timed operations (ms)
	error?: {
		name: string;
		message: string;
		stack?: string;
	};
}

export interface LoggerConfig {
	logDir: string;
	level: LogLevel;
	maxFileSize: number; // bytes
	maxFiles: number; // number of rotated files to keep
	consoleOutput: boolean;
	jsonFormat: boolean;
}

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

// Default configuration
const DEFAULT_CONFIG: LoggerConfig = {
	logDir: join(homedir(), ".agents", ".daemon", "logs"),
	level: "info",
	maxFileSize: 10 * 1024 * 1024, // 10MB
	maxFiles: 5,
	consoleOutput: true,
	jsonFormat: true,
};

class Logger extends EventEmitter {
	private config: LoggerConfig;
	private currentLogFile: string;
	private buffer: LogEntry[] = [];
	private flushTimer: ReturnType<typeof setInterval> | null = null;

	constructor(config: Partial<LoggerConfig> = {}) {
		super();
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.currentLogFile = this.getLogFileName();
		this.ensureLogDir();
		this.startFlushTimer();
	}

	private ensureLogDir() {
		if (!existsSync(this.config.logDir)) {
			mkdirSync(this.config.logDir, { recursive: true });
		}
	}

	private getLogFileName(): string {
		const date = new Date().toISOString().split("T")[0];
		return join(this.config.logDir, `signet-${date}.log`);
	}

	private shouldLog(level: LogLevel): boolean {
		return LOG_LEVELS[level] >= LOG_LEVELS[this.config.level];
	}

	private formatConsole(entry: LogEntry): string {
		const levelColors: Record<LogLevel, string> = {
			debug: "\x1b[90m", // gray
			info: "\x1b[36m", // cyan
			warn: "\x1b[33m", // yellow
			error: "\x1b[31m", // red
		};
		const reset = "\x1b[0m";
		const dim = "\x1b[2m";

		const time = entry.timestamp.split("T")[1].slice(0, 8);
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
		// Console output
		if (this.config.consoleOutput) {
			console.log(this.formatConsole(entry));
		}

		// Buffer for file write
		this.buffer.push(entry);

		// Emit for real-time streaming
		this.emit("log", entry);

		// Check if we need to rotate
		this.checkRotation();
	}

	private flush() {
		if (this.buffer.length === 0) return;

		const lines =
			this.buffer
				.map((entry) =>
					this.config.jsonFormat
						? this.formatJson(entry)
						: this.formatConsole(entry),
				)
				.join("\n") + "\n";

		try {
			// Check if date changed (new log file)
			const newLogFile = this.getLogFileName();
			if (newLogFile !== this.currentLogFile) {
				this.currentLogFile = newLogFile;
			}

			appendFileSync(this.currentLogFile, lines);
			this.buffer = [];
		} catch (e) {
			console.error("Failed to write logs:", e);
		}
	}

	private startFlushTimer() {
		// Flush every second
		this.flushTimer = setInterval(() => this.flush(), 1000);
	}

	private checkRotation() {
		try {
			if (!existsSync(this.currentLogFile)) return;

			const stats = statSync(this.currentLogFile);
			if (stats.size > this.config.maxFileSize) {
				this.rotate();
			}
		} catch {
			// Ignore rotation check errors
		}
	}

	private rotate() {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const rotatedName = this.currentLogFile.replace(
			".log",
			`-${timestamp}.log`,
		);

		try {
			// Rename current to rotated
			const { renameSync } = require("fs");
			renameSync(this.currentLogFile, rotatedName);

			// Clean up old files
			this.cleanOldLogs();
		} catch {
			// Ignore rotation errors
		}
	}

	private cleanOldLogs() {
		try {
			const files = readdirSync(this.config.logDir)
				.filter((f) => f.startsWith("signet-") && f.endsWith(".log"))
				.map((f) => ({
					name: f,
					path: join(this.config.logDir, f),
					mtime: statSync(join(this.config.logDir, f)).mtime.getTime(),
				}))
				.sort((a, b) => b.mtime - a.mtime);

			// Keep only maxFiles
			for (let i = this.config.maxFiles; i < files.length; i++) {
				unlinkSync(files[i].path);
			}
		} catch {
			// Ignore cleanup errors
		}
	}

	// Public logging methods
	log(
		level: LogLevel,
		category: LogCategory,
		message: string,
		data?: Record<string, unknown>,
	) {
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

	debug(
		category: LogCategory,
		message: string,
		data?: Record<string, unknown>,
	) {
		this.log("debug", category, message, data);
	}

	info(category: LogCategory, message: string, data?: Record<string, unknown>) {
		this.log("info", category, message, data);
	}

	warn(
		category: LogCategory,
		message: string,
		errorOrData?: Error | Record<string, unknown>,
	) {
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

	error(
		category: LogCategory,
		message: string,
		error?: Error,
		data?: Record<string, unknown>,
	) {
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

	// Timed operation logging
	time(category: LogCategory, operation: string): () => void {
		const start = Date.now();
		return (data?: Record<string, unknown>) => {
			const duration = Date.now() - start;
			this.log("info", category, `${operation} completed`, {
				...data,
				duration,
			});
		};
	}

	// Activity logging helpers
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
		request: (
			method: string,
			path: string,
			status: number,
			duration: number,
		) => {
			this.debug("api", `${method} ${path}`, { status, duration });
		},
	};

	// Get recent logs
	getRecent(
		options: {
			limit?: number;
			level?: LogLevel;
			category?: LogCategory;
			since?: Date;
		} = {},
	): LogEntry[] {
		const { limit = 100, level, category, since } = options;
		const results: LogEntry[] = [];

		try {
			// Read from current log file
			if (existsSync(this.currentLogFile)) {
				const content = readFileSync(this.currentLogFile, "utf-8");
				const lines = content.trim().split("\n").filter(Boolean);

				for (const line of lines.slice(-limit * 2)) {
					// Read extra for filtering
					try {
						const entry = JSON.parse(line) as LogEntry;

						// Apply filters
						if (level && LOG_LEVELS[entry.level] < LOG_LEVELS[level]) continue;
						if (category && entry.category !== category) continue;
						if (since && new Date(entry.timestamp) < since) continue;

						results.push(entry);
					} catch {
						// Skip non-JSON lines
					}
				}
			}
		} catch {
			// Return empty on read error
		}

		return results.slice(-limit);
	}

	// Cleanup
	shutdown() {
		this.flush();
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
		}
	}
}

// Singleton instance
export const logger = new Logger();

export default logger;
