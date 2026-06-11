import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandHome } from "@signet/core";

export type WorkspaceSource = "env" | "config" | "default";

export interface WorkspaceResolution {
	readonly path: string;
	readonly source: WorkspaceSource;
	readonly configPath: string;
	readonly configuredPath: string | null;
}

interface WorkspaceConfigFile {
	readonly version: 1;
	readonly workspace: string;
	readonly updatedAt: string;
}

export function normalizeWorkspacePath(pathValue: string): string {
	return resolve(expandHome(pathValue.trim()));
}

function readEnvPath(env: NodeJS.ProcessEnv): string | null {
	const raw = env.SIGNET_PATH;
	if (typeof raw !== "string") {
		return null;
	}

	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return null;
	}

	return normalizeWorkspacePath(trimmed);
}

function readConfigHome(env: NodeJS.ProcessEnv): string {
	const raw = env.XDG_CONFIG_HOME;
	if (typeof raw !== "string") {
		return join(homedir(), ".config");
	}

	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return join(homedir(), ".config");
	}

	return normalizeWorkspacePath(trimmed);
}

export function getWorkspaceConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(readConfigHome(env), "signet", "workspace.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readWorkspaceFromConfig(path: string): string | null {
	if (!existsSync(path)) {
		return null;
	}

	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isRecord(raw)) {
			return null;
		}

		const workspace = raw.workspace;
		if (typeof workspace !== "string") {
			return null;
		}

		const trimmed = workspace.trim();
		if (trimmed.length === 0) {
			return null;
		}

		return normalizeWorkspacePath(trimmed);
	} catch {
		return null;
	}
}

export function readConfiguredWorkspacePath(env: NodeJS.ProcessEnv = process.env): string | null {
	const cfgPath = getWorkspaceConfigPath(env);
	return readWorkspaceFromConfig(cfgPath);
}

export function resolveAgentsDir(env: NodeJS.ProcessEnv = process.env): WorkspaceResolution {
	const cfgPath = getWorkspaceConfigPath(env);
	const envPath = readEnvPath(env);
	const cfgValue = readWorkspaceFromConfig(cfgPath);
	if (envPath) {
		return {
			path: envPath,
			source: "env",
			configPath: cfgPath,
			configuredPath: cfgValue,
		};
	}

	if (cfgValue) {
		return {
			path: cfgValue,
			source: "config",
			configPath: cfgPath,
			configuredPath: cfgValue,
		};
	}

	return {
		path: join(homedir(), ".agents"),
		source: "default",
		configPath: cfgPath,
		configuredPath: null,
	};
}

export function writeConfiguredWorkspacePath(pathValue: string, env: NodeJS.ProcessEnv = process.env): string {
	const path = normalizeWorkspacePath(pathValue);
	const cfgPath = getWorkspaceConfigPath(env);
	const cfgDir = dirname(cfgPath);
	mkdirSync(cfgDir, { recursive: true });

	const payload: WorkspaceConfigFile = {
		version: 1,
		workspace: path,
		updatedAt: new Date().toISOString(),
	};
	writeFileSync(cfgPath, `${JSON.stringify(payload, null, 2)}\n`);
	return cfgPath;
}

export function clearConfiguredWorkspacePath(env: NodeJS.ProcessEnv = process.env): void {
	const cfgPath = getWorkspaceConfigPath(env);
	if (!existsSync(cfgPath)) {
		return;
	}

	rmSync(cfgPath, { force: true });
}
