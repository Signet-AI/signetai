import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseConnector, type InstallResult, type UninstallResult, atomicWriteJson } from "@signet/connector-base";
import { expandHome, resolveSessionStartTimeoutMs } from "@signet/core";

// ---------------------------------------------------------------------------
// Signet command resolution
// ---------------------------------------------------------------------------

/** Resolve signet command for hook invocation. Returns array form for hooks.json command field.
 *  Windows: navigates from argv[1] (e.g. <pkg>/bin/signet.js) up two levels to find
 *  the bin directory. Falls back to bare "signet" if the layout doesn't match (shims, junctions). */
function resolveSignetArgs(): string[] {
	if (process.platform !== "win32") return ["signet"];
	const entry = process.argv[1] || "";
	const signetJs = join(entry, "..", "..", "bin", "signet.js");
	if (existsSync(signetJs)) return [process.execPath, signetJs];
	return ["signet"];
}

/** Resolve signet-mcp as { command, args } for Codex config.toml.
 *  Codex expects `command` as a string and `args` as a separate array. */
function resolveSignetMcp(): { command: string; args: string[] } {
	if (process.platform !== "win32") return { command: "signet-mcp", args: [] };
	const entry = process.argv[1] || "";
	const mcpJs = join(entry, "..", "..", "bin", "mcp-stdio.js");
	if (existsSync(mcpJs)) return { command: process.execPath, args: [mcpJs] };
	return { command: "signet-mcp", args: [] };
}

// ---------------------------------------------------------------------------
// hooks.json management
//
// Codex expects hooks.json with this shape (from codex-rs/hooks/src/engine/config.rs):
//
//   {
//     "hooks": {
//       "SessionStart": [{ "hooks": [{ "type": "command", "command": "...", "timeout": N }] }],
//       "UserPromptSubmit": [...],
//       "Stop": [...]
//     }
//   }
//
// Event names are PascalCase. Inner handler arrays use "hooks" (not "handlers").
// Each handler is a tagged union with "type": "command" and "command" as a string.
// ---------------------------------------------------------------------------

const HOOK_EVENT_KEYS = ["SessionStart", "UserPromptSubmit", "Stop"] as const;
const CODEX_SESSION_START_GRACE_SECONDS = 5;
const PROMPT_SUBMIT_TIMEOUT_SECONDS = 5;
const SESSION_END_TIMEOUT_SECONDS = 30;

interface MatcherGroup {
	_signet?: boolean;
	matcher?: string;
	hooks: HandlerConfig[];
}

interface HandlerConfig {
	type: "command";
	command: string;
	timeout?: number;
}

interface HooksFile {
	_signet?: boolean;
	hooks?: Record<string, MatcherGroup[]>;
	[key: string]: unknown;
}

function readTimeoutEnv(name: string): string {
	const value = process.env[name];
	return typeof value === "string" ? value.trim() : "";
}

function resolveCodexSessionStartTimeoutSeconds(): number {
	const raw = readTimeoutEnv("SIGNET_SESSION_START_TIMEOUT") || readTimeoutEnv("SIGNET_FETCH_TIMEOUT");
	return Math.ceil(resolveSessionStartTimeoutMs(raw) / 1000) + CODEX_SESSION_START_GRACE_SECONDS;
}

function buildHooksFile(signetArgs: string[]): HooksFile {
	const cmd = (subcommand: string, secs: number): MatcherGroup => ({
		_signet: true,
		hooks: [{ type: "command", command: [...signetArgs, "hook", subcommand, "-H", "codex"].join(" "), timeout: secs }],
	});
	return {
		_signet: true,
		hooks: {
			SessionStart: [cmd("session-start", resolveCodexSessionStartTimeoutSeconds())],
			UserPromptSubmit: [cmd("user-prompt-submit", PROMPT_SUBMIT_TIMEOUT_SECONDS)],
			Stop: [cmd("session-end", SESSION_END_TIMEOUT_SECONDS)],
		},
	};
}

function readHooksFile(path: string): HooksFile | null {
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as HooksFile;
	} catch {
		return null;
	}
}

function isSignetOwned(file: HooksFile): boolean {
	return file._signet === true;
}

function writeHooksFile(path: string, file: HooksFile): void {
	mkdirSync(join(path, ".."), { recursive: true });
	atomicWriteJson(path, file);
}

const SIGNET_HOOK_SUBCOMMANDS = ["session-start", "user-prompt-submit", "session-end"] as const;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSignetHookCommand(cmd: string): boolean {
	const normalized = cmd.trim().replace(/\s+/g, " ");
	return SIGNET_HOOK_SUBCOMMANDS.some((subcommand) => {
		const hook = `hook\\s+${escapeRegExp(subcommand)}\\b`;
		const bare = new RegExp(`^(?:signet|signet\\.(?:cmd|ps1|bat|exe))\\s+${hook}`, "i");
		if (bare.test(normalized)) return true;

		const quotedBare = new RegExp(`^["'][^"']*[\\\\/]signet(?:\\.(?:cmd|ps1|bat|exe))?["']\\s+${hook}`, "i");
		if (quotedBare.test(normalized)) return true;

		const nodeShim = new RegExp(
			`^(?:"[^"]*[\\\\/]?node(?:\\.exe)?"|'[^']*[\\\\/]?node(?:\\.exe)?'|\\S*[\\\\/]?node(?:\\.exe)?)\\s+(?:"[^"]*[\\\\/]signet\\.js"|'[^']*[\\\\/]signet\\.js'|\\S*[\\\\/]signet\\.js)\\s+${hook}`,
			"i",
		);
		return nodeShim.test(normalized);
	});
}

function isSignetMatcherGroup(group: unknown): boolean {
	if (typeof group !== "object" || group === null) return false;
	if ((group as Record<string, unknown>)._signet === true) return true;
	const hooksArr = (group as Record<string, unknown>).hooks;
	if (!Array.isArray(hooksArr)) return false;
	for (const handler of hooksArr) {
		if (typeof handler !== "object" || handler === null) continue;
		const cmd = (handler as Record<string, unknown>).command;
		if (typeof cmd !== "string") continue;
		if (isSignetHookCommand(cmd)) return true;
	}
	return false;
}

function isLegacySignetMatcherGroup(group: unknown): boolean {
	if (typeof group !== "object" || group === null) return false;
	const handlers = (group as Record<string, unknown>).handlers;
	if (!Array.isArray(handlers)) return false;
	for (const handler of handlers) {
		if (typeof handler !== "object" || handler === null) continue;
		const cmd = (handler as Record<string, unknown>).command;
		if (Array.isArray(cmd)) {
			const joined = cmd.join(" ");
			if (isSignetHookCommand(joined)) return true;
		}
	}
	return false;
}

function removeSignetEntries(file: HooksFile): HooksFile {
	const cleaned: HooksFile = { ...file, hooks: file.hooks ? structuredClone(file.hooks) : undefined };
	const events = cleaned.hooks;
	if (!events || typeof events !== "object") return cleaned;

	for (const key of Object.keys(events)) {
		const groups = events[key];
		if (!Array.isArray(groups)) continue;
		const filtered = groups.filter((g) => !isSignetMatcherGroup(g) && !isLegacySignetMatcherGroup(g));
		if (filtered.length === 0) {
			delete events[key];
		} else {
			(events as Record<string, unknown>)[key] = filtered;
		}
	}

	if (Object.keys(events).length === 0) cleaned.hooks = undefined;

	const hasSignet = cleaned.hooks
		? Object.values(cleaned.hooks as Record<string, unknown[]>).some(
				(groups) => Array.isArray(groups) && groups.some(isSignetMatcherGroup),
			)
		: false;
	if (!hasSignet) cleaned._signet = undefined;
	return cleaned;
}

function migrateLegacyHooksFile(file: HooksFile, signetArgs: string[]): HooksFile {
	if (isSignetOwned(file) && file.hooks && Object.keys(file.hooks).length > 0) return file;

	const legacyKeys = ["sessionStart", "userPromptSubmit", "stop"] as const;
	const hasLegacy = legacyKeys.some(
		(k) =>
			Array.isArray((file as Record<string, unknown>)[k]) &&
			((file as Record<string, unknown>)[k] as unknown[]).some(isLegacySignetMatcherGroup),
	);
	if (!hasLegacy) return file;

	const fresh = buildHooksFile(signetArgs);
	if (!file.hooks || typeof file.hooks !== "object") {
		fresh.hooks = { ...fresh.hooks };
	} else {
		for (const key of HOOK_EVENT_KEYS) {
			const existing = (file.hooks as Record<string, unknown[]>)[key];
			if (!Array.isArray(existing)) continue;
			const kept = existing.filter((g) => !isSignetMatcherGroup(g) && !isLegacySignetMatcherGroup(g));
			const ours = fresh.hooks?.[key] ?? [];
			(fresh.hooks as Record<string, unknown>)[key] = [...kept, ...ours];
		}
	}
	for (const k of legacyKeys) delete (fresh as Record<string, unknown>)[k];
	return fresh;
}

// ---------------------------------------------------------------------------
// MCP server registration (config.toml)
// ---------------------------------------------------------------------------

function tomlQuote(s: string): string {
	// Use TOML literal strings (single-quoted) to avoid backslash escaping
	if (!s.includes("'")) return `'${s}'`;
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

function tomlInlineArray(items: string[]): string {
	return `[${items.map(tomlQuote).join(", ")}]`;
}

export function buildMcpBlock(mcp: { command: string; args: string[] }): string {
	let block = `# Signet MCP server\n[mcp_servers.signet]\ncommand = ${tomlQuote(mcp.command)}\n`;
	if (mcp.args.length > 0) {
		block += `args = ${tomlInlineArray(mcp.args)}\n`;
	}
	return block;
}

function patchConfigToml(path: string, mcp: { command: string; args: string[] }): boolean {
	const dir = join(path, "..");
	mkdirSync(dir, { recursive: true });

	const block = buildMcpBlock(mcp);

	if (!existsSync(path)) {
		writeFileSync(path, block);
		return true;
	}

	const content = readFileSync(path, "utf-8");

	if (!content.includes("[mcp_servers.signet]")) {
		writeFileSync(path, `${content.trimEnd()}\n\n${block}`);
		return true;
	}

	// Section exists but may be stale (e.g. old array-format command).
	// Remove and re-add with correct format.
	unpatchConfigToml(path);
	const updated = existsSync(path) ? readFileSync(path, "utf-8").trim() : "";
	const prefix = updated.length > 0 ? `${updated}\n\n` : "";
	writeFileSync(path, prefix + block);
	return true;
}

function unpatchConfigToml(path: string): boolean {
	if (!existsSync(path)) return false;
	const content = readFileSync(path, "utf-8");
	if (!content.includes("[mcp_servers.signet]")) return false;

	// Remove the signet MCP block — handles both with and without comment
	const lines = content.split("\n");
	const filtered: string[] = [];
	let inSection = false;
	for (const line of lines) {
		if (line.trim() === "# Signet MCP server") continue;
		if (line.trim() === "[mcp_servers.signet]") {
			inSection = true;
			continue;
		}
		// Skip all lines belonging to the signet section until next header
		if (inSection) {
			if (line.match(/^\[/)) inSection = false;
			else continue;
		}
		filtered.push(line);
	}
	writeFileSync(
		path,
		`${filtered
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trimEnd()}\n`,
	);
	return true;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class CodexConnector extends BaseConnector {
	readonly name = "Codex";
	readonly harnessId = "codex";

	protected getCodexHome(): string {
		return join(homedir(), ".codex");
	}

	private getHooksJsonPath(): string {
		return join(this.getCodexHome(), "hooks.json");
	}

	getConfigPath(): string {
		return join(this.getCodexHome(), "config.toml");
	}

	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const configsPatched: string[] = [];
		const warnings: string[] = [];
		const expandedBasePath = expandHome(basePath || join(homedir(), ".agents"));
		const strippedAgentsPath = this.stripLegacySignetBlock(expandedBasePath);
		if (strippedAgentsPath !== null) {
			filesWritten.push(strippedAgentsPath);
		}

		const codexHome = this.getCodexHome();
		mkdirSync(codexHome, { recursive: true });

		const signetArgs = resolveSignetArgs();

		// 1. Install hooks.json (native Codex hook system)
		const hooksPath = this.getHooksJsonPath();
		const existing = readHooksFile(hooksPath);

		if (existing) {
			const migrated = migrateLegacyHooksFile(existing, signetArgs);
			const cleaned = removeSignetEntries(migrated);
			const hasHooks = cleaned.hooks && Object.keys(cleaned.hooks).length > 0;
			if (hasHooks) {
				const signet = buildHooksFile(signetArgs);
				const merged: HooksFile = { ...cleaned, _signet: true };
				merged.hooks = { ...(cleaned.hooks as Record<string, MatcherGroup[]>) };
				for (const key of HOOK_EVENT_KEYS) {
					const current = merged.hooks[key] ?? [];
					const ours = signet.hooks?.[key] ?? [];
					(merged.hooks as Record<string, MatcherGroup[]>)[key] = [...current, ...ours];
				}
				writeHooksFile(hooksPath, merged);
				warnings.push("Merged Signet hooks into existing hooks.json — existing hooks preserved");
			} else {
				const signet = buildHooksFile(signetArgs);
				writeHooksFile(hooksPath, { ...cleaned, _signet: true, hooks: signet.hooks });
			}
		} else {
			writeHooksFile(hooksPath, buildHooksFile(signetArgs));
		}
		filesWritten.push(hooksPath);

		// 2. Symlink skills directory
		const skillsResult = this.symlinkSkills(expandedBasePath, codexHome);
		if (!skillsResult) {
			warnings.push("Failed to symlink skills directory");
		}

		// 3. Register MCP server in config.toml
		const mcp = resolveSignetMcp();
		if (patchConfigToml(this.getConfigPath(), mcp)) {
			configsPatched.push(this.getConfigPath());
		}

		return {
			success: true,
			message: "Codex integration installed — native hooks + MCP server",
			filesWritten,
			configsPatched,
			warnings,
		};
	}

	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];
		const configsPatched: string[] = [];

		// 1. Remove hooks.json (or clean Signet entries from merged file)
		const hooksPath = this.getHooksJsonPath();
		const existing = readHooksFile(hooksPath);
		if (existing) {
			const hasMarker = isSignetOwned(existing);
			const events = existing.hooks;
			const hasHandlers =
				events &&
				typeof events === "object" &&
				Object.values(events as Record<string, unknown[]>).some(
					(groups) => Array.isArray(groups) && groups.some(isSignetMatcherGroup),
				);
			if (hasMarker || hasHandlers) {
				const cleaned = removeSignetEntries(existing);
				const remaining = Object.keys(cleaned).filter((k) => k !== "_signet" && k !== "hooks");
				const hooksRemain = cleaned.hooks && Object.keys(cleaned.hooks as Record<string, unknown>).length > 0;
				if (remaining.length === 0 && !hooksRemain) {
					rmSync(hooksPath, { force: true });
					filesRemoved.push(hooksPath);
				} else {
					writeHooksFile(hooksPath, cleaned);
					configsPatched.push(hooksPath);
				}
			}
		}

		// 2. Remove skills symlink
		const skillsLink = join(this.getCodexHome(), "skills");
		if (existsSync(skillsLink)) {
			rmSync(skillsLink, { force: true });
			filesRemoved.push(skillsLink);
		}

		// 3. Remove MCP server from config.toml
		if (unpatchConfigToml(this.getConfigPath())) {
			configsPatched.push(this.getConfigPath());
		}

		return { filesRemoved, configsPatched };
	}

	isInstalled(): boolean {
		const file = readHooksFile(this.getHooksJsonPath());
		if (!file) return false;
		const events = file.hooks;
		if (!events || typeof events !== "object") return false;
		return Object.values(events as Record<string, unknown[]>).some(
			(groups) => Array.isArray(groups) && groups.some(isSignetMatcherGroup),
		);
	}
}
