import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type DesktopWorkspaceSource = "env" | "config" | "default";

export interface DesktopWorkspaceResolution {
	readonly path: string;
	readonly source: DesktopWorkspaceSource;
	readonly configPath: string;
	readonly configuredPath: string | null;
}

function normalizeWorkspacePath(value: string, home: string): string {
	const expanded = value.trim().replace(/^~(?=$|[\\/])/, home);
	return resolve(expanded);
}

function configHome(env: NodeJS.ProcessEnv, home: string): string {
	const configured = env.XDG_CONFIG_HOME?.trim();
	return configured ? normalizeWorkspacePath(configured, home) : join(home, ".config");
}

function configPath(env: NodeJS.ProcessEnv, home: string): string {
	return join(configHome(env, home), "signet", "workspace.json");
}

function readConfiguredPath(path: string, home: string, strict = true): string | null {
	if (!existsSync(path)) return null;
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (!strict) return null;
		throw new Error(
			`Invalid Signet workspace config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		typeof (value as { workspace?: unknown }).workspace !== "string"
	) {
		if (!strict) return null;
		throw new Error(`Invalid Signet workspace config at ${path}: missing workspace`);
	}
	const workspace = (value as { workspace: string }).workspace.trim();
	if (!workspace) {
		if (!strict) return null;
		throw new Error(`Invalid Signet workspace config at ${path}: workspace must be a non-empty string`);
	}
	return normalizeWorkspacePath(workspace, home);
}

export function resolveDesktopWorkspace(
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
): DesktopWorkspaceResolution {
	const persistedConfigPath = configPath(env, home);
	const envValue = env.SIGNET_PATH?.trim() || env.SIGNET_WORKSPACE?.trim();
	const configuredPath = readConfiguredPath(persistedConfigPath, home, !envValue);
	if (envValue) {
		return {
			path: normalizeWorkspacePath(envValue, home),
			source: "env",
			configPath: persistedConfigPath,
			configuredPath,
		};
	}
	if (configuredPath) {
		return { path: configuredPath, source: "config", configPath: persistedConfigPath, configuredPath };
	}
	return { path: join(home, ".agents"), source: "default", configPath: persistedConfigPath, configuredPath: null };
}

export function applyDesktopWorkspaceEnv(
	resolution: DesktopWorkspaceResolution,
	env: NodeJS.ProcessEnv = process.env,
): DesktopWorkspaceResolution {
	env.SIGNET_PATH = resolution.path;
	env.SIGNET_WORKSPACE = resolution.path;
	return resolution;
}

export function isDesktopWorkspaceDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
