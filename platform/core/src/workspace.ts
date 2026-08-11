/**
 * Canonical Signet workspace path resolution.
 *
 * One owner for the "resolve `SIGNET_PATH` → `SIGNET_WORKSPACE` →
 * `$XDG_CONFIG_HOME/signet/workspace.json` → `~/.agents` default" chain that
 * is shared by connector-base, the CLI, and the desktop shell (issue #956).
 *
 * Resolution precedence:
 *   1. `SIGNET_PATH` env var
 *   2. `SIGNET_WORKSPACE` env var (alias, lower precedence)
 *   3. persisted `$XDG_CONFIG_HOME/signet/workspace.json` `{ workspace }`
 *   4. `~/.agents` default
 *
 * Env var precedence is defined once here and applied everywhere, so a synced
 * or cloned agents directory resolves consistently regardless of which surface
 * performs the resolution.
 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandHome } from "./constants";

// ============================================================================
// Types
// ============================================================================

export type WorkspaceSource = "env" | "config" | "default";

export interface WorkspaceResolution {
	readonly path: string;
	readonly source: WorkspaceSource;
	readonly configPath: string;
	readonly configuredPath: string | null;
}

export interface ResolveWorkspacePathOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
	/**
	 * Throw on a malformed persisted workspace.json instead of falling back to
	 * the default. Existing malformed files now always throw; this option is
	 * retained for source compatibility with explicit install operations.
	 */
	readonly strict?: boolean;
	/**
	 * Require an env-derived workspace path to point at an existing directory.
	 * When `false` (default) an env override is trusted verbatim. When `true`,
	 * a stale env override is treated as unset (with a warning) and resolution
	 * falls through to the config/default, which prevents a migrated/legacy
	 * managed extension from re-embedding a path that no longer exists
	 * (issue #1016).
	 */
	readonly requireExistingEnvPath?: boolean;
}

interface WorkspaceConfigFile {
	readonly version: 1;
	readonly workspace: string;
	readonly updatedAt: string;
}

export interface WorkspaceFileSystem {
	readonly closeSync: typeof closeSync;
	readonly fsyncSync: typeof fsyncSync;
	readonly openSync: typeof openSync;
	readonly renameSync: typeof renameSync;
	readonly rmSync: typeof rmSync;
	readonly writeSync: typeof writeSync;
}

const defaultWorkspaceFileSystem: WorkspaceFileSystem = {
	closeSync,
	fsyncSync,
	openSync,
	renameSync,
	rmSync,
	writeSync,
};

// ============================================================================
// Constants
// ============================================================================

/** Env vars honored as workspace overrides, in precedence order. */
export const WORKSPACE_ENV_KEYS = ["SIGNET_PATH", "SIGNET_WORKSPACE"] as const;

const DEFAULT_AGENTS_DIRNAME = ".agents";

// ============================================================================
// Helpers
// ============================================================================

export function normalizeWorkspacePath(pathValue: string, home = homedir()): string {
	return resolve(expandHome(pathValue.trim(), home));
}

function readTrimmedEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readConfigHome(env: NodeJS.ProcessEnv, home: string): string {
	const raw = env.XDG_CONFIG_HOME;
	if (typeof raw !== "string") return join(home, ".config");
	const trimmed = raw.trim();
	return trimmed.length > 0 ? normalizeWorkspacePath(trimmed, home) : join(home, ".config");
}

function isExistingDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ============================================================================
// Config path + read/write
// ============================================================================

export function getWorkspaceConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return join(readConfigHome(env, home), "signet", "workspace.json");
}

/**
 * Read the persisted `workspace` value from `workspace.json`.
 *
 * Returns `null` only when the file is absent. An existing malformed file
 * throws instead of silently selecting the default workspace.
 */
export function readConfiguredWorkspacePath(
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
	_options: { readonly strict?: boolean } = {},
): string | null {
	const configPath = getWorkspaceConfigPath(env, home);
	if (!existsSync(configPath)) return null;

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`Invalid Signet workspace config at ${configPath}: ${detail}`);
	}

	if (!isRecord(raw) || !("workspace" in raw)) {
		throw new Error(`Invalid Signet workspace config at ${configPath}: missing workspace`);
	}

	const workspace = raw.workspace;
	if (typeof workspace !== "string" || workspace.trim().length === 0) {
		throw new Error(`Invalid Signet workspace config at ${configPath}: workspace must be a non-empty string`);
	}

	return normalizeWorkspacePath(workspace, home);
}

export function writeConfiguredWorkspacePath(
	pathValue: string,
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
	fileSystem: WorkspaceFileSystem = defaultWorkspaceFileSystem,
): string {
	const path = normalizeWorkspacePath(pathValue, home);
	const configPath = getWorkspaceConfigPath(env, home);
	const configDir = dirname(configPath);
	mkdirSync(configDir, { recursive: true });

	const payload: WorkspaceConfigFile = {
		version: 1,
		workspace: path,
		updatedAt: new Date().toISOString(),
	};
	const temporaryPath = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
	const content = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
	let descriptor: number | undefined;
	let committed = false;
	try {
		descriptor = fileSystem.openSync(temporaryPath, "w");
		let offset = 0;
		while (offset < content.length) {
			const written = fileSystem.writeSync(descriptor, content, offset, content.length - offset);
			if (written <= 0) throw new Error(`Unable to write workspace config at ${temporaryPath}`);
			offset += written;
		}
		fileSystem.fsyncSync(descriptor);
		fileSystem.closeSync(descriptor);
		descriptor = undefined;
		fileSystem.renameSync(temporaryPath, configPath);
		committed = true;
	} finally {
		if (descriptor !== undefined) fileSystem.closeSync(descriptor);
		if (!committed) fileSystem.rmSync(temporaryPath, { force: true });
	}
	return configPath;
}

export function clearConfiguredWorkspacePath(env: NodeJS.ProcessEnv = process.env): void {
	const configPath = getWorkspaceConfigPath(env);
	if (!existsSync(configPath)) return;
	rmSync(configPath, { force: true });
}

// ============================================================================
// Resolution
// ============================================================================

/**
 * Resolve the active Signet workspace path from env, persisted config, and
 * default, returning a structured result describing which source won.
 */
export function resolveWorkspacePath(options: ResolveWorkspacePathOptions = {}): WorkspaceResolution {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const requireExistingEnvPath = options.requireExistingEnvPath ?? false;

	const configPath = getWorkspaceConfigPath(env, home);
	// Resolve the env override first. The persisted config is still read so the
	// structured result reports it, but an existing malformed config is always an
	// error rather than a reason to silently select the default workspace.
	const envPath = resolveEnvWorkspace(env, home, requireExistingEnvPath);
	const configValue = readConfiguredWorkspacePath(env, home);

	if (envPath) {
		return {
			path: envPath,
			source: "env",
			configPath,
			configuredPath: configValue,
		};
	}

	if (configValue) {
		return {
			path: configValue,
			source: "config",
			configPath,
			configuredPath: configValue,
		};
	}

	return {
		path: join(home, DEFAULT_AGENTS_DIRNAME),
		source: "default",
		configPath,
		configuredPath: configValue,
	};
}

function resolveEnvWorkspace(env: NodeJS.ProcessEnv, home: string, requireExisting: boolean): string | null {
	for (const key of WORKSPACE_ENV_KEYS) {
		const raw = readTrimmedEnv(env, key);
		if (!raw) continue;
		const normalized = normalizeWorkspacePath(raw, home);
		if (!requireExisting || isExistingDirectory(normalized)) return normalized;
		// A stale env override (from a migrated/legacy managed extension) points
		// at a directory that no longer exists on this machine. Treat it as
		// unset and fall through to config/default resolution so the wrong path
		// is not re-embedded (issue #1016). Warn so the dropped override is
		// diagnosable.
		console.warn(
			`[signet] ${key}="${raw}" does not point to an existing workspace directory; using the default workspace resolution instead.`,
		);
	}
	return null;
}
