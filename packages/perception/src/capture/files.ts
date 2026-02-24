/**
 * File Activity Watcher — monitors file system changes using chokidar.
 *
 * Watches configurable directories for create/modify/delete events,
 * detects git repos & branches, and filters out noisy paths.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { extname, dirname, basename } from "path";
import { homedir } from "os";
import { existsSync, statSync } from "fs";
import type { CaptureAdapter, FileActivity, FilesConfig } from "../types";

const execFileAsync = promisify(execFile);

/** Maximum number of file captures to retain in memory (C-2). */
const MAX_CAPTURES = 10_000;

/** Pattern fragments that should always be excluded. */
const DEFAULT_EXCLUDES = [
	"node_modules",
	".git/objects",
	".git/refs",
	".git/logs",
	"dist",
	"*.lock",
	"__pycache__",
	".DS_Store",
	"*.swp",
	"*.swo",
	"*~",
];

/** Resolve ~ to homedir in paths. */
function expandHome(p: string): string {
	if (p.startsWith("~/")) return p.replace("~", homedir());
	return p;
}

export class FileWatcherAdapter implements CaptureAdapter {
	readonly name = "files";
	private config: FilesConfig;
	private watcher: any = null; // chokidar FSWatcher
	private captures: FileActivity[] = [];
	private excludePatterns: string[];

	constructor(config: FilesConfig) {
		this.config = config;
		this.excludePatterns = [
			...DEFAULT_EXCLUDES,
			...config.excludePatterns,
		];
	}

	async start(): Promise<void> {
		let chokidar: any;
		try {
			chokidar = await import("chokidar");
		} catch {
			console.warn(
				"[perception:files] chokidar not available — file watching disabled.",
			);
			return;
		}

		const dirs = this.config.watchDirs.map(expandHome).filter(existsSync);

		if (dirs.length === 0) {
			console.warn(
				"[perception:files] No valid watch directories found.",
			);
			return;
		}

		this.watcher = chokidar.watch(dirs, {
			ignored: (path: string) => this.shouldIgnore(path),
			persistent: true,
			ignoreInitial: true,
			awaitWriteFinish: {
				stabilityThreshold: 500,
				pollInterval: 100,
			},
			// Reduce CPU: use fs.watch where possible, with polling fallback
			usePolling: false,
		});

		this.watcher.on("add", (path: string) => this.onEvent("create", path));
		this.watcher.on("change", (path: string) => this.onEvent("modify", path));
		this.watcher.on("unlink", (path: string) => this.onEvent("delete", path));
	}

	async stop(): Promise<void> {
		if (this.watcher) {
			await this.watcher.close();
			this.watcher = null;
		}
	}

	async getCaptures(since: string): Promise<FileActivity[]> {
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

	/**
	 * H-1 FIX: Proper glob-like matching for exclude patterns.
	 * Handles patterns like "*.lock", "node_modules", ".git/objects".
	 */
	private shouldIgnore(filePath: string): boolean {
		const lower = filePath.toLowerCase();
		const fileName = basename(filePath).toLowerCase();
		for (const pattern of this.excludePatterns) {
			const p = pattern.toLowerCase();
			if (p.startsWith("*") && p.length > 1) {
				// Glob suffix pattern like "*.lock" — match against file name
				const suffix = p.slice(1); // e.g. ".lock"
				if (fileName.endsWith(suffix)) return true;
			} else if (p.endsWith("*") && p.length > 1) {
				// Glob prefix pattern — match against path segments
				const prefix = p.slice(0, -1);
				if (lower.includes(prefix)) return true;
			} else if (p.includes("/")) {
				// Path segment pattern like ".git/objects" — match path contains
				if (lower.includes(p)) return true;
			} else {
				// Simple name — match as a path segment (not arbitrary substring)
				// e.g. "dist" should match "/dist/" but not "distribution/"
				const segments = lower.split("/");
				if (segments.includes(p)) return true;
			}
		}
		return false;
	}

	private async onEvent(
		eventType: "create" | "modify" | "delete",
		filePath: string,
	): Promise<void> {
		try {
			let sizeBytes: number | undefined;
			if (eventType !== "delete") {
				try {
					const st = statSync(filePath);
					sizeBytes = st.size;
				} catch {
					// File may have been deleted between event and stat
				}
			}

			const ext = extname(filePath).replace(".", "");
			const gitInfo = await this.getGitInfo(filePath);

			const activity: FileActivity = {
				id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
				timestamp: new Date().toISOString(),
				eventType,
				filePath,
				fileType: ext || "unknown",
				isGitRepo: gitInfo.isGitRepo,
				gitBranch: gitInfo.branch,
				sizeBytes,
			};

			this.captures.push(activity);
			// C-2: FIFO trimming
			if (this.captures.length > MAX_CAPTURES) {
				this.captures.splice(0, this.captures.length - MAX_CAPTURES);
			}
		} catch {
			// Silently skip problematic events
		}
	}

	private async getGitInfo(
		filePath: string,
	): Promise<{ isGitRepo: boolean; branch?: string }> {
		try {
			const dir = dirname(filePath);
			const { stdout } = await execFileAsync(
				"git",
				["rev-parse", "--abbrev-ref", "HEAD"],
				{ cwd: dir, timeout: 5000 },
			);
			return { isGitRepo: true, branch: stdout.trim() };
		} catch {
			return { isGitRepo: false };
		}
	}
}
