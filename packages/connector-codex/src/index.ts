import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseConnector, type InstallResult, type UninstallResult, atomicWriteJson } from "@signet/connector-base";

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
// ---------------------------------------------------------------------------

interface HooksJson {
	_signet?: boolean;
	sessionStart?: unknown[];
	userPromptSubmit?: unknown[];
	stop?: unknown[];
	[key: string]: unknown;
}

function buildHooksJson(signetArgs: string[]): HooksJson {
	return {
		_signet: true,
		sessionStart: [
			{
				handlers: [
					{
						command: [...signetArgs, "hook", "session-start", "-H", "codex"],
						timeout: 10,
					},
				],
			},
		],
		userPromptSubmit: [
			{
				handlers: [
					{
						command: [...signetArgs, "hook", "user-prompt-submit", "-H", "codex"],
						timeout: 5,
					},
				],
			},
		],
		stop: [
			{
				handlers: [
					{
						command: [...signetArgs, "hook", "session-end", "-H", "codex"],
						timeout: 30,
					},
				],
			},
		],
	};
}

function readHooksJson(path: string): HooksJson | null {
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as HooksJson;
	} catch {
		return null;
	}
}

function isSignetOwned(hooks: HooksJson): boolean {
	return hooks._signet === true;
}

function writeHooksJson(path: string, hooks: HooksJson): void {
	mkdirSync(join(path, ".."), { recursive: true });
	atomicWriteJson(path, hooks);
}

const SIGNET_HOOK_CMDS = ["hook session-start", "hook user-prompt-submit", "hook session-end"] as const;

function isSignetHandler(entry: unknown): boolean {
	if (typeof entry !== "object" || entry === null) return false;
	const handlers = (entry as Record<string, unknown>).handlers;
	if (!Array.isArray(handlers)) return false;
	for (const handler of handlers) {
		if (typeof handler !== "object" || handler === null) continue;
		const cmd = (handler as Record<string, unknown>).command;
		if (!Array.isArray(cmd)) continue;
		const joined = cmd.join(" ");
		if (SIGNET_HOOK_CMDS.some((s) => joined.includes(s))) return true;
	}
	return false;
}

function removeSignetHooks(hooks: HooksJson): HooksJson {
	const cleaned = { ...hooks };
	for (const key of ["sessionStart", "userPromptSubmit", "stop"] as const) {
		if (!Array.isArray(cleaned[key])) continue;
		const filtered = (cleaned[key] as unknown[]).filter((e) => !isSignetHandler(e));
		if (filtered.length === 0) {
			delete cleaned[key];
		} else {
			cleaned[key] = filtered;
		}
	}
	// Only remove marker if no Signet entries remain
	const hasSignet = ["sessionStart", "userPromptSubmit", "stop"].some(
		(k) => Array.isArray(cleaned[k]) && (cleaned[k] as unknown[]).some(isSignetHandler),
	);
	if (!hasSignet) delete cleaned._signet;
	return cleaned;
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

function buildMcpBlock(mcp: { command: string; args: string[] }): string {
	let block = `# Signet MCP server\n[mcp_servers.signet]\ncommand = ${tomlQuote(mcp.command)}\n`;
	if (mcp.args.length > 0) {
		block += `args = ${tomlInlineArray(mcp.args)}\n`;
	}
	return block;
}

function patchConfigToml(path: string, mcp: { command: string; args: string[] }): boolean {
	const dir = join(path, "..");
	mkdirSync(dir, { recursive: true });

	if (!existsSync(path)) {
		writeFileSync(path, buildMcpBlock(mcp));
		return true;
	}

	const content = readFileSync(path, "utf-8");
	if (content.includes("[mcp_servers.signet]")) return false;

	const appended = content.trimEnd() + "\n\n" + buildMcpBlock(mcp);
	writeFileSync(path, appended);
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
		// Skip key=value lines belonging to the signet section
		if (inSection) {
			if (line.match(/^\s*\w+\s*=/) || line.trim() === "") continue;
			inSection = false;
		}
		filtered.push(line);
	}
	writeFileSync(
		path,
		filtered
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trimEnd() + "\n",
	);
	return true;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class CodexConnector extends BaseConnector {
	readonly name = "Codex";
	readonly harnessId = "codex";

	private getCodexHome(): string {
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

		const codexHome = this.getCodexHome();
		mkdirSync(codexHome, { recursive: true });

		const signetArgs = resolveSignetArgs();

		// 1. Install hooks.json (native Codex hook system)
		const hooksPath = this.getHooksJsonPath();
		const existing = readHooksJson(hooksPath);

		if (existing && !isSignetOwned(existing)) {
			// User has their own hooks.json — merge Signet hooks in
			const signetHooks = buildHooksJson(signetArgs);
			const merged: HooksJson = { ...existing };
			merged._signet = true;
			for (const key of ["sessionStart", "userPromptSubmit", "stop"] as const) {
				const current = Array.isArray(merged[key]) ? (merged[key] as unknown[]) : [];
				const signet = signetHooks[key] as unknown[];
				merged[key] = [...current, ...signet];
			}
			writeHooksJson(hooksPath, merged);
			warnings.push("Merged Signet hooks into existing hooks.json — existing hooks preserved");
		} else {
			writeHooksJson(hooksPath, buildHooksJson(signetArgs));
		}
		filesWritten.push(hooksPath);

		// 2. Symlink skills directory
		const skillsResult = this.symlinkSkills(basePath, codexHome);
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
		const existing = readHooksJson(hooksPath);
		if (existing) {
			// Check marker first; fall back to handler scan if marker was stripped
			const hasMarker = isSignetOwned(existing);
			const hasHandlers = ["sessionStart", "userPromptSubmit", "stop"].some(
				(k) =>
					Array.isArray((existing as Record<string, unknown>)[k]) &&
					((existing as Record<string, unknown>)[k] as unknown[]).some(isSignetHandler),
			);
			if (hasMarker || hasHandlers) {
				const cleaned = removeSignetHooks(existing);
				const remaining = Object.keys(cleaned).filter((k) => k !== "_signet");
				if (remaining.length === 0) {
					rmSync(hooksPath, { force: true });
					filesRemoved.push(hooksPath);
				} else {
					writeHooksJson(hooksPath, cleaned);
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
		const hooks = readHooksJson(this.getHooksJsonPath());
		if (!hooks) return false;
		return ["sessionStart", "userPromptSubmit", "stop"].some(
			(k) =>
				Array.isArray((hooks as Record<string, unknown>)[k]) &&
				((hooks as Record<string, unknown>)[k] as unknown[]).some(isSignetHandler),
		);
	}
}
