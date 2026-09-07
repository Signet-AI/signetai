import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandHome } from "@signet/core";

export interface AgentDirConfig {
	readonly configFileName: string;
	readonly defaultAgentDir: string;
	readonly legacyTildeExpansion?: boolean;
}

export interface AgentDir {
	readonly getConfigPath: (env?: NodeJS.ProcessEnv) => string;
	readonly readConfiguredAgentDir: (env?: NodeJS.ProcessEnv) => string | null;
	readonly resolveAgentDir: (env?: NodeJS.ProcessEnv) => string;
	readonly resolveExtensionsDir: (env?: NodeJS.ProcessEnv) => string;
	readonly listAgentDirCandidates: (env?: NodeJS.ProcessEnv) => readonly string[];
	readonly hasSetup: (env?: NodeJS.ProcessEnv) => boolean;
	readonly writeConfiguredAgentDir: (pathValue: string, env?: NodeJS.ProcessEnv) => string;
	readonly clearConfiguredAgentDir: (env?: NodeJS.ProcessEnv) => void;
}

function readTrimmed(env: NodeJS.ProcessEnv, name: string): string | null {
	const raw = env[name];
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function userHome(env: NodeJS.ProcessEnv): string {
	return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

function normalizePath(pathValue: string, env: NodeJS.ProcessEnv, legacyTildeExpansion = false): string {
	const trimmed = pathValue.trim();
	const home = userHome(env);
	const expanded =
		legacyTildeExpansion && trimmed.startsWith("~") ? join(home, trimmed.slice(1)) : expandHome(trimmed, home);
	return resolve(expanded);
}

function readConfigHome(env: NodeJS.ProcessEnv, legacyTildeExpansion = false): string {
	const configured = readTrimmed(env, "XDG_CONFIG_HOME");
	return configured === null ? join(userHome(env), ".config") : normalizePath(configured, env, legacyTildeExpansion);
}

export function createAgentDir(config: AgentDirConfig): AgentDir {
	const getConfigPath = (env: NodeJS.ProcessEnv = process.env): string =>
		join(readConfigHome(env, config.legacyTildeExpansion), "signet", config.configFileName);

	const readConfiguredAgentDir = (env: NodeJS.ProcessEnv = process.env): string | null => {
		try {
			const raw: unknown = JSON.parse(readFileSync(getConfigPath(env), "utf8"));
			if (typeof raw !== "object" || raw === null) return null;
			const agentDir = Reflect.get(raw, "agentDir");
			if (typeof agentDir !== "string" || agentDir.trim().length === 0) return null;
			return normalizePath(agentDir, env, config.legacyTildeExpansion);
		} catch {
			return null;
		}
	};

	const resolveAgentDir = (env: NodeJS.ProcessEnv = process.env): string => {
		const configured = readTrimmed(env, "PI_CODING_AGENT_DIR");
		if (configured !== null) return normalizePath(configured, env, config.legacyTildeExpansion);
		return readConfiguredAgentDir(env) ?? join(userHome(env), config.defaultAgentDir);
	};

	const resolveExtensionsDir = (env: NodeJS.ProcessEnv = process.env): string =>
		join(resolveAgentDir(env), "extensions");

	const listAgentDirCandidates = (env: NodeJS.ProcessEnv = process.env): readonly string[] => {
		const candidates = new Set<string>();
		const configured = readTrimmed(env, "PI_CODING_AGENT_DIR");
		if (configured !== null) candidates.add(normalizePath(configured, env, config.legacyTildeExpansion));
		const persisted = readConfiguredAgentDir(env);
		if (persisted !== null) candidates.add(persisted);
		candidates.add(join(userHome(env), config.defaultAgentDir));
		return Array.from(candidates);
	};

	const hasSetup = (env: NodeJS.ProcessEnv = process.env): boolean =>
		listAgentDirCandidates(env).some((agentDir) => existsSync(agentDir));

	const writeConfiguredAgentDir = (pathValue: string, env: NodeJS.ProcessEnv = process.env): string => {
		const agentDir = normalizePath(pathValue, env, config.legacyTildeExpansion);
		const configPath = getConfigPath(env);
		if (readConfiguredAgentDir(env) === agentDir) return configPath;
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(
			configPath,
			`${JSON.stringify({ version: 1, agentDir, updatedAt: new Date().toISOString() }, null, 2)}\n`,
		);
		return configPath;
	};

	const clearConfiguredAgentDir = (env: NodeJS.ProcessEnv = process.env): void => {
		try {
			rmSync(getConfigPath(env), { force: true });
		} catch {
			// Best-effort cleanup.
		}
	};

	return {
		getConfigPath,
		readConfiguredAgentDir,
		resolveAgentDir,
		resolveExtensionsDir,
		listAgentDirCandidates,
		hasSetup,
		writeConfiguredAgentDir,
		clearConfiguredAgentDir,
	};
}
