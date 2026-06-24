import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSimpleYaml, resolveDefaultBasePath } from "@signet/core";

export interface GitConfig {
	enabled: boolean;
	autoCommit: boolean;
	autoSync: boolean;
	syncInterval: number;
	remote: string;
	branch: string;
}

export const MIN_GIT_SYNC_INTERVAL_SECONDS = 60;
export const MAX_GIT_SYNC_INTERVAL_SECONDS = 24 * 60 * 60;

export function clampGitSyncIntervalSeconds(value: unknown): number | null {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
	if (!Number.isFinite(parsed)) return null;
	return Math.min(MAX_GIT_SYNC_INTERVAL_SECONDS, Math.max(MIN_GIT_SYNC_INTERVAL_SECONDS, Math.trunc(parsed)));
}

function resolveAgentsDirForModuleInit(): string {
	return resolveDefaultBasePath();
}

function detectGitBranch(remote: string, dir = resolveAgentsDirForModuleInit()): string {
	try {
		const ref = execFileSync("git", ["symbolic-ref", `refs/remotes/${remote}/HEAD`], {
			cwd: dir,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 3000,
			windowsHide: true,
		}).trim();
		const prefix = `refs/remotes/${remote}/`;
		if (ref.startsWith(prefix)) {
			return ref.slice(prefix.length);
		}
	} catch {
		// fall through
	}

	try {
		const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: dir,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 3000,
			windowsHide: true,
		}).trim();
		if (branch && branch !== "HEAD") {
			return branch;
		}
	} catch {
		// fall through
	}

	return "main";
}

export function loadGitConfig(agentsDir = resolveAgentsDirForModuleInit()): GitConfig {
	const defaults: GitConfig = {
		enabled: true,
		autoCommit: false,
		autoSync: false,
		syncInterval: 300,
		remote: "origin",
		branch: "",
	};

	const paths = [join(agentsDir, "agent.yaml"), join(agentsDir, "AGENT.yaml")];

	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			const yaml = parseSimpleYaml(readFileSync(p, "utf-8"));
			const git = yaml.git as Record<string, string | boolean> | undefined;
			if (git) {
				if (git.enabled !== undefined) defaults.enabled = git.enabled === "true" || git.enabled === true;
				if (git.autoCommit !== undefined) defaults.autoCommit = git.autoCommit === "true" || git.autoCommit === true;
				if (git.autoSync !== undefined) defaults.autoSync = git.autoSync === "true" || git.autoSync === true;
				if (git.syncInterval !== undefined) {
					defaults.syncInterval = clampGitSyncIntervalSeconds(git.syncInterval) ?? defaults.syncInterval;
				}
				if (git.remote) defaults.remote = git.remote as string;
				if (git.branch) defaults.branch = git.branch as string;
			}
			break;
		} catch {
			// ignore parse errors
		}
	}

	if (!defaults.branch) {
		defaults.branch = detectGitBranch(defaults.remote, agentsDir);
	}

	return defaults;
}

export const gitConfig: GitConfig = loadGitConfig();
