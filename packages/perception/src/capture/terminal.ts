/**
 * Terminal Watcher — tails shell history files for command capture.
 *
 * Supports zsh extended history format (`: timestamp:duration;command`)
 * and plain history (bash). Redacts sensitive commands.
 */

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "fs";
import { homedir } from "os";
import type { CaptureAdapter, TerminalCapture, TerminalConfig } from "../types";

/** Maximum number of terminal captures to retain in memory (C-2). */
const MAX_CAPTURES = 10_000;

/** Sensitive patterns — commands matching these are redacted. */
const SENSITIVE_PATTERNS = [
	/password/i,
	/secret/i,
	/token/i,
	/api[_-]?key/i,
	/ssh[_-]?key/i,
	/private[_-]?key/i,
	/passphrase/i,
	/\bexport\s+\w*(SECRET|TOKEN|KEY|PASSWORD|PASS)\w*=/i,
];

/** Parse zsh extended history format: `: timestamp:duration;command` */
function parseZshLine(line: string): {
	timestamp?: number;
	duration?: number;
	command: string;
} {
	const match = line.match(/^:\s*(\d+):(\d+);(.+)$/);
	if (match) {
		return {
			timestamp: parseInt(match[1], 10),
			duration: parseInt(match[2], 10),
			command: match[3],
		};
	}
	// Fallback: plain history line
	return { command: line.trim() };
}

export class TerminalWatcherAdapter implements CaptureAdapter {
	readonly name = "terminal";
	private config: TerminalConfig;
	private captures: TerminalCapture[] = [];
	private watchedFiles: string[] = [];
	private lastLineCount: Map<string, number> = new Map();
	private lastFileSize: Map<string, number> = new Map(); // H-10: track file byte offset
	private pollTimer: ReturnType<typeof setInterval> | null = null;

	constructor(config: TerminalConfig) {
		this.config = config;
	}

	async start(): Promise<void> {
		const home = homedir();
		const historyPaths = [
			{ path: `${home}/.zsh_history`, shell: "zsh" as const },
			{ path: `${home}/.bash_history`, shell: "bash" as const },
		];

		for (const { path, shell } of historyPaths) {
			if (existsSync(path)) {
				// H-10: Track initial file size so we only read new bytes
				try {
					const st = statSync(path);
					this.lastFileSize.set(path, st.size);
				} catch {
					this.lastFileSize.set(path, 0);
				}
				// Also track line count for initial baseline
				const lines = this.readHistoryLines(path);
				this.lastLineCount.set(path, lines.length);
				this.watchedFiles.push(path);
			}
		}

		if (this.watchedFiles.length === 0) {
			console.warn(
				"[perception:terminal] No shell history files found.",
			);
			return;
		}

		// Poll every 5 seconds for new history entries (low overhead)
		this.pollTimer = setInterval(() => {
			this.checkForNewCommands();
		}, 5000);
	}

	async stop(): Promise<void> {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	async getCaptures(since: string): Promise<TerminalCapture[]> {
		return this.captures.filter((c) => c.timestamp >= since);
	}

	/** C-5: Return count without copying the array. */
	getCount(): number {
		return this.captures.length;
	}

	/** C-2: Trim captures older than cutoff. Returns number trimmed. */
	trimCaptures(cutoff: string): number {
		const before = this.captures.length;
		this.captures = this.captures.filter((c) => c.timestamp >= cutoff);
		return before - this.captures.length;
	}

	private checkForNewCommands(): void {
		for (const filePath of this.watchedFiles) {
			try {
				// H-10: Only read new bytes since last check
				const newLines = this.readNewLines(filePath);
				if (newLines.length === 0) continue;

				const shell = filePath.includes("zsh") ? "zsh" : "bash";

				for (const line of newLines) {
					if (!line.trim()) continue;

					const parsed =
						shell === "zsh"
							? parseZshLine(line)
							: { command: line.trim() };

					if (!parsed.command || parsed.command.length < 2) continue;

					// H-12 FIX: Check exclusion FIRST, then drop sensitive entirely
					if (this.isExcluded(parsed.command)) continue;
					if (this.isSensitive(parsed.command)) continue; // drop entirely, don't store redacted

					const timestamp = parsed.timestamp
						? new Date(parsed.timestamp * 1000).toISOString()
						: new Date().toISOString();

					const capture: TerminalCapture = {
						id: `term_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
						timestamp,
						command: parsed.command,
						workingDirectory: "", // Not available from history alone
						shell,
					};

					this.captures.push(capture);
					// C-2: FIFO trimming
					if (this.captures.length > MAX_CAPTURES) {
						this.captures.splice(0, this.captures.length - MAX_CAPTURES);
					}
				}
			} catch {
				// Silently skip read errors
			}
		}
	}

	/**
	 * H-10: Read only new bytes from the history file (incremental).
	 * H-4: Join backslash-continued lines before splitting.
	 */
	private readNewLines(filePath: string): string[] {
		try {
			const st = statSync(filePath);
			const lastSize = this.lastFileSize.get(filePath) ?? st.size;

			if (st.size <= lastSize) {
				if (st.size < lastSize) {
					// File was truncated (e.g., history rewrite) — reset
					this.lastFileSize.set(filePath, st.size);
				}
				return [];
			}

			const bytesToRead = st.size - lastSize;
			const fd = openSync(filePath, "r");
			try {
				const buf = Buffer.alloc(bytesToRead);
				readSync(fd, buf, 0, bytesToRead, lastSize);
				this.lastFileSize.set(filePath, st.size);

				let content = buf.toString("utf-8");
				// H-4: Join backslash-continued lines (zsh multiline commands)
				content = content.replace(/\\\n/g, " ");
				return content.split("\n").filter((l) => l.length > 0);
			} finally {
				closeSync(fd);
			}
		} catch {
			return [];
		}
	}

	/** Full read for initial baseline only. */
	private readHistoryLines(filePath: string): string[] {
		try {
			const content = readFileSync(filePath, "utf-8");
			// H-4: Join backslash-continued lines
			const joined = content.replace(/\\\n/g, " ");
			return joined.split("\n").filter((l) => l.length > 0);
		} catch {
			return [];
		}
	}

	private isSensitive(command: string): boolean {
		return SENSITIVE_PATTERNS.some((pattern) => pattern.test(command));
	}

	private isExcluded(command: string): boolean {
		const cmdLower = command.toLowerCase();
		return this.config.excludeCommands.some((pattern) => {
			const p = pattern.replace(/\*/g, "").toLowerCase();
			if (p.length === 0) return false; // Skip empty patterns
			return cmdLower.includes(p);
		});
	}
}
