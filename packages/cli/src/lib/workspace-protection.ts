import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { OpenClawConnector } from "@signet/connector-openclaw";
import Database from "../sqlite.js";

export interface GitRemoteState {
	readonly isRepo: boolean;
	readonly origin: string | null;
}

export interface SnapshotResult {
	readonly path: string;
	readonly root: string;
}

interface SnapshotState {
	readonly source: string;
	readonly snapshot: string;
	readonly createdAt: string;
}

const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

function isWithin(root: string, path: string): boolean {
	const outer = resolve(root);
	const inner = resolve(path);
	if (outer === inner) {
		return true;
	}
	return inner.startsWith(`${outer}${sep}`);
}

function hasSnapshotContents(source: string, snapshot: string): boolean {
	const root = resolve(snapshot);
	const required = [
		"AGENTS.md",
		"agent.yaml",
		"SOUL.md",
		"IDENTITY.md",
		"USER.md",
		"MEMORY.md",
		join("memory", "memories.db"),
	];
	for (const file of required) {
		if (!existsSync(join(root, file))) {
			return false;
		}
	}

	const sourceGit = existsSync(join(resolve(source), ".git"));
	if (sourceGit && !existsSync(join(root, ".git"))) {
		return false;
	}

	return true;
}

function isFresh(createdAt: string): boolean {
	const stamp = Date.parse(createdAt);
	if (!Number.isFinite(stamp)) {
		return false;
	}
	const age = Date.now() - stamp;
	if (age < 0) {
		return true;
	}
	return age <= SNAPSHOT_MAX_AGE_MS;
}

function escapeSqlPath(value: string): string {
	return value.replace(/'/g, "''");
}

function backupSqlite(sourceDb: string, targetDb: string): void {
	const escaped = escapeSqlPath(resolve(targetDb));
	const db = Database(resolve(sourceDb));
	try {
		db.exec(`VACUUM INTO '${escaped}'`);
	} finally {
		db.close();
	}
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

export function defaultBackupRoot(basePath?: string): string {
	const primary = join(homedir(), ".signet", "backups");
	if (!basePath) {
		return primary;
	}
	if (!isWithin(resolve(basePath), primary)) {
		return primary;
	}
	const fallback = join(homedir(), ".signet-backups");
	if (!isWithin(resolve(basePath), fallback)) {
		return fallback;
	}
	return join(tmpdir(), "signet-backups");
}

function snapshotStatePath(basePath: string): string {
	return join(resolve(basePath), ".daemon", "workspace-protection.json");
}

function legacySnapshotStatePath(basePath: string): string {
	return join(resolve(basePath), ".signet-workspace-protection.json");
}

export function createWorkspaceSnapshot(basePath: string, backupRoot?: string): SnapshotResult {
	const root = resolve(backupRoot ?? defaultBackupRoot(basePath));
	const source = resolve(basePath);
	if (isWithin(source, root)) {
		throw new Error(`Backup root must be outside workspace: ${root}`);
	}
	mkdirSync(root, { recursive: true });

	const stamp = new Date().toISOString().replace(/[-:.]/g, "");
	const dir = sanitize(basename(source));
	const target = join(root, `${dir}-${stamp}`);

	cpSync(source, target, {
		recursive: true,
		errorOnExist: true,
		force: false,
	});

	const sourceDb = join(source, "memory", "memories.db");
	if (existsSync(sourceDb)) {
		const targetDb = join(target, "memory", "memories.db");
		rmSync(targetDb, { force: true });
		rmSync(`${targetDb}-wal`, { force: true });
		rmSync(`${targetDb}-shm`, { force: true });
		backupSqlite(sourceDb, targetDb);
	}

	if (!existsSync(target)) {
		throw new Error(`Snapshot copy failed: ${target}`);
	}

	return { path: target, root };
}

function readSnapshotState(basePath: string): SnapshotState | null {
	const next = snapshotStatePath(basePath);
	const legacy = legacySnapshotStatePath(basePath);
	const file = existsSync(next) ? next : legacy;
	if (!existsSync(file)) {
		return null;
	}
	try {
		const raw = JSON.parse(readFileSync(file, "utf-8"));
		if (typeof raw !== "object" || raw === null) {
			return null;
		}
		const source = "source" in raw ? raw.source : null;
		if (typeof source !== "string" || source.trim().length === 0) {
			return null;
		}
		const snapshot = "snapshot" in raw ? raw.snapshot : null;
		if (typeof snapshot !== "string" || snapshot.trim().length === 0) {
			return null;
		}
		const createdAt = "createdAt" in raw ? raw.createdAt : null;
		if (typeof createdAt !== "string" || createdAt.trim().length === 0) {
			return null;
		}
		return {
			source: resolve(source),
			snapshot: resolve(snapshot),
			createdAt: createdAt.trim(),
		};
	} catch {
		return null;
	}
}

export function saveSnapshotProtection(basePath: string, snapshotPath: string): void {
	const state: SnapshotState = {
		source: resolve(basePath),
		snapshot: resolve(snapshotPath),
		createdAt: new Date().toISOString(),
	};
	const file = snapshotStatePath(basePath);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
	rmSync(legacySnapshotStatePath(basePath), { force: true });
}

export function getSnapshotProtection(basePath: string): string | null {
	const state = readSnapshotState(basePath);
	if (!state) {
		return null;
	}
	if (state.source !== resolve(basePath)) {
		return null;
	}
	if (!isFresh(state.createdAt)) {
		return null;
	}
	if (!existsSync(state.snapshot)) {
		return null;
	}
	if (isWithin(resolve(basePath), state.snapshot)) {
		return null;
	}
	if (!hasSnapshotContents(resolve(basePath), state.snapshot)) {
		return null;
	}
	return state.snapshot;
}

export function setOriginRemote(dir: string, url: string): void {
	const path = resolve(dir);
	let state = getGitRemoteState(path);
	if (!state.isRepo) {
		const init = spawnSync("git", ["init"], {
			cwd: path,
			encoding: "utf-8",
			windowsHide: true,
		});
		if (init.status !== 0) {
			throw new Error(readOutput(init.stderr) || `Failed to initialize git repository: ${path}`);
		}
		state = getGitRemoteState(path);
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
