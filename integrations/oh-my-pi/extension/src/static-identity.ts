import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS =
	"[signet: daemon session-start timed out — running with static identity]";
const STATIC_IDENTITY_OFFLINE_STATUS = "[signet: daemon offline — running with static identity]";
const FILES = [
	["AGENTS.md", "Agent Instructions", 12_000],
	["SOUL.md", "Soul", 4_000],
	["IDENTITY.md", "Identity", 2_000],
	["USER.md", "About Your User", 6_000],
	["MEMORY.md", "Working Memory", 10_000],
] as const;

export function resolveSessionStartTimeoutMs(raw?: string): number {
	if (!raw) return 15_000;
	const ms = Number.parseInt(raw, 10);
	if (!Number.isFinite(ms) || ms < 1_000) return 15_000;
	return Math.min(ms, 120_000);
}

export function readStaticIdentity(agentsDir: string, status = STATIC_IDENTITY_OFFLINE_STATUS): string | null {
	if (!existsSync(agentsDir)) return null;
	const parts: string[] = [];
	for (const [file, header, budget] of FILES) {
		const path = join(agentsDir, file);
		if (!existsSync(path)) continue;
		try {
			const raw = readFileSync(path, "utf8").trim();
			if (!raw) continue;
			parts.push(`## ${header}\n\n${raw.length <= budget ? raw : `${raw.slice(0, budget)}\n[truncated]`}`);
		} catch {
			// Ignore unreadable optional identity files.
		}
	}
	return parts.length > 0 ? `${status}\n\n${parts.join("\n\n")}` : null;
}

export function resolveSignetPath(): string {
	const configured = process.env.SIGNET_PATH?.trim();
	return configured ? configured.replace(/^~(?=\/|$)/, homedir()) : join(homedir(), ".agents");
}
