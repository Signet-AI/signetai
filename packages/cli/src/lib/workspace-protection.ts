import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { OpenClawConnector } from "@signet/connector-openclaw";

export interface GitRemoteState {
	readonly isRepo: boolean;
	readonly origin: string | null;
}

export interface SnapshotResult {
	readonly path: string;
	readonly root: string;
}

function readOutput(value: string | Buffer | null): string {
	if (typeof value === "string") {
		return value.trim();
	}
	if (value instanceof Buffer) {
		return value.toString("utf-8").trim();
	}
	return "";
}

function sanitize(name: string): string {
	const trimmed = name.trim().toLowerCase();
	if (trimmed.length === 0) {
		return "workspace";
	}
	return trimmed.replace(/[^a-z0-9._-]+/g, "-");
}

export function getGitRemoteState(dir: string): GitRemoteState {
	const path = resolve(dir);
	const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd: path,
		encoding: "utf-8",
		windowsHide: true,
	});
	const isRepo = probe.status === 0;
	if (!isRepo) {
		return { isRepo: false, origin: null };
	}

	const remote = spawnSync("git", ["remote", "get-url", "origin"], {
		cwd: path,
		encoding: "utf-8",
		windowsHide: true,
	});
	if (remote.status !== 0) {
		return { isRepo: true, origin: null };
	}
	const origin = readOutput(remote.stdout);
	if (origin.length === 0) {
		return { isRepo: true, origin: null };
	}
	return { isRepo: true, origin };
}

export function hasOpenClawWorkspaceLink(basePath: string): boolean {
	const target = resolve(basePath);
	const connector = new OpenClawConnector();
	const workspaces = connector.getDiscoveredWorkspacePaths();
	return workspaces.some((path) => resolve(path) === target);
}

export function defaultBackupRoot(): string {
	return join(homedir(), ".signet", "backups");
}

export function createWorkspaceSnapshot(basePath: string, backupRoot = defaultBackupRoot()): SnapshotResult {
	const root = resolve(backupRoot);
	const source = resolve(basePath);
	mkdirSync(root, { recursive: true });

	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
	const dir = sanitize(basename(source));
	const target = join(root, `${dir}-${stamp}`);

	cpSync(source, target, {
		recursive: true,
		errorOnExist: true,
		force: false,
	});

	if (!existsSync(target)) {
		throw new Error(`Snapshot copy failed: ${target}`);
	}

	return { path: target, root };
}

export function setOriginRemote(dir: string, url: string): void {
	const path = resolve(dir);
	const state = getGitRemoteState(path);
	if (!state.isRepo) {
		throw new Error(`Not a git repository: ${path}`);
	}
	if (state.origin) {
		const set = spawnSync("git", ["remote", "set-url", "origin", url], {
			cwd: path,
			encoding: "utf-8",
			windowsHide: true,
		});
		if (set.status === 0) {
			return;
		}
		throw new Error(readOutput(set.stderr) || "Failed to update origin remote");
	}

	const add = spawnSync("git", ["remote", "add", "origin", url], {
		cwd: path,
		encoding: "utf-8",
		windowsHide: true,
	});
	if (add.status === 0) {
		return;
	}
	throw new Error(readOutput(add.stderr) || "Failed to add origin remote");
}
