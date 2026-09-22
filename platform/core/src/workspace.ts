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

export type WorkspaceSource = "env" | "config" | "default";

export interface WorkspaceResolution {
	readonly path: string;
	readonly source: WorkspaceSource;
	readonly configPath: string;
	readonly configuredPath: string | null;
}

export type WorkspaceStartupStatus = "fresh" | "ready" | "missing" | "incomplete";

export interface WorkspaceStartupPreflight extends WorkspaceResolution {
	readonly status: WorkspaceStartupStatus;
	readonly reasons: readonly string[];
}

export interface ResolveWorkspacePathOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
	readonly strict?: boolean;
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
export const WORKSPACE_ENV_KEYS = ["SIGNET_PATH", "SIGNET_WORKSPACE"] as const;

const DEFAULT_AGENTS_DIRNAME = ".agents";

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

export function getWorkspaceConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return join(readConfigHome(env, home), "signet", "workspace.json");
}
export function readConfiguredWorkspacePath(
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
	options: { readonly strict?: boolean } = {},
): string | null {
	const strict = options.strict ?? true;
	const configPath = getWorkspaceConfigPath(env, home);
	if (!existsSync(configPath)) return null;

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch (err) {
		if (!strict) return null;
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`Invalid Signet workspace config at ${configPath}: ${detail}`);
	}

	if (!isRecord(raw) || !("workspace" in raw)) {
		if (!strict) return null;
		throw new Error(`Invalid Signet workspace config at ${configPath}: missing workspace`);
	}

	const workspace = raw.workspace;
	if (typeof workspace !== "string" || workspace.trim().length === 0) {
		if (!strict) return null;
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
export function resolveWorkspacePath(options: ResolveWorkspacePathOptions = {}): WorkspaceResolution {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const strict = options.strict ?? true;
	const requireExistingEnvPath = options.requireExistingEnvPath ?? false;

	const configPath = getWorkspaceConfigPath(env, home);
	const envPath = resolveEnvWorkspace(env, home, requireExistingEnvPath);
	const configValue = readConfiguredWorkspacePath(env, home, { strict: envPath ? false : strict });

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
export function preflightWorkspace(options: ResolveWorkspacePathOptions = {}): WorkspaceStartupPreflight {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	let resolution: WorkspaceResolution;
	try {
		resolution = resolveWorkspacePath({ ...options, strict: true });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			path: join(home, DEFAULT_AGENTS_DIRNAME),
			source: "default",
			configPath: getWorkspaceConfigPath(env, home),
			configuredPath: null,
			status: "incomplete",
			reasons: [detail],
		};
	}
	const reasons: string[] = [];
	const hasExplicitConfiguration = resolution.source === "env" || resolution.configuredPath !== null;

	if (!isExistingDirectory(resolution.path)) {
		if (hasExplicitConfiguration) {
			reasons.push("configured workspace directory is missing");
			return { ...resolution, status: "missing", reasons };
		}
		return { ...resolution, status: "fresh", reasons };
	}

	const hasAgentConfig =
		existsSync(join(resolution.path, "agent.yaml")) || existsSync(join(resolution.path, "config.yaml"));
	const hasMemoryDb = existsSync(join(resolution.path, "memory", "memories.db"));
	if (hasAgentConfig && hasMemoryDb) {
		return { ...resolution, status: "ready", reasons };
	}

	if (!hasExplicitConfiguration && !hasAgentConfig && !hasMemoryDb) {
		return { ...resolution, status: "fresh", reasons };
	}

	if (!hasAgentConfig) reasons.push("workspace configuration is missing (agent.yaml or config.yaml)");
	if (!hasMemoryDb) reasons.push("workspace database is missing (memory/memories.db)");
	return { ...resolution, status: "incomplete", reasons };
}

export function formatWorkspacePreflightError(preflight: WorkspaceStartupPreflight): string {
	const detail = preflight.reasons.length > 0 ? ` ${preflight.reasons.join("; ")}.` : "";
	return `Signet cannot start: ${preflight.status} workspace at ${preflight.path}.${detail} Restore the configured workspace or run explicit setup; Signet will not recreate it.`;
}

function resolveEnvWorkspace(env: NodeJS.ProcessEnv, home: string, requireExisting: boolean): string | null {
	for (const key of WORKSPACE_ENV_KEYS) {
		const raw = readTrimmedEnv(env, key);
		if (!raw) continue;
		const normalized = normalizeWorkspacePath(raw, home);
		if (!requireExisting || isExistingDirectory(normalized)) return normalized;
		console.warn(
			`[signet] ${key}="${raw}" does not point to an existing workspace directory; using the default workspace resolution instead.`,
		);
	}
	return null;
}
