import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const OH_MY_PI_MANAGED_FILENAMES = ["signet-oh-my-pi.js", "signet-oh-my-pi.mjs"] as const;
const OH_MY_PI_MANAGED_MARKER = "SIGNET_MANAGED_OH_MY_PI_EXTENSION";

interface OhMyPiConfigFile {
	readonly version: 1;
	readonly agentDir: string;
	readonly updatedAt: string;
}

function readTrimmed(env: NodeJS.ProcessEnv, name: string): string | null {
	const raw = env[name];
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function userHome(env: NodeJS.ProcessEnv): string {
	return env.HOME?.trim() || homedir();
}

function expandUserPath(pathValue: string, env: NodeJS.ProcessEnv): string {
	const trimmed = pathValue.trim();
	const home = userHome(env);
	if (trimmed === "~") return home;
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return join(home, trimmed.slice(2));
	return trimmed;
}

function normalizePath(pathValue: string, env: NodeJS.ProcessEnv): string {
	return resolve(expandUserPath(pathValue, env));
}

function readConfigHome(env: NodeJS.ProcessEnv): string {
	const configured = readTrimmed(env, "XDG_CONFIG_HOME");
	return configured ? normalizePath(configured, env) : join(userHome(env), ".config");
}

export function getOhMyPiConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(readConfigHome(env), "signet", "oh-my-pi.json");
}

export function readConfiguredOhMyPiAgentDir(env: NodeJS.ProcessEnv = process.env): string | null {
	const configPath = getOhMyPiConfigPath(env);
	if (!existsSync(configPath)) return null;

	try {
		const raw: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
		if (typeof raw !== "object" || raw === null) return null;
		const agentDir = Reflect.get(raw, "agentDir");
		return typeof agentDir === "string" && agentDir.trim().length > 0 ? normalizePath(agentDir, env) : null;
	} catch {
		return null;
	}
}

/**
 * Resolve the Oh My Pi agent directory.
 *
 * Mirrors the logic of Oh My Pi SDK's `getAgentDir()` (env → default) but
 * adds a persistence layer via `~/.config/signet/oh-my-pi.json` so the CLI
 * remembers the path across sessions even when the env var is unset.
 */
export function resolveOhMyPiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = readTrimmed(env, "PI_CODING_AGENT_DIR");
	if (configured) return normalizePath(configured, env);
	return readConfiguredOhMyPiAgentDir(env) ?? join(userHome(env), ".omp", "agent");
}

export function resolveOhMyPiExtensionsDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(resolveOhMyPiAgentDir(env), "extensions");
}

export function listOhMyPiAgentDirCandidates(env: NodeJS.ProcessEnv = process.env): readonly string[] {
	const candidates = new Set<string>();
	const configured = readTrimmed(env, "PI_CODING_AGENT_DIR");
	if (configured) candidates.add(normalizePath(configured, env));
	const persisted = readConfiguredOhMyPiAgentDir(env);
	if (persisted) candidates.add(persisted);
	candidates.add(join(userHome(env), ".omp", "agent"));
	return Array.from(candidates);
}

export function hasOhMyPiSetup(env: NodeJS.ProcessEnv = process.env): boolean {
	if (existsSync(resolveOhMyPiAgentDir(env))) return true;
	for (const agentDir of listOhMyPiAgentDirCandidates(env)) {
		const extensionsDir = join(agentDir, "extensions");
		for (const filename of OH_MY_PI_MANAGED_FILENAMES) {
			const extensionPath = join(extensionsDir, filename);
			if (!existsSync(extensionPath)) continue;
			try {
				if (readFileSync(extensionPath, "utf8").includes(OH_MY_PI_MANAGED_MARKER)) return true;
			} catch {
				// Ignore unreadable candidate and continue checking others.
			}
		}
	}
	return false;
}

export function writeConfiguredOhMyPiAgentDir(pathValue: string, env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = normalizePath(pathValue, env);
	const configPath = getOhMyPiConfigPath(env);
	if (readConfiguredOhMyPiAgentDir(env) === agentDir && existsSync(configPath)) {
		return configPath;
	}
	mkdirSync(dirname(configPath), { recursive: true });
	const payload: OhMyPiConfigFile = {
		version: 1,
		agentDir,
		updatedAt: new Date().toISOString(),
	};
	writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`);
	return configPath;
}

export function clearConfiguredOhMyPiAgentDir(env: NodeJS.ProcessEnv = process.env): void {
	const configPath = getOhMyPiConfigPath(env);
	if (!existsSync(configPath)) return;
	try {
		rmSync(configPath, { force: true });
	} catch {
		// best-effort cleanup
	}
}
