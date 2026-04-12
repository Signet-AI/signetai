import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

function expandUserPath(pathValue: string): string {
	const trimmed = pathValue.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
	return trimmed;
}

function normalizePath(pathValue: string): string {
	return resolve(expandUserPath(pathValue));
}

function readConfigHome(env: NodeJS.ProcessEnv): string {
	const configured = readTrimmed(env, "XDG_CONFIG_HOME");
	return configured ? normalizePath(configured) : join(homedir(), ".config");
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
		return typeof agentDir === "string" && agentDir.trim().length > 0 ? normalizePath(agentDir) : null;
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
	if (configured) return normalizePath(configured);
	return readConfiguredPiAgentDir(env) ?? join(homedir(), ".pi", "agent");
}

export function resolvePiExtensionsDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(resolvePiAgentDir(env), "extensions");
}

export function listPiAgentDirCandidates(env: NodeJS.ProcessEnv = process.env): readonly string[] {
	const candidates = new Set<string>();
	const configured = readTrimmed(env, "PI_CODING_AGENT_DIR");
	if (configured) candidates.add(normalizePath(configured));
	const persisted = readConfiguredPiAgentDir(env);
	if (persisted) candidates.add(persisted);
	candidates.add(join(homedir(), ".pi", "agent"));
	return Array.from(candidates);
}

export function writeConfiguredPiAgentDir(pathValue: string, env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = normalizePath(pathValue);
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
