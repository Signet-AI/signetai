/**
 * Communications Watcher — scans git repos for new commits.
 *
 * Periodically runs `git log` in watched repositories to track
 * commits, branches, and collaboration activity.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { homedir } from "os";
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { CaptureAdapter, CommCapture, CommsConfig } from "../types";

const execFileAsync = promisify(execFile);

/** Resolve ~ and * glob patterns to real directories. */
function resolveGitRepos(patterns: string[]): string[] {
	const repos: string[] = [];
	const home = homedir();

	for (const pattern of patterns) {
		const expanded = pattern.replace(/^~/, home);

		if (expanded.endsWith("/*")) {
			// Glob: list subdirectories that are git repos
			const parent = expanded.slice(0, -2);
			if (!existsSync(parent)) continue;

			try {
				const entries = readdirSync(parent, { withFileTypes: true });
				for (const entry of entries) {
					if (!entry.isDirectory()) continue;
					const candidate = join(parent, entry.name);
					if (existsSync(join(candidate, ".git"))) {
						repos.push(candidate);
					}
				}
			} catch {
				// Skip unreadable directories
			}
		} else if (existsSync(join(expanded, ".git"))) {
			repos.push(expanded);
		}
	}

	return repos;
}

export class CommsWatcherAdapter implements CaptureAdapter {
	readonly name = "comms";
	private config: CommsConfig;
	private captures: CommCapture[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;
	private lastSeenCommits: Map<string, string> = new Map(); // repo → latest hash

	constructor(config: CommsConfig) {
		this.config = config;
	}

	async start(): Promise<void> {
		// Initial scan to establish baseline
		await this.scan();

		// Scan every 5 minutes
		this.timer = setInterval(() => {
			this.scan().catch((err) => {
				console.warn("[perception:comms] Scan error:", err.message);
			});
		}, 5 * 60 * 1000);
	}

	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	async getCaptures(since: string): Promise<CommCapture[]> {
		return this.captures.filter((c) => c.timestamp >= since);
	}

	private async scan(): Promise<void> {
		const repos = resolveGitRepos(this.config.gitRepos);

		for (const repo of repos) {
			try {
				await this.scanRepo(repo);
			} catch {
				// Skip repos that fail
			}
		}
	}

	private async scanRepo(repoPath: string): Promise<void> {
		try {
			const { stdout } = await execFileAsync(
				"git",
				[
					"log",
					'--since="20 minutes ago"',
					"--format=%H|%s|%an|%ai",
				],
				{ cwd: repoPath, timeout: 10_000 },
			);

			if (!stdout.trim()) return;

			const lines = stdout.trim().split("\n");
			const lastSeen = this.lastSeenCommits.get(repoPath);
			let foundLastSeen = false;

			// Get repo name from path
			const repoName = repoPath.split("/").pop() || repoPath;

			// Get current branch
			let branch = "unknown";
			try {
				const branchResult = await execFileAsync(
					"git",
					["rev-parse", "--abbrev-ref", "HEAD"],
					{ cwd: repoPath, timeout: 5000 },
				);
				branch = branchResult.stdout.trim();
			} catch {
				// Use default
			}

			for (const line of lines) {
				const parts = line.split("|");
				if (parts.length < 4) continue;

				const [hash, subject, author, dateStr] = parts;

				// Skip commits we've already seen
				if (hash === lastSeen) {
					foundLastSeen = true;
					break;
				}

				const capture: CommCapture = {
					id: `comm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
					timestamp: new Date(dateStr).toISOString(),
					source: "git_commit",
					content: subject,
					metadata: {
						repo: repoName,
						repoPath,
						branch,
						commitHash: hash,
						author,
					},
				};

				this.captures.push(capture);
			}

			// Update last seen to newest commit
			if (lines.length > 0) {
				const newestHash = lines[0].split("|")[0];
				if (newestHash) {
					this.lastSeenCommits.set(repoPath, newestHash);
				}
			}
		} catch {
			// Silently skip git errors
		}
	}
}
