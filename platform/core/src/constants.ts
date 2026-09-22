import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveDefaultBasePath(): string {
	const envPath = process.env.SIGNET_PATH?.trim() || process.env.SIGNET_WORKSPACE?.trim();
	if (envPath) return resolve(expandHome(envPath));

	const home = homedir();
	const configHome = process.env.XDG_CONFIG_HOME?.trim()
		? resolve(expandHome(process.env.XDG_CONFIG_HOME.trim(), home))
		: join(home, ".config");
	const configPath = join(configHome, "signet", "workspace.json");
	if (existsSync(configPath)) {
		try {
			const value = JSON.parse(readFileSync(configPath, "utf8")) as { workspace?: unknown };
			if (typeof value.workspace === "string" && value.workspace.trim())
				return resolve(expandHome(value.workspace, home));
		} catch {}
	}
	return join(home, ".agents");
}

export function expandHome(p: string, home = homedir()): string {
	if (p === "~") return home;
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
	return p;
}

export const SCHEMA_VERSION = 3;
export const SPEC_VERSION = "1.0";
export const SCHEMA_ID = "signet/v1";

export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
export const DEFAULT_HYBRID_ALPHA = 0.7;
export const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000;
