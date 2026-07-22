/**
 * Signet Connector for Kimi CLI / Kimi Code
 *
 * Integrates Signet's memory system with Kimi's lifecycle hooks.
 *
 * Kimi facts (from the official Kimi Code docs):
 * - Current config home: ~/.kimi/ (env override KIMI_SHARE_DIR).
 * - Legacy Kimi Code 0.x uses ~/.kimi-code/ (env override KIMI_CODE_HOME).
 * - Hooks: [[hooks]] array-of-tables in the selected config.toml.
 *   Allowed fields: event (required), matcher (optional regex),
 *   command (required), timeout (optional). Extra fields break config load.
 * - Hook payload arrives as JSON on STDIN (snake_case fields).
 * - For UserPromptSubmit, hook STDOUT text is appended to the model context;
 *   SessionStart STDOUT is also appended. SessionEnd is observation-only.
 * - MCP servers: JSON file mcp.json in the selected Kimi home, with shape
 *   {"mcpServers": {"signet": {"command": ..., "args": [...]}}} for stdio.
 *
 * Usage:
 * ```typescript
 * import { KimiConnector } from '@signet/connector-kimi';
 *
 * const connector = new KimiConnector();
 * await connector.install('~/.agents');
 * ```
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseConnector, type InstallResult, type UninstallResult, atomicWriteJson } from "@signet/connector-base";
import {
	expandHome,
	resolvePromptSubmitTimeoutMs,
	resolveSessionStartTimeoutMs,
	resolveSignetDaemonUrl,
} from "@signet/core";

// ---------------------------------------------------------------------------
// Signet command resolution
// ---------------------------------------------------------------------------

/** Resolve signet command for hook invocation. Mirrors the Codex connector:
 *  on Windows, navigate from argv[1] up two levels to find bin/signet.js so
 *  the .cmd shim (which flashes a console window) is bypassed. */
function resolveSignetArgs(): string[] {
	if (process.platform !== "win32") return ["signet"];
	const entry = process.argv[1] || "";
	const signetJs = join(entry, "..", "..", "bin", "signet.js");
	if (existsSync(signetJs)) return [process.execPath, signetJs];
	return ["signet"];
}

export interface KimiMcpStdioConfig {
	readonly command: string;
	readonly args: readonly string[];
}

/** Resolve signet-mcp as { command, args } for Kimi mcp.json (stdio transport). */
function resolveSignetMcp(): KimiMcpStdioConfig {
	if (process.platform !== "win32") return { command: "signet-mcp", args: [] };
	const entry = process.argv[1] || "";
	const mcpJs = join(entry, "..", "..", "bin", "mcp-stdio.js");
	if (existsSync(mcpJs)) return { command: process.execPath, args: [mcpJs] };
	return { command: "signet-mcp", args: [] };
}

function readEnv(name: string): string | undefined {
	const value = process.env[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolveRemoteDaemonUrl(): string | null {
	const explicit = readEnv("SIGNET_DAEMON_URL");
	if (!explicit) return null;
	return resolveSignetDaemonUrl();
}

function readAuthTokenEnv(): string | undefined {
	return readEnv("SIGNET_API_KEY") ?? readEnv("SIGNET_TOKEN");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function cmdEnvQuote(value: string): string {
	return value.replace(/[\^"&|<>]/g, "^$&");
}

function withRemoteDaemonEnv(command: string, remoteDaemonUrl: string | null): string {
	const apiKey = readAuthTokenEnv();
	if (!remoteDaemonUrl && !apiKey) return command;
	if (process.platform === "win32") {
		const vars = [
			...(remoteDaemonUrl ? [`set "SIGNET_DAEMON_URL=${cmdEnvQuote(remoteDaemonUrl)}"`] : []),
			...(apiKey ? [`set "SIGNET_API_KEY=${cmdEnvQuote(apiKey)}"`] : []),
		];
		return `${vars.join(" && ")} && ${command}`;
	}
	return [
		...(remoteDaemonUrl ? [`SIGNET_DAEMON_URL=${shellQuote(remoteDaemonUrl)}`] : []),
		...(apiKey ? [`SIGNET_API_KEY=${shellQuote(apiKey)}`] : []),
		command,
	].join(" ");
}

// ---------------------------------------------------------------------------
// config.toml [[hooks]] management
//
// Kimi expects hook entries as TOML array-of-tables:
//
//   [[hooks]]
//   event = 'SessionStart'
//   command = 'signet hook session-start -H kimi --kimi-json'
//   timeout = 20
//
// ONLY event/matcher/command/timeout are allowed — extra fields (including
// marker keys) break config load, so Signet-owned blocks are identified by
// their command string and an optional preceding comment line.
// ---------------------------------------------------------------------------

const SIGNET_HOOK_COMMENT = "# Signet lifecycle hook (managed by signet)";

const KIMI_SESSION_START_GRACE_SECONDS = 5;
const KIMI_PROMPT_SUBMIT_GRACE_SECONDS = 2;
const SESSION_END_TIMEOUT_SECONDS = 30;

export interface KimiHookEntry {
	readonly event: "SessionStart" | "UserPromptSubmit" | "SessionEnd";
	readonly command: string;
	readonly timeout: number;
}

function readTimeoutEnv(name: string): string {
	const value = process.env[name];
	return typeof value === "string" ? value.trim() : "";
}

function resolveKimiSessionStartTimeoutSeconds(): number {
	const raw = readTimeoutEnv("SIGNET_SESSION_START_TIMEOUT") || readTimeoutEnv("SIGNET_FETCH_TIMEOUT");
	return Math.ceil(resolveSessionStartTimeoutMs(raw) / 1000) + KIMI_SESSION_START_GRACE_SECONDS;
}

function resolveKimiPromptSubmitTimeoutSeconds(): number {
	return (
		Math.ceil(resolvePromptSubmitTimeoutMs(readTimeoutEnv("SIGNET_PROMPT_SUBMIT_TIMEOUT")) / 1000) +
		KIMI_PROMPT_SUBMIT_GRACE_SECONDS
	);
}

export function buildKimiHookEntries(
	signetArgs: readonly string[],
	remoteDaemonUrl: string | null = resolveRemoteDaemonUrl(),
): KimiHookEntry[] {
	const cmd = (subcommand: string, kimiJson: boolean): string =>
		withRemoteDaemonEnv(
			[...signetArgs, "hook", subcommand, "-H", "kimi", ...(kimiJson ? ["--kimi-json"] : [])].join(" "),
			remoteDaemonUrl,
		);
	return [
		{
			event: "SessionStart",
			command: cmd("session-start", true),
			timeout: resolveKimiSessionStartTimeoutSeconds(),
		},
		{
			event: "UserPromptSubmit",
			command: cmd("user-prompt-submit", true),
			timeout: resolveKimiPromptSubmitTimeoutSeconds(),
		},
		{
			event: "SessionEnd",
			command: cmd("session-end", false),
			timeout: SESSION_END_TIMEOUT_SECONDS,
		},
	];
}

function tomlQuote(s: string): string {
	// Use TOML literal strings (single-quoted) to avoid backslash escaping
	if (!s.includes("'")) return `'${s}'`;
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

function serializeHookEntry(entry: KimiHookEntry): string {
	return [
		SIGNET_HOOK_COMMENT,
		"[[hooks]]",
		`event = ${tomlQuote(entry.event)}`,
		`command = ${tomlQuote(entry.command)}`,
		`timeout = ${entry.timeout}`,
	].join("\n");
}

const SIGNET_KIMI_HOOK_PATTERN = /\bhook\s+(?:session-start|user-prompt-submit|session-end)\s+-H\s+kimi\b/;

function isSignetKimiHookBlock(block: readonly string[]): boolean {
	return SIGNET_KIMI_HOOK_PATTERN.test(block.join("\n"));
}

/** Remove every Signet-owned Kimi [[hooks]] block (and its marker comment)
 *  from config.toml content. User-owned hooks and other sections are kept. */
export function removeSignetKimiHookBlocks(content: string): string {
	const lines = content.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "[[hooks]]") {
			const block: string[] = [line];
			let j = i + 1;
			while (j < lines.length && !lines[j].trim().startsWith("[")) {
				block.push(lines[j]);
				j++;
			}
			if (isSignetKimiHookBlock(block)) {
				if (out.length > 0 && out[out.length - 1].trim() === SIGNET_HOOK_COMMENT) {
					out.pop();
				}
				i = j;
				continue;
			}
			out.push(...block);
			i = j;
			continue;
		}
		out.push(line);
		i++;
	}
	return `${out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()}\n`;
}

function patchConfigToml(path: string, entries: readonly KimiHookEntry[]): boolean {
	mkdirSync(join(path, ".."), { recursive: true });
	const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
	const cleaned = removeSignetKimiHookBlocks(existing).trimEnd();
	const blocks = entries.map(serializeHookEntry).join("\n\n");
	const updated = `${cleaned.length > 0 ? `${cleaned}\n\n` : ""}${blocks}\n`;
	if (updated === existing) return false;
	writeFileSync(path, updated);
	return true;
}

function unpatchConfigToml(path: string): boolean {
	if (!existsSync(path)) return false;
	const content = readFileSync(path, "utf-8");
	if (!SIGNET_KIMI_HOOK_PATTERN.test(content)) return false;
	const updated = removeSignetKimiHookBlocks(content);
	if (updated === content) return false;
	writeFileSync(path, updated);
	return true;
}

// ---------------------------------------------------------------------------
// MCP server registration (mcp.json)
// ---------------------------------------------------------------------------

interface KimiMcpJson {
	mcpServers?: Record<string, unknown>;
	[key: string]: unknown;
}

function readMcpJson(path: string): KimiMcpJson | null {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed as KimiMcpJson;
	} catch {
		// Don't corrupt an unparseable config
		return null;
	}
}

function patchMcpJson(path: string, mcp: KimiMcpStdioConfig): boolean {
	mkdirSync(join(path, ".."), { recursive: true });
	const config = readMcpJson(path);
	if (config === null) return false;
	const existingMcp =
		typeof config.mcpServers === "object" && config.mcpServers !== null && !Array.isArray(config.mcpServers)
			? config.mcpServers
			: {};
	const signetEntry = { command: mcp.command, args: [...mcp.args] };
	if (JSON.stringify(existingMcp.signet) === JSON.stringify(signetEntry)) return false;
	config.mcpServers = { ...existingMcp, signet: signetEntry };
	atomicWriteJson(path, config);
	return true;
}

function unpatchMcpJson(path: string): boolean {
	if (!existsSync(path)) return false;
	const config = readMcpJson(path);
	if (config === null) return false;
	if (
		typeof config.mcpServers !== "object" ||
		config.mcpServers === null ||
		Array.isArray(config.mcpServers) ||
		!("signet" in config.mcpServers)
	) {
		return false;
	}
	const { signet: _signet, ...restMcp } = config.mcpServers;
	if (Object.keys(restMcp).length === 0) {
		const { mcpServers: _mcpServers, ...restConfig } = config;
		atomicWriteJson(path, restConfig);
	} else {
		atomicWriteJson(path, { ...config, mcpServers: restMcp });
	}
	return true;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class KimiConnector extends BaseConnector {
	readonly name = "Kimi";
	readonly harnessId = "kimi";

	protected getKimiHome(): string {
		const currentOverride = readEnv("KIMI_SHARE_DIR");
		if (currentOverride) return currentOverride;
		const legacyOverride = readEnv("KIMI_CODE_HOME");
		if (legacyOverride) return legacyOverride;

		const currentHome = join(homedir(), ".kimi");
		const legacyHome = join(homedir(), ".kimi-code");
		if (existsSync(currentHome)) return currentHome;
		if (existsSync(legacyHome)) return legacyHome;
		return currentHome;
	}

	getConfigPath(): string {
		return join(this.getKimiHome(), "config.toml");
	}

	protected getMcpJsonPath(): string {
		return join(this.getKimiHome(), "mcp.json");
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

		const kimiHome = this.getKimiHome();
		mkdirSync(kimiHome, { recursive: true });

		// 1. Merge [[hooks]] entries into config.toml
		const configPath = this.getConfigPath();
		if (patchConfigToml(configPath, buildKimiHookEntries(resolveSignetArgs()))) {
			configsPatched.push(configPath);
		}

		// 2. Symlink skills into the selected Kimi home. Current Kimi also
		// discovers ~/.agents/skills directly, while this keeps legacy support.
		const skillsResult = this.symlinkSkills(expandedBasePath, kimiHome);
		if (skillsResult.errors.length > 0) {
			warnings.push("Failed to symlink skills directory");
		}

		// 3. Register MCP server in mcp.json
		const mcpPath = this.getMcpJsonPath();
		if (patchMcpJson(mcpPath, resolveSignetMcp())) {
			configsPatched.push(mcpPath);
		} else if (readMcpJson(mcpPath) === null) {
			warnings.push(`Skipped MCP registration — could not parse ${mcpPath}`);
		}

		return {
			success: true,
			message: "Kimi integration installed — config.toml hooks + MCP server",
			filesWritten,
			configsPatched,
			warnings,
		};
	}

	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];
		const configsPatched: string[] = [];

		// 1. Remove Signet [[hooks]] entries from config.toml
		const configPath = this.getConfigPath();
		if (unpatchConfigToml(configPath)) {
			configsPatched.push(configPath);
		}

		// 2. Remove skills symlink
		const skillsLink = join(this.getKimiHome(), "skills");
		if (existsSync(skillsLink)) {
			rmSync(skillsLink, { force: true });
			filesRemoved.push(skillsLink);
		}

		// 3. Remove signet MCP server from mcp.json
		const mcpPath = this.getMcpJsonPath();
		if (unpatchMcpJson(mcpPath)) {
			configsPatched.push(mcpPath);
		}

		return { filesRemoved, configsPatched };
	}

	isInstalled(): boolean {
		const configPath = this.getConfigPath();
		if (existsSync(configPath) && SIGNET_KIMI_HOOK_PATTERN.test(readFileSync(configPath, "utf-8"))) {
			return true;
		}
		const mcp = readMcpJson(this.getMcpJsonPath());
		return (
			mcp !== null &&
			typeof mcp.mcpServers === "object" &&
			mcp.mcpServers !== null &&
			!Array.isArray(mcp.mcpServers) &&
			"signet" in mcp.mcpServers
		);
	}
}

export default KimiConnector;
