import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PI_MANAGED_FILENAMES = ["signet-pi.js", "signet-pi.mjs"] as const;
const PI_MANAGED_MARKER = "SIGNET_MANAGED_PI_EXTENSION";

interface PiConfigFile {
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
	return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

function expandUserPath(pathValue: string, env: NodeJS.ProcessEnv): string {
	const trimmed = pathValue.trim();
	const home = userHome(env);
	if (trimmed === "~") return home;
	if (trimmed.startsWith("~/")) return join(home, trimmed.slice(2));
	if (trimmed.startsWith("~")) return join(home, trimmed.slice(1));
	return trimmed;
}

function normalizePath(pathValue: string, env: NodeJS.ProcessEnv): string {
	return resolve(expandUserPath(pathValue, env));
}

function readConfigHome(env: NodeJS.ProcessEnv): string {
	const configured = readTrimmed(env, "XDG_CONFIG_HOME");
	return configured ? normalizePath(configured, env) : join(userHome(env), ".config");
}

export function getPiConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(readConfigHome(env), "signet", "pi.json");
}

export function readConfiguredPiAgentDir(env: NodeJS.ProcessEnv = process.env): string | null {
	const configPath = getPiConfigPath(env);
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
 * Resolve the Pi agent directory.
 *
 * Mirrors the logic of Pi SDK's `getAgentDir()` (env → default) but adds
 * a persistence layer via `~/.config/signet/pi.json` so the CLI remembers
 * the path across sessions even when the env var is unset.
 */
export function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = readTrimmed(env, "PI_CODING_AGENT_DIR");
	if (configured) return normalizePath(configured, env);
	return readConfiguredPiAgentDir(env) ?? join(userHome(env), ".pi", "agent");
}

export function resolvePiExtensionsDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(resolvePiAgentDir(env), "extensions");
}

export function listPiAgentDirCandidates(env: NodeJS.ProcessEnv = process.env): readonly string[] {
	const candidates = new Set<string>();
	const configured = readTrimmed(env, "PI_CODING_AGENT_DIR");
	if (configured) candidates.add(normalizePath(configured, env));
	const persisted = readConfiguredPiAgentDir(env);
	if (persisted) candidates.add(persisted);
	candidates.add(join(userHome(env), ".pi", "agent"));
	return Array.from(candidates);
}

export function hasPiSetup(env: NodeJS.ProcessEnv = process.env): boolean {
	if (existsSync(resolvePiAgentDir(env))) return true;
	for (const agentDir of listPiAgentDirCandidates(env)) {
		const extensionsDir = join(agentDir, "extensions");
		for (const filename of PI_MANAGED_FILENAMES) {
			const extensionPath = join(extensionsDir, filename);
			if (!existsSync(extensionPath)) continue;
			try {
				if (readFileSync(extensionPath, "utf8").includes(PI_MANAGED_MARKER)) return true;
			} catch {
				// Ignore unreadable candidate and continue checking others.
			}
		}
	}
	return false;
}

export function writeConfiguredPiAgentDir(pathValue: string, env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = normalizePath(pathValue, env);
	const configPath = getPiConfigPath(env);
	if (readConfiguredPiAgentDir(env) === agentDir && existsSync(configPath)) {
		return configPath;
	}
	mkdirSync(dirname(configPath), { recursive: true });
	const payload: PiConfigFile = {
		version: 1,
		agentDir,
		updatedAt: new Date().toISOString(),
	};
	writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`);
	return configPath;
}

export function clearConfiguredPiAgentDir(env: NodeJS.ProcessEnv = process.env): void {
	const configPath = getPiConfigPath(env);
	if (!existsSync(configPath)) return;
	try {
		rmSync(configPath, { force: true });
	} catch {
		// best-effort cleanup
	}
}
