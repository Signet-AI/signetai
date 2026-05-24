import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BaseConnector, type InstallResult, type UninstallResult, atomicWriteJson } from "@signet/connector-base";
import {
	expandHome,
	resolvePromptSubmitTimeoutMs,
	resolveSessionStartTimeoutMs,
	resolveSignetDaemonUrl,
} from "@signet/core";

export type SignetMcpConfig =
	| { readonly command: string; readonly args: readonly string[] }
	| { readonly url: string; readonly startupTimeoutSec: number; readonly toolTimeoutSec: number };

const CODEX_PLUGIN_MARKETPLACE_NAME = "signet-local";
const CODEX_PLUGIN_NAME = "signet";
const CODEX_PLUGIN_CONFIG_NAME = `${CODEX_PLUGIN_NAME}@${CODEX_PLUGIN_MARKETPLACE_NAME}`;

interface CodexPluginBundleFile {
	readonly relativePath: string;
	readonly content: string;
}

interface CodexPluginBundleResult {
	readonly marketplaceRoot: string;
	readonly pluginRoot: string;
	readonly filesWritten: readonly string[];
}

interface NativePluginCommandResult {
	readonly success: boolean;
	readonly filesWritten: readonly string[];
	readonly warning?: string;
}

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
function resolveSignetMcp(): SignetMcpConfig {
	const remoteDaemonUrl = resolveRemoteDaemonUrl();
	if (remoteDaemonUrl) {
		return {
			url: `${remoteDaemonUrl}/mcp`,
			startupTimeoutSec: 10,
			toolTimeoutSec: 30,
		};
	}
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

// ---------------------------------------------------------------------------
// Codex plugin bundle generation
// ---------------------------------------------------------------------------

function codexPluginBundleFiles(
	signetArgs: readonly string[],
	mcp: SignetMcpConfig,
	remoteDaemonUrl: string | null,
): CodexPluginBundleFile[] {
	const hookFile = buildHooksFile([...signetArgs], remoteDaemonUrl);
	const mcpServer =
		"url" in mcp
			? {
					url: mcp.url,
					startup_timeout_sec: mcp.startupTimeoutSec,
					tool_timeout_sec: mcp.toolTimeoutSec,
				}
			: {
					command: mcp.command,
					args: mcp.args,
				};
	return [
		{
			relativePath: ".agents/plugins/marketplace.json",
			content: `${JSON.stringify(
				{
					name: CODEX_PLUGIN_MARKETPLACE_NAME,
					interface: { displayName: "Signet Local" },
					plugins: [
						{
							name: CODEX_PLUGIN_NAME,
							source: { source: "local", path: `./plugins/${CODEX_PLUGIN_NAME}` },
							policy: { installation: "AVAILABLE" },
							category: "Coding",
						},
					],
				},
				null,
				2,
			)}\n`,
		},
		{
			relativePath: `plugins/${CODEX_PLUGIN_NAME}/.codex-plugin/plugin.json`,
			content: `${JSON.stringify(
				{
					name: CODEX_PLUGIN_NAME,
					version: "0.1.0",
					description:
						"Connect Codex to the local Signet substrate for source-backed recall, sessions, ontology, skills, and scoped note capture.",
					author: { name: "Signet" },
					homepage: "https://github.com/signetai/signetai",
					repository: "https://github.com/signetai/signetai",
					license: "Apache-2.0",
					keywords: ["signet", "recall", "sources", "sessions", "ontology", "codex"],
					skills: "./skills/",
					mcpServers: "./.mcp.json",
					hooks: "./hooks/hooks.json",
					interface: {
						displayName: "Signet",
						shortDescription: "Source-backed recall and continuity for Codex",
						longDescription:
							"Signet connects Codex to local source-backed memory, transcript search, ontology, and explicit note capture without replacing Codex native memory.",
						developerName: "Signet",
						category: "Coding",
						capabilities: ["Read", "Write"],
						websiteURL: "https://github.com/signetai/signetai",
						defaultPrompt: ["Recall prior Signet context for this repo"],
						brandColor: "#2563EB",
					},
				},
				null,
				2,
			)}\n`,
		},
		{
			relativePath: `plugins/${CODEX_PLUGIN_NAME}/.mcp.json`,
			content: `${JSON.stringify({ mcpServers: { signet: mcpServer } }, null, 2)}\n`,
		},
		{
			relativePath: `plugins/${CODEX_PLUGIN_NAME}/hooks/hooks.json`,
			content: `${JSON.stringify(hookFile, null, 2)}\n`,
		},
		{
			relativePath: `plugins/${CODEX_PLUGIN_NAME}/skills/signet-recall/SKILL.md`,
			content: [
				"---",
				"name: signet-recall",
				"description: Use Signet-specific recall and source search from Codex without confusing it with Codex native memory.",
				"---",
				"",
				"# Signet Recall",
				"",
				"Use `signet_recall` for explicit Signet recall. Ask natural questions with an entity, event, and timeframe when possible. Use `signet_source_search` when the answer should come from source-backed artifacts rather than ordinary saved memories.",
				"",
				"Do not treat Codex native memory and Signet memory as competing stores. Codex native memory is a source that Signet can index with provenance.",
				"",
			].join("\n"),
		},
		{
			relativePath: `plugins/${CODEX_PLUGIN_NAME}/skills/signet-sessions/SKILL.md`,
			content: [
				"---",
				"name: signet-sessions",
				"description: Search Signet transcript/session evidence from Codex.",
				"---",
				"",
				"# Signet Sessions",
				"",
				"Use `signet_session_search` when prior transcript evidence matters. Keep transcript lookup separate from memory recall; do not fold session search into ordinary memory search.",
				"",
			].join("\n"),
		},
		{
			relativePath: `plugins/${CODEX_PLUGIN_NAME}/skills/signet-ontology/SKILL.md`,
			content: [
				"---",
				"name: signet-ontology",
				"description: Navigate Signet ontology and knowledge graph state from Codex.",
				"---",
				"",
				"# Signet Ontology",
				"",
				"Use Signet ontology tools for reviewed structured facts, claim history, entity dependencies, and graph hygiene. Raw Codex memory files are evidence, not ontology by themselves.",
				"",
			].join("\n"),
		},
		{
			relativePath: `plugins/${CODEX_PLUGIN_NAME}/skills/signet-save-note/SKILL.md`,
			content: [
				"---",
				"name: signet-save-note",
				"description: Save explicit notes into Codex native memory through Signet.",
				"---",
				"",
				"# Signet Save Note",
				"",
				"Use `signet_save_note` only for explicit durable notes. It writes small ad-hoc markdown notes under Codex native memory extensions and never edits Codex-generated `MEMORY.md` or `memory_summary.md`.",
				"",
			].join("\n"),
		},
	];
}

export function writeCodexPluginBundle(input: {
	readonly codexHome: string;
	readonly signetArgs?: readonly string[];
	readonly mcp?: SignetMcpConfig;
	readonly remoteDaemonUrl?: string | null;
}): CodexPluginBundleResult {
	const marketplaceRoot = join(input.codexHome, ".tmp", "signet-plugin-marketplace");
	const pluginRoot = join(marketplaceRoot, "plugins", CODEX_PLUGIN_NAME);
	const filesWritten: string[] = [];
	for (const file of codexPluginBundleFiles(
		input.signetArgs ?? resolveSignetArgs(),
		input.mcp ?? resolveSignetMcp(),
		input.remoteDaemonUrl ?? resolveRemoteDaemonUrl(),
	)) {
		const path = join(marketplaceRoot, file.relativePath);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, file.content, "utf-8");
		filesWritten.push(path);
	}
	return { marketplaceRoot, pluginRoot, filesWritten };
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
const CODEX_PROMPT_SUBMIT_GRACE_SECONDS = 2;
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

interface HookTrustEntry {
	readonly key: string;
	readonly trustedHash: string;
}

function readTimeoutEnv(name: string): string {
	const value = process.env[name];
	return typeof value === "string" ? value.trim() : "";
}

function resolveCodexSessionStartTimeoutSeconds(): number {
	const raw = readTimeoutEnv("SIGNET_SESSION_START_TIMEOUT") || readTimeoutEnv("SIGNET_FETCH_TIMEOUT");
	return Math.ceil(resolveSessionStartTimeoutMs(raw) / 1000) + CODEX_SESSION_START_GRACE_SECONDS;
}

function resolveCodexPromptSubmitTimeoutSeconds(): number {
	return (
		Math.ceil(resolvePromptSubmitTimeoutMs(readTimeoutEnv("SIGNET_PROMPT_SUBMIT_TIMEOUT")) / 1000) +
		CODEX_PROMPT_SUBMIT_GRACE_SECONDS
	);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function cmdEnvQuote(value: string): string {
	return value.replace(/[\^"&|<>]/g, "^$&");
}

function withRemoteDaemonEnv(command: string, remoteDaemonUrl: string | null): string {
	if (!remoteDaemonUrl) return command;
	if (process.platform === "win32") {
		return `set "SIGNET_DAEMON_URL=${cmdEnvQuote(remoteDaemonUrl)}" && ${command}`;
	}
	return `SIGNET_DAEMON_URL=${shellQuote(remoteDaemonUrl)} ${command}`;
}

function buildHooksFile(signetArgs: string[], remoteDaemonUrl: string | null = resolveRemoteDaemonUrl()): HooksFile {
	const cmd = (subcommand: string, secs: number, codexJson = true): MatcherGroup => ({
		_signet: true,
		hooks: [
			{
				type: "command",
				command: withRemoteDaemonEnv(
					[...signetArgs, "hook", subcommand, "-H", "codex", ...(codexJson ? ["--codex-json"] : [])].join(" "),
					remoteDaemonUrl,
				),
				timeout: secs,
			},
		],
	});
	return {
		_signet: true,
		hooks: {
			SessionStart: [cmd("session-start", resolveCodexSessionStartTimeoutSeconds())],
			UserPromptSubmit: [cmd("user-prompt-submit", resolveCodexPromptSubmitTimeoutSeconds())],
			Stop: [cmd("session-end", SESSION_END_TIMEOUT_SECONDS, false)],
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
	let normalized = cmd.trim().replace(/\s+/g, " ");
	normalized = normalized.replace(/^SIGNET_DAEMON_URL=(?:'[^']*'|"[^"]*"|\S+)\s+/i, "");
	normalized = normalized.replace(/^set "SIGNET_DAEMON_URL=[^"]*" && /i, "");
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

const CODEX_HOOK_EVENT_LABELS: Record<(typeof HOOK_EVENT_KEYS)[number], string> = {
	SessionStart: "session_start",
	UserPromptSubmit: "user_prompt_submit",
	Stop: "stop",
};

function canonicalJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJson);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => [key, canonicalJson((value as Record<string, unknown>)[key])]),
	);
}

function codexHookHash(eventName: (typeof HOOK_EVENT_KEYS)[number], handler: HandlerConfig): string {
	const identity = {
		event_name: CODEX_HOOK_EVENT_LABELS[eventName],
		hooks: [
			{
				type: "command",
				command: handler.command,
				timeout: Math.max(handler.timeout ?? 600, 1),
				async: false,
			},
		],
	};
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(canonicalJson(identity)))
		.digest("hex")}`;
}

function buildHookTrustEntries(hooksPath: string, file: HooksFile): HookTrustEntry[] {
	const entries: HookTrustEntry[] = [];
	const events = file.hooks;
	if (!events || typeof events !== "object") return entries;

	for (const eventName of HOOK_EVENT_KEYS) {
		const groups = events[eventName] ?? [];
		for (const [groupIndex, group] of groups.entries()) {
			if (!isSignetMatcherGroup(group)) continue;
			for (const [handlerIndex, handler] of group.hooks.entries()) {
				entries.push({
					key: `${hooksPath}:${CODEX_HOOK_EVENT_LABELS[eventName]}:${groupIndex}:${handlerIndex}`,
					trustedHash: codexHookHash(eventName, handler),
				});
			}
		}
	}

	return entries;
}

function tomlDottedKeyQuote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

function patchHookTrustState(path: string, entries: readonly HookTrustEntry[]): boolean {
	if (entries.length === 0 || !existsSync(path)) return false;

	const content = readFileSync(path, "utf-8");
	const lines = content.split("\n");
	const filtered: string[] = [];
	let skipping = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[hooks.state.") && trimmed.endsWith("]")) {
			skipping = entries.some((entry) => trimmed.includes(tomlDottedKeyQuote(entry.key)));
			if (skipping) continue;
		} else if (skipping && trimmed.startsWith("[") && trimmed.endsWith("]")) {
			skipping = false;
		}

		if (!skipping) filtered.push(line);
	}

	const existing = `${filtered
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()}\n`;
	const blocks = entries
		.map((entry) =>
			[
				`[hooks.state.${tomlDottedKeyQuote(entry.key)}]`,
				"enabled = true",
				`trusted_hash = ${tomlQuote(entry.trustedHash)}`,
			].join("\n"),
		)
		.join("\n\n");
	let updated = `${existing.trimEnd()}\n\n${blocks}\n`;
	if (content.includes("# Signet MCP server") && !updated.includes("# Signet MCP server")) {
		updated = updated.replace("[mcp_servers.signet]", "# Signet MCP server\n[mcp_servers.signet]");
	}
	if (updated === content) return false;
	writeFileSync(path, updated);
	return true;
}

function removeHookTrustState(path: string, entries: readonly HookTrustEntry[]): boolean {
	if (entries.length === 0 || !existsSync(path)) return false;

	const content = readFileSync(path, "utf-8");
	const lines = content.split("\n");
	const filtered: string[] = [];
	let skipping = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[hooks.state.") && trimmed.endsWith("]")) {
			skipping = entries.some((entry) => trimmed.includes(tomlDottedKeyQuote(entry.key)));
			if (skipping) continue;
		} else if (skipping && trimmed.startsWith("[") && trimmed.endsWith("]")) {
			skipping = false;
		}

		if (!skipping) filtered.push(line);
	}

	const updated = `${filtered
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()}\n`;
	if (updated === content) return false;
	writeFileSync(path, updated);
	return true;
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

function tomlInlineArray(items: readonly string[]): string {
	return `[${items.map(tomlQuote).join(", ")}]`;
}

export function buildMcpBlock(mcp: SignetMcpConfig): string {
	if ("url" in mcp) {
		return [
			"# Signet MCP server",
			"[mcp_servers.signet]",
			`url = ${tomlQuote(mcp.url)}`,
			`startup_timeout_sec = ${mcp.startupTimeoutSec}`,
			`tool_timeout_sec = ${mcp.toolTimeoutSec}`,
			"",
		].join("\n");
	}
	let block = `# Signet MCP server\n[mcp_servers.signet]\ncommand = ${tomlQuote(mcp.command)}\n`;
	if (mcp.args.length > 0) {
		block += `args = ${tomlInlineArray(mcp.args)}\n`;
	}
	return block;
}

function patchConfigToml(path: string, mcp: SignetMcpConfig): boolean {
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

function removeTomlSection(content: string, header: string): string {
	if (!content.includes(header)) return content;
	const lines = content.split("\n");
	const filtered: string[] = [];
	let inSection = false;
	for (const line of lines) {
		if (line.trim() === header) {
			inSection = true;
			continue;
		}
		if (inSection && line.match(/^\s*\[/)) {
			inSection = false;
		}
		if (!inSection) filtered.push(line);
	}
	return `${filtered.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function patchNativePluginConfig(path: string, marketplaceRoot: string): boolean {
	mkdirSync(join(path, ".."), { recursive: true });
	const marketplaceHeader = `[marketplaces.${CODEX_PLUGIN_MARKETPLACE_NAME}]`;
	const pluginHeader = `[plugins."${CODEX_PLUGIN_CONFIG_NAME}"]`;
	const marketplaceBlock = [
		marketplaceHeader,
		'last_updated = "1970-01-01T00:00:00Z"',
		'source_type = "local"',
		`source = ${tomlQuote(marketplaceRoot)}`,
		"",
		pluginHeader,
		"enabled = true",
		"",
	].join("\n");
	const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
	let cleaned = removeTomlSection(removeTomlSection(existing, marketplaceHeader), pluginHeader);
	cleaned = cleaned.trimEnd();
	const updated = `${cleaned.length > 0 ? `${cleaned}\n\n` : ""}${marketplaceBlock}`;
	if (updated === existing) return false;
	writeFileSync(path, updated);
	return true;
}

function unpatchNativePluginConfig(path: string): boolean {
	if (!existsSync(path)) return false;
	const marketplaceHeader = `[marketplaces.${CODEX_PLUGIN_MARKETPLACE_NAME}]`;
	const pluginHeader = `[plugins."${CODEX_PLUGIN_CONFIG_NAME}"]`;
	const content = readFileSync(path, "utf-8");
	const updated = removeTomlSection(removeTomlSection(content, marketplaceHeader), pluginHeader);
	if (updated === content) return false;
	writeFileSync(path, updated);
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

	protected supportsNativePluginInstall(): boolean {
		if (readEnv("SIGNET_CODEX_DISABLE_NATIVE_PLUGIN") === "1") return false;
		const result = spawnSync("codex", ["plugin", "--help"], {
			stdio: "ignore",
			env: { ...process.env, CODEX_HOME: this.getCodexHome() },
		});
		return result.status === 0;
	}

	protected nativePluginProvidesHooks(): boolean {
		return false;
	}

	protected installNativePlugin(codexHome: string): NativePluginCommandResult {
		const result = spawnSync("codex", ["plugin", "add", CODEX_PLUGIN_CONFIG_NAME], {
			encoding: "utf-8",
			env: { ...process.env, CODEX_HOME: codexHome },
		});
		const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
		if (result.status !== 0) {
			return {
				success: false,
				filesWritten: [],
				warning: `Codex native plugin install failed; falling back to compatibility hooks/MCP: ${output.trim()}`,
			};
		}
		const installedRoot = output.match(/Installed plugin root:\s*(.+)/)?.[1]?.trim();
		return {
			success: true,
			filesWritten: installedRoot ? [installedRoot] : [],
		};
	}

	protected removeNativePlugin(codexHome: string): void {
		spawnSync("codex", ["plugin", "remove", CODEX_PLUGIN_CONFIG_NAME], {
			stdio: "ignore",
			env: { ...process.env, CODEX_HOME: codexHome },
		});
	}

	private getHooksJsonPath(): string {
		return join(this.getCodexHome(), "hooks.json");
	}

	getConfigPath(): string {
		return join(this.getCodexHome(), "config.toml");
	}

	private installCompatibilityHooks(
		signetArgs: string[],
		filesWritten: string[],
		configsPatched: string[],
		warnings: string[],
	): void {
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

		const configPath = this.getConfigPath();
		const installedHooks = readHooksFile(hooksPath);
		if (
			installedHooks &&
			patchHookTrustState(configPath, buildHookTrustEntries(hooksPath, installedHooks)) &&
			!configsPatched.includes(configPath)
		) {
			configsPatched.push(configPath);
		}
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
		const mcp = resolveSignetMcp();
		const nativePluginSupported = this.supportsNativePluginInstall();

		if (nativePluginSupported) {
			const bundle = writeCodexPluginBundle({
				codexHome,
				signetArgs,
				mcp,
				remoteDaemonUrl: resolveRemoteDaemonUrl(),
			});
			filesWritten.push(...bundle.filesWritten);
			if (patchNativePluginConfig(this.getConfigPath(), bundle.marketplaceRoot)) {
				configsPatched.push(this.getConfigPath());
			}
			if (unpatchConfigToml(this.getConfigPath()) && !configsPatched.includes(this.getConfigPath())) {
				configsPatched.push(this.getConfigPath());
			}
			const pluginInstall = this.installNativePlugin(codexHome);
			filesWritten.push(...pluginInstall.filesWritten);
			if (pluginInstall.warning) warnings.push(pluginInstall.warning);
			if (pluginInstall.success) {
				if (patchConfigToml(this.getConfigPath(), mcp) && !configsPatched.includes(this.getConfigPath())) {
					configsPatched.push(this.getConfigPath());
				}
				if (this.nativePluginProvidesHooks()) {
					const existingHooks = readHooksFile(this.getHooksJsonPath());
					const trustEntries = existingHooks ? buildHookTrustEntries(this.getHooksJsonPath(), existingHooks) : [];
					if (removeHookTrustState(this.getConfigPath(), trustEntries) && !configsPatched.includes(this.getConfigPath())) {
						configsPatched.push(this.getConfigPath());
					}
				} else {
					this.installCompatibilityHooks(signetArgs, filesWritten, configsPatched, warnings);
					warnings.push(
						"Codex plugin support detected, but lifecycle hooks still require the compatibility hooks.json path in this Codex version",
					);
				}

				return {
					success: true,
					message: "Codex integration installed — native plugin bundle + Signet lifecycle hooks",
					filesWritten,
					configsPatched,
					warnings,
				};
			}
			if (unpatchNativePluginConfig(this.getConfigPath()) && !configsPatched.includes(this.getConfigPath())) {
				configsPatched.push(this.getConfigPath());
			}
		}

		// 1. Install hooks.json (native Codex hook system)
		this.installCompatibilityHooks(signetArgs, filesWritten, configsPatched, warnings);

		// 2. Symlink skills directory
		const skillsResult = this.symlinkSkills(expandedBasePath, codexHome);
		if (!skillsResult) {
			warnings.push("Failed to symlink skills directory");
		}

		// 3. Register MCP server in config.toml
		const configPath = this.getConfigPath();
		if (patchConfigToml(configPath, mcp)) {
			configsPatched.push(configPath);
		}
		const installedHooks = readHooksFile(this.getHooksJsonPath());
		if (
			installedHooks &&
			patchHookTrustState(configPath, buildHookTrustEntries(this.getHooksJsonPath(), installedHooks)) &&
			!configsPatched.includes(configPath)
		) {
			configsPatched.push(configPath);
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
		const hookTrustEntries = existing ? buildHookTrustEntries(hooksPath, existing) : [];
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
		const configPath = this.getConfigPath();
		this.removeNativePlugin(this.getCodexHome());
		if (unpatchNativePluginConfig(configPath)) {
			configsPatched.push(configPath);
		}
		if (removeHookTrustState(configPath, hookTrustEntries)) {
			configsPatched.push(configPath);
		}
		if (unpatchConfigToml(configPath) && !configsPatched.includes(configPath)) {
			configsPatched.push(configPath);
		}
		const pluginMarketplace = join(this.getCodexHome(), ".tmp", "signet-plugin-marketplace");
		if (existsSync(pluginMarketplace)) {
			rmSync(pluginMarketplace, { recursive: true, force: true });
			filesRemoved.push(pluginMarketplace);
		}

		return { filesRemoved, configsPatched };
	}

	isInstalled(): boolean {
		const configPath = this.getConfigPath();
		if (existsSync(configPath) && readFileSync(configPath, "utf-8").includes(`[plugins."${CODEX_PLUGIN_CONFIG_NAME}"]`)) {
			return true;
		}
		const file = readHooksFile(this.getHooksJsonPath());
		if (!file) return false;
		const events = file.hooks;
		if (!events || typeof events !== "object") return false;
		return Object.values(events as Record<string, unknown[]>).some(
			(groups) => Array.isArray(groups) && groups.some(isSignetMatcherGroup),
		);
	}
}
