/**
 * Terminal Watcher — tails shell history files for command capture.
 *
 * Supports zsh extended history format (`: timestamp:duration;command`)
 * and plain history (bash). Redacts sensitive commands.
 */

import { readFileSync, existsSync, statSync, watchFile, unwatchFile } from "fs";
import { homedir } from "os";
import type { CaptureAdapter, TerminalCapture, TerminalConfig } from "../types";

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
	private polling = false;
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
				// Read initial line count so we only capture new commands
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
		this.polling = true;
		this.pollTimer = setInterval(() => {
			this.checkForNewCommands();
		}, 5000);
	}

	async stop(): Promise<void> {
		this.polling = false;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	async getCaptures(since: string): Promise<TerminalCapture[]> {
		return this.captures.filter((c) => c.timestamp >= since);
	}

	private checkForNewCommands(): void {
		for (const filePath of this.watchedFiles) {
			try {
				const lines = this.readHistoryLines(filePath);
				const lastCount = this.lastLineCount.get(filePath) ?? 0;

				if (lines.length <= lastCount) continue;

				const newLines = lines.slice(lastCount);
				this.lastLineCount.set(filePath, lines.length);

				const shell = filePath.includes("zsh") ? "zsh" : "bash";

				for (const line of newLines) {
					if (!line.trim()) continue;

					const parsed =
						shell === "zsh"
							? parseZshLine(line)
							: { command: line.trim() };

					if (!parsed.command || parsed.command.length < 2) continue;

					// Redact sensitive commands
					if (this.isSensitive(parsed.command)) {
						parsed.command = "[REDACTED — sensitive command]";
					}

					// Check exclusion patterns from config
					if (this.isExcluded(parsed.command)) continue;

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
				}
			} catch {
				// Silently skip read errors
			}
		}
	}

	private readHistoryLines(filePath: string): string[] {
		try {
			const content = readFileSync(filePath, "utf-8");
			return content.split("\n").filter((l) => l.length > 0);
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
			return cmdLower.includes(p);
		});
	}
}
